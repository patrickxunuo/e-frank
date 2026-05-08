# paperplane — brand assets

Canonical brand mark for the desktop app. Four files, one identity.

| File | Purpose |
| --- | --- |
| `paperplane-icon.svg` | Glyph alone (32×32 native). App icon, tray, dock, favicon source. Reads at 16px. |
| `paperplane-logo-on-dark.svg` | Glyph + lowercase wordmark in white. For dark UI surfaces (canonical theme). |
| `paperplane-logo-on-light.svg` | Glyph + lowercase wordmark in deep navy. For light UI surfaces. |
| `paperplane-floating.lottie.json` | Lottie animation — paper airplane gliding/bobbing in a 5-second loop. Hero / empty-state animation. |

## The mark

A paper airplane in side-3-quarter view, nose up-right. The silhouette is a 4-vertex polygon split along its center fold into two filled triangles:

- **lit face** (`#5b8dff`) — the upper, sunlit surface; takes the larger area
- **shadow face** (`#2c4a99`) — the underside that peeks below the fold; smaller, darker, gives the form depth

Without the two-tone fold this is just a triangle. The fold is the brand.

The glyph is intentionally angular and slightly imperfect-feeling (no soft curves, no gradients) to read as folded paper rather than vector-precision illustration. Inspired by the Linear / Cursor school of confident-minimal — but warmer because of the origami metaphor.

## Wordmark

"paperplane", all lowercase, Inter / SF Pro Display / system-ui at 14px / weight 600 / `letter-spacing: -0.01em`. Lowercase reads as friendly-confident — fits the lightweight-async-dispatch product story (you scribble a ticket, fold the plane, send it off, it lands as a PR).

## Tweaking colors

Each SVG declares its palette in a `<style>` block at the top using stable class names (`.body`, `.shadow`, `.wordmark`). Editing colors is a one-line change per file — no path-by-path hunt.

For the Lottie file, color values live in two places: `c.k` arrays under each `fl` (fill) shape, in normalized `[r, g, b, a]` (0-1). A find-replace on the rgb tuples works:

- `#5b8dff` → `[0.357, 0.553, 1.0, 1]`
- `#2c4a99` → `[0.173, 0.290, 0.6, 1]`

## Sizes

- **Sidebar / app chrome:** 24-32px tall (lockup) or 16-20px (icon only).
- **Brand contexts (about screen, splash, README):** 48-64px tall.
- **Favicon / tray icon:** rasterize `paperplane-icon.svg` at 256×256 / 512×512 (e.g. `inkscape paperplane-icon.svg --export-png=icon.png --export-width=512`, or any web converter).

## The Lottie loop

`paperplane-floating.lottie.json` — pure Lottie JSON, no external dependencies, ~3 KB. Renders via [`lottie-web`](https://github.com/airbnb/lottie-web) (or `lottie-react`).

- 240×160 viewport, transparent background, plane centered around (120, 80).
- 5-second loop at 30fps. The plane bobs ±5px horizontal / ±5px vertical and tilts ±3° on a sine, with the rotation slightly offset from the position so it feels like a glider catching air rather than a single rigid wave.
- No "intro" — the first frame is a mid-glide pose. The loop is the steady state.

### Reduced-motion fallback

Honor `prefers-reduced-motion: reduce` in the host component. The simplest swap: render `paperplane-icon.svg` (or a scaled-up version of it) in place of the Lottie when the media query matches. The icon's pose is the resting pose of the loop, so the swap is visually coherent.

```tsx
import Lottie from 'lottie-react';
import animation from './paperplane-floating.lottie.json';
import iconSvg from './paperplane-icon.svg?react';

export function PaperplaneHero(): JSX.Element {
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return prefersReducedMotion
    ? <iconSvg width={120} height={80} />
    : <Lottie animationData={animation} loop autoplay />;
}
```

## Renderer wiring

The current logo component is `IconLogo` in `src/renderer/components/icons.tsx`. To swap, paste the contents of `paperplane-icon.svg`'s body (the two `<polygon>` elements + the `<defs>` style block) into the component's return. For the sidebar lockup, render `paperplane-logo-on-dark.svg` directly via Vite's `?react` SVGR loader or as a static `<img>`.
