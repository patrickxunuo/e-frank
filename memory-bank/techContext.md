# Tech Context

## Repository Structure
- Type: single-repo
- Repositories:
  - **e-frank** — Electron desktop app (this repo) — `D:\e-frank` (Windows dev), `https://github.com/patrickxunuo/e-frank`

## Language & Runtime
- Language: **TypeScript** (both main process and renderer)
- Runtime: **Node.js 20+** (Electron's bundled Node), **Chromium** (Electron's bundled renderer)

## Frameworks
- Desktop shell: **Electron** (latest stable)
- Frontend: **React 18+** (renderer)
- Build tool: **Vite** (with `electron-vite` or equivalent for the main process)

## Testing
- Unit/API tests: **Vitest**
- E2E tests: **Playwright** (TypeScript) — via `@playwright/test` against the packaged or dev Electron app
- Test directory: `tests/` (top-level), with `tests/unit/` and `tests/e2e/` subfolders

## Database
- None (MVP) — use local JSON / SQLite-via-better-sqlite3 if persistence becomes needed later
- Config storage: local filesystem (per-OS app data dir via Electron `app.getPath('userData')`)

## Build & Deploy
- Package manager: **npm** (default, simplest for Electron tooling)
- Build command: `npm run build`
- Dev command: `npm run dev` (opens Electron with hot-reload renderer)
- Packaging: **electron-builder** (cross-platform: macOS dmg + Windows nsis)
- Deploy target: distributed as a packaged desktop app (no server)

## Integrations (consumed BY this app)
The app *talks to* these systems on behalf of the user. They are not the project's own PM stack.
- **Jira REST API** — ticket polling and updates (the user's Jira)
- **GitHub REST API** — PR creation, ticket comments
- **Claude Code CLI** — spawned as child process; communicates via stdio
- **Git CLI** — invoked for checkout/pull/branch/commit/push

## This project's own PM
- Issue tracker: **GitHub Issues** on `patrickxunuo/e-frank`
- Documentation: PRD lives in repo root (`prd.md`); detailed memory in `memory-bank/`
- No Jira/Confluence for our own work

## Key Dependencies (planned)
- `electron`, `electron-builder` — shell + packaging
- `vite`, `@vitejs/plugin-react`, `electron-vite` (or equivalent) — dev/build
- `react`, `react-dom`
- `@playwright/test` — E2E
- `vitest`, `@testing-library/react` — unit
- (later phases) Jira/GitHub clients, simple-git or shell-out, dotenv-style config

## Dev Environment
- Primary platform: Windows 10 (developer machine)
- Must also run on macOS (target platform parity)
- Node 20+ required
