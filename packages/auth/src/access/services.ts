// SPDX-License-Identifier: Apache-2.0
// Domain services over storage for instances, credentials, workspaces, grants and users (ADR-0008). Every writer — the
// admin API, the CLI, a future import — goes through these, so the rules hold on every path (L-065). Owner/admin
// guards on the actor are added with the admin API (P2-09).
import { ASSET_TYPE_NAME_RE, canonicalInstanceUrl, NUMBER_PREFIX_RE } from '@agility-bridge/core';
import {
  type AccessToken,
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
import { openCredentialToken, sealCredentialToken } from '../secrets/credentials.ts';
import type { Keyring } from '../secrets/keyring.ts';
import { DEFAULT_TOKEN_DAYS, generateDeviceToken, type TokenEnvironment } from '../tokens/device.ts';
import {
  assetTypePolicySchema,
  limitsPolicySchema,
  rateLimitPolicySchema,
  SCOPE_OID,
  TOOL_NAME,
  writePolicySchema,
} from './policy.ts';
import type { ToolInfo } from './resolve.ts';
import { type CredentialValidator, UpstreamCheckError, type ValidationResult } from './validate.ts';

export interface AccessServicesOptions {
  readonly storage: Storage;
  /** Needed to store or replace Agility tokens. */
  readonly keyring?: Keyring;
  /** Every tool the server knows (names and kinds). */
  readonly tools: ReadonlyMap<string, ToolInfo>;
  readonly now?: () => number;
  /** `live` on production deployments (device tokens `ab_live_…`), `test` elsewhere. Default `live`. */
  readonly environment?: TokenEnvironment;
  /** Validates tokens and probes instance origins against Agility (P2-13); without it, nothing is validated. */
  readonly validator?: CredentialValidator;
  /** Id generator (tests); default `<prefix>_<random>`. */
  readonly newId?: (prefix: string) => string;
  /**
   * Which instance origins are accepted (P2-19, THREAT_MODEL A9). `httpLoopback` (default true) allows plain-HTTP
   * loopback URLs; servers pass `AB_ALLOW_HTTP_INSTANCES`. `checkHost` may refuse a host (e.g. one that resolves to a
   * private address) by throwing; it runs before the origin is probed.
   */
  readonly instanceUrls?: {
    readonly httpLoopback?: boolean;
    readonly checkHost?: (hostname: string) => Promise<void>;
  };
}

/** A result with notes for the operator: requested access that will not be effective. */
export interface WithWarnings<T> {
  readonly record: T;
  readonly warnings: readonly string[];
}

/** Personal Agility credentials one person may keep (P4-07, THREAT_MODEL T20): revoked ones count until deleted. */
export const MAX_PERSONAL_CREDENTIALS = 10;
/** Live (not revoked, not expired) device tokens per grant (P4-07, THREAT_MODEL T20). */
export const MAX_LIVE_TOKENS_PER_GRANT = 20;

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

/** Most number prefixes one instance may configure (there are a few dozen numbered types). */
export const MAX_NUMBER_PREFIXES = 64;

/**
 * The number prefixes an owner configures for an instance: `null` (learn them from Agility) or `{ "<AssetTypeName>":
 * "<1-4 capital letters>" }`. The one validator for every writer (L-065); the metadata layer applies the same two patterns
 * when it uses a value (ADR-0012: only identifiers that match them ever reach a query).
 */
export function checkNumberPrefixes(value: unknown, field = 'numberPrefixes'): JsonObject | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidInputError(`${field} must map asset type names to prefixes, or be empty.`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_NUMBER_PREFIXES) {
    throw new InvalidInputError(`${field} may name at most ${MAX_NUMBER_PREFIXES} asset types.`);
  }
  const out: Record<string, string> = {};
  for (const [type, prefix] of entries) {
    if (!ASSET_TYPE_NAME_RE.test(type)) {
      throw new InvalidInputError(`${field}: an asset type name is letters, digits and _ (up to 64).`);
    }
    if (typeof prefix !== 'string' || !NUMBER_PREFIX_RE.test(prefix)) {
      throw new InvalidInputError(`${field}.${type}: a prefix is one to four capital letters (A-Z).`);
    }
    out[type] = prefix;
  }
  return out;
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
  /** `passthrough`: callers send their own Agility token (P2-14, needs `AB_PASSTHROUGH=on`). */
  credentialSource?: 'stored' | 'passthrough';
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
      // The attachment download is off unless the workspace says otherwise (D-08), so an unset value is off.
      if (
        value === true &&
        (base === false || (base === undefined && (key === 'attachmentDownload' || key === 'reports')))
      )
        warnings.push(`limits.${key} is off in the workspace.`);
    }
    return warnings;
  }

  /** Probes an origin without a token; returns the schema fingerprint, or undefined without a validator. */
  async function probe(
    instance: Pick<Instance, 'id' | 'baseUrl' | 'tls'>,
  ): Promise<string | null | undefined> {
    if (options.validator === undefined) return undefined;
    const r = await options.validator.probe(instance);
    if (!r.ok) throw new UpstreamCheckError(r.code, r.message);
    return r.fingerprint;
  }

  /** Records a validation result; a transient failure keeps the previous status (and records its code). */
  async function record(id: string, result: ValidationResult): Promise<Credential> {
    if (result.status === 'valid') {
      return storage.credentials.update(id, {
        validationStatus: 'valid',
        validationErrorCode: null,
        validatedAt: now(),
        memberOid: result.memberOid,
        memberName: result.memberName,
        memberUsername: result.memberUsername,
        reachableScopeIds: result.reachableScopeIds,
      });
    }
    if (result.status === 'invalid') {
      return storage.credentials.update(id, {
        validationStatus: 'invalid',
        validationErrorCode: result.code,
        validatedAt: now(),
      });
    }
    return storage.credentials.update(id, { validationErrorCode: result.code });
  }

  /** Validates one credential against Agility now (P2-13). Without a validator, returns it unchanged. */
  async function validateCredential(id: string): Promise<Credential> {
    const c = await mustGet(storage.credentials.get(id), 'credential');
    if (options.validator === undefined || c.revokedAt !== null) return c;
    const keyring = options.keyring;
    if (keyring === undefined) throw new Error('A keyring is required to validate Agility tokens.');
    const instance = await mustGet(storage.instances.get(c.instanceId), 'instance');
    const token = await openCredentialToken(keyring, c);
    const result = await options.validator.validate(instance, id, token);
    // The answer is about the token opened above. A replacement (or a re-encryption) that landed while Agility was answering
    // makes it someone else's answer: keep what the credential now says instead of vouching for a token nobody checked
    // (P4-09). A write between this read and `record` is not covered; a compare-and-swap in storage would close it.
    const now = await mustGet(storage.credentials.get(id), 'credential');
    if (
      now.tokenCiphertext !== c.tokenCiphertext ||
      now.tokenIv !== c.tokenIv ||
      now.keyVersion !== c.keyVersion
    ) {
      return now;
    }
    return record(id, result);
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
    /** Clears `disabledAt` (P4-15). Who may do it, and the "is it disabled" check, are the guards'. */
    enable: (id: string) => storage.users.update(id, { disabledAt: null }),
    /**
     * Clears the user's `(idp, idpSubject)` in one compare-and-set step against the binding the caller saw (P4-12,
     * L-220). The next verified sign-in with the user's email binds again. A binding that changed in between, or none, is a
     * conflict and nothing is written. Authorization, confirmation and ending sessions are the caller's (guards).
     */
    async unbind(id: string, expected: { idp: string; idpSubject: string }): Promise<User> {
      const cleared = await storage.users.unbind(id, expected);
      if (cleared === null) {
        throw new ConflictError(
          'The sign-in identity changed or was already cleared. Reload and check again.',
        );
      }
      return cleared;
    },
  };

  /** Canonical, and allowed by this deployment's policy (P2-19). */
  const acceptedInstanceUrl = async (input: string): Promise<string> => {
    const url = canonicalInstanceUrl(input, { httpLoopback: options.instanceUrls?.httpLoopback ?? true });
    await options.instanceUrls?.checkHost?.(new URL(url).hostname);
    return url;
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
        baseUrl = await acceptedInstanceUrl(input.baseUrl);
      } catch (error) {
        throw new InvalidInputError(`baseUrl: ${(error as Error).message}`);
      }
      const numberPrefixes = checkNumberPrefixes(input.numberPrefixes);
      const fingerprint = await probe({ id: 'new', baseUrl, tls: input.tls ?? null });
      return storage.instances.create({
        ...input,
        numberPrefixes,
        id: newId('ins'),
        baseUrl,
        ...(fingerprint === undefined ? {} : { metaFingerprint: fingerprint }),
      });
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
      return storage.instances.update(
        id,
        patch.numberPrefixes === undefined
          ? patch
          : { ...patch, numberPrefixes: checkNumberPrefixes(patch.numberPrefixes) },
      );
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
      const current = await mustGet(storage.instances.get(id), 'instance');
      let baseUrl: string;
      try {
        baseUrl = await acceptedInstanceUrl(target.baseUrl);
      } catch (error) {
        throw new InvalidInputError(`baseUrl: ${(error as Error).message}`);
      }
      // The new origin must answer like Agility before anything changes (THREAT_MODEL A14).
      await probe({ id, baseUrl, tls: target.tls === undefined ? current.tls : target.tls });
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
      const owner = input.ownerUserId;
      const capMessage = `At most ${MAX_PERSONAL_CREDENTIALS} personal Agility tokens per person; delete one you no longer use first.`;
      const personal = () => storage.credentials.list({ ownerUserId: owner });
      if (owner !== null && (await personal()).length >= MAX_PERSONAL_CREDENTIALS) {
        throw new ConflictError(capMessage);
      }
      const id = newId('crd');
      const sealed = await sealCredentialToken(keyring, id, token);
      await storage.credentials.create({
        id,
        instanceId: input.instanceId,
        ownerUserId: owner,
        label: input.label,
        ...sealed,
      });
      // Parallel adds can all pass the check above: count again after the insert and take this one back when over (the
      // losers of a race all retreat, so the cap holds; the person retries).
      if (owner !== null && (await personal()).length > MAX_PERSONAL_CREDENTIALS) {
        await storage.credentials.delete(id);
        throw new ConflictError(capMessage);
      }
      return validateCredential(id);
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
      await storage.credentials.update(id, { tokenHint: sealed.tokenHint });
      return validateCredential(id);
    },
    /** Validates now: member, reachable projects, status (P2-13). */
    validate: (id: string) => validateCredential(id),
    /**
     * Revalidates every unrevoked credential last validated before `olderThan` (or never), one at a time. Returns how
     * many were checked; failures are recorded on the credential, never thrown.
     */
    /**
     * Revalidates live credentials not validated since `olderThan`, never-validated and oldest first, at most `limit`
     * (Workers revalidate one per scheduled run: each costs Agility requests, P3-08).
     */
    async revalidate(olderThan: number, limit = Number.POSITIVE_INFINITY): Promise<number> {
      const due = (await storage.credentials.list())
        .filter((c) => c.revokedAt === null && (c.validatedAt === null || c.validatedAt < olderThan))
        .sort((a, b) => (a.validatedAt ?? -1) - (b.validatedAt ?? -1));
      let n = 0;
      for (const c of due.slice(0, Math.max(0, limit))) {
        await validateCredential(c.id).catch(() => undefined);
        n++;
      }
      return n;
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
        credentialSource: input.credentialSource ?? 'stored',
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
      const record = await storage.grants.update(id, out);
      // Tokens issued on the old credential must not start acting as the owner of a personal one (P2-17 review M2).
      if (next.credentialId !== current.credentialId && next.credentialId !== null) {
        const credential = await storage.credentials.get(next.credentialId);
        if (credential?.ownerUserId !== null) {
          for (const t of await storage.accessTokens.list({ grantId: id })) {
            if (t.revokedAt === null) await storage.accessTokens.update(t.id, { revokedAt: now() });
          }
        }
      }
      return { record, warnings };
    },
    revoke: (id: string) => storage.grants.update(id, { revokedAt: now() }),
    delete: (id: string) => storage.grants.delete(id),
  };

  const tokens = {
    /**
     * Issues a device token for a grant (one per device, L-066). The token is returned once and only its SHA-256 is
     * stored. Default expiry 90 days; `never` is allowed with a warning.
     */
    async issue(input: {
      grantId: string;
      label: string;
      expiresInDays?: number | 'never';
    }): Promise<WithWarnings<AccessToken> & { token: string }> {
      const grant = await mustGet(storage.grants.get(input.grantId), 'grant');
      if (grant.revokedAt !== null || (grant.expiresAt !== null && grant.expiresAt <= now())) {
        throw new ConflictError('The grant is revoked or expired.');
      }
      const days = input.expiresInDays ?? DEFAULT_TOKEN_DAYS;
      if (days !== 'never' && (!Number.isInteger(days) || days < 1 || days > 3_650)) {
        throw new InvalidInputError('expiresInDays must be 1-3650 or "never".');
      }
      const warnings =
        days === 'never' ? ['The token never expires; revoke it when the device is lost or retired.'] : [];
      const capMessage = `At most ${MAX_LIVE_TOKENS_PER_GRANT} live device tokens per grant; revoke one you no longer use first.`;
      const live = async () =>
        (await storage.accessTokens.list({ grantId: grant.id })).filter(
          (t) => t.revokedAt === null && (t.expiresAt === null || t.expiresAt > now()),
        ).length;
      if ((await live()) >= MAX_LIVE_TOKENS_PER_GRANT) throw new ConflictError(capMessage);
      const issued = await generateDeviceToken(options.environment ?? 'live');
      const record = await storage.accessTokens.create({
        id: newId('tok'),
        grantId: grant.id,
        prefix: issued.displayPrefix,
        tokenHash: issued.tokenHash,
        label: input.label,
        expiresAt: days === 'never' ? null : now() + days * 86_400_000,
      });
      // Same re-check as for credentials: parallel issues retreat together rather than pass the cap (P4-07).
      if ((await live()) > MAX_LIVE_TOKENS_PER_GRANT) {
        await storage.accessTokens.delete(record.id);
        throw new ConflictError(capMessage);
      }
      return { token: issued.token, record, warnings };
    },
    revoke: (id: string) => storage.accessTokens.update(id, { revokedAt: now() }),
    list: (grantId: string) => storage.accessTokens.list({ grantId }),
  };

  return Object.freeze({ users, instances, credentials, workspaces, grants, tokens });
}

export type AccessServices = ReturnType<typeof accessServices>;
