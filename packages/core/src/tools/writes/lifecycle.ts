// SPDX-License-Identifier: Apache-2.0
// close_asset and reopen_asset (P7-06): the lifecycle writes. Both are `destructive` (ADR-0013), separately enabled
// (each is its own tool name in the workspace and grant lists), and act on ONE work item. The state change is an Agility
// *operation* (`POST rest-1.v1/Data/<Type>/<id>?op=<Name>`, empty body), never an attribute write: the operation name
// comes from the instance's metadata for that type (never from the caller), so the type's own validators apply.
// A close of an item that still has open children is refused (D-186); closing a closed item and reopening an open one
// are no-ops (D-188). The request shapes are the documented ones and stay *unverified* until the sandbox (P7-07).
import { z } from 'zod';
import { agilityClient } from '../../agility/client.ts';
import type { ToolContext } from '../../context.ts';
import { AbError, ErrorCode } from '../../errors.ts';
import { runQuery } from '../../identity/resolve.ts';
import { metadataFor } from '../../metadata/service.ts';
import { compileQuery } from '../../query/compiler.ts';
import { invalid } from '../../query/limits.ts';
import type { ToolDefinition } from '../../tool.ts';
import { defineWriteTool } from '../../writes/index.ts';
import { assetArg } from '../common.ts';
import { ITEM_TYPES, idOf, planTarget, rereadTarget, type Target } from './common.ts';

/** Operations that close one item, in the order this tool prefers them; the first one the type has is used (D-187). */
const CLOSE_OPS = ['QuickClose', 'Close', 'Inactivate'] as const;
const REOPEN_OPS = ['Reactivate'] as const;
const KNOWN_OPS: ReadonlySet<string> = new Set([...CLOSE_OPS, ...REOPEN_OPS]);

/** Which types hold the open children of a type, and through which relation (an item with open children is not closed). */
const CHILDREN: Readonly<Record<string, ReadonlyArray<readonly [type: string, relation: string]>>> = {
  Story: [
    ['Task', 'Parent'],
    ['Test', 'Parent'],
  ],
  Defect: [
    ['Task', 'Parent'],
    ['Test', 'Parent'],
  ],
  Epic: [
    ['Epic', 'Super'],
    ['Story', 'Super'],
    ['Defect', 'Super'],
  ],
  Task: [],
  Test: [],
};
const CHILD_LIMIT = 21;
const COST = 22;

export const OPEN = 'Open';
export const CLOSED = 'Closed';
const FIELDS = ['Parent', 'Super'];
const ALLOWED = Object.fromEntries(ITEM_TYPES.map((t) => [t, ['AssetState', 'OpenChildren']]));

/** Open children of one item, counted with the same scoped, bound-parameter queries the read tools use (capped). */
export async function openChildren(ctx: ToolContext, type: string, oid: string): Promise<number> {
  const md = metadataFor(ctx);
  let count = 0;
  for (const [childType, relation] of CHILDREN[type] ?? []) {
    const meta = await md.findAssetType(childType);
    if (meta === undefined || !meta.attributes.has(relation)) continue;
    // A child type this workspace may not read cannot be counted, so the close is refused rather than shown as
    // "0 open children" (D-191, P7-09). Agility's own close operation might close children the approver never saw.
    if (
      ctx.assetTypes.deny.includes(childType) ||
      (ctx.assetTypes.allow !== undefined && !ctx.assetTypes.allow.includes(childType))
    ) {
      throw invalid(
        `${type} cannot be closed with this tool: its ${childType} children cannot be counted because ${childType} is not readable in this workspace.`,
        'Close it in Agility, or ask an owner to allow reading the child type first.',
      );
    }
    // The children of an epic can live in other projects; a project-restricted workspace only sees some of them.
    if (relation === 'Super' && ctx.projects.allowed.length > 0) {
      throw invalid(
        `${type} cannot be closed with this tool: its children may sit in projects outside this workspace, so they cannot all be counted.`,
        'Close it in Agility, or use a workspace that covers every project the epic reaches.',
      );
    }
    const compiled = await compileQuery(ctx, {
      assetType: childType,
      fields: ['Number'],
      filters: [{ field: relation, op: 'eq', value: oid }],
      limit: CHILD_LIMIT,
      includeClosed: false,
    });
    count += (await runQuery(ctx, compiled)).rows.length;
  }
  return Math.min(count, CHILD_LIMIT - 1);
}

