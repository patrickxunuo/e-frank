/**
 * `JiraPoller` — orchestrates per-project Jira polling on a fixed cadence.
 *
 * Per project we track:
 *   - the project snapshot (used to read JQL fresh on each tick)
 *   - the configured intervalMs
 *   - the timer handle (from injectable `timers.setInterval`)
 *   - a per-project mutex (Promise) so overlapping ticks are silently dropped
 *   - a consecutive error counter (for back-off)
 *   - an optional `errorBackoffUntil` epoch ms — set on transient errors so
 *     subsequent ticks before that timestamp are skipped (NOT polled)
 *   - the last cached eligible-tickets array (for diff detection + `list()`)
 *
 * Back-off design — `timers.setInterval` runs on a fixed cadence, so we can't
 * "extend the interval" from the inside. Instead, when a transient error
 * happens, we record `errorBackoffUntil = Date.now() + min(intervalMs * 2^errors, intervalMs * 16)`.
 * The next tick's first action is to check that timestamp and bail early
 * if we're still inside the back-off window. On success, we clear the field.
 *
 * Auth errors short-circuit entirely — the timer is cleared and the project
 * state stays in the `Map` only so `refreshNow` / `list` keep working until
 * `start()` is called again with new credentials.
 */

import { EventEmitter } from 'node:events';
import { FetchHttpClient } from './http-client.js';
import {
  JiraClient,
  type JiraAuth,
  type JiraResult,
  type JiraSelfResponse,
  type JiraErrorCode,
} from './jira-client.js';
import type { RunHistory } from './run-history.js';
import type { ProjectInstance } from '../../shared/schema/project-instance.js';
import type { Connection } from '../../shared/schema/connection.js';
import type { Ticket } from '../../shared/schema/ticket.js';

