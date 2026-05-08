// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { RunStatus, RunState } from '@shared/ipc';

/**
 * RUN-STATUS-FIGURE — `<RunStatusFigure>` Lottie/static swap (#GH-51).
 *
 * Strategy: stub `lottie-react` at the module level so we don't try to run
 * the real animation in jsdom (it relies on canvas/raf). The stub renders a
 * simple `<div data-testid="lottie-stub" />` so we can assert the component
 * mounted Lottie when it should.
 */

vi.mock('lottie-react', () => ({
  default: () => <div data-testid="lottie-stub" />,
}));

// Importing AFTER the mock so the component picks up the stub.
import { RunStatusFigure } from '../../src/renderer/components/RunStatusFigure';

interface MatchMediaStub {
  matches: boolean;
  listeners: Set<(e: MediaQueryListEvent) => void>;
}

function installMatchMedia(stub: MatchMediaStub): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia =
    () =>
      ({
        matches: stub.matches,
        media: '',
        onchange: null,
        addEventListener: (
          _t: string,
          listener: (e: MediaQueryListEvent) => void,
        ): void => {
          stub.listeners.add(listener);
        },
        removeEventListener: (
          _t: string,
          listener: (e: MediaQueryListEvent) => void,
        ): void => {
          stub.listeners.delete(listener);
        },
        addListener: (
          listener: (e: MediaQueryListEvent) => void,
        ): void => {
          stub.listeners.add(listener);
        },
        removeListener: (
          listener: (e: MediaQueryListEvent) => void,
        ): void => {
          stub.listeners.delete(listener);
        },
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
}

let mediaStub: MatchMediaStub;

beforeEach(() => {
  mediaStub = { matches: false, listeners: new Set() };
  installMatchMedia(mediaStub);
});

afterEach(() => {
  cleanup();
});

const STATE_RUNNING: RunState = 'running';
const STATE_AWAITING: RunState = 'awaitingApproval';
const STATE_DONE: RunState = 'done';
const STATE_FAILED: RunState = 'failed';
const STATE_CANCELLED: RunState = 'cancelled';

function statusFigure(status: RunStatus, state: RunState): JSX.Element {
  return <RunStatusFigure status={status} state={state} />;
}

describe('<RunStatusFigure />', () => {
  it('RUN-STATUS-FIGURE-001: renders the Lottie wrapper while pending', () => {
    render(statusFigure('pending', STATE_RUNNING));
    expect(screen.getByTestId('run-status-figure-lottie')).toBeInTheDocument();
    expect(screen.queryByTestId('run-status-figure-static')).toBeNull();
    expect(screen.getByTestId('run-status-figure')).toHaveAttribute(
      'data-status',
      'pending',
    );
  });

  it('RUN-STATUS-FIGURE-002: renders the Lottie wrapper while running', () => {
    render(statusFigure('running', STATE_RUNNING));
    expect(screen.getByTestId('run-status-figure-lottie')).toBeInTheDocument();
  });

  it('RUN-STATUS-FIGURE-003: keeps the Lottie when state=awaitingApproval (status still running)', () => {
    render(statusFigure('running', STATE_AWAITING));
    expect(screen.getByTestId('run-status-figure-lottie')).toBeInTheDocument();
    expect(screen.getByTestId('run-status-figure')).toHaveAttribute(
      'data-state',
      'awaitingApproval',
    );
  });

  it('RUN-STATUS-FIGURE-004: terminal status=done renders the static glyph', () => {
    render(statusFigure('done', STATE_DONE));
    expect(screen.queryByTestId('run-status-figure-lottie')).toBeNull();
    const statik = screen.getByTestId('run-status-figure-static');
    expect(statik).toBeInTheDocument();
    expect(statik).toHaveAttribute('data-status', 'done');
    // Two polygons (body + shadow).
    expect(statik.querySelectorAll('polygon').length).toBe(2);
  });

  it('RUN-STATUS-FIGURE-005: terminal status=failed tags the static glyph for danger styling', () => {
    render(statusFigure('failed', STATE_FAILED));
    const statik = screen.getByTestId('run-status-figure-static');
    expect(statik).toHaveAttribute('data-status', 'failed');
  });

  it('RUN-STATUS-FIGURE-006: terminal status=cancelled tags the static glyph for muted styling', () => {
    render(statusFigure('cancelled', STATE_CANCELLED));
    const statik = screen.getByTestId('run-status-figure-static');
    expect(statik).toHaveAttribute('data-status', 'cancelled');
  });

  it('RUN-STATUS-FIGURE-007: respects prefers-reduced-motion by rendering static for live runs', () => {
    mediaStub.matches = true;
    render(statusFigure('running', STATE_RUNNING));
    expect(screen.queryByTestId('run-status-figure-lottie')).toBeNull();
    expect(screen.getByTestId('run-status-figure-static')).toBeInTheDocument();
  });

  it('RUN-STATUS-FIGURE-008: applies an inline size of 60px by default', () => {
    render(statusFigure('done', STATE_DONE));
    const root = screen.getByTestId('run-status-figure');
    expect(root.style.width).toBe('60px');
    expect(root.style.height).toBe('60px');
  });
});
