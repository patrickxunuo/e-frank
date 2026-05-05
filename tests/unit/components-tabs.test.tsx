// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Tabs } from '../../src/renderer/components/Tabs';

/**
 * CMP-TABS-001..003 — public API of <Tabs>:
 *   - Renders all items + active underline / indicator on the value
 *   - Click a non-active tab → onChange fires with that id
 *   - Disabled tab — click does NOT fire onChange
 *
 * The component renders each tab as a `<button role="tab">` and the strip
 * itself as `role="tablist"` (per spec). We rely on the role queries first,
 * then fall back to data-testid for finer-grained assertions.
 */

const items = [
  { id: 'tickets', label: 'Tickets' },
  { id: 'runs', label: 'Runs' },
  { id: 'prs', label: 'Pull Requests', disabled: true },
  { id: 'settings', label: 'Settings' },
];

afterEach(() => {
  cleanup();
});

describe('<Tabs /> — CMP-TABS', () => {
  it('CMP-TABS-001: renders all items and marks the active tab', () => {
    render(
      <Tabs
        items={items}
        value="tickets"
        onChange={() => {}}
        data-testid="tabs"
      />,
    );

    // tablist + 4 tabs
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(4);

    // The active tab should be marked. The natural ARIA attribute is
    // aria-selected="true". We accept either aria-selected or a class
    // substring containing "active" / "selected" — both are valid encodings
    // of the active state.
    const ticketsTab = tabs.find((t) => /tickets/i.test(t.textContent ?? ''));
    expect(ticketsTab).toBeDefined();
    const activeMarker =
      ticketsTab!.getAttribute('aria-selected') === 'true' ||
      /active|selected/i.test(ticketsTab!.className);
    expect(activeMarker).toBe(true);

    // Non-active tab should NOT carry the active marker.
    const runsTab = tabs.find((t) => /runs/i.test(t.textContent ?? ''));
    expect(runsTab).toBeDefined();
    const inactiveMarker =
      runsTab!.getAttribute('aria-selected') === 'true' ||
      /(?:^|\s)active(?:\s|$)|(?:^|\s)selected(?:\s|$)/i.test(runsTab!.className);
    expect(inactiveMarker).toBe(false);
  });

  it('CMP-TABS-002: clicking a non-active tab fires onChange with that id', () => {
    const onChange = vi.fn();
    render(<Tabs items={items} value="tickets" onChange={onChange} />);
    const tabs = screen.getAllByRole('tab');
    const runsTab = tabs.find((t) => /runs/i.test(t.textContent ?? ''));
    expect(runsTab).toBeDefined();
    fireEvent.click(runsTab!);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('runs');
  });

  it('CMP-TABS-003: disabled tab — click does NOT fire onChange', () => {
    const onChange = vi.fn();
    render(<Tabs items={items} value="tickets" onChange={onChange} />);
    const tabs = screen.getAllByRole('tab');
    const prsTab = tabs.find((t) => /pull requests/i.test(t.textContent ?? ''));
    expect(prsTab).toBeDefined();
    fireEvent.click(prsTab!);
    expect(onChange).not.toHaveBeenCalled();
  });
});
