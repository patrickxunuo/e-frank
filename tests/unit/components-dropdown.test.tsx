// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Dropdown, type DropdownOption } from '../../src/renderer/components/Dropdown';

/**
 * CMP-DROPDOWN-001..012 — <Dropdown /> component.
 *
 * Render contract under test (per spec):
 *  - Hidden native <select> carries the `data-testid` from props so
 *    existing fireEvent.change tests keep working.
 *  - The custom-styled trigger button has testid `{testid}-trigger`.
 *  - Open menu has testid `{testid}-menu`.
 *  - Each option has testid `{testid}-option-{value}`.
 *  - Disabled prop disables BOTH trigger and hidden select.
 *  - Error prop renders an error message and applies error styling
 *    (we only assert the message text is in the DOM — styling is CSS).
 *  - Trigger shows the placeholder when no option matches `value`.
 *
 * Interaction behaviour:
 *  - Trigger click toggles the menu open.
 *  - Click an option calls onChange(value) and closes the menu.
 *  - Disabled option click is a no-op.
 *  - Click outside closes the menu.
 *  - Escape on trigger closes the menu.
 *  - ArrowDown on closed trigger opens the menu.
 *
 * We use a small Harness component that owns the state so we can drive
 * `value` / `onChange` realistically.
 */

const OPTS: DropdownOption[] = [
  { value: 'github', label: 'GitHub' },
  { value: 'jira', label: 'Jira' },
  { value: 'bitbucket', label: 'Bitbucket (coming soon)', disabled: true },
];

interface HarnessProps {
  testid?: string;
  initial?: string;
  onChangeSpy?: (next: string) => void;
  disabled?: boolean;
  error?: string;
  options?: ReadonlyArray<DropdownOption>;
  placeholder?: string;
}

