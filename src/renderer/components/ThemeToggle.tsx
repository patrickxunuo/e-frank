import { Button } from './Button';
import { IconMoon, IconSun } from './icons';
import { useTheme } from '../state/theme';
import styles from './ThemeToggle.module.css';

export interface ThemeToggleProps {
  'data-testid'?: string;
}

/**
 * Binary light/dark toggle. Renders a Button (variant="icon" size="sm") so
 * it inherits the same focus ring as every other icon button in the app.
 * The icon swaps based on the *current* theme; the aria-label describes
 * the *next* state for clarity.
 */
export function ThemeToggle({
  'data-testid': testId = 'theme-toggle',
}: ThemeToggleProps): JSX.Element {
  const { theme, toggle } = useTheme();
  const isDark = theme === 'dark';
  const ariaLabel = isDark ? 'Switch to light theme' : 'Switch to dark theme';

  return (
    <span className={styles.toggle}>
      <Button
        variant="icon"
        size="sm"
        type="button"
        onClick={toggle}
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
