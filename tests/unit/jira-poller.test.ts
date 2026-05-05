import { describe, it, expect, beforeEach } from 'vitest';
import {
  FakeHttpClient,
  type HttpResult,
} from '../../src/main/modules/http-client';
import {
  JiraClient,
  type JiraAuth,
} from '../../src/main/modules/jira-client';
import { JiraPoller } from '../../src/main/modules/jira-poller';
import { RunHistory } from '../../src/main/modules/run-history';
import type { ProjectStoreFs } from '../../src/main/modules/project-store';
import type {
  ProjectInstance,
  TicketsConfig,
} from '../../src/shared/schema/project-instance';
import type {
  PollerErrorEvent,
  PollerTimers,
  TicketsChangedEvent,
} from '../../src/main/modules/jira-poller';

/**
 * JiraPoller acceptance tests (POLLER-001 .. POLLER-015).
 *
 * Most complex test file. Strategy:
 *  - Inject `FakeHttpClient` via a `jiraClientFactory` that builds a real
 *    `JiraClient` over the fake.
 *  - Inject `FakeTimers` (a `PollerTimers` impl) instead of using
 *    `vi.useFakeTimers`. Lets each test deterministically tick intervals.
 *  - Stub `projectStore.list()` and `secretsManager.get()` directly so the
 *    poller has narrow, mockable interfaces.
 *  - For mutex tests, use a manually-resolved Promise to delay the response.
 */

// ---------------------------------------------------------------------------
// Helpers — fake timers, fs, project/secrets stubs
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

