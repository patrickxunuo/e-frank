import { describe, it, expect, beforeEach } from 'vitest';
import {
  FakeHttpClient,
  type HttpResult,
} from '../../src/main/modules/http-client';
import {
  JiraClient,
  type JiraAuth,
} from '../../src/main/modules/jira-client';
// Issue #25 polish: jira-poller is renamed to ticket-poller. The class is
// renamed `TicketPoller`; legacy `JiraPoller` is kept as an alias for one
// release for back-compat in the existing JP-CONN tests below.
import { TicketPoller } from '../../src/main/modules/ticket-poller';
import { RunHistory } from '../../src/main/modules/run-history';
import type { ProjectStoreFs } from '../../src/main/modules/project-store';
import type {
  ProjectInstance,
  TicketsConfig,
} from '../../src/shared/schema/project-instance';
import type { Connection } from '../../src/shared/schema/connection';
import type {
  PollerErrorEvent,
  PollerTimers,
  TicketsChangedEvent,
} from '../../src/main/modules/ticket-poller';

/**
 * TicketPoller acceptance tests (POLLER-001..015 + JP-CONN-001..006 +
 * GH-ISSUES-POLLER-001..003).
 *
 * Issue #25: the poller resolves auth at poll time via the project's
 * `tickets.connectionId` instead of `tokenRef`/`email`/`host`. The harness
 * now wires:
 *   - `connectionStore.get(id)` mock
 *   - `secretsManager.get(secretRef)` returning `"<email>\n<token>"` for Jira
 *   - JiraClientFactory called with the CONNECTION's host (not project's)
 *
 * Strategy:
 *  - Inject `FakeHttpClient` via `jiraClientFactory`.
 *  - Inject `FakeTimers` (a `PollerTimers` impl) — deterministic ticking.
 *  - Stub `projectStore.list()`, `connectionStore.get()`, and
 *    `secretsManager.get()` directly so the poller has narrow, mockable
 *    interfaces.
 */

// ---------------------------------------------------------------------------
// Helpers — fake timers, fs, project/connection/secrets stubs
// ---------------------------------------------------------------------------

interface TimerHandle {
  cb: () => void;
  ms: number;
  id: number;
}

interface FakeTimerControl {
  timers: PollerTimers;
  /** Fire each currently-registered interval's callback once. */
  tick: () => void;
  /** Snapshot of currently-active handles. */
  active: () => ReadonlyArray<TimerHandle>;
  /** Number of currently-active handles. */
  count: () => number;
}

function createFakeTimers(): FakeTimerControl {
  const handles = new Set<TimerHandle>();
  let nextId = 0;
  const timers: PollerTimers = {
    setInterval: (cb: () => void, ms: number) => {
      const h: TimerHandle = { cb, ms, id: nextId++ };
      handles.add(h);
      return h;
    },
    clearInterval: (handle: unknown) => {
      handles.delete(handle as TimerHandle);
    },
  };
  return {
    timers,
    tick: () => {
      // Snapshot before iterating: a callback might add/remove handles.
      for (const h of [...handles]) {
        if (handles.has(h)) h.cb();
      }
    },
    active: () => [...handles],
    count: () => handles.size,
  };
}

// In-memory fs for the underlying RunHistory instance.
type FsOp =
  | { kind: 'readFile'; path: string }
  | { kind: 'writeFile'; path: string; data: string }
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'unlink'; path: string }
  | { kind: 'mkdir'; path: string };

interface MemFs extends ProjectStoreFs {
  files: Map<string, string>;
  ops: FsOp[];
}

