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

import { useLayoutEffect, useRef, useState } from 'react';
import type { RunStatus } from '@shared/ipc';
import type { ExecLogStep } from '../state/run-log';
import { stripAnsi } from './ansi';
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

function isAtBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= PIXEL_TOLERANCE;
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
  onToggle: () => void;
}

function StepRow({ step, index, expanded, onToggle }: StepRowProps): JSX.Element {
  const labelText = step.label ?? step.state;
  const range = formatRange(step);

  // A finished step with zero captured output has nothing to show. Render
  // the row as a non-expandable header so the user doesn't get a useless
  // chevron that opens onto "No output yet." Still-running steps stay
  // expandable (output may arrive any moment).
  const isExpandable = step.status === 'running' || step.lines.length > 0;
  const showBody = isExpandable && expanded;

  return (
    <section
      className={styles.row}
      data-status={step.status}
      data-state={step.state}
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
        {range && <span className={styles.range}>{range}</span>}
      </header>
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
              <div className={styles.line} key={`${entry.timestamp}-${i}`}>
                <span className={styles.lineTime}>{formatHHMMSS(entry.timestamp)}</span>
                <span className={styles.lineStream} data-stream={entry.stream}>
                  {entry.stream}
                </span>
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

  // Track whether the user is currently "following" the bottom. Updated
  // on scroll. Once they scroll up, follow stays off until they return
  // to the bottom OR autoScroll is toggled off-then-on.
  const followRef = useRef<boolean>(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Keep the openSteps set in sync when `expandIndex` changes — used by
  // the parent to auto-expand the current step when the timeline grows.
  useLayoutEffect(() => {
    if (expandIndex < 0) return;
    setOpenSteps((prev) => {
      if (prev.has(expandIndex)) return prev;
      const next = new Set(prev);
      next.add(expandIndex);
      return next;
    });
  }, [expandIndex]);

  // Auto-scroll on content change.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!autoScroll) return;
    if (!followRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [steps, autoScroll]);

  // Re-engage follow whenever auto-scroll is toggled on (rule 3 in spec).
  useLayoutEffect(() => {
    if (autoScroll) {
      followRef.current = true;
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [autoScroll]);

  const handleScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current = isAtBottom(el);
  };

  const toggleStep = (i: number): void => {
    setOpenSteps((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  return (
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
            onToggle={() => toggleStep(i)}
          />
        ))
      )}
    </div>
  );
}
