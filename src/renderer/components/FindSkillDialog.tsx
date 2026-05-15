import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import type { ApiSkill } from '@shared/ipc';
import { Badge } from './Badge';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { Input } from './Input';
import { IconSearch, IconSkills } from './icons';
import { dispatchToast } from '../state/notifications';
import styles from './FindSkillDialog.module.css';

export interface FindSkillDialogProps {
  open: boolean;
  /** Pre-fills the search input when the dialog opens. */
  initialQuery?: string;
  /**
   * Locally-installed skill ids (folder basenames). Used to dedupe API
   * results: rows whose `skillId` matches one of these render with an
   * "Installed" badge and a disabled Install button.
   */
  installedIds: ReadonlyArray<string>;
  onClose: () => void;
  /** Called after a successful install so the parent can refresh the list. */
  onInstalled?: () => void;
}

/** Page size for the skills.sh search request. Issue #GH-93 spec. */
export const PAGE_SIZE = 20;
/** Hard cap on total results to avoid runaway scrolling. Issue #GH-93 spec. */
export const MAX_RESULTS_CAP = 200;
/** Debounce window for input-driven searches. Submit-via-Enter is immediate. */
const SEARCH_DEBOUNCE_MS = 500;

function formatInstalls(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

interface SearchState {
  /** Query that produced the current result set. */
  query: string;
  /** Current limit requested (grows by PAGE_SIZE per scroll bump). */
  limit: number;
  results: ApiSkill[];
  /** Total reported by the API. Tracks when to stop paging. */
  total: number;
  loading: boolean;
  /** Banner-level error message (null when no error). */
  error: string | null;
}

const EMPTY_STATE: SearchState = {
  query: '',
  limit: 0,
  results: [],
  total: 0,
  loading: false,
  error: null,
};

export function FindSkillDialog({
  open,
  initialQuery = '',
  installedIds,
  onClose,
  onInstalled,
}: FindSkillDialogProps): JSX.Element {
  const [query, setQuery] = useState<string>(initialQuery);
  const [state, setState] = useState<SearchState>(EMPTY_STATE);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  /** Tracks the most recent in-flight request so out-of-order responses
   *  (slow first page returning AFTER a faster second-page kick-off) can be
   *  discarded by the UI. */
  const requestSeqRef = useRef<number>(0);
  /** Reset state when the dialog is opened so a previously-failed find
   *  doesn't bleed into the new session. We deliberately do NOT cache
   *  prior results — the skills.sh search is fast enough that re-fetch
   *  on reopen is acceptable, and stale rows from a different machine
   *  state (newly-installed skills, removed skills) are misleading. */
  useEffect(() => {
    if (!open) return;
    setQuery(initialQuery);
    setState(EMPTY_STATE);
    setInstallingId(null);
    setInstallError(null);
    requestSeqRef.current = 0;
  }, [open, initialQuery]);

  const installedSet = useMemo(() => new Set(installedIds), [installedIds]);

  /**
   * Run the skills.sh search. When `appendTo` is non-null, the new rows
   * are merged (deduped by skillId) onto the existing list — the
   * pagination path. When null, the response replaces the list — the
   * initial-search / new-query path.
   */
  const runSearch = useCallback(
    async (
      q: string,
      limit: number,
      appendTo: ApiSkill[] | null,
    ): Promise<void> => {
      const trimmed = q.trim();
      if (trimmed === '') {
        setState(EMPTY_STATE);
        return;
      }
      if (typeof window === 'undefined' || !window.api) {
        setState((s) => ({ ...s, error: 'IPC bridge unavailable', loading: false }));
        return;
      }
      const seq = ++requestSeqRef.current;
      // W1 fix: clear install-error banner when a new search kicks off so
      // a previously-failed install banner doesn't outlive its context.
      setInstallError(null);
      setState((s) => ({
        ...s,
        loading: true,
        error: null,
        // On a fresh query, clear results immediately so the loader has
        // the floor to itself; on append, keep what we have.
        results: appendTo ?? [],
        query: trimmed,
        limit,
      }));
      const result = await window.api.skills.search({ query: trimmed, limit });
      if (seq !== requestSeqRef.current) {
        // Newer request has been started; drop this response.
        return;
      }
      if (!result.ok) {
        setState((s) => ({
          ...s,
          loading: false,
          error: result.error.message || result.error.code || 'Search failed',
        }));
        return;
      }
      const incoming = result.data.skills;
      let next: ApiSkill[];
      if (appendTo === null) {
        next = incoming;
      } else {
        // The skills.sh API doesn't support `offset`, so we re-request
        // with a bigger `limit`. Merge by skillId to keep React keys
        // stable across page bumps + tolerate duplicate rows.
        const seen = new Set(appendTo.map((s) => s.skillId));
        const merged = [...appendTo];
        for (const row of incoming) {
          if (!seen.has(row.skillId)) {
            seen.add(row.skillId);
            merged.push(row);
          }
        }
        next = merged;
      }
      setState({
        query: trimmed,
        limit,
        results: next,
        total: result.data.count,
        loading: false,
        error: null,
      });
    },
    [],
  );

  /**
   * Debounced input → search. Submit-via-Enter bypasses the debounce by
   * calling runSearch directly through `handleSubmit`.
   */
  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (trimmed === '') {
      setState(EMPTY_STATE);
      requestSeqRef.current++;
      return;
    }
    if (trimmed === state.query) {
      return;
    }
    const t = setTimeout(() => {
      void runSearch(trimmed, PAGE_SIZE, null);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, open, state.query, runSearch]);

  const handleSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>): void => {
      e.preventDefault();
      const trimmed = query.trim();
      if (trimmed === '') return;
      void runSearch(trimmed, PAGE_SIZE, null);
    },
    [query, runSearch],
  );

  /** Triggered by the IntersectionObserver sentinel at the bottom. */
  const handleLoadMore = useCallback((): void => {
    if (state.loading) return;
    if (state.error !== null) return;
    if (state.query === '') return;
    if (state.results.length >= state.total) return;
    if (state.results.length >= MAX_RESULTS_CAP) return;
    const nextLimit = Math.min(state.limit + PAGE_SIZE, MAX_RESULTS_CAP);
    if (nextLimit <= state.limit) return;
    void runSearch(state.query, nextLimit, state.results);
  }, [state, runSearch]);

  // Wire up the IntersectionObserver. We attach to a sentinel <div> at
  // the bottom of the results list; when it intersects the viewport (the
  // scrollable parent), we trigger the next page.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const sentinel = sentinelRef.current;
    const root = scrollContainerRef.current;
    if (sentinel === null || root === null) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            handleLoadMore();
          }
        }
      },
      { root, threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [open, handleLoadMore]);

  const handleInstall = useCallback(
    async (row: ApiSkill): Promise<void> => {
      if (typeof window === 'undefined' || !window.api) return;
      setInstallingId(row.skillId);
      setInstallError(null);
      try {
        // The skills CLI expects `owner/repo` (the source repository), not
        // the bare `skillId`. Without this, `skills add <skillId>` tries to
        // clone a non-existent top-level repo and fails with
        // "fatal: repository '<skillId>' does not exist".
        const result = await window.api.skills.install({ ref: row.source });
        if (!result.ok) {
          setInstallError(result.error.message || result.error.code || 'Install failed');
          return;
        }
        if (result.data.status === 'failed') {
          const tail = result.data.stderr.trim() || result.data.stdout.trim() || 'install failed';
          setInstallError(tail);
          return;
        }
        onInstalled?.();
        dispatchToast({
          type: 'success',
          title: `Installed ${row.name}`,
          ttlMs: 4_000,
          dedupeKey: `skill-install-${row.skillId}`,
        });
      } finally {
        setInstallingId(null);
      }
    },
    [onInstalled],
  );

  const hasResults = state.results.length > 0;
  const isInitialLoading = state.loading && !hasResults;
  const isPaging = state.loading && hasResults;
  const isAtCap = state.results.length >= MAX_RESULTS_CAP;
  const isExhausted =
    !state.loading && hasResults && state.results.length >= state.total;
  const showEmpty =
    !state.loading && !state.error && state.query !== '' && state.results.length === 0;
  const showHint = !state.loading && state.error === null && state.query === '';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Find Skill"
      subtitle="Search the skills.sh registry by name, description, or keyword."
      data-testid="find-skill-dialog"
    >
      <div className={styles.body} data-testid="find-skill-body">
        <form
          className={`${styles.searchRow} ${styles.bodyHeader}`}
          onSubmit={handleSubmit}
          data-testid="find-skill-body-header"
        >
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='e.g. "ui" or "deploy to fly.io"'
            leadingIcon={<IconSearch size={14} />}
            data-testid="find-skill-search"
          />
          <Button
            type="submit"
            variant="primary"
            leadingIcon={<IconSkills size={14} />}
            disabled={query.trim() === '' || state.loading}
            data-testid="find-skill-submit"
          >
            Search
          </Button>
        </form>

        <div
          className={styles.bodyScroll}
          ref={scrollContainerRef}
          data-testid="find-skill-body-scroll"
        >
          {state.error !== null && (
            <div className={styles.errorBanner} role="alert" data-testid="find-skill-error">
              <strong>Couldn't search skills.</strong> {state.error}
            </div>
          )}

          {showHint && (
            <div className={styles.streamHint} data-testid="find-skill-hint">
              Type a query to search the public skills.sh catalog. Press
              Enter or click Search to fetch results.
            </div>
          )}

          {isInitialLoading && (
            <div className={styles.loadingFigure} data-testid="find-skill-loading">
              <span className={styles.loadingFigureCaption}>Searching skills…</span>
            </div>
          )}

          {showEmpty && (
            <div className={styles.streamHint} data-testid="find-skill-empty-result">
              No skills found for that query. Try a different keyword.
            </div>
          )}

          {hasResults && (
            <ul className={styles.resultsList} data-testid="find-skill-results">
              {state.results.map((row) => {
                const isInstalled = installedSet.has(row.skillId);
                const isInstalling = installingId === row.skillId;
                return (
                  <li
                    key={row.skillId}
                    className={styles.resultRow}
                    data-testid={`find-skill-row-${row.skillId}`}
                  >
                    <div className={styles.resultBody}>
                      <div className={styles.resultHead}>
                        <span className={styles.resultName} title={row.name}>
                          {row.name}
                        </span>
                        {isInstalled && (
                          <Badge variant="success">Installed</Badge>
                        )}
                      </div>
                      <div className={styles.resultMeta}>
                        <span className={styles.resultSource} title={row.source}>
                          {row.source}
                        </span>
                        <span className={styles.resultDot} aria-hidden="true">·</span>
                        <span className={styles.resultInstalls}>
                          {formatInstalls(row.installs)} installs
                        </span>
                      </div>
                    </div>
                    <div className={styles.resultActions}>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => void handleInstall(row)}
                        disabled={isInstalled || isInstalling || installingId !== null}
                        data-testid={`find-skill-install-${row.skillId}`}
                      >
                        {isInstalled ? 'Installed' : isInstalling ? 'Installing…' : 'Install'}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {/* W2 fix: sentinel is a sibling of the <ul>, not a child of it
              (HTML5 forbids non-<li> children of <ul>). The
              IntersectionObserver only needs `root` to be the scroll
              container — which it is — and `target` to be the sentinel,
              which still gets observed regardless of where it sits in
              the DOM tree. */}
          {hasResults && (
            <div
              ref={sentinelRef}
              className={styles.sentinel}
              data-testid="find-skill-sentinel"
              aria-hidden="true"
            />
          )}

          {isPaging && (
            <div className={styles.pagingSpinner} data-testid="find-skill-paging">
              Loading more…
            </div>
          )}

          {hasResults && (isExhausted || isAtCap) && (
            <div
              className={styles.exhausted}
              data-testid={isAtCap ? 'find-skill-cap-reached' : 'find-skill-exhausted'}
            >
              {isAtCap
                ? `Showing the first ${MAX_RESULTS_CAP} results — refine your search to see more.`
                : 'No more results.'}
            </div>
          )}
        </div>

        {installError !== null && (
          <div
            className={styles.errorBanner}
            role="alert"
            data-testid="find-skill-install-error"
          >
            <strong>Install failed.</strong> {installError}
          </div>
        )}
      </div>
    </Dialog>
  );
}
