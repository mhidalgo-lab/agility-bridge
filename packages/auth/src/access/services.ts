// SPDX-License-Identifier: Apache-2.0
// Domain services over storage for instances, credentials, workspaces, grants and users (ADR-0008). Every writer — the
// admin API, the CLI, a future import — goes through these, so the rules hold on every path (L-065). Owner/admin
// guards on the actor are added with the admin API (P2-09).
import { canonicalInstanceUrl } from '@agility-bridge/core';
import {
  ConflictError,
  type Credential,
  type Grant,
  type Instance,
  InvalidInputError,
  type JsonObject,
  NotFoundError,
  type Role,
  type Storage,
  type User,
  type Workspace,
} from '@agility-bridge/storage';
import type { z } from 'zod';
import { sealCredentialToken } from '../secrets/credentials.ts';
import type { Keyring } from '../secrets/keyring.ts';
import {
  assetTypePolicySchema,
  limitsPolicySchema,
  rateLimitPolicySchema,
  SCOPE_OID,
  TOOL_NAME,
  writePolicySchema,
} from './policy.ts';
import type { ToolInfo } from './resolve.ts';

export interface AccessServicesOptions {
  readonly storage: Storage;
  /** Needed to store or replace Agility tokens. */
  readonly keyring?: Keyring;
  /** Every tool the server knows (names and kinds). */
  readonly tools: ReadonlyMap<string, ToolInfo>;
  readonly now?: () => number;
  /** Id generator (tests); default `<prefix>_<random>`. */
  readonly newId?: (prefix: string) => string;
}

/** A result with notes for the operator: requested access that will not be effective. */
export interface WithWarnings<T> {
  readonly record: T;
  readonly warnings: readonly string[];
}

const defaultId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;

function parse<T>(schema: z.ZodType<T>, value: unknown, field: string): T {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const where = [field, ...(issue?.path ?? []).map(String)].join('.');
  throw new InvalidInputError(`${where}: ${issue?.message ?? 'invalid'}.`);
}

function checkScopes(ids: unknown, field: string, allowEmpty = false): string[] {
  if (!Array.isArray(ids) || ids.some((s) => typeof s !== 'string' || !SCOPE_OID.test(s))) {
    throw new InvalidInputError(`${field} must list Agility projects as Scope:<id> tokens.`);
  }
  if (!allowEmpty && ids.length === 0)
    throw new InvalidInputError(`${field} must name at least one Agility project.`);
  return [...new Set(ids as string[])];
}

/** An Agility access token as typed or pasted: no spaces or control characters, bounded. */
function checkAgilityToken(token: unknown): string {
  if (typeof token !== 'string' || token.length === 0 || token.length > 4_000 || /[\s\p{Cc}]/u.test(token)) {
    throw new InvalidInputError(
      'The Agility access token must be a single line without spaces (from the Agility Applications page).',
    );
  }
  return token;
}

export interface NewWorkspaceInput {
  slug: string;
  name: string;
  instanceId: string;
  allowedScopeIds: string[];
  includeChildScopes?: boolean;
  assetTypes?: JsonObject | null;
  enabledTools?: string[] | null;
  limits?: JsonObject;
  defaultCredentialId?: string | null;
  writePolicy?: JsonObject;
}

export interface NewGrantInput {
  workspaceId: string;
  /** `null` for a service grant, which needs a label. */
  userId: string | null;
  label?: string | null;
  credentialId?: string | null;
  tools?: string[] | null;
  scopeIds?: string[] | null;
  assetTypes?: JsonObject | null;
  limits?: JsonObject;
  rateLimit?: JsonObject | null;
  expiresAt?: number | null;
}

export type GrantPatchInput = Partial<Omit<NewGrantInput, 'workspaceId' | 'userId'>>;
export type WorkspacePatchInput = Partial<Omit<NewWorkspaceInput, 'instanceId'>> & {
  disabledAt?: number | null;
};

