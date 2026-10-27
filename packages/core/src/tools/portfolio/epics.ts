// SPDX-License-Identifier: Apache-2.0
// Shared by the portfolio tools: the Epic row (categories such as Feature or Initiative are values of `Epic.Category`,
// not asset types, L-148), the readable-type check and a batched, scope-rechecked read.
import { agilityClient } from '../../agility/client.ts';
import type { ToolContext } from '../../context.ts';
import { AbError, ErrorCode } from '../../errors.ts';
import { inScope, oidsOf, sanitizeRow } from '../../identity/scope.ts';
import { metadataFor } from '../../metadata/service.ts';
import { assetState } from '../../output/result.ts';
import { utcIso } from '../../output/text.ts';
import type { CompiledQuery } from '../../query/compiler.ts';

export const EPIC = 'Epic';

type Row = Record<string, unknown>;

export const isReadable = (ctx: ToolContext, type: string): boolean =>
  !ctx.assetTypes.deny.includes(type) &&
  (ctx.assetTypes.allow === undefined || ctx.assetTypes.allow.includes(type));

/** Refuses before any request when the workspace does not allow a type (negative authorization, L-035). */
export function requireReadable(ctx: ToolContext, type: string): void {
  if (!isReadable(ctx, type)) {
    throw new AbError(ErrorCode.AuthForbidden, `Asset type ${type} is not allowed in this workspace.`, {
      hint: 'Ask the workspace administrator to allow this asset type.',
    });
  }
}

/** Epic fields limited to what this instance's Epic has (metadata first, L-148). */
export async function epicFields(ctx: ToolContext, extra: readonly string[] = []): Promise<string[]> {
  const meta = await metadataFor(ctx).assetType(EPIC);
  const has = (a: string) => meta.attributes.has(a.split('.')[0] as string);
  const changed = has('ChangeDateUTC') ? 'ChangeDateUTC' : 'ChangeDate';
  return [
    'Name',
    'Category.Name',
    'Status',
    'Status.Name',
    'Super',
    'Super.Number',
    'Super.Name',
    'Swag',
    'DetailEstimate',
    'ToDo',
    changed,
    ...extra,
  ].filter(has);
}

const num = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && v !== '' && Number.isFinite(Number(v))
      ? Number(v)
      : undefined;
const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);

/** One epic as a flat row (camelCase, identity first); absent values are omitted, never null. */
export function epicRow(row: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const project = oidsOf(row['Scope'])[0];
  const parent = oidsOf(row['Super'])[0];
  const changed = text(row['ChangeDateUTC']) ?? text(row['ChangeDate']);
  const fields: Array<[string, unknown]> = [
    ['number', text(row['Number'])],
    ['assetType', EPIC],
    ['oid', oidsOf(row['_oid'])[0] ?? ''],
    ['state', assetState(row['AssetState'], EPIC)],
    [
      'project',
      project === undefined
        ? undefined
        : { oid: project, ...(text(row['Scope.Name']) === undefined ? {} : { name: row['Scope.Name'] }) },
    ],
    ['name', text(row['Name'])],
    ['category', text(row['Category.Name'])],
    ['status', text(row['Status.Name'])],
    [
      'parent',
      parent === undefined
        ? undefined
        : {
            oid: parent,
            ...(text(row['Super.Number']) === undefined ? {} : { number: row['Super.Number'] }),
            ...(text(row['Super.Name']) === undefined ? {} : { name: row['Super.Name'] }),
          },
    ],
    ['swag', num(row['Swag'])],
    ['detailEstimateHours', num(row['DetailEstimate'])],
    ['toDoHours', num(row['ToDo'])],
    ['changedAt', changed === undefined ? undefined : (utcIso(changed) ?? changed)],
  ];
  return Object.fromEntries(fields.filter(([, v]) => v !== undefined));
}

export interface BatchResult {
  /** Rows inside the workspace, rechecked and sanitized, at most the query's limit. */
  readonly rows: Row[];
  /** The query returned more than its limit. */
  readonly more: boolean;
  /** Rows dropped by the scope recheck. */
  readonly hidden: number;
}

/** Several compiled queries in one request; each answer is rechecked for scope (L-064). */
export async function runBatch(ctx: ToolContext, compiled: readonly CompiledQuery[]): Promise<BatchResult[]> {
  if (compiled.length === 0) return [];
  const res = await agilityClient(ctx).query<unknown[]>(compiled.map((c) => c.body));
  return compiled.map((c, i) => {
    const set = Array.isArray(res.data) ? res.data[i] : undefined;
    const raw = (Array.isArray(set) ? set : []).filter(
      (r): r is Row => r !== null && typeof r === 'object' && !Array.isArray(r),
    );
    const window = raw.slice(0, c.limit);
    const rows = window.filter((r) => inScope(ctx, c, r));
    for (const r of rows) sanitizeRow(ctx, c, r);
    return { rows, more: raw.length > c.limit, hidden: window.length - rows.length };
  });
}
