# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

The deployed page polls `version.txt` every 60s and auto-reloads clients once it changes — but
`reloadIfPendingAndSafe()` will never reload out from under a user with a modal open, so a stale
tab can sit on `pendingBuildVersion` for a while. If the two timestamps drift, clients get stuck
thinking a reload is pending even after they're already current.

## Architecture

Everything lives in one `<script type="module">` at the bottom of `index.html`. Rough layout, top
to bottom:

1. **Firebase setup** — `firebaseConfig`/emulator switch, `isAllowedEmail` domain gate.
2. **Notifications** — `parseMentions`/`notifyOnComment`: comments create `notifications` docs for
   the assignee and any `@Name`-mentioned teammates. The notification bell shows read/unread state
   visually (dot + bold vs. muted text). The `suggestions` tab (comment/reply on a
   feature-request board, not tied to a task) follows the same embedded-array reply model as task
   comments — see Firestore data model below.
   - **Desktop popups**: an opt-in toggle in the user menu (`btn-desktop-notif-toggle`,
     `localStorage` key `flowboard_desktop_notif`) fires a native `Notification` from the
     `notifications` `onSnapshot` listener in `startListeners` for anything that arrives *after*
     the listener attaches (`notifStreamStartedAt` guards against popping the whole existing
     backlog on every page load). Tab-open-somewhere only — no service-worker push, no server.
     Requires the browser's Notification permission to be granted; a comment/mention never
     notifies its own author (see `delete recipients[myName]` in `notifyOnComment`), so testing
     needs a second account/tab, not a self-mention.
3. **Drive picker integration** — lazy-loads the Google Picker API (`ensureGapiLoaded`) so users
   can attach a Drive folder to a task/project without guessing folder names.
4. **Pure helpers** — date/time/formatting/sanitization utilities (no DOM or Firestore access).
5. **Modal + UI helpers** — task modal, checklist editor, time-entry editor, "enhanced select"
   dropdown widget, mention autocomplete menu.
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
     lands the target under the sticky column on narrow cards.
   - `renderProjects`: splits into **Ongoing** (sorted by `nextDeadline` ascending) and **Completed**
     (sorted by `lastArchivedAt` descending, collapsible) side-by-side columns, not one flat list —
     each task/project row also has a separate amber "OT" badge (`taskOvertimeMinutes`) next to its
     billable time.
   - Checklist items support drag-to-reorder (native HTML5 DnD) in `renderChecklistEditor`.
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
  time entries. Shared read/write for any `@mediashock.com.sg` account — the whole team edits the
  same board by design, so there's no per-task ownership check.
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
