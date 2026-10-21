// SPDX-License-Identifier: Apache-2.0
// Result recheck (L-064, L-145): the query already carries the workspace's Agility-project restriction, and every row
// that comes back is checked again from the scope fields the compiler selected, so a row the upstream should not have
// returned (or one from a single-asset URL, which ignores filters) never reaches the caller.
import type { ToolContext } from '../context.ts';
import type { CompiledQuery } from '../query/compiler.ts';

/** OID tokens in a relation value: `"Scope:5"`, `{ _oid }`, or arrays of them. */
export function oidsOf(value: unknown): string[] {
  if (typeof value === 'string')
    return value === '' || value === 'NULL' ? [] : [value.split(':').slice(0, 2).join(':')];
  if (Array.isArray(value)) return value.flatMap(oidsOf);
  if (value !== null && typeof value === 'object') {
    const oid = (value as { _oid?: unknown })._oid;
    return typeof oid === 'string' ? oidsOf(oid) : [];
  }
  return [];
}

/** Whether a returned row is inside the workspace's Agility projects (the compiled query's project set). */
export function inScope(
  ctx: ToolContext,
  compiled: Pick<CompiledQuery, 'strategy' | 'scopes'>,
  row: Readonly<Record<string, unknown>>,
): boolean {
  if (ctx.projects.allowed.length === 0) return true;
  const { strategy, scopes } = compiled;
  const hit = (field: string) => oidsOf(row[field]).some((o) => scopes.includes(o));
  switch (strategy.kind) {
    case 'direct':
    case 'derived':
      return hit(strategy.path);
    case 'workspace_bounded':
      return strategy.via === 'self' ? hit('_oid') : hit('Schedule.ScheduledScopes');
    case 'global':
      return true;
    default:
      return false;
  }
}
