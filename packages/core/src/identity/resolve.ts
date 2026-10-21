// SPDX-License-Identifier: Apache-2.0
// Resolvers (P1-06, ARCHITECTURE §6.4): the identifiers and names people use, resolved inside the workspace's scope.
// Every query goes through the compiler (bound values, scope predicate) and every row through `inScope`, so an asset
// outside the workspace answers exactly like a missing one: AB_NOT_FOUND, "not found or not visible" (L-140).
import { agilityClient } from '../agility/client.ts';
import type { ToolContext } from '../context.ts';
import { AbError, ErrorCode } from '../errors.ts';
import { metadataFor, type StatusEntry } from '../metadata/service.ts';
import { type CompiledQuery, compileQuery, type FilterInput, type QueryInput } from '../query/compiler.ts';
import { matchName, type Named, noSingleMatch } from './match.ts';
import { parseAssetRef } from './refs.ts';
import { inScope, oidsOf, sanitizeRow } from './scope.ts';

export interface ResolvedAsset {
  readonly oid: string;
  readonly assetType: string;
  readonly number?: string;
  /** Untrusted. */
  readonly name?: string;
  /** The row as returned, with the requested fields. */
  readonly row: Readonly<Record<string, unknown>>;
}

type Row = Record<string, unknown>;

function notFound(text: string): AbError {
  return new AbError(
    ErrorCode.NotFound,
    `${text.slice(0, 60)} was not found or is not visible with this token.`,
    {
      hint: 'Check the number; the asset may also be outside the workspace’s Agility projects.',
    },
  );
}

const OID_ONLY = /^([A-Za-z][A-Za-z0-9_]*:\d+)/;
const stripMoment = (oid: unknown): string =>
  typeof oid === 'string' ? (OID_ONLY.exec(oid)?.[1] ?? oid) : '';

/** Runs a compiled query and returns the rows that pass the scope recheck, at most `limit + 1`. */
export async function runQuery(
  ctx: ToolContext,
  compiled: CompiledQuery,
): Promise<{ rows: Row[]; hidden: number; hiddenValues: number }> {
  const res = await agilityClient(ctx).query<unknown[]>(compiled.body);
  const set = Array.isArray(res.data) ? res.data[0] : undefined;
  const rows = Array.isArray(set)
    ? set.filter((r): r is Row => r !== null && typeof r === 'object' && !Array.isArray(r))
    : [];
  const kept = rows.filter((r) => inScope(ctx, compiled, r));
  let hiddenValues = 0;
  for (const r of kept) hiddenValues += sanitizeRow(ctx, compiled, r);
  return { rows: kept, hidden: rows.length - kept.length, hiddenValues };
}

export interface Page {
  /** The kept rows of this page (at most `limit`), rechecked and sanitized. */
  readonly rows: Row[];
  /** Whether more rows exist upstream after this page. */
  readonly hasMore: boolean;
  readonly hidden: number;
  /** The offset after the first `shown` rows, in upstream positions (P1-17, L-170). */
  next(shown: number): number;
}

/**
 * One page of a single-type list. A row the recheck drops still counts as an upstream position, so it never shifts the
 * cursor: the next page starts right after the last row shown, or after the whole window when every kept row was shown.
 */
export async function runPage(ctx: ToolContext, compiled: CompiledQuery): Promise<Page> {
  const res = await agilityClient(ctx).query<unknown[]>(compiled.body);
  const set = Array.isArray(res.data) ? res.data[0] : undefined;
  const raw = Array.isArray(set)
    ? set.filter((r): r is Row => r !== null && typeof r === 'object' && !Array.isArray(r))
    : [];
  const window = raw.slice(0, compiled.limit);
  const rows: Row[] = [];
  const positions: number[] = [];
  for (const [i, r] of window.entries()) {
    if (!inScope(ctx, compiled, r)) continue;
    sanitizeRow(ctx, compiled, r);
    rows.push(r);
    positions.push(i);
  }
  return {
    rows,
    hasMore: raw.length > compiled.limit,
    hidden: window.length - rows.length,
    next: (shown) =>
      compiled.offset + (shown >= rows.length ? window.length : (positions[shown - 1] ?? -1) + 1),
  };
}

