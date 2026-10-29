// SPDX-License-Identifier: Apache-2.0
// update_status (P7-04): sets the Status of one work item. The status comes from the instance's list for the item's type
// and its team's workflow (L-142); it is never a free string, never closes the item, and AssetState is not touched.
import { z } from 'zod';
import { AbError, ErrorCode } from '../../errors.ts';
import { matchName, noSingleMatch } from '../../identity/match.ts';
import { oidsOf } from '../../identity/scope.ts';
import { metadataFor, type StatusEntry } from '../../metadata/service.ts';
import { invalid } from '../../query/limits.ts';
import type { ToolDefinition } from '../../tool.ts';
import { defineWriteTool } from '../../writes/index.ts';
import { assetArg } from '../common.ts';
import {
  ITEM_TYPES,
  idOf,
  labelFrom,
  labelOf,
  oidOfLabel,
  planTarget,
  postAsset,
  requireWritable,
  rereadTarget,
} from './common.ts';

const FIELDS = ['Status', 'Status.Name', 'Team'];

/** The statuses this item may take: the type's list, limited to its team's workflow when statuses are per team. */
function candidates(all: readonly StatusEntry[], team: string | undefined): StatusEntry[] {
  return all.filter((s) => s.team === undefined || s.team === team);
}

const COST = 12;

export const updateStatus: ToolDefinition = defineWriteTool({
  name: 'update_status',
  title: 'Update status',
  description: `Set the status of one backlog item, defect, task, test or epic to a status of its workflow (by name or OID token). Changes the status only: it does not close the item. Not paged. Cold call: up to ${COST} Agility requests.`,
  kind: 'write',
  // Resolution, the item read, the status list (cold), the re-read and the one write.
  cost: COST,
  idempotent: true,
  inputSchema: z.object({
    asset: assetArg,
    new_status: z
      .string()
      .min(1)
      .max(200)
      .describe('Status names as configured on the instance. Exactly one: its name or its OID token.'),
  }),
  allowedFields: Object.fromEntries(ITEM_TYPES.map((t) => [t, ['Status']])),
  async plan(input, ctx) {
    const target = await planTarget(ctx, input.asset, { types: ITEM_TYPES, fields: FIELDS });
    await requireWritable(ctx, target.assetType, 'Status', { relation: true, multi: false });
    const team = oidsOf(target.row['Team'])[0];
    const list = candidates(await metadataFor(ctx).statuses(target.assetType), team);
    if (list.length === 0) {
      throw invalid(
        `${target.assetType} has no status list on this instance.`,
        'Use get_work_item to see the item.',
      );
    }
    const wanted = input.new_status.trim();
    const byOid = list.find((s) => s.oid === wanted);
    let chosen = byOid;
    if (chosen === undefined) {
      const active = list.filter((s) => !s.inactive);
      let result = matchName(wanted, active);
      if (result.kind !== 'match') result = matchName(wanted, list);
      if (result.kind !== 'match') throw noSingleMatch(`${target.assetType} status`, wanted, result);
      chosen = result.item;
    }
    if (chosen.inactive) {
      throw invalid(
        `The status "${chosen.name.slice(0, 80)}" is inactive on this instance.`,
        'Choose an active status.',
      );
    }
    const old = labelFrom(target.row, 'Status');
    return {
      mutation: {
        operation: 'update_status',
        target: {
          assetType: target.assetType,
          oid: target.oid,
          ...(target.number === undefined ? {} : { number: target.number }),
        },
        changes: [{ field: 'Status', old, new: labelOf(chosen.name, chosen.oid) }],
      },
      ...(target.version === undefined ? {} : { version: target.version }),
      ...(target.name === undefined ? {} : { label: target.name }),
    };
  },
  async reread(plan, ctx) {
    const now = await rereadTarget(ctx, plan.mutation.target.assetType, plan.mutation.target.oid, FIELDS);
    return {
      values: { Status: labelFrom(now.row, 'Status') },
      ...(now.version === undefined ? {} : { version: now.version }),
    };
  },
  async send(plan, ctx) {
    const change = plan.mutation.changes[0];
    if (change === undefined || typeof change.new !== 'string') {
      throw new AbError(ErrorCode.Internal, 'update_status lost its change.');
    }
    return postAsset(ctx, plan.mutation.target.assetType, idOf(plan.mutation.target.oid), [
      { relation: 'Status', act: 'set', oids: [oidOfLabel(change.new)] },
    ]);
  },
});
