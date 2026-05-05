import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * TOKEN-001 — `tokens.css` declares all the design-system CSS variables
 * the spec mandates. We read the file as text and assert each variable
 * name appears verbatim. The exact values aren't asserted here (a
 * separate snapshot/visual review is the right tool for that) — this
 * test only guards the *contract* of which tokens exist, since
 * components downstream reference them by name.
 */

const TOKEN_NAMES = [
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
  // Shadows
  '--shadow-sm',
  '--shadow-md',
  '--shadow-glow-accent',
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

describe('tokens.css — TOKEN-001', () => {
  it('TOKEN-001: declares every required CSS variable name', () => {
    const text = readFileSync(
      resolve(process.cwd(), 'src/renderer/styles/tokens.css'),
      'utf8',
    );
    for (const name of TOKEN_NAMES) {
      expect(text).toContain(name);
    }
  });

  it('TOKEN-001: declares tokens on :root', () => {
    const text = readFileSync(
      resolve(process.cwd(), 'src/renderer/styles/tokens.css'),
      'utf8',
    );
    expect(text).toMatch(/:root\s*{/);
  });
});