/** A concrete type returned by a cross-type query must itself be readable in this workspace. */
async function readableType(ctx: ToolContext, type: string): Promise<boolean> {
  if (ctx.assetTypes.deny.includes(type)) return false;
  if (ctx.assetTypes.allow !== undefined && !ctx.assetTypes.allow.includes(type)) return false;
  const strategy = await metadataFor(ctx).scopeStrategy(type);
  return strategy.kind !== 'denied' && strategy.kind !== 'global';
}

/**
 * One asset by number (`B-01234`) or OID token (`Story:1234[:moment]`). Numbers use the instance's prefix map only as a
 * hint: one query against the hinted type, or across `Workitem` when the prefix is unknown or shared.
 */
export async function resolveAsset(
  ctx: ToolContext,
  text: string,
  fields: readonly string[] = [],
): Promise<ResolvedAsset> {
  const ref = parseAssetRef(text);
  const md = metadataFor(ctx);
  let input: QueryInput;
  let allowAbstract = false;
  if (ref.kind === 'oid') {
    const meta = await md.findAssetType(ref.assetType);
    if (meta === undefined) throw notFound(ref.oid);
    input = {
      assetType: meta.name,
      fields: [
        'AssetType',
        ...(meta.attributes.has('Number') ? ['Number'] : []),
        ...(meta.attributes.has('Name') ? ['Name'] : []),
        ...fields,
      ],
      filters: [{ field: 'ID', op: 'eq', value: ref.oid }],
    };
  } else {
    const hinted = await md.typesForPrefix(ref.prefix);
    const target = hinted.length === 1 ? (hinted[0] as string) : 'Workitem';
    allowAbstract = target === 'Workitem';
    input = {
      assetType: target,
      fields: ['AssetType', 'Number', 'Name', ...fields],
      filters: [{ field: 'Number', op: 'eq', value: ref.number }],
    };
  }
  const compiled = await compileQuery(ctx, { ...input, limit: 2, includeClosed: true }, { allowAbstract });
  const { rows } = await runQuery(ctx, compiled);
  const visible: Row[] = [];
  for (const r of rows) {
    const type = typeof r['AssetType'] === 'string' ? r['AssetType'] : compiled.assetType;
    if (await readableType(ctx, type)) visible.push(r);
  }
  if (visible.length === 0) throw notFound(ref.kind === 'oid' ? ref.oid : ref.number);
  if (visible.length > 1) {
    throw new AbError(
      ErrorCode.Ambiguous,
      `${ref.kind === 'number' ? ref.number : ref.oid} matches several assets.`,
      {
        hint: 'Pass the OID token of the one you mean.',
        details: {
          candidates: visible.map((r) => ({
            oid: stripMoment(r['_oid']),
            assetType: r['AssetType'],
            number: r['Number'],
          })),
        },
      },
    );
  }
  const row = visible[0] as Row;
  return {
    oid: stripMoment(row['_oid']),
    assetType: typeof row['AssetType'] === 'string' ? row['AssetType'] : compiled.assetType,
    ...(typeof row['Number'] === 'string' ? { number: row['Number'] } : {}),
    ...(typeof row['Name'] === 'string' ? { name: row['Name'] } : {}),
    row,
  };
}

interface NameQuery {
  readonly what: string;
  readonly assetType: string;
  readonly text: string;
  readonly allowGlobal?: boolean;
  readonly filters?: readonly FilterInput[];
  readonly fields?: readonly string[];
  /** The attribute holding the name (default `Name`). */
  readonly nameField?: string;
}

const OID_TOKEN = /^[A-Za-z][A-Za-z0-9_]*:\d{1,12}$/;

/**
 * A named asset: an OID token of the type is checked and returned; a name is looked up exactly, then by its longest
 * word (Agility splits bound values at commas, so names with commas are matched locally), then matched (L-036).
 */
