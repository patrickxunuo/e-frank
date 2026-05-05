import { useId } from 'react';
import styles from './Toggle.module.css';

export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  disabled?: boolean;
  'data-testid'?: string;
}

/**
 * Switch built on a real `<input type="checkbox">` (visually hidden) so
 * keyboard + assistive tech work for free. The visible track + thumb sit
 * on top of the input and inherit checked-state styling via parent
 * `data-checked` attribute.
 */
export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
  'data-testid': testId,
}: ToggleProps): JSX.Element {
  const id = useId();
  const classes = [styles.row];
  if (disabled) classes.push(styles.disabled);

  return (
    <label
      htmlFor={id}
      className={classes.join(' ')}
      data-checked={checked ? 'true' : 'false'}
    >
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => {
          // Belt-and-suspenders: jsdom doesn't always block change events on
          // disabled checkboxes when fireEvent.click is dispatched directly,
          // so guard explicitly.
          if (disabled) return;
          onChange(e.target.checked);
        }}
        data-testid={testId}
        style={{
          position: 'absolute',
          opacity: 0,
          pointerEvents: 'none',
          width: 0,
          height: 0,
        }}
      />
      <span className={styles.track} aria-hidden="true">
        <span className={styles.thumb} />
      </span>
      {label && <span className={styles.label}>{label}</span>}
    </label>
  );
}
