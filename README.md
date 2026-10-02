# Flowboard

A shared project & task prioritization kanban board for creative, fast-paced teams. Runs entirely
as a single client-side HTML file (no build step), backed by Firebase (Firestore + Authentication)
so the whole team edits one live board together, with live updates.

**Live:** https://mediashock-apac.github.io/ms-project-manager/

## Access

Sign in with a **@mediashock.com.sg** Google account. Anyone outside that domain is blocked, both
in the UI and independently at the database level via Firestore Security Rules
(`firestore.rules`) — so it's not just a client-side gate.

## What it does

Ten views, switched from the left rail:

- **Board** — kanban across Pipeline, In Progress, Review and Done, with drag-and-drop between
  statuses. Each task carries a name, project, priority (High/Medium/Low), status, start date,
  deadline, assignee and an optional Google Drive link. Above it, **Focus of the Day** is an
  auto-sorted strip surfacing the highest-priority, most time-sensitive tasks so nothing urgent
  slips
- **Timeline (Gantt)** — a day-by-day workload view generated from active tasks, with weekend
  shading and a "today" marker, for spotting overlaps
- **Calendar** — the same tasks by deadline, month at a time
- **People** — tasks grouped by assignee with overdue/high-priority counts, plus leave tracking
  so "away" shows up everywhere it matters
- **Projects** — work grouped by project/teamspace
- **Chat** — team chat with image sharing (pasted screenshots upload to Cloud Storage)
- **Events → WIP Meeting** — one agenda screen the whole company reads together in the standing
  sync: what has to be decided today, what is coming, and who will not be here for it. Derived
  entirely from existing task/leave data — nothing extra to maintain
- **Activity** — an append-only log of who changed what
- **Suggestions** — product feedback from the team, each with a status (Open/WIP/Fixed/Unable to
  Fix), alongside AI-generated product insights
- **Archived** — completed work moved off the board but not destroyed

Throughout: search and filters (priority, project, assignee), in-app and opt-in desktop
notifications with `@mentions`, a light/dark theme toggle, and JSON export/import of the whole
board.

All of it is shared and live — an edit one person makes appears for everyone else with the page
open, no refresh needed.

## Architecture

- `index.html` — the whole app: markup, styling, and logic in one file, no build step
- **Firestore** — a single `tasks` collection (one document per task), read via a live
  `onSnapshot` listener. Task documents use client-generated IDs (not Firestore auto-IDs)
- **Cloud Storage** — chat image uploads only, under `chat-images/`, read-gated to the team by
  `storage.rules` (not public-read). This is why the Firebase project is on the **Blaze**
  pay-as-you-go plan; Firestore usage alone would still fit inside the free Spark tier
- `firebase.json`, `.firebaserc`, `firestore.rules`, `storage.rules` — standard Firebase CLI
  project files, for the project `pscr-project-manager`
- `version.txt` + `CURRENT_BUILD_VERSION` in `index.html` — a deploy timestamp polled
  client-side, which auto-reloads open tabs when a new version ships (never mid-modal). **Bump
  both to the same value**; `scripts/check-syntax.mjs` fails the push if they drift

## Local development

The Firebase Local Emulator Suite lets you test auth + Firestore fully offline, without touching
the real project:
```
firebase emulators:start --project demo-flowboard
python -m http.server 8765   # serve the file over http:// — Firebase Auth's popup
                              # sign-in flow needs a real http(s) origin, not file://
```
The app auto-detects `localhost`/`127.0.0.1` and points itself at the emulator instead of the real
project in that case — no config changes needed to switch between the two.

There's no build, lint or test tooling, but there is a syntax gate — the app is one big
`type="module"` script, so a single syntax error anywhere takes the whole board down:
```
node scripts/check-syntax.mjs
git config core.hooksPath .githooks   # one-time per clone: runs the check on every push
```

## Tech stack

- Plain HTML, [Tailwind CSS](https://tailwindcss.com/) (via CDN, `darkMode: 'class'`), and vanilla
  JavaScript (ES modules) — no framework, no bundler
- Firebase JS SDK (Firestore + Authentication) via `gstatic.com` CDN

## Deploying

Push to `main` — GitHub Pages serves the repo's root branch directly, so the live site updates
on its own. Note that `firestore.rules`, `firestore.indexes.json` and `storage.rules` are **not**
covered by that push; they need a separate `firebase deploy --only firestore:rules` /
`--only storage`, or a paste into the Firebase console.

## Contributing

`CLAUDE.md` in this repo is the deep architecture reference — the data model, every view's
design reasoning, and the gotchas worth knowing before changing anything. Read it first. The
patterns shared across all Mediashock internal tools (auth, notifications, icons, Firestore
rules conventions) live in the `CLAUDE.md` one folder up.
