import packageJson from '../../../package.json';
import styles from './Sidebar.module.css';
import { IconKey, IconProjects, IconSettings } from './icons';
import { PaperplaneGlyph } from './PaperplaneGlyph';
import { ThemeToggle } from './ThemeToggle';

const APP_VERSION = `v${packageJson.version}`;

export type SidebarNavId = 'projects' | 'connections' | 'settings';

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
  { id: 'settings', label: 'Settings', icon: <IconSettings /> },
];

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const second = parts[1]?.[0] ?? '';
  return (first + second).toUpperCase() || '?';
}

export function Sidebar({ activeNav, user, onNavigate }: SidebarProps): JSX.Element {
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

      <ThemeToggle />

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
      aria-label="paperplane"
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
        paperplane
      </text>
    </svg>
  );
}
