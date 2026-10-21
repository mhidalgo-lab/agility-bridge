// SPDX-License-Identifier: Apache-2.0
// Rows of the generic tools: identity columns first (L-043), then one key per requested attribute path, with relation
// values as OID tokens and zoned dates in UTC. Values stay Agility text; the shaper envelopes and cuts them.

import type { ToolContext } from '../../context.ts';
import { oidsOf } from '../../identity/scope.ts';
import type { AttributeKind } from '../../metadata/model.ts';
import { metadataFor } from '../../metadata/service.ts';
import { assetState } from '../../output/result.ts';
import { utcIso } from '../../output/text.ts';

export const IDENTITY_FIELDS = ['Number', 'AssetState', 'Scope', 'Scope.Name'] as const;

function value(raw: unknown, kind: AttributeKind | undefined): unknown {
  if (raw === null || raw === undefined) return undefined;
  if (kind === 'Relation') {
    const oids = oidsOf(raw);
    return Array.isArray(raw) ? oids : oids[0];
  }
  if (kind === 'Date' && typeof raw === 'string') return utcIso(raw) ?? raw;
  // Agility answers numbers, aggregations included, as strings in query.v1 JSON (live, P1-16).
  if (
    (kind === 'Numeric' || kind === 'LongInt' || kind === 'Rank') &&
    typeof raw === 'string' &&
    raw.trim() !== '' &&
    Number.isFinite(Number(raw))
  ) {
    return Number(raw);
  }
  if (Array.isArray(raw)) return raw.map((v) => value(v, kind)).filter((v) => v !== undefined);
  return raw;
}

export interface FieldInfo {
  readonly kinds: ReadonlyMap<string, AttributeKind>;
  /** Fields holding rich text (HTML), converted by the shaper. */
  readonly richText: readonly string[];
}

/** The kind of every selected path, for value normalisation and rich-text conversion. */
export async function fieldInfo(
  ctx: ToolContext,
  type: string,
  fields: readonly string[],
): Promise<FieldInfo> {
  const md = metadataFor(ctx);
  const kinds = new Map<string, AttributeKind>();
  for (const f of fields) kinds.set(f, (await md.resolvePath(type, f)).kind);
  return { kinds, richText: fields.filter((f) => kinds.get(f) === 'LongText') };
}

/** One row as the generic tools return it. */
export function toItem(
  row: Readonly<Record<string, unknown>>,
  type: string,
  fields: readonly string[],
  info: FieldInfo,
  /** The response key of each field (aggregations are keyed by their bracket-filtered select, live P1-16). */
  keys: Readonly<Record<string, string>> = {},
): Record<string, unknown> {
  const project = oidsOf(row['Scope'])[0];
  const projectName = row['Scope.Name'];
  const item: Record<string, unknown> = {
    ...(typeof row['Number'] === 'string' ? { number: row['Number'] } : {}),
    assetType: typeof row['AssetType'] === 'string' ? row['AssetType'] : type,
    oid: oidsOf(row['_oid'])[0] ?? '',
    ...(row['AssetState'] === undefined ? {} : { state: assetState(row['AssetState'], type) }),
    ...(project === undefined
      ? {}
      : { project: { oid: project, ...(typeof projectName === 'string' ? { name: projectName } : {}) } }),
  };
  for (const f of fields) {
    const v = value(row[keys[f] ?? f], info.kinds.get(f));
    if (v !== undefined) item[f] = v;
  }
  return item;
}
