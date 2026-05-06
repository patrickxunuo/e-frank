import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * TOKEN-001..005 — `tokens.css` declares the design-system CSS variables
 * the spec mandates, in BOTH `:root[data-theme='dark']` and
 * `:root[data-theme='light']` scopes (the theme-scoped tokens), plus
 * keeps layout/typography/motion tokens declared once at top-level
 * `:root` (since they are theme-agnostic).
 *
 * The exact values aren't asserted here — a separate snapshot/visual
 * review is the right tool for that. This file only guards the
 * *contract* of which tokens exist in which scope.
 *
 * Approach: read tokens.css as text, extract the substring inside each
 * scope block, and assert each required token name appears there.
 */

// Tokens that MUST be declared in BOTH theme scopes.
const THEMED_TOKEN_NAMES: readonly string[] = [
  // Surfaces
  '--bg-app',
  '--bg-sidebar',
  '--bg-card',
  '--bg-card-elevated',
  '--bg-input',
  '--border-subtle',
  '--border-default',
  '--border-emphasis',
  // Brand & status
  '--accent',
  '--accent-hover',
  '--accent-press',
  '--accent-deep',
  '--accent-soft',
  '--accent-border',
  '--success',
  '--success-soft',
  '--warning',
  '--warning-soft',
  '--danger',
  '--danger-soft',
  // Text
  '--text-primary',
  '--text-secondary',
  '--text-tertiary',
  '--text-on-accent',
  // Shadows
  '--shadow-sm',
  '--shadow-md',
  '--shadow-strong',
  '--shadow-glow-accent',
  // Surface overlays (theme-aware: dark uses white-translucent, light uses dark-translucent)
  '--surface-overlay-subtle',
  '--surface-overlay-low',
  '--surface-overlay-mid',
  '--surface-overlay-strong',
  // Status borders + extras
  '--accent-soft-strong',
  '--accent-glow',
  '--success-border',
  '--warning-border',
  '--danger-border',
  '--danger-soft-strong',
  // Backdrops
  '--bg-scrim',
  '--bg-header-from',
  '--bg-header-to',
  '--bg-panel-from',
  '--bg-panel-to',
];

// Tokens that are theme-agnostic and stay declared once at `:root`
// (layout, typography, motion).
const ROOT_LEVEL_TOKEN_NAMES: readonly string[] = [
  // Spacing
  '--space-1',
  '--space-2',
  '--space-3',
  '--space-4',
  '--space-5',
  '--space-6',
  '--space-7',
  '--space-8',
  // Radii
  '--radius-sm',
  '--radius-md',
  '--radius-lg',
  '--radius-pill',
  // Transitions
  '--ease-out',
  '--ease-in-out',
  '--duration-fast',
  '--duration-base',
  // Typography
  '--font-display',
  '--font-body',
  '--font-mono',
];

function loadTokensCss(): string {
  return readFileSync(
    resolve(process.cwd(), 'src/renderer/styles/tokens.css'),
    'utf8',
  );
}

/**
 * Extract the body of a top-level CSS rule whose selector matches
 * `selector` (literal). Returns the substring between the opening `{`
 * and the matching closing `}` at start-of-line (column 0). Returns
 * `null` if no match.
 *
 * We use a simple brace-counting scan starting from the `{` after the
 * selector to handle nested rules robustly without resorting to a CSS
 * parser dependency.
 */
function extractScopeBody(text: string, selector: string): string | null {
  // Find the selector followed by `{` (allow whitespace and newlines).
  // Escape regex metacharacters in the selector.
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headerRe = new RegExp(`${escaped}\\s*\\{`, 'm');
  const match = headerRe.exec(text);
  if (!match) return null;

  const openIdx = match.index + match[0].length - 1; // position of `{`
  let depth = 0;
  for (let i = openIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(openIdx + 1, i);
      }
    }
  }
  return null;
}

describe('tokens.css — TOKEN-001..005', () => {
  // ---------------------------------------------------------------------------
  // TOKEN-001 — All required tokens declared at :root[data-theme='dark']
  // ---------------------------------------------------------------------------
  it('TOKEN-001: every required themed token is declared in :root[data-theme=\'dark\']', () => {
    const text = loadTokensCss();
    const darkBody = extractScopeBody(text, ":root[data-theme='dark']");
    expect(darkBody, ':root[data-theme=\'dark\'] block must exist').not.toBeNull();
    if (darkBody === null) return;
    for (const name of THEMED_TOKEN_NAMES) {
      expect(darkBody, `dark scope is missing ${name}`).toContain(name);
    }
  });

  // ---------------------------------------------------------------------------
  // TOKEN-002 — All required tokens declared at :root[data-theme='light']
  // ---------------------------------------------------------------------------
  it('TOKEN-002: every required themed token is declared in :root[data-theme=\'light\']', () => {
    const text = loadTokensCss();
    const lightBody = extractScopeBody(text, ":root[data-theme='light']");
    expect(lightBody, ':root[data-theme=\'light\'] block must exist').not.toBeNull();
    if (lightBody === null) return;
    for (const name of THEMED_TOKEN_NAMES) {
      expect(lightBody, `light scope is missing ${name}`).toContain(name);
    }
  });

  // ---------------------------------------------------------------------------
  // TOKEN-003 — Dark scope contains color-scheme: dark
  // ---------------------------------------------------------------------------
  it('TOKEN-003: :root[data-theme=\'dark\'] declares color-scheme: dark', () => {
    const text = loadTokensCss();
    const darkBody = extractScopeBody(text, ":root[data-theme='dark']");
    expect(darkBody).not.toBeNull();
    if (darkBody === null) return;
    expect(darkBody).toMatch(/color-scheme\s*:\s*dark/);
  });

  // ---------------------------------------------------------------------------
  // TOKEN-004 — Light scope contains color-scheme: light
  // ---------------------------------------------------------------------------
  it('TOKEN-004: :root[data-theme=\'light\'] declares color-scheme: light', () => {
    const text = loadTokensCss();
    const lightBody = extractScopeBody(text, ":root[data-theme='light']");
    expect(lightBody).not.toBeNull();
    if (lightBody === null) return;
    expect(lightBody).toMatch(/color-scheme\s*:\s*light/);
  });

  // ---------------------------------------------------------------------------
  // TOKEN-005 — Layout/type/motion tokens declared at top-level :root
  // ---------------------------------------------------------------------------
  it('TOKEN-005: layout/typography/motion tokens declared at top-level :root', () => {
    const text = loadTokensCss();
    // Top-level `:root { ... }` (no attribute selector). We match the
    // selector exactly, with no `[` immediately after `:root`.
    const rootHeaderRe = /(^|\n)\s*:root\s*\{/m;
    const match = rootHeaderRe.exec(text);
    expect(match, ':root { ... } block must exist').not.toBeNull();
    if (!match) return;

    const openIdx = match.index + match[0].length - 1;
    let depth = 0;
    let endIdx = -1;
    for (let i = openIdx; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          endIdx = i;
          break;
        }
      }
    }
    expect(endIdx).toBeGreaterThan(openIdx);
    const rootBody = text.slice(openIdx + 1, endIdx);

    for (const name of ROOT_LEVEL_TOKEN_NAMES) {
      expect(rootBody, `:root scope is missing ${name}`).toContain(name);
    }
  });
});
