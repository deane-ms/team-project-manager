# Flowboard

A shared project & task prioritization kanban board for creative, fast-paced teams. Runs entirely
as a single client-side HTML file (no build step), backed by Firebase (Firestore + Authentication)
so the whole team edits one live board together, with live updates.

**Live:** https://deane-ms.github.io/team-project-manager/

## Access

Sign in with a **@mediashock.com.sg** Google account. Anyone outside that domain is blocked, both
in the UI and independently at the database level via Firestore Security Rules
(`firestore.rules`) — so it's not just a client-side gate.

## What it does

- **Kanban board** — tasks organized into Pipeline, In Progress, Review, and Done columns, with
  drag-and-drop to move tasks between statuses
- **Add / edit / delete tasks** — each task has a name, project, priority (High/Medium/Low),
  status, start date, deadline, assignee, and an optional Google Drive link
- **Focus of the Day** — an auto-sorted strip that surfaces the highest-priority, most
  time-sensitive tasks so nothing urgent slips through
- **Interactive Gantt timeline** — a day-by-day workload view generated from active tasks, with
  weekend shading and a "today" marker, so a manager can spot overlaps and delegate accordingly
- **People view** — tasks grouped by assignee with overdue/high-priority counts, for comparing
  workloads at a glance
- **Resource tracking** — assignee avatars on every card, plus a one-click button to open a task's
  linked Google Drive asset in a new tab
- **Search & filters** — filter the board by priority, project, or assignee
- **Export / Import** — download the board as a JSON file to back it up, and re-import a file to
  replace the shared board for the whole team
- **Dark mode** — defaults to dark, with a toggle in the header; your preference is remembered locally

All of the above is shared and live: an edit one person makes appears for everyone else with the
page open, no refresh needed.

## Architecture

- `index.html` — the whole app: markup, styling, and logic in one file, no build step
- **Firestore** — a single `tasks` collection (one document per task), read via a live
  `onSnapshot` listener. Task documents use client-generated IDs (not Firestore auto-IDs)
- `firebase.json`, `.firebaserc`, `firestore.rules` — standard Firebase CLI project files, for the
  project `pscr-project-manager` (Spark/free plan)

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

## Tech stack

- Plain HTML, [Tailwind CSS](https://tailwindcss.com/) (via CDN, `darkMode: 'class'`), and vanilla
  JavaScript (ES modules) — no framework, no bundler
- Firebase JS SDK (Firestore + Authentication) via `gstatic.com` CDN
