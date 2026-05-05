# Jira Client + Ticket Polling — Acceptance Criteria

## Description (client-readable)
A main-process Jira REST API client and a per-project poller that runs each project's JQL on a configurable interval (default 5 min), filters out already-processed and currently-running tickets, and broadcasts ticket-list changes to the renderer over typed IPC. Built around an injected `HttpClient` so unit tests run with a fake — no real Jira host needed in CI.

## Adaptation Note
This is a **backend-only** feature. The renderer-facing surface is `window.api.jira.*`. UI lands in #6.

## Interface Contract

### Tech Stack (locked)
- Node 22's global `fetch` (no axios / undici dep)
- TypeScript strict
- Vitest 2 — no real Jira calls; all tests use `FakeHttpClient`

### File Structure (exact)
```
src/
├── main/
│   ├── index.ts                          # extend (instantiate poller, register handlers)
│   └── modules/
│       ├── http-client.ts                # HttpClient + FetchHttpClient + FakeHttpClient
│       ├── jira-client.ts                # JiraClient class
│       ├── run-history.ts                # RunHistory class
│       └── jira-poller.ts                # JiraPoller class
├── preload/
│   └── index.ts                          # extend window.api.jira
└── shared/
    ├── ipc.ts                            # extend with jira:* channels + types
    └── schema/
        └── ticket.ts                     # Ticket type + validator

tests/
└── unit/
    ├── http-client.test.ts
    ├── jira-client.test.ts
    ├── run-history.test.ts
    ├── jira-poller.test.ts
    ├── ticket-schema.test.ts
    └── ipc-contract-jira.test.ts
```

### HttpClient Interface (exact)

File: `src/main/modules/http-client.ts`

```ts
export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  headers?: Readonly<Record<string, string>>;
  body?: string;
  /** ms; aborted if exceeded. Default 30_000. */
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  /** Already-decoded text body. Caller parses JSON. */
  body: string;
}

export type HttpResult =
  | { ok: true; response: HttpResponse }
  | { ok: false; error: { code: HttpErrorCode; message: string; status?: number } };

export type HttpErrorCode =
  | 'NETWORK'              // connection refused, DNS failure, etc.
  | 'TIMEOUT'              // request exceeded timeoutMs
  | 'ABORTED'              // caller-side abort
  | 'INVALID_RESPONSE';    // body could not be read

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResult>;
}

export class FetchHttpClient implements HttpClient { /* wraps global fetch */ }

/**
 * Test double — never makes a real HTTP call. Tests register canned responses
 * keyed by `${method} ${url}` (e.g. "GET https://example.atlassian.net/rest/api/3/myself").
 * Unmatched requests return a NETWORK error with a clear message.
 */
export class FakeHttpClient implements HttpClient {
  /** Register a canned response for an exact method+url match. */
  expect(method: HttpRequest['method'], url: string, response: HttpResult): void;
  /** Register a canned response that matches when the URL starts with `prefix`. */
  expectPrefix(method: HttpRequest['method'], prefix: string, response: HttpResult): void;
  /** Every call recorded in invocation order. */
  readonly calls: ReadonlyArray<HttpRequest>;
  /** Reset all expectations and call log. */
  reset(): void;
}
```

### Ticket Schema (exact)

File: `src/shared/schema/ticket.ts`

```ts
export interface Ticket {
  /** e.g. "ABC-123" — Jira issue key. */
  key: string;
  /** Issue title / summary. */
  summary: string;
  /** Display name of the status (e.g. "Ready for AI", "In Review"). */
  status: string;
  /** Display name of the priority (e.g. "High", "Medium", "Low"). */
  priority: string;
  /** Display name of the assignee, or null if unassigned. */
  assignee: string | null;
  /** ISO 8601 string from Jira (e.g. "2026-05-05T03:30:00.000+0000"). */
  updatedAt: string;
  /** Browse URL — `${host}/browse/${key}`. */
  url: string;
}

/**
 * Maps a single Jira issue JSON object (from /rest/api/3/search response)
 * to our Ticket shape. Tolerant of missing optional fields — falls back to
 * sensible defaults (`"Unknown"` for status/priority, null for assignee).
 *
 * Returns null if the input doesn't look like a Jira issue at all (e.g. no
 * `key` or `fields`).
 */
export function ticketFromJiraIssue(input: unknown, host: string): Ticket | null;
```

