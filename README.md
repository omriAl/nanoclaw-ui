# NanoClaw Dashboard UI

A lightweight web dashboard for [NanoClaw](https://github.com/qwibitai/nanoclaw) — manage scheduled tasks, monitor container agents, and inspect sessions from your browser.

![localhost only](https://img.shields.io/badge/binds_to-127.0.0.1-green)
![no frameworks](https://img.shields.io/badge/frontend-vanilla_JS-blue)

## Features

**Tasks** — Create, edit, pause/resume, delete, and manually trigger scheduled tasks. View run history with duration, status, and error details.

**Containers** — Monitor active container agents in real time. View queue depth (active/max/waiting) and browse run history with exit status.

**Sessions** — Inspect conversation sessions per group and clear them when needed.

- Dark and light theme (follows system preference)
- Auto-refresh with toggle
- Binds to `127.0.0.1` only — never exposed to the network
- Zero external frontend dependencies

## Installation

This is a [NanoClaw feature skill](https://github.com/qwibitai/nanoclaw). Install it from your NanoClaw project:

```bash
# Add the remote
git remote add nanoclaw-ui https://github.com/omriAl/nanoclaw-ui.git

# Merge
git fetch nanoclaw-ui main
git merge nanoclaw-ui/main

# Build and restart
npm install
npm run build
```

Or use the skill command in Claude Code:

```
/nanoclaw-ui:setup
```

After restart, open **http://127.0.0.1:3737** in your browser.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DASHBOARD_PORT` | `3737` | HTTP server port |
| `DASHBOARD_ENABLED` | `true` | Set to `false` to disable |

Add to your `.env` file and restart NanoClaw.

For guided configuration, use:

```
/nanoclaw-ui:configure
```

## What gets merged

| File | Change |
|------|--------|
| `src/dashboard.ts` | HTTP server with REST API |
| `src/dashboard.html` | Single-page app frontend |
| `src/dashboard.test.ts` | Test suite |
| `src/config.ts` | Dashboard port and enable config |
| `src/index.ts` | Dashboard startup/shutdown wiring |
| `src/db.ts` | Container runs table and queries |
| `src/types.ts` | ContainerRun, ActiveContainer types |
| `src/group-queue.ts` | Active container monitoring |
| `src/task-scheduler.ts` | Manual task execution |
| `src/container-runner.ts` | Output tracking fields |
| `package.json` | Build script update |

## License

MIT
