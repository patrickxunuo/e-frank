/**
 * `<ExecutionLog>` — stepped timeline + collapsible per-step terminal body
 * for the Execution View.
 *
 * Auto-scroll model: the parent owns the on/off toggle. When `autoScroll`
 * is true AND the user is currently at the bottom of the scroll container,
 * each render snaps `scrollTop = scrollHeight`. If the user scrolls up,
 * we record that they're no longer at the bottom and stop following until
 * they scroll back down.
 *
 * Each step row exposes the testids documented in the spec:
 *   - `log-step-{i}` on the row
 *   - `log-step-{i}-toggle` on the chevron button
 *   - `log-step-{i}-body` on the collapsible body
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RunStatus } from '@shared/ipc';
import type { ExecLogStep } from '../state/run-log';
import { stripAnsi } from './ansi';
import { IconChevronDown } from './icons';
import styles from './ExecutionLog.module.css';

export interface ExecutionLogProps {
  steps: ExecLogStep[];
  /** Auto-scroll behaviour — controlled by parent. */
  autoScroll: boolean;
  /**
   * Index of the user-visible step expanded by default (typically the
   * current one). Other completed steps start collapsed.
   */
  expandIndex: number;
  'data-testid'?: string;
}

const PIXEL_TOLERANCE = 4;
/**
 * GH-57 #4d: the scroll-to-bottom FAB only appears when there's a
 * meaningful amount of content below the viewport — small overflows
 * would surface a useless button.
 */
const FAB_VISIBILITY_THRESHOLD = 100;

function isAtBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= PIXEL_TOLERANCE;
}

