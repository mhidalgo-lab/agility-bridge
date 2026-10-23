// SPDX-License-Identifier: Apache-2.0
// Colour contrast of the stylesheet's design tokens (P4-03, WCAG 2.1 AA). jsdom has no layout or cascade, so a browser
// based audit cannot compute it; the pages use only these tokens, so checking the token pairs covers every page.
import { describe, expect, it } from 'vitest';
import { ASSETS } from '../src/assets.ts';

// The embedded stylesheet is what is served (the generator's tests check it against assets/admin.css).
const css = ASSETS.css.body;

function tokens(block: string): Record<string, string> {
  return Object.fromEntries(
    [...block.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2]]),
  );
}

const lightBlock = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
const darkBlock = /prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
const light = tokens(lightBlock);
const dark = { ...light, ...tokens(darkBlock) };

function luminance(hex: string): number {
  const channel = (i: number) => {
    const v = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Text on its background: 4.5:1. */
const TEXT: Array<[string, string]> = [
  ['fg', 'bg'],
  ['fg', 'surface'],
  ['muted', 'bg'],
  ['muted', 'surface'],
  ['accent', 'bg'],
  ['accent', 'surface'],
  ['accent-fg', 'accent'],
  ['danger', 'bg'],
  ['danger', 'surface'],
  ['danger-fg', 'danger'],
  ['ok-fg', 'ok-bg'],
  ['info-fg', 'info-bg'],
  ['error-fg', 'error-bg'],
];
/** Borders of controls and the focus ring on the page background: 3:1. */
const NON_TEXT: Array<[string, string]> = [
  ['border', 'bg'],
  ['focus', 'bg'],
  ['focus', 'surface'],
];

describe.each([
  ['light', light],
  ['dark', dark],
] as const)('%s theme', (_name, theme) => {
  it('defines every token the pairs use', () => {
    for (const [a, b] of [...TEXT, ...NON_TEXT]) {
      expect(theme[a], a).toMatch(/^#[0-9a-f]{6}$/i);
      expect(theme[b], b).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it.each(TEXT)('text %s on %s is at least 4.5:1', (a, b) => {
    expect(ratio(theme[a] as string, theme[b] as string)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(NON_TEXT)('%s against %s is at least 3:1', (a, b) => {
    expect(ratio(theme[a] as string, theme[b] as string)).toBeGreaterThanOrEqual(3);
  });
});

describe('the stylesheet', () => {
  it('works at 320 px: pages never force sideways scrolling, tables scroll inside their wrapper', () => {
    expect(css).toMatch(/\.table-wrap\s*\{[^}]*overflow-x:\s*auto/);
    expect(css).toMatch(/overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/max-width:\s*64rem/);
    expect(css).not.toMatch(/min-width:\s*(?:[4-9]\d\d|\d{4,})px/);
    expect(css).toContain('box-sizing: border-box');
  });

  it('keeps 44 px targets, visible focus and reduced motion', () => {
    expect(css).toMatch(/min-height:\s*44px/);
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*3px/);
    expect(css).toContain('prefers-reduced-motion: reduce');
  });

  it('has no external resource and no script-bearing URL', () => {
    expect(css).not.toMatch(/@import|url\(\s*['"]?(?:https?:|data:|javascript:)/i);
  });
});
