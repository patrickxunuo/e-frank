// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { RadioCardGroup } from '../../src/renderer/components/RadioCardGroup';

afterEach(() => {
  cleanup();
});

const OPTIONS = [
  {
    value: 'interactive',
    title: 'Interactive',
    description: 'Pause at every checkpoint.',
    icon: <span data-testid="icon-interactive" />,
  },
  {
    value: 'yolo',
    title: 'YOLO',
    description: 'Auto-approve everything.',
    icon: <span data-testid="icon-yolo" />,
  },
] as const;

function Harness({
  initial = 'interactive',
}: {
  initial?: 'interactive' | 'yolo';
}): JSX.Element {
  const [value, setValue] = useState<'interactive' | 'yolo'>(initial);
  return (
    <RadioCardGroup<'interactive' | 'yolo'>
      label="Workflow Mode"
      required
      value={value}
      onChange={setValue}
      options={OPTIONS.map((o) => ({ ...o }))}
      name="workflowMode"
      data-testid="rcg"
    />
  );
}

describe('<RadioCardGroup />', () => {
  it('RCG-001: renders a radio-group with one card per option', () => {
    render(<Harness />);
    const group = screen.getByRole('radiogroup');
    expect(group).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByText('Interactive')).toBeInTheDocument();
    expect(screen.getByText('YOLO')).toBeInTheDocument();
  });

  it('RCG-002: aria-checked + tabIndex track the selected value', () => {
    render(<Harness initial="interactive" />);
    const radios = screen.getAllByRole('radio');
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    expect(radios[0]).toHaveAttribute('tabindex', '0');
    expect(radios[1]).toHaveAttribute('aria-checked', 'false');
    expect(radios[1]).toHaveAttribute('tabindex', '-1');
  });

  it('RCG-003: clicking a card invokes onChange with that card value', () => {
    const onChange = vi.fn();
    render(
      <RadioCardGroup<'interactive' | 'yolo'>
        value="interactive"
        onChange={onChange}
        options={OPTIONS.map((o) => ({ ...o }))}
        data-testid="rcg"
      />,
    );
    fireEvent.click(screen.getByTestId('rcg-option-yolo'));
    expect(onChange).toHaveBeenCalledWith('yolo');
  });

  it('RCG-004: ArrowRight cycles to the next card and updates the value', () => {
    render(<Harness initial="interactive" />);
    const first = screen.getByTestId('rcg-option-interactive') as HTMLButtonElement;
    first.focus();
    act(() => {
      fireEvent.keyDown(first, { key: 'ArrowRight' });
    });
    expect(screen.getByTestId('rcg-option-yolo')).toHaveAttribute('aria-checked', 'true');
  });

  it('RCG-005: ArrowLeft from the first card wraps to the last', () => {
    render(<Harness initial="interactive" />);
    const first = screen.getByTestId('rcg-option-interactive') as HTMLButtonElement;
    first.focus();
    act(() => {
      fireEvent.keyDown(first, { key: 'ArrowLeft' });
    });
    expect(screen.getByTestId('rcg-option-yolo')).toHaveAttribute('aria-checked', 'true');
  });

  it('RCG-006: emits a hidden input matching `name` so form submission picks it up', () => {
    const { container } = render(<Harness initial="yolo" />);
    const hidden = container.querySelector<HTMLInputElement>('input[type="hidden"][name="workflowMode"]');
    expect(hidden).not.toBeNull();
    expect(hidden?.value).toBe('yolo');
  });
});
