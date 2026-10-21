// SPDX-License-Identifier: Apache-2.0
// The query compiler (P1-04, ADR-0012, ARCHITECTURE §6.3): structured read input → query.v1 JSON. Filter tokens are
// built only from validated attribute paths, allowlisted operators and server-owned variable names; every value a
// caller supplies reaches Agility in `with` (L-057, L-139), type-checked and without commas in scalars (L-162). The
// workspace's Agility-project restriction and the dead-asset exclusion are separate top-level filter entries, which
// query.v1 ANDs (verified live, P1-04), so no caller OR can widen them (L-059).
import type { ToolContext } from '../context.ts';
import { AbError, ErrorCode } from '../errors.ts';
import type { AttributeKind } from '../metadata/model.ts';
import { metadataFor, type ResolvedPath, type ScopeStrategy } from '../metadata/service.ts';
import { invalid, limitError } from './limits.ts';
import { parseInstant } from './time.ts';

export const FILTER_OPS = [
  'eq',
  'ne',
  'lt',
  'le',
  'gt',
  'ge',
  'contains',
  'in',
  'is_set',
  'is_not_set',
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export interface FilterInput {
  readonly field: string;
  readonly op: FilterOp;
  readonly value?: unknown;
}

export interface SortInput {
  readonly field: string;
  readonly direction?: 'asc' | 'desc' | undefined;
}

export interface QueryInput {
  readonly assetType: string;
  /** Attribute paths to select; default: the type's `default` field tier. */
  readonly fields?: readonly string[];
  /** ANDed filters. */
  readonly filters?: readonly FilterInput[];
  /** OR between groups, AND inside a group; the whole set is ANDed with `filters`. */
  readonly anyOf?: readonly (readonly FilterInput[])[];
  readonly sort?: readonly SortInput[];
  readonly limit?: number;
  /** Rows to skip (from a cursor). */
  readonly offset?: number;
  /** ISO 8601 UTC point in time (`asof`). */
  readonly asOf?: string;
  /** Include closed assets (dead ones never). */
  readonly includeClosed?: boolean;
}

export interface CompileOptions {
  /** Global types (members, teams, list types) are compiled only for dedicated tools or an explicit allowance. */
  readonly allowGlobal?: boolean;
  /**
   * Abstract types with a direct `Scope` (`Workitem`, `PrimaryWorkitem`) may be queried by server code that resolves
   * identifiers across types; every returned row's concrete `AssetType` is checked afterwards. Never from caller input.
   */
  readonly allowAbstract?: boolean;
  /** Server-owned selections (identity columns) validated like fields but exempt from the caller's field limit. */
  readonly identityFields?: readonly string[];
}

export interface CompiledQuery {
  /** The query.v1 body to send. */
  readonly body: Readonly<Record<string, unknown>>;
  readonly assetType: string;
  readonly strategy: ScopeStrategy;
  readonly limit: number;
  readonly offset: number;
  /** The selected paths, in order. */
  readonly fields: readonly string[];
  /** Server-added selections used to recheck each row's scope (L-064); not part of the caller's fields. */
  readonly recheck: readonly string[];
  /** The Agility projects rows may belong to (the allowed ones and, when enabled, their descendants); empty = all. */
  readonly scopes: readonly string[];
  /** The body with every bound value masked, for `_meta` and audit. */
  readonly masked: Readonly<Record<string, unknown>>;
  /** Canonical description of what the caller asked for, for the cursor binding. */
  readonly normalized: Readonly<Record<string, unknown>>;
}

const OPERATOR: Readonly<Record<'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge' | 'contains' | 'in', string>> = {
  eq: '=',
  ne: '!=',
  lt: '<',
  le: '<=',
  gt: '>',
  ge: '>=',
  contains: '~=',
  in: '=',
};
const ORDERED_KINDS = new Set<AttributeKind>(['Numeric', 'LongInt', 'Rank', 'Date', 'State']);
const TEXT_KINDS = new Set<AttributeKind>(['Text', 'LongText', 'LocalizerTag']);
const SORTABLE_KINDS = new Set<AttributeKind>([
  'Text',
  'LocalizerTag',
  'Numeric',
  'LongInt',
  'Rank',
  'Date',
  'State',
  'Boolean',
  'AssetType',
]);
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
const OID_RE = /^[A-Za-z][A-Za-z0-9_]*:\d{1,12}$/;
const SCOPE_OID_RE = /^Scope:\d{1,12}$/;
const STATE_CODES = new Set([0, 64, 128, 200, 208, 255]);
const MAX_TEXT_VALUE = 1_000;
const MAX_IN_VALUES = 50;
const MAX_FILTERS = 20;
const MAX_SORT = 3;
export const MAX_OFFSET = 100_000;
/** Server-owned variable names; caller values use `$v1`, `$v2`, … */
const SCOPE_VAR = '$ab_scope';
const STATE_VAR = '$ab_state';
const DELETED_VAR = '$ab_deleted';

class Binder {
  readonly with: Record<string, unknown> = {};
  #n = 0;
  bind(value: unknown): string {
    const name = `$v${++this.#n}`;
    this.with[name] = value;
    return name;
  }
}

/** Relation hops in a path: `Scope.Parent.Name` has 2 (L-058). */
function hops(path: string): number {
  return path.split('.').filter((s) => !s.startsWith('@')).length - 1;
}

function scalarValue(field: string, kind: AttributeKind, value: unknown, op: FilterOp): unknown {
  const bad = (why: string) => invalid(`Invalid value for ${field}: ${why}.`);
  if (TEXT_KINDS.has(kind)) {
    if (typeof value !== 'string') throw bad('expected text');
    if (value.length === 0 || value.length > MAX_TEXT_VALUE) throw bad(`1 to ${MAX_TEXT_VALUE} characters`);
    if (CONTROL_RE.test(value)) throw bad('control characters are not allowed');
    // Agility splits a bound scalar at commas into a value list (L-162).
    if (value.includes(','))
      throw bad(
        op === 'in'
          ? 'a value in the list contains a comma'
          : 'a comma would make it a list; use op "in" with an array',
      );
    return value;
  }
  switch (kind) {
    case 'Numeric':
    case 'LongInt':
    case 'Rank': {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw bad('expected a number');
      if (kind !== 'Numeric' && !Number.isInteger(value)) throw bad('expected an integer');
      return String(value);
    }
    case 'Boolean':
      if (typeof value !== 'boolean') throw bad('expected true or false');
      return String(value);
    case 'Date': {
      if (typeof value !== 'string') throw bad('expected a date');
      return new Date(parseInstant(value)).toISOString();
    }
    case 'State':
      if (typeof value !== 'number' || !STATE_CODES.has(value))
        throw bad('expected an AssetState code (0, 64, 128, 200, 208, 255)');
      return String(value);
    case 'AssetType':
      if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value))
        throw bad('expected an asset type name');
      return value;
    case 'Relation':
      // Subtypes are allowed (a Workitem relation matches Story:1), so only the OID form is checked.
      if (typeof value !== 'string' || !OID_RE.test(value))
        throw bad('expected an OID token such as Story:1234');
      return value;
    default:
      throw bad(`${kind} attributes cannot be filtered`);
  }
}