// Secrets manager stub (poller only needs `get(ref)`).
interface SecretsStub {
  get: (
    ref: string,
  ) => Promise<
    | { ok: true; data: { plaintext: string } }
    | { ok: false; error: unknown }
  >;
  setToken: (ref: string, token: string) => void;
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
    setToken: (ref: string, token: string) => tokens.set(ref, token),
    failWith: (ref: string, err: { code: string; message: string }) =>
      failures.set(ref, err),
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HOST = 'https://example.atlassian.net';
const TOKEN_REF = 'jira-default';
const TOKEN = 'super-secret-token';
const EMAIL = 'me@example.com';
const RUN_HISTORY_PATH = '/userData/run-history.json';

function makeProject(over: Partial<ProjectInstance> = {}): ProjectInstance {
  const tickets: TicketsConfig = {
    source: 'jira',
    query: 'project = "ABC"',
    tokenRef: TOKEN_REF,
    // Email is the new optional TicketsConfig field added by issue #4.
    // We cast through Partial to avoid breaking older schemas during reconciliation.
    ...({ email: EMAIL } as Partial<TicketsConfig>),
  };
  return {
    id: 'p1',
    name: 'Project One',
    repo: { type: 'github', localPath: '/abs/repo', baseBranch: 'main' },
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

// jiraClientFactory that always wires the fixed `FakeHttpClient`.
function makeFactory(http: FakeHttpClient) {
  return (_project: ProjectInstance, auth: JiraAuth) => {
    return new JiraClient({
      httpClient: http,
      // Resolve host from project config — for tests we just use the global HOST.
      host: HOST,
      auth,
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
  secrets: SecretsStub;
  timerCtl: FakeTimerControl;
  poller: JiraPoller;
  errors: PollerErrorEvent[];
  changes: TicketsChangedEvent[];
}

async function makeHarness(opts?: {
  projects?: ProjectInstance[];
  tokens?: Record<string, string>;
}): Promise<Harness> {
  const http = new FakeHttpClient();
  const fs = createMemFs();
  const history = new RunHistory({ filePath: RUN_HISTORY_PATH, fs });
  await history.init();

  const store = createProjectStoreStub(opts?.projects ?? []);
  const secrets = createSecretsStub(opts?.tokens ?? { [TOKEN_REF]: TOKEN });
  const timerCtl = createFakeTimers();

  const poller = new JiraPoller({
    projectStore: store,
    secretsManager: secrets,
    runHistory: history,
    jiraClientFactory: makeFactory(http),
    timers: timerCtl.timers,
  });

  const errors: PollerErrorEvent[] = [];
  const changes: TicketsChangedEvent[] = [];
  poller.on('error', (e) => errors.push(e));
  poller.on('tickets-changed', (e) => changes.push(e));

  return { http, fs, history, store, secrets, timerCtl, poller, errors, changes };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JiraPoller', () => {
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

    // Cache (list()) reflects the same filtered set.
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
    // Build a manually-resolved HttpResult so the first poll's response is
    // pending while we tick the timer again.
    let resolveFirst!: (r: HttpResult) => void;
    const firstResponse = new Promise<HttpResult>((r) => {
      resolveFirst = r;
    });
    let callCount = 0;
    // Replace expect with a custom request override by intercepting the
    // FakeHttpClient via a wrapper. But FakeHttpClient handles this via
    // expectPrefix; instead we register a result that's promise-typed via
    // a custom `request` proxy by subclassing.
    const originalRequest = h.http.request.bind(h.http);
    h.http.request = async (req) => {
      callCount += 1;
      if (callCount === 1) {
        return firstResponse;
      }
      return originalRequest(req);
    };
    // Pre-register a response for any later (non-dropped) calls, so that if
    // the mutex DOES leak we'd see a second matched call.
    h.http.expectPrefix(
      'GET',
      SEARCH_PREFIX,
      jsonOk(searchResponse([fullIssue('ABC-1')])),
    );

    await h.poller.start(project, 60_000);
    // First tick — kicks off the in-flight first poll.
    h.timerCtl.tick();
    // Second tick — should be silently skipped while #1 is pending.
    h.timerCtl.tick();
    // Third tick — same.
    h.timerCtl.tick();

    // Allow microtasks to settle so any queued work would have fired.
    await Promise.resolve();
    await Promise.resolve();

    expect(callCount).toBe(1);

    // Now resolve the first poll. After it lands, callCount stays at 1 — no
    // queued ticks were drained.
    resolveFirst(jsonOk(searchResponse([fullIssue('ABC-1')])));
    // Settle promise chain.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(callCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // POLLER-006 — per-project isolation
  // -------------------------------------------------------------------------
  it('POLLER-006: per-project isolation — caches do not bleed across projects', async () => {
    const p1 = makeProject({ id: 'p1', tickets: { ...project.tickets, query: 'project = "AAA"' } });
    const p2 = makeProject({ id: 'p2', tickets: { ...project.tickets, query: 'project = "BBB"' } });
    h.store.setProjects([p1, p2]);

    // Use fresh harness so its store has both projects.
    const h2 = await makeHarness({ projects: [p1, p2] });

    // Stub responses by JQL — FakeHttpClient.expectPrefix matches any URL
    // that begins with the prefix, so we register two separate prefixes.
    // Easiest: distinguish by JQL substring inside the URL.
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

    // Per spec rule 11: auth errors short-circuit scheduling for that
    // project. The interval handle for THIS project must be cleared.
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
    // Counter strictly increases (back-off counter exposed via
    // `consecutiveErrors`). Cap at 16x is exercised in spec, here we just
    // verify monotonic growth.
    const counters = serverErrors.map((e) => e.consecutiveErrors);
    for (let i = 1; i < counters.length; i++) {
      expect(counters[i]).toBeGreaterThan(counters[i - 1]!);
    }
  });

  // -------------------------------------------------------------------------
  // POLLER-009 — back-off resets on success
  // -------------------------------------------------------------------------
  it('POLLER-009: a successful poll resets consecutiveErrors to 0', async () => {
    // First call: 500. Second call: 200. Third call: 500 again.
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

    await h.poller.refreshNow(project.id); // 500 → counter=1
    await h.poller.refreshNow(project.id); // 200 → reset
    await h.poller.refreshNow(project.id); // 500 → counter back to 1

    const serverErrors = h.errors.filter((e) => e.code === 'SERVER_ERROR');
    expect(serverErrors).toHaveLength(2);
    // After reset, the second 500's counter should be back to 1 — i.e. NOT
    // greater than the first 500's counter.
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

    // Tick — nothing scheduled, so no calls made.
    const callsBefore = h.http.calls.length;
    h.timerCtl.tick();
    await Promise.resolve();
    expect(h.http.calls.length).toBe(callsBefore);
  });

  it('POLLER-010: stop() is idempotent', async () => {
    await h.poller.start(project, 1_000);
    h.poller.stop(project.id);
    // Should not throw on second call.
    expect(() => h.poller.stop(project.id)).not.toThrow();
    // Still also tolerant for unknown id.
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

    // Note: store.list() must return the project so the poller can find it.
    h.store.setProjects([project]);

    const res = await h.poller.refreshNow(project.id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.tickets.map((t) => t.key)).toContain('ABC-1');
  });

  // -------------------------------------------------------------------------
  // POLLER-013 — testConnection
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
  // POLLER-014 — NO_TOKEN error path
  // -------------------------------------------------------------------------
  it('POLLER-014: NO_TOKEN error fires when project has no tokenRef', async () => {
    const noTokenProject = makeProject({
      id: 'no-token',
      tickets: {
        source: 'jira',
        query: 'project = "X"',
        // tokenRef intentionally omitted.
      },
    });
    h.store.setProjects([noTokenProject]);

    await h.poller.start(noTokenProject, 60_000);
    const refresh = await h.poller.refreshNow(noTokenProject.id);
    expect(refresh.ok).toBe(false);

    const noToken = h.errors.find(
      (e) => e.code === 'NO_TOKEN' && e.projectId === noTokenProject.id,
    );
    expect(noToken).toBeDefined();
    // No HTTP call should have been issued — secret resolution failed first.
    expect(h.http.calls).toHaveLength(0);
  });

  it('POLLER-014: NO_TOKEN also fires when secrets backend returns error for the ref', async () => {
    h.secrets.failWith(TOKEN_REF, { code: 'BACKEND_UNAVAILABLE', message: 'no keyring' });
    await h.poller.start(project, 60_000);
    const refresh = await h.poller.refreshNow(project.id);
    expect(refresh.ok).toBe(false);

    expect(h.errors.some((e) => e.code === 'NO_TOKEN' && e.projectId === project.id)).toBe(true);
    expect(h.http.calls).toHaveLength(0);
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

    // Project removed from store between ticks.
    h.store.setProjects([]);

    const refresh = await h.poller.refreshNow(project.id);
    expect(refresh.ok).toBe(false);

    expect(
      h.errors.some(
        (e) => e.code === 'PROJECT_NOT_FOUND' && e.projectId === project.id,
      ),
    ).toBe(true);
    // Scheduling stopped for that id.
    expect(h.timerCtl.count()).toBeLessThan(beforeCount);
  });
});
