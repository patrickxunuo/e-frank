import { useEffect, useState } from 'react';
import packageJson from '../../../package.json';
import type { Run } from '@shared/ipc';
import { useGlobalActiveRuns } from '../state/global-active-run';
import styles from './Sidebar.module.css';
import { IconKey, IconProjects, IconSettings, IconSkills } from './icons';
import { PaperplaneGlyph } from './PaperplaneGlyph';

const APP_VERSION = `v${packageJson.version}`;

export type SidebarNavId = 'projects' | 'connections' | 'skills' | 'settings';

export interface SidebarUser {
  name: string;
  email: string;
}

export interface SidebarProps {
  activeNav: SidebarNavId;
  user?: SidebarUser;
  /** Called when the user clicks a nav item. */
  onNavigate?: (id: SidebarNavId) => void;
}

interface NavItemDef {
  id: SidebarNavId;
  label: string;
  icon: JSX.Element;
}

const NAV_ITEMS: NavItemDef[] = [
  { id: 'projects', label: 'Projects', icon: <IconProjects /> },
  { id: 'connections', label: 'Connections', icon: <IconKey /> },
  { id: 'skills', label: 'Skills', icon: <IconSkills /> },
  { id: 'settings', label: 'Settings', icon: <IconSettings /> },
];

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const second = parts[1]?.[0] ?? '';
  return (first + second).toUpperCase() || '?';
}

/**
 * Resolves project display names for the sidebar pill (#GH-81 lifted
 * from single-id to N-id). Returns a `{ projectId → name }` record.
 * Re-runs whenever the set of ids changes; entries that have resolved
 * before are kept until evicted (rare — only on project deletion).
 *
 * Implementation: one `projects.get(id)` per unique projectId. Bounded
 * by the number of distinct projects with active runs (~1-3 in
 * practice). No batching — the IPC has no plural-get endpoint and the
 * cost is negligible for typical N.
 */
