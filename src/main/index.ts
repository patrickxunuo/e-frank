import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  IPC_CHANNELS,
  type ClaudeRunRequest,
  type ClaudeRunResponse,
  type ClaudeCancelRequest,
  type ClaudeWriteRequest,
  type ClaudeStatusResponse,
  type ClaudeOutputEvent,
  type ClaudeExitEvent,
  type IpcResult,
  type ProjectInstanceDto,
  type ProjectsCreateRequest,
  type ProjectsUpdateRequest,
  type SecretsSetRequest,
  type SecretsGetResponse,
  type SecretsListResponse,
  type JiraListResponse,
  type JiraRefreshResponse,
  type JiraTestConnectionRequest,
  type JiraTestConnectionResponse,
  type JiraTicketsChangedEvent,
  type JiraErrorEvent,
  type RunsStartRequest,
  type RunsStartResponse,
  type RunsModifyRequest,
  type RunsCurrentResponse,
  type RunsListHistoryRequest,
  type RunsListHistoryResponse,
  type RunsCurrentChangedEvent,
} from '../shared/ipc.js';
import type { Run, RunStateEvent, RunMode } from '../shared/schema/run.js';
import { handlePing } from './ping-handler.js';
import {
  ClaudeProcessManager,
  type OutputEvent,
  type ExitEvent,
} from './modules/claude-process-manager.js';
import { NodeSpawner } from './modules/spawner.js';
import { ProjectStore } from './modules/project-store.js';
import { SafeStorageBackend, SecretsManager } from './modules/secrets-manager.js';
import { RunHistory } from './modules/run-history.js';
import {
  JiraPoller,
  type PollerErrorEvent,
  type TicketsChangedEvent,
} from './modules/jira-poller.js';
import { RunStore } from './modules/run-store.js';
import { StubGitManager } from './modules/git-manager.js';
import { StubPrCreator } from './modules/pr-creator.js';
import { StubJiraUpdater } from './modules/jira-updater.js';
import { WorkflowRunner } from './modules/workflow-runner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let mainWindow: BrowserWindow | null = null;

const claudeManager = new ClaudeProcessManager({ spawner: new NodeSpawner() });

// These are constructed at app-ready time (before window creation) because
// `SafeStorageBackend` requires `app.whenReady()` and `app.getPath('userData')`
// is also only safe to call after ready.
let secretsManager: SecretsManager | null = null;
let projectStore: ProjectStore | null = null;
let runHistory: RunHistory | null = null;
let jiraPoller: JiraPoller | null = null;
let runStore: RunStore | null = null;
let workflowRunner: WorkflowRunner | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0e0f13',
    title: 'e-frank',
    webPreferences: {
      // The preload is emitted as CommonJS (`out/preload/index.cjs`) — see
      // electron.vite.config.ts. With `sandbox: true`, Electron requires
      // CJS preloads; ESM preloads silently fail to load. The path must
      // match the built artifact exactly.
      preload: join(__dirname, '../preload/index.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // electron-vite injects ELECTRON_RENDERER_URL during dev so HMR works.
  const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

/**
 * Send `payload` on `channel` to every live renderer window. Used to fan out
 * Claude manager events (`output`, `exit`) so any open window stays in sync.
 */
function broadcastToWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

/**
 * Map the manager's `ExitEvent` (with NodeJS.Signals) to the IPC-friendly
 * `ClaudeExitEvent` shape (signal serialized to string).
 */
function toIpcExitEvent(e: ExitEvent): ClaudeExitEvent {
  return {
    runId: e.runId,
    exitCode: e.exitCode,
    signal: e.signal,
    durationMs: e.durationMs,
    reason: e.reason,
  };
}

function toIpcOutputEvent(e: OutputEvent): ClaudeOutputEvent {
  return {
    runId: e.runId,
    stream: e.stream,
    line: e.line,
    timestamp: e.timestamp,
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * IPC-boundary input validation. The manager itself also validates, but we
 * defend at the boundary so malformed renderer payloads can never reach
 * domain code (rule: never trust the renderer).
 */
function validateRunRequest(raw: unknown): IpcResult<ClaudeRunRequest> {
  if (!isPlainObject(raw)) {
    return { ok: false, error: { code: 'INVALID_REQUEST', message: 'request must be an object' } };
  }
  const { ticketKey, cwd, timeoutMs } = raw;
  if (typeof ticketKey !== 'string') {
    return { ok: false, error: { code: 'INVALID_REQUEST', message: 'ticketKey must be a string' } };
  }
  if (typeof cwd !== 'string') {
    return { ok: false, error: { code: 'INVALID_REQUEST', message: 'cwd must be a string' } };
  }
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs))) {
    return {
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'timeoutMs must be a finite number' },
    };
  }
  const req: ClaudeRunRequest = { ticketKey, cwd };
  if (typeof timeoutMs === 'number') {
    req.timeoutMs = timeoutMs;
  }
  return { ok: true, data: req };
}