export async function resolveByName(ctx: ToolContext, q: NameQuery): Promise<Named & { readonly row: Row }> {
  const text = q.text.trim();
  if (text === '' || text.length > 200)
    throw new AbError(ErrorCode.InputInvalid, `Give a ${q.what} name or OID token (1 to 200 characters).`);
  const nameField = q.nameField ?? 'Name';
  const fields = [...new Set([nameField, ...(q.fields ?? [])])];
  const run = async (filters: FilterInput[], limit: number) => {
    const compiled = await compileQuery(
      ctx,
      { assetType: q.assetType, fields, filters: [...(q.filters ?? []), ...filters], limit },
      { allowGlobal: q.allowGlobal === true },
    );
    return (await runQuery(ctx, compiled)).rows;
  };
  const named = (rows: Row[]) =>
    rows.flatMap((r) =>
      typeof r[nameField] === 'string'
        ? [{ oid: stripMoment(r['_oid']), name: r[nameField] as string, row: r }]
        : [],
    );
  if (OID_TOKEN.test(text) && text.startsWith(`${q.assetType}:`)) {
    const [row] = named(await run([{ field: 'ID', op: 'eq', value: text }], 1));
    if (row === undefined) throw notFound(text);
    return row;
  }
  let items = text.includes(',') ? [] : named(await run([{ field: nameField, op: 'eq', value: text }], 10));
  let result = matchName(text, items);
  if (result.kind !== 'match') {
    const word = text
      .split(/[\s,]+/)
      .filter((w) => w.length >= 2)
      .sort((a, b) => b.length - a.length)[0];
    if (word !== undefined) {
      items = named(await run([{ field: nameField, op: 'contains', value: word }], 50));
      result = matchName(text, items);
    }
    if (result.kind !== 'match' && result.kind !== 'ambiguous' && result.candidates.length === 0) {
      // A typo shares no word: score the first names in the workspace instead of giving up (still never auto-picked).
      items = named(await run([], 50));
      result = matchName(text, items);
    }
  }
  if (result.kind === 'match') return result.item;
  throw noSingleMatch(q.what, text, result);
}

export const resolveProject = (ctx: ToolContext, text: string): Promise<Named & { readonly row: Row }> =>
  resolveByName(ctx, { what: 'Agility project', assetType: 'Scope', text });

export const resolveTeam = (ctx: ToolContext, text: string): Promise<Named & { readonly row: Row }> =>
  resolveByName(ctx, { what: 'team', assetType: 'Team', text, allowGlobal: true });

/** A member by OID token, `me` (the token's own member), username, or name. */
export async function resolveMember(ctx: ToolContext, text: string): Promise<Named & { readonly row: Row }> {
  const t = text.trim();
  const fields = ['Name', 'Username'];
  if (t.toLowerCase() === 'me') {
    const compiled = await compileQuery(
      ctx,
      { assetType: 'Member', fields, filters: [{ field: 'IsSelf', op: 'eq', value: true }], limit: 1 },
      { allowGlobal: true },
    );
    const [row] = (await runQuery(ctx, compiled)).rows;
    if (row === undefined || typeof row['Name'] !== 'string') throw notFound('me');
    return { oid: stripMoment(row['_oid']), name: row['Name'], row };
  }
  if (!OID_TOKEN.test(t) && !t.includes(',') && !/\s/.test(t)) {
    try {
      return await resolveByName(ctx, {
        what: 'member',
        assetType: 'Member',
        text: t,
        allowGlobal: true,
        nameField: 'Username',
        fields,
      });
    } catch (error) {
      if (!(error instanceof AbError) || error.code !== ErrorCode.NotFound) throw error;
    }
  }
  return resolveByName(ctx, { what: 'member', assetType: 'Member', text: t, allowGlobal: true, fields });
}

export interface SprintOptions {
  /** A resolved team OID: only sprints with that team's work. */
  readonly team?: string;
  /** A resolved Agility project OID: only sprints of its schedule. */
  readonly project?: string;
}

