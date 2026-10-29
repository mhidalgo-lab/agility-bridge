// SPDX-License-Identifier: Apache-2.0
// What every wave-1 write tool shares (P7-04): resolving the one target inside the workspace, reading its current
// values (the plan and the re-read use the same read), the readable `Name [OID]` value form, the one send, and the
// conflict refusal. Nothing here sends a request except `postAsset`, and that is only called from a tool's `send`.
import { agilityClient } from '../../agility/client.ts';
import type { XmlElement } from '../../agility/xml.ts';
import type { ToolContext } from '../../context.ts';
import { AbError, ErrorCode } from '../../errors.ts';
import { resolveAsset, runQuery } from '../../identity/resolve.ts';
import { oidsOf } from '../../identity/scope.ts';
import { metadataFor } from '../../metadata/service.ts';
import { assetState } from '../../output/result.ts';
import { type CompiledQuery, compileQuery } from '../../query/compiler.ts';
import { invalid } from '../../query/limits.ts';
import type { WriteValue } from '../../writes/index.ts';
import { text } from '../common.ts';
import { assetXml, type XmlOp } from './asset-xml.ts';

type Row = Record<string, unknown>;

/** The work-item types the wave-1 tools may change. Epics have no sprint, effort or team workflow of their own. */
export const ITEM_TYPES = ['Story', 'Defect', 'Task', 'Test', 'Epic'] as const;

/** An asset type this workspace may not read or touch is refused before any request (T3, ADR-0013). */
export function assertTypeAllowed(ctx: ToolContext, type: string): void {
  if (
    ctx.assetTypes.deny.includes(type) ||
    (ctx.assetTypes.allow !== undefined && !ctx.assetTypes.allow.includes(type))
  ) {
    throw new AbError(ErrorCode.AuthForbidden, `Asset type ${type} is not allowed in this workspace.`, {
      hint: 'Ask the workspace owner to allow this asset type before writing to it.',
    });
  }
}

/** `Name [Member:20]`: readable for the person who approves, and the OID the hash binds. */
export const labelOf = (name: string, oid: string): string => `${name} [${oid}]`;
const LABEL_OID_RE = /\[([A-Za-z][A-Za-z0-9_]*:\d{1,12})\]$/;
export const oidOfLabel = (label: string): string => {
  const oid = LABEL_OID_RE.exec(label)?.[1];
  if (oid === undefined) throw new AbError(ErrorCode.Internal, 'A write value lost its OID.');
  return oid;
};

/** A relation value of a row as a label, or null when empty. `nameKey` holds the related asset's name. */
export function labelFrom(row: Readonly<Row>, field: string, nameKey = `${field}.Name`): string | null {
  const oid = oidsOf(row[field])[0];
  if (oid === undefined) return null;
  const name = text(row[nameKey]);
  return labelOf(name ?? oid, oid);
}

export interface Target {
  readonly assetType: string;
  readonly oid: string;
  readonly number?: string;
  /** Untrusted. */
  readonly name?: string;
  /** `ChangeDateUTC` (or `ChangeDate`): compared on the re-read. */
  readonly version?: string;
  readonly state: ReturnType<typeof assetState>;
  readonly row: Readonly<Row>;
  /** The value of a selected path (aggregations are keyed differently by the compiler). */
  get(field: string): unknown;
}

export interface TargetOptions {
  /** Types this tool may change; another type is refused. */
  readonly types: readonly string[];
  /** Attribute paths to read besides the identity and the change date; ones the type lacks are left out. */
  readonly fields?: readonly string[];
  /** A closed item may be commented on, but not changed otherwise. */
  readonly allowClosed?: boolean;
}

const notFound = (what: string): AbError =>
  new AbError(ErrorCode.NotFound, `${what} was not found or is not visible with this token.`, {
    hint: 'Check the number; the asset may also be outside the workspace’s Agility projects.',
  });

/** One read of the target's own row (scope rechecked, never a deleted asset). Undefined when it is not visible. */
export async function readTarget(
  ctx: ToolContext,
  assetType: string,
  oid: string,
  fields: readonly string[],
): Promise<Target | undefined> {
  const meta = await metadataFor(ctx).assetType(assetType);
  const has = (path: string): boolean => meta.attributes.has(path.split('.')[0] as string);
  const changed = meta.attributes.has('ChangeDateUTC') ? 'ChangeDateUTC' : 'ChangeDate';
  const wanted = [
    ...new Set(
      ['Number', 'Name', 'AssetState', 'Scope', changed, ...fields].filter((f) => has(f) && !f.includes('@')),
    ),
  ];
  const aggregates = fields.filter((f) => f.includes('@') && has(f));
  const compiled: CompiledQuery = await compileQuery(ctx, {
    assetType: meta.name,
    fields: [...wanted, ...aggregates],
    filters: [{ field: 'ID', op: 'eq', value: oid }],
    limit: 1,
    includeClosed: true,
  });
  const { rows } = await runQuery(ctx, compiled);
  const row = rows.find((r) => oidsOf(r['_oid'])[0] === oid);
  if (row === undefined) return undefined;
  const version = text(row[changed]);
  const number = text(row['Number']);
  const name = text(row['Name']);
  return {
    assetType: meta.name,
    oid,
    ...(number === undefined ? {} : { number }),
    ...(name === undefined ? {} : { name }),
    ...(version === undefined ? {} : { version }),
    state: assetState(row['AssetState'], meta.name),
    row,
    get: (field) => row[compiled.keys[field] ?? field],
  };
}

