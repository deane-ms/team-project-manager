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
- `firebase.json`, `.firebaserc`, `firestore.rules` — Firebase CLI project files for
  `pscr-project-manager` (Spark/free plan).
- `sw.js` — a no-op service worker (exists only to satisfy PWA installability; deliberately does
  no caching, see comment in the file).
- `version.txt` — a timestamp stamped on every deploy; polled client-side to trigger auto-reload.

Live at https://deane-ms.github.io/team-project-manager/ (deployed via GitHub Pages, not Firebase
Hosting — `firebase.json` only configures Firestore + emulators).

## Commands

There is no build/lint/test tooling — it's static HTML/JS served as-is. Local development uses the
Firebase Local Emulator Suite:

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
   - **Chrome's native datalist caret is hidden app-wide.** Any `<input list="...">` whose
     datalist has options gets a solid black ▼ drawn by Chrome *while the field is focused or
     hovered* — a filled UA glyph sitting right beside this app's thin stroked SVG icons, which
     reads as a foreign control. Killed with
     `input[list]::-webkit-calendar-picker-indicator { display: none !important }` in the `<style>`
     block. Scoped to `input[list]` deliberately: `input[type="date"]` uses the *same*
     pseudo-element for its calendar button and must keep it. Affects Project, Assignee, and the
     Time Tracking note field. Suggestions still drop down as you type; you just can't click an
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
   - `filters.search` (the search box, `#filter-search`) matches name/project/assignee plus
     checklist-item text and comment text (`applyFilters`) — wired into **Board, Gantt, Calendar and
     People**, the four views listed in `SEARCHABLE_VIEWS`. Projects/Activity/Archived/Suggestions
     don't route through it. (An earlier version of this note also excluded Calendar; that stopped
     being true once `renderCalendar` started calling `applyFilters` and the note wasn't updated —
     if you change which views filter, change `SEARCHABLE_VIEWS` and this line together.)
     - **The box disables itself on the views it doesn't affect.** `syncSearchAvailability()`, called
       from `setView`, sets `disabled`, swaps the placeholder to "Search doesn't apply here", adds a
       tooltip naming the view, and dims it. Previously the box stayed fully enabled everywhere, so
       typing on Archived changed nothing and read as "there is no such task in the archive" — a
       wrong answer rather than no answer. If you make another view searchable, add it to
       `SEARCHABLE_VIEWS` and it picks this up automatically.
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

Three top-level collections, all flat (see `firestore.rules` for the actual access boundary — the
client-side domain check in `isAllowedEmail` is UX only, not enforcement):

- **`tasks`** — one doc per task, client-generated IDs (`uid()`, not Firestore auto-IDs). Fields:
  name, project, priority, status, start/deadline dates, assignee, Drive link, checklist, comments,
  time entries, plus a vestigial `dependsOn` (array of task ids — no editor, round-tripped only;
  see "Task dependencies were removed" above). Shared read/write for any
  `@mediashock.com.sg` account — the whole team edits the same board by design, so there's no
  per-task ownership check.
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
- **`activity`** — append-only log (`logActivity`), queried as latest 50 by `at desc`.
- **`notifications`** — per-recipient; unlike the other two collections this one *does* restrict
  read/update/delete to the addressed recipient (matched against `request.auth.token.name` or
  `.email`, since `recipient` is stored as a display name — see comments in `firestore.rules`).
  Queried with `where("recipient", "==", ...)` only, sorted client-side — deliberately no
  `orderBy` alongside the `where`, to avoid needing a composite index for a query this simple.
- **`suggestions`** — one doc per suggestion, with replies as an embedded array
  (`{text, author, date}` objects, updated via full-array-rewrite on `updateDoc`) rather than a
  subcollection. Shared read/write like `tasks`.

Any *new* top-level collection needs both a `firestore.rules` block and, if it's ever queried with
`where` + `orderBy` together, an entry in `firestore.indexes.json` — and neither deploys with the
site. Pushing to `main` only updates the static GitHub Pages site; rules/indexes require a separate
`firebase deploy` (or pasting the rules into the Firebase Console) as a one-time manual step per
change, or every read/write against the new collection fails with "Missing or insufficient
permissions" even though the code and the deployed page are otherwise correct.

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
