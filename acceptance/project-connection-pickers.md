# Project ↔ Connections Refactor + Picker UI — Acceptance Criteria

## Description (client-readable)

Replace per-project embedded credentials with references to the Connections introduced in #24. AddProject and EditProject become connection pickers + resource selectors instead of credential forms. JiraPoller resolves auth at poll time via the project's `tickets.connectionId`.

This is a **schema break**. Pre-MVP, no users → no migration shim needed. The drift-guard test asserts the new shape and rejects any project record carrying the old credential fields.

## Adaptation Note

Three implementation lanes that move in parallel:
- **Lane 1 — Schema + Store:** drop credential fields, add connection-ref fields, validator updates, drift-guard test.
- **Lane 2 — Backend wiring:** JiraPoller refactor, JiraClient.listProjects, two new IPC channels, getReferencingProjectIds wired up in main.
- **Lane 3 — Renderer:** AddProject + EditProject rewrite to picker UI; new resource-fetch hooks.

Tests live in jsdom + Testing Library + Vitest. No new Playwright.

## Interface Contract

### Tech Stack (locked)
- Strict TS, React 18, CSS Modules, hand-rolled tokens, no new runtime deps

### File Structure (exact)

```
src/
├── shared/
│   ├── ipc.ts                                     # MODIFY — add CONNECTIONS_LIST_REPOS / LIST_JIRA_PROJECTS + types
│   └── schema/
│       └── project-instance.ts                    # MODIFY — schema break
├── main/
│   ├── index.ts                                   # MODIFY — wire JiraPoller w/ ConnectionStore, register new IPC handlers, wire getReferencingProjectIds
│   └── modules/
│       ├── jira-client.ts                         # MODIFY — add listProjects()
│       ├── jira-poller.ts                         # MODIFY — accept ConnectionStore; resolve auth at poll time via connection
│       └── project-store.ts                       # MODIFY — drop the cascade-secret-delete on project delete (secrets now belong to connections)
├── preload/
│   └── index.ts                                   # MODIFY — extend window.api.connections w/ listRepos / listJiraProjects
└── renderer/
    ├── state/
    │   └── connection-resources.ts                # NEW — useConnectionRepos / useConnectionJiraProjects hooks
    └── views/
        ├── AddProject.tsx                         # MODIFY — picker UI rewrite
        └── AddProject.module.css                  # MODIFY — minor tweaks for the new sections

tests/unit/
├── project-instance-schema.test.ts                # MODIFY — new fields + drift guard
├── project-store.test.ts                          # MODIFY — fixtures + cascade behavior change
├── jira-poller.test.ts                            # MODIFY — fixtures + ConnectionStore mock + auth resolution path
├── jira-client.test.ts                            # MODIFY — add listProjects tests
├── github-client.test.ts                          # (no changes — listRepos already covered)
├── connection-store.test.ts                       # MODIFY — tighten the IN_USE flow (no functional changes; just confirm the shape)
├── ipc-contract-projects.test.ts                  # MODIFY — assert new schema fields, drift guard on old fields
├── ipc-contract-connections.test.ts               # MODIFY — assert new LIST_REPOS / LIST_JIRA_PROJECTS channels
├── state-connection-resources.test.tsx            # NEW
└── views-add-project.test.tsx                     # MODIFY — major rewrite for picker UI
```

### Schema (exact)

`src/shared/schema/project-instance.ts`:

```ts
export interface RepoConfig {
  type: RepoType;
  /** Absolute path on disk — kept; the workflow runner clones/cd's here. */
  localPath: string;
  baseBranch: string;
  /** ID of a Connection (the connection's `provider` MUST equal `type`). */
  connectionId: string;
  /** 'owner/name' for github, 'workspace/repo' for bitbucket. Comes from listRepos. */
  slug: string;
}

export interface TicketsConfig {
  source: TicketSource;
  /**
   * JQL override. Optional — when omitted, the poller uses
   * `project = "{ticketsProjectKey}"` as the default.
   */
  query?: string;
  /** ID of a Connection (provider === source). */
  connectionId: string;
  /** Jira project key (e.g. 'PROJ'). */
  projectKey: string;
}
```