/**
 * Resolves the one target: by number or OID inside the workspace's projects (an asset outside answers like a missing
 * one), checks its type and state, and reads its current values. Throws `AbError` to refuse; sends nothing.
 */
export async function planTarget(ctx: ToolContext, ref: string, options: TargetOptions): Promise<Target> {
  const resolved = await resolveAsset(ctx, ref);
  if (!options.types.includes(resolved.assetType)) {
    throw invalid(
      `${resolved.number ?? resolved.oid} is a ${resolved.assetType}, which this tool does not change.`,
      `This tool changes: ${options.types.join(', ')}.`,
    );
  }
  assertTypeAllowed(ctx, resolved.assetType);
  const target = await readTarget(ctx, resolved.assetType, resolved.oid, options.fields ?? []);
  if (target === undefined) throw notFound(ref.slice(0, 60));
  checkState(target, options.allowClosed === true);
  return target;
}

function checkState(target: Target, allowClosed: boolean): void {
  const which = target.number ?? target.oid;
  if (target.state === 'deleted' || target.state === 'template' || target.state === 'broken_down') {
    throw invalid(`${which} is ${target.state.replace('_', ' ')}, so it cannot be changed.`);
  }
  if (target.state === 'closed' && !allowClosed) {
    throw invalid(
      `${which} is closed, so it cannot be changed with this tool.`,
      'Reopen it in Agility first, or add a comment instead.',
    );
  }
}

/** The target the re-read sees: gone, deleted or closed since the plan is a conflict, never a quiet success. */
export async function rereadTarget(
  ctx: ToolContext,
  type: string,
  oid: string,
  fields: readonly string[],
  allowClosed = false,
): Promise<Target> {
  const target = await readTarget(ctx, type, oid, fields);
  if (target === undefined || target.state === 'deleted' || (target.state === 'closed' && !allowClosed)) {
    throw conflict(target?.number ?? oid);
  }
  return target;
}

export const conflict = (which: string): AbError =>
  new AbError(
    ErrorCode.WriteConflict,
    `${which} is no longer available to change (removed, closed or out of scope), so nothing was changed.`,
    { hint: 'Read the item again, make a new plan with dry_run: true, and ask for approval again.' },
  );

/** The attribute must exist on the type, be of the expected shape and be writable on this instance. */
export async function requireWritable(
  ctx: ToolContext,
  type: string,
  attribute: string,
  shape: { readonly relation?: boolean; readonly multi?: boolean } = {},
): Promise<void> {
  const meta = await metadataFor(ctx).assetType(type);
  const a = meta.attributes.get(attribute);
  if (a === undefined || a.readOnly) {
    throw invalid(
      `${attribute} is not a writable attribute of ${type} on this instance.`,
      'Use get_work_item to see what the item has; some instances turn features off.',
    );
  }
  if (
    (shape.relation === true && a.kind !== 'Relation') ||
    (shape.multi !== undefined && a.multi !== shape.multi)
  ) {
    throw invalid(`${attribute} of ${type} has a different shape on this instance than this tool writes.`);
  }
}

/** The OID of what a write created or changed, from the XML answer (`<Asset id="Story:1:5">`), without the moment. */
export function resultOid(root: XmlElement): string | undefined {
  const id = root.attributes['id'];
  return typeof id === 'string' ? oidsOf(id)[0] : undefined;
}

/** The one Agility request of a write: `POST rest-1.v1/Data/<Type>[/<id>]` with the XML document. */
export async function postAsset(
  ctx: ToolContext,
  type: string,
  id: string | undefined,
  ops: readonly XmlOp[],
): Promise<{ oid?: string }> {
  const res = await agilityClient(ctx).restWrite(type, id, assetXml(ops));
  const oid = resultOid(res.data);
  return oid === undefined ? {} : { oid };
}

/** The numeric id of an OID token (`Story:1234` -> `1234`). */
export const idOf = (oid: string): string => oid.split(':')[1] as string;

/** A list value in a stable order (by OID), so the same set always hashes the same. */
export const sortedLabels = (labels: readonly string[]): readonly string[] =>
  [...labels].sort((a, b) => oidOfLabel(a).localeCompare(oidOfLabel(b)));

export type { WriteValue };
