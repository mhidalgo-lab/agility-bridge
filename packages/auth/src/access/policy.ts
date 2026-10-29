// SPDX-License-Identifier: Apache-2.0
// The policy vocabulary of workspaces and grants (ARCHITECTURE §4, ADR-0008): the JSON columns of storage parsed into
// typed policies, and the rules that combine them. A workspace sets limits; a grant can only tighten them (L-062):
// numbers take the minimum, allow lists intersect, deny lists union, switches can only be turned off.
import type { Limits } from '@agility-bridge/core';
import { z } from 'zod';

export const SCOPE_OID = /^Scope:\d{1,12}$/;
export const TYPE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export const TOOL_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

const scopeIds = z.array(z.string().regex(SCOPE_OID)).max(1_000);
const toolNames = z.array(z.string().regex(TOOL_NAME).max(64)).max(200);
const typeNames = z.array(z.string().regex(TYPE_NAME)).max(500);

export const assetTypePolicySchema = z.strictObject({
  /** Only these types (absent = every type the instance exposes). */
  allow: typeNames.optional(),
  deny: typeNames.optional(),
});
export type AssetTypePolicy = z.infer<typeof assetTypePolicySchema>;

/** Numeric limits with their hard bounds, and feature switches (tool conventions, ADR-0010). */
export const limitsPolicySchema = z.strictObject({
  defaultRows: z.number().int().min(1).max(1_000).optional(),
  maxRows: z.number().int().min(1).max(1_000).optional(),
  maxFields: z.number().int().min(1).max(200).optional(),
  maxNestingDepth: z.number().int().min(0).max(5).optional(),
  maxAggregations: z.number().int().min(0).max(50).optional(),
  maxAnyOfGroups: z.number().int().min(0).max(20).optional(),
  maxResponseBytes: z
    .number()
    .int()
    .min(65_536)
    .max(64 * 1024 * 1024)
    .optional(),
  maxAsOfAgeDays: z.number().int().min(0).max(3_650).optional(),
  maxTimeRangeDays: z.number().int().min(1).max(3_660).optional(),
  /** Agility requests per tool call (ADR-0010). */
  callBudget: z.number().int().min(1).max(10_000).optional(),
  /** Member emails in output (D-06). */
  memberEmails: z.boolean().optional(),
  /** The generic `query_assets` / `get_assets` tools. */
  genericQuery: z.boolean().optional(),
  /** `get_attachment`, the text content of one attachment (D-08): off unless the workspace turns it on. */
  attachmentDownload: z.boolean().optional(),
  /** The composite reports (`sprint_health`, …): off unless the workspace turns them on (D-101). */
  reports: z.boolean().optional(),
  /** Largest attachment `get_attachment` reads, in bytes. */
  attachmentMaxBytes: z
    .number()
    .int()
    .min(1_024)
    .max(8 * 1024 * 1024)
    .optional(),
});
export type LimitsPolicy = z.infer<typeof limitsPolicySchema>;

/** Writes per workspace (ADR-0013); write tools also need the server switch and an explicit listing (Phase 7). */
export const writePolicySchema = z.strictObject({
  enabled: z.boolean().optional(),
});
export type WritePolicy = z.infer<typeof writePolicySchema>;

/** Per-grant rate limit (P2-07). */
export const rateLimitPolicySchema = z.strictObject({
  perMinute: z.number().int().min(1).max(100_000).optional(),
  /**
   * Writes per hour for this grant (P7-15): a cap an owner sets. The write limiter uses the lower of this and the
   * deployment's `AB_WRITE_RATE_PER_GRANT_HOURLY`; setting one above the deployment's value is refused.
   */
  writesPerHour: z.number().int().min(1).max(1_000).optional(),
});
export type RateLimitPolicy = z.infer<typeof rateLimitPolicySchema>;