/** The operation this type offers for the action, from its metadata. Refuses when the instance has none. */
async function operationFor(ctx: ToolContext, type: string, ops: readonly string[]): Promise<string> {
  const meta = await metadataFor(ctx).assetType(type);
  const found = ops.find((op) => meta.operations.has(op));
  if (found === undefined) {
    throw invalid(
      `${type} has no ${ops.join(' or ')} operation on this instance, so this tool cannot change its state.`,
      'Use Agility itself for this change; the instance’s metadata decides which operations a type has.',
    );
  }
  return found;
}

const stateLabel = (t: Pick<Target, 'state'>): string => (t.state === 'closed' ? CLOSED : OPEN);

function lifecycleTool(cfg: {
  readonly name: 'close_asset' | 'reopen_asset';
  readonly title: string;
  readonly description: string;
  readonly ops: readonly string[];
  readonly to: string;
}): ToolDefinition {
  const closing = cfg.to === CLOSED;
  return defineWriteTool({
    name: cfg.name,
    title: cfg.title,
    description: `${cfg.description} Needs approval; preview with dry_run. Not paged. Cold call: up to ${COST} Agility requests.`,
    kind: 'destructive',
    // Resolution, the item read, the metadata of the type and of its child types, the child counts, the re-read with its
    // counts, and the one operation.
    cost: COST,
    idempotent: true,
    inputSchema: z.object({ asset: assetArg }),
    allowedFields: ALLOWED,
    async plan(input, ctx) {
      const target = await planTarget(ctx, input.asset, {
        types: ITEM_TYPES,
        fields: FIELDS,
        allowClosed: true,
      });
      const which = target.number ?? target.oid;
      const now = stateLabel(target);
      const changes: Array<{ field: string; old: string | number; new: string | number }> = [
        { field: 'AssetState', old: now, new: cfg.to },
      ];
      let operation: string = cfg.name;
      if (now !== cfg.to) {
        const op = await operationFor(ctx, target.assetType, cfg.ops);
        operation = `${cfg.name}:${op}`;
        if (closing) {
          const open = await openChildren(ctx, target.assetType, target.oid);
          if (open > 0) {
            throw invalid(
              `${which} still has ${open >= CHILD_LIMIT - 1 ? 'more than 19' : String(open)} open child item(s), so it is not closed.`,
              'Close or finish its open tasks, tests or items first, then close it.',
            );
          }
          changes.push({ field: 'OpenChildren', old: 0, new: 0 });
        }
      }
      return {
        mutation: {
          operation,
          target: {
            assetType: target.assetType,
            oid: target.oid,
            ...(target.number === undefined ? {} : { number: target.number }),
          },
          changes,
        },
        ...(target.version === undefined ? {} : { version: target.version }),
        ...(target.name === undefined ? {} : { label: target.name }),
      };
    },
    async reread(plan, ctx) {
      const t = plan.mutation.target;
      const now = await rereadTarget(ctx, t.assetType, t.oid, FIELDS, true);
      const values: Record<string, string | number> = { AssetState: stateLabel(now) };
      if (plan.mutation.changes.some((c) => c.field === 'OpenChildren')) {
        values['OpenChildren'] = await openChildren(ctx, t.assetType, t.oid);
      }
      return { values, ...(now.version === undefined ? {} : { version: now.version }) };
    },
    async send(plan, ctx) {
      // The operation is the one the plan chose from the metadata; it is re-checked against the closed list here.
      const op = plan.mutation.operation.split(':')[1];
      if (op === undefined || !KNOWN_OPS.has(op) || !cfg.ops.includes(op)) {
        throw new AbError(ErrorCode.Internal, `${cfg.name} lost its operation.`);
      }
      const res = await agilityClient(ctx).restWrite(
        plan.mutation.target.assetType,
        idOf(plan.mutation.target.oid),
        '',
        op,
      );
      const id = res.data.attributes['id'];
      return {
        ...(typeof id === 'string' ? { oid: id.split(':').slice(0, 2).join(':') } : {}),
        ...(res.unreadable === true ? { unreadable: true } : {}),
      };
    },
  });
}

export const closeAsset: ToolDefinition = lifecycleTool({
  name: 'close_asset',
  title: 'Close work item',
  description:
    'Close one backlog item, defect, task, test or epic with the close operation its type has on this instance. Refused while it has open child items; an item that is already closed is a no-op. Destructive.',
  ops: CLOSE_OPS,
  to: CLOSED,
});

export const reopenAsset: ToolDefinition = lifecycleTool({
  name: 'reopen_asset',
  title: 'Reopen work item',
  description:
    'Reopen one closed backlog item, defect, task, test or epic with its Reactivate operation. An item that is already open is a no-op. Destructive.',
  ops: REOPEN_OPS,
  to: OPEN,
});

export const LIFECYCLE_TOOLS: readonly ToolDefinition[] = Object.freeze([closeAsset, reopenAsset]);
