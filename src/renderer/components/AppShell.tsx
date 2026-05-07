import type { ReactNode } from 'react';
import styles from './AppShell.module.css';
import { Sidebar, type SidebarNavId, type SidebarUser } from './Sidebar';

/**
 * `route` lets the active view tell `<AppShell>` what to render so the
 * shell can adapt its chrome. Currently used to drop the `.main` padding
 * for the dense `execution` route — `<ExecutionView>` has its own layout
 * and shouldn't compete with a 48px outer buffer for screen real estate.
 */
export type AppShellRoute = 'list' | 'detail' | 'execution' | 'connections' | 'settings';

export interface AppShellProps {
  activeNav: SidebarNavId;
  user?: SidebarUser;
  /** Forwarded to the sidebar; called when the user clicks a nav item. */
  onNavigate?: (id: SidebarNavId) => void;
  /** Active route. Drives `<main>`'s `data-route` attribute for CSS hooks. */
  route?: AppShellRoute;
  children: ReactNode;
}

export function AppShell({
  activeNav,
  user,
  onNavigate,
  route,
  children,
}: AppShellProps): JSX.Element {
  return (
    <div className={styles.shell} data-testid="app-shell">
      <Sidebar activeNav={activeNav} user={user} onNavigate={onNavigate} />
      <main className={styles.main} data-route={route} data-testid="app-main">
        {children}
      </main>
    </div>
  );
}
