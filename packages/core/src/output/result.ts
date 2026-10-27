// SPDX-License-Identifier: Apache-2.0
// The one shaper every tool result goes through (ADR-0015): a one-line summary, `Note:` lines and data blocks in the
// requested format, every Agility string inside the untrusted-data envelope; `structuredContent` with exactly the rows
// the text shows; `_meta["agility-bridge/result"]`.
import type { ToolContext } from '../context.ts';
import type { ToolOutput } from '../tool.ts';
import { envelope, newEnvelopeId } from './envelope.ts';
import { type FormattedRows, formatRows, type OutputCaps, type OutputFormat, safeText } from './format.ts';

export const RESULT_META_KEY = 'agility-bridge/result';

/** A piece of Agility text inside a summary or note line. */
export interface Untrusted {
  readonly untrusted: string;
}

/** Marks Agility text for a summary or note: the line is then shown inside the envelope (L-038). */
export function untrusted(value: unknown): Untrusted {
  return {
    untrusted: typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value),
  };
}

/** Our own text, or our text with Agility values in it. */
export type Line = string | readonly (string | Untrusted)[];

export interface Block {
  /** Our own heading for the block, e.g. "Open defects". */
  readonly title?: string;
  /** Envelope label, e.g. "stories". */
  readonly source: string;
  readonly rows: readonly Record<string, unknown>[];
  readonly columns?: readonly string[];
  readonly richText?: readonly string[];
}

/** Free text from Agility shown as one block (an attachment's content): cleaned, redacted, cut and enveloped. */
export interface TextBlock {
  readonly title?: string;
  readonly source: string;
  readonly text: string;
  /** Most characters shown (at most `MAX_TEXT_BLOCK_CHARS`); the rest is cut and `cut` says so. */
  readonly maxChars: number;
}

/** The most characters one text block shows. */
export const MAX_TEXT_BLOCK_CHARS = 100_000;

export interface OutputSpec {
  readonly summary: Line;
  readonly notes?: readonly Line[];
  readonly blocks?: readonly Block[];
  /** Text blocks, shown after the data blocks. */
  readonly texts?: readonly TextBlock[];
  readonly format?: OutputFormat;
  readonly caps?: Partial<OutputCaps>;
  readonly partial?: boolean;
  /** Further `structuredContent` fields (camelCase); shaped like row values. */
  readonly structured?: Readonly<Record<string, unknown>>;
  /** Further `_meta["agility-bridge/result"]` fields (query with values masked, cache status, links…). */
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface ShapedOutput {
  readonly output: ToolOutput;
  readonly blocks: readonly FormattedRows[];
  /** The text blocks as shown (`text` is what the caller sees; `cut` when the cap shortened it). */
  readonly texts: readonly { readonly text: string; readonly cut: boolean }[];
}

const LINE_VALUE_CHARS = 300;

function isPure(line: Line): line is string {
  return typeof line === 'string';
}

function lineText(line: Line): string {
  if (isPure(line)) return line;
  return line
    .map((p) =>
      typeof p === 'string' ? p : safeText(p.untrusted, LINE_VALUE_CHARS).text.replace(/\s+/g, ' '),
    )
    .join('');
}

/** Member contact data: emails, and usernames (often an email address), matched on the last path segment (D-06). */
const EMAIL_KEY_RE = /(?:^|\.)(?:e-?mail|email_?address|username)$/i;

/** Drops email fields at any depth unless the workspace enables them (D-06, ADR-0015). */
export function minimiseEmails<T>(value: T, depth = 0): T {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => minimiseEmails(v, depth + 1)) as T;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([k]) => !EMAIL_KEY_RE.test(k))
      .map(([k, v]) => [k, minimiseEmails(v, depth + 1)]),
  ) as T;
}

export type AssetState =
  | 'future'
  | 'active'
  | 'closed'
  | 'template'
  | 'broken_down'
  | 'deleted'
  | 'guest_collaborator'
  | 'unknown';

/** `AssetState` codes (Agility docs: 0 future, 64 active, 128 closed, 200 template, 208 broken down, 255 deleted). */
export function assetState(code: unknown, assetType?: string): AssetState {
  switch (Number(code)) {
    case 0:
      return 'future';
    case 64:
      return 'active';
    case 128:
      return 'closed';
    case 200:
      return assetType === 'Member' ? 'guest_collaborator' : 'template';
    case 208:
      return 'broken_down';
    case 255:
      return 'deleted';
    default:
      return 'unknown';
  }
}

