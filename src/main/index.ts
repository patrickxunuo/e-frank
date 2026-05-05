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
} from '../shared/ipc.js';
import { handlePing } from './ping-handler.js';
import {
  ClaudeProcessManager,
  type OutputEvent,
  type ExitEvent,
} from './modules/claude-process-manager.js';
import { NodeSpawner } from './modules/spawner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let mainWindow: BrowserWindow | null = null;

const claudeManager = new ClaudeProcessManager({ spawner: new NodeSpawner() });

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

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.PING, (_event, req) => {
    return handlePing(req);
  });

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
}

app.whenReady().then(() => {
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