function distanceBelowViewport(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

function formatHHMMSS(timestamp: number | undefined): string {
  if (timestamp === undefined) return '';
  const d = new Date(timestamp);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function formatRange(step: ExecLogStep): string {
  if (step.startedAt === undefined) return '';
  const start = formatHHMMSS(step.startedAt);
  if (step.finishedAt === undefined) {
    return `${start} – …`;
  }
  return `${start} – ${formatHHMMSS(step.finishedAt)}`;
}

function statusIcon(status: RunStatus): JSX.Element {
  // Visual variants are driven by CSS via `data-status`; the dot is a
  // single shared element so animations live in one place.
  return <span className={styles.statusDot} aria-hidden="true" data-status={status} />;
}

interface StepRowProps {
  step: ExecLogStep;
  index: number;
  expanded: boolean;
  /**
   * True when this row's open/closed state is currently managed by the
   * auto-follow effect (i.e. the user hasn't manually toggled it). Surfaced
   * as `data-auto-managed` so tests + future styling can disambiguate.
   */
  autoManaged: boolean;
  onToggle: () => void;
}

/**
 * After this many seconds without new output on a running step, the
 * StepRow surfaces a "still working — last output Xs ago" hint so the
 * user knows Claude isn't dead during long quiet stretches (e.g. while
 * a Bash subprocess like `npm install` runs without printing).
 */
const QUIET_THRESHOLD_SECONDS = 15;

function StepRow({ step, index, expanded, autoManaged, onToggle }: StepRowProps): JSX.Element {
  const labelText = step.label ?? step.state;
  const range = formatRange(step);

  // A finished step with zero captured output has nothing to show. Render
  // the row as a non-expandable header so the user doesn't get a useless
  // chevron that opens onto "No output yet." Still-running steps stay
  // expandable (output may arrive any moment).
  const isExpandable = step.status === 'running' || step.lines.length > 0;
  const showBody = isExpandable && expanded;

  // Quiet-period heartbeat. Tracks "seconds since last output" while
  // running. We snapshot the latest line's timestamp + the start of
  // the step (which doubles as "no output yet" reference), tick every
  // second, and surface the elapsed seconds when above threshold.
  const lastLineTs =
    step.lines.length > 0
      ? step.lines[step.lines.length - 1]!.timestamp
      : step.startedAt ?? Date.now();
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (step.status !== 'running') return;
    const handle = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(handle);
    };
  }, [step.status]);
  const quietSeconds = Math.floor((now - lastLineTs) / 1000);
  const showHeartbeat =
    step.status === 'running' && quietSeconds >= QUIET_THRESHOLD_SECONDS;

  return (
    <section
      className={styles.row}
      data-status={step.status}
      data-state={step.state}
      data-auto-managed={autoManaged ? 'true' : 'false'}
      data-testid={`log-step-${index}`}
    >
      <header className={styles.head}>
        {isExpandable ? (
          <button
            type="button"
            className={styles.toggle}
            onClick={onToggle}
            aria-expanded={expanded}
            aria-label={expanded ? `Collapse ${labelText}` : `Expand ${labelText}`}
            data-testid={`log-step-${index}-toggle`}
          >
            <span
              className={`${styles.chevron} ${expanded ? styles.chevronOpen : ''}`}
              aria-hidden="true"
            >
              {/* Right-pointing chevron; CSS rotates when open. */}
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path
                  d="M3 1.5 6.5 5 3 8.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </button>
        ) : (
          // Spacer keeps the row aligned with expandable peers. No toggle,
          // no aria-expanded — the row is purely informational.
          <span
            className={`${styles.toggle} ${styles.toggleDisabled}`}
            aria-hidden="true"
          />
        )}
        <span className={styles.statusIcon} aria-hidden="true">
          {statusIcon(step.status)}
        </span>
        <span className={styles.label}>{labelText}</span>
        {showHeartbeat && (
          <span
            className={styles.heartbeat}
            data-testid={`log-step-${index}-heartbeat`}
          >
            {step.lines.length > 0
              ? `still working — last output ${quietSeconds}s ago`
              : `still working — no output yet (${quietSeconds}s)`}
          </span>
        )}
        {range && <span className={styles.range}>{range}</span>}
      </header>
      {/*
       * Latest-line ticker. When the step is running and the body is
       * collapsed, surface the most recent line as a subtitle row so
       * the user sees live progress without expanding. Truncates with
       * ellipsis on a single line; full text in the title attribute
       * for hover.
       */}
      {step.status === 'running' && step.lines.length > 0 && !expanded && (
        <div
          className={styles.ticker}
          title={stripAnsi(step.lines[step.lines.length - 1]!.line)}
          data-testid={`log-step-${index}-ticker`}
        >
          {stripAnsi(step.lines[step.lines.length - 1]!.line)}
        </div>
      )}
      {showBody && (
        <div
          className={styles.body}
          data-testid={`log-step-${index}-body`}
          role="log"
          aria-live={step.status === 'running' ? 'polite' : 'off'}
        >
          {step.lines.length === 0 ? (
            <span className={styles.bodyEmpty}>No output yet.</span>
          ) : (
            step.lines.map((entry, i) => (
              // STDOUT / STDERR labels were noisy — dropped. Stream
              // distinction is preserved as a `data-stream` hook on the
              // row so CSS can tint stderr lines (muted yellow) without
              // a literal badge column.
              <div
                className={styles.line}
                data-stream={entry.stream}
                key={`${entry.timestamp}-${i}`}
              >
                <span className={styles.lineTime}>{formatHHMMSS(entry.timestamp)}</span>
                <span className={styles.lineText}>{stripAnsi(entry.line)}</span>
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}

export function ExecutionLog({
  steps,
  autoScroll,
  expandIndex,
  'data-testid': testId,
}: ExecutionLogProps): JSX.Element {
  // Start with `expandIndex` expanded; the user can toggle from there.
  // Stored as a Set so flipping individual rows is O(1).
  const [openSteps, setOpenSteps] = useState<Set<number>>(() => {
    if (expandIndex < 0) return new Set();
    return new Set([expandIndex]);
  });
  // GH-52 #7: track which indices the user manually toggled open. The
  // auto-follow effect collapses previously-active steps when the active
  // step advances — but only if the row was opened by us, not by the
  // user. Without this distinction, drilling into a finished phase to
  // read its body would be undone the moment the next phase starts.
  const [userOpenedSteps, setUserOpenedSteps] = useState<Set<number>>(() => new Set());

  // Track whether the user is currently "following" the bottom. Updated
  // on scroll. Once they scroll up, follow stays off until they return
  // to the bottom OR autoScroll is toggled off-then-on.
  const followRef = useRef<boolean>(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Last index the auto-follow effect opened. Used to know which row to
  // collapse when the active step advances. -1 = we haven't opened
  // anything yet (handled by the seed in `openSteps`).
  const lastAutoExpandRef = useRef<number>(expandIndex);
  // GH-57 #4d: tracks whether the scroll-to-bottom FAB should be
  // visible. Recomputed on every scroll + on content/auto-scroll
  // change. Decoupled from followRef so the FAB can hide when content
  // simply fits (no overflow) even if the user previously scrolled up.
  const [showScrollFab, setShowScrollFab] = useState<boolean>(false);

  // Keep the openSteps set in sync when `expandIndex` changes. Auto-follow
  // (GH-52 #7): when the active step advances and `autoScroll` is on,
  // collapse the previously-active step UNLESS the user manually opened it.
  useLayoutEffect(() => {
    if (expandIndex < 0) return;
    const prevAuto = lastAutoExpandRef.current;
    lastAutoExpandRef.current = expandIndex;
    // If the user has manually managed the active row, the auto-effect
    // backs off entirely — we neither force-open it nor collapse a peer
    // on its behalf. This is what makes the "user closes the active step,
    // it stays closed" scenario work without the effect immediately
    // re-opening it on its next run (e.g. after userOpenedSteps changes).
    if (userOpenedSteps.has(expandIndex)) return;
    setOpenSteps((prev) => {
      const alreadyOpen = prev.has(expandIndex);
      const shouldCollapsePrev =
        autoScroll &&
        prevAuto !== expandIndex &&
        prevAuto >= 0 &&
        prev.has(prevAuto) &&
        !userOpenedSteps.has(prevAuto);
      if (alreadyOpen && !shouldCollapsePrev) return prev;
      const next = new Set(prev);
      if (shouldCollapsePrev) next.delete(prevAuto);
      next.add(expandIndex);
      return next;
    });
  }, [expandIndex, autoScroll, userOpenedSteps]);

  // Auto-scroll on content change.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!autoScroll) return;
    if (!followRef.current) return;
    el.scrollTop = el.scrollHeight;
    // After snapping to bottom the FAB is no longer relevant.
    setShowScrollFab(false);
  }, [steps, autoScroll]);

  // Re-engage follow whenever auto-scroll is toggled on (rule 3 in spec).
  useLayoutEffect(() => {
    if (autoScroll) {
      followRef.current = true;
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
      setShowScrollFab(false);
    }
  }, [autoScroll]);

  const handleScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current = isAtBottom(el);
    setShowScrollFab(
      !followRef.current && distanceBelowViewport(el) > FAB_VISIBILITY_THRESHOLD,
    );
  };

  const handleScrollToBottom = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    // Re-engage auto-follow so subsequent streamed lines stay visible.
    followRef.current = true;
    setShowScrollFab(false);
  };

  const toggleStep = (i: number): void => {
    setOpenSteps((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
    // Mark the row as user-managed so the auto-follow effect leaves it
    // alone going forward. We add on both open AND close — once the user
    // has expressed intent for this row, the effect should respect it.
    setUserOpenedSteps((prev) => {
      if (prev.has(i)) return prev;
      const next = new Set(prev);
      next.add(i);
      return next;
    });
  };

  return (
    <div className={styles.scrollWrap}>
      <div
        ref={scrollRef}
        className={styles.scroll}
        onScroll={handleScroll}
        data-testid={testId}
      >
        {steps.length === 0 ? (
          <div className={styles.empty}>Waiting for the runner to start…</div>
        ) : (
          steps.map((step, i) => (
            <StepRow
              key={`${step.state}-${i}`}
              step={step}
              index={i}
              expanded={openSteps.has(i)}
              autoManaged={!userOpenedSteps.has(i)}
              onToggle={() => toggleStep(i)}
            />
          ))
        )}
      </div>
      <button
        type="button"
        className={styles.scrollFab}
        onClick={handleScrollToBottom}
        aria-label="Scroll to bottom"
        data-testid="log-scroll-to-bottom"
        data-visible={showScrollFab ? 'true' : 'false'}
        aria-hidden={showScrollFab ? undefined : 'true'}
        tabIndex={showScrollFab ? 0 : -1}
      >
        <IconChevronDown size={16} />
      </button>
    </div>
  );
}
