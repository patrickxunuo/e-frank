/**
 * Shared IPC contract between the Electron main process and the React renderer.
 *
 * Channel naming convention: `<module>:<action>` (kebab-case after the colon).
 * All channel names and payload shapes MUST be declared here — no string
 * literals scattered through main/preload/renderer code.
 */

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
}
