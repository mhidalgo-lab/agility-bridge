// SPDX-License-Identifier: Apache-2.0
// create_work_item (P7-05): creates one backlog item, defect, task, test or epic in an Agility project of the workspace.
// A create has no old value, so the approval shows every field of the new item (old: empty) and the one target is the
// project that will hold it. After the approval the re-read is a validity check, not a value comparison: the project, the
// parent and their scope must still be fine, and the item must not exist already. Idempotency has no key in Agility, so it
// is derived: the same caller creating the same title under the same parent in the same project within 30 minutes is a
// repeat and is refused, naming the item that exists (D-179). The write shape is *unverified* until the sandbox (P7-07).
import { z } from 'zod';
import { type ToolContext, withMemo } from '../../context.ts';
import { AbError, ErrorCode } from '../../errors.ts';
import { resolveMember, resolveProject, runQuery } from '../../identity/resolve.ts';
import { oidsOf } from '../../identity/scope.ts';
import { metadataFor } from '../../metadata/service.ts';
import { compileQuery } from '../../query/compiler.ts';
import { invalid } from '../../query/limits.ts';
import type { ToolDefinition } from '../../tool.ts';
import { defineWriteTool } from '../../writes/index.ts';
import { text as textOf } from '../common.ts';
import {
  assertTypeAllowed,
  conflict,
  labelOf,
  oidOfLabel,
  planTarget,
  postAsset,
  readTarget,
  requireWritable,
  rereadTarget,
  withinWindow,
} from './common.ts';
import {
  descriptionHtml,
  descriptionText,
  estimateField,
  estimateValue,
  FIELD_ALLOWLIST,
  FIELD_TYPES,
  type FieldType,
  itemName,
  MAX_DESCRIPTION_CHARS,
  notAllowed,
  PARENT_RELATION,
  PARENT_TYPES,
  resolvePriority,
} from './fields.ts';

/** A repeat of the same create inside this window is refused (D-179). */
export const DUPLICATE_WINDOW_MS: number = 30 * 60_000;
const COST = 20;

/** Everything `create_work_item` may write: the type's fields and its parent relation; the project is the target. */
const CREATE_FIELDS: readonly string[] = [
  ...new Set(['AssetType', ...FIELD_TYPES.flatMap((t) => [...FIELD_ALLOWLIST[t], PARENT_RELATION[t]])]),
];

const OPEN_STATES = new Set(['active', 'future']);

/** The project that will hold the item: visible in the workspace (the compiler's scope) and open. */
async function projectOf(
  ctx: ToolContext,
  oid: string,
): Promise<{ readonly oid: string; readonly name: string }> {
  assertTypeAllowed(ctx, 'Scope');
  const project = await readTarget(ctx, 'Scope', oid, []);
  if (project === undefined) throw conflict(oid);
  const name = project.name ?? oid;
  if (!OPEN_STATES.has(project.state)) {
    throw invalid(`The project "${name.slice(0, 80)}" is not open, so nothing can be created in it.`);
  }
  return { oid, name };
}

/** The title is compared as a person would: trimmed, case and inner spacing aside. */
const same = (a: string, b: string): boolean =>
  a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();

/** The item the caller already created with this title under this parent in this project a moment ago, if any. */
async function recentDuplicate(
  ctx: ToolContext,
  type: FieldType,
  project: string,
  parent: string | undefined,
  name: string,
): Promise<{ readonly oid: string; readonly number?: string } | undefined> {
  const meta = await metadataFor(ctx).assetType(type);
  const created = meta.attributes.has('CreateDateUTC') ? 'CreateDateUTC' : 'CreateDate';
  const relation = PARENT_RELATION[type];
  if (!meta.attributes.has('CreatedBy') || !meta.attributes.has(created)) {
    throw invalid(
      `${type} has no creation date or creator on this instance, so a repeated create cannot be told apart.`,
    );
  }
  const me = await resolveMember(ctx, 'me');
  const compiled = await compileQuery(ctx, {
    assetType: type,
    fields: ['Number', 'Name', created, 'CreatedBy', relation],
    filters: [
      { field: 'Scope', op: 'eq', value: project },
      { field: 'CreatedBy', op: 'eq', value: me.oid },
    ],
    sort: [{ field: created, direction: 'desc' }],
    limit: 20,
    includeClosed: true,
  });
  const { rows } = await runQuery(ctx, compiled);
  const now = ctx.clock.now();
  for (const row of rows) {
    const rowName = textOf(row['Name']);
    if (rowName === undefined || !same(rowName, name)) continue;
    if (oidsOf(row['CreatedBy'])[0] !== me.oid) continue;
    if ((oidsOf(row[relation])[0] ?? undefined) !== parent) continue;
    // A creation time that cannot be read is not "recent": one old item must not block its title for ever (D-195).
    if (!withinWindow(textOf(row[created]), now, DUPLICATE_WINDOW_MS)) continue;
    const oid = oidsOf(row['_oid'])[0];
    if (oid === undefined) continue;
    const number = textOf(row['Number']);
    return { oid, ...(number === undefined ? {} : { number }) };
  }
  return undefined;
}

