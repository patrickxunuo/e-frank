import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import {
  dirname,
  isAbsolute as pathIsAbsolute,
  join,
  normalize as pathNormalize,
} from 'node:path';
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
  type RunsDeleteRequest,
  type RunsDeleteResponse,
  type RunsReadLogRequest,
  type RunsReadLogResponse,
  type TicketsListRequest,
  type TicketsListResponse,
  type RunsCurrentChangedEvent,
  type ConnectionsCreateRequest,
  type ConnectionsUpdateRequest,
  type ConnectionsTestRequest,
  type ConnectionsTestResponse,
  type ConnectionsListReposRequest,
  type ConnectionsListReposResponse,
  type ConnectionsListJiraProjectsRequest,
  type ConnectionsListJiraProjectsResponse,
  type ConnectionsListBranchesRequest,
  type ConnectionsListBranchesResponse,
  type DialogSelectFolderRequest,
  type DialogSelectFolderResponse,
  type ChromeState,
  type SkillsListResponse,
  type SkillsInstallRequest,
  type SkillsInstallResponse,
  type SkillsRemoveResponse,
  type SkillsFindStartResponse,
  type SkillsFindOutputEvent,
  type SkillsFindExitEvent,
  type ShellOpenPathRequest,
} from '../shared/ipc.js';
import type { Run, RunStateEvent, RunMode, RunLogEntry } from '../shared/schema/run.js';
import type {
  Connection,
  ConnectionIdentity,
  Provider,
  AuthMethod,
} from '../shared/schema/connection.js';
import { handlePing } from './ping-handler.js';
import {
  ClaudeProcessManager,
  type OutputEvent,
  type ExitEvent,
} from './modules/claude-process-manager.js';
import { NodeSpawner } from './modules/spawner.js';
import { ProjectStore } from './modules/project-store.js';
import { ConnectionStore } from './modules/connection-store.js';
import { SafeStorageBackend, SecretsManager } from './modules/secrets-manager.js';
import { FetchHttpClient } from './modules/http-client.js';
import { JiraClient } from './modules/jira-client.js';
import { GithubClient } from './modules/github-client.js';
import { RunHistory } from './modules/run-history.js';
import {
  TicketPoller,
  type PollerErrorEvent,
  type TicketsChangedEvent,
} from './modules/ticket-poller.js';
import { RunStore } from './modules/run-store.js';
import { RunLogStore } from './modules/run-log-store.js';
import { NodeGitManager } from './modules/git-manager.js';
import { StubPrCreator } from './modules/pr-creator.js';
import { StubJiraUpdater } from './modules/jira-updater.js';
import { WorkflowRunner } from './modules/workflow-runner.js';
import { installEfAutoFeatureSkill } from './modules/skill-installer.js';
import { migrateUserData } from './modules/migrate-userdata.js';
import { scanInstalledSkills } from './modules/skills-scanner.js';
import {
  installSkillViaNpx,
  InvalidSkillRefError,
  uninstallSkillViaNpx,
} from './modules/skill-npx-installer.js';
import {
  SkillFinder,
  FinderAlreadyActiveError,
  FinderNotActiveError,
  type FinderOutputEvent,
  type FinderExitEvent,
} from './modules/skill-finder.js';
import { isValidFindSkillsQuery } from './modules/skill-query-validator.js';
import { validateOpenExternalUrl } from './modules/shell-external-validator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let mainWindow: BrowserWindow | null = null;

/**
 * NOTE: Claude's stdout block-buffers when not connected to a TTY,
 * so output arrives in big chunks (often a single dump at process
 * exit) instead of streaming line-by-line. The clean fix is a
 * pseudo-terminal via `node-pty`, but every Windows-friendly PTY
 * package on npm is currently broken without Visual Studio Build
 * Tools (compile-from-source) or has Node 20+ `spawn EINVAL` issues
 * in its install script. Filed as a follow-up; for now we accept
 * the buffering and lean on the renderer-side fixes (heartbeat,
 * ticker, etc.) so the user has SOME signal that the run is live.
 */
const claudeManager = new ClaudeProcessManager({ spawner: new NodeSpawner() });

/**
 * Separate Claude spawn channel for the Skills `/find-skills` discovery
 * flow (#GH-38). Lives outside ClaudeProcessManager so it never collides
 * with the workflow runner's single-active-run guard — the user can
 * search for skills while a workflow is in flight.
 *
 * `cwd` is bound at app-ready time once `app.getPath('userData')` is
 * available. Until then `skillFinder` is null and handlers surface
 * NOT_INITIALIZED.
 */
let skillFinder: SkillFinder | null = null;

// These are constructed at app-ready time (before window creation) because
// `SafeStorageBackend` requires `app.whenReady()` and `app.getPath('userData')`
// is also only safe to call after ready.
let secretsManager: SecretsManager | null = null;
let projectStore: ProjectStore | null = null;
let connectionStore: ConnectionStore | null = null;
let runHistory: RunHistory | null = null;
let jiraPoller: TicketPoller | null = null;
let runStore: RunStore | null = null;
let runLogStore: RunLogStore | null = null;
let workflowRunner: WorkflowRunner | null = null;

function createWindow(): void {
  // Window chrome (issue #50): we ship a frameless window with a custom
  // 32px titlebar rendered in the renderer. On macOS we keep the native
  // traffic lights via `hiddenInset` (the renderer reserves ~80px on the
  // left so its lockup doesn't sit under them); on Windows/Linux the
  // renderer paints its own min/max/close glyphs.
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a1224',
    title: 'PaperPlane',
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset' as const,
          // Center the traffic lights in the 32px bar (default y is ~6px,
          // which floats them too high relative to our titlebar's center).
          trafficLightPosition: { x: 12, y: 9 },
        }
      : { frame: false }),
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

  // Broadcast maximize-state changes so the renderer can swap the
  // max/restore icon. Renderer reads the initial state via
  // `chrome:get-state` on mount.
  const broadcastMaximizedState = (isMaximized: boolean): void => {
    broadcastToWindows(IPC_CHANNELS.CHROME_STATE_CHANGED, { isMaximized });
  };
  mainWindow.on('maximize', () => {
    broadcastMaximizedState(true);
  });
  mainWindow.on('unmaximize', () => {
    broadcastMaximizedState(false);
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

function validateRunsReadLogRequest(raw: unknown): IpcResult<RunsReadLogRequest> {
  if (!isPlainObject(raw) || typeof raw['runId'] !== 'string') {
    return {
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'runId must be a string' },
    };
  }
  return { ok: true, data: { runId: raw['runId'] } };
}

function validateRunsDeleteRequest(raw: unknown): IpcResult<RunsDeleteRequest> {
  if (!isPlainObject(raw) || typeof raw['runId'] !== 'string' || raw['runId'] === '') {
    return {
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'runId must be a non-empty string' },
    };
  }
  return { ok: true, data: { runId: raw['runId'] } };
}

