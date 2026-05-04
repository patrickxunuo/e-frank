# e-frank

Desktop AI Ticket → PR Automation. e-frank is a desktop application that
converts tickets (Jira / GitHub Issues) into working code and pull requests
using Claude Code, with optional human approval. It is built for solo
developers and power users who already work with Git, Jira/GitHub Issues, and
Claude Code custom skills (e.g. `ef-feature`).

## Tech stack

- Electron (main + preload) with a React 18 + TypeScript renderer
- `electron-vite` for dev/build with HMR
- `electron-builder` for packaging (Windows `nsis`, macOS `dmg`)
- Vitest for unit tests, Playwright for E2E

## Prerequisites

- Node.js **20+**
- npm (bundled with Node)
- macOS or Windows 10/11

## Install

```bash
npm install
```

## Develop

Launches Electron with hot-reloaded renderer.

```bash
npm run dev
```

## Test

```bash
npm test            # alias for vitest run
npm run test:unit   # unit tests via Vitest
npm run test:e2e    # Playwright E2E (placeholder for the scaffold)
```

## Lint, format, typecheck

```bash
npm run lint
npm run format
npm run typecheck
```

## Build

Compiles main, preload, and renderer into `out/`.

```bash
npm run build
```

## Package

Produces installers under `release/${version}/`.

```bash
npm run dist        # current platform
npm run dist:win    # Windows nsis
npm run dist:mac    # macOS dmg
```

## Project layout

```
src/
  main/       # Electron main process (Node.js)
  preload/    # contextBridge that exposes window.api
  renderer/   # React UI
  shared/     # Cross-process types & constants (IPC contract lives here)
tests/
  unit/       # Vitest
  e2e/        # Playwright
```

The IPC contract (channel names + payload types) is the single source of truth
between the main process and the renderer; see
[`src/shared/ipc.ts`](src/shared/ipc.ts).
