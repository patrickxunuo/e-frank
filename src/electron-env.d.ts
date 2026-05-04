import type { IpcApi } from './shared/ipc';

declare global {
  interface Window {
    // Optional because the preload bridge may be absent in non-Electron contexts
    // (e.g. unit tests, misconfigured builds). Renderer code must guard usage.
    api?: IpcApi;
  }
}

export {};
