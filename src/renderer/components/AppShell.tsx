import type { ReactNode } from 'react';
import styles from './AppShell.module.css';
import { Sidebar, type SidebarNavId, type SidebarUser } from './Sidebar';

export interface AppShellProps {
  activeNav: SidebarNavId;
  user?: SidebarUser;
  children: ReactNode;
}

export function AppShell({ activeNav, user, children }: AppShellProps): JSX.Element {
  return (
    <div className={styles.shell} data-testid="app-shell">
      <Sidebar activeNav={activeNav} user={user} />
      <main className={styles.main} data-testid="app-main">
        {children}
      </main>
    </div>
  );
}