export interface PollerTimers {
  setInterval: (cb: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

interface ProjectStoreLike {
  list(): Promise<{ ok: true; data: ProjectInstance[] } | { ok: false; error: unknown }>;
}

interface SecretsManagerLike {
  get(
    ref: string,
  ): Promise<{ ok: true; data: { plaintext: string } } | { ok: false; error: unknown }>;
}

export interface ConnectionStoreLike {
  get(
    id: string,
  ): Promise<{ ok: true; data: Connection } | { ok: false; error: unknown }>;
}

/**
 * Per-poll context passed to the JiraClient factory. We pass the resolved
 * `host` separately (rather than rely on the caller knowing how to read it
 * off the project) because as of #25 the host lives on the Connection, not
 * the project.
 */
export interface JiraClientFactoryContext {
  project: ProjectInstance;
  host: string;
  auth: JiraAuth;
}

export interface JiraPollerOptions {
  projectStore: ProjectStoreLike;
  connectionStore: ConnectionStoreLike;
  secretsManager: SecretsManagerLike;
  runHistory: RunHistory;
  /**
   * Build a JiraClient for a given project. Default uses `FetchHttpClient`.
   * Tests can override to inject a `FakeHttpClient`.
   */
  jiraClientFactory?: (ctx: JiraClientFactoryContext) => JiraClient;
  /** Test injection for setInterval / clearInterval. Default uses globalThis. */
  timers?: PollerTimers;
}

export type PollerErrorCode =
  | 'AUTH'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'NO_TOKEN'
  | 'PROJECT_NOT_FOUND'
  | 'INVALID_RESPONSE';

export interface PollerErrorEvent {
  projectId: string;
  code: PollerErrorCode;
  message: string;
  /** Number of consecutive errors before this one (back-off counter). */
  consecutiveErrors: number;
}

export interface TicketsChangedEvent {
  projectId: string;
  tickets: Ticket[];
  timestamp: number;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MULTIPLIER = 16;

interface ProjectPollState {
  project: ProjectInstance;
  intervalMs: number;
  timer: unknown | null;
  /** In-flight tick promise; null when idle. Used as the per-project mutex. */
  inflight: Promise<void> | null;
  consecutiveErrors: number;
  /** Epoch ms before which the next tick should skip polling. */
  errorBackoffUntil: number | null;
  lastTickets: Ticket[];
  /** True once an AUTH error has stopped this project's timer. */
  stoppedDueToAuth: boolean;
}

function defaultTimers(): PollerTimers {
  return {
    setInterval: (cb, ms) => globalThis.setInterval(cb, ms),
    clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
  };
}

function defaultJiraClientFactory(ctx: JiraClientFactoryContext): JiraClient {
  return new JiraClient({
    httpClient: new FetchHttpClient(),
    host: ctx.host,
    auth: ctx.auth,
  });
}

/**
 * Map a `JiraErrorCode` to the poller's narrower `PollerErrorCode`. They
 * overlap mostly 1:1; the poller adds NO_TOKEN / PROJECT_NOT_FOUND, and we
 * never expose `NOT_FOUND` from Jira (which would mean "wrong endpoint" —
 * surface it as INVALID_RESPONSE).
 */
function jiraCodeToPollerCode(code: JiraErrorCode): PollerErrorCode {
  switch (code) {
    case 'AUTH':
      return 'AUTH';
    case 'NETWORK':
      return 'NETWORK';
    case 'TIMEOUT':
      return 'TIMEOUT';
    case 'RATE_LIMITED':
      return 'RATE_LIMITED';
    case 'SERVER_ERROR':
      return 'SERVER_ERROR';
    case 'INVALID_RESPONSE':
      return 'INVALID_RESPONSE';
    case 'NOT_FOUND':
      return 'INVALID_RESPONSE';
  }
}

/**
 * Compare two ticket arrays for "visible" equality. The spec's diff is over
 * a SET (eligible ticket keys + visible fields), not a list — Jira can return
 * the same set in different order across polls (default sort is `created DESC`
 * but JQL `ORDER BY` overrides drift over time). We sort both sides by key
 * then walk in lockstep so re-orderings don't fire spurious `tickets-changed`
 * events, but any field change still does.
 */
function ticketsDiffer(a: ReadonlyArray<Ticket>, b: ReadonlyArray<Ticket>): boolean {
  if (a.length !== b.length) return true;
  const aSorted = [...a].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  const bSorted = [...b].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  for (let i = 0; i < aSorted.length; i++) {
    const x = aSorted[i]!;
    const y = bSorted[i]!;
    if (
      x.key !== y.key ||
      x.summary !== y.summary ||
      x.status !== y.status ||
      x.priority !== y.priority ||
      x.assignee !== y.assignee ||
      x.updatedAt !== y.updatedAt
    ) {
      return true;
    }
  }
  return false;
}

export class JiraPoller extends EventEmitter {
  private readonly projectStore: ProjectStoreLike;
  private readonly connectionStore: ConnectionStoreLike;
  private readonly secretsManager: SecretsManagerLike;
  private readonly runHistory: RunHistory;
  private readonly jiraClientFactory: (ctx: JiraClientFactoryContext) => JiraClient;
  private readonly timers: PollerTimers;

  private readonly states: Map<string, ProjectPollState> = new Map();

  constructor(options: JiraPollerOptions) {
    super();
    this.projectStore = options.projectStore;
    this.connectionStore = options.connectionStore;
    this.secretsManager = options.secretsManager;
    this.runHistory = options.runHistory;
    this.jiraClientFactory = options.jiraClientFactory ?? defaultJiraClientFactory;
    this.timers = options.timers ?? defaultTimers();
  }

  /**
   * Starts polling a project. If already started, restarts with the new
   * interval — the old timer is cleared, error counters reset, cache kept.
   * The first tick fires immediately (synchronously kicked off here, not
   * waited on) so the poller doesn't sit idle for `intervalMs` after start.
   */
  async start(
    project: ProjectInstance,
    intervalMs: number = DEFAULT_INTERVAL_MS,
  ): Promise<JiraResult<{ projectId: string }>> {
    const projectId = project.id;
    const existing = this.states.get(projectId);
    if (existing !== undefined && existing.timer !== null) {
      this.timers.clearInterval(existing.timer);
      existing.timer = null;
    }

    const state: ProjectPollState = existing ?? {
      project,
      intervalMs,
      timer: null,
      inflight: null,
      consecutiveErrors: 0,
      errorBackoffUntil: null,
      lastTickets: [],
      stoppedDueToAuth: false,
    };
    state.project = project;
    state.intervalMs = intervalMs;
    state.consecutiveErrors = 0;
    state.errorBackoffUntil = null;
    state.stoppedDueToAuth = false;
    this.states.set(projectId, state);

    state.timer = this.timers.setInterval(() => {
      void this.tick(projectId);
    }, intervalMs);

    // Immediate first poll — fire-and-forget. Errors are already routed via
    // the `error` event so callers don't need to await this.
    void this.tick(projectId);

    return { ok: true, data: { projectId } };
  }

  /** Stops polling a project. Idempotent. Drops cached state too. */
  stop(projectId: string): void {
    const state = this.states.get(projectId);
    if (state === undefined) return;
    if (state.timer !== null) {
      this.timers.clearInterval(state.timer);
      state.timer = null;
    }
    this.states.delete(projectId);
  }

  /** Stops all pollers and clears state. Used on app shutdown. */
  stopAll(): void {
    for (const [id, state] of this.states.entries()) {
      if (state.timer !== null) {
        this.timers.clearInterval(state.timer);
        state.timer = null;
      }
      this.states.delete(id);
    }
  }

  /**
   * Triggers a poll right now. Resolves once the poll finishes (or fails).
   * Works even when no timer is active (`start()` was never called or
   * `stop()` was) — we synthesize a transient state for the duration.
   */
  async refreshNow(projectId: string): Promise<JiraResult<{ tickets: Ticket[] }>> {
    let state = this.states.get(projectId);
    if (state === undefined) {
      // No timer state — run a one-shot poll. Find the project, build state
      // on the fly, run the poll, do NOT register a timer.
      const projects = await this.projectStore.list();
      if (!projects.ok) {
        return {
          ok: false,
          error: { code: 'NETWORK', message: 'project store unavailable' },
        };
      }
      const project = projects.data.find((p) => p.id === projectId);
      if (project === undefined) {
        const evt: PollerErrorEvent = {
          projectId,
          code: 'PROJECT_NOT_FOUND',
          message: `no project with id "${projectId}"`,
          consecutiveErrors: 0,
        };
        this.emit('error', evt);
        return {
          ok: false,
          error: { code: 'NETWORK', message: 'project not found' },
        };
      }
      const transient: ProjectPollState = {
        project,
        intervalMs: DEFAULT_INTERVAL_MS,
        timer: null,
        inflight: null,
        consecutiveErrors: 0,
        errorBackoffUntil: null,
        lastTickets: [],
        stoppedDueToAuth: false,
      };
      this.states.set(projectId, transient);
      const result = await this.runPoll(projectId, /* skipBackoff */ true);
      return result;
    }
    // If a tick is already running (e.g. the immediate tick from start()),
    // wait for it to settle before kicking off our own. We always run a
    // fresh poll so we return the latest result, not a stale cache.
    if (state.inflight !== null) {
      await state.inflight;
      state = this.states.get(projectId);
      if (state === undefined) {
        return {
          ok: false,
          error: { code: 'NETWORK', message: 'project no longer tracked' },
        };
      }
    }
    return this.runPoll(projectId, /* skipBackoff */ true);
  }

  /** Returns the cached eligible tickets (last poll result minus running/processed). */
  list(projectId: string): ReadonlyArray<Ticket> {
    const state = this.states.get(projectId);
    if (state === undefined) return [];
    return state.lastTickets;
  }

  /**
   * Verifies credentials without storing anything. Builds a transient
   * JiraClient via the same factory and calls `/myself`. The synthetic
   * project's connectionId / projectKey are placeholders — the factory
   * uses the explicit `host` and `auth` we pass in.
   */
  async testConnection(opts: {
    host: string;
    auth: JiraAuth;
  }): Promise<JiraResult<JiraSelfResponse>> {
    const synthetic: ProjectInstance = {
      id: '__test_connection__',
      name: '',
      repo: {
        type: 'github',
        localPath: '/',
        baseBranch: 'main',
        connectionId: '__test_connection__',
        slug: 'test/test',
      },
      tickets: {
        source: 'jira',
        connectionId: '__test_connection__',
        projectKey: 'TEST',
      },
      workflow: { mode: 'interactive', branchFormat: '{ticketKey}' },
      createdAt: 0,
      updatedAt: 0,
    };
    const client = this.jiraClientFactory({
      project: synthetic,
      host: opts.host,
      auth: opts.auth,
    });
    return client.testConnection();
  }

  // -- Internals -----------------------------------------------------------

  /**
   * Timer-driven entry point. Acquires the per-project mutex (drops if a
   * previous tick is still in flight), respects the `errorBackoffUntil`
   * window, and dispatches to `runPoll`.
   */
  private async tick(projectId: string): Promise<void> {
    const state = this.states.get(projectId);
    if (state === undefined) return;
    if (state.stoppedDueToAuth) return;
    if (state.inflight !== null) {
      // Per-project mutex: another tick is in flight; silently drop.
      return;
    }
    if (state.errorBackoffUntil !== null && Date.now() < state.errorBackoffUntil) {
      // Inside the back-off window — skip this tick.
      return;
    }
    await this.runPoll(projectId, /* skipBackoff */ false).catch(() => {
      // runPoll already routes errors through the `error` event; swallow
      // any thrown exception to keep the timer alive.
    });
  }

  /**
   * The actual poll body. Reads project state fresh, resolves the secret,
   * builds a JiraClient, runs the JQL, applies eligibility filters, diffs
   * against the cached tickets, emits events, updates state.
   */
  private async runPoll(
    projectId: string,
    skipBackoff: boolean,
  ): Promise<JiraResult<{ tickets: Ticket[] }>> {
    const state = this.states.get(projectId);
    if (state === undefined) {
      return { ok: false, error: { code: 'NETWORK', message: 'no poller state' } };
    }
    // Short-circuit if a previous poll already fired AUTH — don't re-hit
    // Jira and don't emit a duplicate error event for the same bad creds.
    // `start()` resets `stoppedDueToAuth`, so the user can retry after
    // updating credentials.
    if (state.stoppedDueToAuth) {
      return {
        ok: false,
        error: { code: 'AUTH', message: 'auth previously failed; call start() with new credentials' },
      };
    }
    // The mutex check lives in `tick()` — overlapping timer ticks are
    // dropped there. `refreshNow` waits for any inflight before calling us.
    // So at this point we're the sole runner.

    let resolveInflight!: () => void;
    state.inflight = new Promise<void>((r) => {
      resolveInflight = r;
    });

    /**
     * After every await we re-check that this poll is still relevant.
     * If `stop()` ran while we were awaiting, the state is no longer in
     * the map (or replaced by a new state from a fresh `start()`), and we
     * abort silently — no more HTTP calls, no events, no state mutation.
     */
    const stillTracked = (): boolean => this.states.get(projectId) === state;

    try {
      // Resolve the project from the store fresh — its JQL might have
      // changed since the timer was scheduled.
      const projectsRes = await this.projectStore.list();
      if (!stillTracked()) {
        return { ok: false, error: { code: 'NETWORK', message: 'poll aborted' } };
      }
      if (!projectsRes.ok) {
        return this.handleError(state, 'NETWORK', 'project store unavailable', skipBackoff);
      }
      const project = projectsRes.data.find((p) => p.id === projectId);
      if (project === undefined) {
        // Project was deleted mid-flight. Stop scheduling and emit error.
        if (state.timer !== null) {
          this.timers.clearInterval(state.timer);
          state.timer = null;
        }
        const evt: PollerErrorEvent = {
          projectId,
          code: 'PROJECT_NOT_FOUND',
          message: `project "${projectId}" no longer exists`,
          consecutiveErrors: state.consecutiveErrors + 1,
        };
        this.emit('error', evt);
        return {
          ok: false,
          error: { code: 'NETWORK', message: 'project not found' },
        };
      }
      state.project = project;

      // Resolve auth via the project's tickets.connectionId.
      const connectionId = project.tickets.connectionId;
      if (connectionId === undefined || connectionId === '') {
        return this.handleError(
          state,
          'NO_TOKEN',
          'project has no tickets.connectionId configured',
          skipBackoff,
        );
      }
      const connectionRes = await this.connectionStore.get(connectionId);
      if (!stillTracked()) {
        return { ok: false, error: { code: 'NETWORK', message: 'poll aborted' } };
      }
      if (!connectionRes.ok) {
        return this.handleError(
          state,
          'NO_TOKEN',
          `connection "${connectionId}" could not be resolved`,
          skipBackoff,
        );
      }
      const connection = connectionRes.data;
      const tokenRes = await this.secretsManager.get(connection.secretRef);
      if (!stillTracked()) {
        return { ok: false, error: { code: 'NETWORK', message: 'poll aborted' } };
      }
      if (!tokenRes.ok) {
        return this.handleError(
          state,
          'NO_TOKEN',
          `secret "${connection.secretRef}" could not be resolved`,
          skipBackoff,
        );
      }
      const plaintext = tokenRes.data.plaintext;
      if (plaintext === '') {
        return this.handleError(
          state,
          'NO_TOKEN',
          `secret "${connection.secretRef}" is empty`,
          skipBackoff,
        );
      }
      // Jira `api-token` connections store the secret as `email\ntoken`.
      // Defense-in-depth fallback: if no newline is present, treat the whole
      // value as the token and email as ''. testConnection / search will
      // surface AUTH on the next round-trip in that pathological case.
      let email: string;
      let apiToken: string;
      const nl = plaintext.indexOf('\n');
      if (nl < 0) {
        email = '';
        apiToken = plaintext;
      } else {
        email = plaintext.slice(0, nl);
        apiToken = plaintext.slice(nl + 1);
      }

      // Build the client and run the search. Default the JQL to
      // `project = "{key}"` when the project has no explicit override.
      const jql =
        project.tickets.query ?? `project = "${project.tickets.projectKey}"`;
      const client = this.jiraClientFactory({
        project,
        host: connection.host,
        auth: { email, apiToken },
      });
      const searchRes = await client.search(jql);
      if (!stillTracked()) {
        return { ok: false, error: { code: 'NETWORK', message: 'poll aborted' } };
      }
      if (!searchRes.ok) {
        const code = jiraCodeToPollerCode(searchRes.error.code);
        // Don't propagate the underlying message verbatim — JiraClient
        // already sanitizes, but stay defensive: use a fixed message that
        // includes only the code.
        return this.handleError(state, code, `Jira search failed: ${code}`, skipBackoff);
      }

      // Eligibility filter.
      const processed = new Set(this.runHistory.getProcessed(projectId));
      const running = new Set(this.runHistory.getRunning(projectId));
      const eligible = searchRes.data.tickets.filter(
        (t) => !processed.has(t.key) && !running.has(t.key),
      );

      // Diff and emit.
      if (ticketsDiffer(state.lastTickets, eligible)) {
        const evt: TicketsChangedEvent = {
          projectId,
          tickets: [...eligible],
          timestamp: Date.now(),
        };
        state.lastTickets = eligible;
        this.emit('tickets-changed', evt);
      }

      // Reset error counters on success.
      state.consecutiveErrors = 0;
      state.errorBackoffUntil = null;
      return { ok: true, data: { tickets: [...state.lastTickets] } };
    } finally {
      state.inflight = null;
      resolveInflight();
    }
  }

  /**
   * Error path: increment the error counter, set or clear the back-off
   * window, emit the `error` event, and stop the timer if AUTH.
   *
   * `skipBackoff: true` (used by `refreshNow`) still emits the error and
   * still increments the counter, but doesn't extend the back-off window —
   * a manual refresh shouldn't push the next scheduled tick further out.
   */
  private handleError(
    state: ProjectPollState,
    code: PollerErrorCode,
    message: string,
    skipBackoff: boolean,
  ): JiraResult<{ tickets: Ticket[] }> {
    // Counter always increments — the event reflects total consecutive
    // errors observed (manual + scheduled). The back-off WINDOW only
    // extends on scheduled ticks (the `!skipBackoff` guard a few lines
    // down) so manual refreshes don't push the next scheduled tick further
    // out.
    state.consecutiveErrors += 1;
    const evt: PollerErrorEvent = {
      projectId: state.project.id,
      code,
      message,
      consecutiveErrors: state.consecutiveErrors,
    };

    if (code === 'AUTH') {
      // Auth errors short-circuit: clear the timer and stop polling for
      // this project until `start()` is called again with new creds.
      if (state.timer !== null) {
        this.timers.clearInterval(state.timer);
        state.timer = null;
      }
      state.stoppedDueToAuth = true;
      state.errorBackoffUntil = null;
      this.emit('error', evt);
      return { ok: false, error: { code: 'AUTH', message } };
    }

    // PROJECT_NOT_FOUND is handled at the call site (it clears the timer
    // separately and emits the event there). NO_TOKEN and the transient
    // codes (NETWORK / TIMEOUT / RATE_LIMITED / SERVER_ERROR / INVALID_RESPONSE)
    // all back off but don't kill the timer.
    if (!skipBackoff) {
      const factor = Math.min(2 ** state.consecutiveErrors, MAX_BACKOFF_MULTIPLIER);
      state.errorBackoffUntil = Date.now() + state.intervalMs * factor;
    }

    this.emit('error', evt);
    // Map back to a JiraResult shape — code is a poller code, but the
    // returned shape uses Jira's narrower union; pick the closest match.
    const jiraCode: JiraErrorCode =
      code === 'NO_TOKEN' || code === 'PROJECT_NOT_FOUND' ? 'NETWORK' : (code as JiraErrorCode);
    return { ok: false, error: { code: jiraCode, message } };
  }

  // -- Typed event listener overloads --------------------------------------

  override on(event: 'tickets-changed', listener: (e: TicketsChangedEvent) => void): this;
  override on(event: 'error', listener: (e: PollerErrorEvent) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override on(event: string | symbol, listener: (...args: any[]) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  override emit(event: 'tickets-changed', e: TicketsChangedEvent): boolean;
  override emit(event: 'error', e: PollerErrorEvent): boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override emit(event: string | symbol, ...args: any[]): boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override emit(event: string | symbol, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }
}
