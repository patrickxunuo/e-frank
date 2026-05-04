# System Patterns

## Project Structure (planned)

```
e-frank/
├── src/
│   ├── main/              # Electron main process (Node.js)
│   │   ├── index.ts       # App entry, window creation, IPC handlers
│   │   ├── ipc/           # IPC channel definitions and handlers
│   │   └── modules/       # Scheduler, GitManager, ClaudeProcessManager, etc.
│   ├── preload/           # Preload script (contextBridge to expose IPC)
│   │   └── index.ts
│   ├── renderer/          # React UI
│   │   ├── App.tsx
│   │   ├── components/
│   │   ├── views/         # Route-level views (ProjectList, ProjectDetail, ExecutionView)
│   │   └── styles/
│   └── shared/            # Types and constants shared across processes
├── tests/
│   ├── unit/              # Vitest unit/API tests
│   └── e2e/               # Playwright E2E
├── electron.vite.config.ts
├── playwright.config.ts
├── vitest.config.ts
└── package.json
```

## Naming Conventions
- Files: **kebab-case** for components and modules (`project-list.tsx`, `git-manager.ts`); **camelCase** for utility files where idiomatic
- React components: **PascalCase** for the component name and the file when it's a single-component file (`ProjectList.tsx`)
- Functions/methods: **camelCase**
- Constants: **SCREAMING_SNAKE_CASE**
- IPC channel names: **kebab-case** with module prefix (e.g. `git:checkout`, `claude:run`, `jira:poll`)

## Code Patterns

### IPC Boundary
- Renderer NEVER touches Node APIs directly
- Preload script exposes a typed `window.api` object via `contextBridge`
- Main process owns all side effects (filesystem, child processes, network)
- Channel naming: `<module>:<action>` (e.g. `git:checkout`, `tickets:list`)

### State
- Renderer state: React hooks + Context for cross-view state; no Redux unless complexity demands it
- Persistent state: JSON file under `userData` (initially); revisit if it grows

### Error Handling
- Main process wraps every IPC handler in a try/catch and returns `{ ok: true, data } | { ok: false, error }`
- Renderer never trusts main blindly — all IPC results are discriminated unions
- User-visible errors get a toast / banner; developer errors get logged to a file under `userData/logs/`

### Streaming Claude Output
- Spawn Claude as a child process with `stdio: 'pipe'`
- Forward stdout/stderr lines to renderer via a dedicated IPC event channel (`claude:output`)
- Detect approval checkpoints by parsing structured markers in Claude's output

## API Conventions (none — desktop app)
- No HTTP server in this app. The "API" is the IPC contract between main and renderer.
- External APIs (Jira, GitHub) are wrapped in dedicated client modules under `src/main/modules/`.

## UI Conventions
- Component library: **none initially** — handcrafted components, project-specific design system
- Styling: **CSS Modules** or **Tailwind** (decide in Phase 1 implementation)
- Theme: defined in CSS variables on `:root` for easy light/dark toggling later
- All interactive elements MUST have `data-testid` attributes for Playwright E2E selectors

## Known Pitfalls

### Sandbox + ESM preload incompatibility
Electron's `sandbox: true` requires the preload script to be **CommonJS** — ESM (`.mjs`) preloads silently fail to load, leaving `window.api` undefined in the renderer ("IPC bridge unavailable"). We deliberately emit the preload as `out/preload/index.cjs` via electron-vite's `formats: ['cjs']` so we can keep `sandbox: true` for defense-in-depth alongside `contextIsolation: true`. The main process path (`'../preload/index.cjs'`), the electron-vite build format, and the `sandbox: true` flag are all guarded by `tests/unit/preload-path.test.ts` — flipping any one of them in isolation will break the IPC bridge.

If you ever need to use ESM in the preload (e.g. for top-level await), you must also set `sandbox: false`. That's a real security trade-off — `contextIsolation: true` still provides the bigger isolation guarantee, but sandbox adds defense-in-depth against preload bugs that accidentally leak Node APIs.
