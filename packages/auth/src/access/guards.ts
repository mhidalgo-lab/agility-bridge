// SPDX-License-Identifier: Apache-2.0
// Owner/admin guards on every writer (P2-09, L-065, THREAT_MODEL T3, T14, A5, A14). The admin API, the CLI and any
// future import call `guardedServices(services, actor)`, never the raw services, so the same rules hold on every path.
import {
  type AccessToken,
  type AuditEntry,
  ConflictError,
  type Credential,
  type Grant,
  type Instance,
  type JsonObject,
  NotFoundError,
  type Role,
  type Storage,
  type User,
  type Workspace,
} from '@agility-bridge/storage';
import { createSetupLink, type SetupLink } from '../identity/login.ts';
import { type KeyVersionStatus, keyStatus, retireKeyVersion } from '../secrets/credentials.ts';
import type { Keyring } from '../secrets/keyring.ts';
import type { ToolInfo } from './resolve.ts';
import type {
  AccessServices,
  GrantPatchInput,
  NewGrantInput,
  NewWorkspaceInput,
  WithWarnings,
  WorkspacePatchInput,
} from './services.ts';

/** Who is acting. The break-glass admin token acts as an owner with a recent sign-in, but has no user of its own. */
export type Actor =
  | { readonly kind: 'user'; readonly userId: string; readonly role: Role; readonly recentAuth: boolean }
  | { readonly kind: 'break_glass' };

/** The actor may not do this (HTTP 403). The message says which role or condition is needed. */
export class ForbiddenError extends Error {
  readonly code = 'forbidden' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/**
 * The action needs a sign-in from the last 10 minutes (HTTP 403 `reauth_required`; the panel sends the user through
 * `/auth/reauth`, L-093).
 */
export class ReauthRequiredError extends ForbiddenError {
  readonly reauth = true as const;