### JiraClient (exact)

File: `src/main/modules/jira-client.ts`

```ts
export interface JiraAuth {
  /** User email (Jira Cloud uses email + API token; Server users put their username here). */
  email: string;
  /** API token / PAT. NEVER logged. */
  apiToken: string;
}

export interface JiraClientOptions {
  httpClient: HttpClient;
  /** Base URL like "https://example.atlassian.net" — no trailing slash. */
  host: string;
  auth: JiraAuth;
}

export type JiraErrorCode =
  | 'NETWORK'
  | 'TIMEOUT'
  | 'AUTH'                 // 401 / 403
  | 'NOT_FOUND'            // 404
  | 'RATE_LIMITED'         // 429
  | 'SERVER_ERROR'         // 5xx
  | 'INVALID_RESPONSE';    // unparseable body

export type JiraResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: JiraErrorCode; message: string; status?: number } };

export interface JiraSearchOptions {
  /** Defaults to 50. Jira max is 100. */
  maxResults?: number;
  /** Fields to fetch. Defaults to ['summary','status','priority','assignee','updated']. */
  fields?: ReadonlyArray<string>;
}

export interface JiraSearchResponse {
  total: number;
  tickets: Ticket[];
}

export interface JiraSelfResponse {
  /** "accountId" on Cloud, "name" on Server. */
  accountId: string;
  displayName: string;
  emailAddress: string;
}

export class JiraClient {
  constructor(options: JiraClientOptions);

  /** GET /rest/api/3/search — runs JQL and returns mapped Tickets. */
  search(jql: string, opts?: JiraSearchOptions): Promise<JiraResult<JiraSearchResponse>>;

  /** GET /rest/api/3/myself — verifies credentials. */
  testConnection(): Promise<JiraResult<JiraSelfResponse>>;
}
```

Behavior contract:
- **Auth header**: `Authorization: Basic ${base64(email + ':' + apiToken)}`. Set on every request.
- **`Accept: application/json`** on every request.
- **Status mapping** (any non-2xx):
  - 401, 403 → `AUTH`
  - 404 → `NOT_FOUND`
  - 429 → `RATE_LIMITED`
  - 5xx → `SERVER_ERROR`
  - other 4xx → `AUTH` if status in {401, 403} else `INVALID_RESPONSE`
- **Network/timeout** errors propagate as `NETWORK` / `TIMEOUT`.
- **URL building**: search uses `${host}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=${n}&fields=${fields.join(',')}`.
- **Never logs `apiToken`** — not in error messages, not in console output.

### RunHistory (exact)

File: `src/main/modules/run-history.ts`

```ts
export interface RunHistoryOptions {
  /** Absolute path to run-history.json. */
  filePath: string;
  fs?: ProjectStoreFs;  // imported from project-store.ts
}

export type RunHistoryErrorCode =
  | 'IO_FAILURE'
  | 'CORRUPT'
  | 'UNSUPPORTED_SCHEMA_VERSION';

export type RunHistoryResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: RunHistoryErrorCode; message: string } };

export class RunHistory {
  constructor(options: RunHistoryOptions);
  init(): Promise<RunHistoryResult<{ projectCount: number }>>;
  markRunning(projectId: string, key: string): Promise<RunHistoryResult<void>>;
  clearRunning(projectId: string, key: string): Promise<RunHistoryResult<void>>;
  markProcessed(projectId: string, key: string): Promise<RunHistoryResult<void>>;
  /** Returns processed keys for a project (empty array if none). Sync read against in-memory state. */
  getProcessed(projectId: string): ReadonlyArray<string>;
  /** Returns running keys for a project. */
  getRunning(projectId: string): ReadonlyArray<string>;
  /** Removes all history for a project (cascade from project deletion). */
  removeProject(projectId: string): Promise<RunHistoryResult<void>>;
}
```

File envelope (exact):
```json
{
  "schemaVersion": 1,
  "runs": {
    "<projectId>": { "processed": ["ABC-1","ABC-2"], "running": ["ABC-3"] }
  }
}
```