function validateTicketsListRequest(raw: unknown): IpcResult<TicketsListRequest> {
  if (!isPlainObject(raw) || typeof raw['projectId'] !== 'string' || raw['projectId'] === '') {
    return {
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'projectId must be a non-empty string' },
    };
  }
  const limit = raw['limit'];
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0 || limit > 100) {
    return {
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'limit must be a finite number in (0, 100]' },
    };
  }
  const cursor = raw['cursor'];
  if (cursor !== undefined && typeof cursor !== 'string') {
    return {
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'cursor must be a string when present' },
    };
  }
  const sortBy = raw['sortBy'];
  if (sortBy !== undefined && sortBy !== 'id' && sortBy !== 'priority') {
    return {
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'sortBy must be "id" or "priority"' },
    };
  }
  const sortDir = raw['sortDir'];
  if (sortDir !== undefined && sortDir !== 'asc' && sortDir !== 'desc') {
    return {
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'sortDir must be "asc" or "desc"' },
    };
  }
  const search = raw['search'];
  if (search !== undefined && typeof search !== 'string') {
    return {
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'search must be a string when present' },
    };
  }
  const req: TicketsListRequest = {
    projectId: raw['projectId'],
    limit,
  };
  if (typeof cursor === 'string') req.cursor = cursor;
  if (sortBy === 'id' || sortBy === 'priority') req.sortBy = sortBy;
  if (sortDir === 'asc' || sortDir === 'desc') req.sortDir = sortDir;
  if (typeof search === 'string') req.search = search;
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

// -- Connections request validators -----------------------------------------

function validateConnectionsCreateRequest(
  raw: unknown,
): IpcResult<ConnectionsCreateRequest> {
  if (!isPlainObject(raw) || raw['input'] === undefined) {
    return {
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'request.input must be present' },
    };
  }
  return {
    ok: true,
    data: { input: raw['input'] as ConnectionsCreateRequest['input'] },
  };
}

function validateConnectionsUpdateRequest(
  raw: unknown,
): IpcResult<ConnectionsUpdateRequest> {
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
    data: { id: raw['id'], input: raw['input'] as ConnectionsUpdateRequest['input'] },
  };
}

function validateConnectionsListReposRequest(
  raw: unknown,
): IpcResult<ConnectionsListReposRequest> {
  if (!isPlainObject(raw) || typeof raw['connectionId'] !== 'string') {
    return {
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'connectionId must be a string' },
    };
  }
  return { ok: true, data: { connectionId: raw['connectionId'] } };
}

function validateConnectionsListJiraProjectsRequest(
  raw: unknown,
): IpcResult<ConnectionsListJiraProjectsRequest> {
  if (!isPlainObject(raw) || typeof raw['connectionId'] !== 'string') {
    return {
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'connectionId must be a string' },
    };
  }
  return { ok: true, data: { connectionId: raw['connectionId'] } };
}

function validateConnectionsListBranchesRequest(
  raw: unknown,
): IpcResult<ConnectionsListBranchesRequest> {
  if (
    !isPlainObject(raw) ||
    typeof raw['connectionId'] !== 'string' ||
    typeof raw['slug'] !== 'string'
  ) {
    return {
      ok: false,
      error: {
        code: 'INVALID_REQUEST',
        message: 'connectionId and slug must be strings',
      },
    };
  }
  return {
    ok: true,
    data: { connectionId: raw['connectionId'], slug: raw['slug'] },
  };
}

function validateDialogSelectFolderRequest(
  raw: unknown,
): IpcResult<DialogSelectFolderRequest> {
  // Both fields are optional. The renderer can pass an empty object.
  if (raw === undefined || raw === null) {
    return { ok: true, data: {} };
  }
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'request must be an object' },
    };
  }
  const out: DialogSelectFolderRequest = {};
  const dp = raw['defaultPath'];
  if (dp !== undefined) {
    if (typeof dp !== 'string') {
      return {
        ok: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'defaultPath must be a string if present',
        },
      };
    }
    out.defaultPath = dp;
  }
  const t = raw['title'];
  if (t !== undefined) {
    if (typeof t !== 'string') {
      return {
        ok: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'title must be a string if present',
        },
      };
    }
    out.title = t;
  }
  return { ok: true, data: out };
}

function validateConnectionsTestRequest(
  raw: unknown,
): IpcResult<ConnectionsTestRequest> {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'request must be an object' },
    };
  }
  const mode = raw['mode'];
  if (mode === 'existing') {
    if (typeof raw['id'] !== 'string') {
      return {
        ok: false,
        error: { code: 'INVALID_REQUEST', message: 'id must be a string' },
      };
    }
    return { ok: true, data: { mode: 'existing', id: raw['id'] } };
  }
  if (mode === 'preview') {
    const provider = raw['provider'];
    const host = raw['host'];
    const authMethod = raw['authMethod'];
    const plaintextToken = raw['plaintextToken'];
    if (
      typeof provider !== 'string' ||
      (provider !== 'github' && provider !== 'bitbucket' && provider !== 'jira')
    ) {
      return {
        ok: false,
        error: { code: 'INVALID_REQUEST', message: 'provider must be a valid Provider' },
      };
    }
    if (typeof host !== 'string') {
      return {
        ok: false,
        error: { code: 'INVALID_REQUEST', message: 'host must be a string' },
      };
    }
    if (
      typeof authMethod !== 'string' ||
      (authMethod !== 'pat' && authMethod !== 'app-password' && authMethod !== 'api-token')
    ) {
      return {
        ok: false,
        error: { code: 'INVALID_REQUEST', message: 'authMethod must be a valid AuthMethod' },
      };
    }
    if (typeof plaintextToken !== 'string') {
      return {
        ok: false,
        error: { code: 'INVALID_REQUEST', message: 'plaintextToken must be a string' },
      };
    }
    const email = raw['email'];
    if (email !== undefined && typeof email !== 'string') {
      return {
        ok: false,
        error: { code: 'INVALID_REQUEST', message: 'email must be a string if present' },
      };
    }
    const data: ConnectionsTestRequest = {
      mode: 'preview',
      provider: provider as Provider,
      host,
      authMethod: authMethod as AuthMethod,
      plaintextToken,
    };
    if (typeof email === 'string') {
      data.email = email;
    }
    return { ok: true, data };
  }
  return {
    ok: false,
    error: { code: 'INVALID_REQUEST', message: 'mode must be "existing" or "preview"' },
  };
}

