import http from 'http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  completeContainerRun,
  createTask,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getContainerRuns,
  getTaskById,
  getTaskRunLogs,
  deleteTask,
  deleteSession,
  insertContainerRun,
  logTaskRun,
  setRegisteredGroup,
  setSession,
  updateTask,
} from './db.js';
import { computeNextRun } from './task-scheduler.js';
import { DashboardDeps, handleRequest } from './dashboard.js';
import { ActiveContainer, ScheduledTask } from './types.js';

function makeDeps(overrides?: Partial<DashboardDeps>): DashboardDeps {
  return {
    getAllTasks,
    getTaskById,
    getTaskRunLogs,
    createTask,
    updateTask,
    deleteTask,
    getAllRegisteredGroups,
    computeNextRun,
    onTasksChanged: vi.fn(),
    ...overrides,
  };
}

function makeTask(
  overrides?: Partial<Omit<ScheduledTask, 'last_run' | 'last_result'>>,
): Omit<ScheduledTask, 'last_run' | 'last_result'> {
  return {
    id: `task-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    group_folder: 'test_group',
    chat_jid: 'test@g.us',
    prompt: 'Test prompt',
    schedule_type: 'interval',
    schedule_value: '60000',
    context_mode: 'isolated',
    next_run: new Date(Date.now() + 60000).toISOString(),
    status: 'active',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function registerTestGroup(): void {
  setRegisteredGroup('test@g.us', {
    name: 'Test Group',
    folder: 'test_group',
    trigger: '@test',
    added_at: new Date().toISOString(),
  });
}

async function callApi(
  deps: DashboardDeps,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const req = new http.IncomingMessage(null as any);
    req.method = method;
    req.url = path;
    req.headers = { host: 'localhost:3737' };

    const mock = {
      _status: 200,
      _headers: {} as Record<string, string | number>,
      _body: '',
      headersSent: false,
      writeHead(status: number, headers?: Record<string, string | number>) {
        mock._status = status;
        if (headers) Object.assign(mock._headers, headers);
        mock.headersSent = true;
        return mock;
      },
      end(data?: string) {
        mock._body = data || '';
        let parsed: unknown;
        try {
          parsed = JSON.parse(mock._body);
        } catch {
          parsed = mock._body;
        }
        resolve({ status: mock._status, data: parsed });
      },
    };
    const res = mock as unknown as http.ServerResponse;

    const promise = handleRequest(req, res, deps);

    // If there's a body, emit it as data
    if (body !== undefined) {
      const bodyStr = JSON.stringify(body);
      process.nextTick(() => {
        req.emit('data', Buffer.from(bodyStr));
        req.emit('end');
      });
    } else {
      process.nextTick(() => req.emit('end'));
    }

    promise.catch(() => {
      // handleRequest catches internally
    });
  });
}

describe('dashboard API', () => {
  beforeEach(() => {
    _initTestDatabase();
    registerTestGroup();
  });

  describe('GET /api/tasks', () => {
    it('returns empty list when no tasks exist', async () => {
      const deps = makeDeps();
      const { status, data } = await callApi(deps, 'GET', '/api/tasks');
      expect(status).toBe(200);
      expect(data).toEqual([]);
    });

    it('returns all tasks', async () => {
      const task = makeTask();
      createTask(task);
      const deps = makeDeps();
      const { status, data } = await callApi(deps, 'GET', '/api/tasks');
      expect(status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
      expect((data as any[]).length).toBe(1);
      expect((data as any[])[0].id).toBe(task.id);
    });
  });

  describe('GET /api/tasks/:id', () => {
    it('returns a task by id', async () => {
      const task = makeTask({ id: 'task-get-test' });
      createTask(task);
      const deps = makeDeps();
      const { status, data } = await callApi(
        deps,
        'GET',
        '/api/tasks/task-get-test',
      );
      expect(status).toBe(200);
      expect((data as any).id).toBe('task-get-test');
    });

    it('returns 404 for unknown id', async () => {
      const deps = makeDeps();
      const { status, data } = await callApi(
        deps,
        'GET',
        '/api/tasks/nonexistent',
      );
      expect(status).toBe(404);
      expect((data as any).error).toContain('not found');
    });
  });

  describe('POST /api/tasks', () => {
    it('creates a task with valid data', async () => {
      const deps = makeDeps();
      const { status, data } = await callApi(deps, 'POST', '/api/tasks', {
        prompt: 'Do something',
        schedule_type: 'interval',
        schedule_value: '300000',
        chat_jid: 'test@g.us',
        context_mode: 'isolated',
      });
      expect(status).toBe(201);
      expect((data as any).id).toMatch(/^task-/);
      expect((data as any).prompt).toBe('Do something');
      expect(deps.onTasksChanged).toHaveBeenCalled();

      // Verify in DB
      const tasks = getAllTasks();
      expect(tasks.length).toBe(1);
    });

    it('rejects missing prompt', async () => {
      const deps = makeDeps();
      const { status, data } = await callApi(deps, 'POST', '/api/tasks', {
        schedule_type: 'interval',
        schedule_value: '300000',
        chat_jid: 'test@g.us',
      });
      expect(status).toBe(400);
      expect((data as any).error).toContain('prompt');
    });

    it('rejects invalid cron expression', async () => {
      const deps = makeDeps();
      const { status, data } = await callApi(deps, 'POST', '/api/tasks', {
        prompt: 'Test',
        schedule_type: 'cron',
        schedule_value: 'not a cron',
        chat_jid: 'test@g.us',
      });
      expect(status).toBe(400);
      expect((data as any).error).toContain('cron');
    });

    it('rejects unknown group', async () => {
      const deps = makeDeps();
      const { status, data } = await callApi(deps, 'POST', '/api/tasks', {
        prompt: 'Test',
        schedule_type: 'interval',
        schedule_value: '60000',
        chat_jid: 'unknown@g.us',
      });
      expect(status).toBe(400);
      expect((data as any).error).toContain('registered group');
    });

    it('accepts valid cron expression', async () => {
      const deps = makeDeps();
      const { status, data } = await callApi(deps, 'POST', '/api/tasks', {
        prompt: 'Daily check',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        chat_jid: 'test@g.us',
      });
      expect(status).toBe(201);
      expect((data as any).schedule_type).toBe('cron');
      expect((data as any).next_run).toBeTruthy();
    });
  });

  describe('PUT /api/tasks/:id', () => {
    it('updates task fields', async () => {
      const task = makeTask({ id: 'task-update-test' });
      createTask(task);
      const deps = makeDeps();
      const { status, data } = await callApi(
        deps,
        'PUT',
        '/api/tasks/task-update-test',
        { prompt: 'Updated prompt', context_mode: 'group' },
      );
      expect(status).toBe(200);
      expect((data as any).prompt).toBe('Updated prompt');
      expect((data as any).context_mode).toBe('group');
      expect(deps.onTasksChanged).toHaveBeenCalled();

      // Verify in DB
      const updated = getTaskById('task-update-test');
      expect(updated?.prompt).toBe('Updated prompt');
      expect(updated?.context_mode).toBe('group');
    });

    it('returns 404 for unknown task', async () => {
      const deps = makeDeps();
      const { status } = await callApi(
        deps,
        'PUT',
        '/api/tasks/nonexistent',
        { prompt: 'x' },
      );
      expect(status).toBe(404);
    });
  });

  describe('DELETE /api/tasks/:id', () => {
    it('deletes a task', async () => {
      const task = makeTask({ id: 'task-delete-test' });
      createTask(task);
      const deps = makeDeps();
      const { status } = await callApi(
        deps,
        'DELETE',
        '/api/tasks/task-delete-test',
      );
      expect(status).toBe(200);
      expect(getTaskById('task-delete-test')).toBeUndefined();
      expect(deps.onTasksChanged).toHaveBeenCalled();
    });

    it('returns 404 for unknown task', async () => {
      const deps = makeDeps();
      const { status } = await callApi(
        deps,
        'DELETE',
        '/api/tasks/nonexistent',
      );
      expect(status).toBe(404);
    });
  });

  describe('POST /api/tasks/:id/pause and /resume', () => {
    it('pauses and resumes a task', async () => {
      const task = makeTask({ id: 'task-pause-test' });
      createTask(task);
      const deps = makeDeps();

      // Pause
      const pause = await callApi(
        deps,
        'POST',
        '/api/tasks/task-pause-test/pause',
      );
      expect(pause.status).toBe(200);
      expect((pause.data as any).status).toBe('paused');
      expect(getTaskById('task-pause-test')?.status).toBe('paused');

      // Resume
      const resume = await callApi(
        deps,
        'POST',
        '/api/tasks/task-pause-test/resume',
      );
      expect(resume.status).toBe(200);
      expect((resume.data as any).status).toBe('active');
      expect(getTaskById('task-pause-test')?.status).toBe('active');
    });
  });

  describe('GET /api/tasks/:id/logs', () => {
    it('returns empty array for task with no runs', async () => {
      const task = makeTask({ id: 'task-logs-test' });
      createTask(task);
      const deps = makeDeps();
      const { status, data } = await callApi(
        deps,
        'GET',
        '/api/tasks/task-logs-test/logs',
      );
      expect(status).toBe(200);
      expect(data).toEqual([]);
    });

    it('returns run logs after execution', async () => {
      const task = makeTask({ id: 'task-logs-test2' });
      createTask(task);
      logTaskRun({
        task_id: 'task-logs-test2',
        run_at: new Date().toISOString(),
        duration_ms: 1500,
        status: 'success',
        result: 'Done',
        error: null,
      });
      logTaskRun({
        task_id: 'task-logs-test2',
        run_at: new Date().toISOString(),
        duration_ms: 500,
        status: 'error',
        result: null,
        error: 'Something failed',
      });
      const deps = makeDeps();
      const { status, data } = await callApi(
        deps,
        'GET',
        '/api/tasks/task-logs-test2/logs',
      );
      expect(status).toBe(200);
      expect((data as any[]).length).toBe(2);
      // Most recent first
      expect((data as any[])[0].status).toBe('error');
      expect((data as any[])[1].status).toBe('success');
    });

    it('returns 404 for unknown task', async () => {
      const deps = makeDeps();
      const { status } = await callApi(
        deps,
        'GET',
        '/api/tasks/nonexistent/logs',
      );
      expect(status).toBe(404);
    });
  });

  describe('GET /api/groups', () => {
    it('returns registered groups', async () => {
      const deps = makeDeps();
      const { status, data } = await callApi(deps, 'GET', '/api/groups');
      expect(status).toBe(200);
      expect((data as any)['test@g.us']).toBeDefined();
      expect((data as any)['test@g.us'].name).toBe('Test Group');
    });
  });

  describe('POST /api/tasks/:id/run', () => {
    it('returns 202 when runTaskNow is provided', async () => {
      registerTestGroup();
      const task = makeTask({ id: 'task-run-test' });
      createTask(task);
      const runTaskNow = vi.fn();
      const deps = makeDeps({ runTaskNow });
      const { status, data } = await callApi(deps, 'POST', '/api/tasks/task-run-test/run');
      expect(status).toBe(202);
      expect((data as any).queued).toBe(true);
      expect((data as any).taskId).toBe('task-run-test');
      expect(runTaskNow).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'task-run-test' }),
      );
    });

    it('returns 404 for unknown task', async () => {
      const deps = makeDeps({ runTaskNow: vi.fn() });
      const { status } = await callApi(deps, 'POST', '/api/tasks/nonexistent/run');
      expect(status).toBe(404);
    });

    it('returns 501 when runTaskNow is not provided', async () => {
      registerTestGroup();
      const task = makeTask({ id: 'task-run-no-dep' });
      createTask(task);
      const deps = makeDeps();
      const { status, data } = await callApi(deps, 'POST', '/api/tasks/task-run-no-dep/run');
      expect(status).toBe(501);
      expect((data as any).error).toContain('not available');
    });

    it('works for paused tasks', async () => {
      registerTestGroup();
      const task = makeTask({ id: 'task-run-paused', status: 'paused' });
      createTask(task);
      const runTaskNow = vi.fn();
      const deps = makeDeps({ runTaskNow });
      const { status } = await callApi(deps, 'POST', '/api/tasks/task-run-paused/run');
      expect(status).toBe(202);
      expect(runTaskNow).toHaveBeenCalled();
    });

    it('returns 405 for GET method', async () => {
      registerTestGroup();
      const task = makeTask({ id: 'task-run-method' });
      createTask(task);
      const deps = makeDeps({ runTaskNow: vi.fn() });
      const { status } = await callApi(deps, 'GET', '/api/tasks/task-run-method/run');
      expect(status).toBe(405);
    });
  });

  // ── Container monitoring ────────────────────────────────────────────

  describe('GET /api/containers/active', () => {
    it('returns empty list when no deps provided', async () => {
      const deps = makeDeps();
      const { status, data } = await callApi(deps, 'GET', '/api/containers/active');
      expect(status).toBe(200);
      expect(data).toEqual([]);
    });

    it('returns active containers from deps', async () => {
      const active: ActiveContainer[] = [
        {
          groupJid: 'test@g.us',
          groupFolder: 'test_group',
          containerName: 'nanoclaw-test-123',
          runType: 'message',
          taskId: null,
          startedAt: Date.now() - 5000,
          idleWaiting: false,
        },
      ];
      const deps = makeDeps({ getActiveContainers: () => active });
      const { status, data } = await callApi(deps, 'GET', '/api/containers/active');
      expect(status).toBe(200);
      expect((data as any[]).length).toBe(1);
      expect((data as any[])[0].containerName).toBe('nanoclaw-test-123');
    });
  });

  describe('GET /api/containers/status', () => {
    it('returns queue metrics', async () => {
      const deps = makeDeps({
        getQueueStatus: () => ({ activeCount: 2, maxConcurrent: 5, waitingCount: 1 }),
      });
      const { status, data } = await callApi(deps, 'GET', '/api/containers/status');
      expect(status).toBe(200);
      expect((data as any).activeCount).toBe(2);
      expect((data as any).maxConcurrent).toBe(5);
      expect((data as any).waitingCount).toBe(1);
    });

    it('returns defaults when deps not provided', async () => {
      const deps = makeDeps();
      const { status, data } = await callApi(deps, 'GET', '/api/containers/status');
      expect(status).toBe(200);
      expect((data as any).activeCount).toBe(0);
    });
  });

  describe('POST /api/containers/:jid/stop', () => {
    it('stops an active container', async () => {
      const stopFn = vi.fn().mockReturnValue(true);
      const deps = makeDeps({ stopActiveContainer: stopFn });
      const { status, data } = await callApi(
        deps,
        'POST',
        '/api/containers/test%40g.us/stop',
      );
      expect(status).toBe(200);
      expect((data as any).stopped).toBe(true);
      expect(stopFn).toHaveBeenCalledWith('test@g.us');
    });

    it('returns 404 when no active container', async () => {
      const deps = makeDeps({ stopActiveContainer: () => false });
      const { status } = await callApi(
        deps,
        'POST',
        '/api/containers/unknown%40g.us/stop',
      );
      expect(status).toBe(404);
    });

    it('returns 501 when deps not provided', async () => {
      const deps = makeDeps();
      const { status } = await callApi(
        deps,
        'POST',
        '/api/containers/test%40g.us/stop',
      );
      expect(status).toBe(501);
    });
  });

  describe('GET /api/containers/history', () => {
    it('returns empty list when no runs', async () => {
      const deps = makeDeps({
        getContainerRuns: (limit, group) => getContainerRuns(limit, group),
      });
      const { status, data } = await callApi(deps, 'GET', '/api/containers/history');
      expect(status).toBe(200);
      expect(data).toEqual([]);
    });

    it('returns container run history', async () => {
      const runId = insertContainerRun({
        group_folder: 'test_group',
        group_name: 'Test Group',
        container_name: 'nanoclaw-test-123',
        run_type: 'message',
      });
      completeContainerRun(runId, {
        duration_ms: 5000,
        exit_code: 0,
        status: 'success',
        result: 'Done',
      });

      const deps = makeDeps({
        getContainerRuns: (limit, group) => getContainerRuns(limit, group),
      });
      const { status, data } = await callApi(deps, 'GET', '/api/containers/history');
      expect(status).toBe(200);
      expect((data as any[]).length).toBe(1);
      expect((data as any[])[0].container_name).toBe('nanoclaw-test-123');
      expect((data as any[])[0].status).toBe('success');
    });

    it('respects limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        const id = insertContainerRun({
          group_folder: 'test_group',
          group_name: 'Test Group',
          container_name: `nanoclaw-test-${i}`,
          run_type: 'message',
        });
        completeContainerRun(id, {
          duration_ms: 1000,
          exit_code: 0,
          status: 'success',
        });
      }

      const deps = makeDeps({
        getContainerRuns: (limit, group) => getContainerRuns(limit, group),
      });
      const { status, data } = await callApi(deps, 'GET', '/api/containers/history?limit=3');
      expect(status).toBe(200);
      expect((data as any[]).length).toBe(3);
    });

    it('filters by group', async () => {
      setRegisteredGroup('other@g.us', {
        name: 'Other',
        folder: 'other_group',
        trigger: '@other',
        added_at: new Date().toISOString(),
      });

      const id1 = insertContainerRun({
        group_folder: 'test_group',
        group_name: 'Test',
        container_name: 'nanoclaw-test-1',
        run_type: 'message',
      });
      completeContainerRun(id1, { duration_ms: 1000, exit_code: 0, status: 'success' });

      const id2 = insertContainerRun({
        group_folder: 'other_group',
        group_name: 'Other',
        container_name: 'nanoclaw-other-1',
        run_type: 'task',
      });
      completeContainerRun(id2, { duration_ms: 2000, exit_code: 0, status: 'success' });

      const deps = makeDeps({
        getContainerRuns: (limit, group) => getContainerRuns(limit, group),
      });
      const { status, data } = await callApi(
        deps,
        'GET',
        '/api/containers/history?group=other_group',
      );
      expect(status).toBe(200);
      expect((data as any[]).length).toBe(1);
      expect((data as any[])[0].group_folder).toBe('other_group');
    });
  });

  // ── Session monitoring ──────────────────────────────────────────────

  describe('GET /api/sessions', () => {
    it('returns empty object when no sessions', async () => {
      const deps = makeDeps({ getSessions: () => getAllSessions() });
      const { status, data } = await callApi(deps, 'GET', '/api/sessions');
      expect(status).toBe(200);
      expect(data).toEqual({});
    });

    it('returns sessions', async () => {
      setSession('test_group', 'session-abc-123');
      const deps = makeDeps({ getSessions: () => getAllSessions() });
      const { status, data } = await callApi(deps, 'GET', '/api/sessions');
      expect(status).toBe(200);
      expect((data as any).test_group).toBe('session-abc-123');
    });
  });

  describe('DELETE /api/sessions/:groupFolder', () => {
    it('clears a session', async () => {
      setSession('test_group', 'session-abc-123');
      const deps = makeDeps({
        clearSession: (gf) => deleteSession(gf),
      });
      const { status, data } = await callApi(
        deps,
        'DELETE',
        '/api/sessions/test_group',
      );
      expect(status).toBe(200);
      expect((data as any).cleared).toBe(true);

      // Verify session is gone
      const sessions = getAllSessions();
      expect(sessions.test_group).toBeUndefined();
    });

    it('is idempotent', async () => {
      const deps = makeDeps({
        clearSession: (gf) => deleteSession(gf),
      });
      const { status } = await callApi(
        deps,
        'DELETE',
        '/api/sessions/nonexistent',
      );
      expect(status).toBe(200);
    });

    it('returns 501 when deps not provided', async () => {
      const deps = makeDeps();
      const { status } = await callApi(
        deps,
        'DELETE',
        '/api/sessions/test_group',
      );
      expect(status).toBe(501);
    });
  });

  // ── Memory visualization ─────────────────────────────────────────────

  describe('GET /api/memory', () => {
    it('returns empty array when deps not provided', async () => {
      const deps = makeDeps();
      const { status, data } = await callApi(deps, 'GET', '/api/memory');
      expect(status).toBe(200);
      expect(data).toEqual([]);
    });

    it('returns summary from deps', async () => {
      const summary = [
        {
          groupFolder: 'test_group',
          groupName: 'Test Group',
          hasGlobal: true,
          hasGroup: true,
          autoMemoryCount: 2,
          additionalMountCount: 0,
        },
      ];
      const deps = makeDeps({ getMemorySummary: async () => summary });
      const { status, data } = await callApi(deps, 'GET', '/api/memory');
      expect(status).toBe(200);
      expect((data as any[]).length).toBe(1);
      expect((data as any[])[0].groupFolder).toBe('test_group');
    });
  });

  describe('GET /api/memory/:groupFolder', () => {
    it('returns 501 when deps not provided', async () => {
      const deps = makeDeps();
      const { status } = await callApi(
        deps,
        'GET',
        '/api/memory/test_group',
      );
      expect(status).toBe(501);
    });

    it('returns 404 for unknown group', async () => {
      const deps = makeDeps({
        getMemoryLayers: async () => null,
      });
      const { status } = await callApi(
        deps,
        'GET',
        '/api/memory/nonexistent',
      );
      expect(status).toBe(404);
    });

    it('returns memory layers for valid group', async () => {
      const layers = {
        groupFolder: 'test_group',
        groupName: 'Test Group',
        global: '# Global instructions',
        group: '# Group instructions',
        autoMemory: [
          {
            filename: 'MEMORY.md',
            content: '# Memory index',
          },
        ],
        additionalMounts: [],
      };
      const deps = makeDeps({
        getMemoryLayers: async (gf) =>
          gf === 'test_group' ? layers : null,
      });
      const { status, data } = await callApi(
        deps,
        'GET',
        '/api/memory/test_group',
      );
      expect(status).toBe(200);
      expect((data as any).global).toBe('# Global instructions');
      expect((data as any).autoMemory.length).toBe(1);
    });

    it('returns 405 for non-GET methods', async () => {
      const deps = makeDeps({
        getMemoryLayers: async () => null,
      });
      const { status } = await callApi(
        deps,
        'POST',
        '/api/memory/test_group',
      );
      expect(status).toBe(405);
    });
  });

  // ── Service control ─────────────────────────────────────────────────

  describe('GET /api/service/status', () => {
    it('returns unknown when deps not provided', async () => {
      const deps = makeDeps();
      const { status, data } = await callApi(
        deps,
        'GET',
        '/api/service/status',
      );
      expect(status).toBe(200);
      expect((data as any).status).toBe('unknown');
      expect((data as any).platform).toBe('unknown');
    });

    it('returns status from deps', async () => {
      const deps = makeDeps({
        getServiceStatus: async () => ({
          status: 'running' as const,
          platform: 'darwin' as const,
          uptime: 12345,
        }),
      });
      const { status, data } = await callApi(
        deps,
        'GET',
        '/api/service/status',
      );
      expect(status).toBe(200);
      expect((data as any).status).toBe('running');
      expect((data as any).platform).toBe('darwin');
    });
  });

  describe('POST /api/service/restart', () => {
    it('returns restarting when deps provided', async () => {
      const deps = makeDeps({
        restartService: async () => {},
      });
      const { status, data } = await callApi(
        deps,
        'POST',
        '/api/service/restart',
      );
      expect(status).toBe(200);
      expect((data as any).restarting).toBe(true);
    });

    it('returns 501 when deps not provided', async () => {
      const deps = makeDeps();
      const { status } = await callApi(
        deps,
        'POST',
        '/api/service/restart',
      );
      expect(status).toBe(501);
    });
  });

  describe('POST /api/service/stop', () => {
    it('returns stopping when deps provided', async () => {
      const deps = makeDeps({
        stopService: async () => {},
      });
      const { status, data } = await callApi(
        deps,
        'POST',
        '/api/service/stop',
      );
      expect(status).toBe(200);
      expect((data as any).stopping).toBe(true);
    });

    it('returns 501 when deps not provided', async () => {
      const deps = makeDeps();
      const { status } = await callApi(
        deps,
        'POST',
        '/api/service/stop',
      );
      expect(status).toBe(501);
    });
  });

  describe('error handling', () => {
    it('returns 404 for unknown routes', async () => {
      const deps = makeDeps();
      const { status } = await callApi(deps, 'GET', '/api/unknown');
      expect(status).toBe(404);
    });

    it('returns 405 for wrong method on /api/tasks', async () => {
      const deps = makeDeps();
      const { status } = await callApi(deps, 'DELETE', '/api/tasks');
      expect(status).toBe(405);
    });
  });
});
