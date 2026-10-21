// SPDX-License-Identifier: Apache-2.0
// The one effective-permission resolver (ADR-0008, L-063, THREAT_MODEL T3, A5): a pure function of the stored records,
// the deployment's settings and the time. Anything missing, disabled, revoked, expired, unvalidated or malformed
// denies; the audience (the workspace a token is bound to) is checked before anything else (L-067).
import type { AccessToken, Credential, Grant, Instance, User, Workspace } from '@agility-bridge/storage';
import {
  type AssetTypePolicy,
  type DeploymentLimits,
  type EffectiveLimits,
  effectiveAssetTypes,
  effectiveLimits,
  type GrantPolicy,
  grantPolicySchema,
  type WorkspacePolicy,
  workspacePolicySchema,
} from './policy.ts';

/** What a tool is, as far as access is concerned (from the tool registry). */
export interface ToolInfo {
  readonly kind: 'read' | 'write' | 'destructive';
  readonly group: string;
}

export interface AccessSettings {
  /** Every tool the server knows, by name. */
  readonly tools: ReadonlyMap<string, ToolInfo>;
  /** The server-level switch for write tools (`AB_WRITE_TOOLS`, ADR-0013). */
  readonly writesEnabled: boolean;
  readonly limits: DeploymentLimits;
}

/** How the caller authenticated. */
export type Principal =
  | { readonly kind: 'device_token'; readonly token: AccessToken }
  /** OAuth (Phase 5): the provider's grant props, already validated for this workspace's resource. */
  | {
      readonly kind: 'oauth';
      readonly grantId: string;
      readonly workspaceId: string;
      readonly writeScope: boolean;
      readonly expiresAt: number | null;
    };

/** The records one request needs, loaded in one go (`loadAccessRecords`). Missing ones are `null`. */
export interface AccessRecords {
  readonly grant: Grant | null;
  readonly workspace: Workspace | null;
  readonly instance: Instance | null;
  /** The grant's credential, or the workspace default when the grant names none. */
  readonly credential: Credential | null;
  /** The grant's user; `null` for a service grant (or when missing). */
  readonly user: User | null;
}

export type DenyReason =
  | 'wrong_workspace'
  | 'token_revoked'
  | 'token_expired'
  | 'grant_missing'
  | 'grant_revoked'
  | 'grant_expired'
  | 'workspace_missing'
  | 'workspace_disabled'
  | 'instance_missing'
  | 'instance_disabled'
  | 'user_missing'
  | 'user_disabled'
  | 'credential_missing'
  | 'credential_revoked'
  | 'credential_unvalidated'
  | 'credential_mismatch'
  | 'malformed_policy'
  | 'no_projects'
  | 'no_tools'
  | 'not_passthrough';

export interface EffectiveAccess {
  readonly workspace: { readonly id: string; readonly slug: string; readonly name: string };
  readonly instance: { readonly id: string; readonly baseUrl: string; readonly tls: Instance['tls'] };
  readonly grant: { readonly id: string; readonly userId: string | null; readonly label: string | null };
  /** The device token, when the caller used one. */
  readonly tokenId: string | null;
  readonly credential: {
    readonly id: string;
    readonly kind: 'personal' | 'shared';
    /** The stored token, sealed; `null` on a pass-through workspace, where the caller sent its own (P2-14). */
    readonly sealed: Pick<Credential, 'tokenCiphertext' | 'tokenIv' | 'keyVersion'> | null;
  };
  /** Tool names the caller may list and call. */
  readonly tools: readonly string[];
  /** Write tools among them (empty unless every write condition holds). */
  readonly writeTools: readonly string[];
  readonly projects: { readonly allowed: readonly string[]; readonly includeChildren: boolean };
  readonly assetTypes: { readonly allow?: readonly string[]; readonly deny: readonly string[] };
  readonly limits: EffectiveLimits;
  readonly rateLimit: GrantPolicy['rateLimit'];
  /** When this access ends (the earlier of the token's and the grant's expiry): caches must not outlive it. */
  readonly expiresAt: number | null;
  /** Requested access that is not effective (for the operator, never shown to the agent as permissions). */
  readonly warnings: readonly string[];
}

export type AccessDecision =
  | { readonly ok: true; readonly access: EffectiveAccess }
  | { readonly ok: false; readonly reason: DenyReason };

const deny = (reason: DenyReason): AccessDecision => ({ ok: false, reason });
const expired = (at: number | null, now: number) => at !== null && at <= now;

function parseWorkspace(w: Workspace): WorkspacePolicy | null {
  const r = workspacePolicySchema.safeParse({
    allowedScopeIds: w.allowedScopeIds,
    includeChildScopes: w.includeChildScopes,
    assetTypes: w.assetTypes,
    enabledTools: w.enabledTools,
    limits: w.limits,
    writePolicy: w.writePolicy,
  });
  return r.success ? r.data : null;
}

