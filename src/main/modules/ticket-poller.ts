/**
 * `TicketPoller` — orchestrates per-project ticket polling on a fixed cadence,
 * dispatching to a source-specific strategy (Jira / GitHub Issues / …) for
 * the actual fetch. Was `JiraPoller` before the project-pickers-polish bundle.
 *
 * Per project we track:
 *   - the project snapshot (used to read the source config fresh on each tick)
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
 *
 * Source dispatch — `buildSourceClient(project)` looks at
 * `project.tickets.source` and delegates to `buildJiraSource` /
 * `buildGithubIssuesSource`. The poller never sees the raw HTTP shape; the
 * strategy returns mapped `Ticket[]`.
 */

import { EventEmitter } from 'node:events';
import { FetchHttpClient, type HttpClient } from './http-client.js';
import {
  JiraClient,
  type JiraAuth,
  type JiraResult,
  type JiraSelfResponse,
} from './jira-client.js';
import { buildJiraSource } from './jira-source.js';
import { buildGithubIssuesSource } from './github-issues-source.js';
import type { RunHistory } from './run-history.js';
import type { ProjectInstance } from '../../shared/schema/project-instance.js';
import type { Ticket } from '../../shared/schema/ticket.js';
import type {
  ConnectionStoreLike,
  PollerErrorCode,
  SecretsManagerLike,
  TicketListOptions,
  TicketListPage,
  TicketSourceClient,
} from './ticket-poller-types.js';

export type {
  ConnectionStoreLike,
  PollerErrorCode,
  TicketListOptions,
  TicketListPage,
  TicketSourceClient,
} from './ticket-poller-types.js';

