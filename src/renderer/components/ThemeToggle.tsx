import { Button } from './Button';
import { IconMoon, IconSun } from './icons';
import { useTheme } from '../state/theme';
import styles from './ThemeToggle.module.css';

export interface ThemeToggleProps {
  'data-testid'?: string;
}

/**
 * Quick light↔dark toggle in the Sidebar. Post-#GH-84 the underlying
 * preference is 3-mode (`'light' | 'dark' | 'system'`), but this toggle
 * stays binary: the icon reflects the EFFECTIVE theme (`resolvedTheme`)
 * and clicking flips it. If the user is currently in `'system'` mode,
 * clicking the toggle escapes to the OPPOSITE of whatever the system
 * resolved to — the action is "give me the other one".
 *
 * The 3-way picker lives in the Settings page Theme section; this
 * toggle is the one-click quick-swap.
 */
export function ThemeToggle({
  'data-testid': testId = 'theme-toggle',
}: ThemeToggleProps): JSX.Element {
  const { resolvedTheme, toggle } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const ariaLabel = isDark ? 'Switch to light theme' : 'Switch to dark theme';

  return (
    <span className={styles.toggle}>
      <Button
        variant="icon"
        size="sm"
        type="button"
        onClick={() => {
          void toggle();
        }}
        aria-label={ariaLabel}
        data-testid={testId}
      >
        <span className={styles.icon} aria-hidden="true">
          {isDark ? <IconMoon size={16} /> : <IconSun size={16} />}
        </span>
      </Button>
    </span>
  );
}
