// SPDX-License-Identifier: Apache-2.0
// move_to_sprint (P7-04): puts one backlog item or defect into a sprint (`Timebox`). The sprint is resolved through the
// sprint resolver limited to the item's own Agility project (its schedule must be scheduled for that project), and a
// closed sprint is refused. The mutation shows the sprint before and after as `Name [Timebox:id]`.
import { z } from 'zod';
import { AbError, ErrorCode } from '../../errors.ts';
import { resolveSprint, runQuery } from '../../identity/resolve.ts';
import { oidsOf } from '../../identity/scope.ts';
import { compileQuery } from '../../query/compiler.ts';
import { invalid } from '../../query/limits.ts';
import type { ToolDefinition } from '../../tool.ts';
import { defineWriteTool } from '../../writes/index.ts';
import { assetArg } from '../common.ts';
import {
  assertTypeAllowed,
  idOf,
  labelFrom,
  labelOf,
  oidOfLabel,
  planTarget,
  postAsset,
  requireWritable,
  rereadTarget,
} from './common.ts';

const TYPES = ['Story', 'Defect'] as const;
const FIELDS = ['Timebox', 'Timebox.Name'];

const COST = 14;

export const moveToSprint: ToolDefinition = defineWriteTool({
  name: 'move_to_sprint',
  title: 'Move to sprint',
  description: `Move one backlog item or defect into a sprint of its own Agility project, by sprint name, OID token or current, previous or next. A closed sprint is refused. Not paged. Cold call: up to ${COST} Agility requests.`,
  kind: 'write',
  overwrites: true,
  // Resolution, the item read, the sprint (a relative name takes two requests), its state, the re-read and the write.
  cost: COST,
  idempotent: true,
  inputSchema: z.object({
    asset: assetArg,
    sprint: z.string().min(1).max(200).describe('Sprint: name, Timebox:<id>, or current, previous or next.'),
  }),
  allowedFields: Object.fromEntries(TYPES.map((t) => [t, ['Timebox']])),
  async plan(input, ctx) {
    assertTypeAllowed(ctx, 'Timebox');
    const target = await planTarget(ctx, input.asset, { types: TYPES, fields: FIELDS });
    await requireWritable(ctx, target.assetType, 'Timebox', { relation: true, multi: false });
    const project = oidsOf(target.row['Scope'])[0];
    if (project === undefined) throw invalid(`${target.number ?? target.oid} has no Agility project.`);
    const sprint = await resolveSprint(ctx, input.sprint, { project });
    const state = await sprintState(ctx, sprint.oid);
    if (state === undefined) throw invalid('That sprint is not visible in this workspace.');
    if (state !== 64 && state !== 0) {
      throw invalid(`The sprint "${sprint.name.slice(0, 80)}" is closed.`, 'Choose an open sprint.');
    }
    return {
      mutation: {
        operation: 'move_to_sprint',
        target: {
          assetType: target.assetType,
          oid: target.oid,
          ...(target.number === undefined ? {} : { number: target.number }),
        },
        changes: [
          { field: 'Timebox', old: labelFrom(target.row, 'Timebox'), new: labelOf(sprint.name, sprint.oid) },
        ],
      },
      ...(target.version === undefined ? {} : { version: target.version }),
      ...(target.name === undefined ? {} : { label: target.name }),
    };
  },
  async reread(plan, ctx) {
    const t = plan.mutation.target;
    const now = await rereadTarget(ctx, t.assetType, t.oid, FIELDS);
    return {
      values: { Timebox: labelFrom(now.row, 'Timebox') },
      ...(now.version === undefined ? {} : { version: now.version }),
    };
  },
  async send(plan, ctx) {
    const change = plan.mutation.changes[0];
    if (change === undefined || typeof change.new !== 'string') {
      throw new AbError(ErrorCode.Internal, 'move_to_sprint lost its change.');
    }
    return postAsset(ctx, plan.mutation.target.assetType, idOf(plan.mutation.target.oid), [
      { relation: 'Timebox', act: 'set', oids: [oidOfLabel(change.new)] },
    ]);
  },
});

/** `AssetState` code of one sprint, read through the compiler (scope rechecked). */
async function sprintState(ctx: Parameters<typeof planTarget>[0], oid: string): Promise<number | undefined> {
  const compiled = await compileQuery(ctx, {
    assetType: 'Timebox',
    fields: ['AssetState'],
    filters: [{ field: 'ID', op: 'eq', value: oid }],
    limit: 1,
    includeClosed: true,
  });
  const { rows } = await runQuery(ctx, compiled);
  const row = rows.find((r) => oidsOf(r['_oid'])[0] === oid);
  return row === undefined ? undefined : Number(row['AssetState']);
}
