// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { resolveMember } from '../../identity/resolve.ts';
import { metadataFor } from '../../metadata/service.ts';
import { shapeOutput, untrusted } from '../../output/result.ts';
import { defineTool, type ToolDefinition } from '../../tool.ts';
import { callerWriteBudget } from '../../writes/budget.ts';
import { compositeWarnings } from '../reports/siblings.ts';

export const whoami: ToolDefinition = defineTool({
  name: 'whoami',
  title: 'Who am I',
  description:
    'Show who you are connected as: the Agility instance and version, the member behind the token, the workspace, which projects and asset types you can see, enabled tool groups, limits, the per-call request budget, write availability and budget. Not paged.',
  kind: 'read',
  group: 'core',
  // Member metadata (cold cache) and the member query.
  cost: 2,
  inputSchema: z.object({}),
  outputSchema: z.looseObject({
    member: z.looseObject({ oid: z.string(), name: z.string(), username: z.string().optional() }),
    instance: z.looseObject({ id: z.string(), url: z.string(), version: z.string().optional() }),
    workspace: z.looseObject({ id: z.string(), name: z.string(), groups: z.array(z.string()) }),
    projects: z.looseObject({ allowed: z.array(z.string()), includeChildProjects: z.boolean() }),
    assetTypes: z.looseObject({ allow: z.array(z.string()).optional(), deny: z.array(z.string()) }),
    limits: z.looseObject({ maxRows: z.number() }),
    budget: z.looseObject({ requestsPerCall: z.number() }),
    writes: z.looseObject({
      enabled: z.boolean(),
      approval: z.string(),
      budget: z.looseObject({ status: z.string() }).optional(),
    }),
    notes: z.array(z.string()).optional(),
  }),
  handler: async (_input, ctx) => {
    const member = await resolveMember(ctx, 'me');
    const version = metadataFor(ctx).fingerprint?.match(/^"(\d+(?:\.\d+){1,3})/)?.[1];
    const { workspace, projects, assetTypes, limits, budget } = ctx;
    const username = typeof member.row['Username'] === 'string' ? member.row['Username'] : undefined;
    const warnings = compositeWarnings(ctx.grantedTools ?? []);
    const hidden = ctx.hiddenByBudget ?? [];
    // The grant's own write budget for this hour, read without taking a unit (P7-16).
    const writeBudget = workspace.writes.enabled ? await callerWriteBudget(ctx) : undefined;
    const structured = {
      member: { oid: member.oid, name: member.name, ...(username === undefined ? {} : { username }) },
      instance: {
        id: ctx.instance.id,
        url: ctx.instance.baseUrl,
        ...(version === undefined ? {} : { version }),
      },
      workspace: { id: workspace.id, name: workspace.name, groups: [...workspace.groups] },
      projects: { allowed: [...projects.allowed], includeChildProjects: projects.includeChildren },
      assetTypes: {
        ...(assetTypes.allow === undefined ? {} : { allow: [...assetTypes.allow] }),
        deny: [...assetTypes.deny],
      },
      limits: { ...limits },
      budget: { requestsPerCall: budget.limit, requestsUsed: budget.used },
      // Only how many custom attributes are enabled for writing, never their names (THREAT_MODEL A12, P7-20): a refusal
      // names what the caller sent, and describe_asset_type shows the attributes in enveloped output.
      writes: {
        enabled: workspace.writes.enabled,
        approval: workspace.writes.approval,
        ...((workspace.writes.customFields?.length ?? 0) > 0
          ? { customFields: workspace.writes.customFields?.length }
          : {}),
        // The grant's own writes left this hour (P7-16).
        ...(writeBudget === undefined ? {} : { budget: writeBudget }),
      },
      ...(warnings.length === 0 ? {} : { warnings }),
      ...(hidden.length === 0 ? {} : { hiddenByBudget: hidden.map((t) => t.name) }),
    };
    const notes = [
      ...warnings.map((w) => w.message),
      ...(hidden.length === 0
        ? []
        : [
            `Not listed because the per-call budget is ${budget.limit} requests: ${hidden.map((t) => `${t.name} (needs ${t.cost})`).join(', ')}. Raise callBudget to list them.`,
          ]),
      projects.allowed.length === 0
        ? 'Every Agility project the member can see is in scope (no project restriction).'
        : `${projects.allowed.length} allowed Agility project(s)${projects.includeChildren ? ' and their sub-projects' : ''}; list_projects shows their names.`,
      workspace.writes.enabled
        ? `Writes are enabled; approval: ${workspace.writes.approval}.${
            writeBudget === undefined
              ? ''
              : writeBudget.status === 'ok'
                ? ` ${writeBudget.remaining} of ${writeBudget.limit} writes left this hour (resets ${writeBudget.resetsAt}).${writeBudget.deploymentFull === true ? ' The whole deployment has used its writes for this hour, so a write would be refused.' : ''}`
                : ' The writes left this hour are unknown right now.'
          }`
        : 'Writes are off: every tool is read-only.',
      'Agility access tokens act fully as their member and do not expire: revoke the token on the Agility Applications page when it is no longer needed.',
    ];
    return shapeOutput(ctx, {
      summary: [
        'Connected to ',
        ctx.instance.id,
        version === undefined ? '' : ` (Agility ${version})`,
        ' as ',
        untrusted(member.name),
        '.',
      ],
      notes,
      blocks: [
        {
          title: 'Limits (per call)',
          source: 'limits',
          rows: Object.entries({ ...limits, requestsPerCall: budget.limit }).map(([limit, value]) => ({
            limit,
            value,
          })),
        },
      ],
      structured,
    }).output;
  },
});