export interface PollerTimers {
  setInterval: (cb: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

interface ProjectStoreLike {
  list(): Promise<{ ok: true; data: ProjectInstance[] } | { ok: false; error: unknown }>;
}

/**
 * Per-poll context for the legacy `jiraClientFactory` test seam. Kept around
 * because the existing JP-CONN tests inject it directly; the default Jira
 * source factory honors it (so the recorded `host` + `auth` still flow
 * through unchanged).
 */
export interface JiraClientFactoryContext {
  project: ProjectInstance;
  host: string;
  auth: JiraAuth;
}

/**
 * Strategy factory — builds a `TicketSourceClient` for one poll. Default
 * implementation dispatches by `project.tickets.source`. Tests that want
 * to inject a fake source-builder can pass `sourceFactory` directly.
 */
export type SourceFactory = (
  project: ProjectInstance,
) => Promise<
  | { ok: true; client: TicketSourceClient }
  | { ok: false; code: PollerErrorCode; message: string }
>;

export interface TicketPollerOptions {
  projectStore: ProjectStoreLike;
  connectionStore: ConnectionStoreLike;
  secretsManager: SecretsManagerLike;
  runHistory: RunHistory;
  /**
   * Legacy test hook: build a JiraClient for a given project. If supplied,
   * the default Jira source factory routes through it so the ProjectStore +
   * ConnectionStore plumbing still runs but the actual JiraClient is the
   * test's fake. Tests that want a different source strategy entirely should
   * pass `sourceFactory` instead.
   */
  jiraClientFactory?: (ctx: JiraClientFactoryContext) => JiraClient;
  /** Test injection for the source-strategy dispatcher. */
  sourceFactory?: SourceFactory;
  /** Test injection for setInterval / clearInterval. Default uses globalThis. */
  timers?: PollerTimers;
  /** Test injection for the underlying HTTP client used by source strategies. */
  httpClient?: HttpClient;
}

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

export class TicketPoller extends EventEmitter {
  private readonly projectStore: ProjectStoreLike;
  private readonly connectionStore: ConnectionStoreLike;
  private readonly secretsManager: SecretsManagerLike;
  private readonly runHistory: RunHistory;
  private readonly jiraClientFactory:
    | ((ctx: JiraClientFactoryContext) => JiraClient)
    | undefined;
  private readonly sourceFactory: SourceFactory;
  private readonly timers: PollerTimers;
  private readonly httpClient: HttpClient;

  private readonly states: Map<string, ProjectPollState> = new Map();

  constructor(options: TicketPollerOptions) {
    super();
    this.projectStore = options.projectStore;
    this.connectionStore = options.connectionStore;
    this.secretsManager = options.secretsManager;
    this.runHistory = options.runHistory;
    this.jiraClientFactory = options.jiraClientFactory;
    this.timers = options.timers ?? defaultTimers();
    this.httpClient = options.httpClient ?? new FetchHttpClient();
    this.sourceFactory = options.sourceFactory ?? this.defaultSourceFactory();
  }

  /**
   * Default source-factory dispatcher — picks a strategy based on
   * `project.tickets.source`. Honors the legacy `jiraClientFactory` injection
   * by routing the Jira strategy through it so existing JP-CONN tests don't
   * need to swap to a full SourceFactory.
   *
   * NOTE: this is a NON-async function returning a Promise directly (rather
   * than `async (...) => buildJiraSource(...)`) so we don't add an extra
   * microtask wrap around the strategy build. Subtle but real: the existing
   * POLLER-005 test asserts that exactly one HTTP call occurs after a
   * specific number of `await Promise.resolve()` flushes; an extra wrap
   * here pushes the http call past that boundary.
   */
  private defaultSourceFactory(): SourceFactory {
    return (project): ReturnType<SourceFactory> => {
      const src = project.tickets.source;
      if (src === 'jira') {
        const opts: Parameters<typeof buildJiraSource>[1] = {
          connectionStore: this.connectionStore,
          secretsManager: this.secretsManager,
          httpClient: this.httpClient,
        };
        if (this.jiraClientFactory !== undefined) {
          // Bridge the legacy ctx-based factory to the new options-based one.
          const legacy = this.jiraClientFactory;
          opts.jiraClientFactory = (clientOpts) =>
            legacy({ project, host: clientOpts.host, auth: clientOpts.auth });
        }
        return buildJiraSource(project, opts);
      }
      if (src === 'github-issues') {
        return buildGithubIssuesSource(project, {
          connectionStore: this.connectionStore,
          secretsManager: this.secretsManager,
          httpClient: this.httpClient,
        });
      }
      // Future-proofing: an unknown discriminator. The validator should
      // already have rejected this, but stay defensive.
      return Promise.resolve({
        ok: false,
        code: 'INVALID_RESPONSE',
        message: `unknown ticket source "${src as string}"`,
      });
    };
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
   * Paginated source-direct list. Bypasses the cache — always rebuilds the
   * source strategy and calls `listPage` so sort + search land on a fresh
   * server-side query. Eligibility (processed / running) is filtered after
   * the fetch so the renderer doesn't see tickets that are already mid-run.
   *
   * The page size may shrink slightly when eligibility removes some rows;
   * the renderer treats an undefined `nextCursor` as "no more rows" and
   * shorter-than-requested pages as a normal partial result.
   */
  async listPage(
    projectId: string,
    opts: TicketListOptions,
  ): Promise<
    | { ok: true; data: TicketListPage }
    | { ok: false; code: PollerErrorCode; message: string }
  > {
    // Resolve the project from the store. We read fresh on every call so
    // recently-edited tickets config (JQL, labels) lands without a poller
    // restart — same rationale as `runPoll`.
    const projectsRes = await this.projectStore.list();
    if (!projectsRes.ok) {
      return { ok: false, code: 'NETWORK', message: 'project store unavailable' };
    }
    const project = projectsRes.data.find((p) => p.id === projectId);
    if (project === undefined) {
      return { ok: false, code: 'PROJECT_NOT_FOUND', message: `no project with id "${projectId}"` };
    }

    const sourceRes = await this.sourceFactory(project);
    if (!sourceRes.ok) {
      return { ok: false, code: sourceRes.code, message: sourceRes.message };
    }

    const pageRes = await sourceRes.client.listPage(opts);
    if (!pageRes.ok) {
      return { ok: false, code: pageRes.code, message: pageRes.message };
    }

    // Eligibility filter — same predicate the polling tick uses. Drop
    // tickets currently mid-run so the user can't accidentally start a
    // second concurrent workflow on the same ticket. Tickets that have
    // *already* completed a run still appear here — source-side state
    // (Jira closed, GitHub closed/merged-PR auto-close) is the source of
    // truth for "this ticket is done."
    const running = new Set(this.runHistory.getRunning(projectId));
    const filtered = pageRes.data.rows.filter((t) => !running.has(t.key));
    return {
      ok: true,
      data: { rows: filtered, nextCursor: pageRes.data.nextCursor },
    };
  }

  /**
   * Verifies Jira credentials without storing anything. Builds a transient
   * JiraClient via the legacy `jiraClientFactory` if present (so the
   * existing JP-CONN tests keep working) or via the default constructor
   * otherwise. The poller class also exposes this for the renderer's
   * `jira:test-connection` IPC.
   */
  async testConnection(opts: {
    host: string;
    auth: JiraAuth;
  }): Promise<JiraResult<JiraSelfResponse>> {
    let client: JiraClient;
    if (this.jiraClientFactory !== undefined) {
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
      client = this.jiraClientFactory({
        project: synthetic,
        host: opts.host,
        auth: opts.auth,
      });
    } else {
      client = new JiraClient({
        httpClient: this.httpClient,
        host: opts.host,
        auth: opts.auth,
      });
    }
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
   * The actual poll body. Reads project state fresh, builds a source-strategy
   * client via the SourceFactory, runs the fetch, applies eligibility filters,
   * diffs against the cached tickets, emits events, updates state.
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
    // the source and don't emit a duplicate error event for the same bad
    // creds. `start()` resets `stoppedDueToAuth`, so the user can retry
    // after updating credentials.
    if (state.stoppedDueToAuth) {
      return {
        ok: false,
        error: { code: 'AUTH', message: 'auth previously failed; call start() with new credentials' },
      };
    }

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
      // Resolve the project from the store fresh — its source config
      // might have changed since the timer was scheduled.
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

      // Build a source-strategy client for this project (auth resolution +
      // client construction lives inside the strategy).
      const sourceRes = await this.sourceFactory(project);
      if (!stillTracked()) {
        return { ok: false, error: { code: 'NETWORK', message: 'poll aborted' } };
      }
      if (!sourceRes.ok) {
        return this.handleError(state, sourceRes.code, sourceRes.message, skipBackoff);
      }

      const fetchRes = await sourceRes.client.fetchTickets();
      if (!stillTracked()) {
        return { ok: false, error: { code: 'NETWORK', message: 'poll aborted' } };
      }
      if (!fetchRes.ok) {
        return this.handleError(state, fetchRes.code, fetchRes.message, skipBackoff);
      }

      // Eligibility filter — drop currently-running tickets so the
      // background poll's cached snapshot stays consistent with what the
      // paginated `listPage` returns. Source-side state is the source of
      // truth for "this ticket is done"; we no longer maintain a local
      // processed set.
      const running = new Set(this.runHistory.getRunning(projectId));
      const eligible = fetchRes.tickets.filter((t) => !running.has(t.key));

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
    // Map back to a JiraResult-compatible shape — the IPC contract still
    // names this `JiraResult` to avoid renderer churn. Treat NO_TOKEN /
    // PROJECT_NOT_FOUND as NETWORK; pass through everything else.
    const outCode: 'NETWORK' | 'TIMEOUT' | 'AUTH' | 'NOT_FOUND' | 'RATE_LIMITED' | 'SERVER_ERROR' | 'INVALID_RESPONSE' =
      code === 'NO_TOKEN' || code === 'PROJECT_NOT_FOUND' ? 'NETWORK' : code;
    return { ok: false, error: { code: outCode, message } };
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

/**
 * Back-compat alias — old `JiraPoller` import sites keep working without
 * the rename touching every caller. New code should use `TicketPoller`.
 */
export const JiraPoller = TicketPoller;
export type JiraPoller = TicketPoller;
export type JiraPollerOptions = TicketPollerOptions;
