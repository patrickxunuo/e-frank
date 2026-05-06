// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { PromptInput } from '../../src/renderer/components/PromptInput';

/**
 * CMP-PROMPT-001..007 — <PromptInput> component.
 *
 * Stable testids the component must expose (per spec):
 *   - `log-prompt-input` — the textarea
 *   - `log-send-button`  — the Send button
 *
 * Behavior:
 *   - Plain Enter inserts newline (does NOT submit)
 *   - Cmd+Enter (mac) and Ctrl+Enter (windows) submit
 *   - Empty text disables Send
 *   - `disabled` prop disables both textarea and button
 *   - Successful submit clears the input
 *   - `initialValue` populates the input on mount
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('<PromptInput /> — CMP-PROMPT', () => {
  // -------------------------------------------------------------------------
  // CMP-PROMPT-001 — Submit on Send button click
  // -------------------------------------------------------------------------
  it('CMP-PROMPT-001: clicking Send calls onSubmit with the current text', async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(<PromptInput onSubmit={onSubmit} />);

    const textarea = screen.getByTestId('log-prompt-input') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'hello there' } });
    fireEvent.click(screen.getByTestId('log-send-button'));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit).toHaveBeenCalledWith('hello there');
  });

  // -------------------------------------------------------------------------
  // CMP-PROMPT-002 — Cmd/Ctrl+Enter submits
  // -------------------------------------------------------------------------
  it('CMP-PROMPT-002a: Cmd+Enter (mac) submits the prompt', async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(<PromptInput onSubmit={onSubmit} />);

    const textarea = screen.getByTestId('log-prompt-input') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'mac submit' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit).toHaveBeenCalledWith('mac submit');
  });

  it('CMP-PROMPT-002b: Ctrl+Enter (windows/linux) submits the prompt', async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(<PromptInput onSubmit={onSubmit} />);

    const textarea = screen.getByTestId('log-prompt-input') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'win submit' } });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit).toHaveBeenCalledWith('win submit');
  });

  // -------------------------------------------------------------------------
  // CMP-PROMPT-003 — Plain Enter inserts newline (does NOT submit)
  // -------------------------------------------------------------------------
  it('CMP-PROMPT-003: plain Enter does NOT call onSubmit', async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(<PromptInput onSubmit={onSubmit} />);

    const textarea = screen.getByTestId('log-prompt-input') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'line1' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    // Wait a tick to make sure no microtask submit fires.
    await new Promise((r) => setTimeout(r, 10));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // CMP-PROMPT-004 — Empty text → Send disabled; submit not called
  // -------------------------------------------------------------------------
  it('CMP-PROMPT-004: empty text → Send button disabled; click is a no-op', () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(<PromptInput onSubmit={onSubmit} />);

    const send = screen.getByTestId('log-send-button') as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    // Click anyway — should be a no-op.
    fireEvent.click(send);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('CMP-PROMPT-004 (whitespace): only-whitespace text keeps Send disabled', () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(<PromptInput onSubmit={onSubmit} />);

    const textarea = screen.getByTestId('log-prompt-input') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '    \n  \t' } });

    const send = screen.getByTestId('log-send-button') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });

  // -------------------------------------------------------------------------
  // CMP-PROMPT-005 — Disabled prop disables both textarea and button
  // -------------------------------------------------------------------------
  it('CMP-PROMPT-005: disabled prop disables BOTH textarea and Send button', () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(
      <PromptInput
        onSubmit={onSubmit}
        disabled
        initialValue="hello there"
      />,
    );

    const textarea = screen.getByTestId('log-prompt-input') as HTMLTextAreaElement;
    const send = screen.getByTestId('log-send-button') as HTMLButtonElement;
    expect(textarea.disabled).toBe(true);
    expect(send.disabled).toBe(true);

    // Cmd+Enter is also a no-op when disabled.
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // CMP-PROMPT-006 — After successful submit, input is cleared
  // -------------------------------------------------------------------------
  it('CMP-PROMPT-006: after onSubmit resolves true the textarea value is cleared', async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(<PromptInput onSubmit={onSubmit} />);

    const textarea = screen.getByTestId('log-prompt-input') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'submit me' } });
    fireEvent.click(screen.getByTestId('log-send-button'));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalled();
    });

    await waitFor(() => {
      const live = screen.getByTestId('log-prompt-input') as HTMLTextAreaElement;
      expect(live.value).toBe('');
    });
  });

  it('CMP-PROMPT-006 (cancel): when onSubmit resolves false the textarea is NOT cleared', async () => {
    const onSubmit = vi.fn().mockResolvedValue(false);
    render(<PromptInput onSubmit={onSubmit} />);

    const textarea = screen.getByTestId('log-prompt-input') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'keep me' } });
    fireEvent.click(screen.getByTestId('log-send-button'));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalled();
    });

    // Wait briefly to make sure no async clear lands.
    await new Promise((r) => setTimeout(r, 20));
    const live = screen.getByTestId('log-prompt-input') as HTMLTextAreaElement;
    expect(live.value).toBe('keep me');
  });

  // -------------------------------------------------------------------------
  // CMP-PROMPT-007 — initialValue populates the input on mount
  // -------------------------------------------------------------------------
  it('CMP-PROMPT-007: initialValue is reflected in the textarea on mount', () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(<PromptInput initialValue="prefilled" onSubmit={onSubmit} />);

    const textarea = screen.getByTestId('log-prompt-input') as HTMLTextAreaElement;
    expect(textarea.value).toBe('prefilled');

    // And Send is enabled because the text is non-empty.
    const send = screen.getByTestId('log-send-button') as HTMLButtonElement;
    expect(send.disabled).toBe(false);
  });
});
