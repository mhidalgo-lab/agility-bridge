// SPDX-License-Identifier: Apache-2.0
// Relations the two wave-2 tools may set (P7-21): `owners`, `team` and `sprint` on create, and a new `parent` or `project`
// on update. Each is resolved inside the workspace's projects like any other target, shown in the approval as
// `Name [OID]` (old and new) and sent in the one request of the tool. Nothing here is a free attribute: a relation must be
// one the type lets this instance write. The request shapes are *unverified* until the sandbox (P7-07).
import type { ToolContext } from '../../context.ts';
import { resolveMember, resolveProject, resolveSprint, resolveTeam } from '../../identity/resolve.ts';
import { oidsOf } from '../../identity/scope.ts';
import { invalid } from '../../query/limits.ts';
import { text } from '../common.ts';
import {
  assertTypeAllowed,
  conflict,
  labelFrom,
  labelOf,
  planTarget,
  requireWritable,
  rereadTarget,
  sortedLabels,
  type Target,
} from './common.ts';
import { type FieldType, PARENT_RELATION, PARENT_TYPES } from './fields.ts';

/** Types that may be moved to another project: a task or test lives in its parent's project and moves with it. */
export const MOVABLE_TYPES: readonly string[] = ['Story', 'Defect', 'Epic'];
/** At most three members on a create: each name can take up to three lookups, and the declared cost is sized for three (D-199). */
export const MAX_OWNERS = 3;

/** Members as `Name [Member:id]` labels, each once, in a stable order; the type must let this instance write `Owners`. */
export async function planOwners(
  ctx: ToolContext,
  type: FieldType,
  owners: readonly string[],
): Promise<readonly string[]> {
  assertTypeAllowed(ctx, 'Member');
  await requireWritable(ctx, type, 'Owners', { relation: true, multi: true });
  const byOid = new Map<string, string>();
  for (const ref of owners) {
    const m = await resolveMember(ctx, ref);
    byOid.set(m.oid, labelOf(text(m.row['Name']) ?? m.name, m.oid));
  }
  return sortedLabels([...byOid.values()]);
}

/** The team the new item belongs to. */
export async function planTeam(ctx: ToolContext, type: FieldType, ref: string): Promise<string> {
  assertTypeAllowed(ctx, 'Team');
  await requireWritable(ctx, type, 'Team', { relation: true, multi: false });
  const team = await resolveTeam(ctx, ref);
  return labelOf(team.name, team.oid);
}

/** `AssetState` of one sprint is read by `move_to_sprint`; a sprint is open when it is active or future. */
export const SPRINT_OPEN = (state: number | undefined): boolean => state === 64 || state === 0;

/** The sprint of the new item's project schedule; closed sprints are refused by the caller with the state it reads. */
export async function planSprint(
  ctx: ToolContext,
  type: FieldType,
  ref: string,
  project: string,
  sprintState: (ctx: ToolContext, oid: string) => Promise<number | undefined>,
): Promise<string> {
  assertTypeAllowed(ctx, 'Timebox');
  await requireWritable(ctx, type, 'Timebox', { relation: true, multi: false });
  const sprint = await resolveSprint(ctx, ref, { project });
  const state = await sprintState(ctx, sprint.oid);
  if (state === undefined) throw invalid('That sprint is not visible in this workspace.');
  if (!SPRINT_OPEN(state)) {
    throw invalid(`The sprint "${sprint.name.slice(0, 80)}" is closed.`, 'Choose an open sprint.');
  }
  return labelOf(sprint.name, sprint.oid);
}

/**
 * Re-parenting: the relation is `Super` (an epic above a backlog item, defect or epic) or `Parent` (a story or defect
 * above a task or test). The new parent is found inside the workspace and must be open; a task or test stays in its
 * parent's project, so a parent of another project is refused.
 */
export async function planParent(
  ctx: ToolContext,
  type: FieldType,
  target: Target,
  ref: string,
): Promise<{ readonly field: string; readonly old: string | null; readonly new: string }> {
  const relation = PARENT_RELATION[type];
  await requireWritable(ctx, type, relation, { relation: true, multi: false });
  const parent = await planTarget(ctx, ref, { types: PARENT_TYPES[type], fields: ['Scope'] });
  if (parent.oid === target.oid) throw invalid('An item cannot be its own parent.');
  if (
    (type === 'Task' || type === 'Test') &&
    oidsOf(parent.row['Scope'])[0] !== oidsOf(target.row['Scope'])[0]
  ) {
    throw invalid(
      `${parent.number ?? parent.oid} is in another project: a ${type} stays in its parent's project.`,
      'Choose a parent of the same project.',
    );
  }
  return {
    field: relation,
    old: labelFrom(target.row, relation),
    new: labelOf(parent.name ?? parent.oid, parent.oid),
  };
}

/**
 * Moving to another project of the workspace (a story, defect or epic). The target project is resolved and checked by the
 * caller's `open` (it must be open and inside the workspace); an item that is in a sprint is refused (D-240), because the
 * sprint belongs to the old project's schedule.
 */
export async function planMove(
  ctx: ToolContext,
  type: FieldType,
  target: Target,
  ref: string,
  open: (ctx: ToolContext, oid: string) => Promise<{ readonly oid: string; readonly name: string }>,
): Promise<{ readonly field: string; readonly old: string | null; readonly new: string }> {
  if (!MOVABLE_TYPES.includes(type)) {
    throw invalid(
      `A ${type} is in its parent's project and moves with it.`,
      'Move the parent, or re-parent this item under one in the other project.',
    );
  }
  await requireWritable(ctx, type, 'Scope', { relation: true, multi: false });
  const given = await resolveProject(ctx, ref);
  const project = await open(ctx, given.oid);
  const now = oidsOf(target.row['Scope'])[0];
  if (project.oid !== now && oidsOf(target.row['Timebox'])[0] !== undefined) {
    throw invalid(
      `${target.number ?? target.oid} is in a sprint of its current project.`,
      'Take it out of the sprint first (move_to_sprint with to_backlog), then move it.',
    );
  }
  return {
    field: 'Scope',
    old: labelFrom(target.row, 'Scope'),
    new: labelOf(project.name, project.oid),
  };
}

/**
 * At the re-read: a new parent must still exist, be open and (for a task or test) still be in the item's project; a moving
 * item must still be out of a sprint. Anything else is a conflict, never a quiet success.
 */
export async function rereadRelations(
  ctx: ToolContext,
  type: FieldType,
  now: Target,
  changes: readonly { readonly field: string; readonly old: unknown; readonly new: unknown }[],
  oidOfLabel: (label: string) => string,
): Promise<void> {
  const relation = PARENT_RELATION[type];
  for (const c of changes) {
    if (c.old === c.new || typeof c.new !== 'string') continue;
    if (c.field === relation) {
      const parentOid = oidOfLabel(c.new);
      const parent = await rereadTarget(ctx, parentOid.split(':')[0] as string, parentOid, ['Scope']);
      if (
        (type === 'Task' || type === 'Test') &&
        oidsOf(parent.row['Scope'])[0] !== oidsOf(now.row['Scope'])[0]
      ) {
        throw conflict(parent.number ?? parentOid);
      }
    }
    if (c.field === 'Scope' && oidsOf(now.row['Timebox'])[0] !== undefined) {
      throw conflict(now.number ?? now.oid);
    }
  }
}
