import type { ReactNode } from 'react';
import styles from './DataTable.module.css';

export type SortDirection = 'asc' | 'desc';

export interface DataTableSortState {
  /** Sort key — must match a column's `key`. */
  key: string;
  dir: SortDirection;
}

export interface DataTableColumn<Row> {
  key: string;
  header: ReactNode;
  render: (row: Row) => ReactNode;
  align?: 'left' | 'right';
  width?: string;
  /**
   * When true, the header is rendered as a clickable button. Clicking it
   * toggles direction (asc → desc → asc) for the active sort key, or
   * switches the active key to this column with the default direction.
   */
  sortable?: boolean;
  /**
   * Default direction for `sortable` columns when they become active.
   * Defaults to 'desc' (newest/biggest first).
   */
  defaultSortDir?: SortDirection;
  /**
   * Per-column disable hint for sortable columns — used by ProjectDetail to
   * gray out priority sort on GitHub-backed projects without dropping the
   * column from the layout. Disabled headers render plain text.
   */
  sortDisabled?: boolean;
}

export interface DataTableProps<Row> {
  columns: DataTableColumn<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  emptyState?: ReactNode;
  onRowClick?: (row: Row) => void;
  /** Optional per-row data-testid generator (e.g. `project-row-{id}`). */
  rowTestId?: (row: Row) => string;
  'data-testid'?: string;
  /**
   * Opt-in: the wrapper claims the parent's height (flex:1 + min-height:0)
   * and scrolls its rows internally. Sticky `<thead>` keeps column labels
   * pinned. Footer slot ('footer') sits below the table inside the
   * scrollable card.
   *
   * Requires the parent to be a flex column with a constrained height.
   */
  fillHeight?: boolean;
  /** Active sort state. Required when any column is sortable. */
  sort?: DataTableSortState;
  onSortChange?: (next: DataTableSortState) => void;
  /**
   * Rendered at the bottom of the table card. Used by the infinite-scroll
   * sentinel + "loading more" row in ProjectDetail's tickets table. Lives
   * inside the scroll region so it scrolls into view when the user reaches
   * the bottom of the loaded rows.
   */
  footer?: ReactNode;
}

/**
 * Lightweight semantic `<table>`. Rows fade-up with staggered delays on first
 * paint; subsequent re-renders preserve the position so the animation only
 * fires when a row first appears.
 */
export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  emptyState,
  onRowClick,
  rowTestId,
  'data-testid': testId,
  fillHeight = false,
  sort,
  onSortChange,
  footer,
}: DataTableProps<Row>): JSX.Element {
  if (rows.length === 0 && emptyState && footer === undefined) {
    return <div className={styles.empty}>{emptyState}</div>;
  }

  const wrapperClass = fillHeight
    ? `${styles.wrapper} ${styles.fillHeight}`
    : styles.wrapper;

  const handleHeaderClick = (col: DataTableColumn<Row>): void => {
    if (col.sortable !== true || col.sortDisabled === true) return;
    if (onSortChange === undefined) return;
    const fallback: SortDirection = col.defaultSortDir ?? 'desc';
    if (sort !== undefined && sort.key === col.key) {
      onSortChange({ key: col.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' });
      return;
    }
    onSortChange({ key: col.key, dir: fallback });
  };

  return (
    <div
      className={wrapperClass}
      data-testid={testId}
      // When fillHeight is on, this wrapper is the scroll container.
      // IntersectionObserver consumers (e.g. ProjectDetail's infinite-
      // scroll sentinel) walk up via `closest('[data-scroll-root]')` to
      // find it, so the observer's `root` resolves to the right element.
      {...(fillHeight ? { 'data-scroll-root': '' } : {})}
    >
      <table className={styles.table}>
        <thead className={fillHeight ? `${styles.thead} ${styles.theadSticky}` : styles.thead}>
          <tr>
            {columns.map((col) => {
              const cls = col.align === 'right' ? styles.alignRight : '';
              const sortActive = sort !== undefined && sort.key === col.key;
              const isSortable = col.sortable === true && col.sortDisabled !== true;
              if (isSortable) {
                return (
                  <th
                    key={col.key}
                    className={cls}
                    style={col.width ? { width: col.width } : undefined}
                    aria-sort={
                      sortActive
                        ? sort.dir === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                    }
                  >
                    <button
                      type="button"
                      className={styles.sortButton}
                      onClick={() => handleHeaderClick(col)}
                      data-testid={`sort-${col.key}`}
                    >
                      <span className={styles.sortLabel}>{col.header}</span>
                      <span
                        className={styles.sortIndicator}
                        data-active={sortActive ? 'true' : 'false'}
                        data-dir={sortActive ? sort.dir : undefined}
                        aria-hidden="true"
                      >
                        {sortActive ? (sort.dir === 'asc' ? '↑' : '↓') : '↕'}
                      </span>
                    </button>
                  </th>
                );
              }
              return (
                <th
                  key={col.key}
                  className={cls}
                  style={col.width ? { width: col.width } : undefined}
                >
                  {col.header}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const rowClasses = [styles.row];
            if (!onRowClick) rowClasses.push(styles.unclickable);
            return (
              <tr
                key={rowKey(row)}
                className={rowClasses.join(' ')}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
                data-testid={rowTestId ? rowTestId(row) : undefined}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={col.align === 'right' ? styles.alignRight : ''}
                  >
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
          {rows.length === 0 && emptyState && (
            <tr>
              <td
                colSpan={columns.length}
                className={styles.inlineEmpty}
              >
                {emptyState}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {footer !== undefined && <div className={styles.footer}>{footer}</div>}
    </div>
  );
}
