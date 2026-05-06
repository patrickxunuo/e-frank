import type { ReactNode } from 'react';
import styles from './AppShell.module.css';
import { Sidebar, type SidebarNavId, type SidebarUser } from './Sidebar';

export interface AppShellProps {
  activeNav: SidebarNavId;
  user?: SidebarUser;
  /** Forwarded to the sidebar; called when the user clicks a nav item. */
  onNavigate?: (id: SidebarNavId) => void;
  children: ReactNode;
}

export function AppShell({
  activeNav,
  user,
  onNavigate,
  children,
}: AppShellProps): JSX.Element {
  return (
    <div className={styles.shell} data-testid="app-shell">
      <Sidebar activeNav={activeNav} user={user} onNavigate={onNavigate} />
      <main className={styles.main} data-testid="app-main">
        {children}
      </main>
    </div>
  );
}
