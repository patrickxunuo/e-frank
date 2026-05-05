/**
 * Shared IPC contract between the Electron main process and the React renderer.
 *
 * Channel naming convention: `<module>:<action>` (kebab-case after the colon).
 * All channel names and payload shapes MUST be declared here — no string
 * literals scattered through main/preload/renderer code.
 */

import type {
  ProjectInstance,
  ProjectInstanceInput,
} from './schema/project-instance.js';
import type { Ticket } from './schema/ticket.js';
import type { Run, RunStateEvent, RunMode } from './schema/run.js';

/**
 * `ProjectInstanceDto` is the renderer-facing alias for the schema's
 * `ProjectInstance`. Aliased (rather than just re-exported) so renderer
 * code can import the rename from this file directly.
 */
export type ProjectInstanceDto = ProjectInstance;

/**
 * `TicketDto` is the renderer-facing alias for the schema's `Ticket`. Same
 * pattern as `ProjectInstanceDto` — keeps renderer imports stable even if we
 * later rename the schema type.
 */
export type TicketDto = Ticket;

// Re-export schema types so renderer code can import everything from
// `shared/ipc` rather than reaching into the schema folder directly.
export type {
  ProjectInstance,
  ProjectInstanceInput,
  RepoConfig,
  TicketsConfig,
  WorkflowConfig,
  ValidationError,
} from './schema/project-instance.js';
export type { Ticket } from './schema/ticket.js';
// Re-export run types so renderer code (and #4-style drift-guard tests)
// can import everything from `shared/ipc`.
export type {
  Run,
  RunMode,
  RunState,
  RunStatus,
  RunStep,
  RunStateEvent,
  ApprovalRequest,
  ApprovalResponse,
} from './schema/run.js';

export const IPC_CHANNELS = {
  PING: 'app:ping',
  CLAUDE_RUN: 'claude:run',
  CLAUDE_CANCEL: 'claude:cancel',
  CLAUDE_WRITE: 'claude:write',
  CLAUDE_STATUS: 'claude:status',
  /** event channel (main -> renderer) */
  CLAUDE_OUTPUT: 'claude:output',
  /** event channel (main -> renderer) */
  CLAUDE_EXIT: 'claude:exit',
  // -- Project store + secrets (issue #3) --
  PROJECTS_LIST: 'projects:list',
  PROJECTS_GET: 'projects:get',
  PROJECTS_CREATE: 'projects:create',
  PROJECTS_UPDATE: 'projects:update',
  PROJECTS_DELETE: 'projects:delete',
  SECRETS_SET: 'secrets:set',
  SECRETS_GET: 'secrets:get',
  SECRETS_DELETE: 'secrets:delete',
  SECRETS_LIST: 'secrets:list',
  // -- Jira poller (issue #4) --
  JIRA_LIST: 'jira:list',
  JIRA_REFRESH: 'jira:refresh',
  JIRA_TEST_CONNECTION: 'jira:test-connection',
  /** Re-syncs pollers after project create/update/delete. */
  JIRA_REFRESH_POLLERS: 'jira:refresh-pollers',
  /** event channel (main -> renderer) */
  JIRA_TICKETS_CHANGED: 'jira:tickets-changed',
  /** event channel (main -> renderer) */
  JIRA_ERROR: 'jira:error',
  // -- Workflow Runner (issue #7) --
  RUNS_START: 'runs:start',
  RUNS_CANCEL: 'runs:cancel',
  RUNS_APPROVE: 'runs:approve',
  RUNS_REJECT: 'runs:reject',
  RUNS_MODIFY: 'runs:modify',
  RUNS_CURRENT: 'runs:current',
  RUNS_LIST_HISTORY: 'runs:list-history',
  /** event channel (main -> renderer) */
  RUNS_CURRENT_CHANGED: 'runs:current-changed',
  /** event channel (main -> renderer) */
  RUNS_STATE_CHANGED: 'runs:state-changed',
} as const;

export type PingRequest = { message: string };
export type PingResponse = { reply: string; receivedAt: number };

