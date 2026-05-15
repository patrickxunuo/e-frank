import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC_CHANNELS,
  type IpcApi,
  type IpcResult,
  type PingRequest,
  type PingResponse,
  type AppInfoResponse,
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
  type JiraListRequest,
  type JiraListResponse,
  type JiraRefreshRequest,
  type JiraRefreshResponse,
  type JiraTestConnectionRequest,
  type JiraTestConnectionResponse,
  type JiraTicketsChangedEvent,
  type JiraErrorEvent,
  type RunsStartRequest,
  type RunsStartResponse,
  type RunsCancelRequest,
  type RunsApproveRequest,
  type RunsRejectRequest,
  type RunsModifyRequest,
  type RunsCurrentResponse,
  type RunsListActiveResponse,
  type RunsListHistoryRequest,
  type RunsListHistoryResponse,
  type RunsDeleteRequest,
  type RunsDeleteResponse,
  type RunsReadLogRequest,
  type RunsReadLogResponse,
  type TicketsListRequest,
  type TicketsListResponse,
  type PullsListRequest,
  type PullsListResponse,
  type RunsCurrentChangedEvent,
  type RunsListChangedEvent,
  type RunStateEvent,
  type Connection,
  type ConnectionsGetRequest,
  type ConnectionsCreateRequest,
  type ConnectionsUpdateRequest,
  type ConnectionsDeleteRequest,
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
  type ChromeStateChangedEvent,
  type SkillsListResponse,
  type SkillsInstallRequest,
  type SkillsInstallResponse,
  type SkillsRemoveRequest,
  type SkillsRemoveResponse,
  type SkillsFindStartRequest,
  type SkillsFindStartResponse,
  type SkillsFindCancelRequest,
  type SkillsFindOutputEvent,
  type SkillsFindExitEvent,
  type ShellOpenExternalRequest,
  type ShellOpenPathRequest,
  type AppConfigGetResponse,
  type AppConfigSetRequest,
  type ClaudeCliProbeResponse,
  type ClaudeCliProbeOverrideRequest,
  type ClaudeCliProbeOverrideResponse,
  type AppConfigSetResponse,
} from '../shared/ipc.js';

