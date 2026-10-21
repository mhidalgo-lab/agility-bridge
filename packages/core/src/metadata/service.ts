// SPDX-License-Identifier: Apache-2.0
// The metadata service (P1-03, ARCHITECTURE §6.2): asset types, attribute paths, number prefixes, status lists, field
// tiers and scope strategies per instance, so every request can be validated before it is sent (L-138). The host owns
// one MetadataService per process; its cache holds instance schemas, never request data (T21). Every fetch is made with
// the calling tool's context, so it is charged to that call's budget, and later calls reuse it.
import { agilityClient } from '../agility/client.ts';
import { type Clock, systemClock, type ToolContext } from '../context.ts';
import { AbError, ErrorCode, isAbError } from '../errors.ts';
import {
  ASSET_TYPE_NAME_RE,
  type AssetTypeMeta,
  ATTRIBUTE_NAME_RE,
  type AttributeKind,
  type AttributeMeta,
  parseAssetType,
} from './model.ts';

/** The rollup category of a status (reporting only, L-142). */
export type StatusCategory = 'not_started' | 'in_progress' | 'completed';

export interface StatusEntry {
  readonly oid: string;
  /** Untrusted: administrators name statuses. */
  readonly name: string;
  readonly order?: number;
  readonly inactive: boolean;
  readonly category?: StatusCategory;
  /** Set when the status belongs to one team's workflow. */
  readonly team?: string;
}

export interface FieldTiers {
  readonly minimal: readonly string[];
  readonly default: readonly string[];
  readonly full: readonly string[];
}

/** How a request for an asset type is kept inside the workspace's Agility projects (ARCHITECTURE §6.3). */
export type ScopeStrategy =
  | { readonly kind: 'direct'; readonly path: 'Scope' }
  | { readonly kind: 'derived'; readonly path: string }
  | { readonly kind: 'workspace_bounded'; readonly via: 'self' | 'schedule' }
  | { readonly kind: 'global' }
  | { readonly kind: 'denied' };

export interface ResolvedPath {
  /** The path as validated, e.g. `Owners.Name`, `Workitems:Story.Estimate`, `Children.@Count`. */
  readonly path: string;
  /** The attribute at the end of the path, or undefined for an aggregation. */
  readonly attribute?: AttributeMeta;
  /** The kind of the value the path selects (`Numeric` for aggregations). */
  readonly kind: AttributeKind;
  /** Whether the path can select several values (a multi-value relation on the way). */
  readonly multi: boolean;
  readonly aggregation?: Aggregation;
}

export type Aggregation = '@Count' | '@Sum' | '@Min' | '@Max' | '@Avg';
const AGGREGATIONS = new Set<string>(['@Count', '@Sum', '@Min', '@Max', '@Avg']);
const NUMERIC_KINDS = new Set<AttributeKind>(['Numeric', 'LongInt', 'Rank']);
/** Longest attribute path, in segments (`Scope.Parent.Name` is 3). */
export const MAX_PATH_SEGMENTS = 5;

/** Numbered asset types whose prefixes are discovered by sampling (L-141). */
export const NUMBERED_TYPES: readonly string[] = Object.freeze([
  'Story',
  'Defect',
  'Task',
  'Test',
  'Epic',
  'Issue',
  'Request',
  'Theme',
  'Goal',
  'TestSet',
  'RegressionTest',
  'RegressionPlan',
  'RegressionSuite',
]);

/**
 * Types reached through another asset (ARCHITECTURE §6.3). `Asset` and `Mentions` point at `BaseAsset`, which has no
 * `Scope`, so the paths downcast to `Workitem`: rows attached to anything else are outside every workspace. Paths are
 * validated against the instance's metadata before use; one that does not resolve denies the type. *unverified* live
 * until the tools that read these types (Phase 6).
 */
export const DERIVED_SCOPE_PATHS: Readonly<Record<string, string>> = Object.freeze({
  Attachment: 'Asset:Workitem.Scope',
  Link: 'Asset:Workitem.Scope',
  Actual: 'Workitem.Scope',
  Expression: 'Mentions:Workitem.Scope',
});

/** Global types tools may read through dedicated tools only (members, teams; list types are found by their base). */
const GLOBAL_TYPES = new Set(['Member', 'Team']);