/** One filter as a token over a bound variable. */
async function compileFilter(
  ctx: ToolContext,
  type: string,
  f: FilterInput,
  binder: Binder,
): Promise<{ token: string; normalized: Record<string, unknown> }> {
  if (f === null || typeof f !== 'object' || typeof f.field !== 'string')
    throw invalid('Each filter needs a field.');
  if (!(FILTER_OPS as readonly string[]).includes(f.op)) {
    throw invalid(
      `Unknown filter operator "${String(f.op).slice(0, 20)}".`,
      `Use one of ${FILTER_OPS.join(', ')}.`,
    );
  }
  const resolved = await metadataFor(ctx).resolvePath(type, f.field);
  if (hops(resolved.path) > ctx.limits.maxNestingDepth) {
    throw limitError('maxNestingDepth', ctx.limits.maxNestingDepth, 'relation hops', hops(resolved.path));
  }
  const path = await sentPath(ctx, type, resolved);
  if (f.op === 'is_set' || f.op === 'is_not_set') {
    // Literal empty value: no caller text in the token (live: `Parent!=""` selects set relations, P0-12).
    return {
      token: `${path}${f.op === 'is_set' ? '!=' : '='}""`,
      normalized: { field: resolved.path, op: f.op },
    };
  }
  const kind = resolved.kind;
  if (['lt', 'le', 'gt', 'ge'].includes(f.op) && !ORDERED_KINDS.has(kind))
    throw invalid(`${f.field} cannot be compared with ${f.op}.`);
  if (f.op === 'contains' && !TEXT_KINDS.has(kind))
    throw invalid(`${f.field} is not text: contains needs a text attribute.`);
  let value: unknown;
  if (f.op === 'in') {
    if (!Array.isArray(f.value) || f.value.length === 0 || f.value.length > MAX_IN_VALUES) {
      throw invalid(`Filter "in" on ${f.field} needs an array of 1 to ${MAX_IN_VALUES} values.`);
    }
    value = f.value.map((v) => scalarValue(f.field, kind, v, f.op));
  } else {
    if (Array.isArray(f.value))
      throw invalid(`Filter ${f.op} on ${f.field} takes one value; use "in" for a list.`);
    value = scalarValue(f.field, kind, f.value, f.op);
  }
  const variable = binder.bind(value);
  return {
    token: `${path}${OPERATOR[f.op]}${variable}`,
    normalized: { field: resolved.path, op: f.op, value },
  };
}

