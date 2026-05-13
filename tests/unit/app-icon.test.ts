import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

/**
 * Guard test: prevent regressions in the app-icon wiring across the four
 * places it needs to stay in sync:
 *
 *   1. The icon artifacts exist at `build/icon.{ico,icns,png}` — generated
 *      by `scripts/build-icons.mjs` from `design/logo/paperplane-icon.svg`
 *      and committed (see .gitignore allow-list) so contributors don't need
 *      to regenerate them before every `npm run dist:*`.
 *   2. `electron-builder.yml` points at those artifacts (top-level `icon` for
 *      Linux/fallback, `win.icon` for the .exe + installer + Windows taskbar,
 *      `mac.icon` for the .app bundle + Dock + Finder).
 *   3. `electron-builder.yml`'s `files:` includes `build/icon.png` so the PNG
 *      is bundled into the asar and accessible at runtime for the
 *      BrowserWindow icon prop.
 *   4. `src/main/index.ts` sets the BrowserWindow `icon:` prop, resolving the
 *      path through `app.getAppPath()` so the same expression works in dev
 *      (project root) and packaged mode (asar root).
 *
 * If any of these drifts out of sync the packaged app falls back to the
 * generic Electron icon — silently in some places, visibly in others. This
 * test exists to catch the drift the moment it happens.
 */
describe('app icon wiring', () => {
  const root = process.cwd();

  describe('icon artifacts', () => {
    const expected: Array<{ file: string; minBytes: number }> = [
      { file: 'build/icon.png', minBytes: 1000 },
      { file: 'build/icon.ico', minBytes: 1000 },
      { file: 'build/icon.icns', minBytes: 1000 },
    ];

    for (const { file, minBytes } of expected) {
      it(`${file} exists and is non-trivial`, () => {
        const path = resolve(root, file);
        expect(existsSync(path), `${file} must exist — run \`npm run build:icons\``).toBe(true);
        const { size } = statSync(path);
        expect(size, `${file} must be larger than ${minBytes} bytes (got ${size})`).toBeGreaterThan(
          minBytes,
        );
      });
    }

    it('icon.icns starts with the ICNS magic header', () => {
      const buf = readFileSync(resolve(root, 'build/icon.icns'));
      expect(buf.subarray(0, 4).toString('ascii')).toBe('icns');
    });

    it('icon.png starts with the PNG magic header', () => {
      const buf = readFileSync(resolve(root, 'build/icon.png'));
      // 89 50 4E 47 0D 0A 1A 0A
      expect(Array.from(buf.subarray(0, 8))).toEqual([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
    });

    it('icon.ico starts with the ICO header (reserved=0, type=1)', () => {
      const buf = readFileSync(resolve(root, 'build/icon.ico'));
      expect(buf.readUInt16LE(0)).toBe(0); // reserved
      expect(buf.readUInt16LE(2)).toBe(1); // type=1 (icon)
      // Image count >= 1, sanity-check the spec'd ICO_SIZES = 6.
      expect(buf.readUInt16LE(4)).toBeGreaterThanOrEqual(1);
    });
  });

  describe('electron-builder.yml', () => {
    const cfg = yaml.load(
      readFileSync(resolve(root, 'electron-builder.yml'), 'utf8'),
    ) as Record<string, unknown>;

    it('declares top-level icon: build/icon.png', () => {
      expect(cfg['icon']).toBe('build/icon.png');
    });

    it('declares win.icon: build/icon.ico', () => {
      const win = cfg['win'] as Record<string, unknown> | undefined;
      expect(win?.['icon']).toBe('build/icon.ico');
    });

    it('declares mac.icon: build/icon.icns', () => {
      const mac = cfg['mac'] as Record<string, unknown> | undefined;
      expect(mac?.['icon']).toBe('build/icon.icns');
    });

    it("files: includes build/icon.png so it's bundled into the asar for the BrowserWindow icon prop", () => {
      const files = cfg['files'] as unknown[];
      expect(Array.isArray(files)).toBe(true);
      expect(files).toContain('build/icon.png');
    });
  });

  describe('src/main/index.ts BrowserWindow icon', () => {
    const mainSrc = readFileSync(resolve(root, 'src/main/index.ts'), 'utf8');

    it('resolves the icon path via app.getAppPath() so dev + packaged both work', () => {
      // The same expression must work in dev (project root) and packaged
      // (asar root). Hardcoding an out/-relative path would break in dev,
      // hardcoding process.cwd() would break in packaged.
      expect(
        /app\.getAppPath\(\)[^;]*build\/icon\.png/.test(mainSrc),
        'src/main/index.ts must resolve the BrowserWindow icon via app.getAppPath() + build/icon.png',
      ).toBe(true);
    });

    it('passes the resolved path as the BrowserWindow `icon:` option', () => {
      // Looser regex — just assert `icon: iconPath` (or similar) appears in
      // the BrowserWindow constructor call. The dev-path resolution above
      // already pins the value; this asserts it's wired in.
      expect(
        /icon:\s*iconPath/.test(mainSrc) ||
          /icon:\s*join\(app\.getAppPath\(\)[^)]*\)/.test(mainSrc),
        'BrowserWindow must receive the resolved icon path as its `icon:` option',
      ).toBe(true);
    });
  });

  describe('scripts/build-icons.mjs', () => {
    it('exists at the path referenced by the build:icons npm script', () => {
      expect(existsSync(resolve(root, 'scripts/build-icons.mjs'))).toBe(true);
    });

    it('package.json declares the build:icons script', () => {
      const pkg = JSON.parse(
        readFileSync(resolve(root, 'package.json'), 'utf8'),
      ) as { scripts?: Record<string, string> };
      expect(pkg.scripts?.['build:icons']).toBe('node scripts/build-icons.mjs');
    });
  });
});
