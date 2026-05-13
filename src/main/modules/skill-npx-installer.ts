/**
 * SkillNpxInstaller — install a Claude Code skill via `npx skills add`.
 *
 * Spawned through the `Spawner` abstraction (same testability seam used
 * by ClaudeProcessManager). The default `NodeSpawner` runs with
 * `shell: true` so the Windows `npx.cmd` shim resolves — that means any
 * skill ref we forward to the shell MUST be vetted by a strict regex
 * before reaching `spawner.spawn()`. The regex below allows the syntaxes
 * the `skills` CLI actually accepts (bare names, `<owner>/<name>`, git
 * URLs, local file paths) and rejects shell metacharacters like
 * `; | & $ ` ` ( )`.
 *
 * Captures the last ~4KB of stdout and stderr so the renderer can show
 * a tail when an install fails. Resolves on process exit; never throws
 * on a non-zero exit — failure surfaces as `status: 'failed'`.
 */

import type { Spawner } from './spawner.js';
import type { SkillInstallStatus } from '../../shared/ipc.js';

/**
 * Strict-but-practical skill-ref regex. Allowed: alphanumerics, hyphen,
 * underscore, dot, slash, `@` (npm scoped pkg, allowed at start too).
 * Rejects: spaces, semicolons, pipes, ampersands, backticks, quotes,
 * `$`, parens, redirects, etc.
 */
export const SKILL_REF_REGEX = /^[a-zA-Z0-9@][\w./@-]+$/;

export interface InstallSkillOptions {
  spawner: Spawner;
  /**
   * Skill reference to pass to `npx skills add`. Must match SKILL_REF_REGEX
   * or the function throws `INVALID_REF` synchronously.
   */
  ref: string;
  /** Working directory for the spawn. Typically `app.getPath('userData')`. */
  cwd: string;
  /** Override the binary. Defaults to `npx`. */
  command?: string;
  /** Override the install flags. Defaults to `-g -y`. */
  flags?: ReadonlyArray<string>;
  /** Hard timeout in ms. Defaults to 5 minutes. */
  timeoutMs?: number;
}

export interface InstallSkillResult {
  status: SkillInstallStatus;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const TAIL_BYTES = 4 * 1024;

function appendTail(buf: string, chunk: string): string {
  const next = buf + chunk;
  return next.length > TAIL_BYTES ? next.slice(next.length - TAIL_BYTES) : next;
}

export class InvalidSkillRefError extends Error {
  readonly code = 'INVALID_REF' as const;
  constructor(public readonly ref: string) {
    super(`Skill ref "${ref}" contains disallowed characters`);
  }
}

export interface UninstallSkillOptions {
  spawner: Spawner;
  /** Skill reference to remove. Same regex validation as install. */
  ref: string;
  /** Working directory for the spawn. Typically `app.getPath('userData')`. */
  cwd: string;
  /** Override the binary. Defaults to `npx`. */
  command?: string;
  /** Override the remove flags. Defaults to `-g -y`. */
  flags?: ReadonlyArray<string>;
  /** Hard timeout in ms. Defaults to 5 minutes. */
  timeoutMs?: number;
}

export interface UninstallSkillResult {
  /** Reuses the install status union — `installed` ⇒ successfully removed. */
  status: SkillInstallStatus;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export async function installSkillViaNpx(
  options: InstallSkillOptions,
): Promise<InstallSkillResult> {
  if (!SKILL_REF_REGEX.test(options.ref)) {
    throw new InvalidSkillRefError(options.ref);
  }
  const command = options.command ?? 'npx';
  const flags = options.flags ?? ['-g', '-y'];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const child = options.spawner.spawn({
    command,
    args: ['skills', 'add', options.ref, ...flags],
    cwd: options.cwd,
  });

  let stdoutTail = '';
  let stderrTail = '';

  child.stdout?.on('data', (chunk) => {
    stdoutTail = appendTail(stdoutTail, chunk.toString('utf8'));
  });
  child.stderr?.on('data', (chunk) => {
    stderrTail = appendTail(stderrTail, chunk.toString('utf8'));
  });

  return await new Promise<InstallSkillResult>((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      resolved = true;
      resolve({
        status: 'failed',
        stdout: stdoutTail,
        stderr: stderrTail + '\n[timed out]',
        exitCode: null,
      });
    }, timeoutMs);

    child.on('exit', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({
        status: code === 0 ? 'installed' : 'failed',
        stdout: stdoutTail,
        stderr: stderrTail,
        exitCode: code,
      });
    });

    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({
        status: 'failed',
        stdout: stdoutTail,
        stderr: stderrTail + `\n[spawn error] ${err.message}`,
        exitCode: null,
      });
    });
  });
}

/**
 * Mirror of `installSkillViaNpx` for removal. Spawns
 * `npx skills remove <ref> -g`. Same regex validation + tail capture +
 * timeout shape. Returns `status: 'installed'` on exit code 0 (the
 * `SkillInstallStatus` union is reused for both install + remove —
 * `'installed'` semantically reads as "the npm op succeeded"; renderer
 * picks the right verb for its UI).
 */
export async function uninstallSkillViaNpx(
  options: UninstallSkillOptions,
): Promise<UninstallSkillResult> {
  if (!SKILL_REF_REGEX.test(options.ref)) {
    throw new InvalidSkillRefError(options.ref);
  }
  const command = options.command ?? 'npx';
  // `-y` is REQUIRED: without it, `npx skills remove` waits on an
  // interactive "Are you sure?" prompt. We don't write to the child's
  // stdin, so without `-y` the child hangs until the 5-minute timeout
  // fires and the UI appears to "remove forever". Parity with the
  // install flags, which always carry `-y` for the same reason.
  const flags = options.flags ?? ['-g', '-y'];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const child = options.spawner.spawn({
    command,
    args: ['skills', 'remove', options.ref, ...flags],
    cwd: options.cwd,
  });

  let stdoutTail = '';
  let stderrTail = '';

  child.stdout?.on('data', (chunk) => {
    stdoutTail = appendTail(stdoutTail, chunk.toString('utf8'));
  });
  child.stderr?.on('data', (chunk) => {
    stderrTail = appendTail(stderrTail, chunk.toString('utf8'));
  });

  return await new Promise<UninstallSkillResult>((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      resolved = true;
      resolve({
        status: 'failed',
        stdout: stdoutTail,
        stderr: stderrTail + '\n[timed out]',
        exitCode: null,
      });
    }, timeoutMs);

    child.on('exit', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({
        status: code === 0 ? 'installed' : 'failed',
        stdout: stdoutTail,
        stderr: stderrTail,
        exitCode: code,
      });
    });

    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({
        status: 'failed',
        stdout: stdoutTail,
        stderr: stderrTail + `\n[spawn error] ${err.message}`,
        exitCode: null,
      });
    });
  });
}
