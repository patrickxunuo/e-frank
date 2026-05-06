import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { IconChevronDown } from './icons';
import styles from './Dropdown.module.css';

export interface DropdownOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface DropdownProps {
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  disabled?: boolean;
  value: string;
  onChange: (next: string) => void;
  options: ReadonlyArray<DropdownOption>;
  /** Placeholder shown when value is empty / not in options. */
  placeholder?: string;
  /** Goes on the hidden native <select> so existing fireEvent.change tests keep working. */
  'data-testid'?: string;
  name?: string;
}

/**
 * Hybrid dropdown:
 *   - A custom-styled trigger + popover for the visible UI.
 *   - A hidden native `<select>` underneath so existing
 *     `fireEvent.change(selectEl, { target: { value: '...' } })` tests keep
 *     working without rewriting them.
 *
 * The hidden `<select>` carries the `data-testid` prop verbatim. The
 * trigger and menu items get suffixed testids (`-trigger`, `-menu`,
 * `-option-{value}`) for new tests.
 */
export function Dropdown({
  label,
  hint,
  error,
  required,
  disabled = false,
  value,
  onChange,
  options,
  placeholder,
  'data-testid': testId = 'dropdown',
  name,
}: DropdownProps): JSX.Element {
  const reactId = useId();
  const triggerId = `${reactId}-trigger`;
  const menuId = `${reactId}-menu`;

  const [open, setOpen] = useState<boolean>(false);
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const selectedOption = useMemo(
    () => options.find((o) => o.value === value),
    [options, value],
  );

  const describedBy: string[] = [];
  if (error) describedBy.push(`${reactId}-error`);
  else if (hint) describedBy.push(`${reactId}-hint`);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent): void => {
      const root = rootRef.current;
      const target = event.target;
      if (!root) return;
      if (target instanceof Node && root.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
    };
  }, [open]);

  // When opening, seed the highlight to the current value (or the first
  // non-disabled option if not present).
  useEffect(() => {
    if (!open) {
      setHighlightedIndex(-1);
      return;
    }
    const idx = options.findIndex((o) => o.value === value);
    if (idx >= 0) {
      setHighlightedIndex(idx);
    } else {
      const firstEnabled = options.findIndex((o) => !o.disabled);
      setHighlightedIndex(firstEnabled);
    }
  }, [open, options, value]);

  const commit = useCallback(
    (next: string): void => {
      onChange(next);
      setOpen(false);
      // Return focus to the trigger so keyboard nav keeps flowing.
      triggerRef.current?.focus();
    },
    [onChange],
  );

  const moveHighlight = useCallback(
    (direction: 1 | -1): void => {
      if (options.length === 0) return;
      setHighlightedIndex((prev) => {
        const start = prev < 0 ? (direction === 1 ? -1 : options.length) : prev;
        let i = start;
        for (let step = 0; step < options.length; step += 1) {
          i = (i + direction + options.length) % options.length;
          const opt = options[i];
          if (opt && !opt.disabled) return i;
        }
        return prev;
      });
    },
    [options],
  );

  const handleTriggerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
      if (disabled) return;
      if (event.key === 'Escape') {
        if (open) {
          event.preventDefault();
          setOpen(false);
        }
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (!open) {
          setOpen(true);
          return;
        }
        moveHighlight(1);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (!open) {
          setOpen(true);
          return;
        }
        moveHighlight(-1);
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        if (!open) {
          event.preventDefault();
          setOpen(true);
          return;
        }
        if (highlightedIndex >= 0) {
          const opt = options[highlightedIndex];
          if (opt && !opt.disabled) {
            event.preventDefault();
            commit(opt.value);
          }
        }
      }
    },
    [commit, disabled, highlightedIndex, moveHighlight, open, options],
  );

  const handleTriggerClick = useCallback((): void => {
    if (disabled) return;
    setOpen((prev) => !prev);
  }, [disabled]);

  const handleOptionClick = useCallback(
    (opt: DropdownOption): void => {
      if (opt.disabled) return;
      commit(opt.value);
    },
    [commit],
  );

  const triggerLabel = selectedOption?.label;
  const showPlaceholder = triggerLabel === undefined;

  return (
    <div className={styles.field} ref={rootRef}>
      {label && (
        <label
          htmlFor={triggerId}
          className={`${styles.label} ${required ? styles.required : ''}`}
        >
          {label}
        </label>
      )}
      <div
        className={styles.shell}
        data-error={error ? 'true' : undefined}
        data-disabled={disabled ? 'true' : undefined}
        data-open={open ? 'true' : undefined}
      >
        <button
          ref={triggerRef}
          id={triggerId}
          type="button"
          className={styles.trigger}
          disabled={disabled}
          onClick={handleTriggerClick}
          onKeyDown={handleTriggerKeyDown}
          aria-haspopup="listbox"
          aria-expanded={open ? true : false}
          aria-controls={menuId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy.length ? describedBy.join(' ') : undefined}
          data-testid={`${testId}-trigger`}
        >
          <span
            className={`${styles.value} ${showPlaceholder ? styles.placeholder : ''}`}
          >
            {showPlaceholder ? placeholder ?? '' : triggerLabel}
          </span>
          <span className={styles.chevron} aria-hidden="true">
            <IconChevronDown size={12} />
          </span>
        </button>
        <select
          hidden
          tabIndex={-1}
          aria-hidden="true"
          value={value}
          name={name}
          disabled={disabled}
          required={required}
          onChange={(e) => onChange(e.target.value)}
          data-testid={testId}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      {open && (
        <ul
          id={menuId}
          className={styles.menu}
          role="listbox"
          data-testid={`${testId}-menu`}
        >
          {options.map((o, idx) => (
            <li key={o.value} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={value === o.value}
                disabled={o.disabled}
                className={styles.option}
                data-disabled={o.disabled ? 'true' : undefined}
                data-active={value === o.value ? 'true' : undefined}
                data-highlighted={highlightedIndex === idx ? 'true' : undefined}
                data-testid={`${testId}-option-${o.value}`}
                onClick={() => handleOptionClick(o)}
                onMouseEnter={() => {
                  if (!o.disabled) setHighlightedIndex(idx);
                }}
              >
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <span
          id={`${reactId}-error`}
          className={`${styles.message} ${styles.errorMessage}`}
        >
          {error}
        </span>
      ) : hint ? (
        <span id={`${reactId}-hint`} className={styles.message}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}
