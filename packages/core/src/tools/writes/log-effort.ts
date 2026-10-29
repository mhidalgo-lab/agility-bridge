// SPDX-License-Identifier: Apache-2.0
// log_effort (P7-04): logs hours worked by the caller on one work item as an `Actual` (RESEARCH 1.5, unverified until
// P7-07). The mutation shows the item's logged total before and after, the date and the member. An identical entry
// (same item, member, date and hours) created in the last 10 minutes makes the call a no-op, so a retried call never
// doubles the hours; an older identical entry does not (D-194). A date left out is the UTC day (D-194).
import { z } from 'zod';
import { AbError, ErrorCode } from '../../errors.ts';
import { resolveMember, runQuery } from '../../identity/resolve.ts';
import { oidsOf } from '../../identity/scope.ts';
import { metadataFor } from '../../metadata/service.ts';
import { compileQuery } from '../../query/compiler.ts';
import { invalid } from '../../query/limits.ts';
import type { ToolDefinition } from '../../tool.ts';
import { defineWriteTool } from '../../writes/index.ts';
import { assetArg, num, text as textOf } from '../common.ts';
import {
  assertTypeAllowed,
  labelOf,
  oidOfLabel,
  planTarget,
  postAsset,
  rereadTarget,
  type Target,
  withinWindow,
} from './common.ts';

const TYPES = ['Story', 'Defect', 'Task', 'Test'] as const;
const TOTAL = 'Actuals.Value.@Sum';
const DAY = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COST = 14;

export const MAX_HOURS = 24;

const round2 = (n: number): number => Math.round(n * 100) / 100;
const totalOf = (t: Target): number => round2(num(t.get(TOTAL)) ?? 0);

/** `YYYY-MM-DD` that is a real calendar day, not more than a day ahead of now (time zones) and within the history limit. */
export function effortDate(value: string | undefined, now: number, maxAgeDays: number): string {
  const today = new Date(now).toISOString().slice(0, 10);
  const date = value ?? today;
  const ms = DATE_RE.test(date) ? Date.parse(`${date}T00:00:00Z`) : Number.NaN;
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== date) {
    throw invalid(`"${date.slice(0, 20)}" is not a date.`, 'Use YYYY-MM-DD (UTC).');
  }
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  if (ms > todayMs + DAY)
    throw invalid('Effort cannot be logged for a future date.', 'Use today or an earlier date.');
  if (ms < todayMs - maxAgeDays * DAY) {
    throw invalid(`Effort cannot be logged more than ${maxAgeDays} days back.`, 'Use a more recent date.');
  }
  return date;
}

/** An identical entry counts as the same call only when it was created inside this window (D-194). */
export const EFFORT_REPEAT_WINDOW_MS: number = 10 * 60_000;

async function sameEntryExists(
  ctx: Parameters<typeof planTarget>[0],
  itemOid: string,
  memberOid: string,
  date: string,
  hours: number,
): Promise<boolean> {
  const actual = await metadataFor(ctx).assetType('Actual');
  const created = actual.attributes.has('CreateDateUTC')
    ? 'CreateDateUTC'
    : actual.attributes.has('CreateDate')
      ? 'CreateDate'
      : undefined;
  // Without a creation time an old entry cannot be told from a repeat; a second entry is then Agility's to refuse.
  if (created === undefined) return false;
  const compiled = await compileQuery(ctx, {
    assetType: 'Actual',
    fields: ['Value', 'Date', 'Member', created],
    filters: [
      { field: 'Workitem', op: 'eq', value: itemOid },
      { field: 'Member', op: 'eq', value: memberOid },
    ],
    sort: [{ field: 'Date', direction: 'desc' }],
    limit: 50,
  });
  const { rows } = await runQuery(ctx, compiled);
  return rows.some(
    (r) =>
      oidsOf(r['Member'])[0] === memberOid &&
      textOf(r['Date'])?.slice(0, 10) === date &&
      round2(num(r['Value']) ?? Number.NaN) === hours &&
      withinWindow(textOf(r[created]), ctx.clock.now(), EFFORT_REPEAT_WINDOW_MS),
  );
}