/**
 * Resolve credentials and run a one-shot Test Connection. For `mode:
 * 'existing'`, looks up the connection + reads the secret; for `mode:
 * 'preview'`, takes fields from the request directly. Constructs a fresh
 * `JiraClient` or `GithubClient` per call. On `existing` success, also
 * persists the verification on the connection row.
 *
 * Bitbucket → NOT_IMPLEMENTED (kept here so the renderer can still render
 * Bitbucket rows; only the test action is gated).
 */
async function runConnectionTest(
  req: ConnectionsTestRequest,
): Promise<IpcResult<ConnectionsTestResponse>> {
  if (connectionStore === null || secretsManager === null) {
    return notInitialized('ConnectionStore');
  }
  let provider: Provider;
  let host: string;
  let authMethod: AuthMethod;
  let plaintextToken: string;
  let email: string | undefined;
  let existingId: string | undefined;

  if (req.mode === 'existing') {
    const got = await connectionStore.get(req.id);
    if (!got.ok) {
      return { ok: false, error: { code: got.error.code, message: got.error.message } };
    }
    const conn = got.data;
    const secret = await secretsManager.get(conn.secretRef);
    if (!secret.ok) {
      return {
        ok: false,
        error: { code: secret.error.code, message: secret.error.message },
      };
    }
    provider = conn.provider;
    host = conn.host;
    authMethod = conn.authMethod;
    existingId = conn.id;
    if (conn.provider === 'jira' && conn.authMethod === 'api-token') {
      // Stored as "email\ntoken" — split on the first newline.
      const value = secret.data.plaintext;
      const nl = value.indexOf('\n');
      if (nl < 0) {
        return {
          ok: false,
          error: {
            code: 'INVALID_SECRET',
            message: 'stored Jira secret is missing the email\\ntoken split',
          },
        };
      }
      email = value.slice(0, nl);
      plaintextToken = value.slice(nl + 1);
    } else {
      plaintextToken = secret.data.plaintext;
    }
  } else {
    provider = req.provider;
    host = req.host;
    authMethod = req.authMethod;
    plaintextToken = req.plaintextToken;
    if (req.email !== undefined) {
      email = req.email;
    }
  }

  const httpClient = new FetchHttpClient();

  if (provider === 'github') {
    const client = new GithubClient({
      httpClient,
      host,
      auth: { token: plaintextToken },
    });
    const res = await client.testConnection();
    if (!res.ok) {
      // Only an explicit HTTP 401 invalidates a stored connection's
      // verified state. 403/network/5xx leave the cached "verified" bit
      // alone — the token may still be valid, this call just couldn't
      // confirm it.
      if (
        existingId !== undefined &&
        res.error.code === 'AUTH' &&
        res.error.status === 401
      ) {
        await connectionStore.markVerificationFailed(existingId);
      }
      return { ok: false, error: { code: res.error.code, message: res.error.message } };
    }
    const identity: ConnectionIdentity = {
      kind: 'github',
      login: res.data.login,
      ...(res.data.name !== undefined ? { name: res.data.name } : {}),
      scopes: res.data.scopes,
    };
    const verifiedAt = Date.now();
    if (existingId !== undefined) {
      await connectionStore.recordVerification(existingId, identity);
    }
    return { ok: true, data: { identity, verifiedAt } };
  }

  if (provider === 'jira') {
    if (authMethod === 'api-token' && (email === undefined || email === '')) {
      return {
        ok: false,
        error: { code: 'AUTH', message: 'Jira api-token connections require an email' },
      };
    }
    const client = new JiraClient({
      httpClient,
      host,
      auth: { email: email ?? '', apiToken: plaintextToken },
    });
    const res = await client.testConnection();
    if (!res.ok) {
      if (
        existingId !== undefined &&
        res.error.code === 'AUTH' &&
        res.error.status === 401
      ) {
        await connectionStore.markVerificationFailed(existingId);
      }
      return { ok: false, error: { code: res.error.code, message: res.error.message } };
    }
    const identity: ConnectionIdentity = {
      kind: 'jira',
      accountId: res.data.accountId,
      displayName: res.data.displayName,
      ...(res.data.emailAddress !== ''
        ? { emailAddress: res.data.emailAddress }
        : {}),
    };
    const verifiedAt = Date.now();
    if (existingId !== undefined) {
      await connectionStore.recordVerification(existingId, identity);
    }
    return { ok: true, data: { identity, verifiedAt } };
  }

  // Bitbucket — placeholder.
  return {
    ok: false,
    error: {
      code: 'NOT_IMPLEMENTED',
      message: 'Bitbucket connections are not yet supported',
    },
  };
}

/**
 * Normalize a filesystem path for an allow-list check. `path.normalize`
 * collapses redundant separators + `.`/`..` segments. We pass the
 * normalized form into the `.claude/skills/` regex check — the original
 * `req.path` is still validated separately against `..` traversal so
 * the user-visible reason for refusal is precise.
 */
