// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ExecutionLog } from '../../src/renderer/components/ExecutionLog';
import type { RunLogEntry, RunState, RunStatus } from '../../src/shared/schema/run';

/**
 * CMP-EXEC-LOG-001..006 — <ExecutionLog> component.
 *
 * Spec snippet:
 *   interface ExecutionLogProps {
 *     steps: ExecLogStep[];
 *     autoScroll: boolean;
 *     expandIndex: number;
 *     'data-testid'?: string;
 *   }
 *
 * `ExecLogStep` (from `src/renderer/state/run-log.ts`):
 *   { state: RunState; label: string | null; status: RunStatus;
 *     startedAt?: number; finishedAt?: number; lines: RunLogEntry[]; }
 *
 * Stable testids the component must expose (per spec):
 *   - `log-step-{index}` on each row
 *   - `log-step-{index}-toggle` on the collapse button
 *   - `log-step-{index}-body` on the content
 */

interface ExecLogStep {
  state: RunState;
  label: string | null;
  status: RunStatus;
  startedAt?: number;
  finishedAt?: number;
  lines: RunLogEntry[];
}

function makeLine(over: Partial<RunLogEntry> = {}): RunLogEntry {
  return {
    runId: 'r-1',
    stream: 'stdout',
    line: 'a line',
    timestamp: 1,
    state: 'running',
    ...over,
  };
}

