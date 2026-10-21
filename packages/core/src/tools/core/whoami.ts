// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { resolveMember } from '../../identity/resolve.ts';
import { metadataFor } from '../../metadata/service.ts';
import { shapeOutput, untrusted } from '../../output/result.ts';
import { defineTool, type ToolDefinition } from '../../tool.ts';

export const whoami: ToolDefinition = defineTool({
  name: 'whoami',
  title: 'Who am I',
  description:
    'Show the connection: the Agility instance and version, the member behind the token, the workspace, its allowed Agility projects and asset types, enabled tool groups, limits by unit, the per-call request budget, and whether writes and which approval channel are available. Not paged.',
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
    limits: z.record(z.string(), z.union([z.number(), z.boolean()])),
    budget: z.looseObject({ requestsPerCall: z.number(), requestsUsed: z.number() }),
    writes: z.looseObject({ enabled: z.boolean(), approval: z.string() }),
  }),
  handler: async (_input, ctx) => {
    const member = await resolveMember(ctx, 'me');
    const version = metadataFor(ctx).fingerprint?.match(/^"(\d+(?:\.\d+){1,3})/)?.[1];
    const { workspace, projects, assetTypes, limits, budget } = ctx;
    const username = typeof member.row['Username'] === 'string' ? member.row['Username'] : undefined;
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
      writes: { ...workspace.writes },
    };
    const notes = [
      projects.allowed.length === 0
        ? 'Every Agility project the member can see is in scope (no project restriction).'
        : `${projects.allowed.length} allowed Agility project(s)${projects.includeChildren ? ' and their sub-projects' : ''}; list_projects shows their names.`,
      workspace.writes.enabled
        ? `Writes are enabled; approval: ${workspace.writes.approval}.`
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
