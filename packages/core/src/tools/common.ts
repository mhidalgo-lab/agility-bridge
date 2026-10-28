// SPDX-License-Identifier: Apache-2.0
// Shared argument schemas and helpers for tools (tool conventions: one name per concept). The description of every
// shared argument lives here once: tools use these schemas instead of spelling the concept again, and the argument
// lint (`ARGUMENT_VOCABULARY`) checks that no tool describes one of these names differently (L-030, L-317).
import { z } from 'zod';
import { oidsOf } from '../identity/scope.ts';

const DESC = {
  asset: 'Asset number (B-01234, D-00012, E-00001) or OID token (Story:1234).',
  epic: 'Epic number (E-01234) or OID token (Epic:1234).',
  workItem: 'Backlog item or defect number (B-01234, D-00012) or OID token (Story:1234).',
  project: 'Agility project: name or Scope:<id>, within the workspace.',
  team: 'Team: name or Team:<id>.',
  sprint: 'Sprint: name, Timebox:<id>, or current, previous or next.',
  member: 'Member: me, a username, a name or Member:<id>.',
  timeRange: 'Window (UTC): "last 14 days", "yesterday" or "2026-10-01 to 2026-10-15".',
  assetType: 'Agility API name, e.g. Story, Defect, Task, Test, Epic.',
  workItemType: 'Story, Defect, Task or Test; all four when omitted.',
  changedItemType: 'Story, Defect, Task, Test or Epic; all five when omitted.',
  status: 'Status names as configured on the instance.',
  limit: 'Most rows; the workspace page size when omitted.',
  cursor: 'nextCursor of the previous call, same arguments.',
  includeClosed: 'Include closed items.',
  format: 'auto (a table up to 8 columns, else CSV), table, csv or json.',
  minimalOutput: 'Only the identity columns and name.',
  skipRelated: 'Skip children, links and comments (cheaper).',
} as const;

/** The advertised descriptions a shared argument name may start with; the argument lint reads it. */
export const ARGUMENT_VOCABULARY: Readonly<Record<string, readonly string[]>> = Object.freeze({
  asset: [DESC.asset, DESC.epic, DESC.workItem],
  assets: ['Asset numbers or OID tokens.'],
  asset_type: [DESC.assetType, DESC.workItemType, DESC.changedItemType],
  project: [DESC.project],
  team: [DESC.team],
  sprint: [DESC.sprint],
  member: [DESC.member],
  time_range: [DESC.timeRange],
  status: [DESC.status],
  limit: [DESC.limit],
  cursor: [DESC.cursor],
  include_closed: [DESC.includeClosed],
  format: [DESC.format],
  minimal_output: [DESC.minimalOutput],
  skip_related: [DESC.skipRelated],
});

const name200 = (): z.ZodString => z.string().min(1).max(200);

export const assetArg: z.ZodString = z.string().min(1).max(64).describe(DESC.asset);
export const epicArg: z.ZodString = z.string().min(1).max(64).describe(DESC.epic);
export const workItemArg: z.ZodString = z.string().min(1).max(64).describe(DESC.workItem);
export const assetTypeArg: z.ZodString = z.string().min(1).max(64).describe(DESC.assetType);
export const projectArg: z.ZodOptional<z.ZodString> = name200().optional().describe(DESC.project);
export const teamArg: z.ZodOptional<z.ZodString> = name200().optional().describe(DESC.team);
export const requiredTeamArg: z.ZodString = name200().describe(DESC.team);
export const sprintArg: z.ZodOptional<z.ZodString> = name200().optional().describe(DESC.sprint);
/** `sprint` for a tool whose natural default is the running sprint. */
export const currentSprintArg: z.ZodDefault<z.ZodString> = name200().default('current').describe(DESC.sprint);
export const memberArg: z.ZodOptional<z.ZodString> = name200().optional().describe(DESC.member);
/** `member` for a tool whose natural default is the caller. */
export const myMemberArg: z.ZodDefault<z.ZodString> = name200().default('me').describe(DESC.member);
export const statusArg: z.ZodOptional<z.ZodArray<z.ZodString>> = z
  .array(z.string().min(1).max(100))
  .max(20)
  .optional()
  .describe(DESC.status);
