# Flowboard

A single-file project & task prioritization dashboard built for creative, fast-paced teams. No backend, no build step — everything runs in the browser and your data is saved locally via `localStorage`.

## Preview locally

There's no build process. Just open the file:

1. Clone or download this repo
2. Open `index.html` directly in your browser (double-click it, or drag it into a browser window)

Each team member's data stays on their own machine. Use **Export** to save a JSON backup or hand your board to a colleague, and **Import** to load one back in.

## Features

- **Kanban board** — tasks organized into Pipeline, In Progress, Review, and Done columns, with drag-and-drop to move tasks between statuses
- **Add / edit / delete tasks** — each task has a name, project, priority (High/Medium/Low), status, start date, deadline, assignee, and an optional Google Drive link
- **Focus of the Day** — an auto-sorted strip that surfaces the highest-priority, most time-sensitive tasks so nothing urgent slips through
- **Interactive Gantt timeline** — a day-by-day workload view generated from your active tasks, with weekend shading and a "today" marker, so a manager can spot overlaps and delegate accordingly
- **Resource tracking** — assignee avatars on every card, plus a one-click button to open a task's linked Google Drive asset in a new tab
- **Search & filters** — filter the board by priority, project, or assignee
- **Export / Import** — download your board as a JSON file to back it up or share it with a teammate, and re-import it elsewhere
- **Dark mode** — defaults to dark, with a toggle in the header; your preference is remembered

## Tech stack

- Plain HTML, [Tailwind CSS](https://tailwindcss.com/) (via CDN, `darkMode: 'class'`), and vanilla JavaScript — no framework, no bundler
- [Lucide](https://lucide.dev/) icons via CDN
- Browser `localStorage` for persistence — no server, no database

## Sharing with the team

This repo exists to version and share the dashboard file with the team — it isn't deployed anywhere. To collaborate:

- Clone the repo to get the latest version
- Pull before opening to make sure you have the newest `index.html`
- Since each person's task data lives only in their own browser's `localStorage`, use **Export/Import** (see above) to move a board between machines or teammates
