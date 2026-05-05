import type { IpcApi } from './shared/ipc';

declare global {
  interface Window {
    // Optional because the preload bridge may be absent in non-Electron contexts
    // (e.g. unit tests, misconfigured builds). Renderer code must guard usage.
    api?: IpcApi;
  }
}

// CSS Modules ambient declarations live in `src/renderer/css-modules.d.ts`
// (kept separate so wildcard module patterns aren't shadowed by this file's
// top-level `import type`).

export {};
