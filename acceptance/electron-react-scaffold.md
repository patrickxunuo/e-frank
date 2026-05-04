# Electron + React Scaffold — Acceptance Criteria

## Description (client-readable)
Bootstrap the e-frank desktop application: an Electron shell with a React+TypeScript renderer, dev tooling with hot-reload, production packaging via electron-builder, and a typed IPC channel demonstrating the main↔renderer contract. This is the foundation every subsequent feature builds on.

## Adaptation Note
This is a *scaffold* feature, not a typical API+UI feature. There are no HTTP API endpoints; the "API" is the **IPC contract** between the Electron main process and the React renderer. "Frontend tests" assert that the renderer mounts and that the IPC ping flow works end-to-end through the typed `window.api` bridge.

## Interface Contract
This is the shared agreement between the Test Writer (Agent A) and the Implementer (Agent B). Both agents receive this full spec — but not each other's code.

### Tech Stack (locked)
- **Node.js** ≥ 20 (developer machine)
- **npm** as package manager (NOT pnpm/yarn for MVP — keep tooling simple)
- **TypeScript** 5.x with `strict: true`
- **Electron** ^31 (latest stable major)
- **electron-vite** ^2 (handles main + preload + renderer with HMR)
- **React** ^18 + **react-dom** ^18
- **electron-builder** ^25 (packaging)
- **Vitest** ^2 (unit tests)
- **@playwright/test** ^1.45 (E2E config only — execution against Electron deferred)
- **ESLint** ^9 + **Prettier** ^3 (lint + format)

### Directory Structure (exact)
```
e-frank/
├── src/
│   ├── main/
│   │   └── index.ts              # main process entry
│   ├── preload/
│   │   └── index.ts              # contextBridge exposing window.api
│   ├── renderer/
│   │   ├── index.html            # vite entry HTML
│   │   ├── main.tsx              # React root
│   │   ├── App.tsx               # placeholder UI
│   │   └── App.css
│   └── shared/
│       └── ipc.ts                # typed IPC contract (channel names + types)
├── tests/
│   ├── unit/
│   │   └── (Agent A and B fill in)
│   └── e2e/
│       └── (Agent A fills in — placeholder only)
├── electron.vite.config.ts
├── playwright.config.ts
├── vitest.config.ts
├── tsconfig.json
├── tsconfig.node.json
├── .eslintrc.cjs (or eslint.config.js for flat config)
├── .prettierrc
├── electron-builder.yml
├── package.json
└── README.md (updated with dev/build/test instructions)
```

### IPC Contract (exact)

File: `src/shared/ipc.ts` — must export the following:

```ts
export const IPC_CHANNELS = {
  PING: 'app:ping',
} as const;

export type PingRequest = { message: string };
export type PingResponse = { reply: string; receivedAt: number };

export interface IpcApi {
  ping: (req: PingRequest) => Promise<PingResponse>;
}
```

**Contract:**
- Main process registers handler for `IPC_CHANNELS.PING` via `ipcMain.handle`
- Handler receives `PingRequest`, returns `PingResponse` where:
  - `reply` is `"pong: " + req.message`
  - `receivedAt` is `Date.now()` at the moment of handling (number, ms since epoch)
- Preload exposes `window.api: IpcApi` via `contextBridge.exposeInMainWorld('api', { ... })`
- Renderer calls `window.api.ping({ message: '...' })` and receives `PingResponse`
- TypeScript: renderer must have an `electron-env.d.ts` (or equivalent) that declares `window.api: IpcApi`

### Required `package.json` scripts (exact names)
```json
{
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "preview": "electron-vite preview",
    "dist": "electron-vite build && electron-builder",
    "dist:win": "electron-vite build && electron-builder --win",
    "dist:mac": "electron-vite build && electron-builder --mac",
    "test": "vitest run",
    "test:unit": "vitest run",
    "test:e2e": "playwright test",
    "lint": "eslint . --ext .ts,.tsx",
    "format": "prettier --write \"src/**/*.{ts,tsx,css,html}\"",
    "typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.node.json"
  }
}
```

### electron-builder targets (minimum)
- Windows: `nsis`
- macOS: `dmg` (config only — must not block on Windows)
- AppId: `tech.emonster.efrank`
- Product name: `e-frank`

### Renderer Placeholder UI (exact)
- Mount React in a single-page UI showing:
  - Heading: `e-frank` (with `data-testid="app-title"`)
  - Subtitle: `Desktop AI Ticket → PR Automation` (with `data-testid="app-subtitle"`)
  - A "Ping" button: `<button data-testid="ping-button">Ping</button>`
  - A status area: `<div data-testid="ping-result">{result}</div>`
  - Clicking Ping calls `window.api.ping({ message: 'hello' })` and renders `result.reply` in the status area
