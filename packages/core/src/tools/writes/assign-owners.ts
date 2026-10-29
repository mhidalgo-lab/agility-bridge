// SPDX-License-Identifier: Apache-2.0
// assign_owners (P7-04): adds and removes owners of one work item. Members go through the member resolver (names are
// matched, never guessed); the mutation shows the whole owner list before and after, each owner as `Name [Member:id]`,
// and the request sends only the difference as `add` / `remove` on `Owners` (RESEARCH 1.5).
import { z } from 'zod';
import { AbError, ErrorCode } from '../../errors.ts';
import { resolveMember } from '../../identity/resolve.ts';
import { oidsOf } from '../../identity/scope.ts';
import { invalid } from '../../query/limits.ts';
import type { ToolDefinition } from '../../tool.ts';
import { defineWriteTool } from '../../writes/index.ts';
import { assetArg, text } from '../common.ts';
import {
  assertTypeAllowed,
  ITEM_TYPES,
  idOf,
  labelOf,
  oidOfLabel,
  planTarget,
  postAsset,
  requireWritable,
  rereadTarget,
  sortedLabels,
} from './common.ts';

const MAX_MEMBERS = 5;
const FIELDS = ['Owners', 'Owners.Name'];

const members = (what: string): z.ZodOptional<z.ZodArray<z.ZodString>> =>
  z
    .array(z.string().min(1).max(200))
    .max(MAX_MEMBERS)
    .optional()
    .describe(`Members to ${what}: me, a username, a name or Member:<id>; at most ${MAX_MEMBERS}.`);

/** The owners of a row as labels, in a stable order. */
function ownersOf(row: Readonly<Record<string, unknown>>): readonly string[] {
  const oids = oidsOf(row['Owners']);
  const names = Array.isArray(row['Owners.Name']) ? row['Owners.Name'] : [row['Owners.Name']];
  return sortedLabels(oids.map((oid, i) => labelOf(text(names[i]) ?? oid, oid)));
}

const COST = 26;

export const assignOwners: ToolDefinition = defineWriteTool({
  name: 'assign_owners',
  title: 'Assign owners',
  description: `Add and remove owners of one backlog item, defect, task, test or epic. Give members to add, to remove, or both; the other owners stay. Not paged. Cold call: up to ${COST} Agility requests.`,
  kind: 'write',
  overwrites: true,
  // Resolution, the item read, up to five members (up to three requests each), the re-read and the one write.
  cost: COST,
  idempotent: true,
  inputSchema: z.object({
    asset: assetArg,
    add: members('add'),
    remove: members('remove'),
  }),
  allowedFields: Object.fromEntries(ITEM_TYPES.map((t) => [t, ['Owners']])),
  async plan(input, ctx) {
    const add = input.add ?? [];
    const remove = input.remove ?? [];
    if (add.length === 0 && remove.length === 0) {
      throw invalid('Give at least one member to add or remove.');
    }
    if (add.length + remove.length > MAX_MEMBERS) {
      throw invalid(`At most ${MAX_MEMBERS} members in one call.`, 'Split the change.');
    }
    assertTypeAllowed(ctx, 'Member');
    const target = await planTarget(ctx, input.asset, { types: ITEM_TYPES, fields: FIELDS });
    await requireWritable(ctx, target.assetType, 'Owners', { relation: true, multi: true });
    const toAdd = new Map<string, string>();
    const toRemove = new Map<string, string>();
    for (const [list, into] of [
      [add, toAdd],
      [remove, toRemove],
    ] as const) {
      for (const ref of list) {
        const m = await resolveMember(ctx, ref);
        into.set(m.oid, text(m.row['Name']) ?? m.name);
      }
    }
    for (const oid of toAdd.keys()) {
      if (toRemove.has(oid)) throw invalid('A member is both added and removed.', 'Name each member once.');
    }
    const old = ownersOf(target.row);
    const owners = new Map(old.map((l) => [oidOfLabel(l), l]));
    for (const [oid, name] of toAdd) if (!owners.has(oid)) owners.set(oid, labelOf(name, oid));
    for (const oid of toRemove.keys()) owners.delete(oid);
    return {
      mutation: {
        operation: 'assign_owners',
        target: {
          assetType: target.assetType,
          oid: target.oid,
          ...(target.number === undefined ? {} : { number: target.number }),
        },
        changes: [{ field: 'Owners', old, new: sortedLabels([...owners.values()]) }],
      },
      ...(target.version === undefined ? {} : { version: target.version }),
      ...(target.name === undefined ? {} : { label: target.name }),
    };
  },
  async reread(plan, ctx) {
    const t = plan.mutation.target;
    const now = await rereadTarget(ctx, t.assetType, t.oid, FIELDS);
    return {
      values: { Owners: ownersOf(now.row) },
      ...(now.version === undefined ? {} : { version: now.version }),
    };
  },
  async send(plan, ctx) {
    const change = plan.mutation.changes[0];
    if (change === undefined || !Array.isArray(change.old) || !Array.isArray(change.new)) {
      throw new AbError(ErrorCode.Internal, 'assign_owners lost its change.');
    }
    const before = new Set((change.old as readonly string[]).map(oidOfLabel));
    const after = new Set((change.new as readonly string[]).map(oidOfLabel));
    const added = [...after].filter((o) => !before.has(o));
    const removed = [...before].filter((o) => !after.has(o));
    return postAsset(ctx, plan.mutation.target.assetType, idOf(plan.mutation.target.oid), [
      ...(added.length === 0 ? [] : [{ relation: 'Owners', act: 'add' as const, oids: added }]),
      ...(removed.length === 0 ? [] : [{ relation: 'Owners', act: 'remove' as const, oids: removed }]),
    ]);
  },
});