function useProjectNames(projectIds: ReadonlyArray<string>): Record<string, string | null> {
  const [names, setNames] = useState<Record<string, string | null>>({});
  // Stable key so React only re-runs when the set actually changes.
  const key = projectIds.slice().sort().join('|');
  useEffect(() => {
    let cancelled = false;
    if (projectIds.length === 0 || typeof window === 'undefined' || !window.api) {
      return () => {
        cancelled = true;
      };
    }
    const api = window.api;
    const unique = Array.from(new Set(projectIds));
    void (async () => {
      for (const id of unique) {
        try {
          const result = await api.projects.get({ id });
          if (cancelled) return;
          if (result.ok) {
            setNames((prev) => ({ ...prev, [id]: result.data.name }));
          }
        } catch {
          if (cancelled) return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return names;
}

/**
 * Single-id wrapper. Kept compatible with the previous `useProjectName(id)`
 * call shape for the case where Sidebar renders just one active run.
 */
function useProjectName(projectId: string | null): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (projectId === null || typeof window === 'undefined' || !window.api) {
      setName(null);
      return () => {
        cancelled = true;
      };
    }
    const api = window.api;
    void (async () => {
      try {
        const result = await api.projects.get({ id: projectId });
        if (cancelled) return;
        if (result.ok) {
          setName(result.data.name);
        }
      } catch {
        if (cancelled) return;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  return name;
}

/**
 * The single-run pill — extracted (#GH-81) so it can be re-used by the
 * N=1 back-compat branch in `Sidebar` without duplicating markup.
 */
function renderSoloActiveRun(activeRun: Run, projectName: string | null): JSX.Element {
  return (
    <div
      className={styles.activeContext}
      data-testid="sidebar-active-context"
    >
      <div className={styles.activeRow}>
        <span className={styles.activeLabel}>Active Project</span>
        <span className={styles.activeValue} title={projectName ?? activeRun.projectId}>
          {projectName ?? activeRun.projectId}
        </span>
      </div>
      <div className={styles.activeRow}>
        <span className={styles.activeLabel}>Active Ticket</span>
        <span className={styles.activeValueMono}>{activeRun.ticketKey}</span>
      </div>
    </div>
  );
}

/** Max active-run rows shown before collapsing the remainder behind "+N more". */
const SIDEBAR_MAX_VISIBLE_RUNS = 3;

export function Sidebar({ activeNav, user, onNavigate }: SidebarProps): JSX.Element {
  const activeRuns = useGlobalActiveRuns();
  // Resolve project names for every distinct projectId present in the runs.
  // The plural hook is rendered unconditionally; when activeRuns is empty,
  // it returns {}. Cost is bounded by distinct projects with concurrent runs.
  const projectIdSet = activeRuns.map((r) => r.projectId);
  const projectNames = useProjectNames(projectIdSet);
  // Singular wrapper still used by the legacy single-run path below — gives
  // exactly the same behavior the pre-#GH-81 sidebar pill had when N=1.
  const soloProjectName = useProjectName(
    activeRuns.length === 1 ? (activeRuns[0]?.projectId ?? null) : null,
  );
  const visibleRuns = activeRuns.slice(0, SIDEBAR_MAX_VISIBLE_RUNS);
  const overflow = activeRuns.length - visibleRuns.length;
  return (
    <aside className={styles.sidebar} data-testid="sidebar">
      <div className={styles.brand}>
        <PaperplaneLockup />
        <span className={styles.tag}>Ticket → PR</span>
      </div>

      <nav className={styles.nav} aria-label="Primary">
        <div className={styles.navHeader}>Workspace</div>
        {NAV_ITEMS.map((item) => {
          const isActive = activeNav === item.id;
          return (
            <button
              key={item.id}
              type="button"
              className={`${styles.navItem} ${isActive ? styles.active : ''}`}
              aria-current={isActive ? 'page' : undefined}
              data-testid={`sidebar-nav-${item.id}`}
              onClick={() => onNavigate?.(item.id)}
            >
              <span className={styles.navIcon}>{item.icon}</span>
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className={styles.spacer} />

      {activeRuns.length === 1 ? (
        // N=1: existing single-pill layout (back-compat).
        renderSoloActiveRun(activeRuns[0] as Run, soloProjectName)
      ) : activeRuns.length > 1 ? (
        // N>1: stacked rows with header + "+N more" overflow indicator.
        <div
          className={styles.activeContext}
          data-testid="sidebar-active-context"
          data-multi="true"
        >
          <div
            className={styles.activeHeader}
            data-testid="sidebar-active-header"
          >
            <span className={styles.activeHeaderLabel}>Active runs</span>
            <span className={styles.activeHeaderCount}>{activeRuns.length}</span>
          </div>
          {visibleRuns.map((run) => (
            <div
              key={run.id}
              className={styles.activeMultiRow}
              data-testid={`sidebar-active-row-${run.id}`}
            >
              <span
                className={styles.activeMultiProject}
                title={projectNames[run.projectId] ?? run.projectId}
              >
                {projectNames[run.projectId] ?? run.projectId}
              </span>
              <span className={styles.activeValueMono}>{run.ticketKey}</span>
            </div>
          ))}
          {overflow > 0 && (
            <div
              className={styles.activeOverflow}
              data-testid="sidebar-active-overflow"
            >
              +{overflow} more
            </div>
          )}
        </div>
      ) : null}

      {user && (
        <div className={styles.user} data-testid="sidebar-user">
          <span className={styles.avatar} aria-hidden="true">
            {initialsOf(user.name)}
          </span>
          <div className={styles.userMeta}>
            <span className={styles.userName}>{user.name}</span>
            <span className={styles.userEmail}>{user.email}</span>
          </div>
        </div>
      )}

      <div className={styles.appVersion} data-testid="sidebar-app-version">
        {APP_VERSION}
      </div>
    </aside>
  );
}

/**
 * Inline paperplane horizontal lockup. Wordmark uses `fill="currentColor"`
 * so its color follows the SVG's CSS `color` property (bound to
 * `--text-primary` in `Sidebar.module.css`). That keeps the wordmark in
 * sync with theme changes without `useTheme()` here — see the same pattern
 * in `Titlebar.tsx`.
 */
function PaperplaneLockup(): JSX.Element {
  return (
    <svg
      viewBox="0 0 152 32"
      role="img"
      aria-label="PaperPlane"
      className={styles.lockup}
      data-testid="app-logo"
    >
      <PaperplaneGlyph />
      <text
        x="42"
        y="16"
        dominantBaseline="middle"
        fontFamily="'General Sans', 'Inter', 'SF Pro Display', system-ui, sans-serif"
        fontSize="14"
        fontWeight="600"
        letterSpacing="-0.01em"
        fill="currentColor"
      >
        PaperPlane
      </text>
    </svg>
  );
}
