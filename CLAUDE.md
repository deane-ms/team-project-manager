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
   - `renderProjects`: splits into **Ongoing** (sorted by `nextDeadline` ascending) and **Completed**
     (sorted by `lastArchivedAt` descending, collapsible) side-by-side columns, not one flat list —
     each task/project row also has a separate amber "OT" badge (`taskOvertimeMinutes`) next to its
     billable time. A project is "Completed" purely by every one of its tasks having `archivedAt`
     set (`activeCount === 0`), not by task `status` — a project can be all-`Done` and still show
     as Ongoing until someone (or `checkProjectDeadlinePopups`, below) actually archives them.
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
     checklist-item text and comment text (`applyFilters`) — already wired into Board, Gantt, and
     People (all three call `applyFilters(activeTasks())`); Calendar/Projects/Activity/Archived/
     Suggestions don't route through it.
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
     "Recently completed" (really "currently `status === 'Done'`," since tasks have no
     `completedAt` timestamp, only `archivedAt` — a separate, later action). Deliberately in-app
     rather than emailed/Slacked: no connector for either exists yet, and this needed no new
     integration to ship. Called from `renderAll()` so it stays in sync with every task change
     like every other view.
8. **Live listeners** — `startListeners`/`stopListeners` wire up four `onSnapshot` subscriptions
   (`tasks`, `activity`, a per-user `notifications` query, and `suggestions`), gated by
   `onAuthStateChanged`.
9. **Version-poll auto-reload** — see Deploying above.

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
  - **Set in one place only — the Projects tab.** Each project card carries a plain, always-visible
    `<input type="date">` (`.project-deadline-input`, delegated `change` handler on `#projects-grid`
    since `renderProjects` replaces the grid's innerHTML on every snapshot). Deliberately *not* also
    editable in the task modal: the same value settable from two places, where editing it inside one
    task silently moves it for every other task in the project, reads as a bug even though it isn't.
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
