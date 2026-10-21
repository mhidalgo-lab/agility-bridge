// SPDX-License-Identifier: Apache-2.0
// Shared argument schemas and helpers for tools (tool conventions: one name per concept).
import { z } from 'zod';
import { oidsOf } from '../identity/scope.ts';

export const limitArg: z.ZodOptional<z.ZodNumber> = z
  .number()
  .int()
  .min(1)
  .max(1_000)
  .optional()
  .describe('Most rows to return (default 25; capped by the workspace).');
export const cursorArg: z.ZodOptional<z.ZodString> = z
  .string()
  .max(2_000)
  .optional()
  .describe('nextCursor from the previous call with the same arguments.');
export const containsArg = (what: string): z.ZodOptional<z.ZodString> =>
  z.string().min(1).max(100).optional().describe(`Only ${what} whose name contains this text.`);
export const includeClosedArg: z.ZodOptional<z.ZodBoolean> = z
  .boolean()
  .optional()
  .describe('Include closed items (default false).');
const FORMATS: z.ZodEnum<{ auto: 'auto'; table: 'table'; csv: 'csv'; json: 'json' }> = z.enum([
  'auto',
  'table',
  'csv',
  'json',
]);
export const formatArg: z.ZodOptional<typeof FORMATS> = FORMATS.optional().describe(
  'Output format: auto (default), table, csv or json.',
);

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