  constructor(message: string) {
    super(message);
    this.name = 'ReauthRequiredError';
  }
}

const roleOf = (a: Actor): Role => (a.kind === 'break_glass' ? 'owner' : a.role);
const userIdOf = (a: Actor): string | null => (a.kind === 'user' ? a.userId : null);
const isOwner = (a: Actor) => roleOf(a) === 'owner';
const isManager = (a: Actor) => roleOf(a) === 'owner' || roleOf(a) === 'admin';

function need(ok: boolean, message: string): void {
  if (!ok) throw new ForbiddenError(message);
}
const needManager = (a: Actor) => need(isManager(a), 'This needs an owner or an admin.');
const needOwner = (a: Actor, what: string) => need(isOwner(a), `Only an owner can ${what}.`);
/** The break-glass token is exempt: it is not a browser session and re-signing in is meaningless for it. */
function needRecent(a: Actor, what: string): void {
  if (a.kind === 'user' && !a.recentAuth) throw new ReauthRequiredError(`Sign in again before ${what}.`);
}

/** One line of "my recent changes" (P4-07). */
export type MyAuditRow = Pick<AuditEntry, 'id' | 'ts' | 'action' | 'status' | 'targetType' | 'targetId'>;

export interface GuardContext {
  readonly storage: Storage;
  readonly tools: ReadonlyMap<string, ToolInfo>;
  /** For the master-key operations (P3-13); without it they are unavailable. */
  readonly keyring?: Keyring;
}

/** The services, each call checked against the actor's role (and, for members, ownership). */
export function guardedServices(services: AccessServices, ctx: GuardContext, actor: Actor) {
  const { storage, tools } = ctx;
  const writeTools = (names: readonly string[] | null | undefined) =>
    (names ?? []).filter((n) => tools.get(n) !== undefined && tools.get(n)?.kind !== 'read');
  const self = userIdOf(actor);

  async function load<T>(row: Promise<T | null>, what: string): Promise<T> {
    const r = await row;
    if (r === null) throw new NotFoundError(`No ${what} with this id.`);
    return r;
  }

  /** Members see only their own records: anything else is "not found", never "forbidden" (no existence oracle). */
  function visible<T>(row: T | null, mine: (r: T) => boolean): T | null {
    if (row === null || isManager(actor)) return row;
    return mine(row) ? row : null;
  }

  async function activeOwners(): Promise<User[]> {
    return (await storage.users.list()).filter((u) => u.role === 'owner' && u.disabledAt === null);
  }

  const users = {
    async list(): Promise<User[]> {
      if (isManager(actor)) return storage.users.list();
      const me = self === null ? null : await storage.users.get(self);
      return me === null ? [] : [me];
    },
    async get(id: string): Promise<User | null> {
      return visible(await storage.users.get(id), (u) => u.id === self);
    },
    async create(input: Parameters<AccessServices['users']['create']>[0]): Promise<User> {
      needManager(actor);
      if (input.role !== 'member') {
        needOwner(actor, 'create owners or admins');
        needRecent(actor, 'creating an owner or an admin');
      }
      return services.users.create(input);
    },
    async update(id: string, patch: Parameters<AccessServices['users']['update']>[1]): Promise<User> {
      needManager(actor);
      const target = await load(storage.users.get(id), 'user');
      if (target.role !== 'member' || (patch.role !== undefined && patch.role !== 'member')) {
        needOwner(actor, 'change owners, admins or roles above member');
        needRecent(actor, 'changing an owner, an admin or a role above member');
      }
      if (target.role === 'owner' && patch.role !== undefined && patch.role !== 'owner') {
        const others = (await activeOwners()).filter((u) => u.id !== id);
        need(others.length > 0, 'The last active owner cannot lose the owner role.');
      }
      return services.users.update(id, patch);
    },
    /**
     * Throws unless the actor may end every session of this user: yourself (any role), an owner anyone, an admin only
     * members. A member asking about someone else gets "not found" (no existence oracle). Ends nothing itself.
     */
    async authorizeEndSessions(id: string): Promise<User> {
      if (!isManager(actor) && id !== self) throw new NotFoundError('No user with this id.');
      const target = await load(storage.users.get(id), 'user');
      if (id !== self && target.role !== 'member') needOwner(actor, "end an owner's or an admin's sessions");
      return target;
    },
    async disable(id: string): Promise<User> {
      needManager(actor);
      const target = await load(storage.users.get(id), 'user');
      if (target.role !== 'member') {
        needOwner(actor, 'disable owners or admins');
        needRecent(actor, 'disabling an owner or an admin');
      }
      if (target.role === 'owner') {
        const others = (await activeOwners()).filter((u) => u.id !== id);
        need(others.length > 0, 'The last active owner cannot be disabled.');
      }
      return services.users.disable(id);
    },
  };

  const instances = {
    list: (): Promise<Instance[]> => storage.instances.list(),
    get: (id: string): Promise<Instance | null> => storage.instances.get(id),
    async create(input: Parameters<AccessServices['instances']['create']>[0]): Promise<Instance> {
      needManager(actor);
      return services.instances.create(input);
    },
    async update(id: string, patch: Parameters<AccessServices['instances']['update']>[1]): Promise<Instance> {
      needManager(actor);
      return services.instances.update(id, patch);
    },
    /** THREAT_MODEL A14: owner only, with a recent sign-in. */
    async retarget(id: string, target: { baseUrl: string; tls?: JsonObject | null }) {
      needOwner(actor, "change an instance's origin or TLS trust");
      needRecent(actor, 'changing an instance origin');
      return services.instances.retarget(id, target);
    },
    async delete(id: string): Promise<void> {
      needManager(actor);
      await storage.instances.delete(id);
    },
  };

  const mineCredential = (c: Credential) => c.ownerUserId !== null && c.ownerUserId === self;
  const credentials = {
    async list(filter: { instanceId?: string } = {}): Promise<Credential[]> {
      if (isManager(actor)) return storage.credentials.list(filter);
      if (self === null) return [];
      return storage.credentials.list({ ...filter, ownerUserId: self });
    },
    async get(id: string): Promise<Credential | null> {
      return visible(await storage.credentials.get(id), mineCredential);
    },
    /** Shared: owners and admins. Personal: only the user themselves (nobody stores a token for someone else). */
    async create(input: Parameters<AccessServices['credentials']['create']>[0]): Promise<Credential> {
      if (input.ownerUserId === null) needManager(actor);
      else {
        need(input.ownerUserId === self, 'Only the user themselves can store their personal Agility token.');
        // A member stores a token only for an instance they have a live grant on (P4-07): owners and admins may also
        // prepare theirs before they are granted anything.
        if (!isManager(actor)) {
          const grants = await storage.grants.list({ userId: input.ownerUserId });
          let granted = false;
          for (const g of grants) {
            if (g.revokedAt !== null) continue;
            const w = await storage.workspaces.get(g.workspaceId);
            if (w !== null && w.instanceId === input.instanceId) granted = true;
          }
          need(granted, 'You can store a personal Agility token only for an instance you have a grant on.');
        }
      }
      return services.credentials.create(input);
    },
    async replaceToken(id: string, token: string): Promise<Credential> {
      const c = await load(storage.credentials.get(id), 'credential');
      if (c.ownerUserId === null) needManager(actor);
      else if (!mineCredential(c)) throw new NotFoundError('No credential with this id.');
      needRecent(actor, "replacing a credential's token");
      return services.credentials.replaceToken(id, token);
    },
    async update(id: string, patch: { label?: string }): Promise<Credential> {
      const c = await load(storage.credentials.get(id), 'credential');
      if (!mineCredential(c) && !isManager(actor)) throw new NotFoundError('No credential with this id.');
      return services.credentials.update(id, patch);
    },
    async validate(id: string): Promise<Credential> {
      const c = await load(storage.credentials.get(id), 'credential');
      if (!mineCredential(c) && !isManager(actor)) throw new NotFoundError('No credential with this id.');
      return services.credentials.validate(id);
    },
    async revoke(id: string): Promise<Credential> {
      const c = await load(storage.credentials.get(id), 'credential');
      if (!mineCredential(c)) {
        if (!isManager(actor)) throw new NotFoundError('No credential with this id.');
      }
      return services.credentials.revoke(id);
    },
    /**
     * Owners and admins delete any unused credential; a member only their own personal one (P4-07), which removes the
     * encrypted token for good. Someone else's is "not found". The storage refuses while a grant still uses it.
     */
    async delete(id: string): Promise<void> {
      if (!isManager(actor)) {
        const c = await load(storage.credentials.get(id), 'credential');
        if (!mineCredential(c)) throw new NotFoundError('No credential with this id.');
      }
      await storage.credentials.delete(id);
    },
  };

  const checkWorkspaceWrites = (input: Partial<NewWorkspaceInput>) => {
    if (input.writePolicy !== undefined) {
      needOwner(actor, 'change write settings');
      needRecent(actor, 'changing write settings');
    }
    // A pass-through workspace serves anyone with a token for its instance: owners decide that (P2-14).
    if (input.credentialSource === 'passthrough') needOwner(actor, 'make a workspace pass-through');
    if (writeTools(input.enabledTools).length > 0) {
      needOwner(actor, 'enable write tools');
      needRecent(actor, 'enabling write tools');
    }
  };
  const workspaces = {
    async list(): Promise<Workspace[]> {
      needManager(actor);
      return storage.workspaces.list();
    },
    async get(id: string): Promise<Workspace | null> {
      needManager(actor);
      return storage.workspaces.get(id);
    },
    async create(input: NewWorkspaceInput): Promise<Workspace> {
      needManager(actor);
      checkWorkspaceWrites(input);
      return services.workspaces.create(input);
    },
    async update(id: string, patch: WorkspacePatchInput): Promise<Workspace> {
      needManager(actor);
      checkWorkspaceWrites(patch);
      return services.workspaces.update(id, patch);
    },
    async disable(id: string): Promise<Workspace> {
      needManager(actor);
      return services.workspaces.disable(id);
    },
    async delete(id: string): Promise<void> {
      needManager(actor);
      await services.workspaces.delete(id);
    },
  };

  const mineGrant = (g: Grant) => g.userId !== null && g.userId === self;
  const grants = {
    async list(filter: { workspaceId?: string } = {}): Promise<Grant[]> {
      if (isManager(actor)) return storage.grants.list(filter);
      if (self === null) return [];
      return storage.grants.list({ ...filter, userId: self });
    },
    async get(id: string): Promise<Grant | null> {
      return visible(await storage.grants.get(id), mineGrant);
    },
    async create(input: NewGrantInput): Promise<WithWarnings<Grant>> {
      needManager(actor);
      if (writeTools(input.tools).length > 0) {
        needOwner(actor, 'grant write tools');
        needRecent(actor, 'granting write tools');
      }
      return services.grants.create(input);
    },
    async update(id: string, patch: GrantPatchInput): Promise<WithWarnings<Grant>> {
      needManager(actor);
      if (writeTools(patch.tools).length > 0) {
        needOwner(actor, 'grant write tools');
        needRecent(actor, 'granting write tools');
      }
      const current = await load(storage.grants.get(id), 'grant');
      if (patch.credentialId !== undefined && patch.credentialId !== current.credentialId) {
        await needCredentialOwner(patch.credentialId, "put a grant on someone's personal Agility token");
      }
      return services.grants.update(id, patch);
    },
    async revoke(id: string): Promise<Grant> {
      needManager(actor);
      return services.grants.revoke(id);
    },
    async delete(id: string): Promise<void> {
      needManager(actor);
      await services.grants.delete(id);
    },
  };

  /** Members manage the tokens of their own grants; owners and admins every token. */
  async function ownGrant(grantId: string): Promise<Grant> {
    const g = await load(storage.grants.get(grantId), 'grant');
    if (!isManager(actor) && !mineGrant(g)) throw new NotFoundError('No grant with this id.');
    return g;
  }

  /**
   * A device token on a grant that uses someone's personal Agility token acts as that person in Agility: only they
   * may issue one (P2-17 review M2). Grants on shared credentials stay with owners and admins.
   */
  async function needCredentialOwner(credentialId: string | null, what: string): Promise<void> {
    if (credentialId === null) return;
    const c = await storage.credentials.get(credentialId);
    if (c !== null && c.ownerUserId !== null && c.ownerUserId !== self) {
      throw new ForbiddenError(`Only the owner of the personal Agility token can ${what}.`);
    }
  }
  const tokens = {
    async list(grantId: string): Promise<AccessToken[]> {
      await ownGrant(grantId);
      return services.tokens.list(grantId);
    },
    async issue(input: Parameters<AccessServices['tokens']['issue']>[0]) {
      const grant = await ownGrant(input.grantId);
      await needCredentialOwner(grant.credentialId, 'issue device tokens on this grant');
      return services.tokens.issue(input);
    },
    async revoke(id: string): Promise<AccessToken> {
      const t = await load(storage.accessTokens.get(id), 'token');
      await ownGrant(t.grantId);
      return services.tokens.revoke(id);
    },
  };

  /**
   * Member self-service (P4-07): the signed-in person's own access, whatever their role. Every method works from the
   * actor's own user id and takes no user, owner or workspace id from the caller; the break-glass token is nobody and gets
   * a refusal. A record that is someone else's answers like a missing one.
   */
  function needSelf(): string {
    if (self === null) throw new ForbiddenError('This needs a signed-in person, not the admin token.');
    return self;
  }
  const me = {
    /** My grants with the workspace each one is in (name, slug, whether it uses stored credentials), for "My access". */
    async grants(): Promise<{ grant: Grant; workspace: Workspace | null }[]> {
      const id = needSelf();
      const own = await storage.grants.list({ userId: id });
      const out: { grant: Grant; workspace: Workspace | null }[] = [];
      for (const grant of own)
        out.push({ grant, workspace: await storage.workspaces.get(grant.workspaceId) });
      return out;
    },
    /**
     * Point one of my live grants at one of my own valid personal credentials, or (`null`) back at the workspace's
     * default, which is allowed only while the grant uses a credential of mine (an administrator's pin on a shared
     * credential is not mine to undo, P4-18 in relic-bridge). Scope, tools and limits are untouched: the workspace's
     * project restriction and the grant's own limits still apply (THREAT_MODEL T3).
     */
    async setGrantCredential(grantId: string, credentialId: string | null): Promise<WithWarnings<Grant>> {
      const id = needSelf();
      const grant = await load(storage.grants.get(grantId), 'grant');
      if (grant.userId !== id) throw new NotFoundError('No grant with this id.');
      if (grant.revokedAt !== null) throw new ConflictError('The grant is revoked.');
      const workspace = await load(storage.workspaces.get(grant.workspaceId), 'workspace');
      if (workspace.disabledAt !== null) throw new ConflictError('The workspace is disabled.');
      if (workspace.credentialSource !== 'stored') {
        throw new ConflictError('This workspace uses the token you send with each request, not stored ones.');
      }
      if (credentialId === null) {
        const current =
          grant.credentialId === null ? null : await storage.credentials.get(grant.credentialId);
        if (current === null || current.ownerUserId !== id) {
          throw new ForbiddenError(
            "Only a grant that uses your own Agility token can go back to the workspace's.",
          );
        }
      } else {
        const c = await storage.credentials.get(credentialId);
        if (c === null || c.ownerUserId !== id) throw new NotFoundError('No credential with this id.');
        if (c.revokedAt !== null) throw new ConflictError('That token is revoked.');
        if (c.validationStatus !== 'valid') {
          throw new ConflictError('Check the token against Agility first: only a valid token can be used.');
        }
      }
      return services.grants.update(grantId, { credentialId });
    },
    /** What changed in my own access recently: admin rows with me as the actor (newest first, at most 50). */
    async audit(limit = 20): Promise<MyAuditRow[]> {
      const id = needSelf();
      const bounded = Math.max(1, Math.min(50, Math.trunc(limit)));
      const found = await storage.audit.query({ userId: id, kind: 'admin', limit: bounded });
      // Only what a person needs to recognise their own change: no request ids, queries or free-form details.
      return found.map((r) => ({
        id: r.id,
        ts: r.ts,
        action: r.action,
        status: r.status,
        targetType: r.targetType,
        targetId: r.targetId,
      }));
    },
  };

  /** Master-key versions (P3-13): owners only; retiring needs a recent sign-in, like a retarget. */
  const keys = {
    async status(): Promise<KeyVersionStatus[]> {
      needOwner(actor, 'see the master-key versions');
      if (ctx.keyring === undefined)
        throw new ForbiddenError('Master-key operations are not available here.');
      return keyStatus(storage, ctx.keyring);
    },
    async retire(version: number, reason: string): Promise<KeyVersionStatus[]> {
      needOwner(actor, 'retire a master-key version');
      needRecent(actor, 'retiring a master-key version');
      if (ctx.keyring === undefined)
        throw new ForbiddenError('Master-key operations are not available here.');
      // The admin API writes the audit row, success or refusal, like every other admin change.
      await retireKeyVersion(storage, ctx.keyring, version, { reason, record: false });
      return keyStatus(storage, ctx.keyring);
    },
  };

  /**
   * First-owner setup links (P4-01): owners only, with a recent sign-in. A link always means *owner*, so whoever can
   * issue one can create an owner.
   */
  const setupLinks = {
    /** Throws unless the actor may create a link; creates nothing. */
    authorize(): void {
      needOwner(actor, 'create an owner setup link');
      needRecent(actor, 'creating a setup link');
    },
    async create(ttlMs: number, clock: { now(): number }): Promise<SetupLink> {
      setupLinks.authorize();
      return createSetupLink(storage.kv, ttlMs, clock);
    },
  };

  return Object.freeze({
    actor,
    users,
    instances,
    credentials,
    workspaces,
    grants,
    tokens,
    me,
    keys,
    setupLinks,
  });
}

export type GuardedServices = ReturnType<typeof guardedServices>;