export interface MetadataServiceOptions {
  /** How long a cached asset type is used before it is fetched again (default 1 hour, ADR-0011). */
  readonly ttlMs?: number;
  readonly clock?: Clock;
  /** Number prefixes per asset type that override discovery, per instance id: `{ env: { Story: 'S' } }`. */
  readonly prefixOverrides?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Field tiers per asset type that override the computed ones (paths validated on use). */
  readonly tierOverrides?: Readonly<Record<string, Partial<FieldTiers>>>;
}

interface Cached<T> {
  readonly value: T;
  readonly at: number;
}

interface InstanceCache {
  fingerprint?: string;
  readonly types: Map<string, Cached<AssetTypeMeta | null>>;
  readonly inflight: Map<string, Promise<AssetTypeMeta | null>>;
  prefixes?: Cached<ReadonlyMap<string, string>>;
  readonly statuses: Map<string, Cached<readonly StatusEntry[]>>;
}

function unknownType(name: string): AbError {
  return new AbError(ErrorCode.InputInvalid, `Unknown asset type "${name}" on this instance.`, {
    hint: 'Use describe_asset_type or list_asset_types to see the types this instance has.',
  });
}

function badPath(type: string, path: string, why: string): AbError {
  return new AbError(ErrorCode.InputInvalid, `Invalid attribute path "${path}" on ${type}: ${why}.`, {
    hint: 'Check the attribute names with describe_asset_type; relations are followed with "." (Owners.Name).',
  });
}

/** `RollupState` codes on status lists: AssetState-style lifecycle values. *unverified* beyond 0, 64 and 128. */
function category(code: unknown): StatusCategory | undefined {
  switch (Number(code)) {
    case 0:
      return 'not_started';
    case 64:
      return 'in_progress';
    case 128:
      return 'completed';
    default:
      return undefined;
  }
}

const PREFIX_RE = /^([A-Z]{1,4})-\d+$/;

/** Process-wide metadata for every configured instance. */
export class MetadataService {
  readonly #ttlMs: number;
  readonly #clock: Clock;
  readonly #options: MetadataServiceOptions;
  readonly #instances = new Map<string, InstanceCache>();

  constructor(options: MetadataServiceOptions = {}) {
    this.#ttlMs = options.ttlMs ?? 3_600_000;
    this.#clock = options.clock ?? systemClock;
    this.#options = options;
  }

  /** The metadata view for one tool call. */
  bind(ctx: ToolContext): InstanceMetadata {
    return new InstanceMetadata(this, ctx);
  }

  /** Drops everything cached for an instance (configuration changes, tests). */
  invalidate(instanceId: string): void {
    this.#instances.delete(instanceId);
  }

  /** @internal */
  cache(instanceId: string): InstanceCache {
    let c = this.#instances.get(instanceId);
    if (c === undefined) {
      c = { types: new Map(), inflight: new Map(), statuses: new Map() };
      this.#instances.set(instanceId, c);
    }
    return c;
  }

  /** @internal */
  fresh<T>(entry: Cached<T> | undefined): entry is Cached<T> {
    return entry !== undefined && this.#clock.now() - entry.at < this.#ttlMs;
  }

  /** @internal */
  now(): number {
    return this.#clock.now();
  }

  /** @internal */
  get options(): MetadataServiceOptions {
    return this.#options;
  }
}

/** The metadata service as one tool call sees it: every fetch uses (and is charged to) this call's context. */
export class InstanceMetadata {
  readonly #service: MetadataService;
  readonly #ctx: ToolContext;
  readonly #cache: InstanceCache;

  constructor(service: MetadataService, ctx: ToolContext) {
    this.#service = service;
    this.#ctx = ctx;
    this.#cache = service.cache(ctx.instance.id);
  }

  /** The asset type, or AB_INPUT_INVALID when the instance has no such type. */
  async assetType(name: string): Promise<AssetTypeMeta> {
    const meta = await this.findAssetType(name);
    if (meta === undefined) throw unknownType(name);
    return meta;
  }

