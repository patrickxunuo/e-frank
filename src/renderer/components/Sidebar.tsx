import styles from './Sidebar.module.css';
import { IconLogo, IconProjects, IconSettings } from './icons';

export type SidebarNavId = 'projects' | 'settings';

export interface SidebarUser {
  name: string;
  email: string;
}

export interface SidebarProps {
  activeNav: SidebarNavId;
  user?: SidebarUser;
}

interface NavItemDef {
  id: SidebarNavId;
  label: string;
  icon: JSX.Element;
}

const NAV_ITEMS: NavItemDef[] = [
  { id: 'projects', label: 'Projects', icon: <IconProjects /> },
  { id: 'settings', label: 'Settings', icon: <IconSettings /> },
];

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const second = parts[1]?.[0] ?? '';
  return (first + second).toUpperCase() || '?';
}

export function Sidebar({ activeNav, user }: SidebarProps): JSX.Element {
  return (
    <aside className={styles.sidebar} data-testid="sidebar">
      <div className={styles.brand}>
        <span className={styles.mark} aria-hidden="true">
          <IconLogo />
        </span>
        <div className={styles.wordmark}>
          <span className={styles.name} data-testid="sidebar-product-name">
            e-frank
          </span>
          <span className={styles.tag}>Ticket → PR</span>
        </div>
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
            >
              <span className={styles.navIcon}>{item.icon}</span>
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className={styles.spacer} />

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
    </aside>
  );
}
