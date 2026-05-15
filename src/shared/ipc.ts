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
import type { Run, RunStateEvent, RunMode, RunLogEntry } from './schema/run.js';
import type {
  Connection,
  ConnectionInput,
  ConnectionUpdate,
  Provider,
  AuthMethod,
  ConnectionIdentity,
} from './schema/connection.js';

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
  RunLogEntry,
} from './schema/run.js';
// Re-export connection types so renderer code can import everything from
// `shared/ipc` rather than reaching into `shared/schema/connection.js`.
export type {
  Connection,
  ConnectionInput,
  ConnectionUpdate,
  ConnectionIdentity,
  Provider,
  AuthMethod,
} from './schema/connection.js';
// Re-export app-config types (#GH-69 Foundation).
export type {
  AppConfig,
  ThemeMode,
  WorkflowModeDefault,
  AppConfigValidationError,
} from './schema/app-config.js';

export const IPC_CHANNELS = {
  PING: 'app:ping',
  /** Diagnostic info: app version, build commit, platform, runtime versions (#GH-87 About). */
  APP_INFO: 'app:info',
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
  // -- Connections (issue #24) --
  CONNECTIONS_LIST: 'connections:list',
  CONNECTIONS_GET: 'connections:get',
  CONNECTIONS_CREATE: 'connections:create',
  CONNECTIONS_UPDATE: 'connections:update',
  CONNECTIONS_DELETE: 'connections:delete',
  CONNECTIONS_TEST: 'connections:test',
  // -- Connection-driven resource pickers (issue #25) --
  CONNECTIONS_LIST_REPOS: 'connections:list-repos',
  CONNECTIONS_LIST_JIRA_PROJECTS: 'connections:list-jira-projects',
  // -- Polish bundle: branches picker + folder picker (project-pickers-polish) --
  CONNECTIONS_LIST_BRANCHES: 'connections:list-branches',
  DIALOG_SELECT_FOLDER: 'dialog:select-folder',
  // -- Workflow Runner (issue #7) --
  RUNS_START: 'runs:start',
  RUNS_CANCEL: 'runs:cancel',
  RUNS_APPROVE: 'runs:approve',
  RUNS_REJECT: 'runs:reject',
  RUNS_MODIFY: 'runs:modify',
  RUNS_CURRENT: 'runs:current',
  /** Plural counterpart to RUNS_CURRENT (#GH-79). Returns `Run[]` for all
   *  in-flight runs. Renderer hooks `useGlobalActiveRuns` / `useActiveRuns`
   *  use this; legacy singular hooks still rely on RUNS_CURRENT for
   *  back-compat (returns first-of-many). */
  RUNS_LIST_ACTIVE: 'runs:list-active',
  RUNS_LIST_HISTORY: 'runs:list-history',
  RUNS_DELETE: 'runs:delete',
  RUNS_READ_LOG: 'runs:read-log',
  // -- Paginated tickets (PR #40 expansion) --
  TICKETS_LIST: 'tickets:list',
  // -- Project Pull Requests tab (issue #GH-67) --
  PULLS_LIST: 'pulls:list',
  /** event channel (main -> renderer) */
  RUNS_CURRENT_CHANGED: 'runs:current-changed',
  /** event channel (main -> renderer) — plural counterpart (#GH-79).
   *  Fires whenever the runner's active-map mutates (start, terminal). */
  RUNS_LIST_CHANGED: 'runs:list-changed',
  /** event channel (main -> renderer) */
  RUNS_STATE_CHANGED: 'runs:state-changed',
  // -- Window chrome (issue #50) -- frameless titlebar controls --
  CHROME_MINIMIZE: 'chrome:minimize',
  CHROME_MAXIMIZE: 'chrome:maximize',
  CHROME_CLOSE: 'chrome:close',
  CHROME_GET_STATE: 'chrome:get-state',
  /** event channel (main -> renderer) */
  CHROME_STATE_CHANGED: 'chrome:state-changed',
  // -- Skill management (issue #GH-38) -- discover, install, list, remove --
  SKILLS_LIST: 'skills:list',
  SKILLS_INSTALL: 'skills:install',
  SKILLS_REMOVE: 'skills:remove',
  SKILLS_FIND_START: 'skills:find-start',
  SKILLS_FIND_CANCEL: 'skills:find-cancel',
  /** event channel (main -> renderer) */
  SKILLS_FIND_OUTPUT: 'skills:find-output',
  /** event channel (main -> renderer) */
  SKILLS_FIND_EXIT: 'skills:find-exit',
  // -- Shell open-path (issue #GH-38 companion) --
  SHELL_OPEN_PATH: 'shell:open-path',
  /** Open a URL in the default browser. Host allow-list enforced in main. */
  SHELL_OPEN_EXTERNAL: 'shell:open-external',
  /**
   * Open the per-user run-log directory (`<userData>/runs/`) in the OS
   * file manager (#GH-87 About). No path argument — main resolves the
   * fixed path itself, so the blast radius stays smaller than extending
   * the `SHELL_OPEN_PATH` allow-list.
   */
  SHELL_OPEN_LOG_DIRECTORY: 'shell:open-log-directory',
  // -- App config (issue #GH-69 Foundation) --
  APP_CONFIG_GET: 'app-config:get',
  APP_CONFIG_SET: 'app-config:set',
  // -- Claude CLI probe (issue #GH-85 Settings → Claude CLI section) --
  /** Probe the resolved Claude CLI path + version. Uses `appConfig.
   *  claudeCliPath` if set, else PATH lookup via `where`/`which`. */
  CLAUDE_CLI_PROBE: 'claude-cli:probe',
  /** Validate an override path without persisting. Returns the same
   *  shape as `probe`; failed validation surfaces a specific error code
   *  (`PATH_NOT_FOUND` / `NOT_EXECUTABLE` / `NOT_CLAUDE`). */
  CLAUDE_CLI_PROBE_OVERRIDE: 'claude-cli:probe-override',
} as const;

