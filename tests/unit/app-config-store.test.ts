import { describe, it, expect } from 'vitest';
import { AppConfigStore, type AppConfigStoreFs } from '../../src/main/modules/app-config-store';
import { DEFAULT_APP_CONFIG, type AppConfig } from '../../src/shared/schema/app-config';

/**
 * AC-STORE-001..010 — `AppConfigStore` (#GH-69 Foundation).
 *
 * Single-object store mirroring ConnectionStore's persistence pattern.
 * Tests use an in-memory fs facade (`makeMemFs()`) so writes are
 * synchronous from the test's POV — no real disk IO, deterministic.
 */

function makeMemFs(): AppConfigStoreFs & {
  files: Map<string, string>;
  writes: { path: string; data: string }[];
  renames: { from: string; to: string }[];
} {
  const files = new Map<string, string>();
  const writes: { path: string; data: string }[] = [];
  const renames: { from: string; to: string }[] = [];
  return {
    files,
    writes,
    renames,
    async readFile(path: string, _enc: 'utf8'): Promise<string> {
      const content = files.get(path);
      if (content === undefined) {
        const err = new Error(`ENOENT: no such file '${path}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return content;
    },
    async writeFile(path: string, data: string): Promise<void> {
      writes.push({ path, data });
      files.set(path, data);
    },
    async rename(from: string, to: string): Promise<void> {
      renames.push({ from, to });
      const data = files.get(from);
      if (data === undefined) {
        const err = new Error(`ENOENT: rename source missing '${from}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      files.delete(from);
      files.set(to, data);
    },
    async unlink(path: string): Promise<void> {
      files.delete(path);
    },
    async mkdir(): Promise<void> {
      // no-op for in-memory fs
    },
  };
}

const FILE_PATH = '/userData/app-config.json';

describe('AppConfigStore — AC-STORE (#GH-69)', () => {
  it('AC-STORE-001: init reads an existing valid file and exposes its config', async () => {
    const fs = makeMemFs();
    fs.files.set(
      FILE_PATH,
      JSON.stringify({
        schemaVersion: 1,
        config: { theme: 'light', defaultPollingIntervalSec: 120 },
      }),
    );
    const store = new AppConfigStore({ filePath: FILE_PATH, fs });
    const init = await store.init();
    expect(init.ok).toBe(true);
    const got = await store.get();
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    // Persisted fields preserved; missing fields filled from defaults.
    expect(got.data.theme).toBe('light');
    expect(got.data.defaultPollingIntervalSec).toBe(120);
    expect(got.data.claudeCliPath).toBe(DEFAULT_APP_CONFIG.claudeCliPath);
    expect(got.data.defaultWorkflowMode).toBe(DEFAULT_APP_CONFIG.defaultWorkflowMode);
    expect(got.data.defaultRunTimeoutMin).toBe(DEFAULT_APP_CONFIG.defaultRunTimeoutMin);
  });

  it('AC-STORE-002: init on missing file seeds defaults without writing to disk', async () => {
    const fs = makeMemFs();
    const store = new AppConfigStore({ filePath: FILE_PATH, fs });
    const init = await store.init();
    expect(init.ok).toBe(true);
    expect(fs.writes).toHaveLength(0); // No write until set() is called
    const got = await store.get();
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.data).toEqual(DEFAULT_APP_CONFIG);
  });

  it('AC-STORE-003: init on corrupt JSON returns FILE_CORRUPT', async () => {
    const fs = makeMemFs();
    fs.files.set(FILE_PATH, 'not json at all {{');
    const store = new AppConfigStore({ filePath: FILE_PATH, fs });
    const init = await store.init();
    expect(init.ok).toBe(false);
    if (init.ok) return;
    expect(init.error.code).toBe('FILE_CORRUPT');
  });

  it('AC-STORE-004: init on wrong schemaVersion returns UNSUPPORTED_SCHEMA_VERSION', async () => {
    const fs = makeMemFs();
    fs.files.set(FILE_PATH, JSON.stringify({ schemaVersion: 99, config: {} }));
    const store = new AppConfigStore({ filePath: FILE_PATH, fs });
    const init = await store.init();
    expect(init.ok).toBe(false);
    if (init.ok) return;
    expect(init.error.code).toBe('UNSUPPORTED_SCHEMA_VERSION');
  });

  it('AC-STORE-005: init on invalid config field returns VALIDATION_FAILED with details', async () => {
    const fs = makeMemFs();
    fs.files.set(
      FILE_PATH,
      JSON.stringify({ schemaVersion: 1, config: { theme: 'invalid-mode' } }),
    );
    const store = new AppConfigStore({ filePath: FILE_PATH, fs });
    const init = await store.init();
    expect(init.ok).toBe(false);
    if (init.ok) return;
    expect(init.error.code).toBe('VALIDATION_FAILED');
    expect(init.error.details).toBeDefined();
    expect(init.error.details?.[0]?.field).toBe('theme');
  });

  it('AC-STORE-006: set(partial) merges into existing and persists', async () => {
    const fs = makeMemFs();
    const store = new AppConfigStore({ filePath: FILE_PATH, fs });
    await store.init();
    const setRes = await store.set({ theme: 'system' });
    expect(setRes.ok).toBe(true);
    if (!setRes.ok) return;
    expect(setRes.data.theme).toBe('system');
    // Other fields unchanged (defaults preserved).
    expect(setRes.data.defaultPollingIntervalSec).toBe(DEFAULT_APP_CONFIG.defaultPollingIntervalSec);
    // File now exists on disk.
    expect(fs.files.has(FILE_PATH)).toBe(true);
    const persisted = JSON.parse(fs.files.get(FILE_PATH) as string);
    expect(persisted.schemaVersion).toBe(1);
    expect(persisted.config.theme).toBe('system');
  });

  it('AC-STORE-007: set with invalid value returns VALIDATION_FAILED and does not persist', async () => {
    const fs = makeMemFs();
    const store = new AppConfigStore({ filePath: FILE_PATH, fs });
    await store.init();
    const setRes = await store.set({
      defaultPollingIntervalSec: -5,
    } as Partial<AppConfig>);
    expect(setRes.ok).toBe(false);
    if (setRes.ok) return;
    expect(setRes.error.code).toBe('VALIDATION_FAILED');
    // No file written.
    expect(fs.files.has(FILE_PATH)).toBe(false);
  });

  it('AC-STORE-008: atomic write — uses .tmp-{uuid} then renames to the final path', async () => {
    const fs = makeMemFs();
    const store = new AppConfigStore({ filePath: FILE_PATH, fs });
    await store.init();
    await store.set({ theme: 'light' });
    // First write went to a tmp path; rename moved it to the final path.
    const tmpWrite = fs.writes[0];
    expect(tmpWrite).toBeDefined();
    expect(tmpWrite?.path.startsWith(`${FILE_PATH}.tmp-`)).toBe(true);
    const rename = fs.renames[0];
    expect(rename?.from).toBe(tmpWrite?.path);
    expect(rename?.to).toBe(FILE_PATH);
  });

  it('AC-STORE-009: empty set({}) is a valid no-op merge that still writes the current config', async () => {
    const fs = makeMemFs();
    const store = new AppConfigStore({ filePath: FILE_PATH, fs });
    await store.init();
    const res = await store.set({});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual(DEFAULT_APP_CONFIG);
  });

  it('AC-STORE-010: get/set before init returns IO_FAILURE (not silent corruption)', async () => {
    const fs = makeMemFs();
    const store = new AppConfigStore({ filePath: FILE_PATH, fs });
    const get1 = await store.get();
    expect(get1.ok).toBe(false);
    if (get1.ok) return;
    expect(get1.error.code).toBe('IO_FAILURE');
    expect(get1.error.message).toMatch(/init/i);
  });

  describe('AC-STORE-CLI-SAFE-001..003 — claudeCliPath shell-metacharacter rejection (#GH-85)', () => {
    it('AC-STORE-CLI-SAFE-001: ampersand in path is rejected with VALIDATION_FAILED', async () => {
      const fs = makeMemFs();
      const store = new AppConfigStore({ filePath: FILE_PATH, fs });
      await store.init();
      const res = await store.set({ claudeCliPath: '/path/claude.exe & calc.exe' });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('VALIDATION_FAILED');
    });

    it('AC-STORE-CLI-SAFE-002: backtick + dollar + semicolon are rejected', async () => {
      const fs = makeMemFs();
      const store = new AppConfigStore({ filePath: FILE_PATH, fs });
      await store.init();
      for (const bad of ['`evil`', '$(id)', '/path/claude; rm -rf']) {
        const res = await store.set({ claudeCliPath: bad });
        expect(res.ok).toBe(false);
      }
    });

    it('AC-STORE-CLI-SAFE-003: plain absolute paths pass validation', async () => {
      const fs = makeMemFs();
      const store = new AppConfigStore({ filePath: FILE_PATH, fs });
      await store.init();
      for (const good of [
        '/usr/local/bin/claude',
        'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd',
        '/opt/anthropic/claude-1.0.96',
      ]) {
        const res = await store.set({ claudeCliPath: good });
        expect(res.ok).toBe(true);
      }
    });
  });
});