export function accessServices(options: AccessServicesOptions) {
  const { storage, tools } = options;
  const now = options.now ?? Date.now;
  const newId = options.newId ?? defaultId;

  function checkTools(names: unknown, field: string): string[] | null {
    if (names === null || names === undefined) return null;
    if (!Array.isArray(names) || names.some((n) => typeof n !== 'string' || !TOOL_NAME.test(n))) {
      throw new InvalidInputError(`${field} must be a list of tool names.`);
    }
    const unknown = names.filter((n) => !tools.has(n));
    if (unknown.length > 0) {
      throw new InvalidInputError(
        `${field}: unknown tool${unknown.length === 1 ? '' : 's'} ${unknown.join(', ')}.`,
      );
    }
    return [...new Set(names as string[])];
  }

  const isWriteTool = (name: string) => tools.get(name)?.kind !== 'read';

  async function mustGet<T>(get: Promise<T | null>, what: string): Promise<T> {
    const row = await get;
    if (row === null) throw new NotFoundError(`No ${what} with this id.`);
    return row;
  }

  /** Grant rules that need the workspace and the credential (ADR-0008 token policy). */
  async function checkGrant(
    workspace: Workspace,
    userId: string | null,
    credentialId: string | null,
    grantTools: string[] | null,
    scopeIds: string[] | null,
    limits: JsonObject,
  ): Promise<string[]> {
    const warnings: string[] = [];
    const effectiveCredentialId = credentialId ?? workspace.defaultCredentialId;
    if (effectiveCredentialId === null) {
      throw new InvalidInputError(
        'The grant needs a credential: name one, or give the workspace a default shared credential.',
      );
    }
    const credential = await mustGet(storage.credentials.get(effectiveCredentialId), 'credential');
    if (credential.instanceId !== workspace.instanceId) {
      throw new InvalidInputError("The credential belongs to another instance than the workspace's.");
    }
    if (credential.ownerUserId !== null && credential.ownerUserId !== userId) {
      throw new InvalidInputError(
        "A grant can only use a shared credential or its own user's personal credential.",
      );
    }
    const writes = (grantTools ?? []).filter(isWriteTool);
    if (writes.length > 0 && credential.ownerUserId === null) {
      throw new InvalidInputError(
        `Shared credentials are for read-only grants; ${writes.join(', ')} need the user's own credential.`,
      );
    }
    if (writes.length > 0 && userId === null) {
      throw new InvalidInputError('Service grants are read-only.');
    }
    const enabled = workspace.enabledTools;
    const notEnabled = (grantTools ?? []).filter((t) =>
      enabled === null ? isWriteTool(t) : !enabled.includes(t),
    );
    if (notEnabled.length > 0) warnings.push(`The workspace does not enable ${notEnabled.join(', ')}.`);
    const outside = (scopeIds ?? []).filter((s) => !workspace.allowedScopeIds.includes(s));
    if (outside.length > 0) {
      throw new InvalidInputError(`scopeIds: ${outside.join(', ')} are not projects of the workspace.`);
    }
    const ws = parse(limitsPolicySchema, workspace.limits, 'workspace.limits');
    const g = parse(limitsPolicySchema, limits, 'limits');
    for (const [key, value] of Object.entries(g)) {
      const base = ws[key as keyof typeof ws];
      if (typeof value === 'number' && typeof base === 'number' && value > base) {
        warnings.push(
          `limits.${key} (${value}) is above the workspace's (${base}); the workspace's applies.`,
        );
      }
      if (value === true && base === false) warnings.push(`limits.${key} is off in the workspace.`);
    }
    return warnings;
  }

  const users = {
    async create(input: {
      email: string;
      role: Role;
      displayName?: string | null;
      idp?: string | null;
      idpSubject?: string | null;
    }): Promise<User> {
      const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : input.email;
      return storage.users.create({ ...input, id: newId('usr'), email });
    },
    async update(id: string, patch: Parameters<Storage['users']['update']>[1]): Promise<User> {
      const email = typeof patch.email === 'string' ? patch.email.trim().toLowerCase() : undefined;
      return storage.users.update(id, email === undefined ? patch : { ...patch, email });
    },
    disable: (id: string) => storage.users.update(id, { disabledAt: now() }),
  };

  const instances = {
    async create(input: {
      label: string;
      baseUrl: string;
      tls?: JsonObject | null;
      numberPrefixes?: JsonObject | null;
    }): Promise<Instance> {
      let baseUrl: string;
      try {
        baseUrl = canonicalInstanceUrl(input.baseUrl);
      } catch (error) {
        throw new InvalidInputError(`baseUrl: ${(error as Error).message}`);
      }
      return storage.instances.create({ ...input, id: newId('ins'), baseUrl });
    },
    /** Label, number prefixes, metadata fingerprint, disabled state. The origin changes only through `retarget`. */
    async update(
      id: string,
      patch: {
        label?: string;
        numberPrefixes?: JsonObject | null;
        metaFingerprint?: string | null;
        disabledAt?: number | null;
      },
    ): Promise<Instance> {
      const allowed = ['label', 'numberPrefixes', 'metaFingerprint', 'disabledAt'];
      const extra = Object.keys(patch).filter((k) => !allowed.includes(k));
      if (extra.length > 0) {
        throw new InvalidInputError(
          `${extra.join(', ')} cannot be changed here; the origin changes through a retarget.`,
        );
      }
      return storage.instances.update(id, patch);
    },
    /**
     * Changes an instance's origin or TLS trust (THREAT_MODEL A14): every credential of the instance is revoked first,
     * then every grant of its workspaces, then the origin changes. Members must enter their tokens again after
     * reviewing the new origin. Owner-only, with a recent sign-in (P2-09, P4-02).
     */
    async retarget(
      id: string,
      target: { baseUrl: string; tls?: JsonObject | null },
    ): Promise<{ instance: Instance; revokedCredentials: number; revokedGrants: number }> {
      await mustGet(storage.instances.get(id), 'instance');
      let baseUrl: string;
      try {
        baseUrl = canonicalInstanceUrl(target.baseUrl);
      } catch (error) {
        throw new InvalidInputError(`baseUrl: ${(error as Error).message}`);
      }
      const t = now();
      let revokedCredentials = 0;
      for (const c of await storage.credentials.list({ instanceId: id })) {
        if (c.revokedAt === null) {
          await storage.credentials.update(c.id, { revokedAt: t });
          revokedCredentials++;
        }
      }
      let revokedGrants = 0;
      for (const w of await storage.workspaces.list({ instanceId: id })) {
        for (const g of await storage.grants.list({ workspaceId: w.id })) {
          if (g.revokedAt === null) {
            await storage.grants.update(g.id, { revokedAt: t });
            revokedGrants++;
          }
        }
      }
      const instance = await storage.instances.update(id, {
        baseUrl,
        ...(target.tls === undefined ? {} : { tls: target.tls }),
      });
      return { instance, revokedCredentials, revokedGrants };
    },
  };

  const credentials = {
    /** Stores an Agility token, encrypted; `ownerUserId: null` makes a shared credential. Validation follows (P2-13). */
    async create(input: {
      instanceId: string;
      ownerUserId: string | null;
      label: string;
      token: string;
    }): Promise<Credential> {
      const keyring = options.keyring;
      if (keyring === undefined) throw new Error('A keyring is required to store Agility tokens.');
      const token = checkAgilityToken(input.token);
      const instance = await mustGet(storage.instances.get(input.instanceId), 'instance');
      if (instance.disabledAt !== null) throw new InvalidInputError('The instance is disabled.');
      const id = newId('crd');
      const sealed = await sealCredentialToken(keyring, id, token);
      return storage.credentials.create({
        id,
        instanceId: input.instanceId,
        ownerUserId: input.ownerUserId,
        label: input.label,
        ...sealed,
      });
    },
    /**
     * Replaces the token of a credential (a member's new token, a rotated service token). The credential becomes
     * unvalidated first, so the new token is never used before it is validated.
     */
    async replaceToken(id: string, token: string): Promise<Credential> {
      const keyring = options.keyring;
      if (keyring === undefined) throw new Error('A keyring is required to store Agility tokens.');
      const value = checkAgilityToken(token);
      const current = await mustGet(storage.credentials.get(id), 'credential');
      if (current.revokedAt !== null) throw new ConflictError('The credential is revoked; create a new one.');
      await storage.credentials.update(id, {
        validationStatus: 'unvalidated',
        validationErrorCode: null,
        validatedAt: null,
      });
      const sealed = await sealCredentialToken(keyring, id, value);
      const replaced = await storage.credentials.replaceSecret(
        id,
        {
          tokenCiphertext: current.tokenCiphertext,
          tokenIv: current.tokenIv,
          keyVersion: current.keyVersion,
        },
        { tokenCiphertext: sealed.tokenCiphertext, tokenIv: sealed.tokenIv, keyVersion: sealed.keyVersion },
      );
      if (!replaced) throw new ConflictError('The credential changed meanwhile; try again.');
      return storage.credentials.update(id, { tokenHint: sealed.tokenHint });
    },
    revoke: (id: string) => storage.credentials.update(id, { revokedAt: now() }),
    update: (id: string, patch: { label?: string }) => storage.credentials.update(id, patch),
  };

  const workspaces = {
    async create(input: NewWorkspaceInput): Promise<Workspace> {
      const allowedScopeIds = checkScopes(input.allowedScopeIds, 'allowedScopeIds');
      const enabledTools = checkTools(input.enabledTools, 'enabledTools');
      const assetTypes =
        input.assetTypes === undefined || input.assetTypes === null
          ? null
          : (parse(assetTypePolicySchema, input.assetTypes, 'assetTypes') as JsonObject);
      const limits = parse(limitsPolicySchema, input.limits ?? {}, 'limits') as JsonObject;
      const writePolicy = parse(writePolicySchema, input.writePolicy ?? {}, 'writePolicy') as JsonObject;
      const instance = await mustGet(storage.instances.get(input.instanceId), 'instance');
      if (instance.disabledAt !== null) throw new InvalidInputError('The instance is disabled.');
      return storage.workspaces.create({
        id: newId('wsp'),
        slug: input.slug,
        name: input.name,
        instanceId: input.instanceId,
        allowedScopeIds,
        includeChildScopes: input.includeChildScopes ?? false,
        assetTypes,
        enabledTools,
        limits,
        defaultCredentialId: input.defaultCredentialId ?? null,
        writePolicy,
      });
    },
    async update(id: string, patch: WorkspacePatchInput): Promise<Workspace> {
      const out: Record<string, unknown> = { ...patch };
      if (patch.allowedScopeIds !== undefined)
        out['allowedScopeIds'] = checkScopes(patch.allowedScopeIds, 'allowedScopeIds');
      if (patch.enabledTools !== undefined)
        out['enabledTools'] = checkTools(patch.enabledTools, 'enabledTools');
      if (patch.assetTypes !== undefined && patch.assetTypes !== null) {
        out['assetTypes'] = parse(assetTypePolicySchema, patch.assetTypes, 'assetTypes');
      }
      if (patch.limits !== undefined) out['limits'] = parse(limitsPolicySchema, patch.limits, 'limits');
      if (patch.writePolicy !== undefined)
        out['writePolicy'] = parse(writePolicySchema, patch.writePolicy, 'writePolicy');
      return storage.workspaces.update(id, out);
    },
    disable: (id: string) => storage.workspaces.update(id, { disabledAt: now() }),
    delete: (id: string) => storage.workspaces.delete(id),
  };

  const grants = {
    async create(input: NewGrantInput): Promise<WithWarnings<Grant>> {
      const workspace = await mustGet(storage.workspaces.get(input.workspaceId), 'workspace');
      const grantTools = checkTools(input.tools, 'tools');
      const scopeIds =
        input.scopeIds === undefined || input.scopeIds === null
          ? null
          : checkScopes(input.scopeIds, 'scopeIds');
      const limits = parse(limitsPolicySchema, input.limits ?? {}, 'limits') as JsonObject;
      const assetTypes =
        input.assetTypes === undefined || input.assetTypes === null
          ? null
          : (parse(assetTypePolicySchema, input.assetTypes, 'assetTypes') as JsonObject);
      const rateLimit =
        input.rateLimit === undefined || input.rateLimit === null
          ? null
          : (parse(rateLimitPolicySchema, input.rateLimit, 'rateLimit') as JsonObject);
      if (input.userId !== null) await mustGet(storage.users.get(input.userId), 'user');
      const warnings = await checkGrant(
        workspace,
        input.userId,
        input.credentialId ?? null,
        grantTools,
        scopeIds,
        limits,
      );
      const record = await storage.grants.create({
        id: newId('grt'),
        workspaceId: workspace.id,
        userId: input.userId,
        label: input.label ?? null,
        credentialId: input.credentialId ?? null,
        tools: grantTools,
        scopeIds,
        assetTypes,
        limits,
        rateLimit,
        expiresAt: input.expiresAt ?? null,
      });
      return { record, warnings };
    },
    async update(id: string, patch: GrantPatchInput): Promise<WithWarnings<Grant>> {
      const current = await mustGet(storage.grants.get(id), 'grant');
      const workspace = await mustGet(storage.workspaces.get(current.workspaceId), 'workspace');
      const out: Record<string, unknown> = { ...patch };
      if (patch.tools !== undefined) out['tools'] = checkTools(patch.tools, 'tools');
      if (patch.scopeIds !== undefined) {
        out['scopeIds'] = patch.scopeIds === null ? null : checkScopes(patch.scopeIds, 'scopeIds');
      }
      if (patch.limits !== undefined) out['limits'] = parse(limitsPolicySchema, patch.limits, 'limits');
      if (patch.assetTypes !== undefined && patch.assetTypes !== null) {
        out['assetTypes'] = parse(assetTypePolicySchema, patch.assetTypes, 'assetTypes');
      }
      if (patch.rateLimit !== undefined && patch.rateLimit !== null) {
        out['rateLimit'] = parse(rateLimitPolicySchema, patch.rateLimit, 'rateLimit');
      }
      const next = { ...current, ...out } as Grant;
      const warnings = await checkGrant(
        workspace,
        next.userId,
        next.credentialId,
        next.tools,
        next.scopeIds,
        next.limits,
      );
      return { record: await storage.grants.update(id, out), warnings };
    },
    revoke: (id: string) => storage.grants.update(id, { revokedAt: now() }),
    delete: (id: string) => storage.grants.delete(id),
  };

  return Object.freeze({ users, instances, credentials, workspaces, grants });
}

export type AccessServices = ReturnType<typeof accessServices>;
