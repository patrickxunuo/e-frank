import { useId } from 'react';
import styles from './Checkbox.module.css';

export interface CheckboxProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /**
   * Render the dash glyph. The native `.indeterminate` DOM property is NOT
   * driven from this prop — the visible state is purely presentational so
   * tests can assert it via the data attribute / dash glyph.
   */
  indeterminate?: boolean;
  disabled?: boolean;
  'aria-label'?: string;
  'data-testid'?: string;
}

/**
 * Visible custom checkbox sitting on top of a hidden real `<input>` so
 * keyboard + AT users get native semantics for free. `indeterminate` is a
 * prop-only state — `checked` MUST be `false` while it's true. Click on
 * either the label or the visible box still toggles via the input.
 *
 * Mirrors `Toggle`'s belt-and-suspenders disabled guard: jsdom doesn't
 * always block onChange when fireEvent.click hits a `disabled` checkbox.
 */
export function Checkbox({
  checked,
  onChange,
  indeterminate = false,
  disabled = false,
  'aria-label': ariaLabel,
  'data-testid': testId,
}: CheckboxProps): JSX.Element {
  const id = useId();
  const classes = [styles.row];
  if (disabled) classes.push(styles.disabled);

  // When indeterminate is presented, the controlled `checked` should be
  // false (per spec); we still ensure the click toggles to `true` because
  // the real-world UX is "indeterminate → all on".
  const dataChecked = indeterminate ? 'mixed' : checked ? 'true' : 'false';

  return (
    <label
      htmlFor={id}
      className={classes.join(' ')}
      data-checked={dataChecked}
      data-indeterminate={indeterminate ? 'true' : undefined}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-checked={indeterminate ? 'mixed' : checked}
        aria-label={ariaLabel}
        onChange={(e) => {
          // jsdom doesn't reliably block onChange on a disabled checkbox
          // when click is dispatched via fireEvent — guard explicitly.
          if (disabled) return;
          if (indeterminate) {
            onChange(true);
            return;
          }
          onChange(e.target.checked);
        }}
        data-testid={testId}
        className={styles.nativeInput}
      />
      <span className={styles.box} aria-hidden="true">
        {indeterminate ? (
          <span className={styles.dash} data-indeterminate-glyph />
        ) : checked ? (
          <svg
            className={styles.tick}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m3.5 8.5 3 3 6-7" />
          </svg>
        ) : null}
      </span>
    </label>
  );
}