export const logEffort: ToolDefinition = defineWriteTool({
  name: 'log_effort',
  title: 'Log effort',
  description: `Log hours you worked on one backlog item, defect, task or test, on a date (UTC, today when omitted), as an effort entry for yourself. Not paged. Cold call: up to ${COST} Agility requests.`,
  kind: 'write',
  // Resolution, the item with its total, member, existing entries, the re-read (2) and the one write; metadata cold.
  cost: COST,
  idempotent: false,
  inputSchema: z.object({
    asset: assetArg,
    hours: z.number().min(0.01).max(MAX_HOURS).describe('Hours worked, at most 24 and two decimals.'),
    date: z.string().min(10).max(10).optional().describe('Day worked, YYYY-MM-DD (UTC); today when omitted.'),
  }),
  allowedFields: Object.fromEntries(TYPES.map((t) => [t, ['Actual.Date', 'Actual.Member', 'Actual.Value']])),
  async plan(input, ctx) {
    const hours = round2(input.hours);
    if (hours < 0.01) throw invalid('Hours must be at least 0.01.');
    const date = effortDate(input.date, ctx.clock.now(), ctx.limits.maxTimeRangeDays);
    assertTypeAllowed(ctx, 'Actual');
    const target = await planTarget(ctx, input.asset, { types: TYPES, fields: [TOTAL] });
    const actual = await metadataFor(ctx).assetType('Actual');
    for (const attribute of ['Value', 'Date', 'Member', 'Workitem']) {
      if (actual.attributes.get(attribute)?.readOnly !== false) {
        throw invalid(`Effort is not writable on this instance (Actual.${attribute}).`);
      }
    }
    const me = await resolveMember(ctx, 'me');
    const total = totalOf(target);
    const duplicate = await sameEntryExists(ctx, target.oid, me.oid, date, hours);
    const member = labelOf(me.name, me.oid);
    return {
      mutation: {
        operation: 'log_effort',
        target: {
          assetType: target.assetType,
          oid: target.oid,
          ...(target.number === undefined ? {} : { number: target.number }),
        },
        // An identical entry already exists: nothing to change (old equals new everywhere).
        changes: duplicate
          ? [
              { field: 'Actual.Date', old: date, new: date },
              { field: 'Actual.Member', old: member, new: member },
              { field: 'Actual.Value', old: hours, new: hours },
            ]
          : [
              { field: 'Actual.Date', old: null, new: date },
              { field: 'Actual.Member', old: null, new: member },
              { field: 'Actual.Value', old: total, new: round2(total + hours) },
            ],
      },
      ...(target.name === undefined ? {} : { label: target.name }),
    };
  },
  async reread(plan, ctx) {
    const t = plan.mutation.target;
    const now = await rereadTarget(ctx, t.assetType, t.oid, [TOTAL]);
    // Date and member have no "current" value on the item: they stay at their old value (null) until written.
    return { values: { 'Actual.Date': null, 'Actual.Member': null, 'Actual.Value': totalOf(now) } };
  },
  async send(plan, ctx) {
    const by = (field: string) => plan.mutation.changes.find((c) => c.field === field)?.new;
    const hours = plan.mutation.changes.find((c) => c.field === 'Actual.Value');
    const date = by('Actual.Date');
    const member = by('Actual.Member');
    if (
      typeof date !== 'string' ||
      typeof member !== 'string' ||
      typeof hours?.new !== 'number' ||
      typeof hours.old !== 'number'
    ) {
      throw new AbError(ErrorCode.Internal, 'log_effort lost its change.');
    }
    const logged = round2(hours.new - hours.old);
    return postAsset(ctx, 'Actual', undefined, [
      { attribute: 'Value', value: logged },
      { attribute: 'Date', value: date },
      { relation: 'Member', act: 'set', oids: [oidOfLabel(member)] },
      { relation: 'Workitem', act: 'set', oids: [plan.mutation.target.oid] },
    ]);
  },
});