/** Renders a whole result. Lower level than `shapeList`; reports use it for several sections. */
export function shapeOutput(ctx: ToolContext, spec: OutputSpec): ShapedOutput {
  const id = newEnvelopeId(ctx.random);
  const minimise = <T>(v: T): T => (ctx.limits.memberEmails ? v : minimiseEmails(v));
  const lines: string[] = [];
  const enveloped: string[] = [];
  if (isPure(spec.summary)) lines.push(spec.summary);
  else enveloped.push(lineText(spec.summary));
  for (const note of spec.notes ?? []) (isPure(note) ? lines : enveloped).push(`Note: ${lineText(note)}`);
  if (enveloped.length > 0) lines.push(envelope(enveloped.join('\n'), id, 'summary and notes'));

  const formatted: FormattedRows[] = [];
  for (const block of spec.blocks ?? []) {
    const f = formatRows(minimise(block.rows), {
      ...spec.caps,
      ...(spec.format === undefined ? {} : { format: spec.format }),
      ...(block.columns === undefined ? {} : { columns: block.columns }),
      ...(block.richText === undefined ? {} : { richText: block.richText }),
    });
    formatted.push(f);
    if (block.title !== undefined) lines.push(`${block.title}:`);
    lines.push(f.rows.length === 0 && f.droppedRows === 0 ? f.body : envelope(f.body, id, block.source));
  }

  const shownTexts: Array<{ text: string; cut: boolean }> = [];
  for (const block of spec.texts ?? []) {
    const shown = safeText(block.text, Math.min(Math.max(1, block.maxChars), MAX_TEXT_BLOCK_CHARS));
    shownTexts.push(shown);
    if (block.title !== undefined) lines.push(`${block.title}:`);
    lines.push(envelope(shown.text === '' ? '(empty)' : shown.text, id, block.source));
  }

  const structuredExtra =
    spec.structured === undefined
      ? {}
      : (shapeStructured(minimise(spec.structured)) as Record<string, unknown>);
  const notes = (spec.notes ?? []).map(lineText);
  const structured: Record<string, unknown> = {
    ...structuredExtra,
    ...(spec.partial === true ? { partial: true } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  };
  const meta = {
    [RESULT_META_KEY]: {
      instance: ctx.instance.id,
      requestsUsed: ctx.budget.used,
      ...(formatted[0] === undefined ? {} : { format: formatted[0].format }),
      ...spec.meta,
    },
  };
  return { output: { text: lines.join('\n'), structured, meta }, blocks: formatted, texts: shownTexts };
}

function shapeStructured(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const f = formatRows([value as Record<string, unknown>], {
    format: 'json',
    maxBlockChars: 100_000,
    maxColumns: 200,
  });
  return f.rows[0] ?? {};
}

export interface ListSpec {
  readonly summary: Line;
  readonly notes?: readonly Line[];
  readonly source: string;
  readonly title?: string;
  /** The page's rows: at most `limit` (the tool fetched `limit + 1` to learn `hasMore`). */
  readonly rows: readonly Record<string, unknown>[];
  readonly columns?: readonly string[];
  readonly richText?: readonly string[];
  readonly hasMore?: boolean;
  /** The cursor for the rows after the first `shown` rows of this page; omit for a list that does not page. */
  readonly cursorFor?: (shown: number) => string;
  /** Only when actually computed (an aggregate); Agility's `-1` and guesses are never shown (L-144). */
  readonly total?: number;
  readonly hiddenOutsideScope?: boolean;
  readonly partial?: boolean;
  readonly format?: OutputFormat;
  readonly caps?: Partial<OutputCaps>;
  readonly meta?: Readonly<Record<string, unknown>>;
  /** Further blocks after the list (a second, bounded list such as links); their shown rows go to `structured[key]`. */
  readonly extraBlocks?: readonly (Block & { readonly key: string })[];
}

/**
 * A paged or bounded list: `items` are exactly the rows shown. When the caps cut a page short, the cursor starts after
 * the last row shown, so no row is skipped; a list that cannot page says it was truncated.
 */
export function shapeList(ctx: ToolContext, spec: ListSpec): ToolOutput {
  const probe = formatRows(ctx.limits.memberEmails ? spec.rows : minimiseEmails(spec.rows), {
    ...spec.caps,
    ...(spec.format === undefined ? {} : { format: spec.format }),
    ...(spec.columns === undefined ? {} : { columns: spec.columns }),
    ...(spec.richText === undefined ? {} : { richText: spec.richText }),
  });
  const shown = probe.rows.length;
  const notes: Line[] = [...(spec.notes ?? [])];
  let nextCursor: string | undefined;
  let truncated = false;
  let partial = spec.partial === true;
  const more = probe.droppedRows > 0 || spec.hasMore === true;
  if (more && spec.cursorFor !== undefined) {
    nextCursor = spec.cursorFor(shown);
    notes.push(
      probe.droppedRows > 0
        ? `Showing ${shown} of this page's ${spec.rows.length} rows (output size cap); pass nextCursor as cursor for the rest.`
        : 'More rows exist: pass nextCursor as cursor for the next page.',
    );
  } else if (more) {
    truncated = true;
    partial = true;
    notes.push(`Showing the first ${shown} rows; more exist. Narrow the filters to see the rest.`);
  }
  if (probe.cutValues > 0)
    notes.push(
      `${probe.cutValues} values were cut (marked …); ask for fewer fields or get the item for the full text.`,
    );
  if (probe.omittedColumns > 0) notes.push(`${probe.omittedColumns} columns were omitted (column cap).`);
  if (spec.hiddenOutsideScope === true)
    notes.push("Some rows outside the workspace's Agility projects were hidden.");
  const total =
    spec.total !== undefined && Number.isInteger(spec.total) && spec.total >= 0 ? spec.total : undefined;
  const extra = spec.extraBlocks ?? [];
  const { output, blocks } = shapeOutput(ctx, {
    summary: spec.summary,
    notes,
    blocks: [
      {
        source: spec.source,
        rows: probe.rows,
        columns: probe.columns,
        ...(spec.title === undefined ? {} : { title: spec.title }),
      },
      ...extra.map(({ key: _key, ...block }) => block),
    ],
    ...(spec.format === undefined ? {} : { format: probe.format }),
    caps: { ...spec.caps, maxRows: Math.max(1, probe.rows.length, ...extra.map((b) => b.rows.length)) },
    partial,
    ...(spec.meta === undefined ? {} : { meta: spec.meta }),
  });
  const structured = {
    items: probe.rows,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    ...(truncated ? { truncated: true } : {}),
    ...(total === undefined ? {} : { total }),
    ...(spec.hiddenOutsideScope === true ? { hiddenOutsideScope: true } : {}),
    ...Object.fromEntries(extra.map((block, i) => [block.key, blocks[i + 1]?.rows ?? []])),
    ...(output.structured as Record<string, unknown>),
  };
  return { ...output, structured };
}