function normalizePathForCheck(p: string): string {
  try {
    return pathNormalize(p);
  } catch {
    return p;
  }
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

  // -- Connections (issue #24) ----------------------------------------------

  ipcMain.handle(
    IPC_CHANNELS.CONNECTIONS_LIST,
    async (): Promise<IpcResult<Connection[]>> => {
      if (connectionStore === null) {
        return notInitialized('ConnectionStore');
      }
      return connectionStore.list();
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CONNECTIONS_GET,
    async (_event, raw): Promise<IpcResult<Connection>> => {
      const validated = validateIdRequest(raw);
      if (!validated.ok) {
        return validated;
      }
      if (connectionStore === null) {
        return notInitialized('ConnectionStore');
      }
      return connectionStore.get(validated.data.id);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CONNECTIONS_CREATE,
    async (_event, raw): Promise<IpcResult<Connection>> => {
      const validated = validateConnectionsCreateRequest(raw);
      if (!validated.ok) {
        return validated;
      }
      if (connectionStore === null) {
        return notInitialized('ConnectionStore');
      }
      const result = await connectionStore.create(validated.data.input);
      if (!result.ok) {
        return { ok: false, error: { code: result.error.code, message: result.error.message } };
      }
      return { ok: true, data: result.data };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CONNECTIONS_UPDATE,
    async (_event, raw): Promise<IpcResult<Connection>> => {
      const validated = validateConnectionsUpdateRequest(raw);
      if (!validated.ok) {
        return validated;
      }
      if (connectionStore === null) {
        return notInitialized('ConnectionStore');
      }
      const result = await connectionStore.update(validated.data.id, validated.data.input);
      if (!result.ok) {
        return { ok: false, error: { code: result.error.code, message: result.error.message } };
      }
      return { ok: true, data: result.data };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CONNECTIONS_DELETE,
    async (_event, raw): Promise<IpcResult<{ id: string }>> => {
      const validated = validateIdRequest(raw);
      if (!validated.ok) {
        return validated;
      }
      if (connectionStore === null) {
        return notInitialized('ConnectionStore');
      }
      const result = await connectionStore.delete(validated.data.id);
      if (!result.ok) {
        // Forward `details` (e.g. `{ referencedBy: string[] }` for IN_USE)
        // so the renderer can surface the blocking project IDs. The
        // `IpcResult` error type is intentionally narrow; we attach the
        // optional `details` via a structural cast so the renderer can
        // read it defensively without committing to a richer contract.
        const error: { code: string; message: string; details?: unknown } = {
          code: result.error.code,
          message: result.error.message,
        };
        if (result.error.details !== undefined) {
          error.details = result.error.details;
        }
        return { ok: false, error: error as { code: string; message: string } };
      }
      return { ok: true, data: result.data };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CONNECTIONS_TEST,
    async (_event, raw): Promise<IpcResult<ConnectionsTestResponse>> => {
      const validated = validateConnectionsTestRequest(raw);
      if (!validated.ok) {
        return validated;
      }
      if (connectionStore === null || secretsManager === null) {
        return notInitialized('ConnectionStore');
      }
      return runConnectionTest(validated.data);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CONNECTIONS_LIST_REPOS,
    async (_event, raw): Promise<IpcResult<ConnectionsListReposResponse>> => {
      const validated = validateConnectionsListReposRequest(raw);
      if (!validated.ok) {
        return validated;
      }
      if (connectionStore === null || secretsManager === null) {
        return notInitialized('ConnectionStore');
      }
      const got = await connectionStore.get(validated.data.connectionId);
      if (!got.ok) {
        return { ok: false, error: { code: got.error.code, message: got.error.message } };
      }
      const conn = got.data;
      if (conn.provider !== 'github') {
        return {
          ok: false,
          error: {
            code: 'INVALID_PROVIDER',
            message: 'connection provider mismatch',
          },
        };
      }
      const secret = await secretsManager.get(conn.secretRef);
      if (!secret.ok) {
        return {
          ok: false,
          error: { code: secret.error.code, message: secret.error.message },
        };
      }
      const client = new GithubClient({
        httpClient: new FetchHttpClient(),
        host: conn.host,
        auth: { token: secret.data.plaintext },
      });
      const res = await client.listRepos();
      if (!res.ok) {
        return { ok: false, error: { code: res.error.code, message: res.error.message } };
      }
      return {
        ok: true,
        data: {
          repos: res.data.map((r) => ({
            slug: r.fullName,
            defaultBranch: r.defaultBranch,
            private: r.private,
          })),
        },
      };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CONNECTIONS_LIST_BRANCHES,
    async (_event, raw): Promise<IpcResult<ConnectionsListBranchesResponse>> => {
      const validated = validateConnectionsListBranchesRequest(raw);
      if (!validated.ok) {
        return validated;
      }
      if (connectionStore === null || secretsManager === null) {
        return notInitialized('ConnectionStore');
      }
      const got = await connectionStore.get(validated.data.connectionId);
      if (!got.ok) {
        return { ok: false, error: { code: got.error.code, message: got.error.message } };
      }
      const conn = got.data;
      if (conn.provider !== 'github') {
        return {
          ok: false,
          error: {
            code: 'INVALID_PROVIDER',
            message: 'connection provider mismatch',
          },
        };
      }
      const secret = await secretsManager.get(conn.secretRef);
      if (!secret.ok) {
        return {
          ok: false,
          error: { code: secret.error.code, message: secret.error.message },
        };
      }
      const client = new GithubClient({
        httpClient: new FetchHttpClient(),
        host: conn.host,
        auth: { token: secret.data.plaintext },
      });
      const res = await client.listBranches(validated.data.slug);
      if (!res.ok) {
        return { ok: false, error: { code: res.error.code, message: res.error.message } };
      }
      return {
        ok: true,
        data: {
          branches: res.data.map((b) => ({ name: b.name, protected: b.protected })),
        },
      };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.DIALOG_SELECT_FOLDER,
    async (_event, raw): Promise<IpcResult<DialogSelectFolderResponse>> => {
      const validated = validateDialogSelectFolderRequest(raw);
      if (!validated.ok) {
        return validated;
      }
      try {
        // Anchor the dialog to the focused window when possible so the
        // sheet sits over our app on macOS instead of floating loose.
        const parent = BrowserWindow.getFocusedWindow() ?? mainWindow;
        const opts: Electron.OpenDialogOptions = {
          properties: ['openDirectory', 'createDirectory'],
        };
        if (validated.data.title !== undefined) opts.title = validated.data.title;
        if (validated.data.defaultPath !== undefined)
          opts.defaultPath = validated.data.defaultPath;
        const result =
          parent !== null
            ? await dialog.showOpenDialog(parent, opts)
            : await dialog.showOpenDialog(opts);
        if (result.canceled || result.filePaths.length === 0) {
          return { ok: true, data: { path: null } };
        }
        return { ok: true, data: { path: result.filePaths[0] ?? null } };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: { code: 'IO_FAILURE', message } };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CONNECTIONS_LIST_JIRA_PROJECTS,
    async (
      _event,
      raw,
    ): Promise<IpcResult<ConnectionsListJiraProjectsResponse>> => {
      const validated = validateConnectionsListJiraProjectsRequest(raw);
      if (!validated.ok) {
        return validated;
      }
      if (connectionStore === null || secretsManager === null) {
        return notInitialized('ConnectionStore');
      }
      const got = await connectionStore.get(validated.data.connectionId);
      if (!got.ok) {
        return { ok: false, error: { code: got.error.code, message: got.error.message } };
      }
      const conn = got.data;
      if (conn.provider !== 'jira') {
        return {
          ok: false,
          error: {
            code: 'INVALID_PROVIDER',
            message: 'connection provider mismatch',
          },
        };
      }
      const secret = await secretsManager.get(conn.secretRef);
      if (!secret.ok) {
        return {
          ok: false,
          error: { code: secret.error.code, message: secret.error.message },
        };
      }
      // Jira `api-token` connections store `email\ntoken`. Fall back to
      // treating the whole value as the token if there's no `\n` (matches
      // the JiraPoller's defense-in-depth pairing).
      const value = secret.data.plaintext;
      const nl = value.indexOf('\n');
      const email = nl < 0 ? '' : value.slice(0, nl);
      const apiToken = nl < 0 ? value : value.slice(nl + 1);
      const client = new JiraClient({
        httpClient: new FetchHttpClient(),
        host: conn.host,
        auth: { email, apiToken },
      });
      const res = await client.listProjects();
      if (!res.ok) {
        return { ok: false, error: { code: res.error.code, message: res.error.message } };
      }
      return {
        ok: true,
        data: {
          projects: res.data.map((p) => ({ key: p.key, name: p.name })),
        },
      };
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

  ipcMain.handle(
    IPC_CHANNELS.RUNS_READ_LOG,
    async (_event, raw): Promise<IpcResult<RunsReadLogResponse>> => {
      const validated = validateRunsReadLogRequest(raw);
      if (!validated.ok) {
        return validated;
      }
      if (runLogStore === null) {
        return notInitialized('RunLogStore');
      }
      const res = await runLogStore.read(validated.data.runId);
      if (!res.ok) {
        return { ok: false, error: { code: res.error.code, message: res.error.message } };
      }
      return { ok: true, data: { entries: res.data } };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.RUNS_DELETE,
    async (_event, raw): Promise<IpcResult<RunsDeleteResponse>> => {
      const validated = validateRunsDeleteRequest(raw);
      if (!validated.ok) {
        return validated;
      }
      if (runStore === null) {
        return notInitialized('RunStore');
      }
      const { runId } = validated.data;
      // Refuse to drop an in-flight run — its sidecar is still being
      // written to and the renderer would lose its current view of state.
      if (workflowRunner !== null) {
        const active = workflowRunner.current();
        if (active !== null && active.id === runId) {
          return {
            ok: false,
            error: { code: 'ACTIVE_RUN', message: 'cannot delete a run while it is running' },
          };
        }
      }
      const res = await runStore.delete(runId);
      if (!res.ok) {
        return { ok: false, error: { code: res.error.code, message: res.error.message } };
      }
      // Drop the sibling NDJSON log too. RunStore and RunLogStore live in
      // the same `runsDir` but are separate fs surfaces. Either failing
      // surfaces back to the renderer; we don't want to half-delete a run
      // and leave 80MB of log behind.
      if (runLogStore !== null) {
        const logRes = await runLogStore.delete(runId);
        if (!logRes.ok) {
          return { ok: false, error: { code: logRes.error.code, message: logRes.error.message } };
        }
      }
      return { ok: true, data: { runId } };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.TICKETS_LIST,
    async (_event, raw): Promise<IpcResult<TicketsListResponse>> => {
      const validated = validateTicketsListRequest(raw);
      if (!validated.ok) {
        return validated;
      }
      if (jiraPoller === null) {
        return notInitialized('TicketPoller');
      }
      const opts = validated.data;
      const res = await jiraPoller.listPage(opts.projectId, {
        cursor: opts.cursor,
        limit: opts.limit,
        sortBy: opts.sortBy,
        sortDir: opts.sortDir,
        search: opts.search,
      });
      if (!res.ok) {
        return { ok: false, error: { code: res.code, message: res.message } };
      }
      const out: TicketsListResponse = { rows: res.data.rows };
      if (res.data.nextCursor !== undefined) {
        out.nextCursor = res.data.nextCursor;
      }
      return { ok: true, data: out };
    },
  );

  // -- Window chrome (issue #50) ---------------------------------------------
  //
  // The renderer's custom titlebar drives min/max/close + reads the initial
  // maximize state on mount. Each handler resolves the `BrowserWindow` from
  // the IPC sender so future multi-window callers operate on themselves
  // (rather than always poking the focused window).
  const resolveSenderWindow = (
    event: Electron.IpcMainInvokeEvent,
  ): BrowserWindow | null => {
    return BrowserWindow.fromWebContents(event.sender);
  };

  ipcMain.handle(IPC_CHANNELS.CHROME_MINIMIZE, (event): IpcResult<null> => {
    const win = resolveSenderWindow(event);
    if (win === null) {
      return { ok: false, error: { code: 'NO_WINDOW', message: 'no host window' } };
    }
    win.minimize();
    return { ok: true, data: null };
  });

  ipcMain.handle(IPC_CHANNELS.CHROME_MAXIMIZE, (event): IpcResult<null> => {
    const win = resolveSenderWindow(event);
    if (win === null) {
      return { ok: false, error: { code: 'NO_WINDOW', message: 'no host window' } };
    }
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
    return { ok: true, data: null };
  });

  ipcMain.handle(IPC_CHANNELS.CHROME_CLOSE, (event): IpcResult<null> => {
    const win = resolveSenderWindow(event);
    if (win === null) {
      return { ok: false, error: { code: 'NO_WINDOW', message: 'no host window' } };
    }
    win.close();
    return { ok: true, data: null };
  });

  ipcMain.handle(IPC_CHANNELS.CHROME_GET_STATE, (event): IpcResult<ChromeState> => {
    const win = resolveSenderWindow(event);
    if (win === null) {
      return { ok: false, error: { code: 'NO_WINDOW', message: 'no host window' } };
    }
    return {
      ok: true,
      data: { isMaximized: win.isMaximized(), platform: process.platform },
    };
  });

  // -- Skill management (#GH-38) --------------------------------------------

  ipcMain.handle(
    IPC_CHANNELS.SKILLS_LIST,
    async (): Promise<IpcResult<SkillsListResponse>> => {
      try {
        // `projectRoot` enables the project-level lane (`<cwd>/.claude/skills/`).
        // Without it the scanner silently skips that lane entirely — and the
        // bundled `ef-auto-feature` skill (which lives under the e-frank repo's
        // own `.claude/skills/` directory in dev) wouldn't appear in the list.
        // `process.cwd()` resolves to the running Electron process's working
        // directory — the repo root in dev, the install dir in dist:win
        // (where there's no `.claude/skills/`, so the project lane is a
        // graceful no-op).
        const skills = await scanInstalledSkills({
          projectRoot: process.cwd(),
        });
        return { ok: true, data: { skills } };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: { code: 'SCAN_FAILED', message } };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SKILLS_INSTALL,
    async (_event, raw): Promise<IpcResult<SkillsInstallResponse>> => {
      const refRaw =
        typeof raw === 'object' && raw !== null && 'ref' in raw
          ? (raw as { ref?: unknown }).ref
          : undefined;
      if (typeof refRaw !== 'string' || refRaw.trim() === '') {
        return {
          ok: false,
          error: { code: 'INVALID_REQUEST', message: 'ref must be a non-empty string' },
        };
      }
      const req: SkillsInstallRequest = { ref: refRaw };
      try {
        const result = await installSkillViaNpx({
          spawner: new NodeSpawner(),
          ref: req.ref,
          cwd: app.getPath('userData'),
        });
        return { ok: true, data: result };
      } catch (err) {
        if (err instanceof InvalidSkillRefError) {
          return {
            ok: false,
            error: { code: err.code, message: err.message },
          };
        }
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: { code: 'INSTALL_FAILED', message } };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SKILLS_REMOVE,
    async (_event, raw): Promise<IpcResult<SkillsRemoveResponse>> => {
      // Same shape-check + regex defense as the install handler; the
      // `uninstallSkillViaNpx` module also validates the ref but we
      // do it here too so a malformed payload never reaches the
      // shell:true spawn.
      const refRaw =
        typeof raw === 'object' && raw !== null && 'ref' in raw
          ? (raw as { ref?: unknown }).ref
          : undefined;
      if (typeof refRaw !== 'string' || refRaw.trim() === '') {
        return {
          ok: false,
          error: { code: 'INVALID_REQUEST', message: 'ref must be a non-empty string' },
        };
      }
      try {
        const result = await uninstallSkillViaNpx({
          spawner: new NodeSpawner(),
          ref: refRaw,
          cwd: app.getPath('userData'),
        });
        return { ok: true, data: result };
      } catch (err) {
        if (err instanceof InvalidSkillRefError) {
          return {
            ok: false,
            error: { code: err.code, message: err.message },
          };
        }
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: { code: 'REMOVE_FAILED', message } };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SKILLS_FIND_START,
    async (_event, raw): Promise<IpcResult<SkillsFindStartResponse>> => {
      const queryRaw =
        typeof raw === 'object' && raw !== null && 'query' in raw
          ? (raw as { query?: unknown }).query
          : undefined;
      if (typeof queryRaw !== 'string' || queryRaw.trim() === '') {
        return {
          ok: false,
          error: { code: 'INVALID_REQUEST', message: 'query must be a non-empty string' },
        };
      }
      // Shell-injection defense. NodeSpawner defaults to `shell: true` so
      // the query is concatenated into a `cmd.exe /c "claude ... -p
      // /find-skills <query>"` string before the OS sees it. A malicious
      // renderer could send `q & calc.exe` and break out. Centralized in
      // `skill-query-validator.ts` so the policy has one home + one test.
      if (!isValidFindSkillsQuery(queryRaw)) {
        return {
          ok: false,
          error: {
            code: 'INVALID_QUERY',
            message:
              'query must be plain text under 200 chars without quotes or shell metacharacters',
          },
        };
      }
      if (skillFinder === null) {
        return notInitialized('SkillFinder');
      }
      try {
        const active = skillFinder.start(queryRaw);
        return {
          ok: true,
          data: { findId: active.findId, pid: active.pid, startedAt: active.startedAt },
        };
      } catch (err) {
        if (err instanceof FinderAlreadyActiveError) {
          return { ok: false, error: { code: err.code, message: err.message } };
        }
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: { code: 'FIND_START_FAILED', message } };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SKILLS_FIND_CANCEL,
    async (_event, raw): Promise<IpcResult<{ findId: string }>> => {
      const findIdRaw =
        typeof raw === 'object' && raw !== null && 'findId' in raw
          ? (raw as { findId?: unknown }).findId
          : undefined;
      if (typeof findIdRaw !== 'string' || findIdRaw === '') {
        return {
          ok: false,
          error: { code: 'INVALID_REQUEST', message: 'findId must be a non-empty string' },
        };
      }
      if (skillFinder === null) {
        return notInitialized('SkillFinder');
      }
      try {
        skillFinder.cancel(findIdRaw);
        return { ok: true, data: { findId: findIdRaw } };
      } catch (err) {
        if (err instanceof FinderNotActiveError) {
          return { ok: false, error: { code: err.code, message: err.message } };
        }
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: { code: 'FIND_CANCEL_FAILED', message } };
      }
    },
  );

  // -- Shell open-path (companion to skills feature) ------------------------

  ipcMain.handle(
    IPC_CHANNELS.SHELL_OPEN_PATH,
    async (_event, raw): Promise<IpcResult<null>> => {
      const pathRaw =
        typeof raw === 'object' && raw !== null && 'path' in raw
          ? (raw as { path?: unknown }).path
          : undefined;
      if (typeof pathRaw !== 'string' || pathRaw === '') {
        return {
          ok: false,
          error: { code: 'INVALID_REQUEST', message: 'path must be a non-empty string' },
        };
      }
      // Defense-in-depth — a compromised renderer must NOT be able to ask
      // Electron to shell-open arbitrary paths (which on Windows + macOS
      // can include `.exe` / `.app` files that the OS happily launches).
      // The only legitimate caller is the Skills page's row "Open" action,
      // and that always passes a SkillSummary.dirPath, which by
      // construction sits under `.claude/skills/` on some root. Require
      // that segment + reject any `..` traversal + require absolute.
      const req: ShellOpenPathRequest = { path: pathRaw };
      const norm = normalizePathForCheck(req.path);
      const isAbs = pathIsAbsolute(req.path);
      const hasSkillsSegment = /[\\/]\.claude[\\/]skills[\\/]/.test(norm);
      const hasTraversal = /(^|[\\/])\.\.([\\/]|$)/.test(req.path);
      if (!isAbs || hasTraversal || !hasSkillsSegment) {
        return {
          ok: false,
          error: {
            code: 'FORBIDDEN_PATH',
            message: 'shell:open-path only accepts absolute paths under .claude/skills/',
          },
        };
      }
      try {
        const errMsg = await shell.openPath(req.path);
        if (errMsg !== '') {
          return { ok: false, error: { code: 'OPEN_FAILED', message: errMsg } };
        }
        return { ok: true, data: null };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: { code: 'OPEN_FAILED', message } };
      }
    },
  );

  // -- Shell open-external (companion to skills find-dialog "View" button)
  ipcMain.handle(
    IPC_CHANNELS.SHELL_OPEN_EXTERNAL,
    async (_event, raw): Promise<IpcResult<null>> => {
      const urlRaw =
        typeof raw === 'object' && raw !== null && 'url' in raw
          ? (raw as { url?: unknown }).url
          : undefined;
      const validated = validateOpenExternalUrl(urlRaw);
      if (!validated.ok) {
        const code =
          validated.reason === 'FORBIDDEN_HOST'
            ? 'FORBIDDEN_URL'
            : validated.reason === 'BAD_PROTOCOL'
              ? 'FORBIDDEN_URL'
              : 'INVALID_REQUEST';
        return {
          ok: false,
          error: {
            code,
            message:
              code === 'FORBIDDEN_URL'
                ? 'shell:open-external rejected: URL host or protocol not allow-listed'
                : 'url must be a parseable absolute URL',
          },
        };
      }
      try {
        await shell.openExternal(validated.url);
        return { ok: true, data: null };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: { code: 'OPEN_FAILED', message } };
      }
    },
  );
}

function toIpcCurrentChangedEvent(e: { run: Run | null }): RunsCurrentChangedEvent {
  return { run: e.run };
}

function toIpcFindOutputEvent(e: FinderOutputEvent): SkillsFindOutputEvent {
  return {
    findId: e.findId,
    stream: e.stream,
    line: e.line,
    timestamp: e.timestamp,
  };
}

function toIpcFindExitEvent(e: FinderExitEvent): SkillsFindExitEvent {
  return {
    findId: e.findId,
    exitCode: e.exitCode,
    signal: e.signal,
    durationMs: e.durationMs,
    reason: e.reason,
  };
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

    // -- Connection store (issue #24, finished in #25) --
    // The `getReferencingProjectIds` callback scans the live ProjectStore
    // (captured via the module-level `projectStore` reference, which is
    // assigned a few statements below — the callback only runs lazily,
    // when a delete is attempted).
    const connections = new ConnectionStore({
      filePath: join(userData, 'connections.json'),
      secretsManager: secrets,
      getReferencingProjectIds: async (connectionId) => {
        if (projectStore === null) return [];
        const list = await projectStore.list();
        if (!list.ok) return [];
        return list.data
          .filter(
            (p) =>
              p.repo.connectionId === connectionId ||
              p.tickets.connectionId === connectionId,
          )
          .map((p) => p.id);
      },
    });
    const connectionsInit = await connections.init();
    if (!connectionsInit.ok) {
      console.error(
        `[main] ConnectionStore init failed: ${connectionsInit.error.code} - ${connectionsInit.error.message}`,
      );
      // Leave connectionStore null — handlers surface NOT_INITIALIZED.
    } else {
      connectionStore = connections;
    }

    const store = new ProjectStore({
      filePath: join(userData, 'projects.json'),
    });
    const storeInit = await store.init();
    if (!storeInit.ok) {
      console.error(
        `[main] ProjectStore init failed: ${storeInit.error.code} - ${storeInit.error.message}`,
      );
      // We DO NOT `return` here anymore. Bailing out left every other IPC
      // handler unregistered (renderer would error on Connections, runs,
      // claude:* — anything downstream). Now we leave `projectStore`
      // null so projects:* handlers surface NOT_INITIALIZED, but the rest
      // of the app keeps wiring. The store also auto-archives an
      // incompatible projects file inside init() — so this branch only
      // hits on a hard IO failure (couldn't rename, etc.).
    } else {
      projectStore = store;
      if (storeInit.data.recoveredFrom !== undefined) {
        console.warn(
          `[main] ProjectStore recovered from incompatible file; archive at "${storeInit.data.recoveredFrom}"`,
        );
      }
    }

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
    // GH-13 — stale-lock recovery. A fresh app start can't have any
    // in-process runs in flight (single-process desktop app), so every
    // persisted lock is by definition orphaned by a crashed previous
    // session. `releaseStaleLocks(0)` releases all of them and returns
    // the released entries; we log each one so the user has a trail of
    // what was cleared (satisfies the spec's "auto-released or flagged"
    // criterion). UI surfacing of released locks is deferred.
    const released = await history.releaseStaleLocks(0);
    if (!released.ok) {
      console.warn(
        `[main] RunHistory.releaseStaleLocks failed: ${released.error.code} - ${released.error.message}`,
      );
    } else if (released.data.length > 0) {
      for (const lock of released.data) {
        const when =
          lock.lockedAt > 0
            ? new Date(lock.lockedAt).toISOString()
            : 'unknown (pre-v2 schema)';
        console.warn(
          `[main] RunHistory released stale lock: projectId=${lock.projectId} key=${lock.key} lockedAt=${when}`,
        );
      }
    }
    runHistory = history;

    const poller = new TicketPoller({
      projectStore: store,
      connectionStore: connections,
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

    // -- Run Log Store (issue #8) --
    // Append-only NDJSON per-run log files live alongside the run JSON
    // sidecars. Init failures leave runLogStore null so the read handler
    // surfaces NOT_INITIALIZED; the claude->log forwarder below still
    // attempts appends but logs and swallows the error.
    const runLogs = new RunLogStore({ runsDir: join(userData, 'runs') });
    const runLogsInit = await runLogs.init();
    if (!runLogsInit.ok) {
      console.error(
        `[main] RunLogStore init failed: ${runLogsInit.error.code} - ${runLogsInit.error.message}`,
      );
    } else {
      runLogStore = runLogs;
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
      gitManager: new NodeGitManager({ spawner: new NodeSpawner() }),
      prCreator: new StubPrCreator(),
      jiraUpdater: new StubJiraUpdater(),
      // Read-only adapter — runner uses this only to resolve a ticket's
      // summary by key for branch/commit derivation. Returns mutable copy
      // since the poller's internal cache is ReadonlyArray.
      ticketPoller: { list: (id) => [...poller.list(id)] },
    });
    runner.on('state-changed', (e: RunStateEvent) => {
      broadcastToWindows(IPC_CHANNELS.RUNS_STATE_CHANGED, e);
    });
    runner.on('current-changed', (e: { run: Run | null }) => {
      broadcastToWindows(IPC_CHANNELS.RUNS_CURRENT_CHANGED, toIpcCurrentChangedEvent(e));
    });
    workflowRunner = runner;

    // -- Claude output -> RunLogStore (issue #8) --
    // Forward every line from the active claude child process to the
    // run-log NDJSON file, tagged with the runner's current state. Lines
    // emitted while no run is active (defensive — shouldn't happen in
    // practice) are dropped. We hook into the manager AFTER the runner is
    // wired so `runner.current()` reflects the very first state.
    claudeManager.on('output', (e: OutputEvent) => {
      if (workflowRunner === null || runLogStore === null) return;
      const current = workflowRunner.current();
      if (current === null) return;
      const entry: RunLogEntry = {
        runId: current.id,
        stream: e.stream,
        line: e.line,
        timestamp: e.timestamp,
        state: current.state,
      };
      void runLogStore.appendLine(entry).then((res) => {
        if (!res.ok) {
          console.warn(
            `[main] runLogStore.appendLine failed for run ${current.id}: ${res.error.code} - ${res.error.message}`,
          );
        }
      });
    });

    // -- Skill discovery (#GH-38) --
    // Constructed late only because it needs `userData` (defined at the top
    // of this try). Doesn't depend on any other store; failure here just
    // means SkillFinder stays null and the find-skills handler surfaces
    // NOT_INITIALIZED to the renderer.
    const finder = new SkillFinder({
      spawner: new NodeSpawner(),
      cwd: userData,
    });
    finder.on('output', (e: FinderOutputEvent) => {
      broadcastToWindows(IPC_CHANNELS.SKILLS_FIND_OUTPUT, toIpcFindOutputEvent(e));
    });
    finder.on('exit', (e: FinderExitEvent) => {
      broadcastToWindows(IPC_CHANNELS.SKILLS_FIND_EXIT, toIpcFindExitEvent(e));
    });
    skillFinder = finder;
  } catch (err) {

    console.error('[main] store initialization threw:', err);
  }
}

/**
 * Dev-mode sync of the bundled ef-auto-feature skill into the user's home
 * directory. See `skill-installer.ts` for rationale. Runs on every app
 * start; the installer is a no-op when contents already match.
 *
 * Source path resolution:
 *   - In dev mode, the main process runs from `out/main/index.js` and
 *     `process.cwd()` is the repo root (where `npm run dev` was
 *     invoked), so `<cwd>/.claude/skills/ef-auto-feature/SKILL.md` is the
 *     right path.
 *   - In packaged builds, that path doesn't exist and the installer
 *     returns `source-missing` — which we log at info level and move
 *     on. Production bundling is a future TODO (electron-builder
 *     `extraResources` to ship the skill at `process.resourcesPath`).
 */
async function syncBundledSkill(): Promise<void> {
  const sourcePath = join(process.cwd(), '.claude', 'skills', 'ef-auto-feature', 'SKILL.md');
  const result = await installEfAutoFeatureSkill({ sourcePath });
  switch (result.status) {
    case 'installed':
      console.log(
        `[skill-installer] installed ef-auto-feature skill at ${result.destPath}`,
      );
      return;
    case 'updated':
      console.log(
        `[skill-installer] updated ef-auto-feature skill at ${result.destPath}`,
      );
      return;
    case 'unchanged':
      // Quiet — happens on every restart while the skill is stable.
      return;
    case 'source-missing':
      console.log(
        `[skill-installer] bundled skill not found at ${result.sourcePath}; ` +
          `running in production mode? (skip)`,
      );
      return;
    case 'io-failure':
      console.warn(
        `[skill-installer] failed to sync ef-auto-feature skill: ${result.error ?? 'unknown error'}`,
      );
      return;
  }
}

app.whenReady().then(async () => {
  // Rebrand from `e-frank` → `Paperplane` (#GH-51) shifted the userData path.
  // Run a one-shot copy of any legacy `e-frank` userData into the new dir
  // BEFORE any store reads — otherwise existing users would see an empty app.
  // The migration is idempotent + non-fatal; failures are logged and boot
  // continues with whatever copied successfully.
  const newUserDataDir = app.getPath('userData');
  const legacyUserDataDir = join(app.getPath('appData'), 'e-frank');
  const migration = await migrateUserData({ newUserDataDir, legacyUserDataDir });
  console.log('[migrate-userdata]', migration);
  await initStores();
  await syncBundledSkill();
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