/**
 * The path as sent: an aggregation over one relation gets a server-built bracket filter that drops dead assets of the
 * relation's target type (`Children[AssetState!='Dead'].@Count`, `Actuals[IsDeleted='false'].Value.@Sum`), because
 * aggregations include them otherwise (L-143). Other paths are sent as validated.
 */
async function sentPath(ctx: ToolContext, type: string, resolved: ResolvedPath): Promise<string> {
  if (resolved.aggregation === undefined) return resolved.path;
  const [relation = '', ...rest] = resolved.path.split('.');
  if (rest.length !== (resolved.aggregation === '@Count' ? 1 : 2) || relation.includes(':')) {
    throw invalid(
      `Aggregations follow one relation: Rel.@Count or Rel.Attribute.@Sum (got ${resolved.path}).`,
    );
  }
  const md = metadataFor(ctx);
  const target = (await md.assetType(type)).attributes.get(relation)?.relatedType;
  const targetMeta = target === undefined ? undefined : await md.findAssetType(target);
  const live = targetMeta?.attributes.has('AssetState')
    ? "[AssetState!='Dead']"
    : targetMeta?.attributes.get('IsDeleted')?.kind === 'Boolean'
      ? "[IsDeleted='false']"
      : '';
  return [`${relation}${live}`, ...rest].join('.');
}

/** The Agility-project restriction for one strategy, over `$ab_scope`: the allowed projects and their descendants. */
function scopeToken(strategy: ScopeStrategy): string | undefined {
  switch (strategy.kind) {
    case 'direct':
    case 'derived':
      return `${strategy.path}=${SCOPE_VAR}`;
    case 'workspace_bounded':
      return strategy.via === 'self' ? `ID=${SCOPE_VAR}` : `Schedule.ScheduledScopes=${SCOPE_VAR}`;
    default:
      return undefined;
  }
}

/** The selections that let `inScope` recheck a row (server-owned, exempt from the caller's field limits). */
export function recheckFields(strategy: ScopeStrategy): string[] {
  switch (strategy.kind) {
    case 'direct':
    case 'derived':
      return [strategy.path];
    case 'workspace_bounded':
      return strategy.via === 'self' ? [] : ['Schedule.ScheduledScopes'];
    default:
      return [];
  }
}

function forbidden(message: string): AbError {
  return new AbError(ErrorCode.AuthForbidden, message, {
    hint: 'Ask the workspace administrator to allow this asset type, or use a dedicated tool.',
  });
}

