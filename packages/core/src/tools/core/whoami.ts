// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { QueryCacheInfo } from '../../agility/query-cache.ts';
import type { QuotaPeriodUsage, QuotaUsage } from '../../agility/quota.ts';
import { resolveMember } from '../../identity/resolve.ts';
import { metadataFor } from '../../metadata/service.ts';
import { shapeOutput, untrusted } from '../../output/result.ts';
import { defineTool, type ToolDefinition } from '../../tool.ts';
import { callerWriteBudget } from '../../writes/budget.ts';
import { compositeWarnings } from '../reports/siblings.ts';

const iso = (ms: number): string => new Date(ms).toISOString();

/** The quota as `whoami` shows it: numbers and reset instants of this grant only. */
function quotaView(usage: QuotaUsage) {
  if (usage.status !== 'ok') return { status: 'unknown' as const };
  const part = (p: QuotaPeriodUsage | undefined) =>
    p === undefined
      ? {}
      : { used: p.used, limit: p.limit, remaining: p.remaining, resetsAt: iso(p.resetsAt), warning: p.warn };
  return {
    status: 'ok' as const,
    ...(usage.daily === undefined ? {} : { daily: part(usage.daily) }),
    ...(usage.monthly === undefined ? {} : { monthly: part(usage.monthly) }),
  };
}

/** A note when a quota is nearly or fully used (80%, L-116), or cannot be read. */
function quotaNotes(usage: QuotaUsage | undefined): string[] {
  if (usage === undefined) return [];
  if (usage.status !== 'ok')
    return ['The Agility request quota of this connection cannot be read right now.'];
  const out: string[] = [];
  for (const [name, p] of [
    ['today', usage.daily],
    ['this month', usage.monthly],
  ] as const) {
    if (p === undefined) continue;
    if (p.remaining === 0) {
      out.push(
        `This connection has used its Agility request quota for ${name}; reads are refused until ${iso(p.resetsAt)} (UTC).`,
      );
    } else if (p.warn) {
      out.push(
        `${p.used} of ${p.limit} Agility requests used ${name} (${p.remaining} left, resets ${iso(p.resetsAt)} UTC): use them sparingly.`,
      );
    }
  }
  return out;
}

/** Settings and the shared tier's proof only: hit counters are per process and would show other callers' activity (T16). */
const cacheStatus = ({ mode, ttlSeconds, shared, sharedMaxEntryChars }: QueryCacheInfo) => ({
  mode,
  ttlSeconds,
  shared,
  // Answers above this many characters are kept in memory only, never in the shared tier (P8-38).
  ...(sharedMaxEntryChars === undefined ? {} : { sharedMaxEntryChars }),
});

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
    // The grant's Agility request quota (P8-09): used, left and when it restarts, read with one statement; unknown when the
    // counters cannot be read, never "unlimited".
    const quota = ctx.quota === undefined ? undefined : await ctx.quota.usage();
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
      // Honest cache status (P8-01, L-098): whether answers may be reused, for how long, and whether the shared tier was
      // proven by a read-back. Configuration and counters only, never cached data.
      ...(ctx.queryCache === undefined || ctx.writes !== undefined
        ? {}
        : { queryCache: cacheStatus(ctx.queryCache.cache.info()) }),
      ...(quota === undefined ||
      (quota.status === 'ok' && quota.daily === undefined && quota.monthly === undefined)
        ? {}
        : { quota: quotaView(quota) }),
      ...(warnings.length === 0 ? {} : { warnings }),
      ...(hidden.length === 0 ? {} : { hiddenByBudget: hidden.map((t) => t.name) }),
    };
    const notes = [
      ...quotaNotes(quota),
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
