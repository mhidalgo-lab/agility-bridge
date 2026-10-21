// SPDX-License-Identifier: Apache-2.0
// Text that came from Agility, made safe to show (ADR-0015, THREAT_MODEL T6, A1): control, bidirectional and
// zero-width characters removed, and rich text (HTML) turned into plain text with light Markdown. Workers have no
// DOMParser, so HTML goes through a small linear scanner that keeps only text, structure and safe links.

// C0 controls except tab, line feed and carriage return; DEL and C1 controls.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
// Bidirectional marks, embeddings, overrides and isolates (Trojan Source), and zero-width characters.
const INVISIBLE_RE = /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const LINE_SEPARATOR_RE = /\r\n?|[\u2028\u2029]/g;

/** Strips control, bidi and zero-width characters and normalises line breaks to `\n`. */
export function cleanText(text: string): string {
  return text.replace(LINE_SEPARATOR_RE, '\n').replace(CONTROL_RE, '').replace(INVISIBLE_RE, '');
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  times: '×',
  laquo: '«',
  raquo: '»',
  deg: '°',
};

function codePoint(n: number): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
    ? String.fromCodePoint(n)
    : '\uFFFD';
}

/** Decodes the common named entities and every numeric one; unknown names stay as written. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(
    /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g,
    (m, body: string) => {
      if (body[0] === '#')
        return codePoint(
          body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1)),
        );
      return NAMED_ENTITIES[body] ?? m;
    },
  );
}

/** Elements dropped together with everything inside them. */
const DROP_WITH_CONTENT = new Set([
  'script',
  'style',
  'head',
  'title',
  'iframe',
  'object',
  'embed',
  'applet',
  'svg',
  'math',
  'noscript',
  'template',
  'textarea',
  'select',
  'canvas',
  'audio',
  'video',
  'frameset',
]);
const BLOCKS = new Set([
  'p',
  'div',
  'section',
  'article',
  'header',
  'footer',
  'main',
  'nav',
  'aside',
  'blockquote',
  'pre',
  'table',
  'dl',
  'dt',
  'dd',
  'figure',
  'figcaption',
  'address',
  'form',
  'fieldset',
]);
const SAFE_LINK_RE = /^(?:https?:|mailto:)/i;

interface Tag {
  readonly name: string;
  readonly closing: boolean;
  readonly attrs: ReadonlyMap<string, string>;
  /** Index just after the tag's `>`. */
  readonly end: number;
}

/** Longest tag read as a tag; anything longer is text (real rich-text tags are short). */
const MAX_TAG_CHARS = 1_000;

/**
 * Reads the tag from `start` (`<`) to `gt` (its `>`). Attribute values are read inside that span only, so a `>` inside
 * a quoted value ends the tag early; the rest then shows as text, which is harmless.
 */
function readTag(html: string, start: number, gt: number): Tag | undefined {
  let i = start + 1;
  const closing = html[i] === '/';
  if (closing) i++;
  const nameStart = i;
  while (i < gt && /[A-Za-z0-9:-]/.test(html[i] as string)) i++;
  if (i === nameStart) return undefined;
  const name = html.slice(nameStart, i).toLowerCase();
  const attrs = new Map<string, string>();
  while (i < gt) {
    if (/[\s/]/.test(html[i] as string)) {
      i++;
      continue;
    }
    const keyStart = i;
    while (i < gt && !/[\s/=]/.test(html[i] as string)) i++;
    const key = html.slice(keyStart, i).toLowerCase();
    while (i < gt && /\s/.test(html[i] as string)) i++;
    let value = '';
    if (html[i] === '=') {
      i++;
      while (i < gt && /\s/.test(html[i] as string)) i++;
      const q = html[i];
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, i + 1);
        const end = close === -1 || close > gt ? gt : close;
        value = html.slice(i + 1, end);
        i = end + 1;
      } else {
        const valueStart = i;
        while (i < gt && !/\s/.test(html[i] as string)) i++;
        value = html.slice(valueStart, i);
      }
    }
    if (key !== '' && !attrs.has(key)) attrs.set(key, value);
  }
  return { name, closing, attrs, end: gt + 1 };
}

interface List {
  readonly ordered: boolean;
  n: number;
}

/**
 * Rich text to plain text with light Markdown: paragraphs, line breaks, headings, `-`/`1.` lists (nested), bold,
 * italics, code, `[text](url)` for http(s) and mailto links only, `[image: alt]`. Scripts, styles, embedded objects,
 * comments, event attributes and every other attribute are dropped. Linear in the input.
 */
/** Longest rich text converted; the shaper cuts values far below this anyway (Phase 1 review H1). */
export const MAX_HTML_CHARS = 65_536;
/** Deepest list indentation rendered; deeper lists render at this depth. */
const MAX_LIST_INDENT = 8;

