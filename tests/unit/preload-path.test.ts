import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Guard test: prevent regressions in the preload bundle format / path.
 *
 * Background: `BrowserWindow` is created with `sandbox: true`. Electron
 * rejects ESM preloads (`.mjs`) when the renderer is sandboxed — a sandboxed
 * preload MUST be CommonJS. We therefore configure electron-vite to emit
 * the preload as `out/preload/index.cjs` (see electron.vite.config.ts), and
 * the main process path must match exactly — Electron does not auto-resolve
 * a different extension. A wrong path or wrong format silently breaks
 * `window.api` in the renderer ("IPC bridge unavailable"). This was a real
 * bug caught during /ef-feature on issue #1; this test exists to keep it
 * from coming back.
 *
 * If this test fails:
 *   - check `out/preload/` after running `npm run build`
 *   - if you intentionally switched to ESM preload, also flip
 *     `sandbox: false` in `src/main/index.ts` and update this test
 *   - otherwise, fix the preload path in `src/main/index.ts` and/or the
 *     `formats` config in `electron.vite.config.ts`
 */
describe('preload path consistency', () => {
  it('main process references preload as index.cjs (matches electron-vite CJS output)', () => {
    const mainSrc = readFileSync(
      resolve(process.cwd(), 'src/main/index.ts'),
      'utf8',
    );

    // The path must include `preload/index.cjs` — match either forward or
    // back slashes for cross-platform safety.
    const referencesCjs = /preload[/\\]index\.cjs/.test(mainSrc);
    const referencesMjs = /preload[/\\]index\.mjs/.test(mainSrc);
    const referencesPlainJs = /preload[/\\]index\.js(?!\w)/.test(mainSrc);

    expect(
      referencesCjs,
      'src/main/index.ts must reference preload/index.cjs (CJS preload required by sandbox: true)',
    ).toBe(true);
    expect(
      referencesMjs,
      'src/main/index.ts must NOT reference preload/index.mjs — Electron rejects ESM preloads under sandbox: true',
    ).toBe(false);
    expect(
      referencesPlainJs,
      'src/main/index.ts must NOT reference preload/index.js — that file is never emitted',
    ).toBe(false);
  });

  it('electron-vite preload build is configured to emit CJS', () => {
    const cfg = readFileSync(
      resolve(process.cwd(), 'electron.vite.config.ts'),
      'utf8',
    );
    // The preload section must declare formats: ['cjs'] so the bundle
    // matches the path referenced by main.
    expect(
      /formats:\s*\[\s*['"]cjs['"]\s*\]/.test(cfg),
      'electron.vite.config.ts preload.lib must set formats: ["cjs"]',
    ).toBe(true);
  });

  it('main process keeps sandbox: true (the reason the preload must be CJS)', () => {
    const mainSrc = readFileSync(
      resolve(process.cwd(), 'src/main/index.ts'),
      'utf8',
    );
    // If sandbox is ever flipped back to false, the preload could be ESM
    // again — but that's a security trade-off and should be a deliberate
    // change, not an accident.
    expect(/sandbox:\s*true/.test(mainSrc)).toBe(true);
    expect(/sandbox:\s*false/.test(mainSrc)).toBe(false);
  });
});