// -- Claude Process Manager IPC payloads --------------------------------------
//
// These types are duplicated (structurally) with the manager's domain types in
// `src/main/modules/claude-process-manager.ts` on purpose: keeping `shared/ipc`
// pure (no runtime imports from main) means the renderer can import from this
// file without pulling in Node-only code. The two definitions must stay in
// sync — the manager file imports nothing from here.

export interface ClaudeRunRequest {
  ticketKey: string;
  cwd: string;
  timeoutMs?: number;
}

export interface ClaudeRunResponse {
  runId: string;
  pid: number | undefined;
  startedAt: number;
}

export interface ClaudeCancelRequest {
  runId: string;
}

export interface ClaudeWriteRequest {
  runId: string;
  text: string;
}

export interface ClaudeStatusResponse {
  active: { runId: string; pid: number | undefined; startedAt: number } | null;
}

export interface ClaudeOutputEvent {
  runId: string;
  stream: 'stdout' | 'stderr';
  line: string;
  timestamp: number;
}

export interface ClaudeExitEvent {
  runId: string;
  exitCode: number | null;
  /** NodeJS.Signals serialized as string across the IPC boundary. */
  signal: string | null;
  durationMs: number;
  reason: 'completed' | 'cancelled' | 'timeout' | 'error';
}

// -- Project store + secrets IPC payloads -------------------------------------
//
// Same duplication policy as the claude:* contracts: the schema's domain types
// are re-exported above (`ProjectInstanceDto` is the renamed re-export of the
// schema's `ProjectInstance`); the request/response wrappers below describe
// the channel-specific envelopes.

export interface ProjectsGetRequest {
  id: string;
}
export interface ProjectsCreateRequest {
  input: ProjectInstanceInput;
}
export interface ProjectsUpdateRequest {
  id: string;
  input: ProjectInstanceInput;
}
export interface ProjectsDeleteRequest {
  id: string;
}

export interface SecretsSetRequest {
  ref: string;
  plaintext: string;
}
export interface SecretsGetRequest {
  ref: string;
}
export interface SecretsGetResponse {
  plaintext: string;
}
export interface SecretsDeleteRequest {
  ref: string;
}
export interface SecretsListResponse {
  refs: string[];
}

// -- Jira poller IPC payloads -------------------------------------------------
//
// `TicketDto` is the renderer-facing alias for the schema's `Ticket`. The
// `JiraErrorEvent.code` is widened to `string` rather than the poller's
// internal union for the same reason as `IpcResult.error.code`: keeps the
// renderer uncoupled from main-process internals.

export interface JiraListRequest {
  projectId: string;
}
export interface JiraListResponse {
  tickets: TicketDto[];
}

export interface JiraRefreshRequest {
  projectId: string;
}
export interface JiraRefreshResponse {
  tickets: TicketDto[];
}

export interface JiraTestConnectionRequest {
  host: string;
  email: string;
  apiToken: string;
}
export interface JiraTestConnectionResponse {
  accountId: string;
  displayName: string;
  emailAddress: string;
}

export interface JiraTicketsChangedEvent {
  projectId: string;
  tickets: TicketDto[];
  timestamp: number;
}

export interface JiraErrorEvent {
  projectId: string;
  code: string;
  message: string;
  consecutiveErrors: number;
}

// -- Workflow Runner IPC payloads --------------------------------------------

export interface RunsStartRequest {
  projectId: string;
  ticketKey: string;
  /** Optional override; defaults to project's `workflow.mode`. */
  modeOverride?: RunMode;
}

export interface RunsStartResponse {
  run: Run;
}

export interface RunsCancelRequest {
  runId: string;
}

export interface RunsApproveRequest {
  runId: string;
}

export interface RunsRejectRequest {
  runId: string;
}

export interface RunsModifyRequest {
  runId: string;
  text: string;
}

export interface RunsCurrentResponse {
  /** `null` when there's no active run. */
  run: Run | null;
}

export interface RunsListHistoryRequest {
  projectId: string;
  /** Defaults to 50 in the runner; renderer may pass a smaller cap. */
  limit?: number;
}