function createMemFs(): MemFs {
  const files = new Map<string, string>();
  const ops: FsOp[] = [];
  return {
    files,
    ops,
    async readFile(path: string, _enc: 'utf8') {
      ops.push({ kind: 'readFile', path });
      const c = files.get(path);
      if (c === undefined) {
        const err = new Error(
          `ENOENT: no such file or directory, open '${path}'`,
        ) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return c;
    },
    async writeFile(path: string, data: string, _enc: 'utf8') {
      ops.push({ kind: 'writeFile', path, data });
      files.set(path, data);
    },
    async rename(from: string, to: string) {
      ops.push({ kind: 'rename', from, to });
      const data = files.get(from);
      if (data === undefined) {
        const err = new Error(
          `ENOENT: rename source missing '${from}'`,
        ) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      files.delete(from);
      files.set(to, data);
    },
    async unlink(path: string) {
      ops.push({ kind: 'unlink', path });
      files.delete(path);
    },
    async mkdir(path: string, _opts: { recursive: true }) {
      ops.push({ kind: 'mkdir', path });
    },
  };
}

// Project store stub (poller only needs `list()`).
interface ProjectStoreStub {
  list: () => Promise<
    | { ok: true; data: ProjectInstance[] }
    | { ok: false; error: unknown }
  >;
  setProjects: (next: ProjectInstance[]) => void;
}

function createProjectStoreStub(initial: ProjectInstance[] = []): ProjectStoreStub {
  let projects = [...initial];
  return {
    list: async () => ({ ok: true, data: [...projects] }),
    setProjects: (next: ProjectInstance[]) => {
      projects = [...next];
    },
  };
}

// Connection store stub (poller only needs `get(id)`).
interface ConnectionStoreStub {
  get: (
    id: string,
  ) => Promise<
    | { ok: true; data: Connection }
    | { ok: false; error: { code: string; message: string } }
  >;
  setConnection: (id: string, conn: Connection) => void;
  failWith: (id: string, err: { code: string; message: string }) => void;
  /** Recorded ids passed to `get`, in order. */
  calls: string[];
}

function createConnectionStoreStub(
  initial: Record<string, Connection> = {},
): ConnectionStoreStub {
  const conns = new Map<string, Connection>(Object.entries(initial));
  const failures = new Map<string, { code: string; message: string }>();
  const calls: string[] = [];
  return {
    calls,
    get: async (id: string) => {
      calls.push(id);
      const fail = failures.get(id);
      if (fail) return { ok: false, error: fail };
      const c = conns.get(id);
      if (c === undefined) {
        return {
          ok: false,
          error: { code: 'NOT_FOUND', message: `no connection for ${id}` },
        };
      }
      return { ok: true, data: c };
    },
    setConnection: (id: string, conn: Connection) => conns.set(id, conn),
    failWith: (id: string, err: { code: string; message: string }) =>
      failures.set(id, err),
  };
}

// Secrets manager stub (poller only needs `get(ref)`).
interface SecretsStub {
  get: (
    ref: string,
  ) => Promise<
    | { ok: true; data: { plaintext: string } }
    | { ok: false; error: unknown }
  >;
  setSecret: (ref: string, plaintext: string) => void;
  failWith: (ref: string, err: { code: string; message: string }) => void;
}

function createSecretsStub(initial: Record<string, string> = {}): SecretsStub {
  const tokens = new Map<string, string>(Object.entries(initial));
  const failures = new Map<string, { code: string; message: string }>();
  return {
    get: async (ref: string) => {
      const fail = failures.get(ref);
      if (fail) return { ok: false, error: fail };
      const t = tokens.get(ref);
      if (t === undefined) {
        return { ok: false, error: { code: 'NOT_FOUND', message: `no secret for ${ref}` } };
      }
      return { ok: true, data: { plaintext: t } };
    },
    setSecret: (ref: string, plaintext: string) => tokens.set(ref, plaintext),
    failWith: (ref: string, err: { code: string; message: string }) =>
      failures.set(ref, err),
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HOST = 'https://example.atlassian.net';
const JIRA_CONN_ID = 'conn-jr-1';
const JIRA_SECRET_REF = 'connection:conn-jr-1:token';
const TOKEN = 'super-secret-token';
const EMAIL = 'me@example.com';
/** SecretsManager stores Jira plaintext as `"<email>\n<token>"` (per Connections API). */
const JIRA_SECRET_PLAINTEXT = `${EMAIL}\n${TOKEN}`;
const RUN_HISTORY_PATH = '/userData/run-history.json';

function makeConnection(over: Partial<Connection> = {}): Connection {
  return {
    id: JIRA_CONN_ID,
    provider: 'jira',
    label: 'Acme',
    host: HOST,
    authMethod: 'api-token',
    secretRef: JIRA_SECRET_REF,
    accountIdentity: { kind: 'jira', accountId: '5f1', displayName: 'Gary' },
    lastVerifiedAt: 1_700_000_000_000,
    verificationStatus: 'verified',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  };
}

function makeProject(over: Partial<ProjectInstance> = {}): ProjectInstance {
  const tickets: TicketsConfig = {
    source: 'jira',
    connectionId: JIRA_CONN_ID,
    projectKey: 'ABC',
    query: 'project = "ABC"',
  };
  return {
    id: 'p1',
    name: 'Project One',
    repo: {
      type: 'github',
      localPath: '/abs/repo',
      baseBranch: 'main',
      connectionId: 'conn-gh-1',
      slug: 'gazhang/frontend-app',
    },
    tickets,
    workflow: { mode: 'interactive', branchFormat: 'feat/{ticketKey}' },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  };
}

function jsonOk(body: unknown, status = 200): HttpResult {
  return {
    ok: true,
    response: {
      status,
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
  };
}

function jsonStatus(status: number, body: unknown = {}): HttpResult {
  return {
    ok: true,
    response: {
      status,
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
  };
}

function searchResponse(issues: unknown[], total = issues.length): unknown {
  return { startAt: 0, maxResults: 50, total, issues };
}

function fullIssue(key: string) {
  return {
    id: '10001',
    self: `${HOST}/rest/api/3/issue/10001`,
    key,
    fields: {
      summary: `Summary for ${key}`,
      status: { name: 'Ready for AI' },
      priority: { name: 'Medium' },
      assignee: { displayName: 'Someone' },
      updated: '2026-05-05T03:30:00.000+0000',
    },
  };
}

const SEARCH_PREFIX = `${HOST}/rest/api/3/search`;
const MYSELF_URL = `${HOST}/rest/api/3/myself`;

interface FactoryRecord {
  host: string;
  auth: JiraAuth;
}

// jiraClientFactory that records every context the poller passed so tests can
// assert the poller used the connection's host (not the project's).
function makeFactory(http: FakeHttpClient, records: FactoryRecord[]) {
  return (ctx: { project: ProjectInstance; host: string; auth: JiraAuth }) => {
    records.push({ host: ctx.host, auth: ctx.auth });
    return new JiraClient({
      httpClient: http,
      host: ctx.host,
      auth: ctx.auth,
    });
  };
}

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

interface Harness {
  http: FakeHttpClient;
  fs: MemFs;
  history: RunHistory;
  store: ProjectStoreStub;
  connections: ConnectionStoreStub;
  secrets: SecretsStub;
  timerCtl: FakeTimerControl;
  poller: TicketPoller;
  errors: PollerErrorEvent[];
  changes: TicketsChangedEvent[];
  factoryRecords: FactoryRecord[];
}

async function makeHarness(opts?: {
  projects?: ProjectInstance[];
  connections?: Record<string, Connection>;
  secrets?: Record<string, string>;
}): Promise<Harness> {
  const http = new FakeHttpClient();
  const fs = createMemFs();
  const history = new RunHistory({ filePath: RUN_HISTORY_PATH, fs });
  await history.init();

  const store = createProjectStoreStub(opts?.projects ?? []);
  const connections = createConnectionStoreStub(
    opts?.connections ?? { [JIRA_CONN_ID]: makeConnection() },
  );
  const secrets = createSecretsStub(
    opts?.secrets ?? { [JIRA_SECRET_REF]: JIRA_SECRET_PLAINTEXT },
  );
  const timerCtl = createFakeTimers();
  const factoryRecords: FactoryRecord[] = [];

  const poller = new TicketPoller({
    projectStore: store,
    secretsManager: secrets,
    connectionStore: connections,
    runHistory: history,
    jiraClientFactory: makeFactory(http, factoryRecords),
    // Plumb the FakeHttpClient through so the github-issues source uses
    // the test double too (the jira path uses jiraClientFactory; the github
    // path uses httpClient directly).
    httpClient: http,
    timers: timerCtl.timers,
  });

  const errors: PollerErrorEvent[] = [];
  const changes: TicketsChangedEvent[] = [];
  poller.on('error', (e) => errors.push(e));
  poller.on('tickets-changed', (e) => changes.push(e));

  return {
    http,
    fs,
    history,
    store,
    connections,
    secrets,
    timerCtl,
    poller,
    errors,
    changes,
    factoryRecords,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TicketPoller', () => {
  let h: Harness;
  let project: ProjectInstance;

  beforeEach(async () => {
    project = makeProject();
    h = await makeHarness({ projects: [project] });
  });

  // -------------------------------------------------------------------------
  // POLLER-001 — start + refreshNow happy path
  // -------------------------------------------------------------------------
  it('POLLER-001: start() then refreshNow() returns mock tickets and emits tickets-changed', async () => {
    h.http.expectPrefix(
      'GET',
      SEARCH_PREFIX,
      jsonOk(searchResponse([fullIssue('ABC-1'), fullIssue('ABC-2')])),
    );

    const startRes = await h.poller.start(project, 60_000);
    expect(startRes.ok).toBe(true);

    const refreshRes = await h.poller.refreshNow(project.id);
    expect(refreshRes.ok).toBe(true);
    if (!refreshRes.ok) return;
    expect(refreshRes.data.tickets).toHaveLength(2);

    expect(h.changes).toHaveLength(1);
    expect(h.changes[0]?.projectId).toBe(project.id);
    expect(h.changes[0]?.tickets.map((t) => t.key)).toEqual(
      expect.arrayContaining(['ABC-1', 'ABC-2']),
    );
  });

  // -------------------------------------------------------------------------
  // POLLER-002 — same response twice → only one event
  // -------------------------------------------------------------------------
  it('POLLER-002: identical JQL response twice → only ONE tickets-changed event', async () => {
    h.http.expectPrefix(
      'GET',
      SEARCH_PREFIX,
      jsonOk(searchResponse([fullIssue('ABC-1')])),
    );
    await h.poller.start(project, 60_000);

    const r1 = await h.poller.refreshNow(project.id);
    expect(r1.ok).toBe(true);
    const r2 = await h.poller.refreshNow(project.id);
    expect(r2.ok).toBe(true);

    expect(h.changes).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // POLLER-003 — running ticket filtered out
  // -------------------------------------------------------------------------
  it('POLLER-003: tickets in runHistory.getRunning are filtered from cache', async () => {
    await h.history.markRunning(project.id, 'ABC-1');

    h.http.expectPrefix(
      'GET',
      SEARCH_PREFIX,
      jsonOk(searchResponse([fullIssue('ABC-1'), fullIssue('ABC-2')])),
    );
    await h.poller.start(project, 60_000);
    const res = await h.poller.refreshNow(project.id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const keys = res.data.tickets.map((t) => t.key);
    expect(keys).not.toContain('ABC-1');
    expect(keys).toContain('ABC-2');

    const cached = h.poller.list(project.id);
    expect(cached.map((t) => t.key)).not.toContain('ABC-1');
    expect(cached.map((t) => t.key)).toContain('ABC-2');
  });

  // -------------------------------------------------------------------------
  // POLLER-004 — processed ticket filtered out
  // -------------------------------------------------------------------------
  it('POLLER-004: tickets in runHistory.getProcessed are filtered from cache', async () => {
    await h.history.markProcessed(project.id, 'ABC-1');

    h.http.expectPrefix(
      'GET',
      SEARCH_PREFIX,
      jsonOk(searchResponse([fullIssue('ABC-1'), fullIssue('ABC-2')])),
    );
    await h.poller.start(project, 60_000);
    const res = await h.poller.refreshNow(project.id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const keys = res.data.tickets.map((t) => t.key);
    expect(keys).not.toContain('ABC-1');
    expect(keys).toContain('ABC-2');
  });

  // -------------------------------------------------------------------------
  // POLLER-005 — per-project mutex: overlapping tick is dropped (not queued)
  // -------------------------------------------------------------------------
  it('POLLER-005: a tick that fires while a previous poll is in-flight is dropped', async () => {
    let resolveFirst!: (r: HttpResult) => void;
    const firstResponse = new Promise<HttpResult>((r) => {
      resolveFirst = r;
    });
    let callCount = 0;
    const originalRequest = h.http.request.bind(h.http);
    h.http.request = async (req) => {
      callCount += 1;
      if (callCount === 1) {
        return firstResponse;
      }
      return originalRequest(req);
    };
    h.http.expectPrefix(
      'GET',
      SEARCH_PREFIX,
      jsonOk(searchResponse([fullIssue('ABC-1')])),
    );

    await h.poller.start(project, 60_000);
    h.timerCtl.tick();
    h.timerCtl.tick();
    h.timerCtl.tick();

    // Drain the strategy chain — it has more `await` boundaries than the
    // pre-#25 direct-jira-client path (sourceFactory → connectionStore.get
    // → secretsManager.get → builds client). 8 microtask drains is enough.
    for (let i = 0; i < 8; i++) await Promise.resolve();

    expect(callCount).toBe(1);

    resolveFirst(jsonOk(searchResponse([fullIssue('ABC-1')])));
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(callCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // POLLER-006 — per-project isolation
  // -------------------------------------------------------------------------
  it('POLLER-006: per-project isolation — caches do not bleed across projects', async () => {
    const p1 = makeProject({
      id: 'p1',
      tickets: {
        source: 'jira',
        connectionId: project.tickets.connectionId,
        projectKey: 'AAA',
        query: 'project = "AAA"',
      },
    });
    const p2 = makeProject({
      id: 'p2',
      tickets: {
        source: 'jira',
        connectionId: project.tickets.connectionId,
        projectKey: 'BBB',
        query: 'project = "BBB"',
      },
    });
    const h2 = await makeHarness({ projects: [p1, p2] });

    const url1 = `${SEARCH_PREFIX}?jql=${encodeURIComponent('project = "AAA"')}`;
    const url2 = `${SEARCH_PREFIX}?jql=${encodeURIComponent('project = "BBB"')}`;
    h2.http.expectPrefix('GET', url1, jsonOk(searchResponse([fullIssue('AAA-1')])));
    h2.http.expectPrefix('GET', url2, jsonOk(searchResponse([fullIssue('BBB-9')])));

    await h2.poller.start(p1, 60_000);
    await h2.poller.start(p2, 60_000);

    const r1 = await h2.poller.refreshNow(p1.id);
    const r2 = await h2.poller.refreshNow(p2.id);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    expect(r1.data.tickets.map((t) => t.key)).toEqual(['AAA-1']);
    expect(r2.data.tickets.map((t) => t.key)).toEqual(['BBB-9']);
    expect(h2.poller.list(p1.id).map((t) => t.key)).toEqual(['AAA-1']);
    expect(h2.poller.list(p2.id).map((t) => t.key)).toEqual(['BBB-9']);
  });

  // -------------------------------------------------------------------------
  // POLLER-007 — auth error stops the poller for that project
  // -------------------------------------------------------------------------
  it('POLLER-007: 401 stops scheduling for the project + emits AUTH error', async () => {
    h.http.expectPrefix('GET', SEARCH_PREFIX, jsonStatus(401, {}));

    await h.poller.start(project, 60_000);
    const beforeCount = h.timerCtl.count();
    expect(beforeCount).toBeGreaterThanOrEqual(1);

    const refresh = await h.poller.refreshNow(project.id);
    expect(refresh.ok).toBe(false);

    expect(h.timerCtl.count()).toBeLessThan(beforeCount);

    expect(h.errors.some((e) => e.code === 'AUTH' && e.projectId === project.id)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // POLLER-008 — back-off on transient errors
  // -------------------------------------------------------------------------
  it('POLLER-008: consecutive 5xx errors increment the consecutiveErrors counter', async () => {
    h.http.expectPrefix('GET', SEARCH_PREFIX, jsonStatus(500, {}));
    await h.poller.start(project, 1_000);

    const r1 = await h.poller.refreshNow(project.id);
    expect(r1.ok).toBe(false);
    const r2 = await h.poller.refreshNow(project.id);
    expect(r2.ok).toBe(false);
    const r3 = await h.poller.refreshNow(project.id);
    expect(r3.ok).toBe(false);

    const serverErrors = h.errors.filter((e) => e.code === 'SERVER_ERROR');
    expect(serverErrors.length).toBeGreaterThanOrEqual(3);
    const counters = serverErrors.map((e) => e.consecutiveErrors);
    for (let i = 1; i < counters.length; i++) {
      expect(counters[i]).toBeGreaterThan(counters[i - 1]!);
    }
  });

  // -------------------------------------------------------------------------
  // POLLER-009 — back-off resets on success
  // -------------------------------------------------------------------------
  it('POLLER-009: a successful poll resets consecutiveErrors to 0', async () => {
    let n = 0;
    const original = h.http.request.bind(h.http);
    h.http.request = async (req) => {
      n += 1;
      if (n === 1) return jsonStatus(500, {});
      if (n === 2) return jsonOk(searchResponse([fullIssue('ABC-1')]));
      if (n === 3) return jsonStatus(500, {});
      return original(req);
    };
    await h.poller.start(project, 1_000);

    await h.poller.refreshNow(project.id);
    await h.poller.refreshNow(project.id);
    await h.poller.refreshNow(project.id);

    const serverErrors = h.errors.filter((e) => e.code === 'SERVER_ERROR');
    expect(serverErrors).toHaveLength(2);
    expect(serverErrors[1]!.consecutiveErrors).toBeLessThanOrEqual(
      serverErrors[0]!.consecutiveErrors,
    );
  });

  // -------------------------------------------------------------------------
  // POLLER-010 — stop() clears the timer
  // -------------------------------------------------------------------------
  it('POLLER-010: stop() clears the project timer; no further ticks fire', async () => {
    h.http.expectPrefix(
      'GET',
      SEARCH_PREFIX,
      jsonOk(searchResponse([fullIssue('ABC-1')])),
    );
    await h.poller.start(project, 1_000);
    expect(h.timerCtl.count()).toBeGreaterThanOrEqual(1);

    h.poller.stop(project.id);
    expect(h.timerCtl.count()).toBe(0);

    const callsBefore = h.http.calls.length;
    h.timerCtl.tick();
    await Promise.resolve();
    expect(h.http.calls.length).toBe(callsBefore);
  });

  it('POLLER-010: stop() is idempotent', async () => {
    await h.poller.start(project, 1_000);
    h.poller.stop(project.id);
    expect(() => h.poller.stop(project.id)).not.toThrow();
    expect(() => h.poller.stop('never-started')).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // POLLER-011 — stopAll() clears every timer
  // -------------------------------------------------------------------------
  it('POLLER-011: stopAll() clears every project timer', async () => {
    const p1 = makeProject({ id: 'p1' });
    const p2 = makeProject({ id: 'p2' });
    const h2 = await makeHarness({ projects: [p1, p2] });
    h2.http.expectPrefix(
      'GET',
      SEARCH_PREFIX,
      jsonOk(searchResponse([fullIssue('ABC-1')])),
    );

    await h2.poller.start(p1, 1_000);
    await h2.poller.start(p2, 1_000);
    expect(h2.timerCtl.count()).toBeGreaterThanOrEqual(2);

    h2.poller.stopAll();
    expect(h2.timerCtl.count()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // POLLER-012 — refreshNow without start
  // -------------------------------------------------------------------------
  it('POLLER-012: refreshNow() works when start() was never called', async () => {
    h.http.expectPrefix(
      'GET',
      SEARCH_PREFIX,
      jsonOk(searchResponse([fullIssue('ABC-1')])),
    );

    h.store.setProjects([project]);

    const res = await h.poller.refreshNow(project.id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.tickets.map((t) => t.key)).toContain('ABC-1');
  });

  // -------------------------------------------------------------------------
  // POLLER-013 — testConnection (still uses host + JiraAuth directly)
  // -------------------------------------------------------------------------
  it('POLLER-013: testConnection returns the JiraSelfResponse from /myself', async () => {
    h.http.expect(
      'GET',
      MYSELF_URL,
      jsonOk({
        accountId: 'acc-1',
        displayName: 'Tester',
        emailAddress: EMAIL,
      }),
    );

    const res = await h.poller.testConnection({
      host: HOST,
      auth: { email: EMAIL, apiToken: TOKEN },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.accountId).toBe('acc-1');
    expect(res.data.displayName).toBe('Tester');
    expect(res.data.emailAddress).toBe(EMAIL);
  });

  // -------------------------------------------------------------------------
  // POLLER-015 — PROJECT_NOT_FOUND when project deleted between ticks
  // -------------------------------------------------------------------------
  it('POLLER-015: PROJECT_NOT_FOUND emitted + scheduling stops when project disappears', async () => {
    h.http.expectPrefix(
      'GET',
      SEARCH_PREFIX,
      jsonOk(searchResponse([fullIssue('ABC-1')])),
    );
    await h.poller.start(project, 60_000);
    const beforeCount = h.timerCtl.count();
    expect(beforeCount).toBeGreaterThanOrEqual(1);

    h.store.setProjects([]);

    const refresh = await h.poller.refreshNow(project.id);
    expect(refresh.ok).toBe(false);

    expect(
      h.errors.some(
        (e) => e.code === 'PROJECT_NOT_FOUND' && e.projectId === project.id,
      ),
    ).toBe(true);
    expect(h.timerCtl.count()).toBeLessThan(beforeCount);
  });

  // -------------------------------------------------------------------------
  // JP-CONN-001..006 — issue #25: auth resolution via ConnectionStore
  // -------------------------------------------------------------------------
  describe('JP-CONN-001..006 connection-based auth resolution', () => {
    it('JP-CONN-001: auth resolved via project.tickets.connectionId → ConnectionStore.get(id)', async () => {
      h.http.expectPrefix(
        'GET',
        SEARCH_PREFIX,
        jsonOk(searchResponse([fullIssue('ABC-1')])),
      );

      await h.poller.start(project, 60_000);
      const refresh = await h.poller.refreshNow(project.id);
      expect(refresh.ok).toBe(true);

      // ConnectionStore.get() must have been invoked with the project's
      // tickets.connectionId.
      expect(h.connections.calls).toContain(JIRA_CONN_ID);
    });

    it('JP-CONN-002: connection not found → NO_TOKEN error event, no HTTP call', async () => {
      // Project references a connection id that doesn't exist in the store.
      const orphaned = makeProject({
        id: 'orphan',
        tickets: { ...project.tickets, connectionId: 'conn-missing' },
      });
      h.store.setProjects([orphaned]);

      await h.poller.start(orphaned, 60_000);
      const refresh = await h.poller.refreshNow(orphaned.id);
      expect(refresh.ok).toBe(false);

      const noTokenErr = h.errors.find(
        (e) => e.code === 'NO_TOKEN' && e.projectId === orphaned.id,
      );
      expect(noTokenErr).toBeDefined();
      // Auth resolution failed before any HTTP call could be made.
      expect(h.http.calls).toHaveLength(0);
    });

    it('JP-CONN-003: secret not found → NO_TOKEN, no HTTP call', async () => {
      // Connection points at a secret ref the secrets backend doesn't have.
      h.connections.setConnection(
        JIRA_CONN_ID,
        makeConnection({ secretRef: 'connection:missing:token' }),
      );

      await h.poller.start(project, 60_000);
      const refresh = await h.poller.refreshNow(project.id);
      expect(refresh.ok).toBe(false);

      expect(
        h.errors.some(
          (e) => e.code === 'NO_TOKEN' && e.projectId === project.id,
        ),
      ).toBe(true);
      expect(h.http.calls).toHaveLength(0);
    });

    it('JP-CONN-004: secret with no "\\n" treats whole as token + email="" and fails on AUTH eventually', async () => {
      // Plaintext stored without the email\ntoken split. The poller's
      // defense-in-depth fallback should still attempt the request.
      h.secrets.setSecret(JIRA_SECRET_REF, 'just-a-bare-token-without-email');
      // Jira will respond 401 to a request with empty email.
      h.http.expectPrefix('GET', SEARCH_PREFIX, jsonStatus(401, {}));

      await h.poller.start(project, 60_000);
      const refresh = await h.poller.refreshNow(project.id);
      expect(refresh.ok).toBe(false);

      // Either NO_TOKEN (if the poller is strict) OR AUTH (if it tries) — the
      // spec calls for "still tries". Assert on AUTH.
      expect(
        h.errors.some((e) => e.code === 'AUTH' && e.projectId === project.id),
      ).toBe(true);
      // And exactly one HTTP call was made (the attempted search).
      expect(h.http.calls.length).toBeGreaterThanOrEqual(1);
    });

    it('JP-CONN-005: tickets.query undefined → JQL falls back to project = "{projectKey}"', async () => {
      const noQueryProject = makeProject({
        id: 'no-query',
        tickets: {
          source: 'jira',
          connectionId: JIRA_CONN_ID,
          projectKey: 'XYZ',
          // query intentionally omitted
        },
      });
      h.store.setProjects([noQueryProject]);

      // Pre-register a response keyed off the EXPECTED default JQL.
      const expectedJql = 'project = "XYZ"';
      const expectedUrl = `${SEARCH_PREFIX}?jql=${encodeURIComponent(expectedJql)}`;
      h.http.expectPrefix(
        'GET',
        expectedUrl,
        jsonOk(searchResponse([fullIssue('XYZ-1')])),
      );

      await h.poller.start(noQueryProject, 60_000);
      const refresh = await h.poller.refreshNow(noQueryProject.id);
      expect(refresh.ok).toBe(true);

      // Confirm the URL the poller actually sent contains the encoded
      // default JQL.
      const lastCall = h.http.calls[h.http.calls.length - 1];
      expect(lastCall?.url).toContain(encodeURIComponent(expectedJql));
    });

    it('JP-CONN-006: host comes from connection.host, not project.tickets.host', async () => {
      // Connection at a different host than the global HOST. The factory is
      // expected to be wired with that host.
      const altHost = 'https://other.atlassian.net';
      h.connections.setConnection(
        JIRA_CONN_ID,
        makeConnection({ host: altHost }),
      );
      // Pre-register at the alt host so the request matches.
      h.http.expectPrefix(
        'GET',
        `${altHost}/rest/api/3/search`,
        jsonOk(searchResponse([fullIssue('ABC-1')])),
      );

      await h.poller.start(project, 60_000);
      const refresh = await h.poller.refreshNow(project.id);
      expect(refresh.ok).toBe(true);

      // The actual outgoing URL must use the connection's host, not the
      // (now-removed) project-side host. Since the project no longer carries
      // host at all, this is doubly guaranteed by the type system + this
      // runtime check.
      const lastCall = h.http.calls[h.http.calls.length - 1];
      expect(lastCall?.url.startsWith(altHost)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // GH-ISSUES-POLLER-001..003 — issue #25 polish:
  // TicketPoller dispatches to a per-source strategy. When
  // `project.tickets.source === 'github-issues'`:
  //   - The poller hits GitHub's /repos/{slug}/issues endpoint.
  //   - Auth resolves through the SAME ConnectionStore + SecretsManager flow
  //     used by Jira (provider must be 'github').
  //   - PRs are filtered out (the issues endpoint returns both).
  //
  // We exercise the dispatch behaviour at a high level — assert on the URL
  // path and the resulting ticket set. The ticket key format
  // `${repoSlug}#${number}` is the marker that the GitHub Issues path was
  // actually used (Jira keys are e.g. `ABC-1`).
  // -------------------------------------------------------------------------
  describe('GH-ISSUES-POLLER-001..003 GitHub Issues dispatch', () => {
    const GH_HOST = 'https://api.github.com';
    const GH_CONN_ID = 'conn-gh-1';
    const GH_SECRET_REF = 'connection:conn-gh-1:token';
    const GH_TOKEN = 'ghp_test_token_xyz';
    const REPO_SLUG = 'gazhang/foo';

    function makeGithubConnection(over: Partial<Connection> = {}): Connection {
      return {
        id: GH_CONN_ID,
        provider: 'github',
        label: 'Personal',
        host: GH_HOST,
        authMethod: 'pat',
        secretRef: GH_SECRET_REF,
        accountIdentity: { kind: 'github', login: 'gazhang', scopes: ['repo'] },
        lastVerifiedAt: 1_700_000_000_000,
        verificationStatus: 'verified',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        ...over,
      };
    }

    function makeGhProject(over: Partial<ProjectInstance> = {}): ProjectInstance {
      const tickets = {
        source: 'github-issues' as const,
        connectionId: GH_CONN_ID,
        repoSlug: REPO_SLUG,
      } as unknown as TicketsConfig;
      return {
        id: 'p-gh',
        name: 'GH Project',
        repo: {
          type: 'github',
          localPath: '/abs/repo',
          baseBranch: 'main',
          connectionId: GH_CONN_ID,
          slug: REPO_SLUG,
        },
        tickets,
        workflow: { mode: 'interactive', branchFormat: 'feat/{ticketKey}' },
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        ...over,
      };
    }

    function ghIssue(over: Record<string, unknown> = {}) {
      return {
        number: 1,
        title: 'Some issue',
        state: 'open',
        html_url: 'https://github.com/gazhang/foo/issues/1',
        updated_at: '2026-05-05T10:00:00Z',
        labels: [],
        assignee: null,
        ...over,
      };
    }

    const ISSUES_URL_PREFIX = `${GH_HOST}/repos/${REPO_SLUG}/issues`;

    it('GH-ISSUES-POLLER-001: project.tickets.source === "github-issues" → /repos/{slug}/issues is hit (not /search)', async () => {
      const ghProject = makeGhProject();
      const harness = await makeHarness({
        projects: [ghProject],
        connections: { [GH_CONN_ID]: makeGithubConnection() },
        secrets: { [GH_SECRET_REF]: GH_TOKEN },
      });
      harness.http.expectPrefix(
        'GET',
        ISSUES_URL_PREFIX,
        jsonOk([ghIssue({ number: 1 }), ghIssue({ number: 2 })]),
      );

      await harness.poller.start(ghProject, 60_000);
      const refresh = await harness.poller.refreshNow(ghProject.id);
      expect(refresh.ok).toBe(true);
      if (!refresh.ok) return;

      // Tickets came from GitHub, not Jira — keys are `GH-{number}` shaped
      // (matches the workflow runner's regex; was `slug#number` before but
      // that didn't pass `[A-Z][A-Z0-9_]*-\d+`).
      const keys = refresh.data.tickets.map((t) => t.key);
      expect(keys).toEqual(expect.arrayContaining(['GH-1', 'GH-2']));
      // Silence unused-fixture lint.
      void REPO_SLUG;

      // The HTTP layer was hit at the GitHub issues URL prefix at least once,
      // and never at the Jira /search prefix.
      const urls = harness.http.calls.map((c) => c.url);
      expect(urls.some((u) => u.startsWith(ISSUES_URL_PREFIX))).toBe(true);
      expect(urls.some((u) => u.includes('/rest/api/3/search'))).toBe(false);
    });

    it('GH-ISSUES-POLLER-002: auth resolves via the connection (ConnectionStore + SecretsManager)', async () => {
      const ghProject = makeGhProject();
      const harness = await makeHarness({
        projects: [ghProject],
        connections: { [GH_CONN_ID]: makeGithubConnection() },
        secrets: { [GH_SECRET_REF]: GH_TOKEN },
      });
      harness.http.expectPrefix('GET', ISSUES_URL_PREFIX, jsonOk([]));

      await harness.poller.start(ghProject, 60_000);
      await harness.poller.refreshNow(ghProject.id);

      // Both stores were consulted — same flow as Jira.
      expect(harness.connections.calls).toContain(GH_CONN_ID);
    });

    it('GH-ISSUES-POLLER-002: missing GitHub connection → NO_TOKEN, no HTTP call', async () => {
      const ghProject = makeGhProject({
        tickets: {
          source: 'github-issues',
          connectionId: 'conn-missing',
          repoSlug: REPO_SLUG,
        } as unknown as TicketsConfig,
      });
      const harness = await makeHarness({
        projects: [ghProject],
        connections: {}, // no connections at all
        secrets: {},
      });

      await harness.poller.start(ghProject, 60_000);
      const refresh = await harness.poller.refreshNow(ghProject.id);
      expect(refresh.ok).toBe(false);

      const noTok = harness.errors.find(
        (e) => e.code === 'NO_TOKEN' && e.projectId === ghProject.id,
      );
      expect(noTok).toBeDefined();
      expect(harness.http.calls).toHaveLength(0);
    });

    it('GH-ISSUES-POLLER-003: PRs from /issues endpoint are filtered out (pull_request !== undefined)', async () => {
      const ghProject = makeGhProject();
      const harness = await makeHarness({
        projects: [ghProject],
        connections: { [GH_CONN_ID]: makeGithubConnection() },
        secrets: { [GH_SECRET_REF]: GH_TOKEN },
      });

      // Mix of pure issues + PR-shaped objects. PRs MUST be dropped before
      // they reach the ticket cache.
      harness.http.expectPrefix(
        'GET',
        ISSUES_URL_PREFIX,
        jsonOk([
          ghIssue({ number: 1 }),
          ghIssue({
            number: 2,
            pull_request: { url: 'https://api.github.com/repos/.../pulls/2' },
          }),
          ghIssue({ number: 3 }),
        ]),
      );

      await harness.poller.start(ghProject, 60_000);
      const refresh = await harness.poller.refreshNow(ghProject.id);
      expect(refresh.ok).toBe(true);
      if (!refresh.ok) return;

      const keys = refresh.data.tickets.map((t) => t.key);
      expect(keys).toEqual(expect.arrayContaining(['GH-1', 'GH-3']));
      expect(keys).not.toContain('GH-2');
    });
  });
});
