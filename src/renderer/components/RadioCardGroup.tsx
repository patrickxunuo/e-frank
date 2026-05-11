/**
 * `<RadioCardGroup>` — side-by-side card-radio control. Each option is a
 * clickable card (icon + title + description); the selected card gets an
 * accent border + filled background. Designed for binary or short-list
 * mode pickers where seeing all options simultaneously beats a Dropdown's
 * one-line summary.
 *
 * Powers AddProject's Workflow Mode picker (Interactive vs YOLO) and is
 * shaped generically so future per-run / per-skill pickers can reuse it.
 *
 * Accessibility: `role="radiogroup"` on the wrapper + `role="radio"` +
 * `aria-checked` per card. Arrow keys (←/→/↑/↓) move focus between cards
 * and update the value — standard radio-group keyboard pattern.
 */

import { useId, useRef } from 'react';
import type { JSX } from 'react';
import styles from './RadioCardGroup.module.css';

export interface RadioCardOption<T extends string> {
  value: T;
  title: string;
  description: string;
  icon: JSX.Element;
}

export interface RadioCardGroupProps<T extends string> {
  /** Label shown above the card row. Optional. */
  label?: string;
  /** Renders the required asterisk on the label. Visual only. */
  required?: boolean;
  /** The currently-selected value. */
  value: T;
  /** Called when the user picks a different card. */
  onChange: (next: T) => void;
  /** Options to render. Order is preserved left-to-right. */
  options: RadioCardOption<T>[];
  /** Form field name (for inclusion in submitted forms via hidden input). */
  name?: string;
  /** Testid root — option testids are derived as `{testid}-option-{value}`. */
  'data-testid'?: string;
}

export function RadioCardGroup<T extends string>({
  label,
  required,
  value,
  onChange,
  options,
  name,
  'data-testid': testId,
}: RadioCardGroupProps<T>): JSX.Element {
  // Stable id for the label↔group association. Each card gets its own
  // tabindex; the radiogroup itself is not tab-stoppable — the focused
  // card is the tab stop.
  const groupId = useId();
  const cardRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const handleKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    currentIdx: number,
  ): void => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') {
      return;
    }
    e.preventDefault();
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    const nextIdx = (currentIdx + delta + options.length) % options.length;
    const nextOption = options[nextIdx];
    if (nextOption === undefined) return;
    cardRefs.current[nextIdx]?.focus();
    onChange(nextOption.value);
  };

  return (
    <div
      className={styles.field}
      role="radiogroup"
      aria-labelledby={label !== undefined ? `${groupId}-label` : undefined}
      data-testid={testId}
    >
      {label !== undefined && (
        <span id={`${groupId}-label`} className={styles.label}>
          {label}
          {required && <span className={styles.required} aria-hidden="true"> *</span>}
        </span>
      )}
      <div className={styles.cards}>
        {options.map((opt, idx) => {
          const selected = opt.value === value;
          return (
            <button
              key={opt.value}
              ref={(node) => {
                cardRefs.current[idx] = node;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              // Only the focused card is in the tab order; others step out
              // so a single Tab moves past the entire group.
              tabIndex={selected ? 0 : -1}
              className={`${styles.card} ${selected ? styles.cardSelected : ''}`}
              onClick={() => onChange(opt.value)}
              onKeyDown={(e) => handleKeyDown(e, idx)}
              data-testid={testId !== undefined ? `${testId}-option-${opt.value}` : undefined}
            >
              <span className={styles.cardIcon} aria-hidden="true">
                {opt.icon}
              </span>
              <span className={styles.cardTitle}>{opt.title}</span>
              <span className={styles.cardDescription}>{opt.description}</span>
            </button>
          );
        })}
      </div>
      {/*
       * Hidden form-pairing input. Lets the surrounding <form> serialize
       * the value via standard form-data submission if anyone reaches for
       * that path. Mirrors the pattern Input / Dropdown use.
       */}
      {name !== undefined && <input type="hidden" name={name} value={value} />}
    </div>
  );
}
