/**
 * `<Settings>` — global app settings page (#GH-69 Foundation).
 *
 * Layout: left rail with anchors to four sections, right content area
 * scrolls. Each section renders a placeholder card stating "Coming in
 * <follow-up issue>" with a stable testid so future PRs (Theme, Claude
 * CLI, Workflow defaults, About) can scope their tests to the right
 * section by replacing the placeholder.
 *
 * Foundation only wires the page shell + the `useAppConfig()` data
 * connection. The four sections land independently:
 *   - Theme — light/dark/system + matchMedia listener
 *   - Claude CLI — version check + override path
 *   - Workflow defaults — RadioCardGroup + number inputs
 *   - About — version, commit, platform, log dir, links
 */
import type { JSX } from 'react';
import { useAppConfig } from '../state/app-config';
import styles from './Settings.module.css';

interface SettingsSection {
  /** Section anchor (used as `#hash` in the rail and as DOM id). */
  id: 'theme' | 'claude-cli' | 'defaults' | 'about';
  label: string;
  /** Brief one-liner shown beneath the section header. */
  blurb: string;
  /** Follow-up issue tag for the placeholder card body. */
  followUp: string;
}

const SECTIONS: ReadonlyArray<SettingsSection> = [
  {
    id: 'theme',
    label: 'Theme',
    blurb: 'Light, dark, or follow system.',
    followUp: 'GH-69 Theme section',
  },
  {
    id: 'claude-cli',
    label: 'Claude CLI',
    blurb: 'Discovery, version check, optional override path.',
    followUp: 'GH-69 Claude CLI section',
  },
  {
    id: 'defaults',
    label: 'Workflow defaults',
    blurb: 'Default workflow mode, polling interval, run timeout.',
    followUp: 'GH-69 Workflow defaults section',
  },
  {
    id: 'about',
    label: 'About',
    blurb: 'Version, build info, log directory, report an issue.',
    followUp: 'GH-69 About section',
  },
];

export function Settings(): JSX.Element {
  // `useAppConfig` is consumed here even though the four placeholders
  // don't render any of its fields yet. The intent is to: (a) verify
  // the wire-up works end-to-end before section PRs land, (b) make
  // the `loading` / `error` shells reusable across sections, and (c)
  // exercise the IPC round-trip in renderer tests today.
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
              <div
                className={styles.placeholderCard}
                data-testid={`settings-placeholder-${section.id}`}
              >
                <span className={styles.placeholderLabel}>Coming soon</span>
                <p className={styles.placeholderBody}>
                  Implementation lands as the {section.followUp} follow-up
                  PR. The shell and the app-config store backing this
                  section are in place — section UI plugs in here.
                </p>
              </div>
            </section>
          ))}
        </main>
      </div>
    </div>
  );
}