function makeStep(over: Partial<ExecLogStep> = {}): ExecLogStep {
  return {
    state: 'running',
    label: 'Implementing feature',
    status: 'running',
    startedAt: 1,
    lines: [],
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('<ExecutionLog /> — CMP-EXEC-LOG', () => {
  // -------------------------------------------------------------------------
  // CMP-EXEC-LOG-001 — Step row renders with status icon and label
  // -------------------------------------------------------------------------
  it('CMP-EXEC-LOG-001: each step renders with status indicator + visible label', () => {
    const steps: ExecLogStep[] = [
      makeStep({ state: 'preparing', label: 'Preparing repo', status: 'done' }),
      makeStep({
        state: 'running',
        label: 'Implementing feature',
        status: 'running',
      }),
    ];

    render(
      <ExecutionLog
        steps={steps}
        autoScroll={true}
        expandIndex={1}
        data-testid="log"
      />,
    );

    const row0 = screen.getByTestId('log-step-0');
    const row1 = screen.getByTestId('log-step-1');
    expect(row0).toHaveTextContent(/preparing repo/i);
    expect(row1).toHaveTextContent(/implementing feature/i);

    // Status encoding must be queryable (spec mandates a status icon per row).
    // We accept either an explicit data-status attribute on the row OR a
    // descendant element carrying it.
    const row0Status =
      row0.getAttribute('data-status') ??
      row0.querySelector('[data-status]')?.getAttribute('data-status');
    const row1Status =
      row1.getAttribute('data-status') ??
      row1.querySelector('[data-status]')?.getAttribute('data-status');
    expect(row0Status).toBe('done');
    expect(row1Status).toBe('running');
  });

  // -------------------------------------------------------------------------
  // CMP-EXEC-LOG-002 — Body collapsed by default for completed steps;
  // expanded for current
  // -------------------------------------------------------------------------
  it('CMP-EXEC-LOG-002: completed step body hidden by default; expandIndex step body visible', () => {
    const steps: ExecLogStep[] = [
      makeStep({
        state: 'preparing',
        label: 'Preparing repo',
        status: 'done',
        lines: [makeLine({ line: 'older-completed-line' })],
      }),
      makeStep({
        state: 'running',
        label: 'Implementing feature',
        status: 'running',
        lines: [makeLine({ line: 'current-running-line' })],
      }),
    ];

    render(
      <ExecutionLog
        steps={steps}
        autoScroll={true}
        expandIndex={1}
        data-testid="log"
      />,
    );

    // Completed step body — must NOT be visible. Either it's not in the DOM
    // at all, or it's hidden via [hidden] / aria-hidden / display:none.
    const completedBody = screen.queryByTestId('log-step-0-body');
    if (completedBody !== null) {
      // Visible-to-user check — jsdom doesn't compute layout, so we read the
      // hidden attribute / aria-hidden / inline style.
      const hidden =
        completedBody.hasAttribute('hidden') ||
        completedBody.getAttribute('aria-hidden') === 'true' ||
        /display:\s*none/i.test(completedBody.getAttribute('style') ?? '');
      expect(hidden).toBe(true);
    }

    // Current (expanded) body — visible AND contains the running line.
    const currentBody = screen.getByTestId('log-step-1-body');
    expect(currentBody).toBeInTheDocument();
    expect(currentBody.hasAttribute('hidden')).toBe(false);
    expect(currentBody).toHaveTextContent(/current-running-line/);
  });

  // -------------------------------------------------------------------------
  // CMP-EXEC-LOG-003 — Toggle button collapses/expands the body
  // -------------------------------------------------------------------------
  it('CMP-EXEC-LOG-003: clicking the toggle expands a previously collapsed step', async () => {
    const steps: ExecLogStep[] = [
      makeStep({
        state: 'preparing',
        label: 'Preparing repo',
        status: 'done',
        lines: [makeLine({ line: 'collapsed-content' })],
      }),
      makeStep({
        state: 'running',
        label: 'Implementing feature',
        status: 'running',
        lines: [],
      }),
    ];

    render(
      <ExecutionLog
        steps={steps}
        autoScroll={true}
        expandIndex={1}
        data-testid="log"
      />,
    );

    const toggle = screen.getByTestId('log-step-0-toggle');
    fireEvent.click(toggle);

    await waitFor(() => {
      const body = screen.getByTestId('log-step-0-body');
      // After expanding, the body is no longer hidden.
      expect(body.hasAttribute('hidden')).toBe(false);
      expect(body).toHaveTextContent(/collapsed-content/);
    });

    // Click again → collapse.
    fireEvent.click(toggle);
    await waitFor(() => {
      const body = screen.queryByTestId('log-step-0-body');
      const hidden =
        body === null ||
        body.hasAttribute('hidden') ||
        body.getAttribute('aria-hidden') === 'true' ||
        /display:\s*none/i.test(body.getAttribute('style') ?? '');
      expect(hidden).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // CMP-EXEC-LOG-004 — Lines render with stream tag (stdout/stderr)
  // -------------------------------------------------------------------------
  it('CMP-EXEC-LOG-004: each line tags its stream (stdout / stderr) in a queryable way', () => {
    const steps: ExecLogStep[] = [
      makeStep({
        state: 'running',
        label: 'Implementing feature',
        status: 'running',
        lines: [
          makeLine({ line: 'normal stdout', stream: 'stdout' }),
          makeLine({ line: 'oh no stderr', stream: 'stderr' }),
        ],
      }),
    ];

    render(
      <ExecutionLog
        steps={steps}
        autoScroll={true}
        expandIndex={0}
        data-testid="log"
      />,
    );

    const body = screen.getByTestId('log-step-0-body');

    // Either the line element has data-stream OR text content includes
    // stdout/stderr (both are reasonable encodings — accept either).
    const streamNodes = Array.from(body.querySelectorAll<HTMLElement>('[data-stream]'));
    if (streamNodes.length > 0) {
      const streams = streamNodes.map((n) => n.getAttribute('data-stream'));
      expect(streams).toContain('stdout');
      expect(streams).toContain('stderr');
    } else {
      // Fallback — text-based stream tag.
      expect(body.textContent ?? '').toMatch(/stdout/i);
      expect(body.textContent ?? '').toMatch(/stderr/i);
    }

    // The actual line text must render regardless.
    expect(body).toHaveTextContent(/normal stdout/);
    expect(body).toHaveTextContent(/oh no stderr/);
  });

  // -------------------------------------------------------------------------
  // CMP-EXEC-LOG-005 — ANSI escapes stripped in rendered output
  // -------------------------------------------------------------------------
  it('CMP-EXEC-LOG-005: input with `\\x1b[31m...\\x1b[0m` renders without escape sequences', () => {
    const steps: ExecLogStep[] = [
      makeStep({
        state: 'running',
        label: 'Implementing feature',
        status: 'running',
        lines: [makeLine({ line: '\x1b[31mERROR\x1b[0m: oops' })],
      }),
    ];

    render(
      <ExecutionLog
        steps={steps}
        autoScroll={true}
        expandIndex={0}
        data-testid="log"
      />,
    );

    const body = screen.getByTestId('log-step-0-body');
    const text = body.textContent ?? '';
    // The escape character must NOT appear anywhere in the rendered text.
    expect(text).not.toContain('\x1b');
    expect(text).not.toMatch(/\[31m/);
    expect(text).not.toMatch(/\[0m/);
    // The visible message survives.
    expect(text).toMatch(/ERROR/);
    expect(text).toMatch(/oops/);
  });

  // -------------------------------------------------------------------------
  // CMP-EXEC-LOG-006 — Auto-scroll: when at bottom, scrollTop is set to scrollHeight
  // -------------------------------------------------------------------------
  it('CMP-EXEC-LOG-006: autoScroll=true → scrollTop is updated when new content lands', async () => {
    // Start with one line at the bottom (user is at bottom).
    const initialSteps: ExecLogStep[] = [
      makeStep({
        state: 'running',
        label: 'Implementing feature',
        status: 'running',
        lines: [makeLine({ line: 'first' })],
      }),
    ];

    const { rerender, container } = render(
      <ExecutionLog
        steps={initialSteps}
        autoScroll={true}
        expandIndex={0}
        data-testid="log"
      />,
    );

    // jsdom doesn't compute layout, so manually patch scrollHeight on the
    // log element so the auto-scroll math has something to read.
    const root = screen.getByTestId('log');
    // The scroll target is most likely either the root or a viewport child.
    // We patch BOTH so whichever the component uses, the assertion can fire.
    const scrollTargets = [
      root,
      ...Array.from(container.querySelectorAll<HTMLElement>('*')),
    ];
    for (const el of scrollTargets) {
      Object.defineProperty(el, 'scrollHeight', {
        configurable: true,
        get: () => 1000,
      });
      Object.defineProperty(el, 'clientHeight', {
        configurable: true,
        get: () => 200,
      });
      // Initialize scrollTop so we can detect change.
      try {
        el.scrollTop = 0;
      } catch {
        /* noop in jsdom for some elements */
      }
    }

    // Add a new line and rerender — auto-scroll should bump scrollTop.
    const updatedSteps: ExecLogStep[] = [
      makeStep({
        state: 'running',
        label: 'Implementing feature',
        status: 'running',
        lines: [makeLine({ line: 'first' }), makeLine({ line: 'second' })],
      }),
    ];

    rerender(
      <ExecutionLog
        steps={updatedSteps}
        autoScroll={true}
        expandIndex={0}
        data-testid="log"
      />,
    );

    // After the rerender, at least one scrollable element should have
    // scrollTop bumped to the patched scrollHeight (auto-scroll-to-bottom
    // behavior). We tolerate a few different implementation strategies:
    //   - assigning scrollTop = scrollHeight
    //   - calling scrollIntoView on a sentinel element
    //
    // We assert the EITHER condition.
    const scrolledToBottom = scrollTargets.some(
      (el) => (el as HTMLElement).scrollTop > 0,
    );
    const sentinelScrolled = Array.from(
      container.querySelectorAll<HTMLElement>('*'),
    ).some((el) => {
      // Some libs add a `data-log-end="true"` sentinel; we don't depend on
      // a specific testid here. The presence of `scrollIntoView` having been
      // called is harder to detect retroactively without spying — fall back
      // to checking scrollTop on any descendant.
      return (el as HTMLElement).scrollTop > 0;
    });

    expect(scrolledToBottom || sentinelScrolled).toBe(true);
  });

  // -------------------------------------------------------------------------
  // GH-52 #7 — auto-scroll follows active phase accordion
  // -------------------------------------------------------------------------
  it('CMP-EXEC-LOG-AUTO-FOLLOW: when expandIndex advances, the previously-active step collapses (auto-scroll on)', () => {
    const initial: ExecLogStep[] = [
      makeStep({
        state: 'planning',
        label: 'Planning',
        status: 'running',
        lines: [makeLine({ state: 'planning', line: 'planning-line-1' })],
      }),
    ];
    const { rerender } = render(
      <ExecutionLog
        steps={initial}
        autoScroll={true}
        expandIndex={0}
        data-testid="log"
      />,
    );

    // Active step (index 0) is open by default.
    expect(screen.queryByTestId('log-step-0-body')).not.toBeNull();

    // Advance: planning closes, implementing opens.
    const advanced: ExecLogStep[] = [
      makeStep({
        state: 'planning',
        label: 'Planning',
        status: 'done',
        lines: [makeLine({ state: 'planning', line: 'planning-line-1' })],
      }),
      makeStep({
        state: 'implementing',
        label: 'Implementing feature',
        status: 'running',
        lines: [
          makeLine({ state: 'implementing', line: 'implementing-line-1' }),
        ],
      }),
    ];
    rerender(
      <ExecutionLog
        steps={advanced}
        autoScroll={true}
        expandIndex={1}
        data-testid="log"
      />,
    );

    // The previously-active step (index 0) auto-collapses; the new
    // active step (index 1) auto-expands.
    expect(screen.queryByTestId('log-step-0-body')).toBeNull();
    expect(screen.queryByTestId('log-step-1-body')).not.toBeNull();
  });

  it('CMP-EXEC-LOG-USER-OPEN: a user-opened step is NOT collapsed when expandIndex advances', () => {
    const initial: ExecLogStep[] = [
      makeStep({
        state: 'planning',
        label: 'Planning',
        status: 'running',
        lines: [makeLine({ state: 'planning', line: 'planning-line-1' })],
      }),
    ];
    const { rerender } = render(
      <ExecutionLog
        steps={initial}
        autoScroll={true}
        expandIndex={0}
        data-testid="log"
      />,
    );

    // User clicks the toggle — twice (open/close/open) so the row ends
    // up open AND in the user-opened set. We assert the auto-managed
    // attribute flips to 'false' as a side-channel signal that the
    // component recorded the manual intent.
    const toggle = screen.getByTestId('log-step-0-toggle');
    fireEvent.click(toggle); // close
    fireEvent.click(toggle); // re-open (now user-opened)

    const row0 = screen.getByTestId('log-step-0');
    expect(row0.getAttribute('data-auto-managed')).toBe('false');

    // Now advance the timeline. The new step opens, but step 0 stays
    // open because the user has expressed intent.
    const advanced: ExecLogStep[] = [
      makeStep({
        state: 'planning',
        label: 'Planning',
        status: 'done',
        lines: [makeLine({ state: 'planning', line: 'planning-line-1' })],
      }),
      makeStep({
        state: 'implementing',
        label: 'Implementing feature',
        status: 'running',
        lines: [
          makeLine({ state: 'implementing', line: 'implementing-line-1' }),
        ],
      }),
    ];
    rerender(
      <ExecutionLog
        steps={advanced}
        autoScroll={true}
        expandIndex={1}
        data-testid="log"
      />,
    );

    // User-opened step 0 stays open; new step 1 also opens.
    expect(screen.queryByTestId('log-step-0-body')).not.toBeNull();
    expect(screen.queryByTestId('log-step-1-body')).not.toBeNull();
  });

  it('CMP-EXEC-LOG-AUTO-OFF: when autoScroll is false, advancing expandIndex does NOT collapse the prior step', () => {
    const initial: ExecLogStep[] = [
      makeStep({
        state: 'planning',
        label: 'Planning',
        status: 'running',
        lines: [makeLine({ state: 'planning', line: 'planning-line-1' })],
      }),
    ];
    const { rerender } = render(
      <ExecutionLog
        steps={initial}
        autoScroll={false}
        expandIndex={0}
        data-testid="log"
      />,
    );
    expect(screen.queryByTestId('log-step-0-body')).not.toBeNull();

    const advanced: ExecLogStep[] = [
      makeStep({
        state: 'planning',
        label: 'Planning',
        status: 'done',
        lines: [makeLine({ state: 'planning', line: 'planning-line-1' })],
      }),
      makeStep({
        state: 'implementing',
        label: 'Implementing feature',
        status: 'running',
        lines: [
          makeLine({ state: 'implementing', line: 'implementing-line-1' }),
        ],
      }),
    ];
    rerender(
      <ExecutionLog
        steps={advanced}
        autoScroll={false}
        expandIndex={1}
        data-testid="log"
      />,
    );
    // With auto-scroll OFF we don't auto-collapse the previously-active
    // step. (Auto-expand of the new step still fires — the user just
    // doesn't get the collapse half of the follow behavior.)
    expect(screen.queryByTestId('log-step-0-body')).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // GH-57 #4d — scroll-to-bottom FAB
  // -------------------------------------------------------------------------
  it('CMP-EXEC-LOG-FAB-001: FAB is hidden when user is at the bottom', () => {
    const steps: ExecLogStep[] = [
      makeStep({
        state: 'running',
        label: 'Implementing feature',
        status: 'running',
        lines: [makeLine({ line: 'tail-line' })],
      }),
    ];
    render(
      <ExecutionLog
        steps={steps}
        autoScroll={true}
        expandIndex={0}
        data-testid="log"
      />,
    );
    const fab = screen.getByTestId('log-scroll-to-bottom');
    // The button stays in the DOM (so the fade-in animation is purely
    // CSS-driven) but `data-visible` reports hidden when at-bottom.
    expect(fab.getAttribute('data-visible')).toBe('false');
  });

  it('CMP-EXEC-LOG-FAB-002: scrolling far up surfaces the FAB', () => {
    const steps: ExecLogStep[] = [
      makeStep({
        state: 'running',
        label: 'Implementing feature',
        status: 'running',
        lines: [makeLine({ line: 'tail-line' })],
      }),
    ];
    render(
      <ExecutionLog
        steps={steps}
        autoScroll={false}
        expandIndex={0}
        data-testid="log"
      />,
    );
    const fab = screen.getByTestId('log-scroll-to-bottom');
    const scroll = screen.getByTestId('log');
    // Patch the scroll metrics so the component computes "user is 800px
    // above the bottom" — well past the FAB_VISIBILITY_THRESHOLD of 100.
    Object.defineProperty(scroll, 'scrollHeight', {
      configurable: true,
      get: () => 2000,
    });
    Object.defineProperty(scroll, 'clientHeight', {
      configurable: true,
      get: () => 400,
    });
    try {
      (scroll as HTMLElement).scrollTop = 800;
    } catch {
      /* jsdom quirk */
    }
    fireEvent.scroll(scroll);
    expect(fab.getAttribute('data-visible')).toBe('true');
  });

  it('CMP-EXEC-LOG-FAB-003: clicking the FAB re-engages auto-follow and hides itself', async () => {
    const steps: ExecLogStep[] = [
      makeStep({
        state: 'running',
        label: 'Implementing feature',
        status: 'running',
        lines: [makeLine({ line: 'tail-line' })],
      }),
    ];
    render(
      <ExecutionLog
        steps={steps}
        autoScroll={false}
        expandIndex={0}
        data-testid="log"
      />,
    );
    const fab = screen.getByTestId('log-scroll-to-bottom');
    const scroll = screen.getByTestId('log');
    Object.defineProperty(scroll, 'scrollHeight', {
      configurable: true,
      get: () => 2000,
    });
    Object.defineProperty(scroll, 'clientHeight', {
      configurable: true,
      get: () => 400,
    });
    try {
      (scroll as HTMLElement).scrollTop = 800;
    } catch {
      /* jsdom quirk */
    }
    // Stub scrollTo so jsdom (which lacks smooth-scroll) doesn't reject
    // the call and so we can assert it was invoked.
    const scrollToSpy = vi.fn();
    (scroll as unknown as { scrollTo: typeof scrollToSpy }).scrollTo = scrollToSpy;
    fireEvent.scroll(scroll);
    expect(fab.getAttribute('data-visible')).toBe('true');

    fireEvent.click(fab);
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 2000, behavior: 'smooth' });
    await waitFor(() => {
      expect(fab.getAttribute('data-visible')).toBe('false');
    });
  });
});