export interface RunsListHistoryResponse {
  runs: Run[];
}

/** Event payload broadcast on `RUNS_CURRENT_CHANGED`. */
export interface RunsCurrentChangedEvent {
  /** `null` indicates the runner has gone idle. */
  run: Run | null;
}

/**
 * Discriminated-union result returned over IPC. `code` is a string (rather
 * than a literal-union of manager error codes) to keep the renderer
 * uncoupled from main-process internals.
 */
export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

export interface IpcApi {
  ping: (req: PingRequest) => Promise<PingResponse>;
  claude: {
    run: (req: ClaudeRunRequest) => Promise<IpcResult<ClaudeRunResponse>>;
    cancel: (req: ClaudeCancelRequest) => Promise<IpcResult<{ runId: string }>>;
    write: (req: ClaudeWriteRequest) => Promise<IpcResult<{ bytesWritten: number }>>;
    status: () => Promise<IpcResult<ClaudeStatusResponse>>;
    /** Subscribe to streaming output events. Returns unsubscribe fn. */
    onOutput: (listener: (e: ClaudeOutputEvent) => void) => () => void;
    /** Subscribe to exit events. Returns unsubscribe fn. */
    onExit: (listener: (e: ClaudeExitEvent) => void) => () => void;
  };
  projects: {
    list: () => Promise<IpcResult<ProjectInstanceDto[]>>;
    get: (req: ProjectsGetRequest) => Promise<IpcResult<ProjectInstanceDto>>;
    create: (req: ProjectsCreateRequest) => Promise<IpcResult<ProjectInstanceDto>>;
    update: (req: ProjectsUpdateRequest) => Promise<IpcResult<ProjectInstanceDto>>;
    delete: (req: ProjectsDeleteRequest) => Promise<IpcResult<{ id: string }>>;
  };
  secrets: {
    set: (req: SecretsSetRequest) => Promise<IpcResult<{ ref: string }>>;
    get: (req: SecretsGetRequest) => Promise<IpcResult<SecretsGetResponse>>;
    delete: (req: SecretsDeleteRequest) => Promise<IpcResult<{ ref: string }>>;
    list: () => Promise<IpcResult<SecretsListResponse>>;
  };
  jira: {
    list: (req: JiraListRequest) => Promise<IpcResult<JiraListResponse>>;
    refresh: (req: JiraRefreshRequest) => Promise<IpcResult<JiraRefreshResponse>>;
    testConnection: (
      req: JiraTestConnectionRequest,
    ) => Promise<IpcResult<JiraTestConnectionResponse>>;
    refreshPollers: () => Promise<IpcResult<{ projectIds: string[] }>>;
    /** Subscribe to ticket-changed events. Returns unsubscribe fn. */
    onTicketsChanged: (listener: (e: JiraTicketsChangedEvent) => void) => () => void;
    /** Subscribe to poller error events. Returns unsubscribe fn. */
    onError: (listener: (e: JiraErrorEvent) => void) => () => void;
  };
  runs: {
    start: (req: RunsStartRequest) => Promise<IpcResult<RunsStartResponse>>;
    cancel: (req: RunsCancelRequest) => Promise<IpcResult<{ runId: string }>>;
    approve: (req: RunsApproveRequest) => Promise<IpcResult<{ runId: string }>>;
    reject: (req: RunsRejectRequest) => Promise<IpcResult<{ runId: string }>>;
    modify: (req: RunsModifyRequest) => Promise<IpcResult<{ runId: string }>>;
    current: () => Promise<IpcResult<RunsCurrentResponse>>;
    listHistory: (
      req: RunsListHistoryRequest,
    ) => Promise<IpcResult<RunsListHistoryResponse>>;
    /** Subscribe to current-changed events (run starts / advances / completes). Returns unsubscribe fn. */
    onCurrentChanged: (listener: (e: RunsCurrentChangedEvent) => void) => () => void;
    /** Subscribe to fine-grained state-changed events (every state entry/exit). Returns unsubscribe fn. */
    onStateChanged: (listener: (e: RunStateEvent) => void) => () => void;
  };
}
