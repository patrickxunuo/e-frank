import { test, expect } from '@playwright/test';

/**
 * E2E placeholder.
 *
 * The acceptance spec defers actual Electron-driven E2E to a later
 * issue. This file exists solely to prove that the Playwright runner
 * is wired and the config parses. It does NOT launch Electron and does
 * NOT touch the renderer.
 */
test('placeholder: Playwright runner is wired (1 + 1 === 2)', () => {
  expect(1 + 1).toBe(2);
});
