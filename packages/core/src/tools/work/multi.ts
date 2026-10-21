// SPDX-License-Identifier: Apache-2.0
// One page across several asset types in one request (query.v1 takes an array of queries). Each type keeps its own
// offset, advanced only by the rows of that type that were shown, so merging never skips or repeats a row whatever the
// merge order; "more available" comes from any type returning more than it showed.
import { agilityClient } from '../../agility/client.ts';
import type { ToolContext } from '../../context.ts';
import { inScope, oidsOf, sanitizeRow } from '../../identity/scope.ts';
import { type CompiledQuery, compileQuery, type QueryInput } from '../../query/compiler.ts';

export interface TypedRow {
  readonly type: string;
  readonly row: Readonly<Record<string, unknown>>;
  readonly compiled: CompiledQuery;
  /** Position of the row in its type's upstream page (hidden rows included). */
  readonly rawIndex: number;
}

export interface MultiPage {
  readonly rows: TypedRow[];
  readonly offsets: Readonly<Record<string, number>>;
  readonly hasMore: boolean;
  readonly hidden: number;
  readonly compiled: readonly CompiledQuery[];
}

export const idOf = (row: Readonly<Record<string, unknown>>): number =>
  Number((oidsOf(row['_oid'])[0] ?? ':0').split(':')[1]);

/**
 * One page across several asset types in one request. Each type's rows are taken in the order Agility returned them
 * (a k-way merge on the heads), so the comparator only decides which type goes next: a comparator that disagrees with
 * Agility's collation reorders the page but never skips or repeats a row (Phase 1 review M2). Offsets count upstream
 * positions, hidden rows included.
 */
export async function multiPage(
  ctx: ToolContext,
  queries: ReadonlyArray<{ readonly type: string; readonly input: QueryInput }>,
  limit: number,
  offsets: Readonly<Record<string, number>>,
  compare: (a: TypedRow, b: TypedRow) => number,
  identityFields: (type: string) => readonly string[],
): Promise<MultiPage> {
  const compiled: CompiledQuery[] = [];
  for (const q of queries) {
    compiled.push(
      await compileQuery(
        ctx,
        { ...q.input, limit, offset: offsets[q.type] ?? 0 },
        { identityFields: identityFields(q.type) },
      ),
    );
  }
  if (compiled.length === 0) return { rows: [], offsets, hasMore: false, hidden: 0, compiled };
  const res = await agilityClient(ctx).query<unknown[]>(compiled.map((c) => c.body));
  const lists: TypedRow[][] = [];
  const fetched: number[] = [];
  let hidden = 0;
  for (const [i, c] of compiled.entries()) {
    const set = Array.isArray(res.data) ? res.data[i] : undefined;
    const rows = Array.isArray(set)
      ? set.filter(
          (r): r is Record<string, unknown> => r !== null && typeof r === 'object' && !Array.isArray(r),
        )
      : [];
    fetched.push(rows.length);
    const kept: TypedRow[] = [];
    for (const [rawIndex, row] of rows.entries()) {
      if (rawIndex >= limit) break; // the limit + 1 row only says that more exist
      if (inScope(ctx, c, row)) {
        sanitizeRow(ctx, c, row);
        kept.push({ type: c.assetType, row, compiled: c, rawIndex });
      } else hidden++;
    }
    lists.push(kept);
  }
  const heads = lists.map(() => 0);
  const shown: TypedRow[] = [];
  while (shown.length < limit) {
    let best = -1;
    for (const [i, list] of lists.entries()) {
      const head = list[heads[i] as number];
      if (head === undefined) continue;
      const current = best < 0 ? undefined : lists[best]?.[heads[best] as number];
      if (current === undefined || compare(head, current) < 0) best = i;
    }
    if (best < 0) break;
    shown.push(lists[best]?.[heads[best] as number] as TypedRow);
    heads[best] = (heads[best] as number) + 1;
  }
  const page: MultiPage = { rows: shown, offsets: {}, hasMore: false, hidden, compiled };
  const next = offsetsAfter(offsets, page, shown.length);
  // More exists when a type returned rows past what this page consumed (its limit + 1 row, or rows not shown).
  const hasMore = compiled.some(
    (c, i) => (fetched[i] as number) > (next[c.assetType] ?? 0) - (offsets[c.assetType] ?? 0),
  );
  return { ...page, offsets: next, hasMore };
}

/** Offsets after the first `shown` rows of a page (the shaper may show fewer rows than the page has). */
export function offsetsAfter(
  base: Readonly<Record<string, number>>,
  page: Pick<MultiPage, 'rows' | 'compiled'>,
  shown: number,
): Record<string, number> {
  const next: Record<string, number> = { ...base };
  for (const c of page.compiled) next[c.assetType] = base[c.assetType] ?? 0;
  for (const r of page.rows.slice(0, shown)) {
    next[r.type] = Math.max(next[r.type] ?? 0, (base[r.type] ?? 0) + r.rawIndex + 1);
  }
  return next;
}
