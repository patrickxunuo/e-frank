/**
 * SkillInstaller — DEV-MODE SYNC for the bundled `ef-feature` skill.
 *
 * Claude resolves slash-command skills from `${cwd}/.claude/skills/`
 * first, then falls back to `~/.claude/skills/`. e-frank's
 * WorkflowRunner spawns Claude with `cwd: project.repo.localPath` —
 * the *user's* project, not e-frank's repo — so the user-level
 * fallback is what's loaded. While we iterate on `ef-feature` inside
 * this repo, the bundled file diverges from whatever's at
 * `~/.claude/skills/ef-feature/SKILL.md`, and the user has to copy by
 * hand on every change. This installer eliminates that step: on app
 * startup, sync the repo's bundled skill into the user-level dir.
 *
 * Behaviour:
 *   - Reads the skill from a caller-provided source path (dev mode:
 *     `<repoRoot>/.claude/skills/ef-feature/SKILL.md`; the source path
 *     simply not existing returns `source-missing` and the caller logs
 *     it without aborting startup).
 *   - Writes to `~/.claude/skills/ef-feature/SKILL.md` (or
 *     `destRoot`-overridden in tests).
 *   - **Overwrites unconditionally on content mismatch.** This is the
 *     right policy for the dev-iterate flow — the bundled version is
 *     the canonical one. Skips the write when contents match so the
 *     mtime doesn't change on every launch.
 *
 * Future scope (not done here):
 *   - Production builds: bundle the skill via electron-builder
 *     `extraResources` and switch the source path to
 *     `process.resourcesPath`. For now the source-path-missing branch
 *     just no-ops in prod, which is fine until we ship an installer.
 *   - User-customized skills: the unconditional overwrite means a user
 *     can't keep a personal edit. Fine while iterating; revisit when
 *     the skill stabilizes.
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export type SkillInstallStatus =
  | 'installed'
  | 'updated'
  | 'unchanged'
  | 'source-missing'
  | 'io-failure';

export interface SkillInstallResult {
  status: SkillInstallStatus;
  /** Absolute path of the bundled source we read from (or attempted to). */
  sourcePath: string;
  /** Absolute path we wrote to (or would have written to). */
  destPath: string;
  /** Set on `io-failure`. */
  error?: string;
}

/**
 * Test seam — small fs surface so SkillInstaller can be unit-tested
 * with an in-memory filesystem.
 */
export interface SkillInstallerFs {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
  mkdir(path: string, opts: { recursive: true }): Promise<void>;
}

function defaultFs(): SkillInstallerFs {
  return {
    readFile: (path, encoding) => fs.readFile(path, encoding),
    writeFile: (path, data, encoding) => fs.writeFile(path, data, encoding),
    mkdir: (path, opts) => fs.mkdir(path, opts).then(() => undefined),
  };
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface InstallEfFeatureSkillOptions {
  /**
   * Absolute path of the bundled skill source. Caller decides where this
   * lives:
   *   - Dev mode: `<repoRoot>/.claude/skills/ef-feature/SKILL.md`
   *   - Production: `<process.resourcesPath>/skills/ef-feature/SKILL.md`
   *     (requires an electron-builder `extraResources` entry; not
   *     required for dev mode).
   */
  sourcePath: string;
  /**
   * Override the destination root. Defaults to `~/.claude/skills/`. Tests
   * pass a temp directory.
   */
  destRoot?: string;
  fs?: SkillInstallerFs;
}

/**
 * Install or refresh the ef-feature skill in the user's home directory.
 * See module docstring for rationale.
 */
export async function installEfFeatureSkill(
  options: InstallEfFeatureSkillOptions,
): Promise<SkillInstallResult> {
  const fsImpl = options.fs ?? defaultFs();
  const destRoot = options.destRoot ?? join(homedir(), '.claude', 'skills');
  const destPath = join(destRoot, 'ef-feature', 'SKILL.md');

  let bundled: string;
  try {
    bundled = await fsImpl.readFile(options.sourcePath, 'utf8');
  } catch (err) {
    if (isENOENT(err)) {
      return {
        status: 'source-missing',
        sourcePath: options.sourcePath,
        destPath,
      };
    }
    return {
      status: 'io-failure',
      sourcePath: options.sourcePath,
      destPath,
      error: errMessage(err),
    };
  }

  // Read existing destination to decide between `unchanged`, `updated`,
  // and `installed`.
  let existing: string | null = null;
  try {
    existing = await fsImpl.readFile(destPath, 'utf8');
  } catch (err) {
    if (!isENOENT(err)) {
      return {
        status: 'io-failure',
        sourcePath: options.sourcePath,
        destPath,
        error: errMessage(err),
      };
    }
  }

  if (existing === bundled) {
    return { status: 'unchanged', sourcePath: options.sourcePath, destPath };
  }

  // Ensure parent dir then write.
  try {
    await fsImpl.mkdir(dirname(destPath), { recursive: true });
    await fsImpl.writeFile(destPath, bundled, 'utf8');
  } catch (err) {
    return {
      status: 'io-failure',
      sourcePath: options.sourcePath,
      destPath,
      error: errMessage(err),
    };
  }

  return {
    status: existing === null ? 'installed' : 'updated',
    sourcePath: options.sourcePath,
    destPath,
  };
}
