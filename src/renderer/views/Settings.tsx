/**
 * `<Settings>` — global app settings page (#GH-69 Foundation + section PRs).
 *
 * Layout: left rail with anchors to four sections, right content area
 * scrolls.
 *
 * Section status:
 *   - Theme — implemented (#GH-84)
 *   - Claude CLI — implemented (#GH-85)
 *   - Workflow defaults — placeholder, #GH-86 follow-up
 *   - About — implemented (#GH-87)
 */
import { useState, type JSX } from 'react';
import type { ThemeMode } from '@shared/ipc';
import { useAppConfig } from '../state/app-config';
import { useAppInfo } from '../state/app-info';
import { useClaudeCli } from '../state/claude-cli';
import { useTheme } from '../state/theme';
import { Button } from '../components/Button';
import { RadioCardGroup, type RadioCardOption } from '../components/RadioCardGroup';
import {
  IconAlert,
  IconCheck,
  IconExternal,
  IconFolder,
  IconMonitor,
  IconMoon,
  IconRefresh,
  IconSun,
} from '../components/icons';
import { dispatchToast } from '../state/notifications';
import styles from './Settings.module.css';

/** GitHub URLs the About section's link buttons open via shell.openExternal. */
const ISSUE_URL = 'https://github.com/patrickxunuo/paperplane/issues/new';
const RELEASES_URL = 'https://github.com/patrickxunuo/paperplane/releases';
/** Anthropic install docs — surfaced from the Claude CLI section's not-found state. */
const CLAUDE_INSTALL_DOCS_URL = 'https://docs.anthropic.com/en/docs/claude-code/quickstart';

interface SettingsSection {
  /** Section anchor (used as `#hash` in the rail and as DOM id). */
  id: 'theme' | 'claude-cli' | 'defaults' | 'about';
  label: string;
  /** Brief one-liner shown beneath the section header. */
  blurb: string;
  /** Follow-up issue tag for sections still rendering the placeholder card. `null` = implemented. */
  followUp: string | null;
}

const SECTIONS: ReadonlyArray<SettingsSection> = [
  {
    id: 'theme',
    label: 'Theme',
    blurb: 'Light, dark, or follow system.',
    followUp: null,
  },
  {
    id: 'claude-cli',
    label: 'Claude CLI',
    blurb: 'Discovery, version check, optional override path.',
    followUp: null,
  },
  {
    id: 'defaults',
    label: 'Workflow defaults',
    blurb: 'Default workflow mode, polling interval, run timeout.',
    followUp: 'GH-86',
  },
  {
    id: 'about',
    label: 'About',
    blurb: 'Version, build info, log directory, report an issue.',
    followUp: null,
  },
];

const THEME_OPTIONS: RadioCardOption<ThemeMode>[] = [
  {
    value: 'light',
    title: 'Light',
    description: 'Always use the light palette.',
    icon: <IconSun size={18} />,
  },
  {
    value: 'dark',
    title: 'Dark',
    description: 'Always use the dark palette.',
    icon: <IconMoon size={18} />,
  },
  {
    value: 'system',
    title: 'System',
    description: 'Follow your OS preference; updates automatically when it changes.',
    icon: <IconMonitor size={18} />,
  },
];

/**
 * Renders the body of a section. For implemented sections this returns the
 * real UI; for placeholders it returns the "coming soon" card. Keeps the
 * top-level Settings render flat — easy to scan which sections are done.
 */
function SectionBody({ section }: { section: SettingsSection }): JSX.Element {
  if (section.id === 'theme') {
    return <ThemeSection />;
  }
  if (section.id === 'claude-cli') {
    return <ClaudeCliSection />;
  }
  if (section.id === 'about') {
    return <AboutSection />;
  }
  return (
    <div
      className={styles.placeholderCard}
      data-testid={`settings-placeholder-${section.id}`}
    >
      <span className={styles.placeholderLabel}>Coming soon</span>
      <p className={styles.placeholderBody}>
        Implementation lands as the {section.followUp ?? '(pending)'} follow-up
        PR. The shell and the app-config store backing this section are in
        place — section UI plugs in here.
      </p>
    </div>
  );
}

/**
 * Theme section (#GH-84). RadioCardGroup over the three theme modes.
 * Reads + writes via `useTheme`, which is itself backed by app-config and
 * applies the resolved theme to `<html data-theme>` + the localStorage
 * write-through cache used by the index.html bootstrap script.
 */
