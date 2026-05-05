import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC_CHANNELS,
  type IpcApi,
  type IpcResult,
  type PingRequest,
  type PingResponse,
  type ClaudeRunRequest,
  type ClaudeRunResponse,
  type ClaudeCancelRequest,
  type ClaudeWriteRequest,
  type ClaudeStatusResponse,
  type ClaudeOutputEvent,
  type ClaudeExitEvent,
} from '../shared/ipc.js';

const api: IpcApi = {
  ping: (req: PingRequest): Promise<PingResponse> =>
    ipcRenderer.invoke(IPC_CHANNELS.PING, req) as Promise<PingResponse>,

  claude: {
    run: (req: ClaudeRunRequest): Promise<IpcResult<ClaudeRunResponse>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_RUN, req) as Promise<
        IpcResult<ClaudeRunResponse>
      >,

    cancel: (req: ClaudeCancelRequest): Promise<IpcResult<{ runId: string }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_CANCEL, req) as Promise<
        IpcResult<{ runId: string }>
      >,

    write: (req: ClaudeWriteRequest): Promise<IpcResult<{ bytesWritten: number }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_WRITE, req) as Promise<
        IpcResult<{ bytesWritten: number }>
      >,

    status: (): Promise<IpcResult<ClaudeStatusResponse>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_STATUS) as Promise<
        IpcResult<ClaudeStatusResponse>
      >,

    onOutput: (listener: (e: ClaudeOutputEvent) => void): (() => void) => {
      // Strip the IpcRendererEvent first arg before invoking the user's
      // listener — renderer code must never see Electron-specific types.
      const wrapped = (_event: IpcRendererEvent, payload: ClaudeOutputEvent): void => {
        listener(payload);
      };
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_OUTPUT, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_OUTPUT, wrapped);
      };
    },

    onExit: (listener: (e: ClaudeExitEvent) => void): (() => void) => {
      const wrapped = (_event: IpcRendererEvent, payload: ClaudeExitEvent): void => {
        listener(payload);
      };
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_EXIT, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_EXIT, wrapped);
      };
    },
  },
};

contextBridge.exposeInMainWorld('api', api);