export type PingRequest = { message: string };
export type PingResponse = { reply: string; receivedAt: number };

/**
 * Diagnostic snapshot returned by `app:info` (#GH-87 About section).
 * Read-only at runtime — version + buildCommit are baked at build time
 * via Vite `define`; the rest are resolved by main from `os` + `process.versions`.
 */
export interface AppInfoResponse {
  /** From `package.json.version`, baked into the binary at build time. */
  appVersion: string;
  /** Short git SHA from `BUILD_COMMIT` env var; `'dev'` for local builds. */
  buildCommit: string;
  /** `process.platform` — e.g. `'darwin'`, `'win32'`, `'linux'`. */
  platform: string;
  /** `os.release()` — e.g. `'23.6.0'` (Darwin), `'10.0.19045'` (Windows). */
  release: string;
  electronVersion: string;
  nodeVersion: string;
  chromeVersion: string;
}

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

// -- Paginated tickets IPC payloads (PR #40 expansion) -----------------------
//
// Server-side pagination + sort + search. Replaces the cache-backed
// `jira.list` for the main ticket grid. The poller keeps its `fetchTickets`
// pathway for diff detection / eligibility caching, but the renderer no
// longer subscribes to those cached snapshots.
//
// `cursor` is opaque to the renderer — Jira encodes `startAt`, GitHub
// encodes `page`. The renderer just round-trips whatever `nextCursor` came
// back on the previous page. `nextCursor === undefined` means no more rows.

export type TicketsSortBy = 'id' | 'priority';
export type TicketsSortDir = 'asc' | 'desc';

export interface TicketsListRequest {
  projectId: string;
  /** Opaque cursor from the previous page's `nextCursor`. Omit for first page. */
  cursor?: string;
  /** Page size. Renderer requests 20; main may cap at the source's max. */
  limit: number;
  /** Default 'priority' for Jira, 'id' for GitHub (priority not supported there). */
  sortBy?: TicketsSortBy;
  sortDir?: TicketsSortDir;
  /**
   * Free-text search. Jira routes this through JQL `text ~ "query*"`.
   * GitHub source ignores it (server-side search isn't supported for the
   * repo-issues endpoint and the renderer hides the input there).
   */
  search?: string;
}

export interface TicketsListResponse {
  rows: TicketDto[];
  /** Undefined when there are no more pages. */
  nextCursor?: string;
}

