---
name: nanoclaw-ui
description: Add a web-based dashboard UI for monitoring and managing NanoClaw tasks, containers, and sessions. Accessible at http://127.0.0.1:3737 with dark/light theme support. Use when the user wants a dashboard, web UI, task monitor, or container monitor.
triggers:
  - "nanoclaw.?ui.*setup|setup.*dashboard|add.*dashboard|install.*dashboard"
  - "nanoclaw.?ui.*config|config.*dashboard|dashboard.*config|dashboard.*port|dashboard.*settings"
---

# NanoClaw Dashboard UI

A lightweight, self-contained web dashboard for managing NanoClaw from your browser. No external frameworks — pure vanilla HTML/CSS/JS with a Node.js HTTP backend.

## What it does

Three tabs give you full visibility and control:

- **Tasks** — view, create, edit, pause/resume, delete, and manually trigger scheduled tasks. See run history with duration, status, and error details for each execution.
- **Containers** — monitor active container agents in real time, view queue depth (active/max/waiting), browse container run history with duration and exit status.
- **Sessions** — inspect conversation sessions per group and clear them when needed.

### Additional features

- Dark and light theme (follows system preference)
- Auto-refresh toggle with configurable polling
- Toast notifications for actions
- Modal dialogs for task creation/editing
- Status badges with color coding
- Binds to `127.0.0.1` only — never exposed to the network

## Setup (`/nanoclaw-ui:setup`)

### Phase 1: Pre-flight

Check if the dashboard is already installed:

```bash
test -f src/dashboard.ts && echo "Already installed" || echo "Not installed"
```

If already installed, skip to the Configure section below.

### Phase 2: Apply code changes

Ensure the remote exists:

```bash
git remote -v | grep nanoclaw-ui || echo "Remote not found"
```

If the `nanoclaw-ui` remote is missing:

```bash
git remote add nanoclaw-ui https://github.com/omriAl/nanoclaw-ui.git
```

Merge the skill branch:

```bash
git fetch nanoclaw-ui main
git merge nanoclaw-ui/main
```

If merge conflicts occur on `package-lock.json`:

```bash
git checkout --theirs package-lock.json
git add package-lock.json
git merge --continue
```

For other conflicts, read the conflicted files and resolve by understanding the intent of both sides.

### What gets merged

| File | Change |
|------|--------|
| `src/dashboard.ts` | **New** — HTTP server with REST API for tasks, containers, sessions |
| `src/dashboard.html` | **New** — Single-page app (vanilla JS, no dependencies) |
| `src/dashboard.test.ts` | **New** — Comprehensive test suite |
| `src/config.ts` | **Modified** — adds `DASHBOARD_PORT` and `DASHBOARD_ENABLED` config |
| `src/index.ts` | **Modified** — dashboard startup/shutdown, container run tracking |
| `src/db.ts` | **Modified** — `container_runs` table, query functions, `getTaskRunLogs` |
| `src/types.ts` | **Modified** — `ContainerRun`, `ActiveContainer` interfaces |
| `src/group-queue.ts` | **Modified** — active container monitoring and control methods |
| `src/task-scheduler.ts` | **Modified** — manual task execution, container run tracking |
| `src/container-runner.ts` | **Modified** — `timedOut`/`hadOutput` output fields |
| `package.json` | **Modified** — build script copies `dashboard.html` to `dist/` |

### Phase 3: Validate

```bash
npm install
npm run build
npx vitest run src/dashboard.test.ts
```

All tests must pass and build must be clean before proceeding.

### Phase 4: Restart

```bash
npm run build
```

macOS:
```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Linux:
```bash
systemctl --user restart nanoclaw
```

### Phase 5: Confirm

Tell the user:

> The dashboard is now running at **http://127.0.0.1:3737**
>
> Open it in your browser to manage tasks, monitor containers, and view sessions.
> The dashboard binds to localhost only — it is not accessible from the network.

---

## Configure (`/nanoclaw-ui:configure`)

Walk the user through all available dashboard configuration options.

### Dashboard port

Default: **3737**. To change, add to `.env`:

```
DASHBOARD_PORT=<port>
```

Then sync to the container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

### Enable / disable

The dashboard is enabled by default. To disable, add to `.env`:

```
DASHBOARD_ENABLED=false
```

### Container monitoring settings

These existing NanoClaw settings affect the Containers tab:

| Variable | Default | Effect |
|----------|---------|--------|
| `MAX_CONCURRENT_CONTAINERS` | `5` | Maximum parallel containers — shown in queue status bar |
| `CONTAINER_TIMEOUT` | `1800000` (30 min) | Timeout for container runs — affects status reporting |

### Apply changes

After modifying `.env`, rebuild and restart:

```bash
npm run build
```

macOS:
```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Linux:
```bash
systemctl --user restart nanoclaw
```

---

## Removal

To remove the dashboard:

1. Delete dashboard source files:
   ```bash
   rm src/dashboard.ts src/dashboard.html src/dashboard.test.ts
   ```

2. Remove from `src/index.ts`:
   - Delete `import { startDashboard, stopDashboard } from './dashboard.js';`
   - Delete the `if (DASHBOARD_ENABLED) { startDashboard({...}) }` block
   - Delete `await stopDashboard();` from the shutdown handler

3. Optionally remove `DASHBOARD_PORT` and `DASHBOARD_ENABLED` from `src/config.ts` and `.env`

4. Rebuild and restart:
   ```bash
   npm run build
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
   ```

---

## Troubleshooting

### Dashboard not loading

- Check port is available: `lsof -i :3737`
- Verify `DASHBOARD_ENABLED` is not `false` in `.env`
- Check logs: `tail -f logs/nanoclaw.log | grep -i dashboard`

### Container tab shows no data

Container runs are recorded only for runs that happen **after** the dashboard is installed. Historical data accumulates over time.

### Tasks created via dashboard don't run

- Verify the `chat_jid` references a registered group
- Check that the task status is `active` (not `paused`)
- Confirm the cron expression or interval is valid

### Port already in use

Change the port in `.env` and restart:
```
DASHBOARD_PORT=3738
```
