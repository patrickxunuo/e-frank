import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import styles from './Input.module.css';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  label?: string;
  error?: string;
  hint?: string;
  leadingIcon?: ReactNode;
  /** Render value with monospace font (paths, branches, JQL keys). */
  mono?: boolean;
  /** Optional explicit testid override. */
  'data-testid'?: string;
}

/**
 * Text input with fixed-position label above and error/hint below.
 * Shell wraps the leading icon + native input so focus + error states
 * read consistently regardless of icon presence.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, hint, leadingIcon, mono = false, id, required, disabled, ...rest },
  ref,
) {
  const reactId = useId();
  const inputId = id ?? reactId;
  const describedBy: string[] = [];
  if (error) describedBy.push(`${inputId}-error`);
  else if (hint) describedBy.push(`${inputId}-hint`);

  const shellClasses = [styles.shell];
  if (error) shellClasses.push(styles.error);
  if (disabled) shellClasses.push(styles.disabled);

  const inputClasses = [styles.input];
  if (mono) inputClasses.push(styles.mono);

  return (
    <div className={styles.field}>
      {label && (
        <label
          htmlFor={inputId}
          className={`${styles.label} ${required ? styles.required : ''}`}
        >
          {label}
        </label>
      )}
      <div className={shellClasses.join(' ')}>
        {leadingIcon && <span className={styles.leadingIcon}>{leadingIcon}</span>}
        <input
          ref={ref}
          id={inputId}
          className={inputClasses.join(' ')}
          disabled={disabled}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy.length ? describedBy.join(' ') : undefined}
          {...rest}
        />
      </div>
      {error ? (
        <span id={`${inputId}-error`} className={`${styles.message} ${styles.errorMessage}`}>
          {error}
        </span>
      ) : hint ? (
        <span id={`${inputId}-hint`} className={styles.message}>
          {hint}
        </span>
      ) : null}
    </div>
  );
});
