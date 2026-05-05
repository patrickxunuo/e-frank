# Project Instance Config + Secrets Storage — Acceptance Criteria

## Description (client-readable)
The data layer for the desktop app. Defines the **Project Instance** schema with a hand-rolled per-field validator, persists projects to a JSON file at `app.getPath('userData')/projects.json` with atomic writes and a write mutex, and stores secrets (Jira / GitHub / Bitbucket tokens) in the OS keychain via Electron `safeStorage`, referenced from the project config so plaintext never lives in the JSON file.

## Adaptation Note
This is a **backend-only** feature — no UI in this issue. Renderer-facing surface is the new `window.api.projects.*` and `window.api.secrets.*` namespaces. UI lands in #5.

## Interface Contract

### Tech Stack (locked, inherited from #1/#2)
- Node.js ≥ 20, Electron 31
- TypeScript strict
- Vitest 2 unit tests, no real `safeStorage` calls (abstracted behind `SecretsBackend`)
- **No new dependencies** — hand-rolled validator, hand-rolled atomic write

### File Structure (exact)
```
src/
├── main/
│   ├── index.ts                              # extend with handler registration
│   └── modules/
│       ├── project-store.ts                  # ProjectStore class
│       └── secrets-manager.ts                # SecretsManager + SecretsBackend + FakeSecretsBackend + SafeStorageBackend
├── preload/
│   └── index.ts                              # extend window.api
└── shared/
    ├── ipc.ts                                # extend with new channels + types
    └── schema/
        └── project-instance.ts               # types + validateProjectInstance

tests/
└── unit/
    ├── project-instance-schema.test.ts       # validator cases
    ├── project-store.test.ts                 # CRUD + atomic + mutex + missing file
    ├── secrets-manager.test.ts               # SecretsManager via FakeSecretsBackend
    └── ipc-contract-projects.test.ts         # new channel/type/regression checks
```

### Project Instance Schema (exact)

File: `src/shared/schema/project-instance.ts`

```ts
export const REPO_TYPES = ['github', 'bitbucket'] as const;
export type RepoType = typeof REPO_TYPES[number];

export const TICKET_SOURCES = ['jira'] as const;
export type TicketSource = typeof TICKET_SOURCES[number];

export const WORKFLOW_MODES = ['interactive', 'yolo'] as const;
export type WorkflowMode = typeof WORKFLOW_MODES[number];

export interface RepoConfig {
  type: RepoType;
  /** Absolute path. */
  localPath: string;
  baseBranch: string;
  /** Optional ref into SecretsManager (e.g. "github-default"). Plaintext tokens NEVER live in this struct. */
  tokenRef?: string;
}

export interface TicketsConfig {
  source: TicketSource;
  /** JQL or equivalent — non-empty after trim. */
  query: string;
  /** Optional ref into SecretsManager for Jira/Bitbucket creds. */
  tokenRef?: string;
}

export interface WorkflowConfig {
  mode: WorkflowMode;
  /** Branch name format. Must contain at least one of {ticketKey} / {slug}. */
  branchFormat: string;
}

export interface ProjectInstance {
  /** UUID v4 generated on create. Stable across edits. */
  id: string;
  name: string;
  repo: RepoConfig;
  tickets: TicketsConfig;
  workflow: WorkflowConfig;
  /** Epoch ms — set on create. */
  createdAt: number;
  /** Epoch ms — bumped on update. */
  updatedAt: number;
}

export interface ValidationError {
  /** Dotted path, e.g. "repo.localPath" or "tickets.query". */
  path: string;
  /** Stable machine-readable code (consumers may switch on this). */
  code: ValidationErrorCode;
  /** Human-readable message — safe to show in UI. */
  message: string;
}

export type ValidationErrorCode =
  | 'REQUIRED'
  | 'NOT_STRING'
  | 'EMPTY'
  | 'INVALID_ENUM'
  | 'NOT_ABSOLUTE'
  | 'INVALID_BRANCH_FORMAT'
  | 'INVALID_ID';

export type ValidationResult =
  | { ok: true; value: ProjectInstance }
  | { ok: false; errors: ValidationError[] };

/**
 * Validates a candidate ProjectInstance. Reports ALL field errors at once
 * (not first-error-and-stop) so the form can render every problem inline.
 */
export function validateProjectInstance(input: unknown): ValidationResult;

/**
 * Convenience for the create-flow: validates a partial input where id /
 * createdAt / updatedAt are filled in by the store. Returns the same
 * shape as validateProjectInstance but with stripped error paths for the
 * store-managed fields.
 */
export interface ProjectInstanceInput {
  name: string;
  repo: RepoConfig;
  tickets: TicketsConfig;
  workflow: WorkflowConfig;
}

export function validateProjectInstanceInput(
  input: unknown,
): { ok: true; value: ProjectInstanceInput } | { ok: false; errors: ValidationError[] };
```

