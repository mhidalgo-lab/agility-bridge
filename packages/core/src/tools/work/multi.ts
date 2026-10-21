// SPDX-License-Identifier: Apache-2.0
// One page across several asset types in one request (query.v1 takes an array of queries). Each type keeps its own
// offset, advanced only by the rows of that type that were shown, so merging never skips or repeats a row whatever the
// merge order; "more available" comes from any type returning more than it showed.
import { agilityClient } from '../../agility/client.ts';
import type { ToolContext } from '../../context.ts';
import { inScope, oidsOf } from '../../identity/scope.ts';
import { type CompiledQuery, compileQuery, type QueryInput } from '../../query/compiler.ts';

export interface TypedRow {
  readonly type: string;
  readonly row: Readonly<Record<string, unknown>>;
  readonly compiled: CompiledQuery;
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
  const all: TypedRow[] = [];
  let hidden = 0;
  const fetched = new Map<string, number>();
  for (const [i, c] of compiled.entries()) {
    const set = Array.isArray(res.data) ? res.data[i] : undefined;
    const rows = Array.isArray(set)
      ? set.filter(
          (r): r is Record<string, unknown> => r !== null && typeof r === 'object' && !Array.isArray(r),
        )
      : [];
    fetched.set(c.assetType, rows.length);
    for (const row of rows) {
      if (inScope(ctx, c, row)) all.push({ type: c.assetType, row, compiled: c });
      else hidden++;
    }
  }
  all.sort(compare);
  const shown = all.slice(0, limit);
  const next: Record<string, number> = { ...offsets };
  const perType = new Map<string, number>();
  for (const r of shown) perType.set(r.type, (perType.get(r.type) ?? 0) + 1);
  let hasMore = all.length > shown.length;
  for (const c of compiled) {
    const n = perType.get(c.assetType) ?? 0;
    next[c.assetType] = (offsets[c.assetType] ?? 0) + n;
    if ((fetched.get(c.assetType) ?? 0) > n) hasMore = true;
  }
  return { rows: shown, offsets: next, hasMore, hidden, compiled };
}

/** Offsets after the first `shown` rows of a page (the shaper may show fewer rows than the page has). */
export function offsetsAfter(
  base: Readonly<Record<string, number>>,
  page: MultiPage,
  shown: number,
): Record<string, number> {
  const next: Record<string, number> = { ...base };
  for (const c of page.compiled) next[c.assetType] = base[c.assetType] ?? 0;
  for (const r of page.rows.slice(0, shown)) next[r.type] = (next[r.type] ?? 0) + 1;
  return next;
}
