// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {
  PAPERPLANE_BODY_POINTS,
  PAPERPLANE_SHADOW_POINTS,
  PaperplaneGlyph,
} from '../../src/renderer/components/PaperplaneGlyph';

/**
 * PAPERPLANE-GLYPH — drift guard between the runtime glyph component and
 * the design-source SVG (#GH-51). The component is the single source of
 * truth for the paperplane silhouette across the Sidebar, Titlebar,
 * IconLogo, and RunStatusFigure call sites — so it must stay aligned with
 * `design/logo/paperplane-icon.svg`. If a designer tweaks the silhouette,
 * this test fails until the component coordinates are updated to match
 * (and vice versa).
 */

afterEach(() => {
  cleanup();
});

function readDesignSvg(): string {
  return readFileSync(
    resolve(__dirname, '../../design/logo/paperplane-icon.svg'),
    'utf8',
  );
}

describe('<PaperplaneGlyph /> drift guard', () => {
  it('PG-001: design SVG body coordinates match runtime constant', () => {
    const svg = readDesignSvg();
    expect(svg).toContain(PAPERPLANE_BODY_POINTS);
  });

  it('PG-002: design SVG shadow coordinates match runtime constant', () => {
    const svg = readDesignSvg();
    expect(svg).toContain(PAPERPLANE_SHADOW_POINTS);
  });

  it('PG-003: renders shadow then body so the lit face paints over the fold', () => {
    const { container } = render(
      <svg>
        <PaperplaneGlyph />
      </svg>,
    );
    const polygons = container.querySelectorAll('polygon');
    expect(polygons.length).toBe(2);
    expect(polygons[0]?.getAttribute('points')).toBe(PAPERPLANE_SHADOW_POINTS);
    expect(polygons[1]?.getAttribute('points')).toBe(PAPERPLANE_BODY_POINTS);
  });

  it('PG-004: forwards bodyClassName and shadowClassName to their polygons', () => {
    const { container } = render(
      <svg>
        <PaperplaneGlyph bodyClassName="my-body" shadowClassName="my-shadow" />
      </svg>,
    );
    const polygons = container.querySelectorAll('polygon');
    expect(polygons[0]?.getAttribute('class')).toBe('my-shadow');
    expect(polygons[1]?.getAttribute('class')).toBe('my-body');
  });

  it('PG-005: brand colors default to #5b8dff (body) + #2c4a99 (shadow)', () => {
    const { container } = render(
      <svg>
        <PaperplaneGlyph />
      </svg>,
    );
    const polygons = container.querySelectorAll('polygon');
    expect(polygons[0]?.getAttribute('fill')).toBe('#2c4a99');
    expect(polygons[1]?.getAttribute('fill')).toBe('#5b8dff');
  });
});
