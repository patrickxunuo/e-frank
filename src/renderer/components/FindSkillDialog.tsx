import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import Lottie from 'lottie-react';
import type { SkillsFindExitEvent, SkillsFindOutputEvent } from '@shared/ipc';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { Input } from './Input';
import { IconExternal, IconSkills } from './icons';
import { PaperplaneGlyph } from './PaperplaneGlyph';
import { parseSkillCandidates, type SkillCandidate } from './find-skill-candidates';
import { getSkillSourceUrl } from './skill-source-url';
import { dispatchToast } from '../state/notifications';
import {
  clearFindSkillCache,
  getFindSkillCache,
  saveFindSkillCache,
  type OutputLine,
} from '../state/find-skill-cache';
import paperplaneAnimation from '../../../design/logo/paperplane-floating.lottie.json';
import styles from './FindSkillDialog.module.css';

export interface FindSkillDialogProps {
  open: boolean;
  /** Pre-fills the search input when the dialog opens. */
  initialQuery?: string;
  onClose: () => void;
  /** Called after a successful install so the parent can refresh the list. */
  onInstalled?: () => void;
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function usePrefersReducedMotion(): boolean {
  const [prefers, setPrefers] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia(REDUCED_MOTION_QUERY).matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mq = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = (e: MediaQueryListEvent): void => setPrefers(e.matches);
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, []);
  return prefers;
}

