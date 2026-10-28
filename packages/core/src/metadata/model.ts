// SPDX-License-Identifier: Apache-2.0
// The instance's asset model from meta.v1 JSON (P1-03). Only identifiers are kept, each checked against a strict
// pattern; display names and descriptions are dropped because metadata strings are untrusted and administrators can
// edit them (THREAT_MODEL A12).
import { AbError, ErrorCode } from '../errors.ts';

export const ATTRIBUTE_KINDS = [
  'AssetType',
  'Boolean',
  'Date',
  'LongInt',
  'LocalizerTag',
  'LongText',
  'Numeric',
  'Opaque',
  'Rank',
  'Relation',
  'State',
  'Text',
] as const;

/** `AttributeType` from meta.v1 (P1-03 live probe); anything else is `unknown`. */
export type AttributeKind = (typeof ATTRIBUTE_KINDS)[number] | 'unknown';

export interface AttributeMeta {
  readonly name: string;
  readonly kind: AttributeKind;
  readonly multi: boolean;
  readonly custom: boolean;
  readonly readOnly: boolean;
  readonly required: boolean;
  /** For relations: the asset type the relation points to. */
  readonly relatedType?: string;
}

export interface AssetTypeMeta {
  readonly name: string;
  readonly base?: string;
  readonly abstract: boolean;
  readonly attributes: ReadonlyMap<string, AttributeMeta>;
  readonly operations: ReadonlySet<string>;
}

export const ASSET_TYPE_NAME_RE: RegExp = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** The letters before the dash of an Agility number (`S` in `S-01054`): what an owner may configure per asset type. */
export const NUMBER_PREFIX_RE: RegExp = /^[A-Z]{1,4}$/;
export const ATTRIBUTE_NAME_RE: RegExp = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;
const KINDS = new Set<string>(ATTRIBUTE_KINDS);

function malformed(what: string): AbError {
  return new AbError(ErrorCode.AgilityError, `Agility returned metadata that could not be read (${what}).`, {
    localDetails: true,
  });
}

const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

function nameref(v: unknown): string | undefined {
  const n = record(v)?.['nameref'];
  return typeof n === 'string' && ASSET_TYPE_NAME_RE.test(n) ? n : undefined;
}

/** One `meta.v1/<Type>` JSON body. Attributes or operations with unusable names are skipped, not trusted. */
export function parseAssetType(json: unknown): AssetTypeMeta {
  const body = record(json);
  if (body === undefined) throw malformed('not an object');
  // The type's name is its `Token`; `Name` is a reference to the type's Name attribute (live, P1-03).
  const name = typeof body['Token'] === 'string' ? body['Token'] : body['Name'];
  if (typeof name !== 'string' || !ASSET_TYPE_NAME_RE.test(name)) throw malformed('no valid asset type name');
  const attributes = new Map<string, AttributeMeta>();
  for (const raw of Object.values(record(body['Attributes']) ?? {})) {
    const a = record(raw);
    const attr = a?.['Name'];
    if (a === undefined || typeof attr !== 'string' || !ATTRIBUTE_NAME_RE.test(attr)) continue;
    const kind =
      typeof a['AttributeType'] === 'string' && KINDS.has(a['AttributeType'])
        ? (a['AttributeType'] as AttributeKind)
        : 'unknown';
    const relatedType = nameref(a['RelatedAsset']);
    attributes.set(attr, {
      name: attr,
      kind,
      multi: a['IsMultivalue'] === true,
      custom: a['IsCustom'] === true || attr.startsWith('Custom_'),
      readOnly: a['IsReadOnly'] === true,
      required: a['IsRequired'] === true,
      ...(relatedType === undefined ? {} : { relatedType }),
    });
  }
  const operations = new Set<string>();
  for (const raw of Object.values(record(body['Operations']) ?? {})) {
    const op = record(raw)?.['Name'];
    if (typeof op === 'string' && ATTRIBUTE_NAME_RE.test(op)) operations.add(op);
  }
  const base = nameref(body['Base']);
  return {
    name,
    abstract: body['Abstract'] === true,
    attributes,
    operations,
    ...(base === undefined ? {} : { base }),
  };
}

const ATTRIBUTE_KEYS = ['name', 'kind', 'multi', 'custom', 'readOnly', 'required', 'relatedType'] as const;

/** The parsed asset type as plain JSON (for a store that outlives the isolate, P6-39). */
export function serializeAssetType(meta: AssetTypeMeta): string {
  return JSON.stringify({
    name: meta.name,
    abstract: meta.abstract,
    ...(meta.base === undefined ? {} : { base: meta.base }),
    attributes: [...meta.attributes.values()].map((a) => ATTRIBUTE_KEYS.map((k) => a[k] ?? null)),
    operations: [...meta.operations],
  });
}

/**
 * Reads what `serializeAssetType` wrote, checking every identifier again (a store is not trusted more than Agility).
 * Returns undefined for anything that does not fit, so the caller fetches from Agility instead.
 */
export function deserializeAssetType(text: string): AssetTypeMeta | undefined {
  try {
    const b = record(JSON.parse(text));
    if (b === undefined || typeof b['name'] !== 'string' || !ASSET_TYPE_NAME_RE.test(b['name']))
      return undefined;
    if (
      typeof b['abstract'] !== 'boolean' ||
      !Array.isArray(b['attributes']) ||
      !Array.isArray(b['operations'])
    )
      return undefined;
    if (b['base'] !== undefined && (typeof b['base'] !== 'string' || !ASSET_TYPE_NAME_RE.test(b['base'])))
      return undefined;
    const attributes = new Map<string, AttributeMeta>();
    for (const row of b['attributes'] as unknown[]) {
      if (!Array.isArray(row)) return undefined;
      const [name, kind, multi, custom, readOnly, required, relatedType] = row as unknown[];
      if (
        typeof name !== 'string' ||
        !ATTRIBUTE_NAME_RE.test(name) ||
        typeof kind !== 'string' ||
        !(KINDS.has(kind) || kind === 'unknown') ||
        typeof multi !== 'boolean' ||
        typeof custom !== 'boolean' ||
        typeof readOnly !== 'boolean' ||
        typeof required !== 'boolean' ||
        (relatedType !== null && (typeof relatedType !== 'string' || !ASSET_TYPE_NAME_RE.test(relatedType)))
      )
        return undefined;
      attributes.set(name, {
        name,
        kind: kind as AttributeKind,
        multi,
        custom,
        readOnly,
        required,
        ...(typeof relatedType === 'string' ? { relatedType } : {}),
      });
    }
    const operations = new Set<string>();
    for (const op of b['operations'] as unknown[]) {
      if (typeof op !== 'string' || !ATTRIBUTE_NAME_RE.test(op)) return undefined;
      operations.add(op);
    }
    return {
      name: b['name'],
      abstract: b['abstract'],
      attributes,
      operations,
      ...(typeof b['base'] === 'string' ? { base: b['base'] } : {}),
    };
  } catch {
    return undefined;
  }
}
