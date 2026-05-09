// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Sidebar } from '../../src/renderer/components/Sidebar';

/**
 * SIDEBAR-LOCKUP — `<Sidebar>` brand mark wiring (#GH-51).
 *
 * After the rebrand the sidebar renders the inline paperplane horizontal
 * lockup as a single SVG (glyph + lowercase wordmark) instead of the prior
 * IconLogo + text pair. Theme switches must propagate automatically because
 * the wordmark uses `currentColor` against a CSS variable in module CSS.
 */

afterEach(() => {
  cleanup();
});

describe('<Sidebar /> paperplane lockup', () => {
  it('SIDEBAR-LOCKUP-001: renders a single lockup SVG with data-testid="app-logo"', () => {
    render(<Sidebar activeNav="projects" />);
    const logo = screen.getByTestId('app-logo');
    expect(logo.tagName.toLowerCase()).toBe('svg');
    expect(logo).toHaveAttribute('aria-label', 'paperplane');
    // The lockup contains the lowercase wordmark inside an SVG <text>.
    expect(logo.textContent).toMatch(/paperplane/);
    // No legacy `IconLogo` rect markers remain.
    expect(logo.querySelector('rect')).toBeNull();
    // Two-tone polygons (glyph) must be present.
    expect(logo.querySelectorAll('polygon').length).toBe(2);
  });

  it('SIDEBAR-LOCKUP-002: drops the legacy `sidebar-product-name` element', () => {
    render(<Sidebar activeNav="projects" />);
    expect(screen.queryByTestId('sidebar-product-name')).toBeNull();
  });

  it('SIDEBAR-LOCKUP-003: keeps the "Ticket → PR" tag below the lockup', () => {
    render(<Sidebar activeNav="projects" />);
    expect(screen.getByText(/Ticket → PR/)).toBeInTheDocument();
  });
});
