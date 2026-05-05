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
  type ProjectInstanceDto,
  type ProjectsGetRequest,
  type ProjectsCreateRequest,
  type ProjectsUpdateRequest,
  type ProjectsDeleteRequest,
  type SecretsSetRequest,
  type SecretsGetRequest,
  type SecretsGetResponse,
  type SecretsDeleteRequest,
  type SecretsListResponse,
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

  projects: {
    list: (): Promise<IpcResult<ProjectInstanceDto[]>> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECTS_LIST) as Promise<IpcResult<ProjectInstanceDto[]>>,

    get: (req: ProjectsGetRequest): Promise<IpcResult<ProjectInstanceDto>> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECTS_GET, req) as Promise<
        IpcResult<ProjectInstanceDto>
      >,

    create: (req: ProjectsCreateRequest): Promise<IpcResult<ProjectInstanceDto>> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECTS_CREATE, req) as Promise<
        IpcResult<ProjectInstanceDto>
      >,

    update: (req: ProjectsUpdateRequest): Promise<IpcResult<ProjectInstanceDto>> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECTS_UPDATE, req) as Promise<
        IpcResult<ProjectInstanceDto>
      >,

    delete: (req: ProjectsDeleteRequest): Promise<IpcResult<{ id: string }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECTS_DELETE, req) as Promise<
        IpcResult<{ id: string }>
      >,
  },

  secrets: {
    set: (req: SecretsSetRequest): Promise<IpcResult<{ ref: string }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETS_SET, req) as Promise<IpcResult<{ ref: string }>>,

    get: (req: SecretsGetRequest): Promise<IpcResult<SecretsGetResponse>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETS_GET, req) as Promise<
        IpcResult<SecretsGetResponse>
      >,

    delete: (req: SecretsDeleteRequest): Promise<IpcResult<{ ref: string }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETS_DELETE, req) as Promise<
        IpcResult<{ ref: string }>
      >,

    list: (): Promise<IpcResult<SecretsListResponse>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SECRETS_LIST) as Promise<IpcResult<SecretsListResponse>>,
  },
};

contextBridge.exposeInMainWorld('api', api);
