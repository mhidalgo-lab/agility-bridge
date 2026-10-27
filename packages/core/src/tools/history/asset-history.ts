// SPDX-License-Identifier: Apache-2.0
// get_asset_history (P6-05, ADR-0011, L-060, L-146): what changed on one asset, from the authoritative `rest-1.v1/Hist`
// versions. The window and the limit are validated before any request; only the selected attributes are asked for and
// read; values are untrusted and leave through the output shaper.
import { z } from 'zod';
import { agilityClient } from '../../agility/client.ts';
import { capBudget, type ToolContext } from '../../context.ts';
import { resolveAsset } from '../../identity/resolve.ts';
import { metadataFor } from '../../metadata/service.ts';
import { assetState, shapeList, untrusted } from '../../output/result.ts';
import { cleanText, richText, utcIso } from '../../output/text.ts';
import { compileQuery } from '../../query/compiler.ts';
import { invalid, limitError } from '../../query/limits.ts';
import { parseTimeRange } from '../../query/time.ts';
import { defineTool, type ToolDefinition } from '../../tool.ts';
import { formatArg, limitArg } from '../common.ts';

const NAME = 'get_asset_history';
const COST = 14;
const MAX_FIELDS = 10;
const MAX_VERSIONS = 5_000;
const MAX_VALUE_CHARS = 500;
const DEFAULT_WINDOW = 'last 30 days';
/** Attributes shown when `fields` is omitted, limited to what the type has on this instance. */
const DEFAULT_FIELDS = [
  'Name',
  'Status.Name',
  'Owners.Name',
  'Estimate',
  'DetailEstimate',
  'ToDo',
  'Timebox.Name',
  'Team.Name',
  'Priority.Name',
  'AssetState',
] as const;

type Json = unknown;

interface Version {
  readonly moment: number;
  readonly at: number | undefined;
  readonly values: ReadonlyMap<string, Json>;
  readonly by: string | undefined;
}

interface Change {
  readonly field: string;
  readonly changedAt: string;
  readonly changedBy?: string;
  readonly from?: Json;
  readonly to: Json;
  readonly version: number;
}

/** One attribute value of a Hist row as a plain, comparable value (relations become OID tokens). */
export function historyValue(raw: unknown): Json {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw.map(historyValue);
  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const ref = o['idref'] ?? o['_oid'];
    return typeof ref === 'string' ? ref : null;
  }
  return raw;
}

const same = (a: Json, b: Json): boolean => JSON.stringify(a) === JSON.stringify(b);
const empty = (v: Json): boolean => v === null || v === '' || (Array.isArray(v) && v.length === 0);

function display(field: string, assetType: string, v: Json): Json {
  if (field === 'AssetState') return assetState(v, assetType);
  if (typeof v === 'string') {
    const t = richText(v);
    return t.length > MAX_VALUE_CHARS ? `${t.slice(0, MAX_VALUE_CHARS)}…` : t;
  }
  if (Array.isArray(v)) return v.map((x) => display(field, assetType, x));
  return v;
}

/** The versions of a Hist answer that belong to `oid`, oldest first (L-122: nothing else is trusted). */
function versions(data: unknown, oid: string, keys: ReadonlyMap<string, string>, atKey: string): Version[] {
  const assets = (data as { Assets?: unknown } | null)?.Assets;
  if (!Array.isArray(assets)) return [];
  const out: Version[] = [];
  for (const a of assets.slice(0, MAX_VERSIONS)) {
    if (a === null || typeof a !== 'object') continue;
    const row = a as { id?: unknown; Attributes?: Record<string, { value?: unknown } | undefined> };
    const id = typeof row.id === 'string' ? row.id : '';
    const m = /^([A-Za-z][A-Za-z0-9_]*:\d+):(\d+)$/.exec(id);
    if (m === null || m[1] !== oid) continue;
    const attrs = row.Attributes ?? {};
    const values = new Map<string, Json>();
    for (const [field, sent] of keys) values.set(field, historyValue(attrs[sent]?.value));
    const stamp = attrs[atKey]?.value;
    const iso = typeof stamp === 'string' ? utcIso(stamp) : undefined;
    const by = attrs['ChangedBy.Name']?.value;
    out.push({
      moment: Number(m[2]),
      at: iso === undefined ? undefined : Date.parse(iso),
      values,
      by: typeof by === 'string' && by !== '' ? cleanText(by).slice(0, 200) : undefined,
    });
  }
  return out.sort((x, y) => x.moment - y.moment);
}

