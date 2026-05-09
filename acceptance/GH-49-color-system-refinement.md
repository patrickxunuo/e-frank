# GH-49 — Ground the color system in the design source

## Spec

Re-anchor the CSS theme tokens to the palette in `design/add_project.png`. Tighten the surface tier hierarchy, brighten the accent, warm the warning, and re-derive the light theme as a credible inversion. Tokenize two leaf hardcodes that crept in. No behavior changes; pure visual.

## Acceptance

### TOKEN-DARK-PALETTE
The dark theme (`:root[data-theme='dark']`) declares the navy-anchored palette:
- `--bg-app: #0a1224`
- `--bg-sidebar: #0d1530`
- `--bg-card: #15203a`
- `--bg-card-elevated: #1c2a4a` (one tier above card)
- `--bg-input: #0e1a35`
- `--accent: #5b8dff` (matches PaperplaneGlyph body fill — brand alignment)
- `--accent-hover: #7aa3ff`
- `--accent-press: #4574e6`
- `--accent-deep: #2c4a99` (matches PaperplaneGlyph shadow fill)
- `--warning: #f4c264` (warm amber from the Interactive info chip)
- `--text-primary: #ffffff`

### TOKEN-LIGHT-PALETTE
The light theme (`:root[data-theme='light']`) is re-grounded — not just defaults.
- `--bg-app: #f5f7fb` (subtle warm tint, lifts cards)
- `--bg-sidebar: #eef2f9`
- `--bg-card: #ffffff`
- `--bg-input: #f8fafd`
- `--accent: #3b6dff`
- `--success: #1ba872`, `--warning: #d99a55`, `--danger: #d63a3a`
- `--text-primary: #0a1224`, `--text-secondary: #3a4566`, `--text-tertiary: #6b7790`

### TOKEN-CONTRACT-PRESERVED
Every token name listed in `tests/unit/tokens.test.ts` THEMED_TOKEN_NAMES is still declared in BOTH `:root[data-theme='dark']` and `:root[data-theme='light']` scopes. No name dropped, no name added without test coverage. `color-scheme: dark` / `color-scheme: light` declarations preserved.

### MESH-MATCHES-ACCENT
`src/renderer/styles/reset.css` body `background-image` radial gradients use rgba values derived from the new accent hue (`rgba(91, 141, 255, ...)` for the indigo gradients) — not the old `rgba(77, 124, 255, ...)`.

### WINDOW-FLASH-MATCHES-BG-APP
`src/main/index.ts` sets `BrowserWindow.backgroundColor` to `'#0a1224'` so the pre-paint window flash matches the new dark `--bg-app`.

### LEAF-TOKENIZED-DANGER
`src/renderer/components/RunStatusFigure.module.css` uses `fill: var(--danger)` for the failed status path — no hex literal.

### LEAF-TOKENIZED-WARNING
`src/renderer/components/ExecutionLog.module.css` line 441 reads `color: var(--warning)` — the dead `, #d99a55` fallback removed (no hardcoded color literal in the var fallback chain).

### BRAND-PRESERVED
`PaperplaneGlyph` component DEFAULT_BODY_FILL (`#5b8dff`) and DEFAULT_SHADOW_FILL (`#2c4a99`) UNCHANGED. The brand glyph stays brand-locked; the new theme accent merely matches it. `RunStatusFigure.module.css` paperplane fills (`#5b8dff`, `#2c4a99`) UNCHANGED for the same reason.

### REGRESSION-GUARDS
`tests/unit/tokens.test.ts` extends with:
- TOKEN-006: `--accent` in dark scope equals `#5b8dff` (locks brand alignment with PaperplaneGlyph).
- TOKEN-007: `RunStatusFigure.module.css` `.failed` rule uses `var(--danger)` (regression guard against re-introducing status hex literals).

### OUT-OF-SCOPE
- Spacing, typography, radii — not touched.
- Animations / transitions — not touched.
- Logo refresh — already #51, not touched.
- New components — none introduced.
- New runtime dependencies — none.

## Interface contract

No public interface changes. Token NAMES preserved. Token VALUES re-anchored.

## Test plan

- `npm run test:unit -- tokens.test.ts` — TOKEN-001..007 all pass.
- `npm run test:unit` — full suite passes (no regressions; nothing else asserts on token values).
- Smoke test in `npm run dev`:
  - Side-by-side AddProject view vs `design/add_project.png` — surface hierarchy, accent saturation, warmth on warning chip match qualitatively.
  - Toggle theme → light theme reads as a credible inversion (cards lift, accent has weight, status colors land).
  - Hover/focus/active on Button, Input, Toggle, ProjectList row → clear before/after on borders + bg.
- WCAG AA spot-check:
  - `--text-secondary` (`rgba(255,255,255,0.72)`) on `--bg-card` (`#15203a`) → ~10:1 ratio, comfortable AA-Large + AA-Normal.
  - `--text-tertiary` (`rgba(255,255,255,0.50)`) on `--bg-app` (`#0a1224`) → ~7:1, AA-Normal.
  - `--accent` (`#5b8dff`) text on `--bg-app` → check at 14px regular text usage.
