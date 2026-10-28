// SPDX-License-Identifier: Apache-2.0
// The work-item row of the typed tools (catalogue: number, assetType, name, status, owners, sprint, estimate).
import type { ToolContext } from '../../context.ts';
import { oidsOf } from '../../identity/scope.ts';
import { metadataFor } from '../../metadata/service.ts';
import { assetState } from '../../output/result.ts';
import { utcIso } from '../../output/text.ts';
import { num, text } from '../common.ts';

export const WORK_ITEM_TYPES = ['Story', 'Defect', 'Task', 'Test'] as const;
export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];

/** The fields a work-item row needs, limited to what the type has on this instance. */
export async function workItemFields(ctx: ToolContext, type: string): Promise<string[]> {
  const meta = await metadataFor(ctx).assetType(type);
  const has = (a: string) => meta.attributes.has(a.split('.')[0] as string);
  const changed = has('ChangeDateUTC') ? 'ChangeDateUTC' : 'ChangeDate';
  return [
    'Name',
    'Status.Name',
    'Owners.Name',
    'Timebox',
    'Timebox.Name',
    'Team.Name',
    'Estimate',
    'DetailEstimate',
    'ToDo',
    changed,
  ].filter(has);
}

export const identityFor = (type: string, ctx: ToolContext): Promise<string[]> =>
  metadataFor(ctx)
    .assetType(type)
    .then((meta) =>
      ['Number', 'AssetState', 'Scope', 'Scope.Name'].filter((f) =>
        meta.attributes.has(f.split('.')[0] as string),
      ),
    );

const texts = (v: unknown) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : [];

export function workItem(type: string, row: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const project = oidsOf(row['Scope'])[0];
  const sprint = oidsOf(row['Timebox'])[0];
  const changed = text(row['ChangeDateUTC']) ?? text(row['ChangeDate']);
  const created = text(row['CreateDateUTC']);
  const fields: Array<[string, unknown]> = [
    ['number', text(row['Number'])],
    ['assetType', type],
    ['oid', oidsOf(row['_oid'])[0] ?? ''],
    ['state', assetState(row['AssetState'], type)],
    [
      'project',
      project === undefined
        ? undefined
        : { oid: project, ...(text(row['Scope.Name']) === undefined ? {} : { name: row['Scope.Name'] }) },
    ],
    ['name', text(row['Name'])],
    ['status', text(row['Status.Name'])],
    ['owners', texts(row['Owners.Name']).length > 0 ? texts(row['Owners.Name']) : undefined],
    [
      'sprint',
      sprint === undefined
        ? undefined
        : { oid: sprint, ...(text(row['Timebox.Name']) === undefined ? {} : { name: row['Timebox.Name'] }) },
    ],
    ['team', text(row['Team.Name'])],
    ['estimate', num(row['Estimate'])],
    ['detailEstimateHours', num(row['DetailEstimate'])],
    ['toDoHours', num(row['ToDo'])],
    ['changedAt', changed === undefined ? undefined : (utcIso(changed) ?? changed)],
    ['createdAt', created === undefined ? undefined : (utcIso(created) ?? created)],
  ];
  return Object.fromEntries(fields.filter(([, v]) => v !== undefined));
}