function ThemeSection(): JSX.Element {
  const { theme, setTheme, loading } = useTheme();
  return (
    <div className={styles.themeCard} data-testid="settings-theme-section">
      <RadioCardGroup
        value={theme}
        onChange={(next) => {
          void setTheme(next);
        }}
        options={THEME_OPTIONS}
        data-testid="settings-theme-radio"
      />
      {loading && (
        <p
          className={styles.themeHint}
          data-testid="settings-theme-loading"
          role="status"
        >
          Loading saved preference…
        </p>
      )}
    </div>
  );
}

/**
 * Claude CLI section (#GH-85). Surfaces the discovered Claude CLI path +
 * version + lets the user override the path. Behind the scenes the
 * override is persisted to `appConfig.claudeCliPath`; the workflow
 * runner reads it per-run, so changes take effect on the next run with
 * no app restart.
 *
 * Three top-level states drive the rendering:
 *   - `found`        — green check + path + version + Refresh button
 *   - `not-found`    — red exclamation + install-docs link
 *   - `error`        — IPC failure banner (rare; usually bridge missing)
 *
 * Below the status panel the override row is always visible — typing a
 * path enables Test → on success enables Save. Clear-override is only
 * enabled when a `source === 'override'` is currently configured. The
 * Test button gates Save so the user can't persist a broken path.
 */
