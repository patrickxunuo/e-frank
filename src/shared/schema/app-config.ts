/**
 * `AppConfig` — global, per-user application configuration (#GH-69).
 *
 * Persisted as a single object in `<userData>/app-config.json` via the
 * `AppConfigStore` mirror of `ConnectionStore`. The four content sections of
 * the Settings page (Theme / Claude CLI / Workflow Defaults / About) read +
 * write fields here; Foundation defines the shape but doesn't yet wire UI
 * for any of them (those land as follow-up PRs per the GH-69 decomposition).
 *
 * Forward-compat: when a future PR adds a new field, the validator below
 * fills in the default for missing values, so old config files keep working
 * across upgrades without a migration step.
 */

/** Theme preference. `system` follows `prefers-color-scheme` at runtime. */
export type ThemeMode = 'light' | 'dark' | 'system';

/** Workflow mode default. Mirrors `RunMode` from `schema/run.ts`. */
export type WorkflowModeDefault = 'interactive' | 'yolo';

export interface AppConfig {
  /**
   * Theme preference. The Theme section (#GH-69 follow-up) renders a
   * RadioCardGroup over this field and migrates `useTheme`'s localStorage
   * backing to read from here.
   */
  theme: ThemeMode;
  /**
   * Override path for the `claude` CLI binary. `null` means "look up via
   * PATH" (current behavior). The Claude CLI section (#GH-69 follow-up)
   * surfaces a Test button + Override path input.
   */
  claudeCliPath: string | null;
  /** Default workflow mode for newly-created projects. AddProject reads this as its initial value. */
  defaultWorkflowMode: WorkflowModeDefault;
  /** Default Jira polling interval, in seconds. Per-project overrides win. */
  defaultPollingIntervalSec: number;
  /** Default run timeout, in minutes. Per-run overrides win. */
  defaultRunTimeoutMin: number;
}

/**
 * The default config used both as the seed when no file exists and as the
 * source of fill-in values for fields missing from a parsed config envelope.
 * Updating these defaults is a non-breaking change — `get()` will start
 * returning the new value for any field a user hadn't explicitly set.
 */
export const DEFAULT_APP_CONFIG: AppConfig = {
  theme: 'dark',
  claudeCliPath: null,
  defaultWorkflowMode: 'interactive',
  defaultPollingIntervalSec: 60,
  defaultRunTimeoutMin: 60,
};

export interface AppConfigValidationError {
  field: keyof AppConfig | '(root)';
  message: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Characters we forbid in `claudeCliPath` because the runner spawns
 * through a shell. Covers POSIX (`;`, `|`, `&`, `<`, `>`, `(`, `)`, `$`,
 * backtick, `*`, `?`, `~`, `!`, single + double quotes) and Windows
 * (`%`, `^`) command interpreters, plus control characters (newlines,
 * tabs, NULL).
 */
// eslint-disable-next-line no-control-regex
const SHELL_UNSAFE_REGEX = /[;|&<>()$`*?~!"'%^\x00-\x1f]/;

function isThemeMode(v: unknown): v is ThemeMode {
  return v === 'light' || v === 'dark' || v === 'system';
}

function isWorkflowModeDefault(v: unknown): v is WorkflowModeDefault {
  return v === 'interactive' || v === 'yolo';
}

/**
 * Validate (and fill in missing fields from defaults). Hand-rolled per
 * project convention — no zod / superstruct / etc. Errors are returned as
 * `{ field, message }[]` so callers can render granular messages.
 *
 * Two-mode semantics:
 *   - `strict: true` (default) — every present field must have the right
 *     shape; missing fields are filled from `DEFAULT_APP_CONFIG`.
 *   - `strict: false` — used when accepting a partial update payload. Only
 *     present fields are validated; missing fields are not errors.
 */
export function validateAppConfig(
  raw: unknown,
  opts?: { strict?: boolean },
): { ok: true; data: AppConfig } | { ok: false; errors: AppConfigValidationError[] };
export function validateAppConfig(
  raw: unknown,
  opts: { strict: false },
): { ok: true; data: Partial<AppConfig> } | { ok: false; errors: AppConfigValidationError[] };
export function validateAppConfig(
  raw: unknown,
  opts: { strict?: boolean } = {},
):
  | { ok: true; data: AppConfig | Partial<AppConfig> }
  | { ok: false; errors: AppConfigValidationError[] } {
  const strict = opts.strict !== false;
  const errors: AppConfigValidationError[] = [];

  if (!isPlainObject(raw)) {
    return {
      ok: false,
      errors: [{ field: '(root)', message: 'expected a JSON object' }],
    };
  }

  const out: Partial<AppConfig> = {};

  // theme
  if (raw['theme'] !== undefined) {
    if (!isThemeMode(raw['theme'])) {
      errors.push({ field: 'theme', message: "must be 'light' | 'dark' | 'system'" });
    } else {
      out.theme = raw['theme'];
    }
  }

  // claudeCliPath — defense-in-depth (#GH-85). The runner spawns this
  // path with `shell: true` (for Windows `.cmd` shim resolution), so we
  // must reject shell metacharacters and control characters that could
  // chain a second command (e.g. `claude.exe & calc.exe`). Newlines
  // would also let the shell parse a separate command line.
  if (raw['claudeCliPath'] !== undefined) {
    const v = raw['claudeCliPath'];
    if (v !== null && typeof v !== 'string') {
      errors.push({ field: 'claudeCliPath', message: 'must be a string or null' });
    } else if (typeof v === 'string' && v.length > 4096) {
      errors.push({ field: 'claudeCliPath', message: 'path too long (max 4096)' });
    } else if (typeof v === 'string' && SHELL_UNSAFE_REGEX.test(v)) {
      errors.push({
        field: 'claudeCliPath',
        message: 'path contains shell metacharacters or control characters',
      });
    } else {
      out.claudeCliPath = v as string | null;
    }
  }

  // defaultWorkflowMode
  if (raw['defaultWorkflowMode'] !== undefined) {
    if (!isWorkflowModeDefault(raw['defaultWorkflowMode'])) {
      errors.push({
        field: 'defaultWorkflowMode',
        message: "must be 'interactive' | 'yolo'",
      });
    } else {
      out.defaultWorkflowMode = raw['defaultWorkflowMode'];
    }
  }

  // defaultPollingIntervalSec
  if (raw['defaultPollingIntervalSec'] !== undefined) {
    const v = raw['defaultPollingIntervalSec'];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 5 || v > 86400) {
      errors.push({
        field: 'defaultPollingIntervalSec',
        message: 'must be a finite number between 5 and 86400 seconds',
      });
    } else {
      out.defaultPollingIntervalSec = v;
    }
  }

  // defaultRunTimeoutMin
  if (raw['defaultRunTimeoutMin'] !== undefined) {
    const v = raw['defaultRunTimeoutMin'];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > 1440) {
      errors.push({
        field: 'defaultRunTimeoutMin',
        message: 'must be a finite number between 1 and 1440 minutes',
      });
    } else {
      out.defaultRunTimeoutMin = v;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  if (strict) {
    // Fill in any missing fields from defaults so the returned object is a
    // complete `AppConfig`. This is the path called by `get()`.
    return { ok: true, data: { ...DEFAULT_APP_CONFIG, ...out } };
  }
  // Loose path (used by `set(partial)`): return only the validated fields.
  return { ok: true, data: out };
}
