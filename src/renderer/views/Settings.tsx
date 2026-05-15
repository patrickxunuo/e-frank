/**
 * `<Settings>` — global app settings page (#GH-69 Foundation + section PRs).
 *
 * Layout: left rail with anchors to four sections, right content area
 * scrolls.
 *
 * Section status:
 *   - Theme — implemented (#GH-84)
 *   - Claude CLI — placeholder, #GH-85 follow-up
 *   - Workflow defaults — placeholder, #GH-86 follow-up
 *   - About — implemented (#GH-87)
 */
import type { JSX } from 'react';
import type { ThemeMode } from '@shared/ipc';
import { useAppConfig } from '../state/app-config';
import { useAppInfo } from '../state/app-info';
import { useTheme } from '../state/theme';
import { Button } from '../components/Button';
import { RadioCardGroup, type RadioCardOption } from '../components/RadioCardGroup';
import {
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
    followUp: 'GH-85',
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