// -- Project Pull Requests IPC payloads (issue #GH-67) -----------------------
//
// Renderer-facing record for one GitHub pull request on the project's repo.
// State and review-state are derived in the main process from the GraphQL
// fields so the renderer never has to reach into raw GitHub responses (which
// would mean re-encoding the GraphQL → enum mapping per consumer).

/**
 * High-level state derived from `state` + `isDraft` + `mergedAt`. Drives the
 * State badge column in the PRs tab.
 *  - `open`     → PR is open and ready for review
 *  - `draft`    → PR is open but marked as draft
 *  - `merged`   → PR was merged
 *  - `closed`   → PR was closed without merging
 */
export type PullState = 'open' | 'draft' | 'merged' | 'closed';

/**
 * Review decision from GitHub's GraphQL `reviewDecision` field, narrowed to
 * the values that have a meaningful UI representation. `null` (no review
 * requested yet) is preserved as `null` rather than collapsed so the renderer
 * can show an em-dash placeholder.
 */
export type PullReviewDecision = 'approved' | 'changes_requested' | 'review_required' | null;

export interface PullDto {
  /** PR number — `#42` displayed in the leftmost column. */
  number: number;
  title: string;
  /** GitHub login of the PR author. `null` for deleted accounts / Dependabot edge cases. */
  authorLogin: string | null;
  state: PullState;
  reviewDecision: PullReviewDecision;
  /** ISO-8601 timestamp of the most recent update — drives the Updated column + sort. */
  updatedAt: string;
  /** Direct link to the PR on github.com — opened via `shell.openExternal` on row click. */
  url: string;
}

export interface PullsListRequest {
  projectId: string;
}

export interface PullsListResponse {
  rows: PullDto[];
}

// -- App Config IPC payloads (#GH-69 Foundation) ----------------------------

export interface AppConfigGetResponse {
  config: import('./schema/app-config.js').AppConfig;
}

export interface AppConfigSetRequest {
  /** Shallow-merged into the existing config. Empty object is a valid no-op. */
  partial: Partial<import('./schema/app-config.js').AppConfig>;
}

export interface AppConfigSetResponse {
  /** Post-merge full config. */
  config: import('./schema/app-config.js').AppConfig;
}

// -- Claude CLI probe IPC payloads (#GH-85 Settings → Claude CLI section) --

/** Where the resolved Claude CLI path came from. */
export type ClaudeCliSource = 'override' | 'path' | 'not-found';

export interface ClaudeCliProbeResponse {
  /** Absolute path to the Claude binary; `null` only when source = 'not-found'. */
  resolvedPath: string | null;
  /** Trimmed `--version` stdout. `null` if probe failed or output was empty. */
  version: string | null;
  /** `override` if the user has set `appConfig.claudeCliPath`; `path` if
   *  discovered via the OS PATH lookup; `not-found` if neither succeeded. */
  source: ClaudeCliSource;
}

export interface ClaudeCliProbeOverrideRequest {
  /** Candidate override path to validate. Not persisted. */
  path: string;
}

