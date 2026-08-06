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
   the assignee and any `@Name`-mentioned teammates.
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
   `renderFocus` ("Focus of the Day"). `setView`/`renderCurrentSecondaryView` switch between them;
   `renderAll` re-runs the relevant renderer(s) after any data change.
8. **Live listeners** — `startListeners`/`stopListeners` wire up three `onSnapshot` subscriptions
   (`tasks`, `activity`, and a per-user `notifications` query), gated by `onAuthStateChanged`.
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

### Auth

Google OAuth restricted via `hd` custom param + client-side `isAllowedEmail` check +
Firestore-rules-level `isMediashock()` check (the real boundary — see rules file comments).
`onAuthStateChanged` drives `startListeners`/`stopListeners` and toggles the whole
auth-gate/app-root visibility.
