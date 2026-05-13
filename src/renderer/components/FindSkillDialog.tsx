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

interface OutputLine {
  id: number;
  stream: 'stdout' | 'stderr';
  text: string;
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
  const [query, setQuery] = useState<string>(initialQuery);
  const [activeFindId, setActiveFindId] = useState<string | null>(null);
  const [lines, setLines] = useState<OutputLine[]>([]);
  const [findError, setFindError] = useState<string | null>(null);
  const [installingRef, setInstallingRef] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [manualRef, setManualRef] = useState<string>('');
  const lineIdRef = useRef<number>(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Reset state when the dialog (re)opens.
  useEffect(() => {
    if (!open) return;
    setQuery(initialQuery);
    setLines([]);
    setFindError(null);
    setInstallError(null);
    setManualRef('');
    setActiveFindId(null);
    lineIdRef.current = 0;
  }, [open, initialQuery]);

  // Subscribe to streaming output + exit events when a find is in flight.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.api || activeFindId === null) {
      return;
    }
    const api = window.api;
    const offOutput = api.skills.onFindOutput((e: SkillsFindOutputEvent) => {
      if (e.findId !== activeFindId) return;
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
      if (e.reason === 'error') {
        setFindError('find-skills failed to run (Claude CLI not installed?).');
      } else if (e.reason === 'completed' && e.exitCode !== null && e.exitCode !== 0) {
        // Surface non-zero exit codes so the user knows /find-skills
        // didn't finish cleanly (e.g. Claude rate-limited or the skill
        // isn't installed). The streamed stderr is already visible
        // in the output area — banner just names the failure.
        setFindError(`find-skills exited with code ${e.exitCode}`);
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
      setLines([]);
      setFindError(null);
      lineIdRef.current = 0;
      const result = await window.api.skills.findStart({ query: trimmed });
      if (!result.ok) {
        setFindError(result.error.message || result.error.code || 'find-skills failed');
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
              <div className={styles.candidatesHead}>Recommended skills</div>
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
