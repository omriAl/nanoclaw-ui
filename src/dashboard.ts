import fs from 'fs';
import http, { IncomingMessage, ServerResponse } from 'http';
import { fileURLToPath } from 'url';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DASHBOARD_PORT, TIMEZONE } from './config.js';
import { logger } from './logger.js';
import {
  ActiveContainer,
  ContainerRun,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

export interface DashboardDeps {
  getAllTasks: () => ScheduledTask[];
  getTaskById: (id: string) => ScheduledTask | undefined;
  getTaskRunLogs: (taskId: string, limit?: number) => TaskRunLog[];
  createTask: (task: Omit<ScheduledTask, 'last_run' | 'last_result'>) => void;
  updateTask: (
    id: string,
    updates: Partial<
      Pick<
        ScheduledTask,
        | 'prompt'
        | 'script'
        | 'schedule_type'
        | 'schedule_value'
        | 'context_mode'
        | 'next_run'
        | 'status'
      >
    >,
  ) => void;
  deleteTask: (id: string) => void;
  getAllRegisteredGroups: () => Record<string, RegisteredGroup>;
  computeNextRun: (task: ScheduledTask) => string | null;
  onTasksChanged: () => void;
  runTaskNow?: (task: ScheduledTask) => void;
  // Container monitoring
  getActiveContainers?: () => ActiveContainer[];
  getQueueStatus?: () => {
    activeCount: number;
    maxConcurrent: number;
    waitingCount: number;
  };
  stopActiveContainer?: (groupJid: string) => boolean;
  getContainerRuns?: (limit?: number, groupFolder?: string) => ContainerRun[];
  // Session monitoring
  getSessions?: () => Record<string, string>;
  clearSession?: (groupFolder: string) => void;
}

// --- Helpers ---

const MAX_BODY_SIZE = 1024 * 1024; // 1MB

async function parseJsonBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        resolve(body);
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

interface RouteMatch {
  params: Record<string, string>;
}

function matchRoute(
  pattern: string,
  pathname: string,
): RouteMatch | null {
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = pathParts[i];
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return { params };
}

// --- Response helpers ---

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

// --- Validation ---

function validateCreateTask(
  body: Record<string, unknown>,
  groups: Record<string, RegisteredGroup>,
): { error: string } | { task: Omit<ScheduledTask, 'last_run' | 'last_result'> } {
  const { prompt, schedule_type, schedule_value, chat_jid, context_mode, script } = body;

  if (typeof prompt !== 'string' || prompt.trim() === '') {
    return { error: 'prompt is required and must be a non-empty string' };
  }
  if (schedule_type !== 'cron' && schedule_type !== 'interval' && schedule_type !== 'once') {
    return { error: "schedule_type must be 'cron', 'interval', or 'once'" };
  }
  if (typeof schedule_value !== 'string' || schedule_value.trim() === '') {
    return { error: 'schedule_value is required' };
  }
  if (typeof chat_jid !== 'string' || !groups[chat_jid]) {
    return { error: 'chat_jid must reference a registered group' };
  }

  const groupEntry = groups[chat_jid as string];

  // Validate schedule and compute next_run
  let nextRun: string | null = null;
  if (schedule_type === 'cron') {
    try {
      const interval = CronExpressionParser.parse(schedule_value as string, {
        tz: TIMEZONE,
      });
      nextRun = interval.next().toISOString();
    } catch {
      return { error: 'Invalid cron expression' };
    }
  } else if (schedule_type === 'interval') {
    const ms = parseInt(schedule_value as string, 10);
    if (isNaN(ms) || ms <= 0) {
      return { error: 'interval must be a positive integer (milliseconds)' };
    }
    nextRun = new Date(Date.now() + ms).toISOString();
  } else if (schedule_type === 'once') {
    const date = new Date(schedule_value as string);
    if (isNaN(date.getTime())) {
      return { error: 'Invalid date for once schedule' };
    }
    nextRun = date.toISOString();
  }

  const resolvedContextMode =
    context_mode === 'group' || context_mode === 'isolated'
      ? context_mode
      : 'isolated';

  return {
    task: {
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      group_folder: groupEntry.folder,
      chat_jid: chat_jid as string,
      prompt: (prompt as string).trim(),
      script: typeof script === 'string' ? script : null,
      schedule_type: schedule_type as 'cron' | 'interval' | 'once',
      schedule_value: schedule_value as string,
      context_mode: resolvedContextMode,
      next_run: nextRun,
      status: 'active',
      created_at: new Date().toISOString(),
    },
  };
}

// --- Request handler ---

let cachedHtml: string | null = null;

function loadHtml(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  // In TS source dir, always re-read for dev; in dist, cache
  const htmlPath = fs.existsSync(path.join(dir, 'dashboard.html'))
    ? path.join(dir, 'dashboard.html')
    : path.join(dir, '..', 'src', 'dashboard.html');
  if (cachedHtml !== null && !dir.endsWith('/src')) return cachedHtml;
  cachedHtml = fs.readFileSync(htmlPath, 'utf-8');
  return cachedHtml;
}

export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DashboardDeps,
): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method || 'GET';

  try {
    // GET / — serve dashboard HTML
    if (pathname === '/' && method === 'GET') {
      const html = loadHtml();
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Content-Length': Buffer.byteLength(html),
      });
      res.end(html);
      return;
    }

    // GET /api/tasks
    if (pathname === '/api/tasks' && method === 'GET') {
      sendJson(res, 200, deps.getAllTasks());
      return;
    }

    // POST /api/tasks
    if (pathname === '/api/tasks' && method === 'POST') {
      const body = await parseJsonBody(req);
      const groups = deps.getAllRegisteredGroups();
      const result = validateCreateTask(body, groups);
      if ('error' in result) {
        sendError(res, 400, result.error);
        return;
      }
      deps.createTask(result.task);
      deps.onTasksChanged();
      sendJson(res, 201, result.task);
      return;
    }

    // Routes with :id
    if (pathname === '/api/tasks' || pathname.startsWith('/api/tasks/')) {
      // Method not allowed on /api/tasks for non-GET/POST
      if (pathname === '/api/tasks') {
        sendError(res, 405, `Method ${method} not allowed on /api/tasks`);
        return;
      }

      // GET/PUT/DELETE /api/tasks/:id
      const taskMatch = matchRoute('/api/tasks/:id', pathname);
      if (taskMatch) {
        const { id } = taskMatch.params;

        if (method === 'GET') {
          const task = deps.getTaskById(id);
          if (!task) {
            sendError(res, 404, `Task ${id} not found`);
            return;
          }
          sendJson(res, 200, task);
          return;
        }

        if (method === 'PUT') {
          const existing = deps.getTaskById(id);
          if (!existing) {
            sendError(res, 404, `Task ${id} not found`);
            return;
          }
          const body = await parseJsonBody(req);
          const updates: Partial<
            Pick<
              ScheduledTask,
              | 'prompt'
              | 'script'
              | 'schedule_type'
              | 'schedule_value'
              | 'context_mode'
              | 'next_run'
              | 'status'
            >
          > = {};

          if (typeof body.prompt === 'string') updates.prompt = body.prompt;
          if (body.script !== undefined)
            updates.script = typeof body.script === 'string' ? body.script : null;
          if (
            body.schedule_type === 'cron' ||
            body.schedule_type === 'interval' ||
            body.schedule_type === 'once'
          ) {
            updates.schedule_type = body.schedule_type;
          }
          if (typeof body.schedule_value === 'string')
            updates.schedule_value = body.schedule_value;
          if (body.context_mode === 'group' || body.context_mode === 'isolated')
            updates.context_mode = body.context_mode;

          // Recompute next_run if schedule changed
          if (updates.schedule_type || updates.schedule_value) {
            const merged: ScheduledTask = { ...existing, ...updates };
            updates.next_run = deps.computeNextRun(merged);
          }

          deps.updateTask(id, updates);
          deps.onTasksChanged();
          sendJson(res, 200, { ...existing, ...updates });
          return;
        }

        if (method === 'DELETE') {
          const existing = deps.getTaskById(id);
          if (!existing) {
            sendError(res, 404, `Task ${id} not found`);
            return;
          }
          deps.deleteTask(id);
          deps.onTasksChanged();
          sendJson(res, 200, { deleted: true });
          return;
        }

        sendError(res, 405, `Method ${method} not allowed`);
        return;
      }

      // GET /api/tasks/:id/logs
      const logsMatch = matchRoute('/api/tasks/:id/logs', pathname);
      if (logsMatch) {
        if (method !== 'GET') {
          sendError(res, 405, `Method ${method} not allowed`);
          return;
        }
        const { id } = logsMatch.params;
        const task = deps.getTaskById(id);
        if (!task) {
          sendError(res, 404, `Task ${id} not found`);
          return;
        }
        const limitParam = url.searchParams.get('limit');
        const limit = limitParam ? parseInt(limitParam, 10) : undefined;
        sendJson(res, 200, deps.getTaskRunLogs(id, limit));
        return;
      }

      // POST /api/tasks/:id/pause
      const pauseMatch = matchRoute('/api/tasks/:id/pause', pathname);
      if (pauseMatch) {
        if (method !== 'POST') {
          sendError(res, 405, `Method ${method} not allowed`);
          return;
        }
        const { id } = pauseMatch.params;
        const task = deps.getTaskById(id);
        if (!task) {
          sendError(res, 404, `Task ${id} not found`);
          return;
        }
        deps.updateTask(id, { status: 'paused' });
        deps.onTasksChanged();
        sendJson(res, 200, { ...task, status: 'paused' });
        return;
      }

      // POST /api/tasks/:id/resume
      const resumeMatch = matchRoute('/api/tasks/:id/resume', pathname);
      if (resumeMatch) {
        if (method !== 'POST') {
          sendError(res, 405, `Method ${method} not allowed`);
          return;
        }
        const { id } = resumeMatch.params;
        const task = deps.getTaskById(id);
        if (!task) {
          sendError(res, 404, `Task ${id} not found`);
          return;
        }
        deps.updateTask(id, { status: 'active' });
        deps.onTasksChanged();
        sendJson(res, 200, { ...task, status: 'active' });
        return;
      }

      // POST /api/tasks/:id/run
      const runMatch = matchRoute('/api/tasks/:id/run', pathname);
      if (runMatch) {
        if (method !== 'POST') {
          sendError(res, 405, `Method ${method} not allowed`);
          return;
        }
        const { id } = runMatch.params;
        const task = deps.getTaskById(id);
        if (!task) {
          sendError(res, 404, `Task ${id} not found`);
          return;
        }
        if (!deps.runTaskNow) {
          sendError(res, 501, 'Manual task execution not available');
          return;
        }
        deps.runTaskNow(task);
        sendJson(res, 202, { queued: true, taskId: id });
        return;
      }
    }

    // GET /api/groups
    if (pathname === '/api/groups') {
      if (method !== 'GET') {
        sendError(res, 405, `Method ${method} not allowed`);
        return;
      }
      sendJson(res, 200, deps.getAllRegisteredGroups());
      return;
    }

    // --- Container monitoring ---

    // GET /api/containers/active
    if (pathname === '/api/containers/active') {
      if (method !== 'GET') {
        sendError(res, 405, `Method ${method} not allowed`);
        return;
      }
      sendJson(res, 200, deps.getActiveContainers?.() ?? []);
      return;
    }

    // GET /api/containers/status
    if (pathname === '/api/containers/status') {
      if (method !== 'GET') {
        sendError(res, 405, `Method ${method} not allowed`);
        return;
      }
      sendJson(
        res,
        200,
        deps.getQueueStatus?.() ?? {
          activeCount: 0,
          maxConcurrent: 0,
          waitingCount: 0,
        },
      );
      return;
    }

    // GET /api/containers/history
    if (pathname === '/api/containers/history') {
      if (method !== 'GET') {
        sendError(res, 405, `Method ${method} not allowed`);
        return;
      }
      const limitParam = url.searchParams.get('limit');
      const limit = limitParam ? parseInt(limitParam, 10) : undefined;
      const groupFolder = url.searchParams.get('group') ?? undefined;
      sendJson(res, 200, deps.getContainerRuns?.(limit, groupFolder) ?? []);
      return;
    }

    // POST /api/containers/:jid/stop
    if (pathname.startsWith('/api/containers/') && pathname.endsWith('/stop')) {
      const stopMatch = matchRoute('/api/containers/:jid/stop', pathname);
      if (stopMatch) {
        if (method !== 'POST') {
          sendError(res, 405, `Method ${method} not allowed`);
          return;
        }
        if (!deps.stopActiveContainer) {
          sendError(res, 501, 'Container stop not available');
          return;
        }
        const jid = decodeURIComponent(stopMatch.params.jid);
        const stopped = deps.stopActiveContainer(jid);
        if (!stopped) {
          sendError(res, 404, 'No active container for this group');
          return;
        }
        sendJson(res, 200, { stopped: true });
        return;
      }
    }

    // --- Session monitoring ---

    // GET /api/sessions
    if (pathname === '/api/sessions') {
      if (method !== 'GET') {
        sendError(res, 405, `Method ${method} not allowed`);
        return;
      }
      sendJson(res, 200, deps.getSessions?.() ?? {});
      return;
    }

    // DELETE /api/sessions/:groupFolder
    if (pathname.startsWith('/api/sessions/')) {
      const sessionMatch = matchRoute('/api/sessions/:groupFolder', pathname);
      if (sessionMatch) {
        if (method !== 'DELETE') {
          sendError(res, 405, `Method ${method} not allowed`);
          return;
        }
        if (!deps.clearSession) {
          sendError(res, 501, 'Session management not available');
          return;
        }
        const groupFolder = decodeURIComponent(sessionMatch.params.groupFolder);
        deps.clearSession(groupFolder);
        sendJson(res, 200, { cleared: true });
        return;
      }
    }

    // Unknown route
    sendError(res, 404, 'Not found');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Body parse errors are 400s
    if (message === 'Invalid JSON' || message === 'Request body too large') {
      sendError(res, 400, message);
      return;
    }
    logger.error({ err, path: pathname, method }, 'Dashboard request error');
    sendError(res, 500, 'Internal server error');
  }
}

// --- Server lifecycle ---

let server: http.Server | null = null;

export function startDashboard(deps: DashboardDeps): void {
  if (server) return;

  // Pre-cache the HTML at startup
  try {
    loadHtml();
  } catch (err) {
    logger.error({ err }, 'Failed to load dashboard.html');
  }

  server = http.createServer((req, res) => {
    handleRequest(req, res, deps).catch((err) => {
      logger.error({ err }, 'Unhandled dashboard error');
      if (!res.headersSent) {
        sendError(res, 500, 'Internal server error');
      }
    });
  });

  server.listen(DASHBOARD_PORT, '127.0.0.1', () => {
    logger.info(
      { port: DASHBOARD_PORT },
      `Dashboard listening on http://127.0.0.1:${DASHBOARD_PORT}`,
    );
  });
}

export async function stopDashboard(): Promise<void> {
  if (!server) return;
  const s = server;
  server = null;
  return new Promise((resolve, reject) => {
    s.close((err) => {
      if (err) {
        reject(err);
      } else {
        logger.info('Dashboard stopped');
        resolve();
      }
    });
  });
}