function validateCancelRequest(raw: unknown): IpcResult<ClaudeCancelRequest> {
  if (!isPlainObject(raw) || typeof raw['runId'] !== 'string') {
    return { ok: false, error: { code: 'INVALID_REQUEST', message: 'runId must be a string' } };
  }
  return { ok: true, data: { runId: raw['runId'] } };
}

function validateWriteRequest(raw: unknown): IpcResult<ClaudeWriteRequest> {
  if (!isPlainObject(raw)) {
    return { ok: false, error: { code: 'INVALID_REQUEST', message: 'request must be an object' } };
  }
  const { runId, text } = raw;
  if (typeof runId !== 'string') {
    return { ok: false, error: { code: 'INVALID_REQUEST', message: 'runId must be a string' } };
  }
  if (typeof text !== 'string') {
    return { ok: false, error: { code: 'INVALID_REQUEST', message: 'text must be a string' } };
  }
  return { ok: true, data: { runId, text } };
}

// -- Project / secrets request validators -----------------------------------

function validateIdRequest(raw: unknown): IpcResult<{ id: string }> {
  if (!isPlainObject(raw) || typeof raw['id'] !== 'string') {
    return { ok: false, error: { code: 'INVALID_REQUEST', message: 'id must be a string' } };
  }
  return { ok: true, data: { id: raw['id'] } };
}

function validateRefRequest(raw: unknown): IpcResult<{ ref: string }> {
  if (!isPlainObject(raw) || typeof raw['ref'] !== 'string') {
    return { ok: false, error: { code: 'INVALID_REQUEST', message: 'ref must be a string' } };
  }
  return { ok: true, data: { ref: raw['ref'] } };
}

function validateProjectsCreateRequest(raw: unknown): IpcResult<ProjectsCreateRequest> {
  if (!isPlainObject(raw) || raw['input'] === undefined) {
    return {
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'request.input must be present' },
    };
  }
  return { ok: true, data: { input: raw['input'] as ProjectsCreateRequest['input'] } };
}

function validateProjectsUpdateRequest(raw: unknown): IpcResult<ProjectsUpdateRequest> {
  if (
    !isPlainObject(raw) ||
    typeof raw['id'] !== 'string' ||
    raw['input'] === undefined
  ) {
    return {
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'request requires id and input' },
    };
  }
  return {
    ok: true,
    data: { id: raw['id'], input: raw['input'] as ProjectsUpdateRequest['input'] },
  };
}

function validateSecretsSetRequest(raw: unknown): IpcResult<SecretsSetRequest> {
  if (
    !isPlainObject(raw) ||
    typeof raw['ref'] !== 'string' ||
    typeof raw['plaintext'] !== 'string'
  ) {
    return {
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'ref and plaintext must be strings' },
    };
  }
  return { ok: true, data: { ref: raw['ref'], plaintext: raw['plaintext'] } };
}

function validateJiraProjectIdRequest(raw: unknown): IpcResult<{ projectId: string }> {
  if (!isPlainObject(raw) || typeof raw['projectId'] !== 'string') {
    return {
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'projectId must be a string' },
    };
  }
  return { ok: true, data: { projectId: raw['projectId'] } };
}