function parseGrant(g: Grant): GrantPolicy | null {
  const r = grantPolicySchema.safeParse({
    tools: g.tools,
    scopeIds: g.scopeIds,
    assetTypes: g.assetTypes,
    limits: g.limits,
    rateLimit: g.rateLimit,
  });
  return r.success ? r.data : null;
}

/**
 * Decides what one request may do in the workspace `slug`. Pure: the same records, settings and time give the same
 * answer, so it can be cached (≤ 60 s, never past `expiresAt`, L-068) and tested exhaustively.
 */
export function resolveAccess(
  principal: Principal,
  slug: string,
  records: AccessRecords,
  settings: AccessSettings,
  now: number,
): AccessDecision {
  const { grant, workspace, instance, credential, user } = records;

  // Audience first (L-067): a token for workspace A is rejected at B before anything else.
  if (workspace === null) return deny('workspace_missing');
  if (workspace.slug !== slug) return deny('wrong_workspace');
  if (principal.kind === 'oauth' && principal.workspaceId !== workspace.id) return deny('wrong_workspace');

  if (principal.kind === 'device_token') {
    if (principal.token.revokedAt !== null) return deny('token_revoked');
    if (expired(principal.token.expiresAt, now)) return deny('token_expired');
  } else if (expired(principal.expiresAt, now)) {
    return deny('token_expired');
  }

  if (grant === null) return deny('grant_missing');
  const grantId = principal.kind === 'device_token' ? principal.token.grantId : principal.grantId;
  if (grant.id !== grantId || grant.workspaceId !== workspace.id) return deny('grant_missing');
  if (grant.revokedAt !== null) return deny('grant_revoked');
  if (expired(grant.expiresAt, now)) return deny('grant_expired');
  if (workspace.disabledAt !== null) return deny('workspace_disabled');
  if (instance === null || instance.id !== workspace.instanceId) return deny('instance_missing');
  if (instance.disabledAt !== null) return deny('instance_disabled');

  if (grant.userId !== null) {
    if (user === null || user.id !== grant.userId) return deny('user_missing');
    if (user.disabledAt !== null) return deny('user_disabled');
  }

  // The credential: the grant's own, else the workspace default (shared only).
  const credentialId = grant.credentialId ?? workspace.defaultCredentialId;
  if (credentialId === null || credential === null || credential.id !== credentialId)
    return deny('credential_missing');
  if (credential.revokedAt !== null) return deny('credential_revoked');
  if (credential.validationStatus !== 'valid') return deny('credential_unvalidated');
  if (credential.instanceId !== workspace.instanceId) return deny('credential_mismatch');
  const kind: 'personal' | 'shared' = credential.ownerUserId === null ? 'shared' : 'personal';
  // A personal credential serves only its owner's grant (never another user's token, L-065); the default is shared.
  if (kind === 'personal' && (grant.userId === null || credential.ownerUserId !== grant.userId)) {
    return deny('credential_mismatch');
  }
  if (grant.credentialId === null && kind !== 'shared') return deny('credential_mismatch');

  const ws = parseWorkspace(workspace);
  const gp = parseGrant(grant);
  if (ws === null || gp === null) return deny('malformed_policy');
  const warnings: string[] = [];

  // Agility projects: workspace ∩ grant (exact ids; Agility enforces the member's own visibility).
  let projects = ws.allowedScopeIds;
  if (gp.scopeIds !== null) {
    const outside = gp.scopeIds.filter((s) => !ws.allowedScopeIds.includes(s));
    if (outside.length > 0)
      warnings.push(`The grant names projects outside the workspace: ${outside.join(', ')}.`);
    projects = ws.allowedScopeIds.filter((s) => (gp.scopeIds as string[]).includes(s));
  }
  if (credential.reachableScopeIds !== null) {
    const unreachable = projects.filter((s) => !(credential.reachableScopeIds as string[]).includes(s));
    if (unreachable.length > 0) {
      warnings.push(
        `The credential's member could not see ${unreachable.join(', ')} when it was last validated.`,
      );
    }
  }
  if (projects.length === 0) return deny('no_projects');

  const { limits, warnings: limitWarnings } = effectiveLimits(settings.limits, ws.limits, gp.limits);
  warnings.push(...limitWarnings);

  // Tools: workspace ∩ grant, known tools only; read tools unless every write condition holds.
  const known = settings.tools;
  const workspaceTools = ws.enabledTools ?? [...known.keys()].filter((n) => known.get(n)?.kind === 'read');
  const unknown = [...(ws.enabledTools ?? []), ...(gp.tools ?? [])].filter((n) => !known.has(n));
  if (unknown.length > 0) warnings.push(`Unknown tools ignored: ${[...new Set(unknown)].join(', ')}.`);
  const notEnabled = (gp.tools ?? []).filter((n) => known.has(n) && !workspaceTools.includes(n));
  if (notEnabled.length > 0)
    warnings.push(`The grant names tools the workspace does not enable: ${notEnabled.join(', ')}.`);
  const writesPossible =
    settings.writesEnabled &&
    ws.writePolicy.enabled === true &&
    kind === 'personal' &&
    (principal.kind === 'device_token' || principal.writeScope);
  const tools: string[] = [];
  const writeTools: string[] = [];
  for (const name of workspaceTools) {
    const info = known.get(name);
    if (info === undefined) continue;
    if (gp.tools !== null && !gp.tools.includes(name)) continue;
    if (!limits.genericQuery && info.group === 'query') continue;
    if (info.kind !== 'read') {
      // Both lists must name a write tool explicitly: "all tools" never includes one.
      const explicit = ws.enabledTools?.includes(name) === true && gp.tools?.includes(name) === true;
      if (!explicit || !writesPossible) {
        if (gp.tools?.includes(name)) {
          warnings.push(
            kind === 'shared'
              ? `${name} needs the user's own credential: shared credentials are read-only.`
              : `${name} is a write tool and writes are not enabled for this request.`,
          );
        }
        continue;
      }
      writeTools.push(name);
    }
    tools.push(name);
  }
  if (tools.length === 0) return deny('no_tools');

  const tokenExpiry = principal.kind === 'device_token' ? principal.token.expiresAt : principal.expiresAt;
  const ends = [tokenExpiry, grant.expiresAt].filter((t): t is number => t !== null);
  const assetTypes = effectiveAssetTypes(ws.assetTypes as AssetTypePolicy | null, gp.assetTypes);

  return {
    ok: true,
    access: Object.freeze({
      workspace: { id: workspace.id, slug: workspace.slug, name: workspace.name },
      instance: { id: instance.id, baseUrl: instance.baseUrl, tls: instance.tls },
      grant: { id: grant.id, userId: grant.userId, label: grant.label },
      tokenId: principal.kind === 'device_token' ? principal.token.id : null,
      credential: {
        id: credential.id,
        kind,
        sealed: {
          tokenCiphertext: credential.tokenCiphertext,
          tokenIv: credential.tokenIv,
          keyVersion: credential.keyVersion,
        },
      },
      tools: Object.freeze(tools),
      writeTools: Object.freeze(writeTools),
      projects: { allowed: Object.freeze([...projects]), includeChildren: ws.includeChildScopes },
      assetTypes,
      limits,
      rateLimit: gp.rateLimit,
      expiresAt: ends.length === 0 ? null : Math.min(...ends),
      warnings: Object.freeze(warnings),
    }),
  };
}