  /** The asset type, or undefined when the instance has no such type. */
  async findAssetType(name: string): Promise<AssetTypeMeta | undefined> {
    if (!ASSET_TYPE_NAME_RE.test(name)) return undefined;
    const cached = this.#cache.types.get(name);
    if (this.#service.fresh(cached)) return cached.value ?? undefined;
    let pending = this.#cache.inflight.get(name);
    if (pending === undefined) {
      pending = this.#load(name).finally(() => this.#cache.inflight.delete(name));
      this.#cache.inflight.set(name, pending);
    }
    return (await pending) ?? undefined;
  }

  async #load(name: string): Promise<AssetTypeMeta | null> {
    let meta: AssetTypeMeta | null;
    let etag: string | undefined;
    try {
      const res = await agilityClient(this.#ctx).meta(name);
      etag = res.etag;
      meta = parseAssetType(res.data);
      if (meta.name !== name) meta = null;
    } catch (error) {
      // meta.v1 answers 404 for a type the instance does not have; remember that too.
      if (isAbError(error) && error.code === ErrorCode.NotFound) meta = null;
      else throw error;
    }
    if (etag !== undefined && this.#cache.fingerprint !== undefined && etag !== this.#cache.fingerprint) {
      // The schema changed: everything derived from the old one goes (L-053).
      this.#cache.types.clear();
      this.#cache.statuses.clear();
      delete this.#cache.prefixes;
    }
    if (etag !== undefined) this.#cache.fingerprint = etag;
    this.#cache.types.set(name, { value: meta, at: this.#service.now() });
    return meta;
  }

  /** The schema fingerprint last seen (`ETag` of meta.v1: `"<version>.<schema stamp>"`). */
  get fingerprint(): string | undefined {
    return this.#cache.fingerprint;
  }

  /** Whether `type` is `ancestor` or derives from it (walks `Base`, fetching base types as needed). */
  async isA(type: string, ancestor: string): Promise<boolean> {
    let current: string | undefined = type;
    for (let depth = 0; current !== undefined && depth < 10; depth++) {
      if (current === ancestor) return true;
      current = (await this.findAssetType(current))?.base;
    }
    return false;
  }

  /**
   * Validates an attribute path against the metadata: `.` follows relations, `Rel:Type` downcasts to a subtype of the
   * relation's target (L-148), and a final `@Count`/`@Sum`/`@Min`/`@Max`/`@Avg` aggregates a multi-value path.
   * Filters inside paths (`[...]`) are never accepted: the query compiler builds them (ADR-0012).
   */
  async resolvePath(type: string, path: string): Promise<ResolvedPath> {
    const segments = path.split('.');
    if (segments.length === 0 || segments.length > MAX_PATH_SEGMENTS) {
      throw badPath(type, path, `at most ${MAX_PATH_SEGMENTS} segments`);
    }
    let current = (await this.assetType(type)).name;
    let multi = false;
    let attribute: AttributeMeta | undefined;
    for (const [i, segment] of segments.entries()) {
      const last = i === segments.length - 1;
      // The attribute before an aggregation is the one aggregated, not a relation to follow.
      const lastAttribute = last || (segments[i + 1] ?? '').startsWith('@');
      if (segment.startsWith('@')) {
        if (!last || !AGGREGATIONS.has(segment))
          throw badPath(type, path, `"${segment}" is not an allowed aggregation`);
        if (!multi) throw badPath(type, path, 'aggregations need a multi-value relation');
        const aggregation = segment as Aggregation;
        if (aggregation !== '@Count' && (attribute === undefined || !NUMERIC_KINDS.has(attribute.kind))) {
          throw badPath(type, path, `${aggregation} needs a numeric attribute`);
        }
        if (aggregation === '@Count' && attribute?.kind !== 'Relation')
          throw badPath(type, path, '@Count follows a relation');
        return { path, kind: 'Numeric', multi: false, aggregation };
      }
      const [name = '', downcast, extra] = segment.split(':');
      if (
        extra !== undefined ||
        !ATTRIBUTE_NAME_RE.test(name) ||
        (downcast !== undefined && !ASSET_TYPE_NAME_RE.test(downcast))
      ) {
        throw badPath(type, path, `"${segment}" is not a valid segment`);
      }
      const owner = await this.assetType(current);
      attribute = owner.attributes.get(name);
      if (attribute === undefined) throw badPath(type, path, `${current} has no attribute "${name}"`);
      multi ||= attribute.multi;
      if (downcast !== undefined || !lastAttribute) {
        if (attribute.kind !== 'Relation' || attribute.relatedType === undefined) {
          throw badPath(type, path, `"${name}" is not a relation`);
        }
        let next = attribute.relatedType;
        if (downcast !== undefined) {
          if (!(await this.isA(downcast, attribute.relatedType))) {
            throw badPath(type, path, `${downcast} is not a kind of ${attribute.relatedType}`);
          }
          next = downcast;
        }
        current = next;
      }
    }
    if (attribute === undefined) throw badPath(type, path, 'empty');
    return { path, attribute, kind: attribute.kind, multi };
  }

  /**
   * Number prefixes per numbered type: configuration overrides first, then one `query.v1` call that samples one number
   * per type the instance has (L-141). A hint only: resolution by number always confirms with a query (P1-06).
   */
  async numberPrefixes(): Promise<ReadonlyMap<string, string>> {
    if (this.#service.fresh(this.#cache.prefixes)) return this.#cache.prefixes.value;
    const found = new Map<string, string>();
    const sample = async (types: readonly string[]) => {
      const res = await agilityClient(this.#ctx).query<unknown[][]>(
        types.map((t) => ({ from: t, select: ['Number'], sort: ['ID'], page: { start: 0, size: 1 } })),
      );
      for (const [i, t] of types.entries()) {
        const rows = Array.isArray(res.data) ? res.data[i] : undefined;
        const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
        const m = PREFIX_RE.exec(typeof row?.['Number'] === 'string' ? row['Number'] : '');
        if (m?.[1] !== undefined) found.set(t, m[1]);
      }
    };
    try {
      // One request on instances that have every numbered type (hosted 26.x does, P0-06).
      await sample(NUMBERED_TYPES);
    } catch (error) {
      if (!isAbError(error) || error.code !== ErrorCode.AgilityError) throw error;
      // An older or trimmed instance lacks a type: ask the metadata which ones exist, then sample those.
      const present: string[] = [];
      for (const t of NUMBERED_TYPES)
        if ((await this.findAssetType(t))?.attributes.has('Number')) present.push(t);
      if (present.length > 0) await sample(present);
    }
    for (const [t, p] of Object.entries(
      this.#service.options.prefixOverrides?.[this.#ctx.instance.id] ?? {},
    )) {
      if (/^[A-Z]{1,4}$/.test(p) && ASSET_TYPE_NAME_RE.test(t)) found.set(t, p);
    }
    this.#cache.prefixes = { value: found, at: this.#service.now() };
    return found;
  }

  /** The asset types whose numbers carry `prefix` (`B` → `['Story']`). */
  async typesForPrefix(prefix: string): Promise<readonly string[]> {
    const map = await this.numberPrefixes();
    return [...map].filter(([, p]) => p === prefix.toUpperCase()).map(([t]) => t);
  }

  /** The status list of an asset type, in order, from the instance (never hard-coded, L-142). */
  async statuses(type: string): Promise<readonly StatusEntry[]> {
    const cached = this.#cache.statuses.get(type);
    if (this.#service.fresh(cached)) return cached.value;
    const status = (await this.assetType(type)).attributes.get('Status');
    if (status?.kind !== 'Relation' || status.relatedType === undefined) {
      this.#cache.statuses.set(type, { value: [], at: this.#service.now() });
      return [];
    }
    const list = await this.assetType(status.relatedType);
    const select = ['Name', 'Order', 'Inactive', 'Team', 'RollupState'].filter((a) => list.attributes.has(a));
    const res = await agilityClient(this.#ctx).query<unknown[][]>({
      from: list.name,
      select,
      sort: list.attributes.has('Order') ? ['Order', 'ID'] : ['ID'],
      page: { start: 0, size: 200 },
    });
    const rows = Array.isArray(res.data?.[0]) ? (res.data[0] as Array<Record<string, unknown>>) : [];
    const value: StatusEntry[] = rows.flatMap((r) => {
      const oid = typeof r['_oid'] === 'string' ? r['_oid'] : undefined;
      if (oid === undefined || typeof r['Name'] !== 'string') return [];
      const order = Number(r['Order']);
      const cat = category(r['RollupState']);
      const team =
        r['Team'] !== null && typeof r['Team'] === 'object'
          ? (r['Team'] as { _oid?: unknown })._oid
          : r['Team'];
      return [
        {
          oid,
          name: r['Name'],
          inactive: r['Inactive'] === true || r['Inactive'] === 'true',
          ...(Number.isFinite(order) && r['Order'] !== null ? { order } : {}),
          ...(cat === undefined ? {} : { category: cat }),
          ...(typeof team === 'string' && team !== '' && team !== 'NULL' ? { team } : {}),
        },
      ];
    });
    this.#cache.statuses.set(type, { value, at: this.#service.now() });
    return value;
  }

  /**
   * Field tiers from metadata (L-050): identity in `minimal`; status, owners, sprint, team, estimate and change date in
   * `default`; descriptions, effort and custom attributes in `full`, capped at `limits.maxFields`. Only attributes the
   * type has are listed; `.Name`/`.Number` on a relation rely on every asset having them. Overrides replace a tier.
   */
  async fieldTiers(type: string): Promise<FieldTiers> {
    const meta = await this.assetType(type);
    const has = (a: string) => meta.attributes.has(a.split('.')[0] ?? '');
    const pick = (paths: readonly string[]) => paths.filter(has);
    const changed = has('ChangeDateUTC') ? 'ChangeDateUTC' : 'ChangeDate';
    const created = has('CreateDateUTC') ? 'CreateDateUTC' : 'CreateDate';
    const minimal = pick(['Number', 'Name', 'AssetType', 'AssetState', 'Scope', 'Scope.Name']);
    const defaults = [
      ...minimal,
      ...pick([
        'Status.Name',
        'Owners.Name',
        'Timebox.Name',
        'Team.Name',
        'Estimate',
        'Super.Number',
        'Parent.Number',
        changed,
      ]),
    ];
    const custom = [...meta.attributes.values()]
      .filter((a) => a.custom && !a.multi)
      .map((a) => (a.kind === 'Relation' ? `${a.name}.Name` : a.name))
      .sort();
    const full = [
      ...defaults,
      ...pick([
        'Description',
        created,
        'ClosedDate',
        'DetailEstimate',
        'ToDo',
        'Actuals.Value.@Sum',
        'Priority.Name',
        'Source.Name',
      ]),
      ...custom,
    ].slice(0, this.#ctx.limits.maxFields);
    const computed: FieldTiers = { minimal, default: defaults, full: [...new Set(full)] };
    const override = this.#service.options.tierOverrides?.[type];
    if (override === undefined) return computed;
    const tiers = { ...computed, ...override };
    for (const path of new Set([...tiers.minimal, ...tiers.default, ...tiers.full]))
      await this.resolvePath(type, path);
    return tiers;
  }

  /** The scope strategy of an asset type (ARCHITECTURE §6.3); unclassified types are denied. */
  async scopeStrategy(type: string): Promise<ScopeStrategy> {
    const meta = await this.findAssetType(type);
    if (meta === undefined || meta.abstract) return { kind: 'denied' };
    if (meta.name === 'Scope') return { kind: 'workspace_bounded', via: 'self' };
    if (meta.name === 'Timebox') {
      return meta.attributes.get('Schedule')?.relatedType === 'Schedule'
        ? { kind: 'workspace_bounded', via: 'schedule' }
        : { kind: 'denied' };
    }
    const scope = meta.attributes.get('Scope');
    if (scope?.kind === 'Relation' && scope.relatedType === 'Scope' && !scope.multi)
      return { kind: 'direct', path: 'Scope' };
    const derived = DERIVED_SCOPE_PATHS[meta.name];
    if (derived !== undefined) {
      try {
        const resolved = await this.resolvePath(meta.name, derived);
        if (resolved.attribute?.relatedType === 'Scope') return { kind: 'derived', path: derived };
      } catch (error) {
        if (!isAbError(error) || error.code !== ErrorCode.InputInvalid) throw error;
      }
      return { kind: 'denied' };
    }
    if (GLOBAL_TYPES.has(meta.name) || (await this.isA(meta.name, 'List'))) return { kind: 'global' };
    return { kind: 'denied' };
  }
}

/** The metadata view for a tool call; AB_INTERNAL when the host configured no metadata service. */
export function metadataFor(ctx: ToolContext): InstanceMetadata {
  if (ctx.metadata === undefined) throw new AbError(ErrorCode.Internal, 'No metadata service is configured.');
  return ctx.metadata.bind(ctx);
}
