// SPDX-License-Identifier: Apache-2.0
// Rows for an agent (ADR-0015, L-040): `table`, `csv` or `json`, caps on rows, value length, block size and columns,
// and the exact rows shown handed back for `structuredContent`, so text and structured output never disagree.
import { AbError, ErrorCode } from '../errors.ts';
import { redact } from '../redact.ts';
import { cleanText, richText } from './text.ts';

export type OutputFormat = 'auto' | 'table' | 'csv' | 'json';
export type RenderedFormat = Exclude<OutputFormat, 'auto'>;

export const OUTPUT_FORMATS: readonly OutputFormat[] = Object.freeze(['auto', 'table', 'csv', 'json']);

/** `auto` renders a Markdown table up to this many columns and CSV above (padding wastes tokens). */
export const TABLE_MAX_COLUMNS = 8;

export interface OutputCaps {
  readonly maxRows: number;
  /** Characters per value. */
  readonly maxValueChars: number;
  /** Characters in one rendered data block. */
  readonly maxBlockChars: number;
  readonly maxColumns: number;
}

/** ADR-0015 defaults. */
export const DEFAULT_OUTPUT_CAPS: OutputCaps = Object.freeze({
  maxRows: 100,
  maxValueChars: 300,
  maxBlockChars: 24_000,
  maxColumns: 50,
});

/** ADR-0015 hard maximums: callers may lower caps, never raise them past these. */
export const MAX_OUTPUT_CAPS: OutputCaps = Object.freeze({
  maxRows: 1_000,
  maxValueChars: 4_000,
  maxBlockChars: 100_000,
  maxColumns: 200,
});

/** Identity columns (L-043): listed first and never dropped by the column cap. */
export const IDENTITY_COLUMNS: readonly string[] = Object.freeze([
  'number',
  'assetType',
  'oid',
  'state',
  'project',
]);

export interface FormatRowsOptions extends Partial<OutputCaps> {
  readonly format?: OutputFormat;
  /** Column order and subset. Default: identity columns first, then keys in order of first appearance. */
  readonly columns?: readonly string[];
  /** Columns holding Agility rich text (HTML), converted to plain text and Markdown. */
  readonly richText?: readonly string[];
}

export interface FormattedRows {
  /** The data block, not yet enveloped; `(no rows)` when empty. */
  readonly body: string;
  /** The rows shown, with the same cuts (for `structuredContent`). */
  readonly rows: Record<string, unknown>[];
  readonly columns: string[];
  readonly format: RenderedFormat;
  /** Input rows not shown because of the row or block cap. */
  readonly droppedRows: number;
  readonly cutValues: number;
  readonly omittedColumns: number;
  readonly blockCapped: boolean;
}

function cap(value: number | undefined, name: keyof OutputCaps): number {
  if (value === undefined) return DEFAULT_OUTPUT_CAPS[name];
  if (!Number.isInteger(value) || value < 1)
    throw new AbError(ErrorCode.InputInvalid, `${name} must be a positive integer.`);
  return Math.min(value, MAX_OUTPUT_CAPS[name]);
}

export function resolveCaps(options: Partial<OutputCaps> = {}): OutputCaps {
  return {
    maxRows: cap(options.maxRows, 'maxRows'),
    maxValueChars: cap(options.maxValueChars, 'maxValueChars'),
    maxBlockChars: cap(options.maxBlockChars, 'maxBlockChars'),
    maxColumns: cap(options.maxColumns, 'maxColumns'),
  };
}

/** Cut to `max` UTF-16 units without splitting a surrogate pair, marking the cut with `…`. */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max - 1);
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/**
 * Cleaned, redacted and cut to `max`. Only a bounded head is redacted (work follows the cap, not the value), with
 * margin so a secret that straddles the cut is still recognised.
 */
export function safeText(text: string, max: number): { readonly text: string; readonly cut: boolean } {
  const head = text.length > max + 512 ? text.slice(0, max + 512) : text;
  const clean = redact(cleanText(head));
  const cut = text.length > head.length || clean.length > max;
  return { text: truncateText(clean, max), cut };
}

interface Counter {
  cut: number;
}

/** A structured value with every string cleaned, redacted and cut, and absent values dropped (never `null`). */
function shapeValue(value: unknown, max: number, counter: Counter, depth = 0): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const s = safeText(value, max);
    if (s.cut) counter.cut++;
    return s.text;
  }
  if (depth >= 4) return undefined;
  if (Array.isArray(value)) {
    const items = value.slice(0, 50).map((v) => shapeValue(v, max, counter, depth + 1));
    if (value.length > 50) counter.cut++;
    return items.filter((v) => v !== undefined);
  }
  if (typeof value === 'object') {
    // fromEntries defines own properties, so a `__proto__` key in the data stays plain data.
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => {
        const shaped = shapeValue(v, max, counter, depth + 1);
        return shaped === undefined ? [] : [[cleanText(k).slice(0, 200), shaped]];
      }),
    );
  }
  return undefined;
}

