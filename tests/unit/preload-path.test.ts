import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Guard test: prevent a regression where `src/main/index.ts` references
 * the preload bundle with the wrong file extension.
 *
 * Background: with `package.json` `"type": "module"`, electron-vite emits
 * the preload as `out/preload/index.mjs` (NOT `index.js`). The main process
 * must reference the exact built filename — Electron does not auto-resolve
 * a different extension, and the IPC bridge silently fails to load if the
 * path is wrong. This was a real bug caught in the first /ef-review pass on
 * issue #1; this test exists to keep it from coming back.
 *
 * If this test fails:
 *   - check `out/preload/` after running `npm run build`
 *   - if electron-vite is now emitting `.js` (e.g. `package.json` removed
 *     `"type": "module"`), update both this test and the path in main
 *   - otherwise, fix the preload path in `src/main/index.ts`
 */
describe('preload path consistency', () => {
  it('main process references preload as index.mjs (matches electron-vite ESM output)', () => {
    const mainSrc = readFileSync(
      resolve(process.cwd(), 'src/main/index.ts'),
      'utf8',
    );

    // The path must include `preload/index.mjs` somewhere — match either
    // forward or back slashes for cross-platform safety.
    const referencesMjs = /preload[/\\]index\.mjs/.test(mainSrc);
    const referencesJs = /preload[/\\]index\.js(?!\w)/.test(mainSrc);

    expect(
      referencesMjs,
      'src/main/index.ts must reference preload/index.mjs (electron-vite ESM build output)',
    ).toBe(true);
    expect(
      referencesJs,
      'src/main/index.ts must NOT reference preload/index.js — that file is never emitted',
    ).toBe(false);
  });

  it('package.json type is "module" (the precondition for the .mjs preload extension)', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as { type?: string };
    // If this ever flips to "commonjs", electron-vite will emit index.js
    // and the preload path in main must be updated to match.
    expect(pkg.type).toBe('module');
  });
});