const newValue = (
  changes: readonly { readonly field: string; readonly new: unknown }[],
  field: string,
): unknown => changes.find((c) => c.field === field)?.new;

const defined: ToolDefinition = defineWriteTool({
  name: 'create_work_item',
  title: 'Create work item',
  description: `Create one backlog item, defect, task, test or epic in an Agility project. A task or test needs a parent item; a backlog item, defect or epic may have an epic as parent. Sets only title, description, estimate and priority. Not paged. Cold call: up to ${COST} Agility requests.`,
  kind: 'write',
  // Resolution of the project, the parent and the priority, metadata (cold), the duplicate scan, the re-read and the write.
  cost: COST,
  idempotent: false,
  inputSchema: z.object({
    item_type: z.enum(FIELD_TYPES).describe('Story, Defect, Task, Test or Epic.'),
    name: z.string().min(1).max(400).describe('Title: one line, at most 200 characters.'),
    project: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Agility project: name or Scope:<id>, within the workspace.'),
    parent: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe('Parent asset number or OID token: a story or defect for a task or test, an epic otherwise.'),
    description: z
      .string()
      .min(1)
      .max(MAX_DESCRIPTION_CHARS)
      .optional()
      .describe('Plain text, at most 4,000 characters; a blank line starts a paragraph.'),
    estimate: z
      .number()
      .min(0)
      .max(10_000)
      .optional()
      .describe('Story points for a story or defect; hours for a task or test. Not for an epic.'),
    priority: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Priority name or OID token, for a story or defect.'),
  }),
  allowedFields: { Scope: CREATE_FIELDS },
  async plan(input, ctx) {
    const type = input.item_type;
    assertTypeAllowed(ctx, type);
    const name = itemName(input.name);
    const description = input.description === undefined ? undefined : descriptionText(input.description);
    const allowed = FIELD_ALLOWLIST[type];
    const estimateAttribute = estimateField(type);
    if (input.estimate !== undefined && estimateAttribute === undefined) throw notAllowed(type, 'estimate');
    if (input.priority !== undefined && !allowed.includes('Priority')) throw notAllowed(type, 'priority');
    const estimate =
      input.estimate === undefined || estimateAttribute === undefined
        ? undefined
        : estimateValue(input.estimate, 'estimate');

    const relation = PARENT_RELATION[type];
    if ((type === 'Task' || type === 'Test') && input.parent === undefined) {
      throw invalid(`A ${type} needs a parent: give the story or defect it belongs to.`, 'Set parent.');
    }
    let parentLabel: string | null = null;
    let parentOid: string | undefined;
    let parentProject: string | undefined;
    if (input.parent !== undefined) {
      const parent = await planTarget(ctx, input.parent, { types: PARENT_TYPES[type], fields: ['Scope'] });
      parentOid = parent.oid;
      parentProject = oidsOf(parent.row['Scope'])[0];
      parentLabel = labelOf(parent.name ?? parent.oid, parent.oid);
    }

    let projectRef: { readonly oid: string; readonly name: string };
    if (type === 'Task' || type === 'Test') {
      // A task or test lives in its parent's project (Agility derives it): a different project is refused.
      if (parentProject === undefined) throw invalid('The parent has no Agility project.');
      if (input.project !== undefined) {
        const given = await resolveProject(ctx, input.project);
        if (given.oid !== parentProject) {
          throw invalid(
            `A ${type} is created in its parent's project; ${input.project.slice(0, 60)} is another one.`,
            'Omit project or use the parent’s.',
          );
        }
      }
      projectRef = await projectOf(ctx, parentProject);
    } else {
      if (input.project === undefined)
        throw invalid('Give the Agility project to create the item in.', 'Set project.');
      const given = await resolveProject(ctx, input.project);
      projectRef = await projectOf(ctx, given.oid);
    }

    // Every attribute must exist on this instance and be writable; Agility's own required-field rules apply on write.
    await requireWritable(ctx, type, 'Name');
    await requireWritable(ctx, type, 'Scope', { relation: true, multi: false });
    if (description !== undefined) await requireWritable(ctx, type, 'Description');
    if (estimate !== undefined && estimateAttribute !== undefined)
      await requireWritable(ctx, type, estimateAttribute);
    if (parentOid !== undefined) await requireWritable(ctx, type, relation, { relation: true, multi: false });
    const priority =
      input.priority === undefined ? undefined : await resolvePriority(ctx, type, input.priority);

    const duplicate = await recentDuplicate(ctx, type, projectRef.oid, parentOid, name);
    if (duplicate !== undefined) {
      throw invalid(
        `You already created a ${type} with this title here in the last 30 minutes (${duplicate.number ?? duplicate.oid}), so this call was not repeated.`,
        'Read it with get_work_item. For a second, different item use another title.',
      );
    }

    const changes: Array<{ field: string; old: null; new: string | number }> = [
      { field: 'AssetType', old: null, new: type },
      { field: 'Name', old: null, new: name },
    ];
    if (description !== undefined) changes.push({ field: 'Description', old: null, new: description });
    if (estimate !== undefined && estimateAttribute !== undefined) {
      changes.push({ field: estimateAttribute, old: null, new: estimate });
    }
    if (priority !== undefined)
      changes.push({ field: 'Priority', old: null, new: labelOf(priority.name, priority.oid) });
    if (parentLabel !== null) changes.push({ field: relation, old: null, new: parentLabel });
    return {
      mutation: {
        operation: 'create_work_item',
        target: { assetType: 'Scope', oid: projectRef.oid },
        changes,
      },
      label: projectRef.name,
    };
  },
  async reread(plan, ctx) {
    const type = newValue(plan.mutation.changes, 'AssetType') as FieldType;
    const relation = PARENT_RELATION[type];
    const project = plan.mutation.target.oid;
    const now = await readTarget(ctx, 'Scope', project, []);
    if (now === undefined || !OPEN_STATES.has(now.state)) throw conflict(project);
    const parentLabel = newValue(plan.mutation.changes, relation);
    let parentOid: string | undefined;
    if (typeof parentLabel === 'string') {
      parentOid = oidOfLabel(parentLabel);
      const parentType = parentOid.split(':')[0] as string;
      const parent = await rereadTarget(ctx, parentType, parentOid, ['Scope']);
      if ((type === 'Task' || type === 'Test') && oidsOf(parent.row['Scope'])[0] !== project) {
        throw conflict(parent.number ?? parentOid);
      }
    }
    const name = newValue(plan.mutation.changes, 'Name') as string;
    const duplicate = await recentDuplicate(ctx, type, project, parentOid, name);
    if (duplicate !== undefined) {
      throw new AbError(
        ErrorCode.WriteConflict,
        `A ${type} with this title was created by you a moment ago (${duplicate.number ?? duplicate.oid}), so nothing was created.`,
        { hint: 'Read it with get_work_item instead of repeating the call.' },
      );
    }
    // A create has no current value: every field is still empty, so none of them is "already applied" or "moved".
    return { values: Object.fromEntries(plan.mutation.changes.map((c) => [c.field, null])) };
  },
  async send(plan, ctx) {
    const c = plan.mutation.changes;
    const type = newValue(c, 'AssetType');
    const name = newValue(c, 'Name');
    if (typeof type !== 'string' || typeof name !== 'string') {
      throw new AbError(ErrorCode.Internal, 'create_work_item lost its change.');
    }
    const field = type as FieldType;
    const description = newValue(c, 'Description');
    const estimateAttribute = estimateField(field);
    const estimate = estimateAttribute === undefined ? undefined : newValue(c, estimateAttribute);
    const priority = newValue(c, 'Priority');
    const parent = newValue(c, PARENT_RELATION[field]);
    return postAsset(ctx, type, undefined, [
      { attribute: 'Name', value: name },
      ...(typeof description === 'string'
        ? [{ attribute: 'Description', value: descriptionHtml(description) }]
        : []),
      ...(typeof estimate === 'number' && estimateAttribute !== undefined
        ? [{ attribute: estimateAttribute, value: estimate }]
        : []),
      { relation: 'Scope', act: 'set' as const, oids: [plan.mutation.target.oid] },
      ...(typeof priority === 'string'
        ? [{ relation: 'Priority', act: 'set' as const, oids: [oidOfLabel(priority)] }]
        : []),
      ...(typeof parent === 'string'
        ? [{ relation: PARENT_RELATION[field], act: 'set' as const, oids: [oidOfLabel(parent)] }]
        : []),
    ]);
  },
});

/**
 * The plan and the re-read of one call share a resolution memo, so the caller's member (the duplicate scan) is looked up
 * once, not twice (P7-09). The memo lives for this call only (L-096).
 */
export const createWorkItem: ToolDefinition = {
  ...defined,
  handler: (input, ctx) => defined.handler(input, withMemo(ctx)),
};