Behavior:
- Atomic writes (mirror #3 `ProjectStore` pattern: temp + rename).
- Write mutex (Promise chain) for concurrent calls.
- Missing file → empty store, no error.
- `init()` rejects unknown `schemaVersion` with `UNSUPPORTED_SCHEMA_VERSION`.
- All mutators are idempotent (marking already-marked key is a no-op write).

### JiraPoller (exact)

File: `src/main/modules/jira-poller.ts`

```ts
export interface JiraPollerOptions {
  projectStore: { list(): Promise<{ ok: true; data: ProjectInstance[] } | { ok: false; error: unknown }> };
  secretsManager: { get(ref: string): Promise<{ ok: true; data: { plaintext: string } } | { ok: false; error: unknown }> };
  runHistory: RunHistory;
  /**
   * Build a JiraClient for a given project. Default uses `FetchHttpClient`.
   * Tests can override to inject a `FakeHttpClient`.
   */
  jiraClientFactory?: (project: ProjectInstance, auth: JiraAuth) => JiraClient;
  /** Test injection for setInterval / clearInterval. Default uses globalThis. */
  timers?: PollerTimers;
}

export interface PollerTimers {
  setInterval: (cb: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

export interface PollerErrorEvent {
  projectId: string;
  code: 'AUTH' | 'NETWORK' | 'TIMEOUT' | 'RATE_LIMITED' | 'SERVER_ERROR' | 'NO_TOKEN' | 'PROJECT_NOT_FOUND' | 'INVALID_RESPONSE';
  message: string;
  /** Number of consecutive errors before this one (back-off counter). */
  consecutiveErrors: number;
}

export interface TicketsChangedEvent {
  projectId: string;
  tickets: Ticket[];
  timestamp: number;
}

export class JiraPoller extends EventEmitter {
  constructor(options: JiraPollerOptions);

  /** Starts polling a project. If already started, restarts with the new interval. */
  start(project: ProjectInstance, intervalMs?: number): Promise<JiraResult<{ projectId: string }>>;

  /** Stops polling a project. Idempotent. */
  stop(projectId: string): void;

  /** Stops all pollers and clears state. Used on app shutdown. */
  stopAll(): void;

  /** Triggers a poll right now. Resolves once the poll finishes (or fails). */
  refreshNow(projectId: string): Promise<JiraResult<{ tickets: Ticket[] }>>;

  /** Returns the cached eligible tickets (last poll result minus running/processed). */
  list(projectId: string): ReadonlyArray<Ticket>;

  /** Verifies credentials without storing anything. */
  testConnection(opts: { host: string; auth: JiraAuth }): Promise<JiraResult<JiraSelfResponse>>;

  on(event: 'tickets-changed', listener: (e: TicketsChangedEvent) => void): this;
  on(event: 'error', listener: (e: PollerErrorEvent) => void): this;
}
```

Behavior contract:
- **Per-project mutex**: a poll for project P that is already in flight when its tick fires is silently skipped (does NOT queue).
- **Eligibility filter**: a ticket from the JQL response is "eligible" if `key ∉ runHistory.getProcessed(projectId) AND key ∉ runHistory.getRunning(projectId)`.
- **Cache**: after each successful poll, the poller stores the eligible tickets per project. `list()` reads this cache.
- **Diff detection**: emits `tickets-changed` only when the set of eligible ticket keys (or any visible field) differs from the previous cached array. Identical results = no event.
- **Back-off on error**: track consecutive error count per project. On error, the next interval is delayed by `min(intervalMs * 2^errors, intervalMs * 16)`. Reset to 0 on first success.
- **Auth errors don't back off** — they short-circuit the poller. The poller stops scheduling new polls for that project until `start()` is called again with new credentials. (Spec rule 11.)
- **JQL is read from the project at each poll** — if the project is updated mid-flight, the next tick uses the new JQL.
- **Resolve secrets at poll time**: `tickets.tokenRef` resolved via `secretsManager.get(ref)`. If `tokenRef` is empty/missing or secrets backend is unavailable, emit `error` with code `NO_TOKEN` and skip the poll.
- **Project lookup via store**: each poll calls `projectStore.list()` and finds the project by id. If gone, emit `error` with `PROJECT_NOT_FOUND` and stop polling that project.
- **Email source**: `auth.email` comes from the project config — for MVP, use a convention: store email at `repo.tokenRef` won't fit; instead, store the email directly in `tickets` config field (extend `TicketsConfig`). **Schema impact**: this issue extends `TicketsConfig` with a new optional `email?: string` field. Ratio: small additive change, doesn't break existing data.

### IPC Contract Extension (exact)

File: `src/shared/ipc.ts` — extend `IPC_CHANNELS`:
```ts
JIRA_LIST: 'jira:list',
JIRA_REFRESH: 'jira:refresh',
JIRA_TEST_CONNECTION: 'jira:test-connection',
JIRA_REFRESH_POLLERS: 'jira:refresh-pollers',  // re-syncs pollers after project create/update/delete
JIRA_TICKETS_CHANGED: 'jira:tickets-changed',  // event channel
JIRA_ERROR: 'jira:error',                      // event channel
```

Add types:
```ts
export interface JiraListRequest { projectId: string }
export interface JiraListResponse { tickets: TicketDto[] }
export interface JiraRefreshRequest { projectId: string }
export interface JiraRefreshResponse { tickets: TicketDto[] }
export interface JiraTestConnectionRequest { host: string; email: string; apiToken: string }
export interface JiraTestConnectionResponse { accountId: string; displayName: string; emailAddress: string }
export interface JiraTicketsChangedEvent { projectId: string; tickets: TicketDto[]; timestamp: number }
export interface JiraErrorEvent { projectId: string; code: string; message: string; consecutiveErrors: number }
```

Re-export `Ticket` as `TicketDto` from `ipc.ts`.

Extend `IpcApi`:
```ts
jira: {
  list: (req: JiraListRequest) => Promise<IpcResult<JiraListResponse>>;
  refresh: (req: JiraRefreshRequest) => Promise<IpcResult<JiraRefreshResponse>>;
  testConnection: (req: JiraTestConnectionRequest) => Promise<IpcResult<JiraTestConnectionResponse>>;
  refreshPollers: () => Promise<IpcResult<{ projectIds: string[] }>>;
  onTicketsChanged: (listener: (e: JiraTicketsChangedEvent) => void) => () => void;
  onError: (listener: (e: JiraErrorEvent) => void) => () => void;
};
```

### TicketsConfig schema extension (exact)

`src/shared/schema/project-instance.ts` — add optional `email` field:
```ts
export interface TicketsConfig {
  source: TicketSource;
  query: string;
  tokenRef?: string;
  /** Jira account email — needed for Basic auth alongside the apiToken stored at tokenRef. */
  email?: string;
}
```

The validator does NOT make this required (existing projects without it remain valid; the poller emits a `NO_TOKEN`-equivalent error if email is missing when tokenRef is set).

### Main process wiring

File: `src/main/index.ts` — extend with:
- After `RunHistory.init()`, `JiraPoller` constructed with the same projectStore + secretsManager refs from #3
- On app-ready, after stores are initialized: `for (const p of (await projectStore.list()).data ?? []) await poller.start(p, 5*60_000)`
- Register 4 invoke handlers + wire 2 events to renderer (`broadcastToWindows` reused from #2)
- On `app.before-quit`: `poller.stopAll()` to clear timers cleanly

## Business Rules
1. **Eligibility**: ticket is eligible iff returned by JQL AND `!processed` AND `!running` for that project.
2. **Diff before broadcast**: `tickets-changed` fires only when the eligible-key list changes (deep field diff is fine if cheap; deduping by key is acceptable).
3. **Per-project isolation**: cached tickets, running state, processed state, and timer are all keyed by `projectId`. Never mix.
4. **Auth errors stop the poller** for that project. The user must update creds and call `refreshPollers` (or restart the app).
5. **Back-off on transient errors**: NETWORK / TIMEOUT / RATE_LIMITED / SERVER_ERROR — exponential up to 16x, reset on success.
6. **No real Jira in tests**: the unit test suite must NEVER hit a real network. Inject `FakeHttpClient`.
7. **No plaintext token in logs / errors**: error messages from JiraClient must not include the apiToken.
8. **Poll mutex per project**: if a poll takes longer than `intervalMs`, the next tick is dropped (not queued).
9. **Schema versioning**: `run-history.json` uses `{ schemaVersion: 1, runs: { ... } }`. Unknown versions reject.
10. **Cascade clean-up**: removing a project (#3) should also clear its run history. (`RunHistory.removeProject(id)` is exposed; #3's delete should call it. We'll thread that wiring through `src/main/index.ts` here, NOT by modifying #3's `ProjectStore.delete` signature — keep #3 untouched at the class level.)
11. **AppShutdown timer cleanup**: `stopAll()` clears every interval and disposes per-project state. Test-verifiable via fake timers.

## API Acceptance Tests

### HttpClient (HTTP-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| HTTP-001 | `FakeHttpClient.expect` registered → request matches → returns canned response | `request()` returns the canned `ok: true` |
| HTTP-002 | Unmatched request | `ok: false`, `code: 'NETWORK'`, message names the unmatched method+url |
| HTTP-003 | `expectPrefix` matches multiple URLs that start with prefix | each matching request returns the canned response |
| HTTP-004 | `calls` records every invocation in order | array length and content match |
| HTTP-005 | `reset()` clears expectations and calls | subsequent unmatched request returns NETWORK error |

### JiraClient (JIRA-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| JIRA-001 | `search()` happy path with stubbed Jira response | returns `ok: true`, `tickets` length matches mock; each ticket has key/summary/status/priority/assignee/updatedAt/url |
| JIRA-002 | `search()` JQL is URL-encoded in the outgoing request | recorded URL contains `jql=project%20%3D%20%22ABC%22` (or equivalent), NOT a raw `jql=project = "ABC"` |
| JIRA-003 | `search()` with extra spaces/quotes in JQL | URL-encoded correctly, no double-encoding |
| JIRA-004 | Auth header on every request | `Authorization: Basic ${base64('email:apiToken')}` |
| JIRA-005 | `search()` returns 401 | `ok: false`, `code: 'AUTH'`, status: 401 |
| JIRA-006 | `search()` returns 429 | `ok: false`, `code: 'RATE_LIMITED'` |
| JIRA-007 | `search()` returns 500 | `ok: false`, `code: 'SERVER_ERROR'` |
| JIRA-008 | `search()` returns 200 with malformed JSON | `ok: false`, `code: 'INVALID_RESPONSE'` |
| JIRA-009 | `testConnection()` happy path | `ok: true`, returns accountId/displayName/emailAddress |
| JIRA-010 | `testConnection()` 401 | `ok: false`, `code: 'AUTH'` |
| JIRA-011 | Error messages NEVER contain the apiToken substring | inject `apiToken: 'super-secret-token-XYZ'`, force every error path, assert no error.message includes that string |
| JIRA-012 | `search()` maps Jira issue with missing optional fields | `assignee: null`, `priority: 'Unknown'` (or similar default) — does NOT throw |

### RunHistory (RH-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| RH-001 | `init()` missing file | `ok: true`, `projectCount: 0` |
| RH-002 | `markRunning` then `getRunning` | array contains the key |
| RH-003 | `markProcessed` then `getProcessed` | array contains the key |
| RH-004 | `clearRunning` after `markRunning` | running array no longer contains the key |
| RH-005 | Multiple projects isolated | running on A doesn't bleed into B |
| RH-006 | Persistence — write then re-init | restored state matches |
| RH-007 | Atomic writes | fs sees temp+rename pattern |
| RH-008 | Idempotent: marking already-running key | second call returns ok, no spurious change |
| RH-009 | `removeProject` clears all keys for that project | running and processed empty for it; other projects untouched |
| RH-010 | `init()` with `schemaVersion: 99` | `ok: false`, `code: 'UNSUPPORTED_SCHEMA_VERSION'` |
| RH-011 | Concurrent `markRunning` calls (mutex) | both effects survive (no clobber) |

### JiraPoller (POLLER-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| POLLER-001 | `start()` then `refreshNow()` returns mock tickets | `tickets-changed` event fires once with the eligible tickets |
| POLLER-002 | Same JQL response twice → only ONE `tickets-changed` event | second poll yields no event (no diff) |
| POLLER-003 | Eligibility — running ticket is filtered out | if key X is in `runHistory.getRunning`, JQL response containing X yields tickets without X in the cached list |
| POLLER-004 | Eligibility — processed ticket is filtered out | if key X is in `runHistory.getProcessed`, same |
| POLLER-005 | Per-project mutex — overlapping ticks dropped | if a poll's response is delayed, the next interval tick is skipped (not queued) |
| POLLER-006 | Per-project isolation | start P1 + P2; only P1's tickets in P1's cache; only P2's in P2's |
| POLLER-007 | Auth error stops the poller | after a 401 response, the timer for that project is cleared; `error` event fires with `code: 'AUTH'` |
| POLLER-008 | Back-off on transient error | first 5xx → next interval is `intervalMs * 2`; second consecutive 5xx → `intervalMs * 4` (capped at 16x) |
| POLLER-009 | Back-off resets on success | after a 5xx then a 200, the next interval is `intervalMs` again |
| POLLER-010 | `stop()` clears the timer | no more ticks fire after `stop` |
| POLLER-011 | `stopAll()` clears all timers | no project polls after |
| POLLER-012 | `refreshNow()` works when no timer is active (start was never called) | runs the poll synchronously |
| POLLER-013 | `testConnection` returns the JiraSelfResponse from a mocked /myself | typed correctly |
| POLLER-014 | `NO_TOKEN` error when project has no `tickets.tokenRef` | poll skipped, error event fires with `code: 'NO_TOKEN'` |
| POLLER-015 | `PROJECT_NOT_FOUND` when project deleted between ticks | error event fires, poller stops scheduling for that id |

### Ticket schema (TICKET-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| TICKET-001 | Full Jira issue → fully populated Ticket | every field present and correct |
| TICKET-002 | Missing `priority` field | `priority: 'Unknown'` |
| TICKET-003 | Missing `assignee` (null in Jira) | `assignee: null` |
| TICKET-004 | URL is `${host}/browse/${key}` | exact match |
| TICKET-005 | Garbage input (no `key`, no `fields`) → null | `ticketFromJiraIssue(...)` returns null |

### IPC Contract (IPC-J-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| IPC-J-001 | New channel strings | `JIRA_LIST === 'jira:list'`, etc. (6 channels) |
| IPC-J-002 | `IpcApi.jira` shape | `expectTypeOf` for all 6 methods |
| IPC-J-003 | Regression — PING / claude:* / projects:* / secrets:* still present and correctly typed | drift check |
| IPC-J-004 | `TicketDto` re-exported from ipc.ts matches schema's `Ticket` | drift guard |

## E2E (Playwright) — Deferred
No new E2E. UI lands in #6.

## Test Status
- [x] HTTP-001..005: PASS (6 tests)
- [x] JIRA-001..012: PASS (21 tests)
- [x] RH-001..011: PASS (15 tests)
- [x] POLLER-001..015: PASS (17 tests; 5 needed reconciliation fixes — see Implementation Notes)
- [x] TICKET-001..005: PASS (13 tests)
- [x] IPC-J-001..004: PASS (27 tests)
- [x] Total project: **271/271 unit tests pass** (was 172/172 after #3; +99 new)
- [x] `npm run lint`: 0 / 0
- [x] `npm run typecheck`: 0
- [x] `npm run build`: clean — preload now 3.93 kB

## Implementation Notes (post-Agent-Team reconciliation)

5 poller tests required fixes after the initial Agent B run:

1. **`runPoll` no longer returns a stale cached `ok: true` when waiting on an in-flight poll.** The original logic had: if `state.inflight !== null`, await it and return `{ ok: true, data: cached }`. This swallowed errors from the in-flight poll. Replaced with: the mutex check lives entirely in `tick()` (which silently drops overlapping ticks), and `refreshNow` waits on any inflight before kicking off its own fresh poll.

2. **`refreshNow` now re-fetches state after the inflight wait** in case `stop()` ran during the await — guards against operating on a state that was removed mid-flight.

3. **`runPoll` aborts after every await if `stop()` ran**: a `stillTracked()` helper compares `this.states.get(projectId)` against the original state reference. If they differ (or state is undefined), the poll exits without making the HTTP search request, without emitting events, and without mutating state. This fixes POLLER-010's "no further ticks fire after stop" — previously the in-flight tick from `start()`'s immediate poll would still issue an HTTP request even after `stop()` cleared the timer.

## Manual verification (developer, after PR)
- [ ] `npm run dev` still works (regression on #1)
- [ ] (Optional, with real Jira) DevTools: `await window.api.jira.testConnection({ host, email, apiToken })` returns `ok: true`
- [ ] (Optional) Create a project with a Jira tokenRef + email, set the token via `secrets.set`, observe ticket polling logs in the main process console
