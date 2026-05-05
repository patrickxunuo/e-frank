import type { ReactNode } from 'react';
import styles from './Tabs.module.css';

export interface TabItem {
  id: string;
  label: ReactNode;
  /** Optional badge/count rendered after the label. */
  badge?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  items: TabItem[];
  value: string;
  onChange: (next: string) => void;
  'data-testid'?: string;
}

/**
 * Controlled tablist. Active tab carries a left-to-right animated underline
 * driven by `data-active`; inactive tabs show a soft hover state. Disabled
 * items short-circuit `onChange` (mirrors the Toggle pattern: the click
 * handler still fires in jsdom even with `disabled`, so we guard explicitly).
 *
 * Accessibility: the strip is `role="tablist"`, each button is `role="tab"`
 * with `aria-selected` reflecting the controlled value.
 */
export function Tabs({
  items,
  value,
  onChange,
  'data-testid': testId,
}: TabsProps): JSX.Element {
  return (
    <div className={styles.tablist} role="tablist" data-testid={testId}>
      {items.map((item) => {
        const isActive = item.id === value;
        const classes = [styles.tab];
        if (isActive) classes.push(styles.active);
        if (item.disabled) classes.push(styles.disabled);
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-disabled={item.disabled || undefined}
            disabled={item.disabled}
            className={classes.join(' ')}
            data-active={isActive ? 'true' : 'false'}
            data-testid={`${testId ?? 'tabs'}-tab-${item.id}`}
            onClick={() => {
              if (item.disabled) return;
              onChange(item.id);
            }}
          >
            <span className={styles.label}>{item.label}</span>
            {item.badge !== undefined && item.badge !== null && (
              <span className={styles.badge}>{item.badge}</span>
            )}
            <span className={styles.underline} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