function validateRunsStartRequest(raw: unknown): IpcResult<RunsStartRequest> {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'request must be an object' },
    };
  }
  const { projectId, ticketKey, modeOverride } = raw;
  if (typeof projectId !== 'string') {
    return {
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'projectId must be a string' },
    };
  }
  if (typeof ticketKey !== 'string') {
    return {
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'ticketKey must be a string' },
    };
  }
  if (
    modeOverride !== undefined &&
    modeOverride !== 'interactive' &&
    modeOverride !== 'yolo'
  ) {
    return {
      ok: false,
      error: {
        code: 'INVALID_REQUEST',
        message: 'modeOverride must be "interactive" or "yolo" if present',
      },
    };
  }
  const req: RunsStartRequest = { projectId, ticketKey };
  if (modeOverride !== undefined) {
    req.modeOverride = modeOverride as RunMode;
  }
  return { ok: true, data: req };
}

function validateRunsRunIdRequest(raw: unknown): IpcResult<{ runId: string }> {
  if (!isPlainObject(raw) || typeof raw['runId'] !== 'string') {
    return {
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'runId must be a string' },
    };
  }
  return { ok: true, data: { runId: raw['runId'] } };
}

function validateRunsModifyRequest(raw: unknown): IpcResult<RunsModifyRequest> {
  if (
    !isPlainObject(raw) ||
    typeof raw['runId'] !== 'string' ||
    typeof raw['text'] !== 'string'
  ) {
    return {
      ok: false,
      error: {
        code: 'INVALID_REQUEST',
        message: 'runId and text must be strings',
      },
    };
  }
  return { ok: true, data: { runId: raw['runId'], text: raw['text'] } };
}

function validateRunsListHistoryRequest(
  raw: unknown,
): IpcResult<RunsListHistoryRequest> {
  if (!isPlainObject(raw) || typeof raw['projectId'] !== 'string') {
    return {
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'projectId must be a string' },
    };
  }
  const limit = raw['limit'];
  if (
    limit !== undefined &&
    (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0)
  ) {
    return {
      ok: false,
      error: {
        code: 'INVALID_REQUEST',
        message: 'limit must be a non-negative finite number if present',
      },
    };
  }
  const req: RunsListHistoryRequest = { projectId: raw['projectId'] };
  if (typeof limit === 'number') {
    req.limit = limit;
  }
  return { ok: true, data: req };
}

function validateJiraTestConnectionRequest(raw: unknown): IpcResult<JiraTestConnectionRequest> {
  if (
    !isPlainObject(raw) ||
    typeof raw['host'] !== 'string' ||
    typeof raw['email'] !== 'string' ||
    typeof raw['apiToken'] !== 'string'
  ) {
    return {
      ok: false,
      error: {
        code: 'INVALID_REQUEST',
        message: 'host, email, and apiToken must be strings',
      },
    };
  }
  return {
    ok: true,
    data: { host: raw['host'], email: raw['email'], apiToken: raw['apiToken'] },
  };
}

