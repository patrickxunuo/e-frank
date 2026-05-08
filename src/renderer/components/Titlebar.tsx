import { useEffect, useState } from 'react';
import styles from './Titlebar.module.css';
import {
  IconWindowClose,
  IconWindowMax,
  IconWindowMin,
  IconWindowRestore,
} from './icons';

/**
 * Custom 32px titlebar that replaces the OS-default Electron chrome
 * (issue #50). Renders the paperplane lockup at the left, a draggable
 * region in the center, and min/max/close window controls at the right.
 *
 * Platform handling:
 *  - Windows / Linux: `frame: false` strips the OS chrome; this component
 *    paints its own min/max/close glyphs on the right.
 *  - macOS: `titleBarStyle: 'hiddenInset'` keeps the native traffic-light
 *    buttons at the top-left. We hide our right-side controls and reserve
 *    ~80px of left padding so the paperplane lockup doesn't sit under the
 *    traffic lights.
 *
 * Drag region: the bar gets `-webkit-app-region: drag` (which also enables
 * double-click-to-maximize for free). Interactive children (window
 * controls) opt back out via `-webkit-app-region: no-drag`.
 */
export function Titlebar(): JSX.Element | null {
  const api = window.api?.chrome;
  const [isMaximized, setIsMaximized] = useState<boolean>(false);
  const [platform, setPlatform] = useState<string>('');

  useEffect(() => {
    if (api === undefined) return;
    let cancelled = false;
    // Subscribe BEFORE the initial getState() so a state change racing the
    // mount can't be lost. We also gate the getState() resolution on a flag
    // set whenever the live subscriber fires — that way an early
    // CHROME_STATE_CHANGED event can't be clobbered by a stale getState
    // resolution that read its value before the change.
    let liveStateReceived = false;
    const off = api.onStateChanged((e) => {
      liveStateReceived = true;
      if (!cancelled) setIsMaximized(e.isMaximized);
    });
    void api.getState().then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setPlatform(res.data.platform);
        if (!liveStateReceived) {
          setIsMaximized(res.data.isMaximized);
        }
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [api]);

  if (api === undefined) {
    // No IPC bridge (test envs without window.api, or a misconfigured
    // preload). Render nothing rather than a half-functional bar.
    return null;
  }

  const isMac = platform === 'darwin';

  const handleMinimize = (): void => {
    void api.minimize();
  };
  const handleMaximize = (): void => {
    void api.maximize();
  };
  const handleClose = (): void => {
    void api.close();
  };

  return (
    <div
      className={`${styles.bar} ${isMac ? styles.barMac : ''}`}
      data-testid="app-titlebar"
      data-platform={platform || 'unknown'}
    >
      <div className={styles.brand}>
        <PaperplaneLockup />
      </div>

      <div className={styles.dragRegion} aria-hidden="true" />

      {!isMac && (
        <div className={styles.controls}>
          <button
            type="button"
            className={styles.controlButton}
            onClick={handleMinimize}
            aria-label="Minimize"
            data-testid="app-titlebar-min"
          >
            <IconWindowMin />
          </button>
          <button
            type="button"
            className={styles.controlButton}
            onClick={handleMaximize}
            aria-label={isMaximized ? 'Restore' : 'Maximize'}
            aria-pressed={isMaximized}
            data-testid="app-titlebar-max"
          >
            {isMaximized ? <IconWindowRestore /> : <IconWindowMax />}
          </button>
          <button
            type="button"
            className={`${styles.controlButton} ${styles.controlButtonClose}`}
            onClick={handleClose}
            aria-label="Close"
            data-testid="app-titlebar-close"
          >
            <IconWindowClose />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Inline paperplane horizontal lockup. The wordmark uses `fill="currentColor"`
 * so its color follows the SVG's CSS `color` property, which `Titlebar.module.css`
 * binds to `--text-primary`. That keeps the wordmark in sync with theme changes
 * driven anywhere else in the app — `useTheme()` is per-component state, so
 * computing the fill in JS would let the bar drift from the rest of the UI
 * until the Titlebar happened to re-render.
 */
function PaperplaneLockup(): JSX.Element {
  return (
    <svg
      viewBox="0 0 152 32"
      role="img"
      aria-label="paperplane"
      className={styles.lockup}
    >
      <polygon points="29,13 13,16 3,23" fill="#2c4a99" />
      <polygon points="29,13 3,5 13,16" fill="#5b8dff" />
      <text
        x="42"
        y="16"
        dominantBaseline="middle"
        fontFamily="'General Sans', 'Inter', 'SF Pro Display', system-ui, sans-serif"
        fontSize="14"
        fontWeight="600"
        letterSpacing="-0.01em"
        fill="currentColor"
      >
        paperplane
      </text>
    </svg>
  );
}