function ClaudeCliSection(): JSX.Element {
  const cli = useClaudeCli();
  const [overrideInput, setOverrideInput] = useState<string>('');
  const [testing, setTesting] = useState<boolean>(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  // `true` only after a successful Test against the CURRENT overrideInput.
  // Editing the input again resets this to false so the user has to re-Test.
  const [testedPath, setTestedPath] = useState<string | null>(null);

  async function onTest(): Promise<void> {
    const path = overrideInput.trim();
    if (path === '') return;
    setTesting(true);
    setValidationError(null);
    setTestedPath(null);
    const result = await cli.testOverride(path);
    setTesting(false);
    if (!result.ok) {
      const friendly =
        result.error.code === 'PATH_NOT_FOUND'
          ? 'File does not exist at that path.'
          : result.error.code === 'NOT_EXECUTABLE'
            ? "That file isn't executable, or `--version` failed."
            : result.error.code === 'NOT_CLAUDE'
              ? "That binary's --version output doesn't look like Claude CLI."
              : result.error.message || result.error.code;
      setValidationError(friendly);
      return;
    }
    setTestedPath(path);
  }

  async function onSave(): Promise<void> {
    const path = overrideInput.trim();
    if (path === '' || path !== testedPath) return;
    const result = await cli.saveOverride(path);
    if (!result.ok) {
      dispatchToast({
        type: 'error',
        title: 'Could not save override',
        body: result.error.message || result.error.code,
      });
      return;
    }
    setOverrideInput('');
    setTestedPath(null);
    setValidationError(null);
    dispatchToast({
      type: 'success',
      title: 'Override saved',
      body: `Claude CLI will spawn from ${path} on the next run.`,
    });
  }

  async function onClear(): Promise<void> {
    const result = await cli.clearOverride();
    if (!result.ok) {
      dispatchToast({
        type: 'error',
        title: 'Could not clear override',
        body: result.error.message || result.error.code,
      });
      return;
    }
    setOverrideInput('');
    setTestedPath(null);
    setValidationError(null);
    dispatchToast({
      type: 'success',
      title: 'Override cleared',
      body: 'Claude CLI will be discovered via PATH on the next run.',
    });
  }

  async function onOpenInstallDocs(): Promise<void> {
    if (typeof window === 'undefined' || !window.api) return;
    await window.api.shell.openExternal({ url: CLAUDE_INSTALL_DOCS_URL });
  }

  const saveDisabled = testedPath === null || testedPath !== overrideInput.trim();

  return (
    <div className={styles.cliCard} data-testid="settings-claude-cli-section">
      {cli.state === 'loading' && (
        <p
          className={styles.cliHint}
          data-testid="settings-claude-cli-loading"
          role="status"
        >
          Probing Claude CLI…
        </p>
      )}

      {cli.state === 'found' && (
        <div className={styles.cliStatus} data-status="found">
          <div className={styles.cliStatusIcon} data-testid="settings-claude-cli-status-found">
            <IconCheck size={16} aria-hidden />
          </div>
          <dl className={styles.cliInfoGrid}>
            <dt className={styles.cliInfoLabel}>Resolved path</dt>
            <dd
              className={styles.cliInfoValue}
              data-testid="settings-claude-cli-resolved-path"
            >
              {cli.resolvedPath}
              {cli.source === 'override' && (
                <span className={styles.cliSourceTag}> (override)</span>
              )}
            </dd>
            <dt className={styles.cliInfoLabel}>Version</dt>
            <dd className={styles.cliInfoValue} data-testid="settings-claude-cli-version">
              {cli.version}
            </dd>
          </dl>
        </div>
      )}

      {cli.state === 'not-found' && (
        <div className={styles.cliStatus} data-status="not-found">
          <div
            className={styles.cliStatusIcon}
            data-tone="danger"
            data-testid="settings-claude-cli-status-not-found"
          >
            <IconAlert size={18} aria-hidden />
          </div>
          <div className={styles.cliNotFoundBody}>
            <p className={styles.cliNotFoundTitle}>Claude CLI not found</p>
            <p className={styles.cliNotFoundCopy}>
              {cli.source === 'override'
                ? "The configured override path doesn't point at a working Claude CLI. Clear the override or replace it below."
                : "Couldn't find `claude` on PATH. Install Claude Code, or set an override path below."}
            </p>
            <Button
              variant="ghost"
              leadingIcon={<IconExternal size={14} />}
              onClick={() => {
                void onOpenInstallDocs();
              }}
              data-testid="settings-claude-cli-install-link"
            >
              Install Claude Code
            </Button>
          </div>
        </div>
      )}

      {cli.state === 'error' && (
        <p
          className={styles.cliErrorBanner}
          data-testid="settings-claude-cli-error"
          role="alert"
        >
          Couldn't probe Claude CLI: {cli.error}
        </p>
      )}

      <div className={styles.cliActionsRow}>
        <Button
          variant="ghost"
          leadingIcon={<IconRefresh size={14} />}
          onClick={() => {
            void cli.refresh();
          }}
          disabled={cli.state === 'loading'}
          data-testid="settings-claude-cli-refresh"
        >
          Refresh
        </Button>
      </div>

      <div className={styles.cliOverrideRow}>
        <label className={styles.cliOverrideLabel} htmlFor="claude-cli-override-input">
          Override path
        </label>
        <input
          id="claude-cli-override-input"
          type="text"
          className={styles.cliOverrideInput}
          value={overrideInput}
          onChange={(e) => {
            setOverrideInput(e.target.value);
            setTestedPath(null);
            setValidationError(null);
          }}
          placeholder="/custom/path/to/claude"
          data-testid="settings-claude-cli-override-input"
        />
        <div className={styles.cliOverrideButtons}>
          <Button
            variant="ghost"
            onClick={() => {
              void onTest();
            }}
            disabled={overrideInput.trim() === '' || testing}
            data-testid="settings-claude-cli-test"
          >
            {testing ? 'Testing…' : 'Test'}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              void onSave();
            }}
            disabled={saveDisabled}
            data-testid="settings-claude-cli-save"
          >
            Save
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              void onClear();
            }}
            disabled={cli.source !== 'override'}
            data-testid="settings-claude-cli-clear"
          >
            Clear override
          </Button>
        </div>
        {validationError !== null && (
          <p
            className={styles.cliValidationError}
            data-testid="settings-claude-cli-validation-error"
            role="alert"
          >
            {validationError}
          </p>
        )}
        {testedPath !== null && testedPath === overrideInput.trim() && (
          <p
            className={styles.cliValidationOk}
            data-testid="settings-claude-cli-validation-ok"
            role="status"
          >
            Looks like Claude CLI — click Save to persist.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Info-row label/value pair used in the About section. Kept as its own
 * component so the row uses a consistent dt/dd shape — important because
 * the values are monospaced (versions, commit shas) while labels are not.
 */
function AboutInfoRow({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId: string;
}): JSX.Element {
  return (
    <>
      <dt className={styles.aboutInfoLabel}>{label}</dt>
      <dd className={styles.aboutInfoValue} data-testid={testId}>
        {value}
      </dd>
    </>
  );
}

/**
 * About section (#GH-87). Surfaces version/build/runtime diagnostics and
 * three small actions: open the log directory, report an issue, check
 * for releases. Diagnostic values come from `useAppInfo()` — which falls
 * back to build-time defines if the IPC bridge is missing — so the
 * section always renders something sensible even in degraded environments.
 */
function AboutSection(): JSX.Element {
  const { info, loading, error } = useAppInfo();

  async function onOpenLogDir(): Promise<void> {
    if (typeof window === 'undefined' || !window.api) {
      dispatchToast({
        type: 'error',
        title: 'Cannot open log directory',
        body: 'IPC bridge is unavailable.',
      });
      return;
    }
    const result = await window.api.shell.openLogDirectory();
    if (!result.ok) {
      dispatchToast({
        type: 'error',
        title: 'Could not open log directory',
        body: result.error.message || result.error.code,
      });
    }
  }

  function onOpenExternal(url: string, failTitle: string): () => Promise<void> {
    return async () => {
      if (typeof window === 'undefined' || !window.api) {
        dispatchToast({
          type: 'error',
          title: failTitle,
          body: 'IPC bridge is unavailable.',
        });
        return;
      }
      const result = await window.api.shell.openExternal({ url });
      if (!result.ok) {
        dispatchToast({
          type: 'error',
          title: failTitle,
          body: result.error.message || result.error.code,
        });
      }
    };
  }

  return (
    <div className={styles.aboutCard} data-testid="settings-about-section">
      {loading && (
        <p
          className={styles.aboutHint}
          data-testid="settings-about-loading"
          role="status"
        >
          Loading diagnostics…
        </p>
      )}
      {info !== null && (
        <dl className={styles.aboutInfoGrid}>
          <AboutInfoRow
            label="App version"
            value={info.appVersion}
            testId="settings-about-app-version"
          />
          <AboutInfoRow
            label="Build"
            value={info.buildCommit}
            testId="settings-about-build-commit"
          />
          <AboutInfoRow
            label="Platform"
            value={info.platform}
            testId="settings-about-platform"
          />
          <AboutInfoRow
            label="Release"
            value={info.release}
            testId="settings-about-release"
          />
          <AboutInfoRow
            label="Electron"
            value={info.electronVersion}
            testId="settings-about-electron"
          />
          <AboutInfoRow
            label="Node"
            value={info.nodeVersion}
            testId="settings-about-node"
          />
          <AboutInfoRow
            label="Chrome"
            value={info.chromeVersion}
            testId="settings-about-chrome"
          />
        </dl>
      )}
      {error !== null && (
        <p
          className={styles.aboutHint}
          data-testid="settings-about-error"
          role="status"
        >
          Showing fallback values — {error}
        </p>
      )}
      <div className={styles.aboutActions}>
        <Button
          variant="ghost"
          leadingIcon={<IconFolder size={14} />}
          onClick={() => {
            void onOpenLogDir();
          }}
          data-testid="settings-about-open-logs"
        >
          Open log directory
        </Button>
        <Button
          variant="ghost"
          leadingIcon={<IconExternal size={14} />}
          onClick={() => {
            void onOpenExternal(ISSUE_URL, 'Could not open issue tracker')();
          }}
          data-testid="settings-about-report-issue"
        >
          Report an issue
        </Button>
        <Button
          variant="ghost"
          leadingIcon={<IconRefresh size={14} />}
          onClick={() => {
            void onOpenExternal(RELEASES_URL, 'Could not open releases page')();
          }}
          data-testid="settings-about-check-updates"
        >
          Check for updates
        </Button>
      </div>
    </div>
  );
}

export function Settings(): JSX.Element {
  // `useAppConfig` is consumed here for the loading / error shells. The
  // section bodies use their own focused hooks (`useTheme` for #GH-84;
  // future sections will follow the same pattern).
  const appConfig = useAppConfig();

  return (
    <div className={styles.page} data-testid="settings-page">
      <header className={styles.head}>
        <div className={styles.titleBlock}>
          <span className={styles.eyebrow}>Workspace · Settings</span>
          <h1 className={styles.title} data-testid="settings-title">
            Settings
          </h1>
          <p className={styles.subtitle}>
            Global preferences. Sections below land incrementally — see the
            GH-69 follow-up issues for the current implementation status.
          </p>
        </div>
      </header>

      <div className={styles.body}>
        <aside className={styles.rail} aria-label="Settings sections">
          <nav className={styles.railNav}>
            {SECTIONS.map((section) => (
              <a
                key={section.id}
                href={`#${section.id}`}
                className={styles.railLink}
                data-testid={`settings-rail-${section.id}`}
              >
                {section.label}
              </a>
            ))}
          </nav>
        </aside>

        <main className={styles.content}>
          {appConfig.loading && (
            <div
              className={styles.loadingBanner}
              data-testid="settings-loading"
              role="status"
            >
              Loading config…
            </div>
          )}
          {appConfig.error !== null && !appConfig.loading && (
            <div
              className={styles.errorBanner}
              data-testid="settings-error"
              role="alert"
            >
              Couldn't load app config: {appConfig.error}
            </div>
          )}

          {SECTIONS.map((section) => (
            <section
              key={section.id}
              id={section.id}
              className={styles.section}
              data-testid={`settings-section-${section.id}`}
            >
              <header className={styles.sectionHead}>
                <h2 className={styles.sectionTitle}>{section.label}</h2>
                <p className={styles.sectionBlurb}>{section.blurb}</p>
              </header>
              <SectionBody section={section} />
            </section>
          ))}
        </main>
      </div>
    </div>
  );
}