const api: IpcApi = {
  ping: (req: PingRequest): Promise<PingResponse> =>
    ipcRenderer.invoke(IPC_CHANNELS.PING, req) as Promise<PingResponse>,

  app: {
    info: (): Promise<IpcResult<AppInfoResponse>> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_INFO) as Promise<IpcResult<AppInfoResponse>>,
  },

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

  jira: {
    list: (req: JiraListRequest): Promise<IpcResult<JiraListResponse>> =>
      ipcRenderer.invoke(IPC_CHANNELS.JIRA_LIST, req) as Promise<IpcResult<JiraListResponse>>,

    refresh: (req: JiraRefreshRequest): Promise<IpcResult<JiraRefreshResponse>> =>
      ipcRenderer.invoke(IPC_CHANNELS.JIRA_REFRESH, req) as Promise<
        IpcResult<JiraRefreshResponse>
      >,

    testConnection: (
      req: JiraTestConnectionRequest,
    ): Promise<IpcResult<JiraTestConnectionResponse>> =>
      ipcRenderer.invoke(IPC_CHANNELS.JIRA_TEST_CONNECTION, req) as Promise<
        IpcResult<JiraTestConnectionResponse>
      >,

    refreshPollers: (): Promise<IpcResult<{ projectIds: string[] }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.JIRA_REFRESH_POLLERS) as Promise<
        IpcResult<{ projectIds: string[] }>
      >,

    onTicketsChanged: (listener: (e: JiraTicketsChangedEvent) => void): (() => void) => {
      // Strip the IpcRendererEvent first arg before invoking the user's
      // listener — renderer code must never see Electron-specific types.
      const wrapped = (
        _event: IpcRendererEvent,
        payload: JiraTicketsChangedEvent,
      ): void => {
        listener(payload);
      };
      ipcRenderer.on(IPC_CHANNELS.JIRA_TICKETS_CHANGED, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.JIRA_TICKETS_CHANGED, wrapped);
      };
    },

    onError: (listener: (e: JiraErrorEvent) => void): (() => void) => {
      const wrapped = (_event: IpcRendererEvent, payload: JiraErrorEvent): void => {
        listener(payload);
      };
      ipcRenderer.on(IPC_CHANNELS.JIRA_ERROR, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.JIRA_ERROR, wrapped);
      };
    },
  },

  connections: {
    list: (): Promise<IpcResult<Connection[]>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONNECTIONS_LIST) as Promise<IpcResult<Connection[]>>,

    get: (req: ConnectionsGetRequest): Promise<IpcResult<Connection>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONNECTIONS_GET, req) as Promise<IpcResult<Connection>>,

    create: (req: ConnectionsCreateRequest): Promise<IpcResult<Connection>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONNECTIONS_CREATE, req) as Promise<IpcResult<Connection>>,

    update: (req: ConnectionsUpdateRequest): Promise<IpcResult<Connection>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONNECTIONS_UPDATE, req) as Promise<IpcResult<Connection>>,

    delete: (req: ConnectionsDeleteRequest): Promise<IpcResult<{ id: string }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONNECTIONS_DELETE, req) as Promise<
        IpcResult<{ id: string }>
      >,

    test: (req: ConnectionsTestRequest): Promise<IpcResult<ConnectionsTestResponse>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONNECTIONS_TEST, req) as Promise<
        IpcResult<ConnectionsTestResponse>
      >,

    listRepos: (
      req: ConnectionsListReposRequest,
    ): Promise<IpcResult<ConnectionsListReposResponse>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONNECTIONS_LIST_REPOS, req) as Promise<
        IpcResult<ConnectionsListReposResponse>
      >,

    listJiraProjects: (
      req: ConnectionsListJiraProjectsRequest,
    ): Promise<IpcResult<ConnectionsListJiraProjectsResponse>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONNECTIONS_LIST_JIRA_PROJECTS, req) as Promise<
        IpcResult<ConnectionsListJiraProjectsResponse>
      >,

    listBranches: (
      req: ConnectionsListBranchesRequest,
    ): Promise<IpcResult<ConnectionsListBranchesResponse>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CONNECTIONS_LIST_BRANCHES, req) as Promise<
        IpcResult<ConnectionsListBranchesResponse>
      >,
  },

  dialog: {
    selectFolder: (
      req: DialogSelectFolderRequest,
    ): Promise<IpcResult<DialogSelectFolderResponse>> =>
      ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_FOLDER, req) as Promise<
        IpcResult<DialogSelectFolderResponse>
      >,
  },

  runs: {
    start: (req: RunsStartRequest): Promise<IpcResult<RunsStartResponse>> =>
      ipcRenderer.invoke(IPC_CHANNELS.RUNS_START, req) as Promise<
        IpcResult<RunsStartResponse>
      >,

    cancel: (req: RunsCancelRequest): Promise<IpcResult<{ runId: string }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.RUNS_CANCEL, req) as Promise<
        IpcResult<{ runId: string }>
      >,

    approve: (req: RunsApproveRequest): Promise<IpcResult<{ runId: string }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.RUNS_APPROVE, req) as Promise<
        IpcResult<{ runId: string }>
      >,

    reject: (req: RunsRejectRequest): Promise<IpcResult<{ runId: string }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.RUNS_REJECT, req) as Promise<
        IpcResult<{ runId: string }>
      >,

    modify: (req: RunsModifyRequest): Promise<IpcResult<{ runId: string }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.RUNS_MODIFY, req) as Promise<
        IpcResult<{ runId: string }>
      >,

    current: (): Promise<IpcResult<RunsCurrentResponse>> =>
      ipcRenderer.invoke(IPC_CHANNELS.RUNS_CURRENT) as Promise<
        IpcResult<RunsCurrentResponse>
      >,

    listActive: (): Promise<IpcResult<RunsListActiveResponse>> =>
      ipcRenderer.invoke(IPC_CHANNELS.RUNS_LIST_ACTIVE) as Promise<
        IpcResult<RunsListActiveResponse>
      >,

    listHistory: (
      req: RunsListHistoryRequest,
    ): Promise<IpcResult<RunsListHistoryResponse>> =>
      ipcRenderer.invoke(IPC_CHANNELS.RUNS_LIST_HISTORY, req) as Promise<
        IpcResult<RunsListHistoryResponse>
      >,

    delete: (req: RunsDeleteRequest): Promise<IpcResult<RunsDeleteResponse>> =>
      ipcRenderer.invoke(IPC_CHANNELS.RUNS_DELETE, req) as Promise<
        IpcResult<RunsDeleteResponse>
      >,

    readLog: (
      req: RunsReadLogRequest,
    ): Promise<IpcResult<RunsReadLogResponse>> =>
      ipcRenderer.invoke(IPC_CHANNELS.RUNS_READ_LOG, req) as Promise<
        IpcResult<RunsReadLogResponse>
      >,

    onCurrentChanged: (
      listener: (e: RunsCurrentChangedEvent) => void,
    ): (() => void) => {
      // Strip the IpcRendererEvent first arg before invoking the user's
      // listener — renderer code must never see Electron-specific types.
      const wrapped = (
        _event: IpcRendererEvent,
        payload: RunsCurrentChangedEvent,
      ): void => {
        listener(payload);
      };
      ipcRenderer.on(IPC_CHANNELS.RUNS_CURRENT_CHANGED, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.RUNS_CURRENT_CHANGED, wrapped);
      };
    },

    onListChanged: (
      listener: (e: RunsListChangedEvent) => void,
    ): (() => void) => {
      const wrapped = (
        _event: IpcRendererEvent,
        payload: RunsListChangedEvent,
      ): void => {
        listener(payload);
      };
      ipcRenderer.on(IPC_CHANNELS.RUNS_LIST_CHANGED, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.RUNS_LIST_CHANGED, wrapped);
      };
    },

    onStateChanged: (listener: (e: RunStateEvent) => void): (() => void) => {
      const wrapped = (_event: IpcRendererEvent, payload: RunStateEvent): void => {
        listener(payload);
      };
      ipcRenderer.on(IPC_CHANNELS.RUNS_STATE_CHANGED, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.RUNS_STATE_CHANGED, wrapped);
      };
    },
  },

  tickets: {
    list: (req: TicketsListRequest): Promise<IpcResult<TicketsListResponse>> =>
      ipcRenderer.invoke(IPC_CHANNELS.TICKETS_LIST, req) as Promise<
        IpcResult<TicketsListResponse>
      >,
  },

  pulls: {
    list: (req: PullsListRequest): Promise<IpcResult<PullsListResponse>> =>
      ipcRenderer.invoke(IPC_CHANNELS.PULLS_LIST, req) as Promise<
        IpcResult<PullsListResponse>
      >,
  },

  chrome: {
    minimize: (): Promise<IpcResult<null>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CHROME_MINIMIZE) as Promise<IpcResult<null>>,

    maximize: (): Promise<IpcResult<null>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CHROME_MAXIMIZE) as Promise<IpcResult<null>>,

    close: (): Promise<IpcResult<null>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CHROME_CLOSE) as Promise<IpcResult<null>>,

    getState: (): Promise<IpcResult<ChromeState>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CHROME_GET_STATE) as Promise<IpcResult<ChromeState>>,

    onStateChanged: (
      listener: (e: ChromeStateChangedEvent) => void,
    ): (() => void) => {
      const wrapped = (
        _event: IpcRendererEvent,
        payload: ChromeStateChangedEvent,
      ): void => {
        listener(payload);
      };
      ipcRenderer.on(IPC_CHANNELS.CHROME_STATE_CHANGED, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.CHROME_STATE_CHANGED, wrapped);
      };
    },
  },

  skills: {
    list: (): Promise<IpcResult<SkillsListResponse>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SKILLS_LIST) as Promise<IpcResult<SkillsListResponse>>,

    install: (req: SkillsInstallRequest): Promise<IpcResult<SkillsInstallResponse>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SKILLS_INSTALL, req) as Promise<
        IpcResult<SkillsInstallResponse>
      >,

    remove: (req: SkillsRemoveRequest): Promise<IpcResult<SkillsRemoveResponse>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SKILLS_REMOVE, req) as Promise<
        IpcResult<SkillsRemoveResponse>
      >,

    findStart: (req: SkillsFindStartRequest): Promise<IpcResult<SkillsFindStartResponse>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SKILLS_FIND_START, req) as Promise<
        IpcResult<SkillsFindStartResponse>
      >,

    findCancel: (
      req: SkillsFindCancelRequest,
    ): Promise<IpcResult<{ findId: string }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SKILLS_FIND_CANCEL, req) as Promise<
        IpcResult<{ findId: string }>
      >,

    onFindOutput: (
      listener: (e: SkillsFindOutputEvent) => void,
    ): (() => void) => {
      const wrapped = (
        _event: IpcRendererEvent,
        payload: SkillsFindOutputEvent,
      ): void => {
        listener(payload);
      };
      ipcRenderer.on(IPC_CHANNELS.SKILLS_FIND_OUTPUT, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.SKILLS_FIND_OUTPUT, wrapped);
      };
    },

    onFindExit: (
      listener: (e: SkillsFindExitEvent) => void,
    ): (() => void) => {
      const wrapped = (
        _event: IpcRendererEvent,
        payload: SkillsFindExitEvent,
      ): void => {
        listener(payload);
      };
      ipcRenderer.on(IPC_CHANNELS.SKILLS_FIND_EXIT, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.SKILLS_FIND_EXIT, wrapped);
      };
    },
  },

  shell: {
    openPath: (req: ShellOpenPathRequest): Promise<IpcResult<null>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SHELL_OPEN_PATH, req) as Promise<IpcResult<null>>,
    openExternal: (req: ShellOpenExternalRequest): Promise<IpcResult<null>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SHELL_OPEN_EXTERNAL, req) as Promise<IpcResult<null>>,
    openLogDirectory: (): Promise<IpcResult<null>> =>
      ipcRenderer.invoke(IPC_CHANNELS.SHELL_OPEN_LOG_DIRECTORY) as Promise<IpcResult<null>>,
  },

  appConfig: {
    get: (): Promise<IpcResult<AppConfigGetResponse>> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_CONFIG_GET) as Promise<
        IpcResult<AppConfigGetResponse>
      >,
    set: (req: AppConfigSetRequest): Promise<IpcResult<AppConfigSetResponse>> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_CONFIG_SET, req) as Promise<
        IpcResult<AppConfigSetResponse>
      >,
  },

  claudeCli: {
    probe: (): Promise<IpcResult<ClaudeCliProbeResponse>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_CLI_PROBE) as Promise<
        IpcResult<ClaudeCliProbeResponse>
      >,
    probeOverride: (
      req: ClaudeCliProbeOverrideRequest,
    ): Promise<IpcResult<ClaudeCliProbeOverrideResponse>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_CLI_PROBE_OVERRIDE, req) as Promise<
        IpcResult<ClaudeCliProbeOverrideResponse>
      >,
  },
};

contextBridge.exposeInMainWorld('api', api);