### File Envelope (exact)

`projects.json` content shape:
```json
{
  "schemaVersion": 1,
  "projects": [ /* ProjectInstance[] */ ]
}
```

The store rejects any envelope where `schemaVersion !== 1` with a clear error rather than guessing.

### ProjectStore Class (exact public API)

File: `src/main/modules/project-store.ts`

```ts
export interface ProjectStoreOptions {
  /** Absolute path to projects.json. */
  filePath: string;
  /** Used to cascade-delete tokens when a project is removed. */
  secretsManager: Pick<SecretsManager, 'delete'>;
  /** Override fs for tests. Defaults to node:fs/promises. */
  fs?: ProjectStoreFs;
}

/** Minimal fs surface used by the store — abstracted for testability. */
export interface ProjectStoreFs {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  mkdir(path: string, opts: { recursive: true }): Promise<void>;
}

export type StoreErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'FILE_CORRUPT'
  | 'IO_FAILURE';

export type StoreResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: StoreErrorCode; message: string; details?: ValidationError[] } };

export class ProjectStore {
  constructor(options: ProjectStoreOptions);

  /**
   * Reads the file (or initializes an empty store if missing). MUST be
   * called once before any CRUD operation. Idempotent.
   */
  init(): Promise<StoreResult<{ count: number }>>;

  list(): Promise<StoreResult<ProjectInstance[]>>;
  get(id: string): Promise<StoreResult<ProjectInstance>>;
  create(input: unknown): Promise<StoreResult<ProjectInstance>>;
  update(id: string, input: unknown): Promise<StoreResult<ProjectInstance>>;
  /** Cascade-deletes any tokenRef on the project from the secrets manager. */
  delete(id: string): Promise<StoreResult<{ id: string }>>;
}
```

### SecretsBackend + SecretsManager (exact)

File: `src/main/modules/secrets-manager.ts`

```ts
/** Minimal facade over Electron's safeStorage so we can fake it in tests. */
export interface SecretsBackend {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(blob: Buffer): string;
}

/** Real implementation — wraps Electron's `safeStorage`. */
export class SafeStorageBackend implements SecretsBackend { /* ... */ }

/** Test implementation — pretends to be encrypted by base64-flipping. Configurable. */
export class FakeSecretsBackend implements SecretsBackend {
  /** Set to false to simulate "no keyring available" environments. */
  available: boolean;
  constructor(opts?: { available?: boolean });
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(blob: Buffer): string;
}

export interface SecretsManagerOptions {
  /** Absolute path to secrets sidecar file. */
  filePath: string;
  backend: SecretsBackend;
  fs?: ProjectStoreFs;
}

export type SecretsErrorCode =
  | 'BACKEND_UNAVAILABLE'
  | 'NOT_FOUND'
  | 'IO_FAILURE'
  | 'CORRUPT';

export type SecretsResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: SecretsErrorCode; message: string } };

/**
 * Stores secrets as encrypted blobs in a sidecar JSON file:
 *   { schemaVersion: 1, secrets: { [ref]: <base64 of encrypted bytes> } }
 *
 * Plaintext tokens never appear in any file or IPC payload outside the
 * `set()`/`get()` round-trip on the main process.
 */
export class SecretsManager {
  constructor(options: SecretsManagerOptions);

  init(): Promise<SecretsResult<{ count: number }>>;
  isAvailable(): boolean;
  /** Returns BACKEND_UNAVAILABLE if isAvailable() === false. */
  set(ref: string, plaintext: string): Promise<SecretsResult<{ ref: string }>>;
  /** Returns NOT_FOUND if the ref isn't stored. */
  get(ref: string): Promise<SecretsResult<{ plaintext: string }>>;
  /** Idempotent — deleting a missing ref returns ok. */
  delete(ref: string): Promise<SecretsResult<{ ref: string }>>;
  /** Lists stored refs (NEVER returns plaintext). */
  list(): Promise<SecretsResult<{ refs: string[] }>>;
}
```

