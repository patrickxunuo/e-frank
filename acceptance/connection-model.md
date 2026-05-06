# Connection Model + Connections Settings View — Acceptance Criteria

## Description (client-readable)

Provider-level **Connections** that hold authentication for GitHub / Bitbucket / Jira at the user level (1..N per provider). Eliminates per-project credential storage from #3 / #4. The Connections settings view in the sidebar lists existing connections, lets the user add/edit/delete them, and runs a Test Connection on demand.

This issue ships **paste-a-token** as the only auth method. OAuth flows arrive in #26 (GitHub Device Flow) and #27 (Atlassian OAuth 3LO). Paste also remains the permanent fallback for self-hosted GHES / Jira Server / Bitbucket Data Center.

## Adaptation Note

This is a renderer + main feature with no Electron-driven Playwright (matches every prior #4–#9 ship). Tests live in jsdom + Testing Library for renderer; Vitest with FakeHttpClient / FakeSecretsBackend / mock fs for main. The schema `validateConnection` mirrors `validateProjectInstance` patterns from #3 exactly.

## Interface Contract

### Tech Stack (locked, inherited from #1–#9)
- Strict TS, Electron main + React 18 renderer, CSS Modules
- Hand-rolled validator (no zod), JSON file persistence (atomic write + write mutex), schema-versioned envelope
- No new runtime deps

### File Structure (exact)

```
src/
├── main/
│   ├── index.ts                                # MODIFY — instantiate ConnectionStore + GithubClient, wire connections:* handlers
│   └── modules/
│       ├── connection-store.ts                 # NEW — JSON store mirroring ProjectStore
│       └── github-client.ts                    # NEW — minimal GitHub REST wrapper
├── preload/
│   └── index.ts                                # MODIFY — extend window.api.connections
├── renderer/
│   ├── App.tsx                                 # MODIFY — add `connections` view route
│   ├── components/
│   │   ├── AddConnectionDialog.tsx             # NEW
│   │   ├── AddConnectionDialog.module.css      # NEW
│   │   └── Sidebar.tsx                         # MODIFY — add Connections nav item
│   ├── state/
│   │   └── connections.ts                      # NEW — useConnections() hook
│   └── views/
│       ├── Connections.tsx                     # NEW — list view
│       └── Connections.module.css              # NEW
└── shared/
    ├── ipc.ts                                  # MODIFY — add CONNECTIONS_* channels + types + IpcApi.connections
    └── schema/
        └── connection.ts                       # NEW — Connection + validators

tests/unit/
├── connection-schema.test.ts                   # NEW
├── connection-store.test.ts                    # NEW
├── github-client.test.ts                       # NEW
├── ipc-contract-connections.test.ts            # NEW
├── state-connections.test.tsx                  # NEW
├── views-connections.test.tsx                  # NEW
└── components-add-connection-dialog.test.tsx   # NEW
```

### Schema (exact)

`src/shared/schema/connection.ts` — renderer-safe (no Node imports):

```ts
export const PROVIDERS = ['github', 'bitbucket', 'jira'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const AUTH_METHODS = ['pat', 'app-password', 'api-token'] as const;
/**
 * pat            — GitHub Personal Access Token
 * app-password   — Bitbucket App Password (placeholder; not implemented in this PR)
 * api-token      — Atlassian/Jira API token (Basic email:token)
 *
 * OAuth methods (oauth-device, oauth-3lo) arrive in #26 / #27 and extend this enum.
 */
export type AuthMethod = (typeof AUTH_METHODS)[number];

export interface Connection {
  /** UUID v4 — assigned by the store. */
  id: string;
  provider: Provider;
  /** User-facing label, e.g. "Personal", "Acme Corp". Unique within provider (case-sensitive for MVP). */
  label: string;
  /** Base URL for API calls (no trailing slash).
   *  GitHub: 'https://api.github.com' or 'https://ghes.example.com/api/v3'.
   *  Jira:   'https://acme.atlassian.net'. */
  host: string;
  authMethod: AuthMethod;
  /** SecretsManager ref where the token's plaintext is stored. Pattern: 'connection:{id}:token'. */
  secretRef: string;
  /**
   * Provider-specific identity captured at last successful test (for display).
   * GitHub: { kind: 'github', login, name?, scopes? }
   * Jira:   { kind: 'jira',   accountId, displayName, emailAddress? }
   * Optional — present after first successful Test Connection.
   */
  accountIdentity?: ConnectionIdentity;
  /** Epoch ms of last successful test, or `undefined` if never verified. */
  lastVerifiedAt?: number;
  /** Epoch ms — set on create. */
  createdAt: number;
  /** Epoch ms — bumped on every update. */
  updatedAt: number;
}

export type ConnectionIdentity =
  | { kind: 'github'; login: string; name?: string; scopes?: string[] }
  | { kind: 'jira'; accountId: string; displayName: string; emailAddress?: string }
  | { kind: 'bitbucket'; username: string; displayName?: string };

/** Input shape for create — id, secretRef, accountIdentity, timestamps assigned by the store. */
export interface ConnectionInput {
  provider: Provider;
  label: string;
  host: string;
  authMethod: AuthMethod;
  /** Required at create — the plaintext is set in SecretsManager and the ref derived. Never persisted as plaintext. */
  plaintextToken: string;
  /** For Jira `api-token` only: the email used in Basic auth. */
  email?: string;
}

export interface ConnectionUpdate {
  label?: string;
  host?: string;
  /** Provided only when the user is rotating the token. Ignored if undefined. */
  plaintextToken?: string;
  /** For Jira: optional update to email. */
  email?: string;
}
```

Validator codes use the same vocabulary as `project-instance.ts`: `REQUIRED, NOT_STRING, NOT_NUMBER, NOT_OBJECT, EMPTY, INVALID_ENUM, INVALID_ID`. Add one new code: `INVALID_HOST` (host must start with `http://` or `https://`).

### ConnectionStore (exact)

`src/main/modules/connection-store.ts`:

```ts
export interface ConnectionStoreOptions {
  filePath: string;
  /** Cascade-deletes the connection's token. */
  secretsManager: Pick<SecretsManager, 'set' | 'delete'>;
  /**
   * Returns the project IDs currently referencing the connection. Cascade-delete
   * is gated when the array is non-empty. In #24, projects don't yet carry
   * connection refs — this returns [] always; #25 wires it up.
   */
  getReferencingProjectIds: (connectionId: string) => Promise<string[]>;
  fs?: ProjectStoreFs;
}

export type ConnectionStoreErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'FILE_CORRUPT'
  | 'IO_FAILURE'
  | 'LABEL_NOT_UNIQUE'
  | 'IN_USE';

export type ConnectionStoreResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ConnectionStoreErrorCode; message: string; details?: ValidationError[] | { referencedBy: string[] } } };

export class ConnectionStore {
  constructor(options: ConnectionStoreOptions);

  init(): Promise<ConnectionStoreResult<{ count: number }>>;
  list(): Promise<ConnectionStoreResult<Connection[]>>;
  get(id: string): Promise<ConnectionStoreResult<Connection>>;
  create(input: ConnectionInput): Promise<ConnectionStoreResult<Connection>>;
  update(id: string, input: ConnectionUpdate): Promise<ConnectionStoreResult<Connection>>;
  /** Refuses if `getReferencingProjectIds(id)` returns a non-empty array → IN_USE with details.referencedBy. */
  delete(id: string): Promise<ConnectionStoreResult<{ id: string }>>;
  /** Atomic write of the verified result back into the connection (lastVerifiedAt + accountIdentity). */
  recordVerification(
    id: string,
    identity: ConnectionIdentity,
  ): Promise<ConnectionStoreResult<Connection>>;
}
```

Behaviour:
- Mirrors `ProjectStore` patterns: schema-versioned envelope `{ schemaVersion: 1, connections: Connection[] }`, atomic write (write to `.tmp-{uuid}` then rename), single-Promise mutex chain via `enqueue<T>`.
- File path: `userData/connections.json`.
- `create`:
  1. Validate input (provider, label, host, authMethod, plaintextToken non-empty)
  2. Reject `LABEL_NOT_UNIQUE` if any existing connection of the same provider has the same label (case-sensitive)
  3. Generate `id = randomUUID()`, derive `secretRef = `connection:{id}:token``
  4. `secretsManager.set(secretRef, plaintextToken)` — if it fails, abort and DO NOT persist the connection
  5. For Jira, if `email` provided, the secretRef stores `email:token` joined by `\n` (so `get()` returns both halves; the test handler splits). For GitHub, just `plaintextToken`.
  6. Persist envelope; return the connection (without plaintext).
- `update`:
  - If `plaintextToken !== undefined`, call `secretsManager.set(secretRef, ...)` (same email-prefix rule for Jira).
  - Bump `updatedAt`.
- `delete`:
  - Call `getReferencingProjectIds(id)`. If non-empty → `{ ok: false, error: { code: 'IN_USE', details: { referencedBy } } }`.
  - Otherwise: cascade `secretsManager.delete(secretRef)` (best-effort; log on failure but don't block), then remove from envelope.
- Plaintext NEVER appears on `Connection` objects returned by any method.

### GithubClient (exact)

`src/main/modules/github-client.ts`:

```ts
export interface GithubAuth {
  /** PAT (`ghp_...`, `github_pat_...`). NEVER logged. */
  token: string;
}

export interface GithubClientOptions {
  httpClient: HttpClient;
  /** Base URL like 'https://api.github.com' — no trailing slash. */
  host: string;
  auth: GithubAuth;
}

export type GithubErrorCode =
  | 'NETWORK'
  | 'TIMEOUT'
  | 'AUTH'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'INVALID_RESPONSE';

export type GithubResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: GithubErrorCode; message: string; status?: number } };

export interface GithubUser {
  login: string;
  id: number;
  name?: string;
  /** OAuth scopes from the `X-OAuth-Scopes` response header (comma-separated, trimmed). Empty array if missing. */
  scopes: string[];
}

export interface GithubRepoSummary {
  fullName: string;       // "owner/name"
  defaultBranch: string;
  private: boolean;
}

export class GithubClient {
  constructor(options: GithubClientOptions);
  /** GET /user — validates the token and returns identity + scopes. */
  testConnection(): Promise<GithubResult<GithubUser>>;
  /** GET /user/repos?per_page=100&sort=updated — single page MVP (full pagination in #25). */
  listRepos(): Promise<GithubResult<GithubRepoSummary[]>>;
}
```

Auth header: `Authorization: Bearer ${token}` (works for both PATs and OAuth tokens). `Accept: application/vnd.github+json`. `X-GitHub-Api-Version: 2022-11-28`. The token MUST NEVER appear in error messages — same security rule as `JiraClient` (no `error.message` forwarding from the network layer).

### IPC contract extension

`src/shared/ipc.ts` — add:

```ts
CONNECTIONS_LIST: 'connections:list',
CONNECTIONS_GET: 'connections:get',
CONNECTIONS_CREATE: 'connections:create',
CONNECTIONS_UPDATE: 'connections:update',
CONNECTIONS_DELETE: 'connections:delete',
CONNECTIONS_TEST: 'connections:test',
```

Types:

```ts
export interface ConnectionsGetRequest { id: string }
export interface ConnectionsCreateRequest { input: ConnectionInput }
export interface ConnectionsUpdateRequest { id: string; input: ConnectionUpdate }
export interface ConnectionsDeleteRequest { id: string }
/** Test an existing connection by id (read creds from SecretsManager) OR test pre-save creds. */
export type ConnectionsTestRequest =
  | { mode: 'existing'; id: string }
  | { mode: 'preview'; provider: Provider; host: string; authMethod: AuthMethod; plaintextToken: string; email?: string };
export interface ConnectionsTestResponse {
  identity: ConnectionIdentity;
  /** Echoed back so the dialog can update its UI even before the connection is saved. */
  verifiedAt: number;
}

// IpcApi.connections:
connections: {
  list: () => Promise<IpcResult<Connection[]>>;
  get: (req: ConnectionsGetRequest) => Promise<IpcResult<Connection>>;
  create: (req: ConnectionsCreateRequest) => Promise<IpcResult<Connection>>;
  update: (req: ConnectionsUpdateRequest) => Promise<IpcResult<Connection>>;
  delete: (req: ConnectionsDeleteRequest) => Promise<IpcResult<{ id: string }>>;
  test: (req: ConnectionsTestRequest) => Promise<IpcResult<ConnectionsTestResponse>>;
};
```

Existing IPC channels unchanged. The `connection-schema.ts` re-exports `Connection`, `ConnectionInput`, `ConnectionUpdate`, `Provider`, `AuthMethod`, `ConnectionIdentity` from `shared/ipc` (mirrors how project-instance types are re-exported).

### Main wiring (`src/main/index.ts`)

After `secretsManager` is initialized:

```ts
const connectionStore = new ConnectionStore({
  filePath: join(userDataDir, 'connections.json'),
  secretsManager,
  // No projects reference connections yet (#25 wires this up). Stub returns [].
  getReferencingProjectIds: async () => [],
});
const csInit = await connectionStore.init();
if (!csInit.ok) {
  console.error('[main] ConnectionStore init failed:', csInit.error);
  // proceed; mutations will return notInitialized — same pattern as ProjectStore
}
```

Register the six `connections:*` IPC handlers (mirroring the projects handlers). For `connections:test`:
- Resolve `host`, `provider`, `authMethod`, plaintext token (and `email` for Jira) — either from the store via `id` (mode === 'existing') or from the request (mode === 'preview').
- For Jira: split `email\ntoken` if stored that way.
- Construct a fresh `JiraClient` or `GithubClient` per call, call `testConnection()`, map to `ConnectionsTestResponse`.
- Bitbucket → return `{ ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'Bitbucket connections are not yet supported' } }`.
- On success in `mode: 'existing'`, also call `connectionStore.recordVerification(id, identity)` so the row's `lastVerifiedAt` updates.

### Renderer — `useConnections` hook

`src/renderer/state/connections.ts`:

```ts
export interface UseConnectionsResult {
  connections: Connection[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}
export function useConnections(): UseConnectionsResult;
```

Behaviour: identical pattern to `useProjects` from #5. On mount, calls `window.api.connections.list()`. Per-effect `cancelled` flag. Handles `window.api === undefined` gracefully.

### Renderer — `<Connections>` view

`src/renderer/views/Connections.tsx`:

```ts
export interface ConnectionsProps {
  /** When set, opens the Add dialog after first paint (e.g. linked from empty state). */
  initialAdd?: boolean;
}
```

Layout:
- Page header with title "Connections" + subtitle "Manage your GitHub, Bitbucket, and Jira connections." + an Add Connection primary button (top-right).
- Empty state when `connections.length === 0`: a card with an "Add your first connection" CTA.
- Otherwise: a `<DataTable>` (or simple grid) of rows. Columns:
  - Provider (icon + provider name in `<Badge>`)
  - Label (display font, primary color)
  - Host (mono, secondary)
  - Identity (e.g., `@gazhang` or `Gary Zhang <gazhang@…>`) — derived from `accountIdentity`; "Not verified" if absent
  - Last verified (relative time via `formatRelative` — reuse from #6)
  - Actions: Test (ghost btn) / Edit (ghost btn) / Delete (destructive ghost btn)
- testids: `connections-page`, `connections-add-button`, `connections-empty`, `connections-row-{id}`, `connection-test-{id}`, `connection-edit-{id}`, `connection-delete-{id}`.
- Delete confirms via the existing `<Dialog>` (size="sm"). If the IPC returns `IN_USE`, the dialog shows the `referencedBy` project IDs.
- Test action calls `connections.test({ mode: 'existing', id })` and shows a transient success / error toast (or inline pill on the row).

### Renderer — `<AddConnectionDialog>`

`src/renderer/components/AddConnectionDialog.tsx`:

```ts
export interface AddConnectionDialogProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  /** When set, dialog opens in Edit mode (label / host editable; token only set if user types a new one). */
  editing?: Connection;
}
```

Form:
- **Provider**: Select with options GitHub, Jira, Bitbucket (Bitbucket disabled with a "(coming soon)" suffix).
- **Label**: Input. Required. Must be unique within provider — server-side validated via the create response.
- **Host**: Input. Required. Default placeholder per provider:
  - GitHub: `https://api.github.com` (auto-filled)
  - Jira: `https://your-workspace.atlassian.net`
  - Bitbucket: `https://api.bitbucket.org/2.0`
- **Email** (Jira only): Input. Required when provider === 'jira'.
- **Token** (or App Password for Bitbucket): Input type="password". Required on create; optional on edit (empty = don't change).
- **Test Connection** button: calls `connections.test({ mode: 'preview', ... })`. On success, shows a green pill: `"@login"` / `"Gary Zhang <…>"`. On failure, shows an inline error with the typed code + message.
- **Save** button: disabled until required fields filled (and, on create, until Test Connection has succeeded — UX safeguard, not a hard gate; if user wants to bypass, they edit then save).
- Dialog uses the existing `<Dialog>` `size="md"` shell. testids: `add-connection-dialog`, `connection-provider-select`, `connection-label-input`, `connection-host-input`, `connection-email-input`, `connection-token-input`, `connection-test-button`, `connection-save-button`, `connection-cancel-button`, `connection-test-result`.

### Sidebar nav

`src/renderer/components/Sidebar.tsx`:
- Extend `SidebarNavId` with `'connections'`.
- Add a `NAV_ITEMS` row between Projects and Settings: `{ id: 'connections', label: 'Connections', icon: <IconKey /> }`. (Add an `IconKey` to `icons.tsx` if not present — a small key/lock icon).
- Buttons need an `onClick` to navigate. Right now `Sidebar` doesn't take an onClick — add an optional `onNavigate?: (id: SidebarNavId) => void` prop and call it on each nav item's click.

### App routing

`src/renderer/App.tsx`:
- Extend `ViewState` with `{ kind: 'connections' }`.
- Wire the sidebar's `onNavigate` to `setView({ kind: 'connections' })` when the user clicks the Connections nav item, and `setView({ kind: 'list' })` for Projects.
- Pass `activeNav={view.kind === 'connections' ? 'connections' : 'projects'}` to `<AppShell>`.
- When `view.kind === 'connections'` render `<Connections />`.

## Business Rules

1. **Plaintext never crosses the IPC boundary** outside the `connections.create` / `update` / `test` request payloads. The `Connection` returned by `list / get / create / update` carries only `secretRef`, never plaintext.
2. **Jira creds are stored as `email\ntoken`** under the secret ref. The test handler splits on the first `\n`. If the secret value has no `\n`, it's treated as token-only and Basic auth construction fails with a typed error.
3. **Label uniqueness is per-provider**, case-sensitive (MVP). Updating a connection's label to one that collides → `LABEL_NOT_UNIQUE`.
4. **Cascade-delete-protection:** delete is gated by the injected `getReferencingProjectIds`. In #24, returns []; #25 wires up. The error code is `IN_USE` with `details.referencedBy: string[]`.
5. **secretsManager.set must succeed** for `create` to succeed. Failure aborts; the connection is NOT persisted.
6. **secretsManager.delete failure during cascade** is logged but does not block the connection deletion (matches `ProjectStore.delete` behavior).
7. **Bitbucket** is accepted in the provider enum but `connections:test` for it returns `{ ok: false, error: { code: 'NOT_IMPLEMENTED', ... } }`. Listing/saving Bitbucket connections still works so a future #27/Bitbucket issue doesn't need a schema migration.
8. **Test Connection** updates `lastVerifiedAt` + `accountIdentity` only in `mode: 'existing'` (saved connections); `mode: 'preview'` does not write to the store.
9. **All interactive elements** carry `data-testid`.

## API Acceptance Tests

### Connection schema (CONN-SCH-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| CONN-SCH-001 | `validateConnection` rejects non-object input | INVALID errors |
| CONN-SCH-002 | Missing required fields → REQUIRED for each | id/provider/label/host/authMethod/secretRef/createdAt/updatedAt |
| CONN-SCH-003 | Invalid provider → INVALID_ENUM | "github"/"bitbucket"/"jira" |
| CONN-SCH-004 | Invalid authMethod → INVALID_ENUM | true |
| CONN-SCH-005 | host missing scheme → INVALID_HOST | "example.com" rejected |
| CONN-SCH-006 | createdAt / updatedAt must be finite numbers | NaN rejected |
| CONN-SCH-007 | `validateConnectionInput` rejects `id` field if present | INVALID_ID |
| CONN-SCH-008 | `validateConnectionInput` requires non-empty plaintextToken | EMPTY |
| CONN-SCH-009 | `validateConnectionInput` requires `email` when provider === 'jira' AND authMethod === 'api-token' | REQUIRED |

### ConnectionStore (CONN-STORE-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| CONN-STORE-001 | `init()` returns count: 0 when file missing | true |
| CONN-STORE-002 | `init()` parses an existing valid envelope | round-trip preserves all fields |
| CONN-STORE-003 | `init()` rejects FILE_CORRUPT on malformed JSON | true |
| CONN-STORE-004 | `init()` rejects UNSUPPORTED_SCHEMA_VERSION on v0 envelope | true |
| CONN-STORE-005 | `create` assigns id, derives secretRef, calls secretsManager.set, persists envelope | secretsManager.set called once with the right ref |
| CONN-STORE-006 | `create` rejects LABEL_NOT_UNIQUE for same-provider duplicate label | true |
| CONN-STORE-007 | `create` allows same label across different providers | true |
| CONN-STORE-008 | `create` for Jira stores `${email}\n${token}` under secretRef | secretsManager.set called with joined value |
| CONN-STORE-009 | `create` aborts when secretsManager.set fails | envelope NOT mutated |
| CONN-STORE-010 | `update` rotates token only when plaintextToken provided | secretsManager.set called only if provided |
| CONN-STORE-011 | `update` reports LABEL_NOT_UNIQUE on collision | true |
| CONN-STORE-012 | `delete` calls getReferencingProjectIds; refuses with IN_USE if non-empty | error.details.referencedBy populated |
| CONN-STORE-013 | `delete` cascades secretsManager.delete; ignores cascade failure | envelope mutated even if cascade fails |
| CONN-STORE-014 | `recordVerification` updates lastVerifiedAt + accountIdentity, bumps updatedAt | true |
| CONN-STORE-015 | Atomic write to `.tmp-{uuid}` then rename | tmp file written then renamed |
| CONN-STORE-016 | Concurrent create calls serialize via the mutex | both succeed, no clobber |
| CONN-STORE-017 | Plaintext never appears on returned Connection | true |

### GithubClient (GH-CLIENT-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| GH-CLIENT-001 | `testConnection()` GETs `${host}/user` with Bearer auth | FakeHttpClient asserts URL + headers |
| GH-CLIENT-002 | 200 → ok with login + scopes from `X-OAuth-Scopes` header | true |
| GH-CLIENT-003 | 401/403 → AUTH | true |
| GH-CLIENT-004 | 404 → NOT_FOUND | true |
| GH-CLIENT-005 | 429 → RATE_LIMITED | true |
| GH-CLIENT-006 | 5xx → SERVER_ERROR | true |
| GH-CLIENT-007 | Network error (TIMEOUT/ABORTED/NETWORK) lifts to typed error | true |
| GH-CLIENT-008 | `listRepos()` returns array of `{ fullName, defaultBranch, private }` | true |
| GH-CLIENT-009 | listRepos honors per_page=100, sort=updated | URL contains those params |
| GH-CLIENT-010 | Token NEVER appears in any error.message | true |
| GH-CLIENT-011 | Missing `X-OAuth-Scopes` → scopes is `[]` | true |
| GH-CLIENT-012 | Garbage JSON body → INVALID_RESPONSE | true |

### IPC contract (IPC-CONN-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| IPC-CONN-001 | `CONNECTIONS_*` channel constants are stable strings | true |
| IPC-CONN-002 | IpcApi.connections has list/get/create/update/delete/test methods | true |
| IPC-CONN-003 | Drift guard: ConnectionsTestRequest discriminated union compiles | true |
| IPC-CONN-004 | Existing channels unchanged (regression) | true |

### Renderer hook — useConnections (CONN-HOOK-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| CONN-HOOK-001 | On mount, calls window.api.connections.list() | true |
| CONN-HOOK-002 | Returns connections array on success | true |
| CONN-HOOK-003 | Surfaces error message on failure | true |
| CONN-HOOK-004 | refresh() re-calls list() | true |
| CONN-HOOK-005 | window.api === undefined → loading false, error set | true |

### Connections view (VIEW-CONN-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| VIEW-CONN-001 | Heading "Connections" + Add button rendered | true |
| VIEW-CONN-002 | Empty state when `connections.length === 0` | testid `connections-empty` present |
| VIEW-CONN-003 | One row per connection with provider badge, label, host, identity, last verified | testid `connections-row-{id}` |
| VIEW-CONN-004 | "Not verified" shown when accountIdentity absent | true |
| VIEW-CONN-005 | Test action calls connections.test (mode: 'existing'); success updates row pill | true |
| VIEW-CONN-006 | Edit action opens AddConnectionDialog with `editing` prop populated | true |
| VIEW-CONN-007 | Delete action opens confirm dialog; on confirm calls connections.delete | true |
| VIEW-CONN-008 | Delete IN_USE error shows referencedBy list in the dialog | true |
| VIEW-CONN-009 | Add button opens dialog | true |

### AddConnectionDialog (CMP-CONN-DIALOG-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| CMP-CONN-DIALOG-001 | Provider select renders GitHub/Jira/Bitbucket | true |
| CMP-CONN-DIALOG-002 | Bitbucket option disabled (coming soon) | true |
| CMP-CONN-DIALOG-003 | Switching provider updates default host placeholder | true |
| CMP-CONN-DIALOG-004 | Email field shown only when provider === 'jira' | true |
| CMP-CONN-DIALOG-005 | Test Connection calls connections.test (mode: 'preview'); success pill shows identity | true |
| CMP-CONN-DIALOG-006 | Test Connection error shows code + message inline | true |
| CMP-CONN-DIALOG-007 | Save calls connections.create when no `editing` prop | true |
| CMP-CONN-DIALOG-008 | Save calls connections.update when `editing` prop given | true |
| CMP-CONN-DIALOG-009 | Edit mode: token field empty + label "Leave empty to keep current" | true |
| CMP-CONN-DIALOG-010 | Server LABEL_NOT_UNIQUE response surfaced as inline label-field error | true |
| CMP-CONN-DIALOG-011 | Save disabled until required fields filled | true |

### Sidebar regression (SIDEBAR-CONN-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| SIDEBAR-CONN-001 | Connections nav item rendered between Projects and Settings | true |
| SIDEBAR-CONN-002 | Clicking Connections fires onNavigate('connections') | true |
| SIDEBAR-CONN-003 | activeNav='connections' applies aria-current to the row | true |

### App routing (APP-CONN-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| APP-CONN-001 | Sidebar Connections click navigates to Connections view | testid `connections-page` rendered |
| APP-CONN-002 | Sidebar Projects click returns to ProjectList | true |
| APP-CONN-003 | Existing detail / execution views unchanged (regression) | true |

## Manual verification (after PR)
- [ ] `npm run dev`: ProjectList still loads
- [ ] Click Connections in sidebar → empty state visible
- [ ] Add a GitHub PAT connection → Test Connection turns green with `@login`
- [ ] Save → row appears in list
- [ ] Add a Jira API-token connection → Test Connection turns green with display name
- [ ] Edit a connection → label/host changes persist; leaving token empty keeps existing token
- [ ] Delete a connection → row disappears
- [ ] Restart app → connections persist

## Test Status
- [ ] CONN-SCH-001..009
- [ ] CONN-STORE-001..017
- [ ] GH-CLIENT-001..012
- [ ] IPC-CONN-001..004
- [ ] CONN-HOOK-001..005
- [ ] VIEW-CONN-001..009
- [ ] CMP-CONN-DIALOG-001..011
- [ ] SIDEBAR-CONN-001..003
- [ ] APP-CONN-001..003
- [ ] `npm run lint`: 0
- [ ] `npm run typecheck`: 0
- [ ] `npm run build`: clean