export interface ClaudeCliProbeOverrideResponse {
  resolvedPath: string;
  version: string;
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

/**
 * Plural counterpart to `RunsCurrentResponse` (#GH-79). Returns every
 * in-flight run; an empty array means the runner is idle.
 */
export interface RunsListActiveResponse {
  runs: Run[];
}

export interface RunsListHistoryRequest {
  projectId: string;
  /** Defaults to 50 in the runner; renderer may pass a smaller cap. */
  limit?: number;
}

export interface RunsListHistoryResponse {
  runs: Run[];
}

export interface RunsDeleteRequest {
  runId: string;
}

export interface RunsDeleteResponse {
  runId: string;
}

export interface RunsReadLogRequest {
  runId: string;
}

export interface RunsReadLogResponse {
  entries: RunLogEntry[];
}

/** Event payload broadcast on `RUNS_CURRENT_CHANGED`. */
export interface RunsCurrentChangedEvent {
  /** `null` indicates the runner has gone idle. */
  run: Run | null;
}

/**
 * Event payload broadcast on `RUNS_LIST_CHANGED` (#GH-79). Fires whenever
 * the active-runs set mutates (a start, or a terminal). Empty array means
 * the runner is fully idle.
 */
export interface RunsListChangedEvent {
  runs: Run[];
}

// -- Connections IPC payloads -------------------------------------------------

export interface ConnectionsGetRequest {
  id: string;
}
export interface ConnectionsCreateRequest {
  input: ConnectionInput;
}
export interface ConnectionsUpdateRequest {
  id: string;
  input: ConnectionUpdate;
}
export interface ConnectionsDeleteRequest {
  id: string;
}

/**
 * Test an existing connection by id (read creds from SecretsManager) OR
 * test pre-save creds before persisting.
 */
export type ConnectionsTestRequest =
  | { mode: 'existing'; id: string }
  | {
      mode: 'preview';
      provider: Provider;
      host: string;
      authMethod: AuthMethod;
      plaintextToken: string;
      email?: string;
    };

export interface ConnectionsTestResponse {
  identity: ConnectionIdentity;
  /** Echoed back so the dialog can update its UI even before the connection is saved. */
  verifiedAt: number;
}

// -- Connection-driven resource pickers (issue #25) --

export interface ConnectionsListReposRequest {
  connectionId: string;
}
export interface ConnectionsListReposResponse {
  repos: Array<{ slug: string; defaultBranch: string; private: boolean }>;
}

export interface ConnectionsListJiraProjectsRequest {
  connectionId: string;
}
export interface ConnectionsListJiraProjectsResponse {
  projects: Array<{ key: string; name: string }>;
}

export interface ConnectionsListBranchesRequest {
  connectionId: string;
  /** Repo slug, e.g. "owner/name". */
  slug: string;
}
export interface ConnectionsListBranchesResponse {
  branches: Array<{ name: string; protected: boolean }>;
}

// -- Window chrome (issue #50) -----------------------------------------------
//
// The renderer owns a custom 32px titlebar with min/max/close controls; the
// main process owns the actual `BrowserWindow` operations. The handlers
// below operate on the BrowserWindow that owns the IPC sender's webContents,
// so multiple windows (future) work without coordination.

/**
 * Snapshot of the host BrowserWindow's chrome-relevant flags. `platform` is
 * exposed so the renderer can branch on traffic-light vs custom-controls
 * layout without reaching into Electron APIs.
 */
export interface ChromeState {
  isMaximized: boolean;
  /** `process.platform` value at app start. */
  platform: 'darwin' | 'win32' | 'linux' | string;
}

/** Event payload broadcast on `CHROME_STATE_CHANGED`. */
export interface ChromeStateChangedEvent {
  isMaximized: boolean;
}

// -- Skill management IPC payloads (issue #GH-38) ----------------------------
//
// `SkillSummary` is the renderer-facing record for one installed skill.
// Source enum is `'user' | 'project'`: `user` = `~/.claude/skills/<id>/`,
// `project` = `<projectRoot>/.claude/skills/<id>/`. When the same id exists
// in both, `project` wins (scanner dedupes that way, matching Claude's own
// resolution order — see `skill-installer.ts` module docstring).

export type SkillSource = 'user' | 'project';

export interface SkillSummary {
  /** Folder slug (kebab — `ef-auto-feature`, `find-skills`, etc.). */
  id: string;
  /** Display name from SKILL.md frontmatter `name:` (falls back to id). */
  name: string;
  /** Description from SKILL.md frontmatter `description:` (may be empty). */
  description: string;
  source: SkillSource;
  /** Absolute path to the skill's directory (parent of SKILL.md). */
  dirPath: string;
  /** Absolute path to the SKILL.md file itself. */
  skillMdPath: string;
}

export interface SkillsListResponse {
  skills: SkillSummary[];
}

export type SkillInstallStatus = 'installed' | 'failed';

export interface SkillsInstallRequest {
  /** Bare skill name, `<owner>/<name>`, or `@scope/<name>` reference.
   * Validated against `^[a-zA-Z0-9@][\w./@-]+$` in the main process —
   * anything else returns an `INVALID_REF` error without spawning. The
   * leading `@` opens the door to scoped-npm-package refs the way `npx
   * skills add @org/skill` expects them. */
  ref: string;
}

export interface SkillsInstallResponse {
  status: SkillInstallStatus;
  /** Last ~4KB of stdout, useful for surfacing why install failed. */
  stdout: string;
  /** Last ~4KB of stderr. */
  stderr: string;
  exitCode: number | null;
}

export interface SkillsRemoveRequest {
  /** Skill reference to remove. Same regex validation as install. */
  ref: string;
}

export interface SkillsRemoveResponse {
  /** `'installed'` on the underlying union reads as "the npm op succeeded";
   * the Skills page renders the right verb based on which IPC was called. */
  status: SkillInstallStatus;
  /** Last ~4KB of stdout. */
  stdout: string;
  /** Last ~4KB of stderr. */
  stderr: string;
  exitCode: number | null;
}

export interface SkillsFindStartRequest {
  /** User's natural-language search query. */
  query: string;
}

export interface SkillsFindStartResponse {
  /** Opaque id renderers use to correlate stream events with this find. */
  findId: string;
  pid: number | undefined;
  startedAt: number;
}

export interface SkillsFindCancelRequest {
  findId: string;
}

export interface SkillsFindOutputEvent {
  findId: string;
  stream: 'stdout' | 'stderr';
  line: string;
  timestamp: number;
}

export interface SkillsFindExitEvent {
  findId: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  reason: 'completed' | 'cancelled' | 'error';
}

// -- Shell open-path (companion to skills feature) ---------------------------

export interface ShellOpenPathRequest {
  /** Absolute path to open in the OS file manager. */
  path: string;
}

export interface ShellOpenExternalRequest {
  /**
   * Fully-qualified `http://` or `https://` URL to open in the default
   * browser. Main-process handler enforces a hostname allow-list to
   * defend against `javascript:` / `file://` injection from a
   * compromised renderer.
   */
  url: string;
}

// -- Folder picker (Electron native dialog) ----------------------------------

export interface DialogSelectFolderRequest {
  /** Optional starting directory; falls back to OS default. */
  defaultPath?: string;
  /** Window title for the OS dialog. */
  title?: string;
}
export interface DialogSelectFolderResponse {
  /** `null` when the user cancels. */
  path: string | null;
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
  /**
   * `app.info()` — diagnostic snapshot for the Settings About section
   * (#GH-87). Read-only; no params; one round-trip returns everything.
   */
  app: {
    info: () => Promise<IpcResult<AppInfoResponse>>;
  };
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
  connections: {
    list: () => Promise<IpcResult<Connection[]>>;
    get: (req: ConnectionsGetRequest) => Promise<IpcResult<Connection>>;
    create: (req: ConnectionsCreateRequest) => Promise<IpcResult<Connection>>;
    update: (req: ConnectionsUpdateRequest) => Promise<IpcResult<Connection>>;
    delete: (req: ConnectionsDeleteRequest) => Promise<IpcResult<{ id: string }>>;
    test: (req: ConnectionsTestRequest) => Promise<IpcResult<ConnectionsTestResponse>>;
    listRepos: (
      req: ConnectionsListReposRequest,
    ) => Promise<IpcResult<ConnectionsListReposResponse>>;
    listJiraProjects: (
      req: ConnectionsListJiraProjectsRequest,
    ) => Promise<IpcResult<ConnectionsListJiraProjectsResponse>>;
    listBranches: (
      req: ConnectionsListBranchesRequest,
    ) => Promise<IpcResult<ConnectionsListBranchesResponse>>;
  };
  dialog: {
    selectFolder: (
      req: DialogSelectFolderRequest,
    ) => Promise<IpcResult<DialogSelectFolderResponse>>;
  };
  runs: {
    start: (req: RunsStartRequest) => Promise<IpcResult<RunsStartResponse>>;
    cancel: (req: RunsCancelRequest) => Promise<IpcResult<{ runId: string }>>;
    approve: (req: RunsApproveRequest) => Promise<IpcResult<{ runId: string }>>;
    reject: (req: RunsRejectRequest) => Promise<IpcResult<{ runId: string }>>;
    modify: (req: RunsModifyRequest) => Promise<IpcResult<{ runId: string }>>;
    current: () => Promise<IpcResult<RunsCurrentResponse>>;
    /**
     * Plural counterpart to `current()` (#GH-79). Returns every in-flight
     * run. Used by `useGlobalActiveRuns` / `useActiveRuns(projectId)`.
     * Legacy `current()` still works for callers that only need one.
     */
    listActive: () => Promise<IpcResult<RunsListActiveResponse>>;
    listHistory: (
      req: RunsListHistoryRequest,
    ) => Promise<IpcResult<RunsListHistoryResponse>>;
    delete: (req: RunsDeleteRequest) => Promise<IpcResult<RunsDeleteResponse>>;
    readLog: (req: RunsReadLogRequest) => Promise<IpcResult<RunsReadLogResponse>>;
    /** Subscribe to current-changed events (run starts / advances / completes). Returns unsubscribe fn. */
    onCurrentChanged: (listener: (e: RunsCurrentChangedEvent) => void) => () => void;
    /** Plural counterpart to `onCurrentChanged` (#GH-79). Fires whenever the active-set mutates. */
    onListChanged: (listener: (e: RunsListChangedEvent) => void) => () => void;
    /** Subscribe to fine-grained state-changed events (every state entry/exit). Returns unsubscribe fn. */
    onStateChanged: (listener: (e: RunStateEvent) => void) => () => void;
  };
  tickets: {
    list: (req: TicketsListRequest) => Promise<IpcResult<TicketsListResponse>>;
  };
  pulls: {
    list: (req: PullsListRequest) => Promise<IpcResult<PullsListResponse>>;
  };
  chrome: {
    minimize: () => Promise<IpcResult<null>>;
    maximize: () => Promise<IpcResult<null>>;
    close: () => Promise<IpcResult<null>>;
    getState: () => Promise<IpcResult<ChromeState>>;
    /** Subscribe to maximize/unmaximize events. Returns unsubscribe fn. */
    onStateChanged: (listener: (e: ChromeStateChangedEvent) => void) => () => void;
  };
  skills: {
    list: () => Promise<IpcResult<SkillsListResponse>>;
    install: (req: SkillsInstallRequest) => Promise<IpcResult<SkillsInstallResponse>>;
    remove: (req: SkillsRemoveRequest) => Promise<IpcResult<SkillsRemoveResponse>>;
    findStart: (req: SkillsFindStartRequest) => Promise<IpcResult<SkillsFindStartResponse>>;
    findCancel: (req: SkillsFindCancelRequest) => Promise<IpcResult<{ findId: string }>>;
    /** Subscribe to streaming find-skills output. Returns unsubscribe fn. */
    onFindOutput: (listener: (e: SkillsFindOutputEvent) => void) => () => void;
    /** Subscribe to find-skills exit events. Returns unsubscribe fn. */
    onFindExit: (listener: (e: SkillsFindExitEvent) => void) => () => void;
  };
  shell: {
    openPath: (req: ShellOpenPathRequest) => Promise<IpcResult<null>>;
    /**
     * Open a URL in the default browser. Renderer-facing wrapper around
     * Electron's `shell.openExternal`. Hostname must be in the main-
     * process allow-list; rejected URLs return `FORBIDDEN_URL`.
     */
    openExternal: (req: ShellOpenExternalRequest) => Promise<IpcResult<null>>;
    /**
     * Open the per-user run-log directory (`<userData>/runs/`) in the OS
     * file manager (#GH-87 About). No path argument — main resolves the
     * fixed path itself, so a compromised renderer can't pivot this into
     * "open any path I want".
     */
    openLogDirectory: () => Promise<IpcResult<null>>;
  };
  /**
   * Global app config (#GH-69 Foundation). The four content sections of
   * the Settings page (Theme / CLI / Defaults / About) read + write
   * fields via `set({ partial })`. Missing fields fall back to
   * `DEFAULT_APP_CONFIG` so a fresh install never sees null.
   */
  appConfig: {
    get: () => Promise<IpcResult<AppConfigGetResponse>>;
    set: (req: AppConfigSetRequest) => Promise<IpcResult<AppConfigSetResponse>>;
  };
  /**
   * Claude CLI discovery + override validation (#GH-85). `probe` returns
   * whichever path the runner would actually spawn (override > PATH); the
   * Settings page calls it on mount. `probeOverride` runs the validation
   * gate against a candidate path WITHOUT persisting — the renderer uses
   * the response to gate the Save button.
   */
  claudeCli: {
    probe: () => Promise<IpcResult<ClaudeCliProbeResponse>>;
    probeOverride: (
      req: ClaudeCliProbeOverrideRequest,
    ) => Promise<IpcResult<ClaudeCliProbeOverrideResponse>>;
  };
}
