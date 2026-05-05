import { forwardRef, useId, type TextareaHTMLAttributes } from 'react';
import styles from './Input.module.css';

export interface TextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> {
  label?: string;
  error?: string;
  hint?: string;
  mono?: boolean;
  'data-testid'?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, error, hint, mono = false, id, required, disabled, ...rest },
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

  const inputClasses = [styles.input, styles.textarea];
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
        <textarea
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
