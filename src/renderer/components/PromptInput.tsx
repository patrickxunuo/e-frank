/**
 * `<PromptInput>` — bottom composer for the Execution View.
 *
 * Uncontrolled by design: the parent gives an `initialValue` and an
 * `onSubmit(text)`; the component owns its own draft state and calls
 * `onSubmit` on Send / ⌘+Enter. After a successful submit the input
 * clears.
 *
 * Plain Enter inserts a newline (so users can compose multi-line prompts
 * naturally); ⌘/Ctrl+Enter submits. Send is disabled when empty or
 * `disabled` is set.
 *
 * Shared with #9's Modify flow, which is why we don't bake in any
 * Execution-View-specific copy or icons here.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { Button } from './Button';
import styles from './PromptInput.module.css';

export interface PromptInputProps {
  initialValue?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Resolves true on success (clears input), false on cancel. */
  onSubmit: (text: string) => Promise<boolean> | boolean;
  'data-testid'?: string;
  sendLabel?: string;
}

export interface PromptInputHandle {
  focus(): void;
  setValue(v: string): void;
}

const DEFAULT_PLACEHOLDER = 'Send a message to Claude…';

/**
 * Resize the textarea to fit its content (up to the CSS max-height).
 * Scrolling kicks in beyond ~6 rows via `max-height` in the stylesheet.
 */
function autoResize(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

export const PromptInput = forwardRef<PromptInputHandle, PromptInputProps>(
  function PromptInput(
    {
      initialValue = '',
      placeholder = DEFAULT_PLACEHOLDER,
      disabled = false,
      onSubmit,
      'data-testid': testId,
      sendLabel = 'Send',
    },
    ref,
  ): JSX.Element {
    const [value, setValue] = useState<string>(initialValue);
    const [submitting, setSubmitting] = useState<boolean>(false);
    const taRef = useRef<HTMLTextAreaElement | null>(null);

    useImperativeHandle(
      ref,
      (): PromptInputHandle => ({
        focus: () => taRef.current?.focus(),
        setValue: (v) => setValue(v),
      }),
      [],
    );

    // Re-autosize when the value mutates externally (e.g. setValue or
    // post-submit clear). Local typing also calls autoResize on input.
    useEffect(() => {
      const el = taRef.current;
      if (el) autoResize(el);
    }, [value]);

    const trimmed = value.trim();
    const sendDisabled = disabled || submitting || trimmed.length === 0;

    const submit = useCallback(async (): Promise<void> => {
      if (sendDisabled) return;
      setSubmitting(true);
      try {
        const result = await onSubmit(value);
        if (result) {
          setValue('');
        }
      } catch (err) {
        // Swallow rejections so `void submit()` callers don't see unhandled
        // promise rejections. The caller (ExecutionView, future #9) is
        // expected to surface user-facing errors via inline UI; preserving
        // the input value lets the user retry.

        console.warn('[prompt-input] onSubmit threw:', err);
      } finally {
        setSubmitting(false);
      }
    }, [onSubmit, sendDisabled, value]);

    const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
      if (e.key !== 'Enter') return;
      // ⌘+Enter (mac) or Ctrl+Enter (win/linux) → submit.
      // Plain Enter → newline (default textarea behaviour, don't preventDefault).
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        void submit();
      }
    };

    return (
      <div className={styles.wrap}>
        <div className={styles.row} data-disabled={disabled ? 'true' : 'false'}>
          <textarea
            ref={taRef}
            className={styles.textarea}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onInput={(e) => autoResize(e.currentTarget)}
            placeholder={placeholder}
            disabled={disabled || submitting}
            rows={1}
            spellCheck
            data-testid={testId ?? 'log-prompt-input'}
            aria-label={placeholder}
          />
          <div className={styles.send}>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => {
                void submit();
              }}
              disabled={sendDisabled}
              data-testid="log-send-button"
            >
              {sendLabel}
            </Button>
          </div>
        </div>
        <span className={styles.hint} aria-hidden="true">
          <span className={styles.kbd}>⌘</span>
          <span className={styles.kbd}>Enter</span>
          to send · Enter for new line
        </span>
      </div>
    );
  },
);
