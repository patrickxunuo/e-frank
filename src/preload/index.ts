import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, type IpcApi, type PingRequest, type PingResponse } from '../shared/ipc.js';

const api: IpcApi = {
  ping: (req: PingRequest): Promise<PingResponse> =>
    ipcRenderer.invoke(IPC_CHANNELS.PING, req) as Promise<PingResponse>,
};

contextBridge.exposeInMainWorld('api', api);