export const timeRangeArg = (defaultValue: string): z.ZodDefault<z.ZodString> =>
  z.string().min(1).max(100).default(defaultValue).describe(DESC.timeRange);
export const workItemTypeArg = <const T extends readonly [string, ...string[]]>(
  types: T,
): z.ZodOptional<z.ZodEnum<{ [K in T[number]]: K }>> => z.enum(types).optional().describe(DESC.workItemType);
/** `asset_type` for a tool that also covers epics (portfolio items). */
export const changedItemTypeArg = <const T extends readonly [string, ...string[]]>(
  types: T,
): z.ZodOptional<z.ZodEnum<{ [K in T[number]]: K }>> =>
  z.enum(types).optional().describe(DESC.changedItemType);
export const minimalOutputArg: z.ZodOptional<z.ZodBoolean> = z
  .boolean()
  .optional()
  .describe(DESC.minimalOutput);
/** `get_work_item`: leave out the related assets. A different thing from `minimal_output` (fewer columns per row). */
export const skipRelatedArg: z.ZodOptional<z.ZodBoolean> = z.boolean().optional().describe(DESC.skipRelated);
export const limitArg: z.ZodOptional<z.ZodNumber> = z
  .number()
  .int()
  .min(1)
  .max(1_000)
  .optional()
  .describe(DESC.limit);
export const cursorArg: z.ZodOptional<z.ZodString> = z.string().max(2_000).optional().describe(DESC.cursor);
export const containsArg = (what: string): z.ZodOptional<z.ZodString> =>
  z.string().min(1).max(100).optional().describe(`Only ${what} whose name contains this text.`);
export const includeClosedArg: z.ZodDefault<z.ZodBoolean> = z
  .boolean()
  .default(false)
  .describe(DESC.includeClosed);
const FORMATS: z.ZodEnum<{
  auto: 'auto';
  table: 'table';
  csv: 'csv';
  json: 'json';
}> = z.enum(['auto', 'table', 'csv', 'json']);
export const formatArg: z.ZodDefault<typeof FORMATS> = FORMATS.default('auto').describe(DESC.format);

/** A relation value as `{ oid, name }` when the row has both, else undefined. */
export function ref(
  row: Readonly<Record<string, unknown>>,
  field: string,
): { oid: string; name?: string } | undefined {
  const oid = oidsOf(row[field])[0];
  if (oid === undefined) return undefined;
  const name = row[`${field}.Name`];
  return { oid, ...(typeof name === 'string' ? { name } : {}) };
}

/** The OID of a row without its moment. */
export const rowOid = (row: Readonly<Record<string, unknown>>): string => oidsOf(row['_oid'])[0] ?? '';

/** Open output schema for a bounded list (no cursor): the same keys as `listOutput`, without `nextCursor`. */
export const boundedListOutput = (item: z.ZodType, extra: z.ZodRawShape = {}): z.ZodType =>
  z.looseObject({
    items: z.array(item),
    truncated: z.boolean().optional(),
    partial: z.boolean().optional(),
    notes: z.array(z.string()).optional(),
    ...extra,
  });

/** Open output schema for a paged list of items. */
export const listOutput = (item: z.ZodType): z.ZodType =>
  z.looseObject({
    items: z.array(item),
    nextCursor: z.string().optional(),
    truncated: z.boolean().optional(),
    partial: z.boolean().optional(),
    notes: z.array(z.string()).optional(),
    hiddenOutsideScope: z.boolean().optional(),
  });

// ---------------------------------------------------------------------------------------------------------------
// Small readers of Agility values, one definition each (P6-45, L-317). Agility sends numbers as numbers or strings.
// ---------------------------------------------------------------------------------------------------------------

/** A finite number from a number or a numeric string; nothing for anything else (booleans, null, blanks, objects). */
export const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
      ? Number(v)
      : undefined;

/** A non-empty string; nothing for anything else. */
export const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** One decimal place. */
export const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Is this attribute name the acceptance-criteria field of a work item (custom names differ by instance)? */
export const isAcceptanceAttribute = (name: string): boolean => /accept(?:ance)?_?crit/i.test(name);