export const getAssetHistory: ToolDefinition = defineTool({
  name: NAME,
  title: 'Get asset history',
  description:
    'What changed on one asset (work item or portfolio item) in a bounded window, from the authoritative Agility history: one row per changed field (status, owners, estimate, sprint, name, …) with who and when (UTC), from and to, newest first. Not paged. A cold call can make up to 14 Agility requests.',
  kind: 'read',
  group: 'history',
  // Capped at run time: metadata for the type and the resolver query, the project tree, one Hist request.
  cost: COST,
  inputSchema: z.object({
    asset: z.string().min(1).max(64).describe('Number (B-01234, D-00012, E-00007) or OID token.'),
    time_range: z
      .string()
      .min(1)
      .max(100)
      .default(DEFAULT_WINDOW)
      .describe(
        'Window (UTC, bounded by the workspace), e.g. "last 14 days", "since 2026-10-01", "2026-10-01 to 2026-10-15".',
      ),
    fields: z
      .array(z.string().min(1).max(200))
      .max(MAX_FIELDS)
      .optional()
      .describe(
        'Attribute paths to follow (at most 10); when omitted: name, status, owners, estimates, sprint, team, priority and state.',
      ),
    limit: limitArg,
    format: formatArg,
  }),
  outputSchema: z.looseObject({
    asset: z.looseObject({ assetType: z.string(), oid: z.string() }),
    window: z.looseObject({ since: z.string(), until: z.string() }),
    items: z.array(z.looseObject({ field: z.string() })),
    truncated: z.boolean().optional(),
    partial: z.boolean().optional(),
    notes: z.array(z.string()).optional(),
  }),
  handler: async (input, outer) => {
    const ctx: ToolContext = { ...outer, budget: capBudget(outer.budget, COST) };
    // Everything that bounds the request is checked before the first Agility request (L-060).
    const window = parseTimeRange(
      input.time_range ?? DEFAULT_WINDOW,
      ctx.clock.now(),
      ctx.limits.maxTimeRangeDays,
    );
    const limit = input.limit ?? ctx.limits.defaultRows;
    if (limit > ctx.limits.maxRows) throw limitError('maxRows', ctx.limits.maxRows, 'rows', limit);
    const requested = input.fields === undefined ? undefined : [...new Set(input.fields)];
    if (requested !== undefined) {
      const most = Math.min(MAX_FIELDS, ctx.limits.maxFields);
      if (requested.length === 0) throw invalid('fields needs at least one attribute path.');
      if (requested.length > most) throw limitError('maxFields', most, 'fields', requested.length);
      for (const f of requested) {
        if (/[@[\]]/.test(f)) throw invalid('History follows plain attributes, not aggregations or filters.');
      }
    }
    const since = Date.parse(window.since);
    const until = Date.parse(window.until);

    const md = metadataFor(ctx);
    const target = await resolveAsset(ctx, input.asset);
    const meta = await md.assetType(target.assetType);
    const has = (a: string) => meta.attributes.has(a.split('.')[0] as string);
    const atKey = has('ChangeDateUTC') ? 'ChangeDateUTC' : 'ChangeDate';
    const wanted = requested ?? DEFAULT_FIELDS.filter(has);
    if (wanted.length === 0) throw invalid(`${target.assetType} has no attributes this tool follows.`);

    // The compiler validates every path (metadata, hops, member emails, allow lists); nothing is sent for the query.
    const compiled = await compileQuery(ctx, {
      assetType: target.assetType,
      fields: wanted,
      filters: [{ field: 'ID', op: 'eq', value: target.oid }],
      limit: 1,
      includeClosed: true,
    });
    const guarded = new Set(compiled.guards.map((g) => g.key));
    const notes: string[] = [];
    const keys = new Map<string, string>();
    for (const field of wanted) {
      const sent = compiled.keys[field] as string;
      if (guarded.has(sent)) {
        if (requested !== undefined)
          throw invalid(
            `${field} reaches another asset that history cannot check against the workspace's projects.`,
            'Follow the attribute itself (for example Status.Name) or read it with query_assets.',
          );
        notes.push(`${field} was left out: it reaches an asset outside this tool's scope checks.`);
        continue;
      }
      keys.set(field, sent);
    }
    if (keys.size === 0) throw invalid('None of the requested attributes can be followed in history.');
    const selection = [
      ...new Set([...keys.values(), atKey, ...(has('ChangedBy') ? ['ChangedBy.Name'] : [])]),
    ];

    const res = await agilityClient(ctx).hist<unknown>(
      target.assetType,
      target.oid.split(':')[1] as string,
      selection,
    );
    const all = versions(res.data, target.oid, keys, atKey);
    const rawCount = (res.data as { Assets?: unknown[] } | null)?.Assets?.length ?? 0;
    if (rawCount > MAX_VERSIONS)
      notes.push(`Only the first ${MAX_VERSIONS} versions of this asset were read; later ones are missing.`);
    if (all.length === 0) notes.push('Agility returned no history versions for this asset.');

    const changes: Change[] = [];
    let unstamped = 0;
    let quiet = 0;
    let inWindow = 0;
    let previous: Version | undefined;
    for (const [i, v] of all.entries()) {
      const inside = v.at !== undefined && v.at >= since && v.at < until;
      if (v.at === undefined) unstamped++;
      if (inside) {
        inWindow++;
        let changed = 0;
        for (const [field, value] of v.values) {
          const before = previous?.values.get(field) ?? null;
          if (previous === undefined ? empty(value) : same(before, value)) continue;
          changed++;
          changes.push({
            field,
            changedAt: new Date(v.at as number).toISOString(),
            ...(v.by === undefined ? {} : { changedBy: v.by }),
            ...(previous === undefined ? {} : { from: display(field, target.assetType, before) }),
            to: display(field, target.assetType, value),
            version: i + 1,
          });
        }
        if (changed === 0) quiet++;
      }
      previous = v;
    }
    if (unstamped > 0)
      notes.push(
        `${unstamped} versions had no usable UTC timestamp and are neither shown nor counted in the window.`,
      );
    if (quiet > 0) notes.push(`${quiet} versions in the window changed none of the followed attributes.`);
    const firstAt = all[0]?.at;
    if (firstAt !== undefined && firstAt >= since && firstAt < until)
      notes.push('The window includes the first version: its rows show initial values (no "from").');
    // Newest version first; the fields of one version keep the order they were asked for.
    const ordered = [...changes].sort((a, b) => b.version - a.version);
    const shown = ordered.slice(0, limit);
    const rows = shown.map((c) => ({
      changedAt: c.changedAt,
      ...(c.changedBy === undefined ? {} : { changedBy: c.changedBy }),
      field: c.field,
      ...('from' in c ? { from: c.from } : {}),
      to: c.to,
      version: c.version,
    }));
    const out = shapeList(ctx, {
      summary: [
        `${changes.length} change${changes.length === 1 ? '' : 's'} on ${target.assetType} `,
        untrusted(target.number ?? target.oid),
        ` between ${window.since} and ${window.until} (${inWindow} of ${all.length} versions in the window), newest first.`,
      ],
      notes: [...notes, 'Source: the authoritative Agility history (Hist), not the activity stream.'],
      source: 'asset history',
      rows,
      columns: ['changedAt', 'changedBy', 'field', 'from', 'to', 'version'],
      hasMore: ordered.length > shown.length,
      ...(input.format === undefined ? {} : { format: input.format }),
      meta: { endpoint: 'rest-1.v1/Hist', window },
    });
    return {
      ...out,
      structured: {
        ...(out.structured as { items: Array<{ field: string }> }),
        asset: {
          assetType: target.assetType,
          oid: target.oid,
          ...(target.number === undefined ? {} : { number: target.number }),
        },
        window: { ...window },
        versions: { total: all.length, inWindow },
      },
    };
  },
});
