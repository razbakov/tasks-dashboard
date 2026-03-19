# Tasks Dashboard

Lightweight Bun HTTP server that scans ~/Tasks/ and displays all agent tasks in a live web UI.

## What was built

### Backend (server.ts)
- Bun HTTP server on port 4000
- Scans ~/Tasks/ for task directories
- Reads task.json, STATUS.md (fallback), agent.log (last 5 lines), screenshot.png
- Pings each task's devPort to get live HTTP status
- GET /api/tasks returns JSON array with live status
- GET /screenshots/:task serves screenshot files
- GET / serves the dashboard HTML

### Frontend (index.html)
- Dark theme card grid, auto-refreshes every 5 seconds
- Each card shows: task name, branch, status badge, dev server status, clickable URL, summary, collapsible original task, how-to-test checklist, screenshot thumbnail (click to enlarge), agent log tail, completed timestamp
- SDTV brand red accent (#c92128)
- Plain HTML/CSS/JS, no frameworks

### Task data
- Wrote task.json for 3 existing tasks: sdtv-video-store, sdtv-festival-partners, sdtv-grow-festival

## How to run
```
bun run server.ts
# Open http://localhost:4000
```