export function FindSkillDialog({
  open,
  initialQuery = '',
  onClose,
  onInstalled,
}: FindSkillDialogProps): JSX.Element {
  // Seed all "persistable" state from the cache so a remount picks up
  // the previous find's result. The useEffect below handles the
  // open-prop transition path; useState initializers cover the very
  // first render.
  const initialCache = getFindSkillCache();
  const [query, setQuery] = useState<string>(
    initialQuery !== '' ? initialQuery : initialCache.query,
  );
  const [activeFindId, setActiveFindId] = useState<string | null>(null);
  const [lines, setLines] = useState<OutputLine[]>(() => [...initialCache.lines]);
  const [findError, setFindError] = useState<string | null>(initialCache.findError);
  const [installingRef, setInstallingRef] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [manualRef, setManualRef] = useState<string>('');
  const lineIdRef = useRef<number>(initialCache.nextLineId);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /**
   * Tracks whether the current in-flight find has streamed at least
   * one line. We use this to defer clearing the cache until first
   * line, so that hitting Stop before any output preserves the
   * previously-cached candidates instead of wiping them.
   */
  const gotFirstLineRef = useRef<boolean>(false);
  /**
   * The query that was passed to the in-flight find. Captured at
   * find-start so the cache `save` on exit can record the right
   * query string regardless of what the input shows now (the user
   * may have started typing a new query while the find ran).
   */
  const inflightQueryRef = useRef<string>('');

  // Hydrate state on dialog open. If `initialQuery` prop is provided
  // AND differs from the cached query, the prop wins (e.g. the Skills
  // EmptyState CTA passes `ef-feature` — it's an explicit intent to
  // search for that ref, not to re-display whatever was last cached).
  // Otherwise, restore from cache.
  useEffect(() => {
    if (!open) return;
    const cached = getFindSkillCache();
    const useProp = initialQuery !== '' && initialQuery !== cached.query;
    if (useProp) {
      setQuery(initialQuery);
      setLines([]);
      setFindError(null);
      lineIdRef.current = 0;
    } else {
      setQuery(cached.query);
      setLines([...cached.lines]);
      setFindError(cached.findError);
      lineIdRef.current = cached.nextLineId;
    }
    // These are transient — always reset on open regardless of cache.
    setInstallError(null);
    setManualRef('');
    setActiveFindId(null);
    gotFirstLineRef.current = false;
  }, [open, initialQuery]);

  // Subscribe to streaming output + exit events when a find is in flight.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.api || activeFindId === null) {
      return;
    }
    const api = window.api;
    const offOutput = api.skills.onFindOutput((e: SkillsFindOutputEvent) => {
      if (e.findId !== activeFindId) return;
      // First line of this find → commit to the new search. Clear the
      // cache so a downstream Stop-without-output snapshot can't
      // restore stale lines mid-stream, and clear the visible-from-
      // cache lines so the new result isn't appended to the old one.
      if (!gotFirstLineRef.current) {
        gotFirstLineRef.current = true;
        clearFindSkillCache();
        setLines([]);
        setFindError(null);
        lineIdRef.current = 0;
      }
      setLines((prev) => [
        ...prev,
        {
          id: lineIdRef.current++,
          stream: e.stream,
          text: e.line,
        },
      ]);
    });
    const offExit = api.skills.onFindExit((e: SkillsFindExitEvent) => {
      if (e.findId !== activeFindId) return;
      setActiveFindId(null);
      let nextFindError: string | null = null;
      if (e.reason === 'error') {
        nextFindError = 'find-skills failed to run (Claude CLI not installed?).';
      } else if (e.reason === 'completed' && e.exitCode !== null && e.exitCode !== 0) {
        // Surface non-zero exit codes so the user knows /find-skills
        // didn't finish cleanly (e.g. Claude rate-limited or the skill
        // isn't installed). The streamed stderr is already visible
        // in the output area — banner just names the failure.
        nextFindError = `find-skills exited with code ${e.exitCode}`;
      }
      setFindError(nextFindError);

      if (gotFirstLineRef.current) {
        // The find produced output → commit the new result to the
        // cache. Use functional setLines so we capture the latest
        // queued state (avoids a stale-closure on the lines array).
        setLines((prev) => {
          saveFindSkillCache({
            query: inflightQueryRef.current,
            lines: prev,
            findError: nextFindError,
            nextLineId: lineIdRef.current,
          });
          return prev;
        });
      } else {
        // Cancelled / errored before first line → previously-cached
        // candidates (if any) are still intact. Restore them so the
        // user gets back to what they were looking at before the
        // aborted re-search.
        const cached = getFindSkillCache();
        setLines([...cached.lines]);
        setFindError(cached.findError);
        setQuery(cached.query);
        lineIdRef.current = cached.nextLineId;
      }
    });
    return () => {
      offOutput();
      offExit();
    };
  }, [activeFindId]);

  // Auto-scroll the output area when new lines arrive — but ONLY when
  // the user is already pinned to the bottom. If they've scrolled up to
  // read earlier candidates, leave their scroll position alone so we
  // don't yank them back. 8px epsilon absorbs sub-pixel rounding.
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom <= 8) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines]);

  // Run the structured-output parser over the accumulated stdout. The
  // SkillFinder is now driven by a prompt that asks Claude to respond
  // ONLY with a JSON array; we slice the first `[...]` out and validate.
  // If Claude rambles instead, `parsed` flips false and the dialog
  // shows the raw stream + manual install input as a fallback.
  const stdoutText = useMemo(
    () => lines.filter((l) => l.stream === 'stdout').map((l) => l.text).join('\n'),
    [lines],
  );
  const { candidates, parsed: hasStructuredCandidates } = useMemo(
    () => parseSkillCandidates(stdoutText),
    [stdoutText],
  );

  const handleStartFind = useCallback(
    async (e?: FormEvent<HTMLFormElement>): Promise<void> => {
      e?.preventDefault();
      if (typeof window === 'undefined' || !window.api) return;
      const trimmed = query.trim();
      if (trimmed === '') return;
      // Local lines reset so the loading indicator shows — but the
      // cache stays intact until the FIRST streamed line of this new
      // find (`gotFirstLineRef` path above). That lets Stop-before-
      // output restore the previously-cached candidates rather than
      // wiping them silently.
      setLines([]);
      setFindError(null);
      lineIdRef.current = 0;
      gotFirstLineRef.current = false;
      inflightQueryRef.current = trimmed;
      const result = await window.api.skills.findStart({ query: trimmed });
      if (!result.ok) {
        // Find-start IPC failed (validator rejected the query, or no
        // bridge). Restore the previously-cached state so the dialog
        // is back to its pre-search appearance. No new lines were
        // ever produced, so the cache is still authoritative.
        const cached = getFindSkillCache();
        setLines([...cached.lines]);
        setFindError(result.error.message || result.error.code || 'find-skills failed');
        lineIdRef.current = cached.nextLineId;
        return;
      }
      setActiveFindId(result.data.findId);
    },
    [query],
  );

  const handleCancel = useCallback(async (): Promise<void> => {
    if (typeof window === 'undefined' || !window.api || activeFindId === null) return;
    await window.api.skills.findCancel({ findId: activeFindId });
  }, [activeFindId]);

  const handleInstall = useCallback(
    async (ref: string, displayName?: string): Promise<void> => {
      if (typeof window === 'undefined' || !window.api) return;
      const trimmed = ref.trim();
      if (trimmed === '') return;
      setInstallingRef(trimmed);
      setInstallError(null);
      try {
        const result = await window.api.skills.install({ ref: trimmed });
        if (!result.ok) {
          setInstallError(`${result.error.message || result.error.code}`);
          return;
        }
        if (result.data.status === 'failed') {
          const tail = result.data.stderr.trim() || result.data.stdout.trim() || 'install failed';
          setInstallError(tail);
          return;
        }
        // Success — refresh the parent list and clear the manual input.
        setManualRef('');
        onInstalled?.();
        dispatchToast({
          type: 'success',
          title: `Installed ${displayName ?? trimmed}`,
          ttlMs: 4_000,
          dedupeKey: `skill-install-${trimmed}`,
        });
      } finally {
        setInstallingRef(null);
      }
    },
    [onInstalled],
  );

  const handleOpenSource = useCallback(async (ref: string): Promise<void> => {
    if (typeof window === 'undefined' || !window.api) return;
    const url = getSkillSourceUrl(ref);
    if (url === null) return;
    await window.api.shell.openExternal({ url });
  }, []);

  /**
   * Wipe both the persisted cache and the dialog's local view. The
   * dialog falls back to its pre-search empty-state hint. The user
   * keeps any draft query they typed — only the search results are
   * cleared, since that's what "Clear" reads as in this context.
   */
  const handleClear = useCallback((): void => {
    clearFindSkillCache();
    setLines([]);
    setFindError(null);
    setQuery('');
    lineIdRef.current = 0;
  }, []);

  const isFinding = activeFindId !== null;
  const prefersReducedMotion = usePrefersReducedMotion();
  // Once we have parsed candidates, hide the raw stream — the cards
  // ARE the result view. Keep the stream visible for in-flight finds
  // and for the fallback (no JSON detected).
  const showRawStream = !hasStructuredCandidates;

  return (
    <Dialog
      open={open}
      onClose={() => {
        // Block backdrop / Esc / X-button close while a find is in
        // flight — Claude's output is the *result* of the search, so
        // an accidental click outside shouldn't throw away 30s of
        // streamed candidates. The user must hit Stop explicitly to
        // cancel; once `isFinding` flips false the dialog closes
        // normally.
        if (isFinding) return;
        onClose();
      }}
      size="lg"
      title="Find Skill"
      subtitle="Ask Claude what skill best fits your stack or workflow."
      data-testid="find-skill-dialog"
    >
      <div className={styles.body} data-testid="find-skill-body">
        {/*
         * Three-row grid: sticky search top, scrollable middle region
         * (loader + raw-stream + candidates list), sticky manual-install
         * bottom. Long candidate lists no longer push the search input
         * or the manual-install fallback off-screen.
         */}
        <form
          className={`${styles.searchRow} ${styles.bodyHeader}`}
          onSubmit={(e) => void handleStartFind(e)}
          data-testid="find-skill-body-header"
        >
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='e.g. "image cropping" or "deploy to fly.io"'
            disabled={isFinding}
            data-testid="find-skill-search"
          />
          {isFinding ? (
            <Button
              type="button"
              variant="destructive"
              onClick={() => void handleCancel()}
              data-testid="find-skill-cancel"
            >
              Stop
            </Button>
          ) : (
            <Button
              type="submit"
              variant="primary"
              leadingIcon={<IconSkills size={14} />}
              disabled={query.trim() === ''}
              data-testid="find-skill-submit"
            >
              Search
            </Button>
          )}
        </form>

        <div className={styles.bodyScroll} data-testid="find-skill-body-scroll">
          {findError && (
            <div className={styles.errorBanner} role="alert" data-testid="find-skill-error">
              <strong>Couldn't run find-skills.</strong> {findError}
            </div>
          )}

          {/*
           * Paperplane Lottie loader — shown while a find is in flight and
           * no output has streamed yet. Once Claude starts producing
           * lines, the loader collapses and the stream / cards take over.
           * `prefers-reduced-motion: reduce` falls back to the static
           * paperplane glyph (same affordance, no animation).
           */}
          {isFinding && lines.length === 0 && (
            <div className={styles.loadingFigure} data-testid="find-skill-loading-figure">
              {prefersReducedMotion ? (
                <svg
                  width={80}
                  height={80}
                  viewBox="0 0 32 32"
                  className={styles.loadingFigureStatic}
                  aria-hidden="true"
                >
                  <PaperplaneGlyph />
                </svg>
              ) : (
                <div className={styles.loadingFigureLottie} aria-hidden="true">
                  <Lottie animationData={paperplaneAnimation} loop autoplay />
                </div>
              )}
              <span className={styles.loadingFigureCaption}>Searching skills…</span>
            </div>
          )}

          {/*
           * Raw stream fallback. Shown when:
           *   - the find is mid-flight (so the user sees something happening
           *     even before Claude emits valid JSON), OR
           *   - the find has completed but no JSON array was detectable
           *     (Claude rambled instead of complying with the format).
           * Hidden once `parseSkillCandidates` succeeds.
           */}
          {showRawStream && lines.length > 0 && (
            <div className={styles.stream} ref={scrollRef} data-testid="find-skill-stream">
              {lines.map((line) => (
                <div
                  key={line.id}
                  className={styles.streamLine}
                  data-stream={line.stream}
                >
                  {line.text}
                </div>
              ))}
            </div>
          )}

          {/*
           * Empty-state hint before any search has been kicked off.
           */}
          {showRawStream && lines.length === 0 && !isFinding && (
            <div className={styles.streamHint}>
              Search asks Claude to find Claude Code skills matching your query
              and returns them as structured cards with an inline Install
              button for each.
            </div>
          )}

          {hasStructuredCandidates && candidates.length === 0 && !isFinding && (
            <div className={styles.streamHint} data-testid="find-skill-empty-result">
              Claude didn't recommend any skills for that query. Try a
              different keyword, or paste a skill ref below if you know
              the name.
            </div>
          )}

          {candidates.length > 0 && (
            <div className={styles.candidates} data-testid="find-skill-candidates">
              <div className={styles.candidatesHead}>
                <span className={styles.candidatesLabel}>Recommended skills</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleClear}
                  disabled={isFinding}
                  data-testid="find-skill-clear"
                >
                  Clear
                </Button>
              </div>
              <div className={styles.candidateList} data-layout="row">
                {candidates.map((c) => (
                  <SkillCandidateCard
                    key={c.ref}
                    candidate={c}
                    installing={installingRef === c.ref}
                    disabled={installingRef !== null && installingRef !== c.ref}
                    onInstall={() => void handleInstall(c.ref, c.name)}
                    onOpenSource={() => void handleOpenSource(c.ref)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        <div className={styles.bodyFooter} data-testid="find-skill-body-footer">
          <div className={styles.manualBlock}>
            <div className={styles.manualHead}>Install by name</div>
            <p className={styles.manualHint}>
              If the recommendation you want isn't detected, paste the skill ref
              here (e.g. <code>ef-feature</code> or <code>owner/repo</code>).
            </p>
            <div className={styles.manualRow}>
              <Input
                value={manualRef}
                onChange={(e) => setManualRef(e.target.value)}
                placeholder="skill-ref"
                data-testid="find-skill-install-input"
              />
              <Button
                variant="primary"
                onClick={() => void handleInstall(manualRef)}
                disabled={manualRef.trim() === '' || installingRef !== null}
                data-testid="find-skill-install-manual"
              >
                {installingRef === manualRef.trim() ? 'Installing…' : 'Install'}
              </Button>
            </div>
          </div>

          {installError && (
            <div className={styles.errorBanner} role="alert" data-testid="find-skill-install-error">
              <strong>Install failed.</strong> {installError}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

interface SkillCandidateCardProps {
  candidate: SkillCandidate;
  installing: boolean;
  /** Another candidate is being installed — block this card's Install. */
  disabled: boolean;
  onInstall: () => void;
  onOpenSource: () => void;
}

/**
 * One row per recommended skill. Left column: name + stars + ref pill +
 * description. Right column: action cluster (View source + Install).
 * Single-column list — wider rows make space for the description
 * without truncating it on the first line.
 *
 * The View button is omitted entirely (not just disabled) when the
 * ref doesn't resolve to a known web source — `find-skills` style
 * bare-name refs have no URL we trust enough to open.
 */
function SkillCandidateCard({
  candidate,
  installing,
  disabled,
  onInstall,
  onOpenSource,
}: SkillCandidateCardProps): JSX.Element {
  const sourceUrl = getSkillSourceUrl(candidate.ref);
  return (
    <article className={styles.card} data-testid={`find-skill-card-${candidate.ref}`}>
      <div className={styles.cardBody}>
        <header className={styles.cardHead}>
          <span className={styles.cardName} title={candidate.name}>
            {candidate.name}
          </span>
          <span className={styles.cardStars} aria-label="GitHub stars">
            <span aria-hidden="true">★</span>
            {candidate.stars !== null ? candidate.stars.toLocaleString() : '—'}
          </span>
          <span className={styles.cardRef} title={candidate.ref}>
            {candidate.ref}
          </span>
        </header>
        {candidate.description && (
          <p className={styles.cardDescription} title={candidate.description}>
            {candidate.description}
          </p>
        )}
      </div>
      <div className={styles.cardActions}>
        {sourceUrl !== null && (
          <Button
            variant="ghost"
            size="sm"
            leadingIcon={<IconExternal size={12} />}
            onClick={onOpenSource}
            data-testid={`find-skill-view-${candidate.ref}`}
            aria-label={`View source for ${candidate.name}`}
          >
            View
          </Button>
        )}
        <Button
          variant="primary"
          size="sm"
          onClick={onInstall}
          disabled={installing || disabled}
          data-testid={`find-skill-install-${candidate.ref}`}
        >
          {installing ? 'Installing…' : 'Install'}
        </Button>
      </div>
    </article>
  );
}