export const workspacePolicySchema = z.strictObject({
  allowedScopeIds: scopeIds.min(1),
  includeChildScopes: z.boolean(),
  assetTypes: assetTypePolicySchema.nullable(),
  enabledTools: toolNames.nullable(),
  limits: limitsPolicySchema,
  writePolicy: writePolicySchema,
});
export type WorkspacePolicy = z.infer<typeof workspacePolicySchema>;

export const grantPolicySchema = z.strictObject({
  tools: toolNames.nullable(),
  scopeIds: scopeIds.min(1).nullable(),
  assetTypes: assetTypePolicySchema.nullable(),
  limits: limitsPolicySchema,
  rateLimit: rateLimitPolicySchema.nullable(),
});
export type GrantPolicy = z.infer<typeof grantPolicySchema>;

/** The numbers and switches of `limitsPolicySchema` and how a grant tightens each. */
const NUMBER_LIMITS = [
  'defaultRows',
  'maxRows',
  'maxFields',
  'maxNestingDepth',
  'maxAggregations',
  'maxAnyOfGroups',
  'maxResponseBytes',
  'maxAsOfAgeDays',
  'maxTimeRangeDays',
  'attachmentMaxBytes',
  'callBudget',
] as const;
const SWITCHES = ['memberEmails', 'genericQuery', 'attachmentDownload', 'reports'] as const;

/** What a deployment allows at most and uses by default (runtime presets, ADR-0010). */
export interface DeploymentLimits {
  /** Defaults where a workspace says nothing. */
  readonly defaults: Limits & { readonly callBudget: number; readonly genericQuery: boolean };
  /** Values no workspace may exceed on this runtime (e.g. the Workers Free response cap). */
  readonly ceilings: Partial<Record<(typeof NUMBER_LIMITS)[number], number>>;
}

export type EffectiveLimits = Limits & { readonly callBudget: number; readonly genericQuery: boolean };

/**
 * Workspace limits over the deployment defaults (capped by its ceilings), tightened by the grant: numbers take the
 * minimum, switches stay on only when both allow them. `warnings` name grant values that tried to loosen a limit.
 */
export function effectiveLimits(
  deployment: DeploymentLimits,
  workspace: LimitsPolicy,
  grant: LimitsPolicy,
): { limits: EffectiveLimits; warnings: string[] } {
  const warnings: string[] = [];
  const out: Record<string, number | boolean | readonly string[]> = { ...deployment.defaults };
  for (const key of NUMBER_LIMITS) {
    let value = workspace[key] ?? deployment.defaults[key];
    const ceiling = deployment.ceilings[key];
    if (ceiling !== undefined) value = Math.min(value, ceiling);
    const g = grant[key];
    if (g !== undefined) {
      if (g > value)
        warnings.push(`The grant's ${key} (${g}) is above the workspace's (${value}); ${value} applies.`);
      value = Math.min(value, g);
    }
    out[key] = value;
  }
  for (const key of SWITCHES) {
    const ws = workspace[key] ?? deployment.defaults[key];
    const g = grant[key];
    if (g === true && !ws) warnings.push(`The grant turns ${key} on, but the workspace has it off.`);
    out[key] = ws && g !== false;
  }
  // A default page larger than the maximum would be refused by every tool.
  out['defaultRows'] = Math.min(out['defaultRows'] as number, out['maxRows'] as number);
  return { limits: Object.freeze(out) as unknown as EffectiveLimits, warnings };
}

/** Allow lists intersect (absent = no restriction), deny lists union. */
export function effectiveAssetTypes(
  workspace: AssetTypePolicy | null,
  grant: AssetTypePolicy | null,
): { allow?: readonly string[]; deny: readonly string[] } {
  const wa = workspace?.allow;
  const ga = grant?.allow;
  const allow = wa === undefined ? ga : ga === undefined ? wa : wa.filter((t) => ga.includes(t));
  const deny = [...new Set([...(workspace?.deny ?? []), ...(grant?.deny ?? [])])];
  return allow === undefined ? { deny } : { allow: [...new Set(allow)], deny };
}
