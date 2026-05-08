/**
 * `<PaperplaneGlyph />` — single source of truth for the two-polygon
 * paperplane silhouette used across the app.
 *
 * Used by:
 *   - `IconLogo` in `icons.tsx` (default brand icon)
 *   - `PaperplaneLockup` in `Sidebar.tsx` and `Titlebar.tsx` (horizontal
 *     lockup with wordmark)
 *   - `StaticGlyph` in `RunStatusFigure.tsx` (terminal-status indicator,
 *     with optional fill overrides for `failed` / `cancelled` tints)
 *
 * **The fragment, not a full SVG.** This component returns the two
 * `<polygon>` elements without a wrapping `<svg>`. Each consumer wraps
 * them in its own `<svg>` because the viewBox differs:
 *   - Icon contexts: `viewBox="0 0 32 32"` — the natural canvas of the
 *     mark.
 *   - Lockup contexts: `viewBox="0 0 152 32"` — the wider canvas that
 *     also fits the "paperplane" wordmark on the right.
 * The polygon coordinates are written for the 0-32 left margin, which is
 * what both viewBox shapes expect.
 *
 * **Design source of truth.** `design/logo/paperplane-icon.svg`. If the
 * silhouette ever changes, update both this component AND the SVG files
 * in `design/logo/` so designers and runtime stay aligned. The
 * `components-paperplane-glyph.test.tsx` test asserts the polygon
 * coordinates here match those in the design SVG to catch drift.
 */

export interface PaperplaneGlyphProps {
  /** Lit upper face. Default brand color `#5b8dff`. */
  bodyFill?: string;
  /** Shaded under-face. Default brand color `#2c4a99`. */
  shadowFill?: string;
  /** Optional className to forward onto the body polygon (e.g. for CSS-driven theming via `fill: var(--token)`). */
  bodyClassName?: string;
  /** Optional className to forward onto the shadow polygon. */
  shadowClassName?: string;
}

const DEFAULT_BODY_FILL = '#5b8dff';
const DEFAULT_SHADOW_FILL = '#2c4a99';

// Coordinates kept in a constant so tests can import + assert exact
// values, and so a future tweak is one edit. Authored for a 32×32
// canvas with the plane spanning x=2..30 and y=3..25.
export const PAPERPLANE_BODY_POINTS = '30,14 2,3 14,17';
export const PAPERPLANE_SHADOW_POINTS = '30,14 14,17 2,25';

export function PaperplaneGlyph({
  bodyFill = DEFAULT_BODY_FILL,
  shadowFill = DEFAULT_SHADOW_FILL,
  bodyClassName,
  shadowClassName,
}: PaperplaneGlyphProps): JSX.Element {
  return (
    <>
      <polygon
        points={PAPERPLANE_SHADOW_POINTS}
        fill={shadowFill}
        className={shadowClassName}
      />
      <polygon
        points={PAPERPLANE_BODY_POINTS}
        fill={bodyFill}
        className={bodyClassName}
      />
    </>
  );
}