/**
 * A sprint by OID token, name, or `current` / `previous` / `next` (by dates, UTC). Sprints of different schedules can
 * overlap: when the relative sprint differs per schedule the answer is AB_AMBIGUOUS, never a guess.
 */
export async function resolveSprint(
  ctx: ToolContext,
  text: string,
  options: SprintOptions = {},
): Promise<Named & { readonly row: Row }> {
  const t = text.trim().toLowerCase();
  const filters: FilterInput[] = [
    ...(options.team === undefined
      ? []
      : [{ field: 'Workitems.Team', op: 'eq' as const, value: options.team, trusted: true }]),
    ...(options.project === undefined
      ? []
      : [{ field: 'Schedule.ScheduledScopes', op: 'eq' as const, value: options.project, trusted: true }]),
  ];
  const fields = ['Name', 'BeginDate', 'EndDate', 'Schedule'];
  if (t !== 'current' && t !== 'previous' && t !== 'next') {
    return resolveByName(ctx, { what: 'sprint', assetType: 'Timebox', text, filters, fields });
  }
  const now = new Date(ctx.clock.now()).toISOString();
  const relative: Record<
    typeof t,
    { filters: FilterInput[]; sort: { field: string; direction: 'asc' | 'desc' } }
  > = {
    current: {
      filters: [
        { field: 'BeginDate', op: 'le', value: now },
        { field: 'EndDate', op: 'gt', value: now },
      ],
      sort: { field: 'BeginDate', direction: 'asc' },
    },
    previous: {
      filters: [{ field: 'EndDate', op: 'le', value: now }],
      sort: { field: 'EndDate', direction: 'desc' },
    },
    next: {
      filters: [{ field: 'BeginDate', op: 'gt', value: now }],
      sort: { field: 'BeginDate', direction: 'asc' },
    },
  };
  const spec = relative[t];
  const compiled = await compileQuery(ctx, {
    assetType: 'Timebox',
    fields,
    filters: [...filters, ...spec.filters],
    sort: [spec.sort],
    limit: 20,
    includeClosed: true,
  });
  const { rows } = await runQuery(ctx, compiled);
  // The closest sprint per schedule; several schedules means several answers.
  const perSchedule = new Map<string, Row>();
  for (const r of rows) {
    const schedule = oidsOf(r['Schedule'])[0] ?? '';
    if (!perSchedule.has(schedule) || t === 'current')
      perSchedule.set(t === 'current' ? stripMoment(r['_oid']) : schedule, r);
  }
  const picked = [...perSchedule.values()].filter((r) => typeof r['Name'] === 'string');
  if (picked.length === 1) {
    const row = picked[0] as Row;
    return { oid: stripMoment(row['_oid']), name: row['Name'] as string, row };
  }
  if (picked.length === 0) {
    throw new AbError(ErrorCode.NotFound, `There is no ${t} sprint visible in this workspace.`, {
      hint:
        t === 'current'
          ? 'No sprint spans today; ask for "previous" or "next", or name the sprint.'
          : 'Name the sprint instead.',
    });
  }
  throw new AbError(ErrorCode.Ambiguous, `Several ${t} sprints overlap in this workspace.`, {
    hint: 'Pass the team or the Agility project, or the sprint’s OID token.',
    details: {
      candidates: picked.slice(0, 5).map((r) => ({
        oid: stripMoment(r['_oid']),
        name: r['Name'],
        beginDate: r['BeginDate'],
        endDate: r['EndDate'],
      })),
    },
  });
}

/** A status of an asset type by name or OID token, from the instance's list (L-142). */
export async function resolveStatus(ctx: ToolContext, assetType: string, text: string): Promise<StatusEntry> {
  const statuses = await metadataFor(ctx).statuses(assetType);
  const t = text.trim();
  const byOid = statuses.find((s) => s.oid === t);
  if (byOid !== undefined) return byOid;
  const active = statuses.filter((s) => !s.inactive);
  let result = matchName(t, active);
  if (result.kind !== 'match') result = matchName(t, statuses);
  if (result.kind === 'match') return result.item;
  throw noSingleMatch(`${assetType} status`, t, result);
}
