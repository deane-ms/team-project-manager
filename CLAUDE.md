# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Patterns shared across every Mediashock internal tool (notifications, theme toggle, icons,
> auth, Firestore rules gotchas) live in `CLAUDE.md` in the parent `Claude Projects/` folder —
> check there before building something this project's own architecture below doesn't cover.

## What this is

Flowboard — a shared kanban/task-prioritization board for Mediashock APAC, built as a single
client-side HTML file (no build step, no framework, no bundler), backed by Firebase (Firestore +
Google Auth) so the whole team edits one live board together with real-time updates.

- **`index.html`** (~3300 lines) — the entire app: markup, Tailwind styling, and vanilla ES-module
  JS in one file. This is virtually the whole codebase.
- `firebase.json`, `.firebaserc`, `firestore.rules`, `storage.rules` — Firebase CLI project files
  for `pscr-project-manager`. Chat image sharing (see below) needs this project on the **Blaze**
  (pay-as-you-go) plan with Cloud Storage enabled — Firestore usage alone would still fit inside
  Spark's free tier, and everything else in this app assumed Spark until that feature shipped.
- `sw.js` — a no-op service worker (exists only to satisfy PWA installability; deliberately does
  no caching, see comment in the file).
- `version.txt` — a timestamp stamped on every deploy; polled client-side to trigger auto-reload.

Live at https://deane-ms.github.io/team-project-manager/ (deployed via GitHub Pages, not Firebase
Hosting — `firebase.json` only configures Firestore + emulators).

## Commands

There is no build/lint/test tooling — it's static HTML/JS served as-is. Local development uses the
Firebase Local Emulator Suite (Auth + Firestore + Storage):

```
firebase emulators:start --project demo-flowboard
python -m http.server 8765   # serve over http://, not file:// — Auth popup sign-in requires a real origin
```

The app auto-detects `localhost`/`127.0.0.1` (`USE_EMULATORS` in index.html) and points itself at
the emulators instead of the real Firebase project — no config changes needed to switch.

## Deploying

There's no CI/deploy script in this repo. When shipping a change to `index.html`, bump both:
- `CURRENT_BUILD_VERSION` (near the bottom of the module script in `index.html`)
- `version.txt` (same timestamp)

**Syntax-check before shipping.** There's no build step, so nothing catches a broken `<script>` —
and because it's one big `type="module"`, a single syntax error anywhere kills the *entire* app,
not just the feature that introduced it. This has already shipped once: commit `7ca02d4` landed a
literal `&amp;&amp;` (HTML-escaped `&&`) inside `addDependency()`, which made the whole module fail
to parse and took the live board down completely.

`scripts/check-syntax.mjs` now guards this — it extracts every inline `<script>` in `index.html`
(currently 3, not just the big module one) and runs `node --check` over each, reporting failures
against `index.html`'s own line numbers:

```
node scripts/check-syntax.mjs
```

It's wired in two places, because neither alone is enough:

- **`.githooks/pre-push`** actually *prevents* the bad deploy. It needs one command per clone:
  ```
  git config core.hooksPath .githooks
  ```
  Git hooks aren't distributed by `git clone`, so a fresh checkout has no protection until
  someone runs that. `git push --no-verify` bypasses it deliberately.
- **`.github/workflows/syntax-check.yml`** is the backstop for pushes where the hook wasn't
  enabled, was bypassed, or the edit came from the GitHub web UI. It runs *after* the push, so it
  can only make the breakage loud (red X) rather than stop it — GitHub Pages will already have
  deployed. Turning this into a real gate would mean moving Pages off its branch-based build onto
  an Actions-based deploy that only publishes when the check passes; that's a bigger change and
  hasn't been done.

Both paths run the same script, so there's one place to fix if the markup ever changes shape.

The deployed page polls `version.txt` every 60s and auto-reloads clients once it changes — but
`reloadIfPendingAndSafe()` will never reload out from under a user with a modal open, so a stale
tab can sit on `pendingBuildVersion` for a while. If the two timestamps drift, clients get stuck
thinking a reload is pending even after they're already current.

## Architecture

Everything lives in one `<script type="module">` at the bottom of `index.html`. Rough layout, top
to bottom:

1. **Firebase setup** — `firebaseConfig`/emulator switch, `isAllowedEmail` domain gate.
2. **Notifications** — `parseMentions`/`notifyOnComment`: comments create `notifications` docs for
   the assignee and any `@Name`-mentioned teammates. `notifyAssignment` separately notifies a
   task's assignee on creation or reassignment, even with no comment attached (hooked into the
   task-save handler, gated on `oldTask.assignee !== assignee`). The notification bell shows
   read/unread state visually (dot + bold vs. muted text). The `suggestions` tab (comment/reply on
   a feature-request board, not tied to a task) follows the same embedded-array reply model as
   task comments — see Firestore data model below.
   - **A mention must END where the name ends.** `parseMentions` and `enrichCommentText` both
     append a shared `MENTION_TAIL = '(?![A-Za-z0-9])'` to their generated regex. Without it an
     assignee name that's a prefix of a longer word matched inside it: with "Dee" on the board,
     typing "@Deepak" sent Dee a real mention notification for a comment that never named them, and
     rendered as a half-highlighted "@Dee"+"pak". Sorting names longest-first in `enrichCommentText`
     does *not* cover this -- that only handles one assignee name being a prefix of another, not of
     an arbitrary word. The sibling Content Hub has the identical pair
     (`parseMentions`/`enrichFeedbackText`) and the same constant; all four were fixed together, so
     a change to one needs the same change in the other three.
   - **Comment replies actually thread now** (`renderCommentsLog`, `backfillCommentThreading`,
     `inferReplyTarget`) — reported directly ("why are the replies to comments not just below the
     comment itself?"). Root cause: clicking Reply never created a real reply. It just prefilled
     the new-comment box with `"@Author "` and, once sent, that landed as an ordinary comment
     appended to the same flat array — visually indistinguishable from a top-level comment except
     for the mention text, so there was no actual parent/child relationship for anything to render
     nested from.
     - **Comments still store as a flat array, always appended via `arrayUnion`** — that's
       deliberate and unchanged, since a full reorder would mean rewriting the whole array on
       every add instead of an atomic append, reopening exactly the race-on-concurrent-comment
       risk `arrayUnion` exists to avoid. Threading is purely a render-time concern:
       `renderCommentsLog` walks each comment's new `replyTo` (a parent comment's `id`) into a
       tree and renders replies nested (indented, left-bordered) directly under their parent. A
       `replyTo` pointing at an id no longer present (parent removed) falls back to rendering as a
       top-level comment rather than vanishing or throwing.
     - **New replies get a real `replyTo`, not another guess.** `task-comment-add-btn`'s handler
       now assigns every comment a `uid()` id and, via `inferReplyTarget`, resolves `replyTo`
       against the task's current comments at send time — same function the backfill below uses,
       so live replies and migrated old ones can never drift into different logic.
     - **`backfillCommentThreading(comments)` migrates existing data** — assigns a stable `id` to
       any comment that doesn't have one (same fix-it-forward pattern as the checklist item id
       backfill above it), then infers `replyTo` for comments predating this field via
       `inferReplyTarget`'s heuristic: a comment counts as a reply only when its text *starts with*
       `"@Name "` — exactly what the Reply button always inserted — resolving to the most recent
       *earlier* comment by that name. This can't be certain (a manually-typed leading mention
       with no reply intent looks identical after the fact), but it's the best inference available
       for data written before replies were tracked as a real field.
     - **Unlike the checklist backfill, this can't just live in memory until the task's next
       unrelated Save.** Comments write straight to Firestore on their own (`arrayUnion` on add, a
       full-array rewrite on remove via `removeCommentAt`) — never through the task-form save
       payload — so nothing else would ever persist a purely in-memory fix. `openTaskModal` runs
       the backfill and, only if it actually changed anything, writes the result back via
       `updateDoc` immediately (skips the write for tasks that need no fix, which is most of them
       once this has rolled out). This is how "apply it to existing entries" actually happens:
       progressively, the next time each task with old un-threaded replies gets opened by anyone
       on the team — not a one-time bulk migration script, since there's no service-account/admin
       Firestore access set up for this app to run one from outside the browser (see "Scheduled
       cloud routines" in the parent `Claude Projects/CLAUDE.md`) and no other durable place for a
       migration to run except through a real signed-in session.
     - The live-refresh path (the `tasks` `onSnapshot` handler re-rendering an already-open task's
       comments when someone else edits it) also runs `backfillCommentThreading` before rendering,
       not just `openTaskModal` — otherwise the moment `openTaskModal`'s own backfill write
       round-trips back through that same listener would flash the log flat/unthreaded for a beat
       before self-correcting.
     - **`sanitizeImportedComments` preserves `id`/`replyTo`** (generating a fresh id if one's
       missing or invalid, same as the backfill) instead of reconstructing every comment as bare
       `{text, date, author}` — otherwise an export/import round-trip would silently flatten every
       reply thread back into a plain list, same reasoning as why `dependsOn` survives that path.
     - **The Suggestions tab's replies are a different, already-correct shape and needed no fix**:
       one flat `replies` array *per suggestion post* (`suggestion-reply-add-btn`,
       `data-suggestion-id`), always rendered directly under that one suggestion — there's no
       "reply to a specific earlier reply" concept there at all, so nothing was ever ambiguous
       about where a reply belongs.
     - **`#task-comments-log`'s `max-h-40` (160px) was reported as too cramped once threading
       made the log taller** — bumped to `max-h-96` (384px). Safe to grow generously: Comments is
       the last section in the task modal's own internally-scrolling form
       (`#task-form`, `overflow-y-auto`), immediately before the fixed Delete/Cancel/Save footer,
       so a taller comments pane doesn't push any other field further out of view — it only
       changes how much of the conversation shows before the log's own inner scrollbar kicks in.
     - **The task modal itself also went wider** — `max-w-2xl` (42rem) → `max-w-5xl` (64rem, ~50%
       wider), requested directly right after the taller comments log. Uses Tailwind's standard
       scale rather than an arbitrary `max-w-[...]` value; `5xl` lands within ~2% of an exact 50%
       increase, close enough that a named step reads better than a bespoke number. No other
       layout change needed — the modal's own `p-2 sm:p-4` outer padding and the form's existing
       `sm:grid-cols-2` field pairs already respond to the wider container correctly on their own.
   - **Desktop popups**: an opt-in toggle in the user menu (`btn-desktop-notif-toggle`,
     `localStorage` key `flowboard_desktop_notif`) fires a native `Notification` from the
     `notifications` `onSnapshot` listener in `startListeners` for anything added *after* the
     listener's first snapshot (`notifListenerReady` flips true once that first snapshot resolves,
     so only later `docChanges()` "added" events pop a notification — this avoids bursting the
     whole existing backlog open every page load). Deliberately not a timestamp comparison: an
     earlier version compared each notification's client-generated `at` field against this tab's
     own `Date.now()` at attach time, which silently ate popups whenever the notifying user's and
     the recipient's machine clocks disagreed (the in-app bell has no such check, so it kept
     working — only desktop popups went quiet). Tab-open-somewhere only — no service-worker push,
     no server. Requires the browser's Notification permission to be granted; a comment/mention/
     assignment never notifies its own author (see `delete recipients[myName]` in
     `notifyOnComment`, and the self-check in `notifyAssignment`), so testing needs a second
     account/tab, not a self-mention.
     - **Reported directly as "doesn't alert me immediately"** — turned out to mean the opt-in
       toggle/browser permission weren't actually active, so the in-app bell (only visible by
       opening the app) was the only signal that ever fired; not a bug in the notification
       pipeline itself, which is real-time (a live `onSnapshot`, not a poll) regardless of
       notification type.
     - **Clicking a chat-mention popup only ever opened a task, never the chat** — reported
       directly right after ("when clicking on desktop notification, it should bring me directly
       to chat"). `fireDesktopNotification`'s `n.onclick` only ever checked `notif.taskId`; a
       project chat mention carries `chatProject` instead (see `notifyOnProjectChat`), which
       this handler never looked at, so clicking one silently did nothing beyond focusing the
       window. Fixed to branch on `chatProject` the same way the notification bell's own panel
       click handler already does (`setView('chat')` + `selectChatProject(chatProject)`) — that
       existing path was never broken; this one just never reused it. The popup body also gained
       the same subject-naming `taskName` already got (`"<name>: <snippet>"`), using
       `chatProject` in place of `taskName` when present, so you can tell which chat it's about
       before clicking.
3. **Drive picker integration** — lazy-loads the Google Picker API (`ensureGapiLoaded`) so users
   can attach a Drive folder to a task/project without guessing folder names.
   - **Project and Google Drive Link are one field, not two.** They used to be separate inputs
     that a single Drive pick filled in together, and Project was `readonly` — the only way to
     set it was to browse Drive, so a project with no Drive folder couldn't be named at all.
     Now `#task-project` is free-type and doubles as the link entry point: `absorbProjectLink()`
     (on `paste` and on `change`/blur, deliberately **not** on every keystroke, or a hand-typed
     URL gets absorbed halfway through being typed) pulls any URL out of the field into a hidden
     `#task-drive` input, leaving the rest of the text as the project name. Trailing sentence
     punctuation is trimmed off the URL first, same as the sibling Content Hub's pasted-Drive-link
     handling. Still stored as two separate task fields (`project` + `driveLink`) — `project` is
     the grouping key for Projects/Gantt/People/`filters`, so it has to stay a real name and can
     never become a URL. Existing tasks need no migration.
   - **Assignee is a picker over the team roster, not a free-text field.** It used to be
     `<input list="assignee-suggestions">` — you typed a colleague's name from memory and a
     datalist merely *suggested*, so nothing stopped "Sarah" / "Sarah L" / "sarah lim" becoming
     three people in the People view, three filter options and three separate workload columns,
     only one of whom could actually be notified (see `people` in the data model below). It is now
     a real `<select>` (`renderAssigneeOptions`, run on every `openTaskModal` so someone who
     signed in thirty seconds ago is already pickable) put through the same `enhanceSelect()`
     widget as every other dropdown in this app.
     - **The currently-assigned person is always kept as an option** even if `teamRoster()`
       somehow doesn't list them. Without that, opening an old task would show a blank picker and
       saving it — for any unrelated edit — would silently reassign the task out from under them.
     - **`+ Someone else…` (`ASSIGNEE_OTHER`) is the deliberate escape hatch**, for the one case a
       roster picker can't serve: assigning work to someone before their first sign-in (a new
       starter, an intern). It reveals `#task-assignee-other`, which is otherwise hidden, so this
       is progressive disclosure rather than a second always-visible way to set the same field.
       `currentAssigneeValue()` is the single place that knows which of the two inputs is live —
       both the submit handler and `taskFormSnapshot()` call it, so the save path and the
       unsaved-changes check can't disagree about what the assignee is.
     - **No `required` attribute on the select.** `enhanceSelect()` puts the real control in
       `sr-only`, and a browser refuses to submit a form whose invalid control can't be focused —
       the form would fail silently with no message. The existing check in the submit handler
       covers it. For the same reason `setFieldError` now redirects its red outline to the
       enhanced select's *trigger button*, and `clearFieldErrors` clears it from those buttons —
       reddening an `sr-only` element shows the user nothing.
   - **Chrome's native datalist caret is hidden app-wide.** Any `<input list="...">` whose
     datalist has options gets a solid black ▼ drawn by Chrome *while the field is focused or
     hovered* — a filled UA glyph sitting right beside this app's thin stroked SVG icons, which
     reads as a foreign control. Killed with
     `input[list]::-webkit-calendar-picker-indicator { display: none !important }` in the `<style>`
     block. Scoped to `input[list]` deliberately: `input[type="date"]` uses the *same*
     pseudo-element for its calendar button and must keep it. Affects Project and the Time Tracking note
     field (Assignee used to be in this list; it's a real select now, see above). Suggestions still drop down as you type; you just can't click an
     arrow to browse them cold.
     - **Testing this needs real Chrome, headed, with the field focused.** Playwright's bundled
       Chromium never draws the caret, headed or not, so a headless run "passes" whether or not
       the rule works. `getComputedStyle(el, '::-webkit-calendar-picker-indicator')` is also
       useless here — it reports the UA value (`inline-block`) and ignores author overrides even
       when they're applied. The only reliable check is a pixel diff of the focused input in
       `chromium.launch({ channel: 'chrome', headless: false })`.
   - **One icon, on the right.** The field briefly had two: a brand-coloured tray glyph sitting
     decoratively on the left plus a folder glyph on the right for the Drive picker. The left one
     was purely ornamental once the field had a real affordance, so the tray glyph moved to the
     right as the Browse-Drive button and the folder was dropped. It's muted (`text-zinc-400` /
     `dark:text-zinc-500`, brand only on hover), matching every other icon button in this form —
     nothing in the Project row is brand-coloured at rest any more.
   - The attached link surfaces as a one-line link/Copy/Remove row under the field
     (`#task-project-link-row`), swapped with a `#task-project-hint` when nothing's attached —
     `syncDriveLinkButtons()` toggles both `hidden` *and* `flex` rather than relying on
     stylesheet order, matching how the task modal itself is shown/hidden.
   - The Drive picker now fills the project name **only when the field is blank**
     (`openDrivePicker`'s callback), so someone who already typed "Q3 Campaign" and then browses
     to attach the folder doesn't get their name overwritten by the folder's.
   - `#task-project` carries `maxlength="200"` so a pasted Drive URL isn't truncated before
     `absorbProjectLink()` can extract it; the 60-char limit on the *name* is enforced in the
     submit handler instead. It also has a `#project-suggestions` datalist (populated from
     `uniqueValues('project')`) — without it, free-type would quietly split "Acme Rebrand" and
     "acme rebrand" into two projects everywhere that groups by this field.
4. **Pure helpers** — date/time/formatting/sanitization utilities (no DOM or Firestore access).
5. **Modal + UI helpers** — task modal, checklist editor, time-entry editor, "enhanced select"
   dropdown widget, mention autocomplete menu.
   - **A typed-but-unsent comment used to vanish silently on Cancel *or* Save** — reported
     directly. Root cause: comments write straight to Firestore the instant Add is clicked (their
     own `arrayUnion`/full-array-rewrite calls, entirely separate from the task-form save flow),
     so a draft still sitting in `#task-comment-input` was invisible to both exit paths.
     - **Cancel/backdrop/Escape/X** already ran every close through `taskModalHasUnsavedChanges()`
       (`taskFormSnapshot()` vs. `formBaseline`, captured at `openTaskModal` time) before an
       explicit "Discard changes?" `openConfirm` — that mechanism just never looked at the comment
       box. Added `commentDraft: document.getElementById('task-comment-input').value` to the
       snapshot and the gap closes for free; `openTaskModal` already clears that field before
       capturing `formBaseline`, so a fresh open always starts at `''` there.
     - **Save had no equivalent check of any kind.** The task-form `submit` handler's body is now
       `commitTaskSave()`, a named function instead of the listener's own anonymous callback, so
       it can be invoked either immediately (no draft) or from an `openConfirm` callback ("Save
       without sending this comment?" / Save without it / Go back) when
       `#task-comment-input` has trimmed text. Deliberately a separate check from the
       Cancel-side snapshot comparison, not a reuse of it — the correct framing here isn't
       "discard everything or keep editing," it's "discard the draft specifically, or go click
       Add first," which needs its own copy naming the comment.
   - **`closeOtherHeaderPanels(exceptPanel)` enforces one floating panel/dropdown open at a
     time** — the notification bell, digest bell, user menu, and every "enhanced select"
     filter/sort menu each used to manage only their own hidden/visible state independently, so
     two could genuinely be open and stacked on top of each other at once (reported directly
     against a screenshot: "notification or drop down panels can only open one at a time"). Each
     trigger now calls it (passing itself as the exception) before toggling its own visibility,
     and `enhanceSelect`'s `openMenu()` calls it too (passing `null`, closing everything). Defined
     early, next to `closeOtherEnhancedSelectMenus`, even though `userMenuPanel`/`digestPanel`/
     `notificationPanel` aren't assigned until much further down the file — safe, since `var`
     hoists them and the function body only actually runs from a later click, well after module
     init has set all three.
   - `setFieldError(inputEl, message)` walks *up* from the input looking for the field's
     `.field-error` `<p>`, rather than only checking the input's immediate parent. Fields wrapped
     in a `.relative` div for an overlaid icon (Project) keep their `.field-error` outside that
     wrapper, so the original one-level lookup silently found nothing and those fields' validation
     messages never appeared at all — the input just turned red with no explanation.
6. **Task mutations** — `deleteTask`, `updateTaskStatus`, `replaceAllTasks` (import), archive/
   unarchive — all writing directly to Firestore; there is no local-first optimistic queue beyond
   what `onSnapshot` naturally re-renders.
7. **View renderers** — one function per view: `renderBoard` (kanban + drag-and-drop), `renderGantt`,
   `renderCalendar`, `renderPeople`, `renderProjects`, `renderActivityFeed`, `renderArchived`,
   `renderFocus` ("Focus of the Day"), `renderSuggestions`. `setView`/`renderCurrentSecondaryView`
   switch between them; `renderAll` re-runs the relevant renderer(s) after any data change.
   - **`renderGantt` stacking tiers** (all below 30, so a sticky Gantt cell can never cover the
     app header at `z-40` or its notification/user-menu panels at `z-30` — `z-40` vs `z-40` did
     exactly that once, with the corner cell covering the mobile nav menu):
     `26` corner · `25` month + day header (the frozen top row) · `20` task label column (the
     frozen left column) · `15` today line · `0` leave bands then bars.
     - **The header used to be `z-10`, *below* the label column's `z-20`**, on the reasoning that
       the two can never overlap because "one owns the header rows, the other owns a task row."
       That holds only while nothing scrolls. A sticky header travels down over the rows beneath
       it, and at that moment the task names painted straight over the month and day numbers —
       reported from a screenshot. A frozen top row has to out-rank the other frozen edge.
     - **Raising the z-index alone was not enough.** The header cells were semi-transparent
       (`dark:bg-zinc-700/80`, and the weekend/today tints at `/70`, `/40`, `/10`), so bars
       scrolling underneath still showed through as ghost blocks. Every cell in both header rows
       is a solid colour now.
     - **Do not give these cells a `top` offset to clear the app's own sticky header.** Tried
       and reverted the same day. `position: sticky` with `top: 200px` does not mean "stop 200px
       down once you scroll there" — it means "never come closer than 200px to the scroll
       container's top edge", which the header satisfies **immediately, before any scrolling**,
       by dropping 200px down into the middle of the chart and floating over rows 3–4, leaving a
       blank band where it belonged. Reported from a screenshot within minutes of shipping.
       `top-0` / `top-8` are correct. The app header (`sticky top-0 z-40`) does still sit above
       the frozen row when the page scrolls; if that ever needs solving, the fix is to make the
       chart its own scroll container — `#gantt-wrap` currently sets **no `overflow` at all**, so
       the page is the scroll container and `scrollWrap.scrollLeft` in the "keep today in view"
       block is a no-op — not to offset the sticky cells.
   - `renderGantt`: day-column width is capped (`GANTT_MAX_DAY_WIDTH`) so a short date range doesn't
     stretch into oversized solid-color bars; the sticky Task label column needs a higher `z-index`
     than the today-line and day-grid content or bars paint over it (they're normal-flow siblings
     with no explicit z-index, so DOM order wins by default); the "scroll to keep today in view"
     math has to subtract the label column's width from the viewport before positioning, or it
     lands the target under the sticky column on narrow cards. Only tasks with *both* a
     `startDate` and a `deadline` can plot a bar; both are individually optional elsewhere (the
     "TBD" deadline checkbox in the task modal), so a task can be otherwise fully filled-in and
     still have nothing to draw. `#gantt-hidden-note` (updated at the top of `renderGantt`) says
     how many filtered-in tasks are missing one or both dates, so they don't just silently vanish
     from this view with no indication anything's hidden — same reasoning for the empty-state
     message when *every* filtered task is missing a date. Bar/dot color comes from `pm`,
     chosen as `Done` → `DONE_META` (green) → else `isReadyForReview(t)` → `READY_FOR_REVIEW_META`
     (purple) → else `PRIORITY_META[t.priority]`. **Ready for review** means `status === 'Review'`
     *and* every checklist item is checked off (an empty checklist doesn't count — nothing to
     have finished) — fully done from the assignee's side, just waiting on someone else's
     sign-off, so priority no longer says much about what to look at. Same `pm`-shape object as
     `PRIORITY_META`/`DONE_META` (`badge`/`dot`/`bar`/`barLight`/`border`), Gantt-only for now —
     Board cards, Focus of the Day, and People/Projects still color purely by priority/Done.
     - **The sticky Task label column leads with the project, not the task** — same field-priority
       swap as the Board cards (`t.project` bold, `t.assignee + ' · ' + t.name` muted underneath;
       used to be `t.name` bold / `assignee · project` underneath). Asked for directly after
       seeing the Board's version. Deliberately **not** a rerun of the Gantt's project-*grouping*
       revert (`db57071` — row-per-project header/summary-bar, reverted for not working on the
       real board): this is a label-text swap on the same flat, date-sorted row list that already
       exists, nothing about row order, count, or the chronological alignment a Gantt exists for
       changes. That's the actual reason grouping failed there and a plain swap doesn't share it.
   - **`dueUrgency(t)`** is the single source of truth for "overdue"/"due soon", shared by the
     Board badges, stats bar, Projects tab's per-project overdue chip, People view, and the This
     Week digest. It exempts `status === 'Review'` the same way it already exempted `'Done'` —
     once a task is sent off for review (client or internal sign-off), the clock isn't really the
     assignee's anymore, so flagging it OVERDUE the day after its original deadline is a false
     alarm about someone else's response time, not the assignee falling behind. `renderFocus`
     shows a dedicated blue "Under review" label for the same status instead of a days-based one
     (`Xd overdue`/`Due today`/etc.), and `focusScore` skips its urgency boost for Review tasks
     too — otherwise a heavily-overdue-but-in-review task would still dominate the top of Focus
     of the Day by sort score even with a calm badge. That in turn meant Review tasks could get
     crowded out of the strip's 6-slot cap entirely by unrelated overdue work elsewhere, so
     `renderFocus` reserves up to `FOCUS_REVIEW_RESERVED` (2) slots for the highest-priority
     Review tasks before filling the rest of the 6 normally — guaranteed a little visibility
     without letting Review tasks dominate the strip the way the old urgency boost did.
   - **`focusScore(t)`** (shared by `renderFocus` and the Board's "Sort: Focus" option) weighs
     deadline proximity above priority tier, not just alongside it: a Low-priority task due
     today outscores a High-priority task due in three weeks. Priority (`PRIORITY_WEIGHT × 1000`)
     is the tiebreaker among similarly-urgent tasks, or the only signal once nothing has a
     near-term deadline — it was previously the dominant term for anything not yet overdue (the
     old near-term boost topped out at +450, dwarfed by the 1000-point gap between priority
     tiers), which let a High-priority task with weeks of runway rank above something actually
     due soon.
   - **Board columns render one card per project, not one card per task** (`groupTasksByProject`
     + `projectGroupCardHtml` + `boardTaskRowHtml`, all called from `renderBoard`). This *is*
     project-row-grouping, on the one view where the earlier Gantt attempt at the same idea
     (`db57071` — "didn't work in practice on the real board") doesn't apply: a Gantt row's whole
     point is chronological alignment (who's doing what at the same time), and clustering by
     project breaks that. A Kanban column has no such axis — it's already siloed by status — so
     this is closer to a plain Jira/Trello swimlane than to what was reverted there.
     - `groupTasksByProject(list)` clusters an *already-sorted* column's tasks by project without
       reordering them — a project's group appears wherever its first (best-sorted) task would
       have anyway, and tasks keep their relative order within the group. So the "Sort: Focus /
       Priority / Deadline / Project" dropdown still controls order (which project card comes
       first, and row order within it) — it just no longer controls *whether* tasks cluster,
       which happens unconditionally regardless of sort mode.
     - **`projectGroupCardHtml(g)`** is the one wrapper every project gets — project name as the
       card header, tasks underneath as `divide-y`-separated rows — whether the project has one
       task or five. That "always the same treatment" is what actually resolved the repeated
       feedback about grouped and ungrouped cards looking inconsistent: there's no longer a
       second look to be inconsistent with.
     - **`boardTaskRowHtml(t)`** is a compact three-line row (task name; then assignee; then a
       priority/status badge, deadline with a calendar icon, logged time, and an OVERDUE/DUE
       TODAY/DUE TOMORROW badge when relevant — plus a priority dot on the row's left edge),
       not a shrunken version of the old full task-card. Checklist/comment
       counts and the Drive-link shortcut stay dropped — reachable by opening the task
       (`data-open-task`, unchanged). Time logged (`taskTimeMinutes(t)`, clock icon +
       `formatDuration`) came back after its removal was reported directly ("the time or hrs are
       missing where it was there originally") — only shown when non-zero, same as the old card's
       conditional. **Edit/Archive/Delete icon buttons shipped removed, then came back too** —
       their first removal was reported as a real usability loss ("icons and buttons are missing
       now, compromising on usability"), not just fewer badges: those are core actions people
       expect to reach without opening the full modal first, unlike the purely-informational
       counts/link that stayed cut. Row padding also went `py-2.5` → `py-3` and the metadata
       line's top margin `mt-0.5` → `mt-1` after the same feedback called the rows "too cramp." The gap *between* project
       cards in a column (`data-column-body`'s own `gap-*`) went `gap-2.5` → `gap-4` on a
       follow-up "space out the cards more" — a separate axis from the in-row padding above; both
       needed their own pass. The project title itself went `text-sm` → `text-base` (matching the
       column header `<h3>`'s size) for clearer hierarchy over the `text-sm` task names below it.
       **A visible priority/status badge (`pm.badge`, "MEDIUM"/"HIGH"/"Completed") came back into
       the metadata line too** — the priority dot next to the task name (still there) was reported
       as insufficient on its own ("priority labels are missing"): a colored dot backed only by a
       hover `title` isn't actually readable at a glance, which the badge fixes without removing
       the dot's quick left-edge color scan down a column of rows. That badge landing right next
       to the avatar/assignee/date with only `gap-1.5` between everything then got its own "too
       cluttered" report — the metadata line's gap went `gap-1.5` → `gap-2`, badge/overdue/
       due-soon pills' padding `px-1` → `px-1.5`, and the gap under the task name `mt-1` → `mt-1.5`;
       the avatar+assignee pair is now wrapped in its own flex span so they stay visually paired
       as one unit as the surrounding gap grows, and the `·` separator between assignee and date
       was dropped — redundant once real spacing does that job instead.
       **The metadata is now two stacked rows, not one wrapping strip** — avatar+assignee on its
       own line, then priority badge / deadline / logged time / urgency badges together on the
       next. Before that it led with the priority badge sitting directly next to the avatar with
       only the row's normal `gap-2` between them — two similarly compact, colorful elements with
       nothing to tell them apart, which read as one cluttered blob rather than two distinct facts
       (reported against a screenshot: "separate the name and the priority badge"). The first fix
       kept them on one `flex-wrap` line split by a 1px vertical divider, but at real board-column
       widths that line wrapped *mid-cluster* — the badge landing beside the name and the date/time
       orphaned below — so the same screenshot came back with "put the priority badge, date and
       time in one row, the name on a row on its own." Two explicit rows make the break point
       structural instead of width-dependent, which is the thing a divider on a wrapping line
       can't do; the divider is gone with it, since separate rows already say "different kinds of
       information." The second row keeps `flex-wrap` purely as a narrow-column fallback.
       **The two meta lines span the full card width; only the task name shares a line with the
       Edit/Archive/Delete buttons.** The row was originally one horizontal flex — dot, a
       `min-w-0 flex-1` text column, then the button cluster — so every line inside that text
       column, meta lines included, was ~100px narrower than the card, even though the buttons are
       24px tall and the space beside the meta lines was empty. At a 4-column (`xl:grid-cols-4`)
       board that shortfall was enough to push logged time onto its own line anyway, defeating the
       stacking above — reported as "why are the times here in a separate line?" So the row is now
       `flex flex-col`: a top line (dot + name + buttons) and the meta block below it, indented
       `pl-[18px]` (the dot's `w-2` + the top line's `gap-2.5`) so it aligns under the name with
       the dot still alone on the left edge for a column-wide priority scan. Reclaiming that width
       was preferred over shrinking the badge/date/time type, which would have bought less room
       and cost legibility.
       Still carries `class="task-card"` and `data-task-id` despite being visually a row now, so
       `attachBoardDnD`'s existing `.task-card` drag wiring and CSS (`.dragging`,
       `.task-just-completed`) keep working unchanged — only the inner grip span
       (`data-drag-handle`) is actually `draggable="true"`; the dragstart it fires bubbles up to
       whatever ancestor has the listener, so a row works exactly like the old card did there.
     - **Three iterations landed here, not one.** A dot/uppercase-label/left-border header on
       cards that stayed full-size was reported as clutter — a visual motif existing nowhere else
       on a card. Removing the header but keeping full-size cards (just tighter-spaced, first
       card naming the project) was reported as still not what was meant. What was actually
       wanted — confirmed against a text mockup before building it a third time, after two misses
       — was a real project-card container with a task list inside it, each row still showing
       assignee/deadline. `renderFocus`'s Focus-of-the-Day cards are unaffected by any of this —
       a narrower, always-just-this-person's-work strip that was never part of this request.
   - `renderProjects`: splits into **Ongoing** (sorted by `nextDeadline` ascending) and **Completed**
     (sorted by `lastArchivedAt` descending, collapsible) side-by-side columns, not one flat list —
     each task/project row also has a separate amber "OT" badge (`taskOvertimeMinutes`) next to its
     billable time. A project is "Completed" purely by every one of its tasks having `archivedAt`
     set (`activeCount === 0`), not by task `status` — a project can be all-`Done` and still show
     as Ongoing until someone (or `checkProjectDeadlinePopups`, below) actually archives them.
     - **`openCount` (active *and* not `Done`) is tracked separately from `activeCount` (active,
       regardless of status) specifically so the card header doesn't lie by omission.** It used to
       show an unqualified "N active tasks" even when every one of those tasks was already
       `Done` — reading as a contradiction next to task rows that literally said "Completed"
       right below it (reported as "why is this project still in Ongoing?" against a project
       whose only task showed Completed). `projectCardHtml` now picks the label based on
       `openCount` vs `activeCount`: genuinely open work still reads "N active tasks"; a project
       where `openCount === 0 && activeCount > 0` reads "All N tasks done" instead, in emerald,
       plus a **`.project-archive-btn`** ("Ready to archive") that calls the existing
       `archiveProjectTasks` directly via `confirmArchiveProject` — same confirm copy and same
       archive call as `promptProjectReadyToComplete`, just reachable any time every task is
       Done rather than gated on the project's deadline having passed, and not part of the
       once-per-session popup queue. Delegated on `#projects-grid` alongside the two existing
       deadline handlers, same reasoning (innerHTML gets replaced on every snapshot).
   - Checklist items support drag-to-reorder (native HTML5 DnD) in `renderChecklistEditor`.
   - `checkProjectDeadlinePopups()` (called after every `tasks` `onSnapshot`, guarded by
     `projectPopupShown` so each qualifying project only prompts once per session) nudges a
     project's own assignee(s) — anyone with at least one active task in it — around its
     deadline, defined as the *latest* deadline among its active tasks (when the whole project
     is meant to be done, not just its next task): if that date has arrived or passed and every
     active task is `status === 'Done'`, `promptProjectReadyToComplete` offers to bulk-archive
     them via `archiveProjectTasks` (same batched-write shape as the existing "Archive completed"
     board action, scoped to one project); if it's due today and something isn't done yet,
     `promptProjectDueToday` is a plain reminder, no action taken. Both reuse `openConfirm`
     (tone `'question'`) and are serialized through a small queue (`enqueueProjectPopup`/
     `advanceProjectPopupQueue`) so two qualifying projects in the same snapshot don't stomp each
     other's modal state — and both defer entirely while the task modal or another confirm is
     already open, rather than interrupting an edit in progress.
   - **Filters persist across reloads** (`FILTERS_KEY = 'flowboard_filters'`, `loadFilters`/
     `persistFilters`/`restoreFilterControls`). Only the five known keys are read back, so a
     stale or hand-edited `localStorage` value can't inject anything else. Safe to persist
     precisely *because* every active filter already renders as a visible pill next to a Clear
     button — there is no hidden state to be surprised by, which is the usual objection to
     remembering a filter. At five people the unfiltered board fit on one screen and re-narrowing
     it each session cost nothing; at eleven it's the first thing everyone does on every visit.
     - **`reconcileFilters()` runs from the `tasks` `onSnapshot` handler, not from a renderer**,
       and this placement is the whole trick. A restored filter naming a project or person who
       has since left the board has to be dropped — left active it hides every task with no pill
       on screen explaining why and nothing to click to clear. But the first `renderAll()` fires
       at `init()` while `tasks` is still `[]` waiting on the first snapshot, so doing this check
       in `renderFilterOptions` would clear *every* persisted filter on every load. The snapshot
       handler is the one moment the set of real projects/people actually changes and the only
       point at which `tasks` is known to be loaded. `renderFilterOptions` now reads `filters` as
       its source of truth (not the select's own value, which is empty on a fresh load) and only
       *displays*.
     - `restoreFilterControls()` (called first in `init()`) pushes the persisted values back into
       search/priority/sort only. The project select has no options yet at init time (and the
       people filter has no roster yet either); `renderFilterOptions` restores those.
     - **The people filter (`filters.assignees`) is a checkbox multi-select, not the single-value
       `<select>` it used to be** — requested directly, framed as "subscribing to calendars":
       pick any number of people whose schedule/workload to see, not one at a time. Built as its
       own `#filter-people-trigger`/`#filter-people-menu` pair (not another `enhanceSelect()`
       instance, which only ever drives one value) but registered into the same
       `allEnhancedSelects` array those use, so it gets "closes on outside click / Escape / when
       another header panel opens" for free from the existing generic handlers instead of a
       second copy of that logic. `renderPeopleFilterList()` (called from `renderFilterOptions`)
       rebuilds the checkbox list from `teamRoster()` — **the roster, not `uniqueValues('assignee')`**
       — on purpose: someone with zero current tasks is still a real person to pre-subscribe to
       before they have any, which a tasks-derived list would never offer. `reconcileFilters()`
       validates persisted names against the same `teamRoster()` list.
       - **Two things were decided rather than assumed, both kept at the safer/more-consistent
         default:** nobody checked still means "show everyone" (matches the old filter's empty
         state — an opt-in-only "nothing shows until you subscribe" reading of the calendar
         metaphor was considered and rejected as too easy to load into a confusing empty board);
         and it applies to the same four views the old single-select touched (Board/Gantt/
         Calendar/People), not narrowed to just Gantt/People, so the app has one filtering
         behavior everywhere instead of two.
       - `loadFilters()` migrates the old persisted single `assignee` string into a one-item
         `assignees` array, so someone's existing narrowed view survives the upgrade instead of
         silently resetting to Everyone.
       - **`DEFAULT_FILTERS.assignees` is a literal `[]` that must never be handed out as-is.**
         `Object.assign({}, DEFAULT_FILTERS)` only shallow-copies, so every consumer (the
         `loadFilters()` catch-all, the Clear-filters handler) explicitly overrides `assignees`
         with its own fresh `[]` — sharing the template's array would let one caller's
         `push()`/`splice()` corrupt the default for every other caller in the same page load.
   - `filters.search` (the search box, `#filter-search`) matches name/project/assignee plus
     checklist-item text and comment text (`applyFilters`) — wired into **Board, Gantt, Calendar and
     People**, the four views listed in `SEARCHABLE_VIEWS`. Projects/Activity/Archived/Suggestions
     don't route through it. (An earlier version of this note also excluded Calendar; that stopped
     being true once `renderCalendar` started calling `applyFilters` and the note wasn't updated —
     if you change which views filter, change `SEARCHABLE_VIEWS` and this line together.)
     - **Activity is searchable too, and it is the one entry in `SEARCHABLE_VIEWS` that does not
       route through `applyFilters()`.** `renderActivityFeed` runs its own match over the summary
       line and the person, because an activity row is not a task — the priority/project/assignee
       filters describe tasks, and silently applying them to a log of "X renamed Y" entries would
       hide rows for reasons the row itself never displays. `syncSearchAvailability()` swaps the
       placeholder to "Search activity…" there so the box doesn't promise checklist/comment search
       it isn't doing on that view.
     - **The box disables itself on the views it doesn't affect.** `syncSearchAvailability()`, called
       from `setView`, sets `disabled`, swaps the placeholder to "Search doesn't apply here", adds a
       tooltip naming the view, and dims it. Previously the box stayed fully enabled everywhere, so
       typing on Archived changed nothing and read as "there is no such task in the archive" — a
       wrong answer rather than no answer. If you make another view searchable, add it to
       `SEARCHABLE_VIEWS` and it picks this up automatically.
     - **The Sort dropdown had the same gap, reported directly as "sorting isn't working" on
       Activity and Projects.** Neither ever read `filters.sortBy`: Projects always sorts Ongoing
       by soonest deadline and Completed by most recently archived (one true order, not a user
       choice), and Activity is a chronological log with no priority/deadline/project fields to
       sort by in the first place. Projects gets the same disable-with-a-reason treatment as
       search (`SORT_DISABLED_VIEWS`, `syncSortAvailability()`) — `enhanceSelect()` gained a
       `setDisabled()` method for this (`sort-by` needed one, `search` didn't: the real `<select>`
       is `sr-only` and out of tab order, so disabling it alone would have left the visible
       trigger button — the thing clicks and Tab actually reach — fully clickable while merely
       looking disabled; `.disabled` has to go on both elements).
       - **Activity briefly got a real Newest/Oldest-first sort instead of a disable** (a
         separate `filters.activitySort` field, its own `<option>` list swapped into the live
         `<select>` per view), reasoning that "newest first" is a meaningful choice for a log even
         though it isn't the same choice a task list offers. Shipped, then reported back on a
         direct follow-up as not wanted on that page at all — pulled entirely rather than left as
         a working-but-unwanted feature: no `activitySort` field, no option-swapping,
         `renderActivityFeed` back to the log's natural (already newest-first) query order. Sort
         is simply in `SORT_DISABLED_VIEWS` alongside Projects now — the difference is Activity
         also hides the control outright (see `ACTIVITY_HIDDEN_FILTER_WRAP_IDS` below) rather
         than leaving it greyed out the way Projects' Sort still is.
     - **Priority/Project/People are hidden outright on Activity, not just left inert.** Same
       "control present, wired to nothing" gap as search/sort above — `renderActivityFeed`
       already had its own comment explaining why these three don't apply (an activity row isn't
       a task). Reported directly once they sat there fully clickable and doing nothing.
       `syncToolbarLayout()`, called alongside `syncSearchAvailability()`/`syncSortAvailability()`
       from `setView()`, toggles `.hidden` on `ACTIVITY_HIDDEN_FILTER_WRAP_IDS` (`filter-priority-
       wrap`/`filter-project-wrap`/`filter-people-wrap`/`sort-by-wrap`) and switches `#toolbar-row`
       from `justify-end` to `justify-center` — with only Search left standing on that view, a
       right-hugging row would read as "most of a toolbar went missing" rather than intentional.
   - **Task dependencies were removed** (they shipped in `7ca02d4` and were taken out again).
     The whole editor is gone: the modal's Dependencies section, `wouldCreateCycle`,
     `renderDependenciesEditor`, `addDependency`, `currentTasksForDeps`, the board card's amber
     `BLOCKED` badge, and the activity-log diff line. **Don't rebuild it without asking** — it was
     cut deliberately, not lost.
     - `dependsOn` is still **read on load and passed straight back through on save**
       (`currentDependsOn`, a plain variable with no editor attached), so a task saved while the
       feature existed doesn't get the field wiped by a routine edit. Same "removed from the UI,
       kept in the data" approach as the Tasks checklist in the sibling Content Hub. It's also
       still sanitised on Import so an export/import round-trip preserves it.
     - In practice there is probably no `dependsOn` data at all: the feature only existed between
       `7ca02d4` and its removal, and that same commit shipped a syntax error that made the whole
       app fail to load, so nobody could have used it. The round-trip is cheap insurance, not a
       response to known data.
   - **This Week digest** (`btn-digest`/`digest-panel`, `renderDigestPanel`): a bell-and-dropdown
     icon next to the notification bell, same interaction pattern, scoped to the signed-in
     viewer's own tasks (`t.assignee === myName`) — Overdue, Due in the next 7 days, and
     "Recently completed" (still really "currently `status === 'Done'`," even though a real
     `completedAt` timestamp exists now — see "Completion motivators" below; this list wasn't
     switched to it, see the comment above `renderDigestPanel` for why). Deliberately in-app
     rather than emailed/Slacked: no connector for either exists yet, and this needed no new
     integration to ship. Called from `renderAll()` so it stays in sync with every task change
     like every other view.
   - **Completion motivators** (`renderBoard`, `boardTaskRowHtml`, `updateTaskStatus`,
     `statusTransitionEffects`) — three small, deliberately-scoped-down pieces addressing "moving
     a card into Done should feel rewarding," built after a toast-per-task-move idea was rejected
     in conversation for fatigue risk on a busy shared board:
     - A `completedAt` timestamp is now stamped on every task the moment it enters `Done`, and
       cleared if it's moved back out — the first real completion timestamp this app has had
       (`archivedAt` is a separate, later, manual action). Existing Done tasks from before this
       shipped simply have no `completedAt` and don't retroactively gain one — same fix-it-forward
       approach as the checklist item id backfill.
       - **`statusTransitionEffects(taskId, taskProject, oldStatus, newStatus)` is the one place
         that decides `completedAt`, the pulse flag, and whether a project just finished** — both
         `updateTaskStatus` (Board drag-and-drop) and the task-modal save handler call it. It
         didn't start that way: this logic first shipped living directly inside
         `updateTaskStatus`, so changing a task's Status dropdown in the modal and clicking Save
         silently skipped all of it (no `completedAt`, no pulse, no confetti) — that path writes
         through its own `setDoc` call, never through `updateTaskStatus`. Reported directly
         ("the confetti doesn't appear when status is changed to completed in the card"), fixed by
         extracting the shared helper rather than duplicating the logic a second time. Takes
         `oldStatus` as a plain value, not an old-task object, specifically so a brand-new task
         saved with `status: 'Done'` on first creation (no old task to diff against) still counts
         as "entering Done" — `oldStatus` is `null` in that case, and `null !== 'Done'` is true.
     - **Card pulse**: a card that just moved into Done gets a one-shot pulse animation
       (`task-just-completed` / `task-complete-pop`). The pulse flag (`justCompletedIds`, id →
       timestamp, TTL ~3.5s) is set **eagerly in `statusTransitionEffects` before the Firestore
       write goes out**, not inside a `.then()` — the `onSnapshot`-driven re-render that actually
       paints the card in its new column can land before the write's own promise resolves, and
       setting the flag too late means the pulse silently never shows.
       - **The green "this is done" signal lives on the row (`boardTaskRowHtml`'s `rowBg`), not
         the column.** It briefly lived on the column too (an emerald tint on the Done column's
         header/background) — reverted after feedback that tinting the whole column on top of
         already-green cards was too much at once. A Done task's row now gets an actual
         background wash (`bg-emerald-50 dark:bg-emerald-500/10`), so the signal is visible
         regardless of which project card it's sitting in. The Done column's header keeps its
         small emerald "N today" pill (a status readout, not a column-wide tint) and its neutral
         zinc background/border, same as every other column.
     - **"N today" badge**: the Done column header shows a count of tasks with `completedAt` on
       today's local date (`completedTodayCount`, via the existing `localDateOf` helper — not a
       raw UTC slice, for the same reason `localDateOf` exists elsewhere). It bounces
       (`done-today-bounce`) only on the render where the count just increased
       (`lastDoneTodayCount`, module-scoped) — not on page load, and not on an unrelated re-render
       from someone else's edit landing via `onSnapshot`.
     - **Confetti fires on every single task completion**, not just whole-project completion —
       `statusTransitionEffects` returns `enteringDone` alongside `willFinishProject`, and both
       call sites (`updateTaskStatus` for Board drag-and-drop, `commitTaskSave` for the modal)
       call bare `spawnConfetti()` whenever a task enters `Done` and isn't the project-finishing
       task. Originally confetti was scoped to whole-project completion only; reported directly
       ("have it per task") as too rare to feel like a reward for everyday task completion.
     - **Whole-project celebration** stays a separate, rarer case worth an actual toast — every
       active task in a project now `Done`. `updateTaskStatus`/`commitTaskSave` check this
       synchronously against the current `tasks` state before the write (same reasoning as the
       pulse flag), and fire `celebrateProjectComplete` instead of the bare per-task confetti —
       a new `'celebrate'` `showToast` type (sparkle icon, longer 5.2s dwell) plus its own
       `spawnConfetti()` call, so a failed write can't produce a false "project complete"
       celebration (the `if (willFinishProject) ... else if (enteringDone) ...` branching at both
       call sites means a project-finishing task gets the special toast+confetti, never a double
       burst of confetti on top of it). This is deliberately independent of
       `checkProjectDeadlinePopups`'s existing archive-prompt, which is gated on the project's
       *deadline* having passed, not on the moment every task actually finishes — both can fire
       for the same project, at different times, for different reasons.
       - `spawnConfetti()` spawns 90 `.confetti-piece` divs (bumped up from an original 28, which
         read as sparse/underwhelming once per-task completion made the burst a far more frequent
         sight — reported directly). On-brand palette (orange wordmark, emerald Done, plus the
         amber/violet already used for overtime/due-soon — not a generic rainbow), each piece
         animated via CSS custom properties set per-element (`--confetti-rot`/`--confetti-drift`
         for fall rotation/drift, `--confetti-w`/`--confetti-h` for a randomized size between
         small flecks and bigger ribbons — a fixed 8×14px rectangle repeated 28 times is what
         made the original burst read as flat/sparse even though every piece animated correctly)
         so one shared `@keyframes confetti-fall` and one shared `.confetti-piece` rule still
         give every piece its own look, then removed via `setTimeout`.
         **`removeConfettiPiece(el)` is a named, parameterized closure factory, not an inline
         `function () { piece.remove(); }` inside the loop** — `var piece` is one shared binding
         across all 90 loop iterations, so an inline closure would have every timeout firing
         against whichever piece the loop landed on *last*, leaking the rest permanently.
         Checks `prefers-reduced-motion` itself and skips creating any elements at all rather
         than the CSS-level `animation: none` override used for the pulse/bounce above — a
         confetti piece that can't fall is just a stray colored rectangle sitting on screen for
         two seconds, which reads as a bug, not a design choice.
     - All the new CSS animations respect `prefers-reduced-motion` (no existing animation in this
       app did before this — Flowboard didn't have the guard the sibling apps already use, until
       now).
     - **Not verified in a live browser this round** — this environment has no Firebase CLI /
       emulator installed, and the app is `type="module"` (unlike the sibling MS Creatives, its
       state isn't reachable from `window.*` for a Playwright smoke test either). Verified via
       `node scripts/check-syntax.mjs` and a careful manual re-read of the diff only. Worth an
       emulator-backed pass before/after the next deploy if anything here looks off in practice.
   - **Review audience** (`reviewAudience` field, `promptReviewAudience`, `reviewAudienceBadgeHtml`)
     — a task entering the Review column gets asked whether the review is for the client or
     internal, and the answer shows as a label on its Board card for as long as it stays there.
     Requested directly, then a direct follow-up ("make it editable as well") turned the label
     from a one-time stamp into something you can click to change your mind.
     - **`promptReviewAudience(onChoose)` reuses the confirm modal instead of building a second
       one** — it already has two independently-labeled buttons (`confirmText`/`cancelText`) plus
       an `onCancel` callback, which is exactly a two-choice prompt's shape. "Cancel" here is a
       real equal choice ("Internal review"), not an abort: dismissing via backdrop click or
       Escape calls neither callback, so `onChoose` simply never fires and whatever
       `reviewAudience` already had (usually nothing, for a fresh move into Review) is left
       alone — asking never forces an answer.
     - **Three separate triggers, all funneling into the same `promptReviewAudience`:**
       (1) dropping a card onto the Review column on the Board — fires *after* `updateTaskStatus`
       completes the move, not before, so the drop itself never waits on a modal decision, then a
       follow-up bare `updateDoc({ reviewAudience })`; (2) flipping the task modal's Status
       dropdown to Review — a `change` listener on `#task-status` prompts immediately and stashes
       the answer in `pendingReviewAudience` (a module var, since Save can't itself await an async
       modal choice), read back into `taskData` at save time; (3) clicking the card's own label,
       any time, via `data-set-review-audience` in the global click delegation — checked *before*
       `data-open-task` there, so clicking the label re-prompts instead of opening the full task
       modal underneath it.
     - **Clearing is centralized in `statusTransitionEffects`, not duplicated at each call
       site** — `if (newStatus !== 'Review' && oldStatus === 'Review') patch.reviewAudience =
       null`, same shared-helper pattern `completedAt` already uses for entering/leaving Done. A
       card leaving Review and coming back later starts blank again rather than silently
       reusing a stale answer nobody just gave.
     - **`openTaskModal()` only carries `pendingReviewAudience` forward when the task being
       opened is *already* in Review** (`task.status === 'Review' ? (task.reviewAudience ||
       null) : null`) — editing a Pipeline task doesn't inherit a leftover value from whatever
       task the modal last had open, and the dropdown's `change` event only fires on an actual
       user interaction, not on `openTaskModal()` setting the initial value — so opening an
       existing Review task and clicking Save without touching Status never re-prompts.
     - **`reviewAudience` is deliberately NOT in `tasks`' `update` rule carve-out** — restricted
       to the assignee or an admin, on request (a first pass briefly opened it to the whole team,
       matching `status`'s own carve-out, before being asked to keep it assignee/admin-only).
       Anyone can still drag a task into Review (that write is just `status`/`completedAt`/
       `updatedAt`, already in the carve-out); the follow-up prompt asking who the review is for
       only actually saves if the person dragging is the assignee or an admin. Since the intended
       restriction was already what the live rules enforced (the brief wider-open version was
       only ever committed, never deployed — see "Firestore rules/index deploys are separate from
       shipping the site" in the top-level `CLAUDE.md`), reverting it in the repo needed no
       redeploy to take effect.
     - **The two write paths handle a permission denial differently, on purpose.** The
       click-to-edit badge (`data-set-review-audience`) surfaces `writeErrorMessage(err, task)` —
       the same assignee-or-admin explanation every other restricted task edit in this app already
       gives — because clicking the label is a deliberate act someone should get real feedback on.
       The drag-and-drop follow-up swallows its error silently instead: dragging a card into
       Review is open to the whole team, so a teammate who isn't the assignee gets asked the
       question and then has the answer quietly rejected *every single time they drag anything
       into Review* — an error toast there would be near-constant noise for an outcome that was
       never really their permission to have in the first place. The assignee or an admin can
       always set it properly afterward via the label itself.
     - **Superseded: task `update` is now open to the whole team** (see "Who can edit what
       (ownership rules)" further down), so both write paths above now simply succeed for
       anyone — the assignee-or-admin restriction this whole point describes, and the two
       differently-handled denial paths right below it, no longer actually happen for
       `reviewAudience`. Left as historical record of why it was ever treated as a special case,
       not corrected in place, since the reasoning (a first pass opened it too wide, then was
       asked to narrow it back) is exactly the kind of thing worth knowing if anyone ever
       reintroduces per-field task ownership again.
     - **Two colors, deliberately not reused from anywhere else that colors a Board card**: blue
       for Client, zinc for Internal. Every other status/priority hue already means something
       specific on this exact row (rose/amber/sky = High/Medium/Low, purple = ready-for-review,
       emerald = Done) or on the project badge above it (the orange/teal/indigo/fuchsia/cyan/
       lime/pink/violet hash palette) — reusing any of those here would have read as a second,
       false signal riding along with the real one.
     - **The badge sits last in the meta row with `ml-auto`, not right after Priority.** First
       shipped next to Priority; reported directly that this crowded the row's left side while
       the rest of it (past the date/time icons) sat empty. Moving it to the end and giving it
       `ml-auto` pushes just that one badge to the row's right edge without disturbing the
       left-packed order of Priority/date/time/overdue before it.
   - **Project group chat** (`#view-chat`, `selectChatProject`, `renderChatView`,
     `renderChatDetail`) — a dedicated message thread + pinned-links list per project, requested
     directly as "something equivalent to a WhatsApp/Google Chat group" for housing a project's
     links, images and conversation in one place, separate from task comments.
     - **A standalone sidebar tab, not a modal** — shipped first as a modal opened from the
       Projects tab, then reported directly ("the chat should be a standalone tab") and rebuilt.
       `data-view-btn="chat"` sits in the sidebar nav right after Projects, with its own
       `messageCircle` icon (a rounded speech bubble) — deliberately not the rectangular
       `message` icon Suggestions already uses one row below it, which would have made the two
       indistinguishable at a glance. The view itself is a two-pane layout: `#chat-project-list`
       on the left (every project, whether or not it has a chat yet), the selected project's
       thread in `#chat-detail` on the right, with `#chat-empty-state` shown until something's
       selected. `renderChatView()` is this tab's renderer, wired into
       `renderCurrentSecondaryView()` like every other view; `TOOLBAR_HIDDEN_FILTER_VIEWS` (the
       generalized form of what used to be Activity-only hiding logic) hides the Priority/
       Project/People/Sort dropdowns on Chat too, for the same reason Activity hides them — none
       of the four describe a project list any more than they describe an activity log.
     - **The project list column is drag-to-resize** (`#chat-list-resize-handle`,
       `applyChatListWidth`) — reported directly against a screenshot where several project
       names ("271231[LittlePaddington]MarketingAgencyPartner2026…") were truncating past
       usefulness in the fixed `w-64` column. This team's project-naming convention embeds a
       long, space-free date/client/campaign string, so no single fixed width reads every name
       without truncating *something* — letting people widen the column themselves beats
       guessing one width that works for every project on the board. Persisted to
       `localStorage` (`flowboard_chat_list_width`), same as `filters` — a personal display
       preference, not shared team state, so it isn't written to Firestore. Only active at the
       `lg` breakpoint the two-column layout exists at (`matchMedia('(min-width: 1024px)')`);
       below that the panes stack and the handle is hidden, since there's nothing to drag between.
       - **The max width is relative (`chatListMaxWidth()`, half of `#chat-panes-row`'s own
         width), not a fixed pixel ceiling** — first shipped as a flat 440px cap, reported back
         directly as too restrictive ("make the width extendable to up to 50% of the space
         allowed"). `applyChatListWidth()` re-clamps against the current cap on every call, not
         just at drag-time (via a debounced `resize` listener too), so a width saved on a wide
         monitor doesn't strand the detail pane too narrow after the browser window itself
         shrinks.
     - **The shared confirm modal (`#confirm-title`/`#confirm-body`) didn't wrap a long,
       space-free string — it overflowed past the modal's edge instead**, surfaced by the same
       long project name above landing in the "Create a group chat for…" confirm. Plain CSS text
       wrapping only breaks at spaces; a single unbroken token wider than the modal (`max-w-sm`)
       had nowhere to break, so it just ran past the `overflow-hidden` edge and got clipped. Fixed
       with `break-words` (`overflow-wrap: break-word`) on both elements — a general fix to the
       shared component, not a chat-specific one, since `openConfirm` is reused for archive/
       delete/etc. confirmations elsewhere that insert task or project names the same way and
       were equally exposed to this, just not yet hit by a name long enough to show it.
     - **Focus of the Day's card had the same overflow, a third place this naming convention
       exposed the same class of bug** — its project-name line had no `truncate` at all
       (`renderFocus`'s card template), so a long project name ran past the card's rounded border
       into the empty space of whatever sat next to it, worse than the confirm modal's version
       since there wasn't even an `overflow-hidden` boundary to stop at. Fixed with `truncate`
       (ellipsis, matching how the chat project list already handles this) plus the same
       `data-tooltip`/`tooltip-top` pair the card's task-name line above it already uses, so the
       full name is still reachable on hover. Worth checking any other place a project or task
       name renders as a bare `<p>`/`<span>` with no `truncate`/`break-words` for the same latent
       bug — this convention's names are unusually good at finding rendering assumptions that
       held for ordinary "Word Word Word" names.
     - **The pinned-link "Label" input was too narrow to read anything typed into it**
       (`w-28` → `w-44`) — reported directly against a screenshot.
     - **Manual, not automatic on a project's first task** — explicitly called out by the user
       mid-build ("this is something to be created manually and not automatically when a user
       creates a task"). Most projects never need a dedicated thread, so `projectCardHtml`'s card
       button and the Chat tab's own "New chat" picker (below) both funnel into the same
       `openConfirm` → `createProjectChat` flow. `Array.isArray(projectDoc.chat)` is the one
       signal a chat exists — no separate boolean flag to keep in sync with it.
     - **`#chat-project-list` only lists projects that already have a chat** — reported directly
       ("if no chat is created, it should not be listed"). It first shipped listing *every*
       project on the board, with a "no chat yet" placeholder row doubling as the create
       affordance; creating one now lives entirely behind an explicit **"New chat"** button
       (`#chat-new-btn`/`#chat-new-menu`, `renderNewChatMenu`) — a small dropdown of exactly the
       complementary set (projects *without* a chat), each option opening the same create-confirm
       `projectCardHtml`'s own button already used. `allProjectNames()` factors out the "every
       project name on the board" query both the list and the picker need the complementary
       halves of. The empty states are worded differently on purpose: "No group chats yet — use
       'New chat' above" (nothing created at all) vs. "Every active project already has a chat."
       / "No active projects on the board." inside the picker itself (nothing *left* to create
       one for) — conflating these would tell someone to click a button that can't actually help
       them.
       - **Only "on the board" projects are offered** (`!isProjectFullyArchived(name)`, the same
         Ongoing/Completed definition `renderProjects` uses) — reported directly after a fully
         archived, wrapped-up project showed up as a "New chat" candidate alongside active ones.
         Starting a fresh conversation for something already finished and archived isn't a real
         use case; this only narrows what "New chat" can start, not what the main list already
         shows — an archived project's *existing* chat (with its own "Completed" tag) still
         appears there untouched.
       - **`#chat-new-menu` is `position: fixed`, computed from the button's own rect on open, not
         an absolutely-positioned child of `#chat-project-list-pane`** — it originally was, and
         got silently clipped by that pane's own `overflow-hidden` (needed for the rounded corners
         and the scrolling list beneath it) the moment a project name was long enough to need the
         wider width below to show. Reported directly against a screenshot. Same fix, and the same
         underlying reason, as `#chat-reaction-picker` a few sections up — a dropdown anchored
         inside any `overflow-hidden` ancestor will eventually clip once its content is wide
         enough, so it has to live outside that ancestor in the DOM and be positioned in viewport
         coordinates instead of document-flow ones.
       - **Option labels wrap (`whitespace-normal break-words`) instead of truncating** —
         reported directly ("the dropdown should expand so the entire title can be seen"). The
         menu's own `max-w-[24rem]` caps how wide any single long name can force the dropdown
         before wrapping takes over, so one very long project name can't blow the picker out to
         an unreasonable width on screen.
     - **Search and a "My chats" filter, both requested directly** — `chat` joined
       `SEARCHABLE_VIEWS` (custom placeholder "Search chats…", same pattern Activity already
       uses for its own non-`applyFilters()` search) and `renderChatProjectList` matches
       `filters.search` against project names. "My chats" (`chatShowMineOnly`, a plain
       session-local toggle button, not persisted — a quick narrow-down while looking, not a
       standing preference like the board filters) was read literally: "chats I am involved in"
       means chats this person has actually **posted in** (`pdoc.chat.some(m => m.author ===
       myName)`), not merely projects they're assigned a task in — those are different
       relationships and the literal one is what was asked for. Both compose with each other
       (search AND My-chats can be active together), and the empty-state message names whichever
       combination produced zero results rather than a generic "no chats."
     - **@mention autocomplete didn't exist in the chat compose box at all** — reported directly
       ("tagging people in the chat does not seem to work"). A manually-typed exact
       `@FullName` would still have highlighted and notified correctly (chat messages already ran
       through the same `parseMentions`/`enrichCommentText` task comments use), but with no
       discoverable `@` menu, nobody would think to try typing a name out in full. The task
       comment box's own autocomplete was hardwired to one specific input/menu pair
       (`mentionInput`/`mentionMenu` module vars); generalized into `wireMentionAutocomplete
       (inputEl, menuEl)` — same name and shape as the sibling Content Hub's own function of the
       same purpose, which had already generalized this before Flowboard did — and instantiated
       twice: once for `#task-comment-input`/`#mention-menu` (unchanged behavior), once for the
       new `#project-chat-input`/`#project-chat-mention-menu`. Each caller holds its own returned
       `{close}` handle rather than sharing one global `closeMentionMenu()`, so sending a chat
       message can't accidentally leave the *task* comment box's menu in a stale state or
       vice versa.
     - **Deleting a message vs. deleting the whole chat — asked for directly, with an explicit
       permission split, refined once more on a direct follow-up.** First pass: "delete a single
       message yes. Delete entire project should only be available for admin." Second pass, once
       single-message delete had shipped: "should only apply to your own message. Not to
       others." Three tiers now, not two:
       - **Your own message** (`removeChatMessage`, the `x` on each message next to its
         timestamp) — `chatMessageHtml` only ever renders that button when `m.author === myName`,
         so someone else's message has no delete affordance to click at all. Deliberately
         *narrower* than removing a task comment (`removeCommentAt`, still open to the whole team
         for tasks) — a later, more specific request than the comment behavior it otherwise
         mirrors structurally (full-array rewrite dropping exactly one entry, same `openConfirm`
         shape).
       - **Someone else's single message, or the whole chat** — both admin-only, and both real
         boundaries in `firestore.rules`, not just hidden buttons.
       - **The whole chat** (`deleteProjectChat`, the trash icon in the thread header, hidden
         entirely unless `isAdminUser()`) uses `deleteField()` on both `chat` and `links` rather
         than writing empty arrays — this is what makes `Array.isArray(doc.chat)` go back to
         `false`, so the project actually disappears from the Chat tab's list and becomes
         eligible for "New chat" again, instead of lingering as a visible-but-empty conversation.
         If the deleted chat was the one currently open, the view falls back to the empty state
         and tears down its typing subscription, the same cleanup `stopListeners` does at sign-out.
       - **The client-side `isAdminUser()`/author-match checks are UX only — the real boundary is
         in `firestore.rules`.** `projects`' `update` rule reads `chat`'s size before and after a
         write (anyone can grow it — post; or leave it unchanged — react), and for a shrink,
         isolates exactly which entry disappeared with `resource.data.chat.removeAll
         (request.resource.data.chat)` (old minus new — safe specifically because a delete leaves
         every *other* entry byte-for-byte unchanged, so this can't misidentify the wrong one).
         `chatSingleOwnRemoval()` then requires the shrink to be by exactly one entry *and* that
         entry's `author` to match the requester's own token name/email — anything else (someone
         else's message, or more than one entry at once) falls through to `isAdmin()`. Same
         "count what actually changed" spirit as `tasks`' own `changedKeys().hasOnly([...])`
         carve-out, just measuring array contents instead of which fields changed.
         `!('chat' in resource.data)` is there so a project creating its **first** chat (a field
         appearing where it didn't exist) doesn't get misread as a shrink and blocked for
         non-admins — that path stays open to everyone, unchanged from before this rule existed.
         **`removeAll()` and list-indexing (`removed[0]`) were not exercised against a live
         Firestore emulator** (none available in the environment this was written in) — if either
         turns out to be invalid Rules syntax, the console will refuse to *publish* the file
         outright (a compile error) rather than silently misenforcing, but this is worth an actual
         test — two accounts, one deleting the other's message — the next time this file changes.
     - **Archived/completed projects keep their chat fully visible and functional, with a quiet
       "Completed" tag** (`isProjectFullyArchived`, same `activeCount === 0` definition
       `renderProjects`' own Ongoing/Completed split already uses) — asked directly ("how about
       projects that are archived?"). Nothing about a project wrapping up should make its chat
       disappear or go read-only: people reference a finished project's thread for exactly the
       reason the Archived *task* view stays browsable instead of being a graveyard ("what did
       the client say back in Q1"). The Chat tab now calls `ensureArchivedTasksListener()` on
       entry (mirroring the Projects tab) so `archivedTasks` is actually loaded for this check,
       not just whichever tasks happen to already be in memory from an earlier view.
     - **Chat's search box moved off the centered treatment it shared with Activity** — reported
       directly ("move search bar to the right"). `syncToolbarLayout()`'s centering used to be
       the same boolean as the filter-hiding one (`TOOLBAR_HIDDEN_FILTER_VIEWS`, both Activity and
       Chat), which made sense back when both views were "just a lone search box, nothing else in
       the row." Chat no longer fits that: it has its own controls (New chat, My chats) directly
       below the toolbar, so a centered search box above them read as floating/misplaced in a way
       it doesn't on Activity, which still has nothing else there. The two concerns are now
       split — `TOOLBAR_HIDDEN_FILTER_VIEWS` still governs which views hide the four filter
       dropdowns (Activity and Chat, unchanged), but centering is now `currentView === 'activity'`
       specifically, and everything else (including Chat) right-aligns.
     - **A dot+count on the sidebar's own "Chat" link** (`renderChatNavBadge`, `#chat-nav-badge`)
       — asked directly, in two parts ("does chat notifications appear on the sidebar?" → no →
       "build the chat dot with number on side bar"). No new data model: the same `notifications`
       collection and `read` flag the bell already tracks, narrowed to the subset carrying
       `chatProject` (an @mention in a project chat — see `notifyOnProjectChat` — the only thing
       that currently notifies about chat activity at all, same as a plain task comment with no
       @mention notifies nobody). Called alongside `renderNotificationBell()` from the same
       `notifications` `onSnapshot` handler, since it's reading the exact same `myNotifications`
       array, just filtered further — there's no separate read-state to invent or keep in sync.
       Positioned `absolute` on the nav button (`relative` added to the button itself) rather
       than inline after the label, specifically so it still renders — overlaid on the icon's
       top-right corner — when the sidebar is collapsed to its icon-only rail, not just in the
       expanded label view.
       - **A mention notification only ever cleared by explicitly clicking it in the bell panel
         or hitting "Mark all read" — opening the same chat by any other route left it sitting
         unread indefinitely.** Reported directly ("when the message is replied to or read, the
         notifications should not remain"). `markChatNotificationsRead(name)` marks every unread
         notification carrying that `chatProject` as read, called from `selectChatProject` (the
         moment the chat is opened, however it was opened — the Chat tab's own project list, a
         deep link, not just the bell) and again from the end of `renderChatDetail` (so a *new*
         mention landing while the chat is already open clears itself too). Replying requires the
         chat to already be open, so covering "opened" covers "replied to" as well without a
         separate check tied to sending a message — there was never a need to special-case
         `sendProjectChatMessage` on top of this.
     - **Lives on the same `projects/{id}` doc as the deadline**, not a new collection —
       `chat` (array of `{id, text, author, date, reactions}`, same shape/append pattern as task
       comments: `arrayUnion` to add, a full-array rewrite to edit an existing entry's fields)
       and `links` (array of `{id, label, url}`). `createProjectChat` reuses
       `projectDeadlineDoc(name)`'s existing find-or-create logic rather than adding a second
       lookup — the function predates chat but was never deadline-specific in what it does, just
       in what it was originally written for.
     - **Reuses `enrichCommentText`/`parseMentions` wholesale** for @mentions and auto-linking
       pasted URLs — a chat message is rendered exactly like a task comment's text, so "links and
       images" just means "paste the Drive/image URL and it becomes clickable," the same as
       comments already do. No separate URL-linkifying code.
     - **Every project assignee gets notified on every chat message, not just @mentions** —
       requested directly ("user don't have to be tagged to receive a notification"), compared
       against WhatsApp's own group behavior before building: WhatsApp notifies every group
       *member* on every message regardless of @mention (a mention there only matters for
       bypassing a *muted* group, a feature this app doesn't have) — membership is explicit, not
       inferred. This app has no explicit "who's in this chat" list at all, so `projectAssignees
       (projectName)` (every distinct `assignee` across that project's active *and* archived
       tasks) is the closest available stand-in for "who's actually on this," chosen directly
       over two alternatives: "everyone who's posted in this chat before" (rejected — it can't
       notify anyone on a chat's very first message) and "the whole team" (rejected — too noisy
       with no per-chat mute to fall back on).
       - **A recipient's notification type is per-person, not per-message** — `notifyOnProjectChat`
         unions `parseMentions(text)` with `projectAssignees(projectName)` into one recipient set
         (so someone who's both @mentioned and a project assignee gets exactly one notification,
         not two), keyed by name so the sender is excluded from their own broadcast the same way
         self-mentions were already excluded. Each recipient's stored `type` is `'chat_mention'`
         if they were actually named, `'chat_post'` otherwise — `renderNotificationBell` and
         `fireDesktopNotification` both branch on this to say "mentioned you in" vs. "posted in,"
         so a plain broadcast notification never claims a mention that didn't happen.
       - **Called unconditionally now, not just when there's text** — forwarding a caption-less
         screenshot, or posting one directly, both still notify a project's assignees;
         previously `if (caption)`/`if (original.text)` skipped the call entirely for an
         image-only message, which (before this change) only meant "no mention was possible
         anyway," but now would have skipped the whole assignee broadcast too.
         `notifyOnProjectChat` takes a `hasImage` third argument so a caption-less image's
         snippet still reads as "Photo" (matching the same fallback used elsewhere) instead of
         an empty notification body.
       - The notification doc carries a `chatProject` field instead of `taskId`/`taskName`;
         `renderNotificationBell` and the notification-list click handler both branch on its
         presence, and clicking switches to the Chat tab and calls `selectChatProject
         (chatProject)` instead of opening a task — same as before this change, unaffected by it.
     - **Reacting to a message notifies its author** (`notifyOnChatReaction`) — reported directly
       ("emoji reactions should create a notification"), confirmed via `toggleProjectChatReaction`
       that this genuinely didn't happen before (a plain Firestore update to the message's
       `reactions` field, no notification write anywhere near it). Unlike `notifyOnProjectChat`,
       this is never a broadcast — only the one message's own author is notified, since a
       reaction is about that specific message, not something the whole project team needs to
       hear about. Only fires on the *add* half of the toggle (`toggleProjectChatReaction` tracks
       this with a local `added` flag) — removing a reaction stays silent, and reacting to your
       own message never notifies you (`notifyOnChatReaction` checks `message.author !== myName`
       itself, a second guard beyond the UI never offering a way to react to nothing). Its own
       `type: 'chat_reaction'` reads "reacted to your message in" in both the bell panel and the
       desktop popup title — a third wording alongside `chat_mention`/`chat_post`, not folded into
       either, since reacting is neither posting nor mentioning.
     - **Read receipts, WhatsApp-style ticks on your own messages only** — requested directly
       ("similar to WhatsApp, can I see whether my message is received or read?"), with the one
       real difference from WhatsApp raised and confirmed before building: WhatsApp's receipts
       work off an explicit, bounded group membership list, which this app's chat has never had
       (anyone on the team can open any project's chat) — so there's no fixed "everyone" to
       compare against and therefore **no third, blue "read by all" state**, just unread (single
       tick) vs. read by at least one other person (double tick, with exactly who named in the
       hover `title`). Computed entirely from data already collected for the unread-dot feature
       (`chatLastRead` on every teammate's own `people` doc, see `markChatRead`/`isChatUnread`
       above) — no new field, write, or query needed. `chatMessageHtml` computes this inline, only
       when `mine`, by checking every `teamPeople` entry (not scoped to project assignees the way
       the notification broadcast is — anyone could plausibly have opened the chat, and there's
       no noise concern for a per-message, opt-in-to-look-at indicator the way there was for a
       push notification) for a `chatLastRead` entry on this exact project whose `at` is at or
       after the message's own `date`. Live: since `teamPeople` updates trigger a full `renderAll`
       already (see the `people` `onSnapshot` handler's own comment on why), a teammate opening
       the chat elsewhere flips your ticks from single to double without any new listener.
       - **`ICONS.checkTick`/`checkTickDouble` are new, deliberately not the existing `check`
         entry** (a checkmark-in-a-circle used elsewhere for "done"/completion UI) — a bare tick
         reads as a delivery/read mark, not a completion badge, and reusing `check` would have
         made this new UI silently mean two different things depending on where it showed up.
     - **An emoji picker was asked for directly, "similar to what we've built on Content Hub"** —
       ported from the sibling MS LinkedIn Hub's `createEmojiPicker`/`EMOJI_CATEGORIES`
       (`content-hub-firebase.html`), which that app's own `DESIGN.md` documents as a *deliberate
       exception* to "never emoji" — real emoji there are the feature's actual content, not UI
       chrome, same reasoning that applies here. `EMOJI_CATEGORIES`'s eight category lists are
       copied verbatim for consistency across Mediashock's tools. The factory itself is
       `createEmojiPickerPanel(tabsEl, gridEl, onPick)`, adapted rather than copied byte-for-byte:
       Content Hub's version is hardwired to one textarea (`insertAtCursor`/`onInsert`), but this
       app reuses the exact same category-tab-plus-grid UI for two different purposes (see
       below), so it takes a plain `onPick(emoji)` callback instead and leaves what "picking" an
       emoji actually does to the caller. `insertAtCursor` itself is copied unchanged.
       - **The compose box** (`#project-chat-emoji-toggle`/`#project-chat-emoji-picker`) is the
         direct port of Content Hub's usage — an inline smiley button overlaid bottom-right of
         the textarea, `onPick` inserting the emoji at the cursor via `insertAtCursor`.
       - **Reactions were asked for separately ("I want more reactions"), on the same message
         that asked for the emoji picker** — read as one request, not two: reactions became real
         emoji rather than the small fixed SVG icon set (Like/Love/Noted) this shipped with
         first. First version added a fixed 6-icon "quick reaction" row (`PROJECT_CHAT_QUICK_
         REACTIONS`) shown on *every* message regardless of whether it had any reactions, plus a
         dashed "+" opening the full picker for anything else — reported back directly as
         cluttered/distracting, so the always-visible row was removed. `chatMessageHtml` now
         renders only reactions someone has actually used, plus the same "+" — a fresh message
         with no reactions shows just the quiet "+", not six icons nobody's touched yet. The "+"
         opens `#chat-reaction-picker`, a *second* instance of the same `createEmojiPickerPanel`
         (one shared panel, not one per message) — the emoji set stays effectively unlimited
         either way, only the always-visible shortcut row was cut. `activeReactionMessageId`
         tracks which message the shared panel is currently open for.
       - **The reaction picker positions itself with `position: fixed`, computed from the
         trigger's `getBoundingClientRect()`** (`openChatReactionPicker`), the same technique
         `positionTooltip` already uses elsewhere in this file — not a CSS-relative dropdown
         anchored to the message row, which `#project-chat-log`'s own `overflow-y-auto` would
         clip the moment the panel needed to extend past the scroll container's edge. The
         compose-box picker doesn't need this: it lives in the non-scrolling footer, so a plain
         `absolute` position anchored to the textarea wrapper is safe there.
       - Toggling a reaction is a full-array rewrite of `chat` (same reason `removeCommentAt`
         rewrites the whole array) — `arrayUnion` can only append a new element, never mutate a
         field on one already in the array. Emoji characters are safe as object keys here
         specifically *because* it's a full-object rewrite, not a dotted-path `updateDoc` call —
         see the typing-presence note below for the case where that distinction does matter.
     - **WhatsApp-style bubbles, reply, and forward — all asked for directly in one message**
       ("can the chat look like whatsapp where my messages are ... on the right while the others
       are on the left? Also replying and forwarding of messages should be possible").
       `chatMessageHtml` was rebuilt around this rather than patched: own messages right-align
       with no name/avatar (you already know it's you, same reasoning WhatsApp itself skips it);
       everyone else's left-align with avatar+name above the bubble, since a *group* chat still
       needs "who said this" answered at a glance, unlike WhatsApp's 1:1 case. Bubbles are soft
       tints (`bg-brand-100`/`bg-zinc-100`), not a solid WhatsApp-green fill — `enrichCommentText`'s
       existing mention/link styling (`brand-600` text) needs a light background to stay
       readable, and white text on a solid `brand-500` bubble would have made both nearly
       invisible; changing bubble color was cheaper and safer than touching that shared function.
       Reply/forward/delete/react first shipped as an `opacity-0 group-hover:opacity-100` icon
       row, then moved to a right-click context menu on a direct follow-up with a WhatsApp Web
       screenshot attached ("can we have the same way whatsapp does it? Right click to show
       options") — see the dedicated section below; `chatMessageHtml` today renders only the
       bubble, timestamp, and any reactions someone's actually added, nothing interactive beyond
       that at rest or on hover.
       - **Reply is a quoted preview, not a nested thread** — deliberately not a rerun of task
         comments' real `replyTo` tree (`renderCommentsLog`, which actually indents children under
         parents). Chat stays flat and chronological; a reply is just a message that carries a
         small quote of an earlier one, exactly WhatsApp's own quoted-reply, not a thread view.
         `startChatReply(messageId)` looks the original up in the *currently loaded* `pdoc.chat`
         (no separate fetch) and populates `#chat-reply-preview` above the compose box;
         `chatReplyTarget` holds `{id, author, text}` until send or cancel.
         `sendProjectChatMessage` attaches `replyTo: chatReplyTarget.id` to the new message and
         calls `cancelChatReply()` in the same `.then()` that already clears the input and the
         mention menu. `chatMessageHtml` takes the *whole* `chat` array (not just the one message)
         specifically so a reply's quote can resolve `m.replyTo` against it; if the original was
         since deleted, the quote is silently omitted — same "don't guess, don't break" fallback
         `renderCommentsLog` uses for a task comment's dangling `replyTo`.
       - **Forward copies a message into a *different* project's chat** — a materially different
         feature from task comments (which have no forward at all) because Flowboard's chats are
         one-per-project, so "forward" here specifically means *across* chats, not within one.
         `openChatForwardMenu` reuses the exact `position: fixed`/`getBoundingClientRect()`
         pattern as the reaction picker and "New chat" menu (`#chat-forward-menu`, a single shared
         panel), listing every *other* project that already has a chat — not `allProjectNames()`
         unfiltered, since forwarding into a chat that doesn't exist yet isn't offered here (start
         one via "New chat" first). `forwardChatMessage` writes a **new** message
         (`{id: uid(), text, author: <the forwarder>, forwarded: true, forwardedFrom:
         <source project>}`) via `arrayUnion` on the target doc — deliberately not attributed to
         the original author, matching WhatsApp's own convention that a forwarded message is a
         new message *you* sent, just tagged where it came from. Reactions and `replyTo` are not
         carried over; a forwarded message starts fresh with zero reactions in its new chat.
         `notifyOnProjectChat` still runs against the target project, so an @mention inside a
         forwarded message notifies there exactly like a freshly typed one would.
     - **`#chat-reply-preview` showed up permanently, empty, regardless of its `hidden`
       attribute** — reported directly ("the reply preview bar should not be there unless
       replying"), twice; the first fix attempt (bumping the whole feature) didn't address the
       actual cause. Root cause: its static class list included `flex` *alongside* the native
       `hidden` attribute. `[hidden]` (a UA-stylesheet rule) and `.flex` (an author-stylesheet
       rule) are equal specificity, and the author stylesheet always wins a tie — so `.flex`'s
       `display: flex` overrode `[hidden]`'s `display: none` regardless of whether the attribute
       was actually set at runtime. This is the identical bug class `task-project-link-row`
       already works around elsewhere in this file (see its own comment) — the fix here is the
       same: `flex` was removed from the static class list, and `startChatReply`/`cancelChatReply`
       now toggle it explicitly alongside `.hidden`, instead of leaving a competing display class
       sitting in the markup permanently. Worth checking any *other* `hidden`+`flex` (or
       `hidden`+`grid`/`block`) pairing in this file for the same latent bug — the other three
       Chat floating panels (`chat-reaction-picker`, `chat-new-menu`, `chat-forward-menu`) happen
       to be safe only because none of them pairs `hidden` with a competing display-setting class
       (`fixed` alone doesn't touch `display`).
     - **Message actions moved to a right-click context menu, WhatsApp Web's own pattern** — asked
       for directly with a screenshot of WhatsApp's real menu attached ("can we have the same way
       whatsapp does it? Right click to show options"), after the hover-icon row and the
       always-present reaction "+" were *both* separately reported as visual clutter first.
       `chatMessageHtml` now renders nothing interactive beyond existing reaction pills at rest —
       `data-message-row="<id>"` on the outer wrapper is the only hook a `contextmenu` listener on
       `#project-chat-log` needs (`e.preventDefault()`, then `openChatMessageMenu(id, e.clientX,
       e.clientY)`). One shared `#chat-message-menu` panel (`position: fixed`, positioned at the
       click coordinates the same way the other floating panels position off a trigger's rect) —
       a quick-reaction row (`CHAT_CONTEXT_REACTIONS`, WhatsApp's own six: 👍❤️😂😮😢🙏) plus a
       "+" into the full picker, then Reply / Forward / Copy / Delete. Right-click is desktop-only
       by design, same as WhatsApp's own — there's no long-press equivalent wired for touch, since
       that wasn't what was shown or asked for.
       - **Copy is new** (`#chat-message-menu-copy`, `navigator.clipboard.writeText`) — the one
         action that didn't exist in any form before this menu; every other action already existed
         as its own inline control and just moved.
       - **Delete only ever shows for your own message** — same `msg.author !== myName` check the
         old inline button used, still backed by the same `firestore.rules` boundary
         (`chatSingleOwnRemoval`) regardless of where the button that triggers it lives.
       - **Forward and the reaction "+" both read their trigger button's position *before* closing
         the message menu**, not after — `openChatForwardMenu`/`openChatReactionPicker` compute
         their own position from `getBoundingClientRect()` on the button that opened them, which
         returns a meaningless all-zero rect once that button's ancestor menu is `hidden`.
     - **Individual chat messages don't appear in the Activity feed; creating/deleting a whole
       chat thread does.** First reported for messages only ("chat messages should not appear in
       Activity") — `logActivity` calls for posting, removing, and forwarding a message
       (`project_chat`) were removed outright, since they'd have flooded a task-focused audit log
       with routine chat traffic and surfaced message *snippets* well beyond the chat itself.
       - **Briefly extended to creating/deleting the thread too, then reverted the same day.**
         A screenshot of a feed dominated by "Posted/Created/Deleted... group chat" rows (from a
         team actively testing the chat feature) first read as "all of this is noise" — `logActivity`
         was dropped from `createProjectChat`/`deleteProjectChat` and `renderActivityFeed` was
         changed to filter out all three types. Corrected directly right after ("create and delete
         project chat should still log under activity"): creating/deleting a thread is a
         project-level event, closer in kind to a deadline change than to the message traffic
         inside it, and stays rare enough not to be noise on its own — it was only *adjacent* noise
         while sitting in the same feed as dozens of per-message rows. Both `logActivity` calls
         are back in `createProjectChat`/`deleteProjectChat`; only `project_chat` stays in
         `HIDDEN_ACTIVITY_TYPES` now.
       - **The stale `project_chat`-type entries already written before the messages fix can't be
         deleted through the app.** `activity` is append-only by design (`allow update, delete: if
         false` in `firestore.rules`, same convention as every audit log in this codebase — see
         the top-level `CLAUDE.md`'s "two rules conventions" section) specifically so nobody can
         erase the record of what they did. `renderActivityFeed` filters `activityLog` against
         `HIDDEN_ACTIVITY_TYPES` before rendering instead, hiding those rows from the feed without
         touching the underlying (immutable) documents — the only way to actually remove them from
         Firestore is deleting them directly in the Firebase console, not through anything this
         codebase exposes.
     - **Typing indicators and reactions were asked for directly, then the free-tier constraint
       was clarified before building either.** Both are plain Firestore field writes with no
       Cloud Storage dependency, so both fit inside Spark's free quota (50k reads/20k writes per
       day) — an 11-person team posting and reacting in one project chat comes nowhere close.
       The one genuine free-tier wall in this app is images/file *uploads*: Cloud Storage for
       Firebase stopped supporting the Spark plan for new buckets in a 2024 policy change, which
       is why links stay paste-only (see above) rather than a real upload/attach flow.
       - **Typing presence** (`projectTyping/{projectId}`, same doc id as the project doc) is
         `{entries: [{name, at}]}`, a plain array rather than a map keyed by display name — a
         name containing "." would otherwise be read as a nested field path by `setDoc`/
         `updateDoc`'s dotted-key handling (e.g. "J. Tan"), silently writing to the wrong place.
         The chat view keeps its own local cache of the latest snapshot
         (`latestChatTypingEntries`) rather than calling `getDoc` fresh on every heartbeat — a
         project has to already be selected (and therefore already subscribed) for anyone to
         type into its chat, so the cache is never actually stale when a heartbeat needs it.
         Entries age out after `PROJECT_CHAT_TYPING_TTL_MS` (8s); a person's own entry also
         clears immediately on blur/send/switching to a different project rather than waiting
         out the TTL, and a plain `setInterval` re-render (`chatTypingTickTimer`, every 2s) is
         what actually hides a stale entry for everyone else once nobody's written a newer
         heartbeat over it — nothing server-side expires it.
       - **Firestore rules needed a new, deliberately wide-open collection block**
         (`projectTyping` in `firestore.rules`) — enumerated explicitly rather than folded into
         an existing rule, per this app's "never `match /{document=**}`" convention. Whole-team
         read/write, same as `projects` itself: there's no per-message ownership to scope here,
         just a small rolling presence list.
     - **Switching the selected project tears down and re-subscribes typing presence
       (`selectChatProject`); switching *tabs* away from Chat does not.** The typing
       subscription and its 2s render timer just keep running cheaply in the background — same
       as every other listener in this app (tasks/people/projects/activity all stay subscribed
       regardless of which view is on screen) — until the selection actually changes or the
       session signs out (`stopListeners` tears both down explicitly, since nothing else would).
     - **The Chat tab re-renders live from the same `projects` listener that already drives the
       deadline UI** — `renderCurrentSecondaryView()` (called from `renderAll()`, which both
       `unsubProjects` and `unsubPeople`'s `onSnapshot` handlers already call on every change)
       calls `renderChatView()` whenever Chat is the current tab, the same way the `tasks`
       listener already re-renders an open task modal. A teammate's new message, reaction,
       pinned link, or presence heartbeat shows up without needing its own listener — resist
       adding an explicit `renderChatView()` call inside either handler; it's already covered by
       the `renderAll()` they call and would just render twice.
     - **The chat's "photo"** (`chatAvatarHtml`, in the tab's project list and the selected
       thread's header) — requested directly ("upload an image for the group chat profile"), but
       a real upload needs Firebase Storage, which no longer supports the free Spark plan for new
       buckets (same wall as every image feature in every Mediashock tool). Built as the
       zero-infrastructure option instead: a solid colored circle with the project's initials,
       the same "colored initials" idea `avatarHtml` already uses for a person with no photo, on
       `PROJECT_AVATAR_PALETTE` — the same 8 hues and hash formula as the existing
       `PROJECT_BADGE_PALETTE`/`projectColor` (the Gantt's project-color badges), so a project's
       chat avatar always lands on the same hue as its badge elsewhere rather than being a third,
       independent color source for the same identity.
       - **The letters shown are `projectInitials(name)`, not the plain `initials()` people use
         — reported directly against a screenshot where nearly every avatar read "2-something".**
         This team's project-naming convention stamps every project with a same-shaped leading
         date ("271231[LittlePaddington]…", "260820[Lark]…"), so plain first-letter-of-first-word
         degenerated to the same digit for almost every project on the board — exactly the
         opposite of "easier identification." `projectInitials` instead pulls from the `[Client]`
         bracket when one exists (confirmed directly: the bracket, not whatever follows it, is
         the part people actually mean when they refer to a project — "the Lark one"), inserting
         a space at camelCase boundaries first since these brackets run words together with no
         spaces of their own ("LittlePaddington" → "Little"/"Paddington" → "LP"). No bracket at
         all falls back to the same leading-date-strip against the whole name, then plain
         `initials()` if that leaves nothing to work with. **Two projects sharing a client
         bracket will share initials** ("[Mediashock]" appears on three of this board's real
         projects) — accepted as correct, not a bug to route around, since the color underneath
         still differs (it's hashed on the *full* name) and the client grouping itself is real
         information, not a collision to hide.
     - **Online presence** (`isPersonOnline`, the green dot on message avatars, the "Online now"
       strip above the two panes) — also requested directly, decided as the cheap option over a
       Firebase Realtime Database `onDisconnect()` presence system (put to the user rather than
       assumed, same as the Google-photo-vs-upload choice on the `people` collection). Reuses
       `people.lastSeen`, which `registerPresence` already wrote once per sign-in, rather than a
       new field or collection: `startPresenceHeartbeat` now refreshes it every
       `PRESENCE_HEARTBEAT_MS` (60s) for as long as the session stays open, plus immediately on
       `visibilitychange` going visible (so reopening a laptop reads as "back online" right away,
       not up to a minute later), and `stopListeners` stops the interval at sign-out.
       `isPersonOnline(name)` treats "seen within `ONLINE_THRESHOLD_MS`" (2 minutes) as online.
       - **This is approximate by design, not a bug**: a silent disconnect (closed lid, lost
         wifi, killed tab) has no "I'm offline now" write to react to, so nobody finds out until
         the heartbeat simply stops arriving. A real Realtime Database presence system would
         catch this instantly via `onDisconnect()`, at the cost of adding a second Firebase
         product (its own security rules, its own thing to keep in sync) to a stack that
         currently only needs Firestore + Auth. Revisit if 2-minute staleness ever actually
         bothers anyone; don't add it pre-emptively.
       - **`renderChatOnlineStrip`'s own `setInterval` (30s) is what actually ages a teammate
         back out to offline** for everyone else, since — per the point above — nothing writes a
         new `people` doc when someone goes quiet, so no `onSnapshot` ever fires to trigger a
         re-render on its own. 30s is deliberately coarser than the typing indicator's 2s tick;
         online/offline doesn't need that grade of immediacy.
       - **`presenceAvatarHtml` wraps `avatarHtml` rather than adding a parameter to it** — scoped
         to Chat's message authors specifically (where online status was asked for), so every
         other call site (task comments, time entries, People cards, Focus of the Day, …) is
         completely untouched.
     - **In-chat search** (`#chat-search-toggle`/`#chat-search-bar`) — requested directly
       ("search within the chat itself should also be possible just like WhatsApp"), distinct
       from `filters.search` on the project list, which only narrows which *chats* are listed.
       Matches message text only (not author names or pinned links). `runChatSearch` reads
       straight from `projectDeadlineDoc(currentChatProjectName).chat`, not from the rendered
       DOM, so match count/order is correct even for messages currently scrolled out of view;
       highlighting is applied separately by walking each matched row's `.chat-message-text`
       text nodes with a `TreeWalker` and wrapping hits in `<mark>` (`highlightTextNode`), rather
       than string-replacing that paragraph's `innerHTML` — the bubble can already contain `<a>`
       tags from `enrichCommentText`'s mention/link handling, and a naive replace risks matching
       inside a tag and corrupting the markup. `clearChatSearchHighlights` reverses it by
       swapping each `<mark>` back for a plain text node and calling `.normalize()`.
       - **`#chat-search-bar` uses the same `hidden`-attribute-plus-JS-toggled-`flex`-class
         idiom as `#chat-reply-preview`** — `flex` is deliberately absent from its static class
         list; putting it there would silently win the display property over `hidden` at rest
         (same CSS-specificity bug documented above), leaving the bar permanently visible.
       - **Re-runs itself on every `renderChatDetail`** (a live update while search is open,
         e.g. a new message arriving mid-search) rather than just jumping to the bottom, since a
         fresh `innerHTML` wipes any `<mark>` wrapping from the previous pass. Re-running resets
         which match is "current" to the first one again — an accepted simplification, not
         tracked as a bug, since a live update mid-search is a rare edge case.
       - Enter/Shift+Enter step to the next/previous match; Escape closes the bar. Switching
         chats (`selectChatProject`) always calls `closeChatSearch()`, same as it already does
         for an in-progress reply or forward, so a search someone was mid-typing doesn't
         silently carry over into a different project's thread.
     - **The chat list's subtitle now shows the latest message, not a message count** —
       reported directly against a screenshot of a real WhatsApp chat list ("the text below the
       chat title should reflect the latest message... show the last update of day or time").
       `renderChatProjectList` reads `chat[chat.length - 1]` and renders `"<author>: <text>"`
       (`"You: …"` for your own last message), with a `chatListTimestamp` on the same row as the
       project name — a bare time for anything sent today, `"Yesterday"` for exactly one day
       back, else a short date, mirroring `activityDateHeader`'s own "Today"/"Yesterday" idiom
       without the full weekday+year the Activity feed's version uses (this has to fit on one
       line next to the project name).
     - **The chat list's default width went 256 → 128 → 400.** 256 (`w-64`) first read as too
       wide against a screenshot of the column at its old default; halving it to 128, a literal
       reading of "make it 50% the default," turned out cramped in practice — confirmed visually
       while testing that pass, `#chat-project-list-pane`'s own header row ("CHATS" + "New chat")
       and every row's name/preview/timestamp all clipped hard. 400 is the number that actually
       stuck, on request after being offered as the recommendation: it matches WhatsApp Web's own
       real list-pane proportions (roughly 380-420px against a typical window), which this whole
       chat feature has been modeled on throughout, and gives each row's now-denser content
       (avatar, name, completed tag, unread dot, star, timestamp, preview line) real room.
       `CHAT_LIST_WIDTH_MIN` ended back at its original 200 — a sensible floor the width debate
       never actually had a reason to change.
       - **A real bug surfaced while landing on 400: the default was silently getting clamped
         down to the 200px floor on every fresh sign-in**, only correcting itself once someone
         manually dragged the column. Root cause: `chatListMaxWidth()` (the 50%-of-row cap) falls
         back to `CHAT_LIST_WIDTH_MIN` when `#chat-panes-row` measures 0-wide, which it reliably
         does at module load and on every `resize` — both of which can fire while the Chat tab
         isn't the active view. `applyChatListWidth()` used to assign that fallback straight back
         into `chatListWidth` itself (`chatListWidth = Math.min(chatListWidth, chatListMaxWidth())`),
         permanently downgrading the real preference to 200 the first time it ran, with nothing
         ever able to raise it back up afterward. Fixed two ways together: `applyChatListWidth`
         now clamps into a local `display` variable for `pane.style.width` rather than overwriting
         `chatListWidth`, and `loadChatListWidth` dropped its own upper-bound check against
         `chatListMaxWidth()` at load time (which had the same 0-wide-row problem, and could
         silently discard a perfectly valid wider *saved* width in favour of the default on
         reload). `setView('chat')` also now calls `applyChatListWidth()` once on entry, so the
         very first time someone opens the tab in a session it re-measures against the row's real
         width immediately rather than waiting for the next resize.
     - **Favourite chats and unread tracking**, both requested directly in the same message
       ("make favourite chats a feature and it should sort alongside My chats. Unread chats
       should also be included in the sorting"):
       - **Favouriting** (`isFavoriteChat`/`toggleFavoriteChat`, the per-row star toggle) and
         **read tracking** (`isChatUnread`/`markChatRead`) both persist on the signed-in person's
         own `people/{uid}` doc — `favoriteChats` and `chatLastRead` respectively — the same doc
         `registerPresence`/`heartbeatPresence` already write to, chosen directly over
         `localStorage` so both stay correct across devices/sessions. No `firestore.rules` change
         needed: `people/{uid}` was already writable only by its own uid, and both are just new
         fields on that same document.
       - **Both are plain arrays of records, not maps keyed by project name** — `favoriteChats`
         is `[name, ...]`, `chatLastRead` is `[{project, at}, ...]`. Same reasoning `projectTyping`
         already documented above: a project name containing "." would otherwise be read as a
         nested field path by `updateDoc`'s dotted-key handling, silently writing to the wrong
         place. `chatLastRead` in particular has to upsert by project name on every write
         (replace-if-present, else append), which is why it's a full read-modify-write rather
         than `arrayUnion`/`arrayRemove` — those only add/remove a literal whole entry, not
         "replace the entry for project X regardless of its old `at`."
       - **`markChatRead` runs both when a chat is opened and on every subsequent re-render while
         it's still open** (called from the end of `renderChatDetail`, not `selectChatProject`,
         since the former already covers both cases) — otherwise a message arriving while someone
         is actively looking at that chat would leave it marked unread again the next time they
         glanced at the list. It skips the write once the stored `at` already covers the latest
         message, so re-rendering an already-caught-up chat doesn't write to Firestore on every
         unrelated snapshot.
       - **Sort order**: favourites first, then unread, then everything else, each tier
         newest-message-first — confirmed directly over a simpler "favourites only, unread is
         just a badge" alternative. Replaces the previous plain-alphabetical order entirely;
         `allProjectNames()` still supplies the starting list, `renderChatProjectList`'s own
         `.sort()` reorders it into these three tiers afterward.
       - **My chats / Favourites / Unread are mutually exclusive, one shared `chatListFilterMode`
         (`null | 'mine' | 'favorites' | 'unread'`) rather than three independent booleans** —
         built independently-combinable first, then corrected directly right after ("only one
         chat sort can be allowed at a given time"). `setChatListFilterMode(mode)` toggles: picking
         a new mode always clears whichever was active, clicking the currently-active one clears
         back to `null` (show everything) — same on/off feel each pill had standalone, just
         exclusive now. All three buttons share one `syncChatFilterToggleUI` that styles whichever
         one matches the current mode and un-styles the other two, rather than three near-identical
         per-button sync functions. Still session-local, like "My chats" always was — only the
         favourite *status* and read-state themselves persist (on the person doc above); which
         filter is currently narrowing the list resets on reload.
       - **The row had to stop being a real `<button>`** (`role="button" tabindex="0"` `<div>`
         now) to host the star toggle as a real nested `<button>` — a `<button>` inside another
         `<button>` is invalid HTML that browsers hoist/break unpredictably. The delegated click
         listener on `#chat-project-list` checks for `.chat-favorite-toggle` first and returns
         before reaching the row-select logic; a parallel `keydown` listener supplies the
         Enter/Space activation a real `<button>` would give for free. `.chat-project-row:active`
         was added alongside the global `button:not(:disabled):active` press-feedback rule, since
         that rule only ever matches actual `<button>` elements and this row no longer is one.
     - **The chat header's subtitle shows the project's Drive folder, not a static caption** —
       reported directly against a screenshot ("it would be more useful to have the project
       folder link there") in place of "Group chat for this project — separate from task
       comments." There's no dedicated project-level Drive link field; `driveLink` lives per
       *task* (see the task modal's Project field). `projectDriveLink(name)` finds the first task
       under that project with a non-empty `driveLink` and uses it — in practice every task in a
       project points at the same folder, so the first match stands in for "this project's
       folder." Falls back to a plain "No project folder linked yet" line when no task under that
       project has one. Re-derived on every `renderChatDetail` (not just when the chat is first
       opened), so editing a task's Drive link while this chat happens to be open updates the
       header live, the same way a new message does.
       - **Shows the link's actual location, not the word "Project folder"** — reported directly
         right after ("show the path/location of the folder instead of 'project folder' for the
         link"). Rebuilt around the exact folder-icon-plus-truncated-URL treatment the task
         modal's own `#task-drive-open` already uses (`syncDriveLinkButtons`): the `https://`
         scheme is stripped for display, the anchor truncates with an ellipsis inside a
         `min-w-0 flex-1` flex row (icon `shrink-0` beside it, same structure as
         `#task-project-link-row`), and the full URL still lives in `title` for a hover tooltip.
         `#project-chat-subtitle` itself dropped its own `truncate` class once the inner anchor
         took over truncation — redundant `white-space: nowrap` on the outer `<p>` had nothing
         left to do once the flex child was sized to fill it.
     - **"Pinned links"'s label/url/submit row is now hidden until "+ Add" is clicked** —
       reported directly ("this should only appear when clicking 'add'. Move Add button to the
       same row as Pinned links but right aligned"). `#project-chat-link-toggle` sits on the
       "Pinned links" row itself, right-aligned via `justify-between`; clicking it a second time
       while open closes it back up, same as the "New chat" dropdown's own trigger button. Same
       `hidden`-attribute-plus-JS-toggled-`flex`-class idiom as `#chat-reply-preview`/
       `#chat-search-bar` for the same reason — `flex` is deliberately absent from
       `#project-chat-link-form`'s static class list. `closeProjectChatLinkForm()` is also called
       from `selectChatProject`, alongside the existing reply/forward/search resets, so an open
       "add a link" form doesn't silently carry over into a different project's chat. A pushpin
       icon (`ICONS.pin`) sits next to the "Pinned links" label itself, requested directly right
       after — the section header had no visual tie to what a literal pin means beyond its text.
     - **Chat image sharing** — requested directly ("can sharing of screenshots be allowed on
       chat"), the first real deviation from "$0/month, needs no server" this app has taken
       (see the top-level `Claude Projects/CLAUDE.md`'s own note on this). Two options were
       weighed against it directly: a client-side upload to a free third-party image host
       (`localStorage` API key, same pattern MS Creatives already uses for its AI features) was
       rejected because chat screenshots can be client-confidential and that would put them on
       a service Mediashock doesn't control; rendering an already-hosted image link inline with
       no new infrastructure was rejected because it doesn't solve "paste a screenshot from your
       clipboard," the actual ask. **Firebase Storage on the Blaze plan** won, on the reasoning
       that an 11-person team's chat screenshots comfortably fit inside Blaze's free-tier
       allotment (5GB storage, 1GB/day download) in practice, even though Blaze removes the hard
       $0 guarantee Spark has.
       - **Needs two manual steps outside this codebase before any of it works, neither of which
         ships by pushing to `main`**: (1) upgrade the `pscr-project-manager` Firebase project
         from Spark to Blaze (requires attaching a billing account — the actual reason Spark
         stopped allowing new Storage buckets in 2024 in the first place) and enable Cloud
         Storage for it; (2) deploy `storage.rules` (`firebase deploy --only storage`, or paste
         into the Firebase console's Storage Rules tab) — same "rules aren't part of the site
         deploy" gotcha `firestore.rules` already has, now with a second rules file to remember.
         Until both are done, every upload attempt fails caught-and-toasted ("Could not send
         image: ..."), not silently and not by crashing the app.
       - **Paste is the only entry point, deliberately** — a screenshot tool (Snipping Tool,
         Cmd+Shift+4, …) puts the image directly on the clipboard, and pasting into
         `#project-chat-input` is the one place in this app a plain image paste is expected to do
         something other than insert text (there's no text form of an image to paste anyway).
         `uploadAndSendChatImage(file)` uploads to `chat-images/{projectId}/{uid()}.{ext}` in
         Storage, gets a download URL, and sends a chat message shaped like every other one but
         with `imageUrl` set and `text` optionally carrying whatever was already typed as a
         caption. No drag-and-drop or file-picker button was added — paste covers the actual
         request, and either could be layered on later reusing the same upload function if asked.
       - **A plain `<img src="...">` pointed at the Storage download URL doesn't work, and this
         is not a smaller-scope corner cut — it's why `storage.rules` requiring auth is even
         possible in a browser at all.** A browser's own `<img>` tag makes an anonymous GET with
         no way to attach an `Authorization` header, so a rules-protected file requested that way
         gets denied outright (a broken-image icon for literally everyone, including signed-in
         teammates) rather than degrading gracefully. `chatMessageHtml` renders the thumbnail
         with no `src` at all — just `data-chat-image-src` holding the real URL — and
         `loadProtectedChatImage(imgEl, url)` fetches it manually with a Bearer ID token
         (`auth.currentUser.getIdToken()`) and points the `<img>` at a `URL.createObjectURL(blob)`
         instead. This is *why* the read rule could be `isMediashock()`-gated rather than public:
         the alternative most Firebase-Storage-backed apps default to (`allow read: if true`,
         because that's the only way a bare `<img>` tag works) would have quietly undone the
         entire reason this went through Storage instead of a public third-party host.
         - **`chat-image-loading` is a real CSS floor (`min-height`/`min-width`), not decorative
           polish** — an `<img>` with no `src` has no intrinsic size, so the grey placeholder
           background would otherwise paint into an invisible 0x0 box. Removed the moment `src`
           is actually set, so a short or very wide screenshot isn't stuck reserving more space
           than it ends up needing.
         - **`chatImageObjectUrls` tracks every blob URL created for the currently-rendered log,
           revoked in a batch at the top of every `renderChatDetail`** — `renderChatDetail`
           replaces the whole log's `innerHTML` on every live update (a new message, a reaction,
           …), and nothing else in this app ever calls `URL.revokeObjectURL` on these, so a long
           session would otherwise leak one blob per image per render, forever.
       - **A click opens a same-page lightbox (`#chat-image-lightbox`), not a new tab** — a
         `blob:` URL is only guaranteed valid in the document that created it, and browsers vary
         on honoring it in a freshly opened tab, which a same-page overlay sidesteps entirely.
         Click anywhere on the overlay (including the enlarged image itself, since the click
         handler is on the overlay and clicks bubble to it) or press Escape to close — same
         `hidden`-attribute-without-a-competing-`flex`-class idiom as `#chat-reply-preview`/
         `#chat-search-bar` elsewhere in this file, toggled by JS instead of left in the static
         class list.
       - **An image-only message (no caption) shows "Photo," not a blank line, everywhere a
         message would otherwise preview as text** — the quoted-reply preview (both the compose
         box's `#chat-reply-preview-text` and a sent message's own quoted block in
         `chatMessageHtml`) and the chat list's own latest-message subtitle. Same fallback logic
         in three places rather than a shared helper, since each site builds its string
         differently (plain `textContent` vs. HTML with an icon vs. a `<span>` folded into a
         larger sentence) — worth consolidating if a fourth site ever needs the same fallback.
       - **A forwarded image message reuses the same Storage URL rather than re-uploading** —
         `forwardChatMessage` copies `imageUrl` onto the new message the same way it already
         copies `text`; it's the same file, still covered by the same `storage.rules` read check
         for whoever's now looking at it in the target project's chat.
       - **Known gap, not yet solved: deleting a message or an entire chat does not delete its
         image(s) from Storage.** `removeChatMessage`/`deleteProjectChat` only ever touch the
         Firestore `chat` array; an orphaned file under `chat-images/{projectId}/` just sits in
         the bucket afterward, and nothing prunes it. Low-stakes at this team's actual volume
         (a handful of KB-to-few-MB screenshots is nowhere near Blaze's free-tier storage
         allotment), but worth a real cleanup pass — e.g. a Storage delete alongside each of
         those two functions' existing Firestore writes — if this ever gets used heavily enough
         for it to matter.
       - **Not verified against a live upload** — this environment has no Firebase CLI/emulator
         and, as of writing, the project hadn't yet been upgraded to Blaze, so the actual
         upload → download-URL → authenticated-fetch → blob-URL round trip has only been
         exercised in pieces: real click/keydown/paste-interception behavior against synthetic
         data (a real 1×1 PNG blob standing in for a fetched one, a fake clipboard image item
         confirming the paste listener intercepts and calls `uploadAndSendChatImage`), not the
         real Storage upload itself. Worth a real two-screenshot test — post one, forward it,
         delete it — once Blaze is live and `storage.rules` is deployed.
   - **Task deep links** (`copyTaskLink`, the `#task=<id>` hash) — "point another user to a
     specific task card," built alongside the project chat above (a message can reference a
     task by pasting its link). `openTaskModal(task)` sets `#task=<id>` via
     `history.replaceState` (not `pushState`, so opening/closing tasks doesn't spam browser
     history) for every existing task it opens — not only when Copy Link is clicked — so the
     address bar is always a valid share link for whatever's open, and `closeTaskModal` clears
     it back to the plain path. `copyTaskLink` (the modal header's new link-icon button, next to
     the close button, hidden on a fresh "Add Task") just writes that same URL to the clipboard.
     - **Consuming the link on load has to wait for the first real `tasks` snapshot** — `tasks`
       starts as `[]`, so checking `location.hash` any earlier would always miss. Guarded by a
       one-time `deepLinkOpened` flag inside the `tasks` `onSnapshot` handler so a *later*
       snapshot (someone else's unrelated edit landing live) can't reopen a task the person
       already closed. A `hashchange` listener separately covers pasting a fresh `#task=` link
       into a tab that's already open, guarded against re-opening the task that's already open.
   - **Overtime is manually tagged** (`task-time-overtime`, `setOvertimeToggle`) — a plain toggle
     button next to Billable, same shape and pattern. It used to be auto-detected: crossing
     `OVERTIME_DAILY_MINUTES` (8h) in a person's cumulative logged time for the day popped an
     `openConfirm` at log time asking whether to mark it. That could fire on an unrelated small
     entry just because *earlier* entries the same day already pushed the total over 8h, and only
     ever checked the signed-in user's own name — not necessarily who the task was actually being
     logged against. A manual toggle is more predictable, at the cost of the automatic nudge that
     used to catch it even when nobody was thinking about it.
   - **General UI polish pass** — modals (task/confirm), every header dropdown (notification,
     digest, user menu, mention autocomplete, and every "enhanced select" filter/sort menu), and
     checklist items ticking done all got a subtle open/check animation, on top of the completion
     motivators above. Requested directly ("subtle animations that make the UI more pleasant to
     use") after noticing most of the app was otherwise instant on/off.
     - **Open-only, deliberately.** Closing still goes through a plain `hidden` toggle everywhere
       (backdrop click, Escape, Cancel, outside-click — many call sites per modal/panel). Adding a
       matching exit animation would mean every one of those delaying `classList.add('hidden')`
       by the animation's duration instead of adding it immediately, which is real extra
       bookkeeping repeated at every close site for comparatively little payoff — an abrupt close
       reads far less jarring than an abrupt open. `.modal-backdrop`/`.modal-pop-in`/
       `.panel-pop-in` all lean on a browser behavior that needs zero JS either way: a CSS
       `animation` on an element restarts on its own whenever that element's `display` flips from
       `none` to visible, so a permanent class on the modal/panel markup is enough — the same
       `[hidden] { display: none !important }` rule that already governs every toggle in this app
       is what makes this work.
     - **`justCheckedItemIds`** (checklist item id → `true`, TTL 500ms) is the same eager-flag
       pattern as `justCompletedIds` for the Board card pulse, scoped to checklist items instead
       of tasks: set in the `.checklist-toggle` change handler the moment an item goes from
       not-done to done, read by `renderChecklistEditor()` to add `.checklist-just-checked` (a
       brief green background flash) to that row on its next render.
     - All the new animation classes are covered by the existing
       `@media (prefers-reduced-motion: reduce)` block alongside the completion motivators.
   - **Second polish pass** — drag-and-drop, button presses, and the notification bell, added
     after the first pass was well received and asked to be extended:
     - **Dragging a card/checklist item** now has a smooth lift instead of an instant opacity
       snap (`.task-card.dragging` gains `transform: scale(1.02)` + a drop shadow;
       `.checklist-item-row.dragging` gets the same shadow treatment). `.task-card` already
       carried Tailwind's bare `transition` class from earlier work, so this needed no new
       transition rule; `.checklist-item-row` didn't, so it got one added explicitly. The Board
       column's drop-target highlight (`.col-drop-target`) also gained a `background-color`
       transition on `[data-column]` for the same reason — only the color is transitioned, not
       the outline, since `outline-style`/`width` don't animate reliably across browsers and the
       color fade alone already carries most of the visible effect.
     - **`button:not(:disabled):active { filter: brightness(0.9); }`** is global press feedback,
       deliberately using `filter` instead of `transform`. Flowboard doesn't have a shared
       `.btn`/`.icon-btn` class anywhere (unlike the sibling apps) — every button is raw Tailwind
       utilities — so a single global rule was the only way to cover all of them without editing
       every button's markup. `transform` was ruled out specifically because several buttons
       already use it for their own hover effect (e.g. the Focus-of-the-Day cards'
       `hover:-translate-y-0.5`), and a global `:active` transform would have silently replaced
       those instead of composing with them; `filter` composites independently, so it can't
       collide. Also deliberately *not* wrapped in its own `transition` rule — most buttons
       already carry Tailwind's bare `transition` class, whose default `transition-property` list
       already includes `filter`, so adding one here risked overwriting whatever properties an
       individual button's existing `transition` was actually covering (a bare CSS `transition`
       shorthand fully replaces the list, it doesn't merge with what's already declared).
     - **`nudgeNotificationBell()`** shakes `#btn-notifications` once per snapshot when a new
       *unread* notification actually lands via the `notifications` `onSnapshot` listener —
       same `notifListenerReady`-gated "added after the first snapshot" detection
       `fireDesktopNotification` already uses (see the comment there on why a ready-flag, not a
       timestamp comparison), called once per snapshot rather than once per new doc so a batch of
       several notifications (e.g. one comment mentioning three people) doesn't restart the shake
       repeatedly. Fires regardless of the desktop-notification opt-in, so it's the one new-
       activity cue everyone gets. The bell button is a persistent DOM node (never recreated),
       so this is a plain `classList` add/remove-after-timeout rather than the render-time flag
       pattern `justCompletedIds`/`justCheckedItemIds` use — no render pass needed to pick it up.
       The remove → forced reflow (`void btn.offsetWidth`) → re-add sequence lets the animation
       restart cleanly if a second notification arrives mid-shake, instead of the class-already-
       present no-op that a bare re-add would otherwise be.
8. **Live listeners** — `startListeners`/`stopListeners` wire up four `onSnapshot` subscriptions
   (`tasks`, `activity`, a per-user `notifications` query, and `suggestions`), gated by
   `onAuthStateChanged`.
9. **Version-poll auto-reload** — see Deploying above.

### App shell: sidebar nav, not a horizontal tab row

`#app` is a top-level flex **row**, not a flex column: `<aside id="sidebar">` beside a
`<div class="flex-1 ... flex flex-col overflow-hidden">` holding the (now much slimmer) `<header>`
and `<main>`. This replaced a single flex-column page where 8 view tabs, search, four filters, and
half a dozen action buttons all lived in one horizontal header — reported directly as too much
crammed into one strip. Agreed on via an interactive mockup (a separate, standalone artifact) before
touching this file, per standing collaborate-before-building feedback — see that memory if this
needs revisiting.

- **Nav is the one thing that actually moved to the sidebar.** The 8 `.view-toggle-btn` buttons
  (same `data-view-btn` attribute, same click wiring, same icons) now live in a vertical
  `<nav>` instead of `#view-tab-row`'s horizontal track. `setView()` used to toggle 7 individual
  Tailwind utility classes per button (`bg-white`/`shadow-card`/`text-brand-700`/etc. — shaped for
  a white pill floating on a grey track) — now toggles a single `.active` class, with
  `.view-toggle-btn`/`.view-toggle-btn.active`/`:hover` rules in the styles block deciding what
  that looks like for a rail item instead.
- **Notification/digest bells stayed in the top header; account (avatar, theme toggle, sign out)
  moved to the sidebar's bottom.** This was the one deliberate relocation beyond "nav moved,"
  matching the Slack/Linear/Notion split: bells are glanced at from wherever you are and shouldn't
  need a side panel open; identity/settings are "set once, rarely touched." `#user-menu-panel`'s
  own markup/ids/content are untouched — only its position rule flipped from `top-full mt-1
  right-0` to `bottom-full mb-1 left-2`, since its trigger now sits near the bottom of the
  viewport instead of the top.
- **The header is no longer `position: sticky`.** It's a `shrink-0` flex sibling stacked above
  the scrolling `<main>` inside the same overflow-hidden column as the sidebar, which pins it at
  the top by construction — sticky positioning was only ever needed back when header+main
  scrolled together as one ordinary page. `<footer>` moved from a sibling of `<main>` to the last
  thing *inside* it, so it's still only seen by actually scrolling to the end (unchanged
  behavior), not turned into a permanently-visible status bar.
- **Sidebar collapse (icon-only rail) is one class, one CSS custom property.** `#sidebar.collapsed`
  swaps a single width via a CSS custom property (`--` not used directly — width is just two
  fixed values, expanded vs. collapsed, on the class selector) and fades `.sidebar-label` spans to
  `opacity:0` — nothing computed or re-applied from JS per click. Persisted to `localStorage`
  (`flowboard_sidebar_collapsed`), restored immediately on load (no auth dependency, unlike
  everything else that waits on `onAuthStateChanged`).
- **Below 767px, the sidebar becomes an off-canvas drawer** (`position: fixed`, `translateX(-100%)`
  by default, slides in on `#app.sidebar-open`) with a dedicated `#sidebar-backdrop` — replacing
  the old `#mobile-view-trigger`, which toggled `#view-tab-row`'s own `hidden` class inline rather
  than sliding anything. The drawer closes on: picking a view (`setView()`), tapping the backdrop,
  or Escape (added to the existing task-modal/confirm-modal Escape handler for the same reason
  those get it — a backdropped overlay should close on Escape). `#sb-collapse-btn` itself is
  `hidden` below `md:`, so "collapsed" and "drawer open" can never be a state to reason about at
  the same time — a stale `collapsed` class surviving a resize down to mobile width is overridden
  back to full labels by the mobile media query (same specificity, later in the stylesheet, wins
  when its condition matches).
- **Verified against the real file, not just the standalone mockup**, before shipping: a scratch
  copy with the auth gate forced open and the real (Firebase-importing) module script swapped for
  a tiny stand-in wiring only the collapse/drawer/nav-click behavior under test, screenshotted in
  light, dark, collapsed, and mobile-drawer states. Still not a live-browser/Firestore check (no
  emulator in this environment) — worth a real click-through after deploying.
- **Floating tooltips (`data-tooltip` + a `tooltip-right`/`tooltip-top` class) are JS-driven, not
  CSS.** Requested directly, for two spots reported in the same message: the sidebar's icon-only
  collapsed rail (nothing labels an icon once `.sidebar-label` is hidden) and a truncated Gantt
  project badge (`projectColor` — see the Gantt section below).
  - **First shipped covering only the Gantt badge, then reported back as still not working —
    it wasn't broken, it just didn't cover what "long titles" actually meant.** The request read
    as one bug about one already-demonstrated spot; it was actually "cards with long titles" in
    general, which the Gantt row (not visually a card) never implied covering. Verified the
    shipped Gantt tooltip really did work first — a real-DOM Playwright test against this exact
    file (auth gate forced open, `#app` unhidden, a synthetic row injected into `#gantt-wrap`)
    showed the full text rendering correctly — before concluding the gap was coverage, not a
    regression. Extended `data-tooltip`/`tooltip-top` to every truncated card/title in the same
    pass: `boardTaskRowHtml`'s task name, `projectGroupCardHtml`'s project header, the Focus of
    the Day card name, and the People and Projects tab card headers (`p.name`/`g.project`). If a
    new card shows a name with `truncate` or `line-clamp-*`, give it `data-tooltip` too — this
    class of "the label just got cut off" report has now happened twice.
  - **A pure `::after`-based tooltip was the first attempt, and it doesn't work here.** The
    sidebar's own `<nav>` (`overflow-y-auto`) and each Gantt row's label cell (`overflow-hidden`)
    both clip an absolutely-positioned pseudo-element the moment it visually pokes outside their
    box — this is true *regardless* of the fact that the pseudo-element's own containing block
    (for `left`/`top` purposes) is the hovered element itself, not that ancestor. Overflow clips
    rendered descendants unconditionally; it has nothing to do with what establishes their
    positioning context. Confirmed with an isolated two-case test (a button inside a
    scroll-clipped `<nav>`, a badge inside an `overflow-hidden` cell) before writing the real
    fix, since this is exactly the kind of thing that looks correct in the markup and is silently
    invisible in the browser.
  - **The fix: one tooltip `<div>` appended directly to `<body>`**, moved with real pixel
    coordinates (`position: fixed`, computed from `getBoundingClientRect()` on hover) rather than
    living inside either clipped ancestor's DOM subtree at all. `positionTooltip()` reads a
    `tooltip-top`/`tooltip-right` class off the *target* to decide which side to render on;
    `tooltipSuppressed()` gates sidebar tooltips to only fire while `#sidebar` actually has
    `.collapsed` — expanded, a nav item's own visible label already says what it is, and (more
    importantly) the collapse button's tooltip text ("Expand sidebar") would otherwise describe
    the wrong action while the sidebar is still expanded, since clicking it there collapses,
    not expands.
  - Delayed on the way in (`setTimeout(..., 300)`, so an incidental mouse pass doesn't flash a
    tooltip) but instant on the way out (`hideTooltip()` called directly from `mouseout`), same
    asymmetry native browser tooltips use. Re-verified the real fix with the same isolated
    two-case test before wiring it into this file — both now render the full text outside their
    respective clipped ancestor, escaping correctly in both directions.
  - **`positionTooltip()`'s `tooltip-top` branch only clamped the left edge, not the right.**
    Never mattered while the Gantt project badge was the only `tooltip-top` user — it always sits
    in the frozen left column, nowhere near the right edge of the viewport. The Gantt's own
    "Progress" toggle (`#gantt-progress-toggle`, replacing its native `title` with `data-tooltip`
    on request, same swap `#sb-collapse-btn` got) sits at the *right* end of the chart's legend
    row, and a tooltip long enough to need centering there ran its right edge straight off-screen.
    Caught from an actual screenshot, not just the passing DOM check — the check only confirms a
    tooltip element exists with the right text, not that it's fully visible. Fixed by clamping
    both edges: `Math.min(centeredLeft, window.innerWidth - tr.width - 4)` before the existing
    `Math.max(4, ...)`.
- **Search + the priority/project/people/sort toolbar moved out of `<header>` entirely, into
  `<main>`, right after `#focus-section`.** It used to share a row with the header's own
  title/stats, directly under it — reported directly as too much crammed under a line that was
  already asking for attention. `#focus-section` (Focus of the Day) has no `data-view` gate and
  already rendered above every view, not just Board, so putting the toolbar right after it gives
  every one of the 8 views the same shared row in the same place, not something Board-specific.
  The row is `justify-end` (right-aligned) with `#filter-search` first, then priority/project/
  people/sort — matching how they read left to right, narrow-to-scoped.
  - **`order-2` alone wasn't enough to put search first — needed `sm:order-first`.**
    `#filters-panel` (holding the four dropdowns) is `sm:contents` at that breakpoint, which pulls
    its children out to become direct flex items of the row *without* inheriting the panel's own
    `order-3` — they fall back to the default `order: 0`, which beats a merely-numbered `order-2`
    search box. Order beat this the same reasoning way CSS overflow beat the tooltip fix above:
    looks correct in the markup, wrong on screen. Caught by actually reading each control's
    rendered `left` position in a real-DOM Playwright check, not by eyeballing a screenshot.
  - IDs, event listeners, and the mobile collapsible-filters-trigger pattern (`#mobile-filters-
    trigger` / `#filters-panel.hidden` toggle) are untouched — nothing in the JS queries these by
    position or by `header`, so relocating the markup needed no script changes at all.
  - **`#toolbar-row` gets a `border-t` + `pt-4`**, separate from the `gap-6` `<main>` already
    puts between sections — Focus of the Day and this row are both dense, and ran together
    without something marking the boundary (reported directly, same message as the header
    alignment fix below).
  - **On Activity, Priority/Project/People hide entirely (`filter-priority-wrap` /
    `filter-project-wrap` / `filter-people-wrap`, toggled by `syncToolbarLayout()`, called
    alongside `syncSortAvailability()`/`syncSearchAvailability()` from `setView()`) and the row
    switches from `justify-end` to `justify-center`.** Same reasoning `renderActivityFeed`
    already gives for skipping `applyFilters()` — those three describe tasks, and Activity isn't
    a task list — but reported separately once they sat there fully clickable and doing nothing,
    the same "control present, wired to nothing" gap Sort had. Search and Sort both stay: they
    actually work on Activity (search filters the log, Sort does Newest/Oldest — see the Sort
    section above), so only the three inert controls are hidden, not the whole row. Recentering
    when only two controls remain keeps the row from reading as "most of a toolbar went
    missing" flush against the right edge.
- **The header row is a fixed `h-16`, matching the sidebar's own brand-row height exactly** (the
  `<aside>`'s own `h-16` div), so their bottom borders meet at the same y-position across the
  full page width. It used to be `py-3` with no explicit height, which happened to render at
  ~60px against the sidebar's fixed 64px — 4px off, close enough to look accidental rather than
  intentional, and reported directly from a screenshot as needing to look neater. If either
  row's content ever needs to grow taller than 64px, both heights need to move together or this
  drifts out of alignment again.

### No mock/sample data

There is deliberately **no sample or demo content anywhere in this app.** A `seedDemoData()`
function and a "Load sample tasks" button (`#btn-load-sample`, shown in the empty-board banner) used
to inject 10 fictional tasks — and with them five invented teammates (Priya Nair, Marcus Lee, Ava
Chen, Diego Ruiz, Sam Osei) and five invented projects. Both are removed.

The problem wasn't the button, it was what it left behind: seeded tasks are indistinguishable from
real ones once created, and the invented names persisted into the assignee autocomplete and the
`@mention` roster (`uniqueValues('assignee')`), so they kept resurfacing as if they were colleagues.
The sibling Content Hub removed its equivalent seeding for exactly this reason — see "One-time
onboarding banner" in its `DESIGN.md`. **Don't re-add mock-content seeding.** If an onboarding aid is
wanted again, prefer something visibly marked as an example over real-looking documents.

The empty-board banner remains, now just saying the board is empty. The assignee field's placeholder
is a neutral instruction rather than a fake person's name, for the same reason.

Note this was a *code* removal — it can't delete tasks that button already created. If sample tasks
were ever loaded on the live board, those documents are still there and have to be deleted from the
board itself.

### State model

No framework/reactive layer — plain module-scoped `var`s (`tasks`, `currentView`,
`editingTaskId`, `activityLog`, `myNotifications`) mutated directly, with renderers called manually
after each mutation. `tasks` is fully replaced on every `onSnapshot` fire and is the single source
of truth for all views (no per-view derived state persisted).

### Firestore data model

Four top-level collections, all flat (see `firestore.rules` for the actual access boundary — the
client-side domain check in `isAllowedEmail` is UX only, not enforcement):

- **`tasks`** — one doc per *active* task, client-generated IDs (`uid()`, not Firestore auto-IDs).
  Fields: name, project, priority, status, start/deadline dates, assignee, Drive link, checklist,
  comments, time entries, plus a vestigial `dependsOn` (array of task ids — no editor,
  round-tripped only; see "Task dependencies were removed" above). Read/create/update are open to
  any `@mediashock.com.sg` account — see "Who can edit what (ownership rules)" below for the one
  exception (`delete` stays scoped to the assignee, an admin, or an archive-move).
  - **Archived tasks live in a separate `archivedTasks` collection, not in `tasks` with a flag.**
    `tasksCol` is loaded via one unfiltered `onSnapshot` on every single session — every tab open,
    reload, or reconnect re-downloads the *entire* collection — and archiving used to just stamp
    `archivedAt` on the same doc rather than actually removing it, so that read cost only ever
    grew, forever, regardless of how much work was still actually active. `archiveTask`/
    `unarchiveTask`/`archiveCompletedTasks`/`archiveProjectTasks` now all move a task between the
    two collections (a `set` on the destination + a `delete` on the source in the same
    `writeBatch`, so it's atomic — never duplicated or lost, even if the batch fails partway).
    `archivedTasksCol` is loaded lazily (`ensureArchivedTasksListener`), only by the two views that
    actually read archived data (Projects, Archived) — Board/Gantt/Calendar/Focus/People never
    attach it, so most sessions never pay for it at all. Export and Import both force it to load
    first (`withArchivedTasksReady`) regardless of which views were opened this session, since
    both need the complete picture (an export missing archived history, or an import's
    "replace everything" delete leaving archived tasks behind, would both be silent data bugs).
    Reported directly ("how many users can PM accommodate to?" → Firestore's free-tier daily read
    quota, driven by `tasks` growing forever since nothing was ever removed from it).
    - **`migrateLegacyArchivedTasks`** is a one-time fix-it-forward migration (same pattern as the
      checklist-id and comment-threading backfills elsewhere in this file) for tasks archived
      before this split shipped — they still carry an `archivedAt` stamp but were never moved out
      of `tasks`. Whoever's session sees one of these in a `tasks` snapshot moves it, the same
      way `archiveTask` now does. No "already migrated" flag needed: once a doc is deleted from
      `tasksCol` it stops appearing in future snapshots, so this is self-limiting and safe to
      delete once nobody sees it fire in practice for a while.
    - Both collections use the exact same document shape and the same client-generated id, so a
      restore (`unarchiveTask`) is just the reverse move — the doc's Firestore id never changes
      across an archive/restore round-trip.
  - Each **checklist item** carries its own `uid()`-generated `id` (backfilled on load for older
    tasks saved before this existed — see the `.map()` over `task.checklist` in `openTaskModal`,
    same "fix it forward" pattern as `upsertUserDirectory` in the sibling Content Hub app), so a
    **time entry** can optionally reference one via `checklistItemId` — `null`/absent means
    "General," not tied to any item. There's no separate picker UI for this: the single
    `task-time-note` field doubles as both "what did you work on" and "which item," linked to a
    `task-time-checklist-suggestions` `<datalist>` of the checklist's item texts (same
    input-with-`<datalist>`-autocomplete pattern as the Assignee field) for discoverability.
    `checklistItemIdForNote(note)` resolves the link by exact case-insensitive text match against
    `currentChecklist` at commit time — so picking the suggestion (or typing an item's name
    verbatim) links it, but "Partial Content on 7 Aug, minus the CTA" doesn't, only the bare item
    text does. `checklistItemMinutes(itemId)` sums an item's linked entries for the small time
    badge on its checklist row; `renderChecklistItemSuggestions()` keeps the datalist's options in
    sync with the checklist and is called from the end of `renderChecklistEditor()` so the two
    never drift apart. Removing a checklist item does *not* touch time entries that referenced its
    id — they keep counting toward the task's totals, they just stop matching any item's badge.
- **`projects`** — one auto-ID doc per project, `{name, deadline}`, holding the project's **own**
  deadline, deliberately separate from the deadlines of the tasks inside it. The project name is a
  **field, not the doc ID**: project names are free text typed into the task modal, and one
  containing `/` is not a legal document ID. Looked up by name client-side (`projectDeadlineFor`)
  — one doc per project is a tiny collection, and this needs no composite index. `deadline` is an
  ISO date string or `null`.
  - **This resolved a real contradiction.** Before it existed, "project deadline" wasn't stored
    anywhere and was derived two incompatible ways at once: `renderProjects` sorted Ongoing by the
    *earliest* active task deadline, while `checkProjectDeadlinePopups` treated the *latest* task
    deadline as the project's due date. Both now read the stored deadline when one is set and fall
    back to their original derivation when it isn't, so undated projects behave exactly as before.
  - **Set in one place only — the Projects tab**, and progressively disclosed. A project with no
    deadline shows a quiet `+ Deadline` button (`.project-deadline-add`); the real
    `<input type="date">` (`.project-deadline-input`) is swapped in on click, or shown outright once a
    deadline exists. `projectDeadlineEditing` holds the one project name currently revealed.
    Abandoning the field without picking anything (`focusout` with an empty value) collapses it back,
    and clearing an existing deadline does too. All three handlers are delegated on `#projects-grid`,
    since `renderProjects` replaces its innerHTML on every snapshot.
    - **It used to be an always-visible date input on every card, and that was wrong.** The argument
      for it was "no hidden state to discover" — but it put an empty `mm/dd/yyyy` box on every
      undated project (9 of them on the real board), which reads as a form you're required to fill
      in, for a value most projects never set. That trade was defensible while the deadline was also
      drawn on the Timeline; once Timeline grouping was reverted the visible cost stayed and the
      payoff shrank, so it became clutter. Reported by the user as simply "why is the deadline there?".
    - Deliberately *not* also editable in the task modal: the same value settable from two places,
      where editing it inside one task silently moves it for every other task in the project, reads
      as a bug even though it isn't.
  - **Not shown on the Gantt.** Grouping the Gantt's rows by project (a project header row with a
    summary bar and a deadline tick) was built, shipped, and reverted the same day -- it didn't work
    in practice on the real board. `renderGantt` is back to a flat, start-date-ordered task list and
    is byte-identical to its pre-change version. The project deadline lives in the Projects tab only.
    Don't re-add Gantt grouping without asking first.
    - **Project identity and deadline pile-ups were later addressed without touching row order or
      grouping** (`projectColor`, `computeGanttDeadlineStacks`) — a comparison against TeamGantt
      found it doesn't group rows by project either (project color there is manual/optional, not
      automatic), which confirmed the flat list here isn't a compromise to fix later.
      - `projectColor(t.project)` **also went through two designs.** The first gave each row a
        plain color bar/swatch next to the existing priority dot -- shipped, then reported back
        as "not immediately intuitive": two unlabeled colored marks sitting side by side with no
        way to tell which one meant what. Rebuilt so the color lives ON the project name itself,
        as a badge/pill (`PROJECT_BADGE_PALETTE`, the exact same soft `bg-*-100 text-*-700 ring-*`
        shape as `PRIORITY_META`/`DONE_META`/`READY_FOR_REVIEW_META`'s `.badge` classes, not a
        bare `bg-*-400` swatch) -- the color is now attached directly to the readable text it
        identifies instead of being a separate mark to memorize. Same name-hash trick as
        `avatarColor`, kept as its own palette so a project and a person never coincidentally
        share a color. Palette hues (orange/teal/indigo/fuchsia/cyan/lime/pink/violet)
        deliberately exclude rose/amber/sky/emerald/purple, since those already mean
        High/Medium/Low/Done/Ready-for-review elsewhere and a project landing on one of those by
        coincidence would read as a false status signal. The priority dot stays exactly where and
        what it always was -- two distinct signals (a colored tag = which project, a plain dot =
        priority/status), not two competing swatches.
      - `computeGanttDeadlineStacks(list)` **went through two designs.** The first flagged any
        two of one assignee's plotted (non-`Done`) tasks whose *date ranges* overlapped at all --
        shipped, then reported back as not actually useful: one person working across several
        projects' overlapping date ranges is completely normal, just a matter of them
        prioritizing what ships first, not a real conflict. What's actually worth a warning is
        two or more of one person's tasks sharing the exact same **deadline** -- everything
        landing due the same day with no slack to sequence it. Rebuilt around that instead (same
        function name's intent, `s/computeGanttConflicts/computeGanttDeadlineStacks/` and every
        call site), grouping by `t.deadline` (already a plain `YYYY-MM-DD` string from the
        `<input type="date">` field, so no timezone-conversion helper needed) within each
        assignee, not by interval overlap. Surfaced identically to how the first version was --
        an amber `!` badge on the bar's top-left corner (top-right is already the overdue dot;
        different corner and shape so the two warnings don't blur into each other), a
        `#gantt-stack-note` count next to the existing `#gantt-hidden-note`, and the specific
        stacked task name(s) named in the bar's tooltip -- only the trigger condition changed.
      - TeamGantt's closest equivalent (a Workloads heat-map showing hours/day per person) lives
        in a separate report, not on the chart itself, and its own users have publicly asked for
        an on-chart version that doesn't exist yet -- this is that, tuned to what this team
        actually finds worth a warning rather than a straight port of TeamGantt's own metric.
- **`people`** — the **team roster**: one doc per teammate, **doc ID = their Firebase uid**,
  `{name, email, photoURL, lastSeen}`, upserted by `registerPresence(user)` on every sign-in
  (`onAuthStateChanged`, deliberately *before* `startListeners` so a first-time signer-in is
  already in their own session's snapshot and can assign themselves a task without reloading).
  - **Profile photos are pulled from the person's Google account (`user.photoURL`), not an
    upload feature.** Requested directly ("insert a profile image"); the choice between
    auto-pulling Google's photo vs. building a real upload flow (Firebase Storage, a new
    `storage.rules` file with its own deploy step, upload/crop UI) was put to the user rather
    than assumed — Google's photo won as the zero-infrastructure option, with real upload noted
    as a possible later layer on top if anyone actually wants to override it. `null`, not `''`,
    for "no photo" — `avatarHtml()`'s truthiness check would otherwise render a broken
    `<img src="">` for every account with none set.
    - **`avatarHtml(name, className, textSizeClass)`** is the one shared renderer for every small
      avatar circle in the app (comments, time entries, mentions, Focus of the Day, Board rows,
      People cards, suggestions, archived rows) — a real `<img>` when `personPhotoUrl(name)` finds
      one, the pre-existing colored-initials `<span>` (`avatarColor`/`initials`) otherwise. Matched
      by **display name** against `teamPeople`, same as every other name-based lookup in this file
      — most call sites only ever have a name string (`t.assignee`, `comment.author`, ...), never
      a uid. `className` carries whatever sizing/spacing the call site needs; the function only
      appends what differs between the photo and initials cases.
    - Google photo URLs get `referrerpolicy="no-referrer"` on the `<img>` — a known quirk where
      Google can 403 the request when it carries this page's own URL as a referrer, unrelated to
      anything specific to this app.
    - **The sidebar's own user-chip avatar reads `user.photoURL` directly, not through
      `avatarHtml()`/`personPhotoUrl()`.** It's set from `onAuthStateChanged`, which can fire
      before this session's own `people` snapshot has arrived with the value `registerPresence`
      (called right after, in the same handler) is about to write — looking it up via the roster
      at that exact moment could race and miss it. `user.photoURL` is the identical value,
      available immediately with no snapshot dependency.
  - **Why it exists.** Before it, the only answer to "who is on this team" was inferred from the
    board itself (`uniqueValues('assignee')`), so a new joiner did not exist to the app until
    someone hand-typed their name onto a task — they could not be picked, and could not be
    `@mentioned`. Worse, typing that name slightly wrong created a second, permanent person who
    could never receive a notification: `notifications.recipient` is a display name matched in
    `firestore.rules` against `request.auth.token.name`, so a near-miss is written successfully
    and then read by nobody. Silent, with no error on either side. This became urgent at ~11
    people; it never bit at 5, where everyone knew everyone's exact display name.
  - **`teamRoster()`** is the accessor — roster names UNION every name already on a task. The
    task half is *not* legacy cruft: tasks created before this collection existed carry names
    with no uid behind them, and dropping them would silently reassign the task the next time
    anyone opened it. `parseMentions`, `enrichCommentText`, the mention autocomplete and the
    assignee picker all read this; `renderPeople` and the assignee *filter* deliberately still
    read `uniqueValues('assignee')`, since those answer "who currently has work," not "who exists."
  - **Rules are narrower than every other collection here**: read by the whole team, but
    `create/update` only where `personId == request.auth.uid`, and `delete: if false`. This is
    the one collection where shared write would be actively harmful — rewriting someone else's
    `name` silently redirects their notifications. A leaver is handled by not signing in, not by
    deleting a row their old tasks still reference by name.
  - The module-level list is `teamPeople`, **not** `people` — `renderPeople()` declares its own
    local `people` meaning something different (who currently has tasks), and the shadowing was
    a trap waiting for the next edit.
- **`activity`** — append-only log (`logActivity`), queried as latest **200** by `at desc`, and
  searchable from the main search box (see below). Was 50, which is several days of history at
  five people and about an afternoon at eleven — quietly turning an audit trail into a "recently"
  list. Raised and made searchable in the same pass: a longer feed is only useful if you can find
  anything in it.
- **`notifications`** — per-recipient; unlike the other two collections this one *does* restrict
  read/update/delete to the addressed recipient (matched against `request.auth.token.name` or
  `.email`, since `recipient` is stored as a display name — see comments in `firestore.rules`).
  Queried with `where("recipient", "==", ...)` only, sorted client-side — deliberately no
  `orderBy` alongside the `where`, to avoid needing a composite index for a query this simple.
- **`suggestions`** — one doc per suggestion, with replies as an embedded array
  (`{text, author, date}` objects, updated via full-array-rewrite on `updateDoc`) rather than a
  subcollection. Shared read/write like `tasks`.
- **`projectTyping`** — ephemeral "who's typing" presence for a project's group chat (see
  "Project group chat" above), one doc per project sharing that project's own `projects/{id}`
  doc id: `{entries: [{name, at}]}`. Whole-team read/write, same as `projects`. Not queried with
  `where`/`orderBy`, so it needs no index entry.

Any *new* top-level collection needs both a `firestore.rules` block and, if it's ever queried with
`where` + `orderBy` together, an entry in `firestore.indexes.json` — and neither deploys with the
site. Pushing to `main` only updates the static GitHub Pages site; rules/indexes require a separate
`firebase deploy` (or pasting the rules into the Firebase Console) as a one-time manual step per
change, or every read/write against the new collection fails with "Missing or insufficient
permissions" even though the code and the deployed page are otherwise correct.

### Personal leave (time off)

Leave is stored **on the person's roster doc** — `people/{uid}.leave`, an array of
`{id, start, end, note}` with both ends inclusive `YYYY-MM-DD` strings — **not on a task, and
emphatically not as a task status.** That was the first instinct and it's wrong: one person going
away affects every task they hold at once, and it says nothing about how any of that work is
progressing, so as a status it would have to be set *and unset* on each of their tasks by hand
while corrupting the field `dueUrgency`, `focusScore`, `isReadyForReview` and the Done count all
read.

**Researched against TeamGantt and Monday before building.** Neither reschedules anything around
leave, which is why this doesn't either:
- **TeamGantt** has company-wide holidays only. For individual time off its own documentation
  recommends *"create a task called Vacation and assign yourself to it"* — the workaround above,
  which is exactly what we avoided. Its Workloads heat map has no concept of a person being away.
- **Monday** does log real per-person PTO (a Schedules page, separate from holiday schemes) and
  subtracts it from capacity — but it feeds the **Workload widget**, not the timeline bars, and
  it's Pro/Enterprise only.

So leave here is a **visibility signal**: it shades the days and names the clash, and a human
decides what to move.

- **`leaveFor` / `isOnLeave` / `leavePeriodOn`** compare raw `YYYY-MM-DD` strings — no `Date`
  parsing and no timezone helper, because the format sorts lexicographically. Same reasoning as
  `computeGanttDeadlineStacks` grouping on the raw `t.deadline` string.
- **The Gantt warns on a DEADLINE landing inside leave, not on date-range overlap** —
  `#gantt-leave-note`, alongside the existing hidden/stack notes. This is the same lesson
  `computeGanttDeadlineStacks` learned by shipping the wrong version first: a task merely
  *spanning* someone's time off is normal, they work either side of it. A deadline landing while
  they're away can't resolve itself.
- **The band is a diagonal hatch (`.gantt-leave`), not a flat tint.** The day columns already use
  flat tints for weekend and for today; a third flat colour reads as a fourth kind of *day*
  rather than as "this one person is away". Emitted before the bar in the same relative container
  so DOM order puts it underneath, with `pointer-events: none` so it can't eat a click meant for
  the bar. Deliberately **no third badge on the bar** — the top-right overdue dot and top-left
  amber stack badge already carry two warnings, and CLAUDE.md's own note on that pair says a
  third would blur them.
- **Entry is in the People tab**, progressively disclosed behind a quiet `+ Time off` button
  (`leaveEditingFor`) — same pattern and same reasoning as the Projects tab's deadline field: an
  always-visible pair of empty date boxes on every person card reads as a form you must fill in,
  for a value most people don't have set at any moment. Handlers are delegated on `#people-grid`
  since `renderPeople` replaces its innerHTML.
  - **`+ Time off` sits top-right of a "Time off" header row, not stacked below "None booked."**
    — the original layout stacked label / status / button in one column, which read as the
    button being an afterthought rather than an action tied to the heading above it (reported
    directly against a screenshot). `personLeaveSectionHtml` now builds a `toggleBtn` (header row,
    right-aligned via `flex justify-between`) separately from the full add-period `editorForm`
    (start/end/note/Add/Cancel), which still renders below the status content once
    `leaveEditingFor === name` — four inputs plus two buttons don't fit next to a label without
    wrapping badly, so only the toggle moved, not the whole editor.
  - **`toggleBtn` is a real bordered pill, not plain colored text** — same shape as the Archived
    view's `Restore` button (`border` + `hover:bg-zinc-50`, not just a hover text-color change).
    It started as quiet colored text matching `.project-deadline-add`'s style (the Projects tab's
    own progressive-disclosure button, which stays that way — this change was scoped to Time off
    only, not applied everywhere that pattern appears) and was reported back as not reading as
    interactive at all. `disabled:opacity-50 disabled:cursor-not-allowed` covers the
    not-signed-in-yet disabled state, matching the same utility pair already used on
    `#task-deadline`.
- **`canEditLeaveFor`** mirrors the `people` rule — yourself, or an admin. `ADMIN_EMAILS` in
  index.html is **UI gating only, not the boundary**; keep it identical to `admins()` in
  `firestore.rules`.
- **The rules needed no change** — `people` already allowed the owner or an admin to write the
  whole doc, and `leave` is just another field on it.
- **Known limits**: (1) someone who has never signed in has no roster doc, so there's nowhere to
  attach their leave — the `+ Time off` button is disabled with a title saying so; (2) the People
  tab only lists people with tasks matching the current filters, so you can't book leave for
  someone with no active work; (3) the roster listener now calls `renderAll()`, so another
  person signing in mid-edit will clear the date inputs you were typing into.
- `logActivity` fires **inside `saveLeave`'s success path**, not at the call site, so a rules
  denial or dropped connection can't log something that never happened. Its own
  `leave_changed` activity type, amber, matching the Away chip and the Gantt note — one colour
  for "someone is not available" everywhere it appears.

### Who can edit what (ownership rules)

**Updating a task is open to the whole team again, regardless of assignee or admin status** —
reverted on request ("allow other users to edit the task regardless of assignee or admin
rights"). The board started this way (`allow read, write: if isMediashock()`), moved to an
ownership-scoped model once the team grew past five (admin → anything, assignee → their own task,
everyone else → comments/status only — kept below for context, since `DELETE` and `archivedTasks`
still work this way), then moved back on this direct request. Reads were never restricted either
way — everyone has always seen the whole board.

| | tasks (`update`) | tasks (`delete`) |
|---|---|---|
| **admin** (`admins()` in `firestore.rules`) | anything | anything |
| **assignee** | anything (same as everyone now) | their own task |
| **anyone else** | anything | only via archiving (see below) |

- **This only widened `update` — `delete` kept the old ownership scoping**, since the request was
  specifically to *edit* tasks, not to let anyone permanently delete anyone else's. A stricter
  boundary on the more destructive operation was kept rather than assumed away by the broader ask.
- **`reviewAudience` (the client/internal review label) lost its own narrower assignee-or-admin
  restriction along with the rest** — it was never a separate rule, just a field the old update
  rule's comments/status carve-out excluded (see "Review audience" elsewhere in this file for
  the UI-side reasoning that no longer fully applies: `writeErrorMessage` on the badge-click path
  will now simply succeed for anyone, and the drag-and-drop path's "swallow the denial silently"
  branch has nothing left to swallow). Worth knowing this UI code still exists and is now
  effectively dead for tasks — not removed, since the same `writeErrorMessage` helper is still
  live for other things (see below).
- **Archiving is allowed for everyone; a bare, unrecoverable delete is not.** Both are a `delete`
  on `tasks/{id}`, so the rule can't tell them apart by operation — it uses
  `existsAfter(/databases/$(database)/documents/archivedTasks/$(taskId))`, which reports state
  *after* the batch commits. Archive writes both halves in one `writeBatch`, a bare delete
  doesn't. This matters beyond neatness: `archiveCompletedTasks` archives the whole team's Done
  tasks in one atomic batch, and Firestore fails the *entire* batch if a single write is denied,
  so an assignee-only archive rule would have broken that button for every non-admin.
- **`isAssignee` matches a display name**, since that's what `tasks.assignee` has always held —
  still relevant for the `delete` rule and for `archivedTasks` (unchanged by this reversal, still
  ownership-scoped both ways: `update` is assignee-or-admin, `delete` mirrors the tasks rule
  above). Someone whose Google display name doesn't match the assignee text still can't delete
  their own task or edit an archived one; admins can always fix a wrong `people` display name.
- **Admins are a hardcoded email list in the rules, not a `role` field** — a role in a document
  is only as safe as the rule guarding that document. Keep `admins()` identical to the sibling
  Content Hub's copy.
- `suggestions` delete is author-or-admin (update stays open — replies are an embedded array,
  so replying *is* an update to someone else's doc). It was open to everyone only because
  `write` covers delete.
- **Client-side, `writeErrorMessage(err, task)`** turns Firestore's bare
  "Missing or insufficient permissions" into a sentence naming the assignee. Still wired into the
  task-save and move-task handlers, but neither should actually trigger it for a task `update`
  any more — that's now open to anyone signed in. Left in place rather than removed: it's a
  cheap safety net if this rule is ever tightened again, and the same helper still means
  something real for archived-task `update`s and other collections (`people`, `suggestions`).

### Auth

Google OAuth restricted via `hd` custom param + client-side `isAllowedEmail` check +
Firestore-rules-level `isMediashock()` check (the real boundary — see rules file comments).
`onAuthStateChanged` drives `startListeners`/`stopListeners` and toggles the whole
auth-gate/app-root visibility.

## Automated UI/UX optimization reviews

A scheduled cloud routine (`https://claude.ai/code/routines/trig_01LFPtkH67p4A3HKqjQMrUb2`, cron
`0 1-21/5 * * *`, ~5 runs/day) reviews this repo unattended and opens a GitHub issue titled
"UI/UX Optimization Report — <date>" when it finds something concrete — categorized 🔴 Critical /
🟡 Refinement / 🔵 Feature Optimization, citing specific function/line. It skips creating a new
issue if one from the last 24h already exists, and opens nothing at all if it found nothing real.

**Push-notification fallback.** Every run through 2026-08-12 found real things but silently
failed to file them: `gh issue create`/the GitHub tool hit `403 Resource not accessible by
integration` on every single attempt, and the findings were just discarded — worth knowing if
this repo's issue tracker looks suspiciously empty despite the routine "working." The prompt now
tries issue creation first and, if it fails for any reason, pushes a mobile notification with the
same categorized report instead (prefixed with the error) so a real finding is never silently
dropped again. **The root cause isn't fixed by this** — it's a GitHub App permissions gap (`issues:write`
missing on the integration for this repo), fixable only from GitHub's UI. See "Scheduled cloud
routines" in the parent `Claude Projects/CLAUDE.md` for the exact fix — it's the same gap on both
this repo and the sibling Content Hub repo's routine, since both go through the same GitHub App
installation.

**This is report-only by design, not the original "propose then wait for a reply" spec it was
adapted from.** A cron-fired cloud session runs once, unattended, and finishes — it cannot pause
mid-run and wait days for a human to reply "1, 3, 4" the way an interactive chat can. So the
automated run's tools are deliberately restricted to `Bash`/`Read`/`Grep`/`Glob` (no `Edit`/
`Write`), and its prompt forbids touching code entirely. **Implementing anything from a report is
always a separate, manually-triggered step**: open the GitHub issue, then ask Claude in a normal
interactive session (e.g. "implement items 1 and 3 from issue #N") — that request, in a real
conversation, is the actual approval gate. Manage/disable the schedule at
`https://claude.ai/code/routines`.
