// SPDX-License-Identifier: Apache-2.0
// Shared machinery of the composite reports (P6-07, L-037). A report is a thin layer over sibling tools: each section
// runs one sibling's handler with the call's own context and one shared budget, only when the caller holds that tool.
// A section that was not granted, failed or ran out of budget is reported as such and contributes no numbers at all
// (L-033); the report never calls a tool the caller was not granted and never repeats query code.
import { z } from 'zod';
import type { ToolContext } from '../../context.ts';
import { AbError, ErrorCode } from '../../errors.ts';
import { RESULT_META_KEY } from '../../output/result.ts';
import type { ToolDefinition } from '../../tool.ts';

export type SectionStatus = 'ok' | 'skipped' | 'failed' | 'not_run';

/** What the caller learns about one section (our own text and codes only). */
export interface SectionInfo {
  readonly key: string;
  readonly tool: string;
  readonly status: SectionStatus;
  /** Agility requests the section used. */
  readonly requests: number;
  /** Error code of a failed or not-run section. */
  readonly errorCode?: string;
}

export interface SectionRun {
  readonly info: SectionInfo;
  /** The sibling's structured result (already shaped and cleaned); only when `status` is `ok`. */
  readonly data?: Record<string, unknown>;
  /** The sibling's masked queries, for the audit trail. */
  readonly queries: readonly string[];
  readonly error?: unknown;
}

/** True when the caller may call `tool` (the host registered it for this request). */
export const granted = (ctx: ToolContext, tool: string): boolean => ctx.grantedTools?.includes(tool) === true;

/**
 * Runs one section. Never throws: an error becomes a `failed` section (or `not_run` when the budget is spent) with its
 * stable code; the caller decides, through `rethrowIfNothingRead`, whether the whole report fails.
 */
export async function runSection(
  ctx: ToolContext,
  key: string,
  tool: ToolDefinition,
  input: Record<string, unknown>,
): Promise<SectionRun> {
  const base = { key, tool: tool.name };
  if (!granted(ctx, tool.name)) return { info: { ...base, status: 'skipped', requests: 0 }, queries: [] };
  if (ctx.budget.remaining <= 0)
    return {
      info: { ...base, status: 'not_run', requests: 0, errorCode: ErrorCode.BudgetExhausted },
      queries: [],
    };
  const before = ctx.budget.used;
  try {
    const parsed = tool.inputSchema.parse(input);
    const out = await tool.handler(parsed, ctx);
    const meta = out.meta?.[RESULT_META_KEY] as { queries?: unknown } | undefined;
    const queries = Array.isArray(meta?.queries)
      ? meta.queries.filter((q): q is string => typeof q === 'string')
      : [];
    return {
      info: { ...base, status: 'ok', requests: ctx.budget.used - before },
      data: (out.structured ?? {}) as Record<string, unknown>,
      queries,
    };
  } catch (error) {
    const code = error instanceof AbError ? error.code : ErrorCode.Internal;
    return {
      info: {
        ...base,
        status: code === ErrorCode.BudgetExhausted ? 'not_run' : 'failed',
        requests: ctx.budget.used - before,
        errorCode: code,
      },
      queries: [],
      error,
    };
  }
}

/** One note per section that did not deliver (our text; the title is ours). */
export function sectionNotes(
  runs: readonly SectionRun[],
  titles: Readonly<Record<string, string>>,
): string[] {
  const notes: string[] = [];
  for (const { info } of runs) {
    const title = titles[info.key] ?? info.key;
    if (info.status === 'skipped')
      notes.push(
        `Section "${title}" skipped: ${info.tool} is not granted to this caller, so it was not read.`,
      );
    else if (info.status === 'not_run')
      notes.push(
        `Section "${title}" not run: the request budget of this call ran out. Repeat the call; cached metadata makes it cheaper.`,
      );
    else if (info.status === 'failed')
      notes.push(
        `Section "${title}" failed (${info.errorCode ?? 'AB_INTERNAL'}); nothing from it is reported.`,
      );
  }
  return notes;
}

/**
 * When sections were attempted and none delivered, the report has nothing to say: the first error is the answer (a
 * missing sprint or asset is a not-found, not an empty report).
 */
export function rethrowIfNothingRead(runs: readonly SectionRun[]): void {
  const attempted = runs.filter((r) => r.info.status !== 'skipped');
  if (attempted.length === 0 || attempted.some((r) => r.info.status === 'ok')) return;
  const first = attempted.find((r) => r.error !== undefined);
  if (first?.error !== undefined) throw first.error;
}

export const sectionInfos = (runs: readonly SectionRun[]): SectionInfo[] => runs.map((r) => ({ ...r.info }));
export const allQueries = (runs: readonly SectionRun[]): string[] => runs.flatMap((r) => [...r.queries]);
/** True when some section did not deliver. */
export const incomplete = (runs: readonly SectionRun[]): boolean => runs.some((r) => r.info.status !== 'ok');

type Json = Record<string, unknown>;
export const obj = (v: unknown): Json | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
export const arr = (v: unknown): Json[] =>
  Array.isArray(v)
    ? v.filter((x): x is Json => x !== null && typeof x === 'object' && !Array.isArray(x))
    : [];
export const numOf = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
export const strOf = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
export const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Open output schema of a report: the sections with their status, the notes and the partial flag. */
export const reportOutput = (shape: z.ZodRawShape = {}): z.ZodType =>
  z.looseObject({
    sections: z.array(z.looseObject({ key: z.string(), tool: z.string(), status: z.string() })),
    partial: z.boolean().optional(),
    notes: z.array(z.string()).optional(),
    ...shape,
  });