/**
 * Access on a pass-through workspace (P2-14, D-04): the caller authenticated with its own Agility token, already
 * validated against the workspace's instance and known here only by its HMAC fingerprint. Every workspace control
 * applies unchanged (projects, asset types, tools, limits); there is no grant, so nothing can widen or narrow them, and
 * write tools are never granted (read-only in 1.0).
 */
export function resolvePassthroughAccess(
  slug: string,
  records: Pick<AccessRecords, 'workspace' | 'instance'>,
  fingerprint: string,
  settings: AccessSettings,
): AccessDecision {
  const { workspace, instance } = records;
  if (workspace === null || workspace.slug !== slug) return deny('wrong_workspace');
  if (workspace.credentialSource !== 'passthrough') return deny('not_passthrough');
  if (workspace.disabledAt !== null) return deny('workspace_disabled');
  if (instance === null || instance.id !== workspace.instanceId) return deny('instance_missing');
  if (instance.disabledAt !== null) return deny('instance_disabled');
  const ws = parseWorkspace(workspace);
  if (ws === null) return deny('malformed_policy');
  const { limits } = effectiveLimits(settings.limits, ws.limits, {});
  const known = settings.tools;
  const candidates = ws.enabledTools ?? [...known.keys()];
  const tools = candidates.filter((name) => {
    const info = known.get(name);
    return info !== undefined && info.kind === 'read' && (limits.genericQuery || info.group !== 'query');
  });
  if (tools.length === 0) return deny('no_tools');
  const id = fingerprint.slice(0, 32);
  return {
    ok: true,
    access: Object.freeze({
      workspace: { id: workspace.id, slug: workspace.slug, name: workspace.name },
      instance: { id: instance.id, baseUrl: instance.baseUrl, tls: instance.tls },
      grant: { id: `passthrough:${id}`, userId: null, label: 'pass-through' },
      tokenId: `pt:${id}`,
      credential: { id: `pt:${id}`, kind: 'personal' as const, sealed: null },
      tools: Object.freeze(tools),
      writeTools: Object.freeze([]),
      projects: { allowed: Object.freeze([...ws.allowedScopeIds]), includeChildren: ws.includeChildScopes },
      assetTypes: effectiveAssetTypes(ws.assetTypes as AssetTypePolicy | null, null),
      limits,
      rateLimit: null,
      expiresAt: null,
      warnings: Object.freeze([]),
    }),
  };
}