### IPC Contract Extension (exact)

File: `src/shared/ipc.ts` — extend `IPC_CHANNELS`:
```ts
PROJECTS_LIST: 'projects:list',
PROJECTS_GET: 'projects:get',
PROJECTS_CREATE: 'projects:create',
PROJECTS_UPDATE: 'projects:update',
PROJECTS_DELETE: 'projects:delete',
SECRETS_SET: 'secrets:set',
SECRETS_GET: 'secrets:get',
SECRETS_DELETE: 'secrets:delete',
SECRETS_LIST: 'secrets:list',
```

Add types (mirroring the manager-side, with shared/main duplication documented per the #2 pattern):
```ts
export type ProjectInstanceDto = ProjectInstance; // re-export from schema
export interface ProjectsCreateRequest { input: ProjectInstanceInput }
export interface ProjectsUpdateRequest { id: string; input: ProjectInstanceInput }
export interface ProjectsDeleteRequest { id: string }
export interface ProjectsGetRequest { id: string }
export interface SecretsSetRequest { ref: string; plaintext: string }
export interface SecretsGetRequest { ref: string }
export interface SecretsGetResponse { plaintext: string }
export interface SecretsDeleteRequest { ref: string }
export interface SecretsListResponse { refs: string[] }
```

(The schema types `ProjectInstance` / `ProjectInstanceInput` are exported from `src/shared/schema/project-instance.ts` and re-exported / referenced from `ipc.ts` for renderer convenience.)

Extend `IpcApi`:
```ts
projects: {
  list: () => Promise<IpcResult<ProjectInstanceDto[]>>;
  get: (req: ProjectsGetRequest) => Promise<IpcResult<ProjectInstanceDto>>;
  create: (req: ProjectsCreateRequest) => Promise<IpcResult<ProjectInstanceDto>>;
  update: (req: ProjectsUpdateRequest) => Promise<IpcResult<ProjectInstanceDto>>;
  delete: (req: ProjectsDeleteRequest) => Promise<IpcResult<{ id: string }>>;
};
secrets: {
  set: (req: SecretsSetRequest) => Promise<IpcResult<{ ref: string }>>;
  get: (req: SecretsGetRequest) => Promise<IpcResult<SecretsGetResponse>>;
  delete: (req: SecretsDeleteRequest) => Promise<IpcResult<{ ref: string }>>;
  list: () => Promise<IpcResult<SecretsListResponse>>;
};
```

### Main process wiring

File: `src/main/index.ts` — extend with:
- Construct `SafeStorageBackend` (real) → `SecretsManager` → `ProjectStore` at app-ready time
- Both stores' `init()` runs once at startup; if either fails, surface a window-modal error and quit cleanly
- 9 new IPC handlers (5 projects + 4 secrets), each wraps the manager call and returns `IpcResult<T>`
- Existing `app:ping` and `claude:*` handlers must keep working

### Preload (exact)

File: `src/preload/index.ts` — extend `window.api` with `projects: {...}` and `secrets: {...}` namespaces. Each method is `(req?) => ipcRenderer.invoke(channel, req)`. Existing `api.ping` and `api.claude` are unchanged.

## Business Rules

1. **Schema version envelope**: `projects.json` and `secrets.json` both wrap their data in `{ schemaVersion: 1, ... }`. Reading `schemaVersion !== 1` returns `UNSUPPORTED_SCHEMA_VERSION` rather than attempting a best-effort parse.
2. **Atomic writes**: every mutation writes to `<target>.tmp-<random>` first, then `fs.rename(temp, target)`. If the process dies between, the previous file is intact.
3. **Write mutex**: a single in-process Promise chain serializes all `create / update / delete` calls. Concurrent IPC requests await each other.
4. **Missing file = empty store**: a missing `projects.json` or `secrets.json` initializes an empty store. No prompt, no error.
5. **Validator emits ALL errors**: `validateProjectInstance` walks every field and collects errors before returning. The form depends on this for inline validation.
6. **`branchFormat` placeholders**: must contain at least one of `{ticketKey}` or `{slug}`. A literal string with neither is an `INVALID_BRANCH_FORMAT` error.
7. **`localPath` must be absolute**: `path.isAbsolute(localPath)`. Existence is NOT checked at validation time (the store layer is platform-agnostic; existence is a runtime concern for #10 Git Manager).
8. **Token refs vs plaintext**: `RepoConfig.tokenRef` and `TicketsConfig.tokenRef` are arbitrary string identifiers (e.g. `"github-default"` or a UUID). The store does NOT validate that the ref exists in `SecretsManager` — the form is allowed to save a project with a tokenRef pointing at a secret that's about to be set. The token-set call from the UI happens separately via `secrets.set`.
9. **Cascade delete**: `ProjectStore.delete(id)` must call `secretsManager.delete(repo.tokenRef)` and `secretsManager.delete(tickets.tokenRef)` for any non-empty refs on the deleted project, BEFORE removing the project from the JSON. If the secret deletion fails, the project deletion still proceeds (we log + return ok with a warning, but don't block the user-facing delete).
10. **`SecretsManager.set` requires backend availability**: if `backend.isEncryptionAvailable() === false`, `set()` returns `BACKEND_UNAVAILABLE`. We do NOT fall back to plaintext storage. Tests cover both branches.
11. **`SecretsManager.list` returns refs only**: never plaintext. There is intentionally no `getAll()`.
12. **IDs are UUID v4**: assigned by `create()` via `crypto.randomUUID()`. Inputs that supply an `id` field on create are rejected with `INVALID_ID` (the store owns id assignment).
13. **`createdAt` / `updatedAt`**: assigned by the store. `createdAt` set on create and never changed. `updatedAt` bumped on every successful `update()`.

## Validator Acceptance Tests (VAL-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| VAL-001 | Happy path: fully-valid input | `ok: true`, returned value matches input |
| VAL-002 | Missing `name` | error path `name`, code `REQUIRED` |
| VAL-003 | Empty `name` (whitespace only) | error path `name`, code `EMPTY` |
| VAL-004 | `repo.type` invalid (e.g. `'gitlab'`) | error path `repo.type`, code `INVALID_ENUM`, message includes the valid values |
| VAL-005 | `repo.localPath` relative (`./foo`) | error path `repo.localPath`, code `NOT_ABSOLUTE` |
| VAL-006 | `repo.baseBranch` empty | error path `repo.baseBranch`, code `EMPTY` |
| VAL-007 | `tickets.source` invalid | error path `tickets.source`, code `INVALID_ENUM` |
| VAL-008 | `tickets.query` empty (whitespace only) | error path `tickets.query`, code `EMPTY` |
| VAL-009 | `workflow.mode` invalid | error path `workflow.mode`, code `INVALID_ENUM` |
| VAL-010 | `workflow.branchFormat` no placeholder (`'feat/foo'`) | error path `workflow.branchFormat`, code `INVALID_BRANCH_FORMAT` |
| VAL-011 | Multiple errors at once | `ok: false`, errors array contains all expected paths in stable order |
| VAL-012 | Top-level `null` input | `ok: false`, error path `''`, code `NOT_STRING` (or analogous "not an object" code — implementer may add `NOT_OBJECT`) |
| VAL-013 | Wrong type for `name` (number) | error path `name`, code `NOT_STRING` |
| VAL-014 | `branchFormat` with `{ticketKey}` only — accepted | `ok: true` |
| VAL-015 | `branchFormat` with `{slug}` only — accepted | `ok: true` |
| VAL-016 | Input with extra unknown fields — preserved on success | `ok: true` (extras silently dropped) |
| VAL-017 | Input on create supplies `id` — rejected | error path `id`, code `INVALID_ID` (use `validateProjectInstanceInput`) |

## ProjectStore Acceptance Tests (PS-XXX)

Use a stubbed `ProjectStoreFs` (in-memory map) and a stubbed `SecretsManager` (records `delete` calls).

| ID | Scenario | Expected |
|----|----------|----------|
| PS-001 | `init()` with missing file — empty store | `ok: true, data: { count: 0 }` |
| PS-002 | `init()` with valid file containing 2 projects | `count: 2`; `list()` returns those 2 |
| PS-003 | `init()` with invalid JSON | `ok: false, code: 'FILE_CORRUPT'` |
| PS-004 | `init()` with `schemaVersion: 99` | `ok: false, code: 'UNSUPPORTED_SCHEMA_VERSION'` |
| PS-005 | `create()` valid input | `ok: true`; project assigned UUID id, createdAt + updatedAt set; `list()` reflects new project |
| PS-006 | `create()` invalid input | `ok: false, code: 'VALIDATION_FAILED'`; error details has the validator's errors array |
| PS-007 | `create()` writes atomically | fs sees `writeFile(temp)` then `rename(temp, target)`; never raw `writeFile(target)` |
| PS-008 | `get()` with unknown id | `ok: false, code: 'NOT_FOUND'` |
| PS-009 | `update()` valid — bumps updatedAt, preserves createdAt and id | new updatedAt > old; createdAt unchanged; id unchanged |
| PS-010 | `update()` unknown id | `ok: false, code: 'NOT_FOUND'` |
| PS-011 | `delete()` cascades to secrets | secrets.delete called for each non-empty `tokenRef` (`repo.tokenRef`, `tickets.tokenRef`) |
| PS-012 | `delete()` proceeds even if secrets.delete fails | project removed; result is `ok: true` |
| PS-013 | Concurrent `create()` calls (mutex) | both succeed; final list has both new projects in deterministic order |
| PS-014 | List/get round-trip after restart | persist via fs stub, instantiate new store, `list()` returns the same projects |
| PS-015 | `delete()` removes only the targeted project | other projects unchanged |

## SecretsManager Acceptance Tests (SM-XXX)

Use `FakeSecretsBackend` and a stubbed `ProjectStoreFs`.

| ID | Scenario | Expected |
|----|----------|----------|
| SM-001 | `set()` then `get()` round-trip | get returns the same plaintext |
| SM-002 | `set()` overwrites existing ref | second set wins; get returns the new value |
| SM-003 | `get()` missing ref | `ok: false, code: 'NOT_FOUND'` |
| SM-004 | `delete()` existing ref then get | `delete` ok; `get` returns NOT_FOUND |
| SM-005 | `delete()` missing ref is idempotent | `ok: true` |
| SM-006 | `list()` returns ref names only | array of strings; never plaintext |
| SM-007 | `set()` when backend unavailable | `ok: false, code: 'BACKEND_UNAVAILABLE'`; nothing persisted |
| SM-008 | `set()` writes atomically | fs sees temp+rename pattern |
| SM-009 | `init()` on missing file | `ok: true, data: { count: 0 }` |
| SM-010 | `init()` on file with `schemaVersion !== 1` | `ok: false, code: 'CORRUPT'` |
| SM-011 | Plaintext NEVER appears in the encrypted file content | inspect fs writes — no occurrence of the plaintext substring |
| SM-012 | `get()` decryption failure (corrupted blob) | `ok: false, code: 'CORRUPT'` |

## IPC Contract Tests (IPC-PS-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| IPC-PS-001 | New channel strings | `PROJECTS_LIST === 'projects:list'`, etc. for all 9 |
| IPC-PS-002 | IpcApi extension | `expectTypeOf<IpcApi['projects']['list']>()`, etc. — all 9 methods have correct signatures |
| IPC-PS-003 | Regression — PING and CLAUDE_* contracts unchanged | `IPC_CHANNELS.PING === 'app:ping'`, all 6 claude channels still present and correct |
| IPC-PS-004 | Schema types re-exported through ipc.ts | `ProjectInstanceDto` shape matches schema's `ProjectInstance` (drift guard like #2's) |

## E2E (Playwright) — Deferred
No new Playwright coverage. Real UI lands in #5.

## Test Status
- [x] VAL-001 through VAL-017: PASS (22 tests in `tests/unit/project-instance-schema.test.ts`)
- [x] PS-001 through PS-015: PASS (16 tests in `tests/unit/project-store.test.ts`)
- [x] SM-001 through SM-012: PASS (13 tests in `tests/unit/secrets-manager.test.ts`)
- [x] IPC-PS-001 through IPC-PS-004: PASS (31 tests in `tests/unit/ipc-contract-projects.test.ts`)
- [x] Total project: **172/172 unit tests pass** (was 90/90 after #2; +82 new)
- [x] `npm run lint`: 0 errors, 0 warnings
- [x] `npm run typecheck`: 0 errors
- [x] `npm run build`: clean — preload now 2.54 kB (bundles new IPC channels), renderer unchanged

## Manual verification (developer, after PR)
- [ ] `npm run dev` still works; existing `Ping` button still returns `pong: hello` (regression on #1)
- [ ] (Optional, in DevTools console) `await window.api.projects.list()` returns `{ ok: true, data: [] }` on first launch
- [ ] (Optional) `await window.api.projects.create({ input: { ... } })` creates a project; restart app; `list()` returns it
