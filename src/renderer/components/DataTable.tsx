import type { ReactNode } from 'react';
import styles from './DataTable.module.css';

export interface DataTableColumn<Row> {
  key: string;
  header: ReactNode;
  render: (row: Row) => ReactNode;
  align?: 'left' | 'right';
  width?: string;
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
}: DataTableProps<Row>): JSX.Element {
  if (rows.length === 0 && emptyState) {
    return <div className={styles.empty}>{emptyState}</div>;
  }

  return (
    <div className={styles.wrapper} data-testid={testId}>
      <table className={styles.table}>
        <thead className={styles.thead}>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                className={col.align === 'right' ? styles.alignRight : ''}
                style={col.width ? { width: col.width } : undefined}
              >
                {col.header}
              </th>
            ))}
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
        </tbody>
      </table>
    </div>
  );
}