Removed fields (drift guard MUST reject these):
- `RepoConfig.host`, `RepoConfig.tokenRef`
- `TicketsConfig.host`, `TicketsConfig.email`, `TicketsConfig.tokenRef`

### Validator updates (exact)

In `validateRepo`:
- Drop `tokenRef` handling.
- Add: `connectionId` required, non-empty string.
- Add: `slug` required, non-empty string. No format validation here (the picker is the source of truth — bad slugs can't get into the form).
- Drop the `host` field handling.

In `validateTickets`:
- Drop `tokenRef`, `email`, `host` handling.
- Make `query` OPTIONAL (was required). If present, must be a non-empty string after trim.
- Add: `connectionId` required, non-empty string.
- Add: `projectKey` required, non-empty string.

Add a new validation code: `MISMATCHED_PROVIDER` reserved for future cross-checks; not used in this validator (the validator is renderer-safe and can't consult ConnectionStore — main verifies on create/update).

### `JiraClient.listProjects()` (exact)

Add to `src/main/modules/jira-client.ts`:

```ts
export interface JiraProjectSummary {
  key: string;        // 'PROJ'
  name: string;       // 'Project name'
  /** 'project' kind shortname for the type — Cloud only; optional. */
  projectTypeKey?: string;
}

// On JiraClient:
async listProjects(): Promise<JiraResult<JiraProjectSummary[]>>;
```

GET `${host}/rest/api/3/project/search?maxResults=100&orderBy=key`. Maps each item to `{ key, name, projectTypeKey? }`.

Same security rules as `search()`/`testConnection()`: token NEVER in error.message, no forwarding from http layer.

### IPC contract additions (exact)

`src/shared/ipc.ts`:

```ts
CONNECTIONS_LIST_REPOS: 'connections:list-repos',
CONNECTIONS_LIST_JIRA_PROJECTS: 'connections:list-jira-projects',
```

Types:

```ts
export interface ConnectionsListReposRequest { connectionId: string }
export interface ConnectionsListReposResponse {
  repos: Array<{ slug: string; defaultBranch: string; private: boolean }>;
}
export interface ConnectionsListJiraProjectsRequest { connectionId: string }
export interface ConnectionsListJiraProjectsResponse {
  projects: Array<{ key: string; name: string }>;
}

// IpcApi.connections gains:
listRepos: (req: ConnectionsListReposRequest) => Promise<IpcResult<ConnectionsListReposResponse>>;
listJiraProjects: (req: ConnectionsListJiraProjectsRequest) => Promise<IpcResult<ConnectionsListJiraProjectsResponse>>;
```

Behavior in main: validate the request, look up the connection by id, fetch the secret, build a fresh client (`GithubClient` for repos / `JiraClient` for projects), call `listRepos` / `listProjects`. Return the typed result. If connection not found → `NOT_FOUND`. If wrong provider → `INVALID_PROVIDER`.

### JiraPoller refactor (exact)

`src/main/modules/jira-poller.ts`:

- `JiraPollerOptions` gains `connectionStore: { get(id): Promise<{ ok: true; data: Connection } | { ok: false; error: ... }> }`.
- The auth resolution block (currently reads `project.tickets.tokenRef` + `project.tickets.email`) becomes:
  1. Read `connectionId = project.tickets.connectionId`
  2. `connectionRes = await connectionStore.get(connectionId)`. If `!ok` → `handleError(state, 'NO_TOKEN', ...)` with a CONNECTION_NOT_FOUND-style message.
  3. Read `host = connectionRes.data.host`. (No more reading `project.tickets.host`.)
  4. `secretRes = await secretsManager.get(connectionRes.data.secretRef)`. If `!ok` → `handleError(...)` with a NO_TOKEN-style message.
  5. Split `secretRes.data.plaintext` on the FIRST `\n`. If no `\n`, treat the whole value as the token and email as `''` (the connections:test handler does the inverse pairing on save). For Jira `api-token` connections this should always have a `\n`; defense-in-depth fallback.
  6. Construct the JiraClient with `{ httpClient, host, auth: { email, apiToken } }`.
- The query passed to `client.search()` is `project.tickets.query ?? `project = "${project.tickets.projectKey}"``.
- Remove the `project.tickets.host` reads from the host construction.

### ProjectStore changes

`src/main/modules/project-store.ts`:

- Drop the cascade-secret-delete logic in `delete()` (the `refsToDelete` Set + `secretsManager.delete(ref)` loop). Project records no longer carry secret refs.
- The constructor still takes a `secretsManager: Pick<SecretsManager, 'delete'>` for backwards compat; we just don't call it. Optionally remove the param entirely — slightly cleaner. Mark this in the spec: **DO** remove it; clean break.

### Main wiring (`src/main/index.ts`)

- Pass `connectionStore` into `JiraPoller`'s constructor.
- Update the `ConnectionStore`'s `getReferencingProjectIds` callback (currently `async () => []`) to:
  ```ts
  getReferencingProjectIds: async (connectionId) => {
    if (!projectStore) return [];
    const list = await projectStore.list();
    if (!list.ok) return [];
    return list.data
      .filter((p) => p.repo.connectionId === connectionId || p.tickets.connectionId === connectionId)
      .map((p) => p.id);
  };
  ```
- Register two new IPC handlers (`CONNECTIONS_LIST_REPOS`, `CONNECTIONS_LIST_JIRA_PROJECTS`).
- Validate request shape in each handler (mirror existing pattern with `validateXxxRequest`).

### Renderer — `useConnectionRepos` / `useConnectionJiraProjects` hooks

`src/renderer/state/connection-resources.ts`:

```ts
export interface RepoSummary { slug: string; defaultBranch: string; private: boolean }
export interface JiraProjectSummary { key: string; name: string }

export interface UseConnectionResourceState<T> {
  data: ReadonlyArray<T>;
  loading: boolean;
  error: string | null;
  /** Fetches (or re-fetches if already cached). */
  refresh: () => Promise<void>;
}

export function useConnectionRepos(connectionId: string | null): UseConnectionResourceState<RepoSummary>;
export function useConnectionJiraProjects(connectionId: string | null): UseConnectionResourceState<JiraProjectSummary>;
```

Behavior:
- When `connectionId === null`, returns `{ data: [], loading: false, error: null, refresh: noop }`.
- On mount (or when `connectionId` changes to non-null), calls the IPC.
- Per-session in-memory cache keyed by `connectionId` (a `Map`-style ref shared across hook instances). If the cache has an entry, render it immediately and DO NOT re-fetch. `refresh()` clears the cache and re-fetches.
- Per-effect `cancelled` closure flag.
- Handles `window.api === undefined` gracefully.

### `<AddProject>` rewrite (exact)

Sections (in order):

**1. Basic Info**
- Project Name (Input) — unchanged

**2. Source**
- Description: "Pick a GitHub connection and the repository this project tracks."
- Connection picker: `<Dropdown options={githubConnections.map(...)}>`. Empty state: if `githubConnections.length === 0`, show an EmptyState card "No GitHub connections yet" with an "Add GitHub connection" button that opens `<AddConnectionDialog>` inline (provider preselected to `github`).
- Repo picker: `<Dropdown>` populated from `useConnectionRepos(repoConnectionId)`. Disabled until a connection is picked. Loading spinner inside the dropdown trigger when `loading`. "No repositories visible to this token" empty state. Each option shows `slug` (mono).
- Refresh button next to the Repo picker label: calls `useConnectionRepos.refresh()`.
- Local Path (Input, mono, absolute path) — unchanged
- Base Branch (Input, mono) — unchanged

**3. Tickets**
- Description: "Pick a Jira connection and the project tickets are pulled from."
- Connection picker: `<Dropdown options={jiraConnections.map(...)}>`. Empty state: same pattern as Source's.
- Project picker: `<Dropdown>` populated from `useConnectionJiraProjects(ticketsConnectionId)`. Each option shows `${key} — ${name}`.
- Refresh button next to the Project picker label.
- JQL Override (Textarea, optional) — placeholder: `(defaults to project = "{key}" if empty)`.

**4. Workflow** — unchanged (mode dropdown + branchFormat input).

Action bar (footer): Cancel + Create Project. The page-bottom "Test connection" button is REMOVED — the Connections page already covers the Test Connection flow per-connection; the project form trusts the connection's stored verification status.

testids:
- `field-name`, `field-repo-connection`, `field-repo-slug`, `field-repo-local-path`, `field-repo-base-branch`
- `field-tickets-connection`, `field-tickets-project-key`, `field-ticket-query`
- `field-workflow-mode`, `field-branch-format`
- `add-project-source-empty` (empty-state CTA), `add-project-tickets-empty`
- `add-project-repo-refresh`, `add-project-jira-projects-refresh`

### `<AddProject>` form-state shape (exact)

```ts
interface FormState {
  name: string;
  repoConnectionId: string;     // empty until picked
  repoSlug: string;             // empty until picked
  repoLocalPath: string;
  repoBaseBranch: string;
  ticketsConnectionId: string;
  ticketsProjectKey: string;
  ticketQuery: string;          // optional JQL override
  workflowMode: 'interactive' | 'yolo';
  branchFormat: string;
}
```

When the user changes `repoConnectionId`, reset `repoSlug` to '' (the new connection's repo list is different).
When the user changes `ticketsConnectionId`, reset `ticketsProjectKey` to ''.

Build the input on submit:

```ts
const input: ProjectInstanceInput = {
  name: form.name,
  repo: {
    type: derivedFromConnection.provider,    // 'github' or 'bitbucket'
    localPath: form.repoLocalPath,
    baseBranch: form.repoBaseBranch,
    connectionId: form.repoConnectionId,
    slug: form.repoSlug,
  },
  tickets: {
    source: 'jira',                          // future: derive from connection
    connectionId: form.ticketsConnectionId,
    projectKey: form.ticketsProjectKey,
    ...(form.ticketQuery.trim() ? { query: form.ticketQuery } : {}),
  },
  workflow: { mode: form.workflowMode, branchFormat: form.branchFormat },
};
```

The repo `type` is derived from the picked connection's provider. (The user no longer picks "GitHub vs Bitbucket" separately — the connection IS the provider.)

### EditProject mode

- Pre-select connection + slug/projectKey from the existing project record.
- If `repoConnectionId` no longer matches any connection (or its provider mismatches `repo.type`), show a yellow banner "The connection used for the source repo was removed. Please pick a new one." Force re-pick before Save is enabled. Same for tickets.
- testid: `add-project-broken-connection-banner`.

### ConnectionStore.delete + IN_USE

Already plumbed in #24. With this PR, `getReferencingProjectIds` is wired up so deleting a referenced connection truly fails with `IN_USE` and `details.referencedBy = [projectId, ...]`. The Connections view already surfaces the referencing IDs in the delete-confirm dialog (no UI change needed there).

## Business Rules

1. **Schema break is unconditional.** Pre-MVP, no migration. Validator REJECTS old fields (`host`, `email`, `tokenRef` on repo/tickets) — drift guard.
2. **Repo type is derived from the connection's provider** at form submit. The user doesn't pick repo type independently. (When OAuth flows for Bitbucket land in #27, this stays correct.)
3. **JQL override is optional.** Defaults to `project = "{ticketsProjectKey}"` at poll time inside JiraPoller.
4. **Resource lists are cached per session** keyed by `connectionId`. Refresh clears the entry and re-fetches.
5. **Empty-state CTAs** for "no connections of this provider yet" open `<AddConnectionDialog>` inline with the provider preselected.
6. **EditProject** with a missing/mismatched connection forces re-pick before Save.
7. **JiraPoller resolves auth at poll time via the connection's host + secret.** No project-side credential capture.
8. **ProjectStore.delete no longer cascades** to SecretsManager — secrets belong to connections, not projects.
9. **Plaintext never crosses IPC** for resource listing. The handler reads the secret server-side, builds a client, and returns only the resource summary (slug + branch, or key + name).
10. **All interactive elements** carry `data-testid`.

## API Acceptance Tests

### Schema (PROJ-SCH-XXX, REVISED)

| ID | Scenario | Expected |
|----|----------|----------|
| PROJ-SCH-001 | `validateProjectInstance` accepts a record with `repo.connectionId + repo.slug` and no host/tokenRef | ok |
| PROJ-SCH-002 | Drift guard: `host` on repo or tickets → INVALID_ENUM/REQUIRED-style error | true |
| PROJ-SCH-003 | Drift guard: `tokenRef` on repo or tickets → reject | true |
| PROJ-SCH-004 | Drift guard: `email` on tickets → reject | true |
| PROJ-SCH-005 | Missing `repo.connectionId` → REQUIRED | true |
| PROJ-SCH-006 | Missing `repo.slug` → REQUIRED | true |
| PROJ-SCH-007 | Missing `tickets.connectionId` → REQUIRED | true |
| PROJ-SCH-008 | Missing `tickets.projectKey` → REQUIRED | true |
| PROJ-SCH-009 | Empty `tickets.query` is OK (optional now) | true |
| PROJ-SCH-010 | `tickets.query` if present must be non-empty after trim | true |

### ProjectStore (PS-XXX, REVISED subset)

| ID | Scenario | Expected |
|----|----------|----------|
| PS-DEL-NO-CASCADE | `delete()` no longer calls `secretsManager.delete` | secretsManager not called |
| PS-CREATE-NEW-FIELDS | `create()` accepts the new RepoConfig + TicketsConfig shape | ok |
| (existing init / list / get / update tests) | Use the new fixture shape — should pass unchanged | true |

### JiraClient (JC-XXX additions)

| ID | Scenario | Expected |
|----|----------|----------|
| JC-LP-001 | `listProjects()` GETs `${host}/rest/api/3/project/search?maxResults=100&orderBy=key` | true |
| JC-LP-002 | 200 with valid body → array of `{ key, name }` | true |
| JC-LP-003 | 200 with malformed body → INVALID_RESPONSE | true |
| JC-LP-004 | 401/403/404/429/5xx → AUTH/NOT_FOUND/RATE_LIMITED/SERVER_ERROR | true |
| JC-LP-005 | Token never appears in error.message | true |

### JiraPoller (JP-XXX, REVISED)

| ID | Scenario | Expected |
|----|----------|----------|
| JP-CONN-001 | Auth resolved via `project.tickets.connectionId` → ConnectionStore.get | mock called with the right id |
| JP-CONN-002 | Connection not found → NO_TOKEN error event | true |
| JP-CONN-003 | Secret not found → NO_TOKEN | true |
| JP-CONN-004 | Secret with no `\n` → still tries (treats whole as token, email='') and fails on AUTH eventually | true |
| JP-CONN-005 | JQL falls back to `project = "{key}"` when `tickets.query` is undefined | search called with the default JQL |
| JP-CONN-006 | host comes from connection.host, not project.tickets.host (which doesn't exist anymore) | client constructed with connection's host |

### IPC contract (IPC-XXX additions)

| ID | Scenario | Expected |
|----|----------|----------|
| IPC-CONN-LR-001 | `CONNECTIONS_LIST_REPOS === 'connections:list-repos'` | true |
| IPC-CONN-LR-002 | `IpcApi.connections.listRepos` typed as `(req) => Promise<IpcResult<{ repos }>>` | true |
| IPC-CONN-LJP-001 | `CONNECTIONS_LIST_JIRA_PROJECTS === 'connections:list-jira-projects'` | true |
| IPC-CONN-LJP-002 | `IpcApi.connections.listJiraProjects` typed correctly | true |
| IPC-PROJ-DRIFT | Project schema drift guard: old fields rejected (validator-level) | true |

### Connection store (CONN-STORE-XXX update)

| ID | Scenario | Expected |
|----|----------|----------|
| CONN-STORE-IN-USE-WIRED | When `getReferencingProjectIds` returns ['p1','p2'], delete fails with IN_USE and details.referencedBy=['p1','p2'] | (already covered by CONN-STORE-012; no test changes here) |

### Renderer hook — useConnectionRepos / useConnectionJiraProjects (CONN-RES-HOOK-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| CONN-RES-HOOK-001 | When connectionId is null → idle (no IPC call) | true |
| CONN-RES-HOOK-002 | When connectionId set → calls listRepos / listJiraProjects | true |
| CONN-RES-HOOK-003 | Returns the data on success | true |
| CONN-RES-HOOK-004 | Surfaces error message on failure | true |
| CONN-RES-HOOK-005 | Per-session cache: second hook with same id doesn't re-fetch | true |
| CONN-RES-HOOK-006 | refresh() clears the cache entry and re-fetches | true |
| CONN-RES-HOOK-007 | window.api === undefined → loading false, error set | true |

### AddProject view (ADD-PROJ-XXX, REVISED)

| ID | Scenario | Expected |
|----|----------|----------|
| ADD-PROJ-001 | Renders Source section with connection picker | testid `field-repo-connection` present |
| ADD-PROJ-002 | Renders Tickets section with connection picker | testid `field-tickets-connection` present |
| ADD-PROJ-003 | Source empty-state when no GitHub connections | `add-project-source-empty` testid + Add GitHub Connection button |
| ADD-PROJ-004 | Picking a GitHub connection populates the repo dropdown via listRepos | mock called once |
| ADD-PROJ-005 | Picking a Jira connection populates the project dropdown via listJiraProjects | mock called once |
| ADD-PROJ-006 | Refresh button on repo picker re-calls listRepos | mock called twice |
| ADD-PROJ-007 | Submit builds ProjectInstanceInput with the new shape | repo.connectionId / repo.slug / tickets.connectionId / tickets.projectKey present |
| ADD-PROJ-008 | Submit derives repo.type from the picked GitHub connection's provider ('github') | true |
| ADD-PROJ-009 | Empty JQL → query field omitted from input | true |
| ADD-PROJ-010 | EditProject with missing connection → broken-connection banner shown, Save disabled | true |
| ADD-PROJ-011 | All field testids present (per testid list above) | true |

## Manual verification (after PR)
- [ ] Add a GitHub PAT connection (via #24 Connections page)
- [ ] Add a Jira API-token connection
- [ ] Click Add Project → Source picker shows the GitHub connection → pick it → repo dropdown lists the user's repos
- [ ] Tickets picker shows the Jira connection → pick it → project dropdown lists Jira projects
- [ ] Save → project persists with new schema
- [ ] Edit the project → pickers pre-select correctly
- [ ] Delete the GitHub connection → the Connections page surfaces "Used by: <project-id>" and refuses delete
- [ ] Re-edit the project, pick a different connection, save → works

## Test Status
- [ ] PROJ-SCH-001..010
- [ ] PS-DEL-NO-CASCADE / PS-CREATE-NEW-FIELDS
- [ ] JC-LP-001..005
- [ ] JP-CONN-001..006
- [ ] IPC-CONN-LR-001..002 / IPC-CONN-LJP-001..002 / IPC-PROJ-DRIFT
- [ ] CONN-RES-HOOK-001..007
- [ ] ADD-PROJ-001..011
- [ ] All prior tests still pass
- [ ] `npm run lint`: 0
- [ ] `npm run typecheck`: 0
- [ ] `npm run build`: clean