/** Generic "manager not initialized" failure — surfaces a clear error to the renderer. */
function notInitialized<T>(name: string): IpcResult<T> {
  return {
    ok: false,
    error: { code: 'NOT_INITIALIZED', message: `${name} failed to initialize at startup` },
  };
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.PING, (_event, req) => {
    return handlePing(req);
  });

  // -- Claude Process Manager ------------------------------------------------

  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_RUN,
    async (_event, raw): Promise<IpcResult<ClaudeRunResponse>> => {
      const validated = validateRunRequest(raw);
      if (!validated.ok) {
        return validated;
      }
      const result = claudeManager.run(validated.data);
      return result;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_CANCEL,
    async (_event, raw): Promise<IpcResult<{ runId: string }>> => {
      const validated = validateCancelRequest(raw);
      if (!validated.ok) {
        return validated;
      }
      return claudeManager.cancel(validated.data.runId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_WRITE,
    async (_event, raw): Promise<IpcResult<{ bytesWritten: number }>> => {
      const validated = validateWriteRequest(raw);
      if (!validated.ok) {
        return validated;
      }
      return claudeManager.write(validated.data);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_STATUS,
    async (): Promise<IpcResult<ClaudeStatusResponse>> => {
      return { ok: true, data: { active: claudeManager.status() } };
    },
  );

  // Forward manager events to all renderer windows.
  claudeManager.on('output', (e: OutputEvent) => {
    broadcastToWindows(IPC_CHANNELS.CLAUDE_OUTPUT, toIpcOutputEvent(e));
  });
  claudeManager.on('exit', (e: ExitEvent) => {
    broadcastToWindows(IPC_CHANNELS.CLAUDE_EXIT, toIpcExitEvent(e));
  });

  // -- Project store ---------------------------------------------------------

  ipcMain.handle(
    IPC_CHANNELS.PROJECTS_LIST,
    async (): Promise<IpcResult<ProjectInstanceDto[]>> => {
      if (projectStore === null) {
        return notInitialized('ProjectStore');
      }
      return projectStore.list();
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PROJECTS_GET,
    async (_event, raw): Promise<IpcResult<ProjectInstanceDto>> => {
      const validated = validateIdRequest(raw);
      if (!validated.ok) {
        return validated;
      }
      if (projectStore === null) {
        return notInitialized('ProjectStore');
      }
      return projectStore.get(validated.data.id);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PROJECTS_CREATE,
    async (_event, raw): Promise<IpcResult<ProjectInstanceDto>> => {
      const validated = validateProjectsCreateRequest(raw);
      if (!validated.ok) {
        return validated;
      }
      if (projectStore === null) {
        return notInitialized('ProjectStore');
      }
      return projectStore.create(validated.data.input);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PROJECTS_UPDATE,
    async (_event, raw): Promise<IpcResult<ProjectInstanceDto>> => {
      const validated = validateProjectsUpdateRequest(raw);
      if (!validated.ok) {
        return validated;
      }
      if (projectStore === null) {
        return notInitialized('ProjectStore');
      }
      return projectStore.update(validated.data.id, validated.data.input);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PROJECTS_DELETE,
    async (_event, raw): Promise<IpcResult<{ id: string }>> => {
      const validated = validateIdRequest(raw);
      if (!validated.ok) {
        return validated;
      }
      if (projectStore === null) {
        return notInitialized('ProjectStore');
      }
      // Cascade ordering matters:
      // 1) Cancel any active workflow run for this project FIRST. Otherwise
      //    the runner keeps mutating run-history for a project that's about
      //    to be wiped, leaving inconsistent state.
      // 2) Stop the Jira poller so in-flight ticks can't emit
      //    `tickets-changed` for an already-deleted project.
      // 3) Delete from the store.
      // 4) Clean up run-history.
      if (workflowRunner !== null) {
        const active = workflowRunner.current();
        if (active !== null && active.projectId === validated.data.id) {
          await workflowRunner.cancel(active.id);
        }
      }
      if (jiraPoller !== null) {
        jiraPoller.stop(validated.data.id);
      }
      const result = await projectStore.delete(validated.data.id);
      if (result.ok && runHistory !== null) {
        const cleared = await runHistory.removeProject(validated.data.id);
        if (!cleared.ok) {
          console.warn(
            `[main] run-history cascade for "${validated.data.id}" failed: ${cleared.error.code} - ${cleared.error.message}`,
          );
        }
      }
      return result;
    },
  );

  // -- Secrets manager -------------------------------------------------------

  ipcMain.handle(
    IPC_CHANNELS.SECRETS_SET,
    async (_event, raw): Promise<IpcResult<{ ref: string }>> => {
      const validated = validateSecretsSetRequest(raw);
      if (!validated.ok) {
        return validated;
      }
      if (secretsManager === null) {
        return notInitialized('SecretsManager');
      }
      return secretsManager.set(validated.data.ref, validated.data.plaintext);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SECRETS_GET,
    async (_event, raw): Promise<IpcResult<SecretsGetResponse>> => {
      const validated = validateRefRequest(raw);
      if (!validated.ok) {
        return validated;
      }
      if (secretsManager === null) {
        return notInitialized('SecretsManager');
      }
      return secretsManager.get(validated.data.ref);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SECRETS_DELETE,
    async (_event, raw): Promise<IpcResult<{ ref: string }>> => {
      const validated = validateRefRequest(raw);
      if (!validated.ok) {
        return validated;
      }
      if (secretsManager === null) {
        return notInitialized('SecretsManager');
      }
      return secretsManager.delete(validated.data.ref);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SECRETS_LIST,
    async (): Promise<IpcResult<SecretsListResponse>> => {
      if (secretsManager === null) {
        return notInitialized('SecretsManager');
      }
      return secretsManager.list();
    },
  );

  // -- Jira poller -----------------------------------------------------------

  ipcMain.handle(
    IPC_CHANNELS.JIRA_LIST,
    async (_event, raw): Promise<IpcResult<JiraListResponse>> => {
      const validated = validateJiraProjectIdRequest(raw);
      if (!validated.ok) {
        return validated;
      }
      if (jiraPoller === null) {
        return notInitialized('JiraPoller');
      }
      const tickets = jiraPoller.list(validated.data.projectId);
      return { ok: true, data: { tickets: [...tickets] } };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.JIRA_REFRESH,
    async (_event, raw): Promise<IpcResult<JiraRefreshResponse>> => {
      const validated = validateJiraProjectIdRequest(raw);
      if (!validated.ok) {
        return validated;
      }
      if (jiraPoller === null) {
        return notInitialized('JiraPoller');
      }
      const res = await jiraPoller.refreshNow(validated.data.projectId);
      if (!res.ok) {
        return { ok: false, error: { code: res.error.code, message: res.error.message } };
      }
      return { ok: true, data: { tickets: res.data.tickets } };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.JIRA_TEST_CONNECTION,
    async (_event, raw): Promise<IpcResult<JiraTestConnectionResponse>> => {
      const validated = validateJiraTestConnectionRequest(raw);
      if (!validated.ok) {
        return validated;
      }
      if (jiraPoller === null) {
        return notInitialized('JiraPoller');
      }
      const res = await jiraPoller.testConnection({
        host: validated.data.host,
        auth: { email: validated.data.email, apiToken: validated.data.apiToken },
      });
      if (!res.ok) {
        return { ok: false, error: { code: res.error.code, message: res.error.message } };
      }
      return { ok: true, data: res.data };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.JIRA_REFRESH_POLLERS,
    async (): Promise<IpcResult<{ projectIds: string[] }>> => {
      if (jiraPoller === null || projectStore === null) {
        return notInitialized('JiraPoller');
      }
      // Re-sync: stop everything, then start a poller for each current
      // project. The poller's `start()` is idempotent, but stopping first
      // means projects deleted since last sync get cleaned up too.
      jiraPoller.stopAll();
      const list = await projectStore.list();
      if (!list.ok) {
        return { ok: false, error: { code: list.error.code, message: list.error.message } };
      }
      const ids: string[] = [];
      for (const p of list.data) {
        await jiraPoller.start(p, 5 * 60 * 1000);
        ids.push(p.id);
      }
      return { ok: true, data: { projectIds: ids } };
    },
  );

  // -- Workflow Runner -----------------------------------------------------

  ipcMain.handle(
    IPC_CHANNELS.RUNS_START,
    async (_event, raw): Promise<IpcResult<RunsStartResponse>> => {
      const validated = validateRunsStartRequest(raw);
      if (!validated.ok) {
        return validated;
      }
      if (workflowRunner === null) {
        return notInitialized('WorkflowRunner');
      }
      const res = await workflowRunner.start(validated.data);
      if (!res.ok) {
        return { ok: false, error: { code: res.error.code, message: res.error.message } };
      }
      return { ok: true, data: { run: res.data.run } };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.RUNS_CANCEL,
    async (_event, raw): Promise<IpcResult<{ runId: string }>> => {
      const validated = validateRunsRunIdRequest(raw);
      if (!validated.ok) {
        return validated;
      }
      if (workflowRunner === null) {
        return notInitialized('WorkflowRunner');
      }
      const res = await workflowRunner.cancel(validated.data.runId);
      if (!res.ok) {
        return { ok: false, error: { code: res.error.code, message: res.error.message } };
      }
      return { ok: true, data: res.data };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.RUNS_APPROVE,
    async (_event, raw): Promise<IpcResult<{ runId: string }>> => {
      const validated = validateRunsRunIdRequest(raw);
      if (!validated.ok) {
        return validated;
      }
      if (workflowRunner === null) {
        return notInitialized('WorkflowRunner');
      }
      const res = await workflowRunner.approve({ runId: validated.data.runId });
      if (!res.ok) {
        return { ok: false, error: { code: res.error.code, message: res.error.message } };
      }
      return { ok: true, data: res.data };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.RUNS_REJECT,
    async (_event, raw): Promise<IpcResult<{ runId: string }>> => {
      const validated = validateRunsRunIdRequest(raw);
      if (!validated.ok) {
        return validated;
      }
      if (workflowRunner === null) {
        return notInitialized('WorkflowRunner');
      }
      const res = await workflowRunner.reject({ runId: validated.data.runId });
      if (!res.ok) {
        return { ok: false, error: { code: res.error.code, message: res.error.message } };
      }
      return { ok: true, data: res.data };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.RUNS_MODIFY,
    async (_event, raw): Promise<IpcResult<{ runId: string }>> => {
      const validated = validateRunsModifyRequest(raw);
      if (!validated.ok) {
        return validated;
      }
      if (workflowRunner === null) {
        return notInitialized('WorkflowRunner');
      }
      const res = await workflowRunner.modify({
        runId: validated.data.runId,
        text: validated.data.text,
      });
      if (!res.ok) {
        return { ok: false, error: { code: res.error.code, message: res.error.message } };
      }
      return { ok: true, data: res.data };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.RUNS_CURRENT,
    async (): Promise<IpcResult<RunsCurrentResponse>> => {
      if (workflowRunner === null) {
        return notInitialized('WorkflowRunner');
      }
      return { ok: true, data: { run: workflowRunner.current() } };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.RUNS_LIST_HISTORY,
    async (_event, raw): Promise<IpcResult<RunsListHistoryResponse>> => {
      const validated = validateRunsListHistoryRequest(raw);
      if (!validated.ok) {
        return validated;
      }
      if (runStore === null) {
        return notInitialized('RunStore');
      }
      const res = await runStore.list(validated.data.projectId, validated.data.limit);
      if (!res.ok) {
        return { ok: false, error: { code: res.error.code, message: res.error.message } };
      }
      return { ok: true, data: { runs: res.data } };
    },
  );
}

function toIpcCurrentChangedEvent(e: { run: Run | null }): RunsCurrentChangedEvent {
  return { run: e.run };
}

function toIpcTicketsChangedEvent(e: TicketsChangedEvent): JiraTicketsChangedEvent {
  return {
    projectId: e.projectId,
    tickets: e.tickets,
    timestamp: e.timestamp,
  };
}

function toIpcJiraErrorEvent(e: PollerErrorEvent): JiraErrorEvent {
  return {
    projectId: e.projectId,
    code: e.code,
    message: e.message,
    consecutiveErrors: e.consecutiveErrors,
  };
}

/**
 * Initialize the secrets manager + project store. Failures are logged but
 * don't crash the app — the corresponding handlers will surface a
 * `NOT_INITIALIZED` error to the renderer instead.
 */
async function initStores(): Promise<void> {
  try {
    const userData = app.getPath('userData');
    const backend = new SafeStorageBackend();
    const secrets = new SecretsManager({
      filePath: join(userData, 'secrets.json'),
      backend,
    });
    const secretsInit = await secrets.init();
    if (!secretsInit.ok) {
      console.error(
        `[main] SecretsManager init failed: ${secretsInit.error.code} - ${secretsInit.error.message}`,
      );
      // Leave secretsManager null so set/delete return NOT_INITIALIZED — a
      // mutation on top of an unreadable file would clobber whatever's there
      // (corrupt envelope, future schemaVersion, partially-written blob).
      // The user's existing secrets file is left intact for inspection.
      return;
    }
    secretsManager = secrets;

    const store = new ProjectStore({
      filePath: join(userData, 'projects.json'),
      secretsManager: secrets,
    });
    const storeInit = await store.init();
    if (!storeInit.ok) {

      console.error(
        `[main] ProjectStore init failed: ${storeInit.error.code} - ${storeInit.error.message}`,
      );
      // Leave projectStore null so handlers return NOT_INITIALIZED — the
      // file is corrupt or unsupported and we shouldn't silently overwrite.
      return;
    }
    projectStore = store;

    const history = new RunHistory({
      filePath: join(userData, 'run-history.json'),
    });
    const historyInit = await history.init();
    if (!historyInit.ok) {

      console.error(
        `[main] RunHistory init failed: ${historyInit.error.code} - ${historyInit.error.message}`,
      );
      // RunHistory init failure leaves the poller un-constructed; jira:* IPC
      // handlers will surface NOT_INITIALIZED to the renderer.
      return;
    }
    runHistory = history;

    const poller = new JiraPoller({
      projectStore: store,
      secretsManager: secrets,
      runHistory: history,
    });
    poller.on('tickets-changed', (e: TicketsChangedEvent) => {
      broadcastToWindows(IPC_CHANNELS.JIRA_TICKETS_CHANGED, toIpcTicketsChangedEvent(e));
    });
    poller.on('error', (e: PollerErrorEvent) => {
      broadcastToWindows(IPC_CHANNELS.JIRA_ERROR, toIpcJiraErrorEvent(e));
    });
    jiraPoller = poller;

    // Bootstrap: kick off a poller for every currently-known project.
    const initialList = await store.list();
    if (initialList.ok) {
      for (const p of initialList.data) {
        await poller.start(p, 5 * 60 * 1000);
      }
    }

    // -- Workflow Runner (issue #7) --
    // Per-run JSON sidecars live under userData/runs/. RunStore.init creates
    // the directory if missing; failures are logged but never crash the app.
    const runs = new RunStore({ runsDir: join(userData, 'runs') });
    const runsInit = await runs.init();
    if (!runsInit.ok) {

      console.error(
        `[main] RunStore init failed: ${runsInit.error.code} - ${runsInit.error.message}`,
      );
      // Leave runStore null so runs:list-history surfaces NOT_INITIALIZED;
      // the WorkflowRunner itself can still operate without persistence
      // (saves are best-effort and logged) so we still construct it.
    } else {
      runStore = runs;
    }

    const runner = new WorkflowRunner({
      projectStore: {
        get: async (id: string) => {
          const r = await store.get(id);
          if (!r.ok) {
            return { ok: false, error: { code: r.error.code, message: r.error.message } };
          }
          return { ok: true, data: r.data };
        },
      },
      secretsManager: {
        get: async (ref: string) => {
          const r = await secrets.get(ref);
          if (!r.ok) {
            return { ok: false, error: { code: r.error.code, message: r.error.message } };
          }
          return { ok: true, data: { plaintext: r.data.plaintext } };
        },
      },
      runHistory: history,
      runStore: runs,
      claudeManager,
      gitManager: new StubGitManager(),
      prCreator: new StubPrCreator(),
      jiraUpdater: new StubJiraUpdater(),
    });
    runner.on('state-changed', (e: RunStateEvent) => {
      broadcastToWindows(IPC_CHANNELS.RUNS_STATE_CHANGED, e);
    });
    runner.on('current-changed', (e: { run: Run | null }) => {
      broadcastToWindows(IPC_CHANNELS.RUNS_CURRENT_CHANGED, toIpcCurrentChangedEvent(e));
    });
    workflowRunner = runner;
  } catch (err) {

    console.error('[main] store initialization threw:', err);
  }
}

app.whenReady().then(async () => {
  await initStores();
  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    // macOS: re-create a window when the dock icon is clicked and no other
    // windows are open.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  // Clear every poll timer cleanly so we don't fire a tick after the app
  // has started tearing down its windows / IPC channels.
  if (jiraPoller !== null) {
    jiraPoller.stopAll();
  }
  // Best-effort cancel of any in-flight workflow run so we don't leave a
  // child claude process orphaned. Fire and forget — the app is shutting
  // down regardless and we can't await here.
  if (workflowRunner !== null) {
    const active = workflowRunner.current();
    if (active !== null) {
      void workflowRunner.cancel(active.id);
    }
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