export function htmlToText(input: string): string {
  const html = input.length > MAX_HTML_CHARS ? input.slice(0, MAX_HTML_CHARS) : input;
  const lower = html.toLowerCase();
  const out: string[] = [];
  const lists: List[] = [];
  const links: Array<{ href?: string; at: number }> = [];
  let pre = 0;
  // The next `>` at or after the current `<`, found once and reused, so a page of `<` without `>` stays linear.
  let gt = -1;
  const block = () => out.push('\n\n');
  const text = (raw: string) => {
    const decoded = decodeEntities(raw);
    out.push(pre > 0 ? decoded : decoded.replace(/\s+/g, ' '));
  };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      text(html.slice(i));
      break;
    }
    if (lt > i) text(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt);
      i = end === -1 ? html.length : end + 1;
      continue;
    }
    if (gt !== -2 && gt < lt) gt = html.indexOf('>', lt);
    if (gt === -1) gt = -2;
    const tag = gt >= 0 && gt - lt <= MAX_TAG_CHARS ? readTag(html, lt, gt) : undefined;
    if (tag === undefined) {
      text('<');
      i = lt + 1;
      continue;
    }
    i = tag.end;
    const { name, closing } = tag;
    if (DROP_WITH_CONTENT.has(name)) {
      if (!closing) {
        const end = lower.indexOf(`</${name}`, i);
        if (end === -1) break;
        const after = html.indexOf('>', end);
        i = after === -1 ? html.length : after + 1;
      }
      continue;
    }
    if (BLOCKS.has(name)) {
      if (name === 'pre') pre += closing ? (pre > 0 ? -1 : 0) : 1;
      block();
      continue;
    }
    switch (name) {
      case 'br':
        out.push('\n');
        break;
      case 'hr':
        out.push('\n\n---\n\n');
        break;
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        block();
        if (!closing) out.push(`${'#'.repeat(Number(name[1]))} `);
        break;
      case 'ul':
      case 'ol':
        // A nested list continues its parent item; a top-level one is a block.
        if (closing) lists.pop();
        else lists.push({ ordered: name === 'ol', n: 0 });
        if (lists.length === (closing ? 0 : 1)) block();
        break;
      case 'li': {
        if (closing) break;
        const list = lists.at(-1);
        const indent = '  '.repeat(Math.min(MAX_LIST_INDENT, Math.max(0, lists.length - 1)));
        if (list === undefined) out.push(`\n- `);
        else out.push(`\n${indent}${list.ordered ? `${++list.n}.` : '-'} `);
        break;
      }
      case 'tr':
        if (closing) out.push('\n');
        break;
      case 'td':
      case 'th':
        if (closing) out.push(' | ');
        break;
      case 'strong':
      case 'b':
        out.push('**');
        break;
      case 'em':
      case 'i':
        out.push('_');
        break;
      case 'code':
        if (pre === 0) out.push('`');
        break;
      case 'img': {
        const alt = cleanText(decodeEntities(tag.attrs.get('alt') ?? ''))
          .replace(/\s+/g, ' ')
          .trim();
        out.push(alt === '' ? '[image]' : `[image: ${alt.replace(/[[\]]/g, '')}]`);
        break;
      }
      case 'a': {
        if (!closing) {
          // A link inside a link keeps only its text: one open link at a time keeps the work linear (review H1).
          if (links.length > 0) break;
          const href = cleanText(decodeEntities(tag.attrs.get('href') ?? '')).trim();
          links.push({ ...(SAFE_LINK_RE.test(href) ? { href } : {}), at: out.length });
          break;
        }
        const link = links.pop();
        if (link?.href === undefined) break;
        const label = out.splice(link.at).join('').replace(/\s+/g, ' ').trim().replace(/[[\]]/g, '');
        const url = link.href.replace(/[()\s]/g, (c) => encodeURIComponent(c));
        out.push(label === '' || label === link.href ? url : `[${label}](${url})`);
        break;
      }
      default:
        // Every other element (span, font, u, …) keeps its text and loses its attributes.
        break;
    }
  }
  return cleanText(out.join(''))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+(?=\n)/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const HTML_HINT_RE = /<\/?[A-Za-z][A-Za-z0-9]*(?:\s[^<>]*)?\/?>|&(?:#[0-9]+|#x[0-9a-f]+|[a-z]+);/i;

/** An Agility rich-text value (LongText attributes hold HTML) as plain text; plain values are only cleaned. */
export function richText(value: string): string {
  return HTML_HINT_RE.test(value) ? htmlToText(value) : cleanText(value).trim();
}

const AGILITY_DATE_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2})?)(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * An Agility timestamp as ISO 8601 UTC with milliseconds (L-149: up to 7 fractional digits, `Z` or an offset).
 * Undefined when the value carries no zone: callers keep the raw value instead of guessing.
 */
export function utcIso(value: string): string | undefined {
  const m = AGILITY_DATE_RE.exec(value.trim());
  if (m === null || m[4] === undefined) return undefined;
  const [, day, time, fraction = '', zone] = m;
  const ms = `${fraction}000`.slice(0, 3);
  const offset = zone === 'Z' ? 'Z' : `${zone.slice(0, 3)}:${zone.slice(-2)}`;
  const t = Date.parse(`${day}T${time?.length === 5 ? `${time}:00` : time}.${ms}${offset}`);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}
