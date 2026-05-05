import { forwardRef, useId, type SelectHTMLAttributes, type ReactNode } from 'react';
import styles from './Input.module.css';

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className'> {
  label?: string;
  error?: string;
  hint?: string;
  leadingIcon?: ReactNode;
  children: ReactNode;
  'data-testid'?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, error, hint, leadingIcon, id, required, disabled, children, ...rest },
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
        <select
          ref={ref}
          id={inputId}
          className={styles.input}
          disabled={disabled}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy.length ? describedBy.join(' ') : undefined}
          {...rest}
        >
          {children}
        </select>
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