- Styling: minimal — system font, centered column, dark background with light text. Use CSS variables for theme tokens (defined on `:root`). Follow the systemPatterns.md convention.

## Business Rules
1. **Main process owns side effects**: filesystem, child processes, network calls happen ONLY in main. Renderer is pure UI.
2. **Renderer never accesses Node APIs**: `nodeIntegration: false`, `contextIsolation: true` on the BrowserWindow.
3. **All IPC channels are typed**: every channel name and payload shape is declared in `src/shared/ipc.ts`. No string literals scattered in code.
4. **TypeScript strict mode**: `strict: true`, `noUncheckedIndexedAccess: true` in tsconfig.
5. **No `any` in IPC types**: the IPC boundary must be fully typed.

## API Acceptance Tests (IPC contract tests)

Since this is a desktop app, there are no HTTP "API tests". The IPC contract is the closest analog. Tests below are unit/integration tests that assert the contract holds.

| ID | Scenario | Setup | Action | Expected |
|----|----------|-------|--------|----------|
| IPC-001 | IPC contract module exports correct shape | — | Import `src/shared/ipc.ts` | Module exports `IPC_CHANNELS` (const) with `PING: 'app:ping'`; exports type aliases `PingRequest`, `PingResponse`, and interface `IpcApi` |
| IPC-002 | Main process ping handler returns correct shape | Mock or extract handler from `src/main/index.ts` (or a handler module) | Call handler with `{ message: 'hello' }` | Returns `{ reply: 'pong: hello', receivedAt: <number> }` with `receivedAt` close to `Date.now()` |
| IPC-003 | Main process ping handler echoes the message | (same setup) | Call handler with `{ message: 'foo bar 123' }` | `reply === 'pong: foo bar 123'` |
| SCAFFOLD-001 | package.json has all required scripts | Read `package.json` | Parse scripts | Object contains keys: `dev`, `build`, `dist`, `test`, `test:e2e`, `lint`, `typecheck` |
| SCAFFOLD-002 | Required config files exist | — | Check filesystem | All of: `electron.vite.config.ts`, `playwright.config.ts`, `vitest.config.ts`, `tsconfig.json`, `electron-builder.yml` exist |
| SCAFFOLD-003 | TypeScript strict mode is enabled | Read `tsconfig.json` | Parse compilerOptions | `compilerOptions.strict === true` |
| SCAFFOLD-004 | electron-builder has both win and mac targets configured | Read `electron-builder.yml` | Parse YAML | Has `win` section with `nsis` target; has `mac` section with `dmg` target; `appId: tech.emonster.efrank` |

## Frontend Acceptance Tests (renderer-level)

| ID | User Action | Expected Result |
|----|------------|-----------------|
| FE-001 | Render `<App />` in jsdom (Vitest + @testing-library/react) with `window.api.ping` stubbed to resolve `{ reply: 'pong: hello', receivedAt: 0 }` | Element with `data-testid="app-title"` shows `e-frank`; `data-testid="app-subtitle"` shows the subtitle; Ping button is present |
| FE-002 | (Same setup as FE-001) Click `data-testid="ping-button"` | After promise resolution, `data-testid="ping-result"` contains the text `pong: hello` |
| FE-003 | (Same setup as FE-001 but `window.api` is undefined) Render `<App />` | App still mounts without throwing; clicking Ping shows a graceful error/disabled state in `data-testid="ping-result"` (not a crash) |

## E2E (Playwright) — Deferred
Playwright config must exist and be valid. Actual Electron-driven E2E tests are deferred to a later issue — driving Electron from Playwright is non-trivial and out of scope for the scaffold. Agent A should create one placeholder test file that asserts `1 + 1 === 2` using `@playwright/test` syntax to prove the runner is wired (test target: `chromium` browser; the test does NOT need to launch Electron).

## Test Status
- [x] IPC-001: PASS
- [x] IPC-002: PASS (incl. real-clock check)
- [x] IPC-003: PASS (incl. empty-string edge case)
- [x] SCAFFOLD-001: PASS
- [x] SCAFFOLD-002: PASS
- [x] SCAFFOLD-003: PASS
- [x] SCAFFOLD-004: PASS
- [x] FE-001: PASS
- [x] FE-002: PASS
- [x] FE-003: PASS (mount + click)
- [x] Playwright placeholder: PASS (1/1)
- [x] `npm run lint`: 0 errors, 0 warnings
- [x] `npm run typecheck`: 0 errors
- [x] `npm run build`: produces `out/main`, `out/preload`, `out/renderer` bundles cleanly

### Manual verification still required
- [ ] `npm run dev` opens an Electron window with React rendered (cannot be programmatically verified — developer must run and confirm)
- [ ] Hot reload works for renderer (manual)
- [ ] `npm run dist` produces a packaged installer (skipped in automated run; takes several minutes and produces a multi-hundred-MB binary)
