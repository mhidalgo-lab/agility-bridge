// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { cleanText, htmlToText, richText, utcIso } from '../../src/index.ts';
import { BOM, LRI, LS, NUL, RLO, ZWSP } from '../helpers/chars.ts';

describe('htmlToText', () => {
  it('drops scripts, styles, comments, embedded objects and every attribute', () => {
    const html =
      '<p onclick="steal()">Hello <b>team</b></p><script>alert(1)</script><style>p{color:red}</style>' +
      '<!-- hidden instructions --><iframe src="https://evil.example"></iframe><svg><script>x()</script></svg>' +
      '<img src="x" onerror="alert(1)" alt="diagram">';
    const out = htmlToText(html);
    expect(out).toBe('Hello **team**\n\n[image: diagram]');
    expect(out).not.toMatch(/alert|steal|color|hidden|evil|onerror/);
  });

  it('keeps http(s) and mailto links and drops javascript: and data: links', () => {
    expect(htmlToText('<a href="https://agility.example.com/x?a=1&amp;b=2">spec</a>')).toBe(
      '[spec](https://agility.example.com/x?a=1&b=2)',
    );
    expect(htmlToText('<a href="mailto:a@example.com">mail</a>')).toBe('[mail](mailto:a@example.com)');
    expect(htmlToText('<a href="javascript:alert(1)">click</a>')).toBe('click');
    expect(htmlToText('<a href=" JaVaScRiPt:alert(1)">click</a>')).toBe('click');
    // A `>` inside a quoted value ends the tag early: the rest shows as text, never as a link.
    expect(htmlToText('<a href="data:text/html,<script>x</script>">x</a>')).not.toMatch(/data:|\]\(|<script/);
  });

  it('renders nested and ordered lists', () => {
    const html =
      '<ul><li>One<ul><li>One.a</li><li>One.b</li></ul></li><li>Two</li></ul><ol><li>First</li><li>Second</li></ol>';
    expect(htmlToText(html)).toBe('- One\n  - One.a\n  - One.b\n- Two\n\n1. First\n2. Second');
  });

  it('handles headings, line breaks, entities, pre and an unclosed script', () => {
    expect(htmlToText('<h2>Acceptance criteria</h2>Given&nbsp;x<br>then &lt;y&gt; &#169; &#x2603;')).toBe(
      '## Acceptance criteria\n\nGiven x\nthen <y> © ☃',
    );
    expect(htmlToText('<pre>  keep   spacing</pre>')).toBe('keep   spacing');
    expect(htmlToText('before<script>never closed')).toBe('before');
    expect(htmlToText('a < b and c>d')).toBe('a < b and c>d');
  });

  it('is linear on hostile input', () => {
    const t = performance.now();
    htmlToText('<a href="'.repeat(20_000));
    htmlToText('<div>'.repeat(50_000));
    htmlToText(`<${'a '.repeat(50_000)}`);
    expect(performance.now() - t).toBeLessThan(2_000);
  });
});

describe('cleanText and richText', () => {
  it('strips control, bidi override and zero-width characters', () => {
    expect(cleanText(`a${NUL}b${RLO}c${LRI}d${ZWSP}e${BOM}f\r\ng${LS}h`)).toBe('abcdef\ng\nh');
  });

  it('converts only values that look like HTML', () => {
    expect(richText('<p>x</p>')).toBe('x');
    expect(richText('  3 < 4 plain  ')).toBe('3 < 4 plain');
  });
});

describe('utcIso', () => {
  it.each([
    ['2026-10-01T12:34:56.1234567Z', '2026-10-01T12:34:56.123Z'],
    ['2026-10-01T12:34:56Z', '2026-10-01T12:34:56.000Z'],
    ['2026-10-01T09:34:56.5-03:00', '2026-10-01T12:34:56.500Z'],
    ['2026-10-01T12:34Z', '2026-10-01T12:34:00.000Z'],
  ])('%s → %s', (input, out) => expect(utcIso(input)).toBe(out));

  it('refuses values without a zone instead of guessing', () => {
    expect(utcIso('2026-10-01T12:34:56.123')).toBeUndefined();
    expect(utcIso('yesterday')).toBeUndefined();
  });
});
