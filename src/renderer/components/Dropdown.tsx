import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { IconChevronDown } from './icons';
import styles from './Dropdown.module.css';

interface MenuRect {
  top: number;
  left: number;
  width: number;
}

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
  /**
   * When true, a search input is rendered above the option list. Filters
   * options client-side via case-insensitive substring match. Default: false.
   */
  searchable?: boolean;
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
 * `-option-{value}`) for new tests. When `searchable` is true, a search
 * input also appears with testid `{testid}-search`.
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
  searchable = false,
  'data-testid': testId = 'dropdown',
  name,
}: DropdownProps): JSX.Element {
  const reactId = useId();
  const triggerId = `${reactId}-trigger`;
  const menuId = `${reactId}-menu`;

  const [open, setOpen] = useState<boolean>(false);
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);
  const [menuRect, setMenuRect] = useState<MenuRect | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const selectedOption = useMemo(
    () => options.find((o) => o.value === value),
    [options, value],
  );

  // The "visible" option set after applying the search filter. When
  // searchable is false (or query is empty), this is the original list.
  const visibleOptions = useMemo<ReadonlyArray<DropdownOption>>(() => {
    if (!searchable) return options;
    const q = searchQuery.trim().toLowerCase();
    if (q === '') return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, searchable, searchQuery]);

  const describedBy: string[] = [];
  if (error) describedBy.push(`${reactId}-error`);
  else if (hint) describedBy.push(`${reactId}-hint`);

  // Close on outside click. Both the shell (trigger + hidden select) AND
  // the portaled menu count as "inside".
  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (shellRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
    };
  }, [open]);

  // Reset the search query whenever the menu closes — opening it again
  // should always start from a clean filter.
  useEffect(() => {
    if (!open) {
      setSearchQuery('');
    }
  }, [open]);

  // Auto-focus the search input on open. Done in a layout effect so the
  // input exists before focus is requested.
  useLayoutEffect(() => {
    if (!open || !searchable) return;
    searchInputRef.current?.focus();
  }, [open, searchable]);

  // Measure the trigger when opening (and reposition on scroll/resize while
  // open). The menu is portaled to <body>, so its layout uses viewport
  // coordinates via position: fixed.
  useLayoutEffect(() => {
    if (!open) {
      setMenuRect(null);
      return;
    }
    const measure = (): void => {
      const el = shellRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setMenuRect({
        top: rect.bottom + 4,
        left: rect.left,
        width: rect.width,
      });
    };
    measure();
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [open]);

  // When opening, seed the highlight to the current value (or the first
  // non-disabled option of the FILTERED set). Re-runs when the visible set
  // changes (i.e. the user types in the search box).
  useEffect(() => {
    if (!open) {
      setHighlightedIndex(-1);
      return;
    }
    const idx = visibleOptions.findIndex((o) => o.value === value);
    if (idx >= 0) {
      setHighlightedIndex(idx);
      return;
    }
    const firstEnabled = visibleOptions.findIndex((o) => !o.disabled);
    setHighlightedIndex(firstEnabled);
  }, [open, visibleOptions, value]);

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
      if (visibleOptions.length === 0) return;
      setHighlightedIndex((prev) => {
        const start =
          prev < 0 ? (direction === 1 ? -1 : visibleOptions.length) : prev;
        let i = start;
        for (let step = 0; step < visibleOptions.length; step += 1) {
          i = (i + direction + visibleOptions.length) % visibleOptions.length;
          const opt = visibleOptions[i];
          if (opt && !opt.disabled) return i;
        }
        return prev;
      });
    },
    [visibleOptions],
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
          const opt = visibleOptions[highlightedIndex];
          if (opt && !opt.disabled) {
            event.preventDefault();
            commit(opt.value);
          }
        }
      }
    },
    [commit, disabled, highlightedIndex, moveHighlight, open, visibleOptions],
  );

  // Search input shares the trigger's keyboard handling so arrow keys still
  // navigate (and Enter still commits) while the input is focused.
  const handleSearchKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveHighlight(1);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveHighlight(-1);
        return;
      }
      if (event.key === 'Enter') {
        if (highlightedIndex >= 0) {
          const opt = visibleOptions[highlightedIndex];
          if (opt && !opt.disabled) {
            event.preventDefault();
            commit(opt.value);
          }
        }
      }
    },
    [commit, highlightedIndex, moveHighlight, visibleOptions],
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
    <div className={styles.field}>
      {label && (
        <label
          htmlFor={triggerId}
          className={`${styles.label} ${required ? styles.required : ''}`}
        >
          {label}
        </label>
      )}
      <div
        ref={shellRef}
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
      {open && menuRect !== null && typeof document !== 'undefined'
        ? createPortal(
            <ul
              ref={menuRef}
              id={menuId}
              className={styles.menu}
              role="listbox"
              data-testid={`${testId}-menu`}
              style={{
                position: 'fixed',
                top: `${menuRect.top}px`,
                left: `${menuRect.left}px`,
                width: `${menuRect.width}px`,
              }}
            >
              {searchable && (
                <li role="presentation" className={styles.searchRow}>
                  <input
                    ref={searchInputRef}
                    type="text"
                    className={styles.search}
                    placeholder="Search…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={handleSearchKeyDown}
                    data-testid={`${testId}-search`}
                    aria-label="Search options"
                  />
                </li>
              )}
              {visibleOptions.length === 0 && searchable ? (
                <li
                  role="presentation"
                  className={styles.empty}
                  data-testid={`${testId}-empty`}
                >
                  No matches
                </li>
              ) : (
                visibleOptions.map((o, idx) => (
                  <li key={o.value} role="presentation">
                    <button
                      type="button"
                      role="option"
                      aria-selected={value === o.value}
                      disabled={o.disabled}
                      className={styles.option}
                      data-disabled={o.disabled ? 'true' : undefined}
                      data-active={value === o.value ? 'true' : undefined}
                      data-highlighted={
                        highlightedIndex === idx ? 'true' : undefined
                      }
                      data-testid={`${testId}-option-${o.value}`}
                      onClick={() => handleOptionClick(o)}
                      onMouseEnter={() => {
                        if (!o.disabled) setHighlightedIndex(idx);
                      }}
                    >
                      {o.label}
                    </button>
                  </li>
                ))
              )}
            </ul>,
            document.body,
          )
        : null}
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
