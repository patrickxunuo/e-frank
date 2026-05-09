import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

/**
 * SCAFFOLD-001..004: Scaffold-level filesystem assertions.
 *
 * These tests are deliberately filesystem-driven (not module-import
 * driven) because they assert on configuration files, not runtime
 * behavior. They run from the repo root and resolve paths relative to
 * `process.cwd()` — vitest is configured to run from the project root.
 *
 * Note: `js-yaml` is required as a devDependency by Agent B. If the
 * import fails the test suite will surface a clear error.
 */

const repoRoot = process.cwd();
const at = (relPath: string): string => resolve(repoRoot, relPath);

/**
 * Strips `// line comments` and `/* block comments *\/` from a JSON
 * string. tsconfig.json conventionally allows comments (jsonc), but
 * `JSON.parse` does not. We try a strict parse first and fall back to
 * a lenient parse when needed. This is intentionally simple — it is
 * not a full jsonc parser, but it is more than sufficient for a
 * standard tsconfig.json.
 */
function parseJsonLoose(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const stripped = raw
      // strip /* ... */ blocks (non-greedy, multi-line)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      // strip // ... line comments
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      // remove trailing commas before } or ]
      .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(stripped);
  }
}

describe('scaffold (SCAFFOLD-001..004)', () => {
  describe('SCAFFOLD-001: package.json scripts', () => {
    it('package.json contains the required script keys', () => {
      const raw = readFileSync(at('package.json'), 'utf8');
      const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };

      expect(pkg.scripts).toBeDefined();
      const scripts = pkg.scripts as Record<string, string>;

      const required: ReadonlyArray<string> = [
        'dev',
        'build',
        'dist',
        'test',
        'test:e2e',
        'lint',
        'typecheck',
      ];

      for (const key of required) {
        expect(scripts, `missing script: ${key}`).toHaveProperty(key);
        expect(typeof scripts[key]).toBe('string');
        expect(scripts[key]?.length ?? 0).toBeGreaterThan(0);
      }
    });
  });

  describe('SCAFFOLD-002: required config files exist', () => {
    const required: ReadonlyArray<string> = [
      'electron.vite.config.ts',
      'playwright.config.ts',
      'vitest.config.ts',
      'tsconfig.json',
      'electron-builder.yml',
    ];

    for (const file of required) {
      it(`exists: ${file}`, () => {
        expect(existsSync(at(file)), `missing required file: ${file}`).toBe(
          true,
        );
      });
    }
  });

  describe('SCAFFOLD-003: tsconfig strict mode', () => {
    it('tsconfig.json has compilerOptions.strict === true', () => {
      const raw = readFileSync(at('tsconfig.json'), 'utf8');
      const parsed = parseJsonLoose(raw) as {
        compilerOptions?: { strict?: unknown };
      };

      expect(parsed).toBeDefined();
      expect(parsed.compilerOptions).toBeDefined();
      expect(parsed.compilerOptions?.strict).toBe(true);
    });
  });

  describe('SCAFFOLD-004: electron-builder.yml has correct targets and appId', () => {
    it('parses as YAML, has appId and win/mac targets', () => {
      const raw = readFileSync(at('electron-builder.yml'), 'utf8');
      const cfg = yaml.load(raw) as {
        appId?: string;
        win?: { target?: unknown };
        mac?: { target?: unknown };
      };

      expect(cfg).toBeDefined();
      // Rebranded to PaperPlane in #GH-51 — appId flipped to keep userData
      // paths and OS app identity in sync with the renamed productName.
      expect(cfg.appId).toBe('tech.emonster.paperplane');

      // win.target may be a string ("nsis"), an array of strings
      // (["nsis"]), or an array of objects ([{ target: "nsis" }]).
      // We accept any of these shapes as long as "nsis" is referenced.
      expect(cfg.win).toBeDefined();
      expect(targetsInclude(cfg.win?.target, 'nsis')).toBe(true);

      // mac.target similarly accepts the same shapes for "dmg".
      expect(cfg.mac).toBeDefined();
      expect(targetsInclude(cfg.mac?.target, 'dmg')).toBe(true);
    });
  });
});

/**
 * Returns true if `target` references `needle`. electron-builder's
 * target field is famously polymorphic:
 *   target: nsis
 *   target: [nsis]
 *   target: [{ target: nsis, arch: [x64] }]
 */
function targetsInclude(target: unknown, needle: string): boolean {
  if (target == null) return false;
  if (typeof target === 'string') return target === needle;
  if (Array.isArray(target)) {
    return target.some((entry) => {
      if (typeof entry === 'string') return entry === needle;
      if (entry && typeof entry === 'object' && 'target' in entry) {
        const inner = (entry as { target?: unknown }).target;
        return typeof inner === 'string' && inner === needle;
      }
      return false;
    });
  }
  if (typeof target === 'object' && 'target' in target) {
    const inner = (target as { target?: unknown }).target;
    return typeof inner === 'string' && inner === needle;
  }
  return false;
}