function display(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // A project or owner shows its name; a list of them, their names.
  if (Array.isArray(value)) return value.map(display).join('; ');
  const name = (value as { name?: unknown }).name;
  if (typeof name === 'string') return name;
  return JSON.stringify(value);
}

const NEWLINE_RE = /\n/g;

function tableCell(value: unknown): string {
  return display(value).replace(/\\/g, '\\\\').replace(NEWLINE_RE, '\\n').replace(/\|/g, '\\|');
}

const CSV_QUOTE_RE = /[",\n]|^\s|\s$/;
/** Text a spreadsheet would evaluate (L-041): `=`, `+`, `@`, tab, CR, and `-` unless the value is a plain number. */
const FORMULA_RE = /^[=+@\t\r]|^-(?!\d+(?:\.\d+)?(?:e[+-]?\d+)?$)/i;

function csvCell(value: unknown): string {
  let text = display(value);
  if (typeof value !== 'number' && FORMULA_RE.test(text)) text = `'${text}`;
  return CSV_QUOTE_RE.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function renderer(format: RenderedFormat, columns: readonly string[]) {
  switch (format) {
    case 'table':
      return {
        header: [`| ${columns.map(tableCell).join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`],
        row: (r: Record<string, unknown>) => `| ${columns.map((c) => tableCell(r[c])).join(' | ')} |`,
        footer: [] as string[],
      };
    case 'csv':
      return {
        header: [columns.map(csvCell).join(',')],
        row: (r: Record<string, unknown>) => columns.map((c) => csvCell(r[c])).join(','),
        footer: [] as string[],
      };
    case 'json':
      return { header: ['['], row: (r: Record<string, unknown>) => JSON.stringify(r), footer: [']'] };
  }
}

function defaultColumns(rows: readonly Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  for (const c of IDENTITY_COLUMNS) if (rows.some((r) => Object.hasOwn(r, c))) seen.add(c);
  for (const row of rows) for (const key of Object.keys(row)) seen.add(key);
  return [...seen];
}

/** Renders rows within the caps. */
export function formatRows(
  input: readonly Record<string, unknown>[],
  options: FormatRowsOptions = {},
): FormattedRows {
  const rows = input.filter((r) => r !== null && typeof r === 'object' && !Array.isArray(r));
  const caps = resolveCaps(options);
  const requested = options.format ?? 'auto';
  if (!OUTPUT_FORMATS.includes(requested)) {
    throw new AbError(ErrorCode.InputInvalid, `format must be one of ${OUTPUT_FORMATS.join(', ')}.`);
  }
  const wanted = options.columns ? [...new Set(options.columns)] : defaultColumns(rows);
  // Identity columns survive the column cap; the rest fill what is left in order.
  const identity = wanted.filter((c) => IDENTITY_COLUMNS.includes(c));
  const others = wanted.filter((c) => !IDENTITY_COLUMNS.includes(c));
  const keep = new Set([...identity, ...others].slice(0, Math.max(caps.maxColumns, identity.length)));
  const columns = wanted.filter((c) => keep.has(c));
  const omittedColumns = wanted.length - columns.length;
  const rich = new Set(options.richText ?? []);
  const format: RenderedFormat =
    requested === 'auto' ? (columns.length <= TABLE_MAX_COLUMNS ? 'table' : 'csv') : requested;
  const render = renderer(
    format,
    columns.map((c) => safeText(c, 200).text),
  );

  const lines = [...render.header];
  let used = [...render.header, ...render.footer].reduce((n, l) => n + l.length + 1, 0);
  const shown: Record<string, unknown>[] = [];
  const counter: Counter = { cut: 0 };
  let blockCapped = used > caps.maxBlockChars && rows.length > 0;
  for (const row of blockCapped ? [] : rows.slice(0, caps.maxRows)) {
    const rowCounter: Counter = { cut: 0 };
    const shaped: Record<string, unknown> = Object.fromEntries(
      columns.flatMap((c) => {
        if (!Object.hasOwn(row, c)) return [];
        const raw = row[c];
        const v = shapeValue(
          rich.has(c) && typeof raw === 'string' ? richText(raw) : raw,
          caps.maxValueChars,
          rowCounter,
        );
        return v === undefined ? [] : [[c, v]];
      }),
    );
    const line = render.row(shaped);
    const comma = format === 'json' && shown.length > 0 ? 1 : 0;
    if (used + comma + line.length + 1 > caps.maxBlockChars) {
      blockCapped = true;
      break;
    }
    used += comma + line.length + 1;
    if (comma === 1) lines[lines.length - 1] += ',';
    lines.push(line);
    shown.push(shaped);
    counter.cut += rowCounter.cut;
  }
  lines.push(...render.footer);
  return {
    body:
      rows.length === 0
        ? '(no rows)'
        : shown.length === 0 && blockCapped
          ? '(the columns alone exceed the size cap)'
          : lines.join('\n'),
    rows: shown,
    columns,
    format,
    droppedRows: rows.length - shown.length,
    cutValues: counter.cut,
    omittedColumns,
    blockCapped,
  };
}
