/**
 * `<RunStatusFigure>` — the in-flight indicator for the ExecutionView header
 * (issue #GH-51).
 *
 *  - While the run is `pending` / `running` (including `awaitingApproval`):
 *    renders a 5-second Lottie loop of the paperplane gliding in place.
 *  - On terminal status: renders the static paperplane glyph, tinted by status
 *    (done = default brand colors, failed = `--danger`, cancelled = muted
 *    `--text-tertiary`).
 *
 * Honors `prefers-reduced-motion: reduce` — when the OS-level setting is on,
 * the live state also renders the static glyph (using the resting pose of the
 * loop, so the swap is visually coherent).
 */

import { useEffect, useState } from 'react';
import Lottie from 'lottie-react';
import type { RunState, RunStatus } from '@shared/ipc';
import animationData from '../../../design/logo/paperplane-floating.lottie.json';
import { PaperplaneGlyph } from './PaperplaneGlyph';
import styles from './RunStatusFigure.module.css';

export interface RunStatusFigureProps {
  status: RunStatus;
  state: RunState;
  size?: number;
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
    // Older WebKit emits `change` only on the legacy addListener path; modern
    // engines support addEventListener. Try the modern path first.
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, []);

  return prefers;
}

function isLive(status: RunStatus): boolean {
  return status === 'pending' || status === 'running';
}

function StaticGlyph({
  size,
  status,
}: {
  size: number;
  status: RunStatus;
}): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={styles.static}
      data-status={status}
      data-testid="run-status-figure-static"
      aria-hidden="true"
    >
      <PaperplaneGlyph
        bodyClassName={styles.body}
        shadowClassName={styles.shadow}
      />
    </svg>
  );
}

export function RunStatusFigure({
  status,
  state,
  size = 60,
}: RunStatusFigureProps): JSX.Element {
  const reducedMotion = usePrefersReducedMotion();
  // `state` is captured for diagnostics on the root element so DOM inspectors
  // (and tests) can correlate rendered output with the underlying state
  // machine without prop-drilling further.
  const showLottie = isLive(status) && !reducedMotion;

  return (
    <div
      className={styles.figure}
      data-testid="run-status-figure"
      data-status={status}
      data-state={state}
      style={{ width: size, height: size }}
    >
      {showLottie ? (
        <div className={styles.lottieWrap} data-testid="run-status-figure-lottie">
          <Lottie animationData={animationData} loop autoplay />
        </div>
      ) : (
        <StaticGlyph size={size} status={status} />
      )}
    </div>
  );
}