function Harness({
  testid = 'provider-select',
  initial = 'github',
  onChangeSpy,
  disabled,
  error,
  options = OPTS,
  placeholder,
}: HarnessProps): JSX.Element {
  const [value, setValue] = useState<string>(initial);
  return (
    <Dropdown
      data-testid={testid}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChangeSpy?.(next);
      }}
      options={options}
      disabled={disabled}
      error={error}
      placeholder={placeholder}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('<Dropdown /> — CMP-DROPDOWN', () => {
  // ---------------------------------------------------------------------------
  // CMP-DROPDOWN-001 — Hidden <select> renders with the data-testid from props
  // ---------------------------------------------------------------------------
  it('CMP-DROPDOWN-001: hidden <select> renders with the provided data-testid', () => {
    render(<Harness testid="provider-select" initial="github" />);
    const select = screen.getByTestId('provider-select');
    expect(select.tagName.toLowerCase()).toBe('select');
  });

  // ---------------------------------------------------------------------------
  // CMP-DROPDOWN-002 — fireEvent.change parity with old Select tests
  // ---------------------------------------------------------------------------
  it('CMP-DROPDOWN-002: fireEvent.change on the hidden select fires onChange(value)', () => {
    const onChange = vi.fn();
    render(
      <Harness
        testid="provider-select"
        initial="github"
        onChangeSpy={onChange}
      />,
    );

    fireEvent.change(screen.getByTestId('provider-select'), {
      target: { value: 'jira' },
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('jira');
  });

  // ---------------------------------------------------------------------------
  // CMP-DROPDOWN-003 — Trigger displays the label of the currently-selected option
  // ---------------------------------------------------------------------------
  it('CMP-DROPDOWN-003: trigger displays the label of the currently-selected option', () => {
    render(<Harness testid="provider-select" initial="jira" />);
    const trigger = screen.getByTestId('provider-select-trigger');
    expect(trigger.textContent).toMatch(/jira/i);
  });

  // ---------------------------------------------------------------------------
  // CMP-DROPDOWN-004 — Trigger click opens the menu
  // ---------------------------------------------------------------------------
  it('CMP-DROPDOWN-004: trigger click opens the menu', () => {
    render(<Harness testid="provider-select" initial="github" />);

    expect(screen.queryByTestId('provider-select-menu')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('provider-select-trigger'));

    expect(screen.getByTestId('provider-select-menu')).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // CMP-DROPDOWN-005 — Click option calls onChange(value) AND closes menu
  // ---------------------------------------------------------------------------
  it('CMP-DROPDOWN-005: clicking an option calls onChange(value) and closes the menu', async () => {
    const onChange = vi.fn();
    render(
      <Harness
        testid="provider-select"
        initial="github"
        onChangeSpy={onChange}
      />,
    );

    fireEvent.click(screen.getByTestId('provider-select-trigger'));
    expect(screen.getByTestId('provider-select-menu')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('provider-select-option-jira'));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('jira');

    await waitFor(() => {
      expect(screen.queryByTestId('provider-select-menu')).not.toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // CMP-DROPDOWN-006 — Disabled option click is a no-op (no onChange, menu stays)
  // ---------------------------------------------------------------------------
  it('CMP-DROPDOWN-006: disabled option click does NOT call onChange and does not close the menu', () => {
    const onChange = vi.fn();
    render(
      <Harness
        testid="provider-select"
        initial="github"
        onChangeSpy={onChange}
      />,
    );

    fireEvent.click(screen.getByTestId('provider-select-trigger'));
    fireEvent.click(screen.getByTestId('provider-select-option-bitbucket'));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('provider-select-menu')).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // CMP-DROPDOWN-007 — Click outside closes the menu
  // ---------------------------------------------------------------------------
  it('CMP-DROPDOWN-007: clicking outside closes the menu', async () => {
    render(<Harness testid="provider-select" initial="github" />);

    fireEvent.click(screen.getByTestId('provider-select-trigger'));
    expect(screen.getByTestId('provider-select-menu')).toBeInTheDocument();

    // Click on the body (a node outside the dropdown).
    fireEvent.mouseDown(document.body);
    fireEvent.click(document.body);

    await waitFor(() => {
      expect(screen.queryByTestId('provider-select-menu')).not.toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // CMP-DROPDOWN-008 — Escape on the trigger closes the menu
  // ---------------------------------------------------------------------------
  it('CMP-DROPDOWN-008: Escape key on the trigger closes the menu', async () => {
    render(<Harness testid="provider-select" initial="github" />);

    const trigger = screen.getByTestId('provider-select-trigger');
    fireEvent.click(trigger);
    expect(screen.getByTestId('provider-select-menu')).toBeInTheDocument();

    fireEvent.keyDown(trigger, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByTestId('provider-select-menu')).not.toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // CMP-DROPDOWN-009 — ArrowDown on closed trigger opens the menu
  // ---------------------------------------------------------------------------
  it('CMP-DROPDOWN-009: ArrowDown on closed trigger opens the menu', () => {
    render(<Harness testid="provider-select" initial="github" />);

    const trigger = screen.getByTestId('provider-select-trigger');
    expect(screen.queryByTestId('provider-select-menu')).not.toBeInTheDocument();

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });

    expect(screen.getByTestId('provider-select-menu')).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // CMP-DROPDOWN-010 — disabled disables BOTH trigger and hidden select
  // ---------------------------------------------------------------------------
  it('CMP-DROPDOWN-010: disabled prop disables both the trigger and the hidden select', () => {
    render(<Harness testid="provider-select" initial="github" disabled />);

    const trigger = screen.getByTestId('provider-select-trigger') as HTMLButtonElement;
    const select = screen.getByTestId('provider-select') as HTMLSelectElement;

    expect(trigger.disabled).toBe(true);
    expect(select.disabled).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // CMP-DROPDOWN-011 — error prop renders the error message
  // ---------------------------------------------------------------------------
  it('CMP-DROPDOWN-011: error prop renders the error message text in the DOM', () => {
    const { container } = render(
      <Harness
        testid="provider-select"
        initial="github"
        error="Provider is required"
      />,
    );

    // The error message is rendered inside the dropdown's field root
    // (sibling of the .shell wrapper). The harness has nothing else in
    // the DOM that would carry the message — checking the container's
    // textContent is the most stable assertion that doesn't depend on
    // the exact CSS-module class names or DOM nesting depth.
    expect(container.textContent ?? '').toMatch(/provider is required/i);
  });

  // ---------------------------------------------------------------------------
  // CMP-DROPDOWN-012 — Trigger shows placeholder when no option matches value
  // ---------------------------------------------------------------------------
  it('CMP-DROPDOWN-012: trigger shows placeholder when value matches no option', () => {
    render(
      <Harness
        testid="provider-select"
        initial=""
        placeholder="Select a provider…"
      />,
    );

    const trigger = screen.getByTestId('provider-select-trigger');
    expect(trigger.textContent).toMatch(/select a provider/i);
  });
});