/** Compiles one read. Every metadata lookup is charged to this call's budget. */
export async function compileQuery(
  ctx: ToolContext,
  input: QueryInput,
  options: CompileOptions = {},
): Promise<CompiledQuery> {
  const md = metadataFor(ctx);
  const { limits } = ctx;
  const meta = await md.assetType(input.assetType);
  const type = meta.name;
  if (
    ctx.assetTypes.deny.includes(type) ||
    (ctx.assetTypes.allow !== undefined && !ctx.assetTypes.allow.includes(type))
  ) {
    throw forbidden(`Asset type ${type} is not allowed in this workspace.`);
  }
  let strategy = await md.scopeStrategy(type);
  if (strategy.kind === 'denied' && meta.abstract && options.allowAbstract === true) {
    const scope = meta.attributes.get('Scope');
    if (scope?.kind === 'Relation' && scope.relatedType === 'Scope' && !scope.multi)
      strategy = { kind: 'direct', path: 'Scope' };
  }
  if (strategy.kind === 'denied')
    throw forbidden(`Asset type ${type} cannot be read through agility-bridge.`);
  if (strategy.kind === 'global' && options.allowGlobal !== true) {
    throw forbidden(
      `Asset type ${type} is global (not tied to an Agility project) and needs an explicit workspace allowance.`,
    );
  }

  // Fields (L-058: every part of the query counts against the limits).
  const requestedFields = input.fields ?? (await md.fieldTiers(type)).default;
  const fields = [...new Set(requestedFields)];
  if (fields.length === 0) throw invalid('Select at least one field.');
  if (fields.length > limits.maxFields)
    throw limitError('maxFields', limits.maxFields, 'fields', fields.length);
  const select: string[] = [];
  let aggregations = 0;
  for (const field of fields) {
    const resolved = await md.resolvePath(type, field);
    if (hops(resolved.path) > limits.maxNestingDepth) {
      throw limitError('maxNestingDepth', limits.maxNestingDepth, 'relation hops', hops(resolved.path));
    }
    if (resolved.aggregation !== undefined) aggregations++;
    select.push(await sentPath(ctx, type, resolved));
  }
  const filters = input.filters ?? [];
  const groups = input.anyOf ?? [];
  if (filters.length + groups.reduce((n, g) => n + g.length, 0) > MAX_FILTERS) {
    throw limitError(
      'maxFilters',
      MAX_FILTERS,
      'filters',
      filters.length + groups.reduce((n, g) => n + g.length, 0),
    );
  }
  if (groups.length > limits.maxAnyOfGroups)
    throw limitError('maxAnyOfGroups', limits.maxAnyOfGroups, 'groups', groups.length);

  // Caller filters: one entry each (ANDed), and the any_of groups together in one parenthesised entry.
  const binder = new Binder();
  const filterEntries: string[] = [];
  const normalizedFilters: Record<string, unknown>[] = [];
  for (const f of filters) {
    const c = await compileFilter(ctx, type, f, binder);
    if (c.token.includes('.@')) aggregations++;
    filterEntries.push(c.token);
    normalizedFilters.push(c.normalized);
  }
  const normalizedGroups: Record<string, unknown>[][] = [];
  if (groups.length > 0) {
    const parts: string[] = [];
    for (const group of groups) {
      if (!Array.isArray(group) || group.length === 0)
        throw invalid('Each any_of group needs at least one filter.');
      const tokens: string[] = [];
      const normalized: Record<string, unknown>[] = [];
      for (const f of group) {
        const c = await compileFilter(ctx, type, f, binder);
        if (c.token.includes('.@')) aggregations++;
        tokens.push(c.token);
        normalized.push(c.normalized);
      }
      parts.push(`(${tokens.join(';')})`);
      normalizedGroups.push(normalized);
    }
    filterEntries.push(`(${parts.join('|')})`);
  }
  if (aggregations > limits.maxAggregations)
    throw limitError('maxAggregations', limits.maxAggregations, 'aggregations', aggregations);

  // Server-owned predicates, each its own top-level entry (ANDed by query.v1).
  const serverEntries: string[] = [];
  const serverWith: Record<string, unknown> = {};
  const allowed = ctx.projects.allowed;
  for (const s of allowed) {
    if (!SCOPE_OID_RE.test(s))
      throw new AbError(ErrorCode.Internal, 'Invalid Agility project in the workspace configuration.');
  }
  const restricted = allowed.length > 0 && strategy.kind !== 'global';
  const scopes = !restricted
    ? []
    : ctx.projects.includeChildren
      ? await md.projectTree(allowed)
      : [...allowed];
  if (restricted && scopes.length === 0) {
    throw new AbError(
      ErrorCode.AuthForbidden,
      "None of the workspace's Agility projects is visible with this token.",
      {
        hint: 'Check the workspace configuration and that the member behind the token can see those projects.',
      },
    );
  }
  if (restricted) {
    const token = scopeToken(strategy);
    if (token !== undefined) {
      serverEntries.push(token);
      serverWith[SCOPE_VAR] = [...scopes];
    }
  }
  if (meta.attributes.has('AssetState')) {
    // Dead (template, broken down, deleted) never; closed only when asked (L-143).
    serverEntries.push(`AssetState=${STATE_VAR}`);
    serverWith[STATE_VAR] = input.includeClosed === true ? ['0', '64', '128'] : ['0', '64'];
  } else if (meta.attributes.get('IsDeleted')?.kind === 'Boolean') {
    serverEntries.push(`IsDeleted=${DELETED_VAR}`);
    serverWith[DELETED_VAR] = 'false';
  }

  // Sort: stable, ending with ID (L-163); ChangeDate sorts are allowed but cost about 1.1 s.
  const sortInput = input.sort ?? [];
  if (sortInput.length > MAX_SORT)
    throw limitError('maxSortFields', MAX_SORT, 'sort fields', sortInput.length);
  const sort: string[] = [];
  for (const s of sortInput) {
    const resolved = await md.resolvePath(type, s.field);
    if (resolved.multi || resolved.aggregation !== undefined || !SORTABLE_KINDS.has(resolved.kind)) {
      throw invalid(
        `Cannot sort by ${s.field}.`,
        'Sort by a single-value attribute (Name, Estimate, ChangeDateUTC, …).',
      );
    }
    if (s.direction !== undefined && s.direction !== 'asc' && s.direction !== 'desc')
      throw invalid('Sort direction is asc or desc.');
    sort.push(`${s.direction === 'desc' ? '-' : ''}${resolved.path}`);
  }
  if (!sort.some((s) => s.replace(/^-/, '') === 'ID')) sort.push('ID');

  // Page: explicit, limit + 1 to learn "more available" (Agility returns no totals).
  const limit = input.limit ?? limits.defaultRows;
  if (!Number.isInteger(limit) || limit < 1) throw invalid('limit must be a positive integer.');
  if (limit > limits.maxRows) throw limitError('maxRows', limits.maxRows, 'rows', limit);
  const offset = input.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET)
    throw invalid('The cursor is out of range.');

  let asof: string | undefined;
  if (input.asOf !== undefined) {
    const t = parseInstant(input.asOf);
    const now = ctx.clock.now();
    if (t > now) throw invalid('as_of is in the future.');
    const ageDays = (now - t) / 86_400_000;
    if (ageDays > limits.maxAsOfAgeDays)
      throw limitError('maxAsOfAgeDays', limits.maxAsOfAgeDays, 'days', Math.ceil(ageDays));
    asof = new Date(t).toISOString();
  }

  const identity: string[] = [];
  for (const f of options.identityFields ?? []) {
    if (select.includes(f) || identity.includes(f)) continue;
    identity.push((await md.resolvePath(type, f)).path);
  }
  const recheck = restricted
    ? recheckFields(strategy).filter((f) => !select.includes(f) && !identity.includes(f))
    : [];
  const withValues = { ...binder.with, ...serverWith };
  const body: Record<string, unknown> = {
    from: type,
    select: [...select, ...identity, ...recheck],
    ...(filterEntries.length + serverEntries.length > 0
      ? { filter: [...serverEntries, ...filterEntries] }
      : {}),
    ...(Object.keys(withValues).length > 0 ? { with: withValues } : {}),
    sort,
    page: { start: offset, size: limit + 1 },
    ...(asof === undefined ? {} : { asof }),
  };
  const masked = {
    ...body,
    ...(body['with'] === undefined
      ? {}
      : { with: Object.fromEntries(Object.keys(withValues).map((k) => [k, '…'])) }),
  };
  const normalized = {
    assetType: type,
    fields,
    filters: normalizedFilters,
    anyOf: normalizedGroups,
    sort,
    includeClosed: input.includeClosed === true,
    ...(asof === undefined ? {} : { asOf: asof }),
  };
  return { body, assetType: type, strategy, limit, offset, fields, recheck, scopes, masked, normalized };
}
