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

### Approval marker format (locked, since #7)

The Workflow Runner pauses on a single-line marker emitted by Claude
skills:

```
<<<EF_APPROVAL_REQUEST>>>{"plan":"...","filesToModify":[...],"diff":"...","options":["approve","reject"]}<<<END_EF_APPROVAL_REQUEST>>>
```

The runner parses the JSON between the markers and populates
`Run.pendingApproval`. Behaviour:

- **interactive mode**: state transitions to `awaitingApproval`; the runner
  awaits a renderer-side `approve` / `reject` / `modify` decision via the
  `runs:approve` / `runs:reject` / `runs:modify` IPC channels. On `approve`
  the runner writes `approve\n` to Claude's stdin; on `modify` it writes
  the user-supplied text + `\n`; on `reject` it cancels the run.
- **yolo mode**: the runner writes `approve\n` to stdin immediately and
  never enters `awaitingApproval`.
- **malformed JSON**: logged at warn level and treated as regular output;
  the runner does NOT pause.

The `<<<EF_APPROVAL_REQUEST>>>` and `<<<END_EF_APPROVAL_REQUEST>>>`
sentinels are deliberately verbose so they can't collide with normal
program output. Claude skill authors and #9 (UI) agree on this format —
do not change it without bumping a marker version.

### Phase marker format (locked, since #37)

Claude skills also emit a single-line **phase marker** at the start of
each pipeline phase so the runner can drive the UI timeline without
running git/PR/Jira ops itself. Same marker style as approvals — pair
of verbose sentinels, JSON body in between:

```
<<<EF_PHASE>>>{"phase":"committing"}<<<END_EF_PHASE>>>
```

The `phase` field maps to one of the runner's whitelisted `RunState`
values. After GH-52 the set is:

`fetchingTicket`, `branching`, `understandingContext`, `planning`,
`implementing`, `evaluatingTests`, `reviewingCode`, `committing`,
`pushing`, `creatingPr`, `updatingTicket`.

The first six were added in GH-52 so the timeline mirrors the full
`ef-auto-feature` skill (one runner step per skill phase) instead of
collapsing the bulk of the run into a single `running` umbrella.

`tests/unit/skill-markers.test.ts` is a static-analysis guard against
drift between this list and the markers SKILL.md actually emits — if
either side adds a phase the other doesn't know about, the test fails.

Two phases carry an optional payload field:

- `branching` may include `branchName` (string) — the actual branch
  Claude created. The runner stores it on `Run.branchName` so the UI
  shows the real name instead of the runner's pre-Claude derivation.
- `creatingPr` may include `prUrl` (string) — the PR URL Claude got
  from `gh pr create`. The runner stores it on `Run.prUrl`.

Other fields are ignored. When the runner parses a valid marker:

- closes the current step (state-changed exit + persist),
- transitions `Run.state` to the new phase,
- opens a new step with the matching `userVisibleLabel`,
- emits `state-changed` (entry) + `current-changed`, persists.

Approval markers can interleave with phase markers — when an approval
arrives, `Run.state` flips to `awaitingApproval` (paused), and on
resume flips back to whatever phase was active. The runner closes the
prior in-flight phase step BEFORE pushing the awaitingApproval step
(GH-52 #4) so the timeline never shows two simultaneously-running
steps. On resume it pushes a fresh phase step for the restored phase
so the user sees a clear "paused → resumed" boundary. Phase markers
themselves do **not** transition into `awaitingApproval`.

Same-phase dedupe (GH-52 #5): if the runner receives a phase marker
whose phase already matches the current `Run.state` AND the last step
is still `running` with that same state, the marker is dropped. Keeps
the timeline honest when a skill accidentally re-announces a phase.

Behaviour for malformed input:

- **unknown `phase` value**: logged at warn level, treated as regular
  output. Forwards-compatible — newer skills emitting future phase
  values won't crash older runners.
- **malformed JSON**: logged at warn level, treated as regular output.
  Matches approval-marker semantics.

The `<<<EF_PHASE>>>` / `<<<END_EF_PHASE>>>` sentinels are stable. The
ef-feature skill emits these between its existing Phase 0..6 sections;
do not rename without coordinating skill + runner together.

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
