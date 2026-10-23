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
  InvalidInputError,
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
import { DEFAULT_TOKEN_DAYS } from '../tokens/device.ts';
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

/**
 * Does `next` name projects `current` does not? `null` means "every project of the workspace", which is wider than any list.
 * Narrowing is never a widening.
 */
function widensNames(next: readonly string[] | null | undefined, current: readonly string[] | null): boolean {
  if (next === undefined) return false;
  if (next === null) return current !== null;
  if (current === null) return false;
  const have = new Set(current);
  return next.some((n) => !have.has(n));
}

/**
 * Does the asset-type policy `next` reach types `current` does not (a longer allow list, no allow list where there was one, a
 * shorter deny list)? No policy and empty lists are the same; order and repeats are not a change.
 */
function widensAssetTypes(next: JsonObject | null | undefined, current: JsonObject | null): boolean {
  if (next === undefined) return false;
  const list = (p: JsonObject | null, key: string): readonly string[] | null => {
    const v = p?.[key];
    return Array.isArray(v) ? (v as string[]) : null;
  };
  if (widensNames(list(next, 'allow'), list(current, 'allow'))) return true;
  const nextDeny = new Set(list(next, 'deny') ?? []);
  return (list(current, 'deny') ?? []).some((t) => !nextDeny.has(t));
}

/** A device token with where it belongs, for the panel-wide list (P4-15). Never a hash or a token value. */
export type TokenListItem = AccessToken & {
  readonly userId: string | null;
  readonly workspaceId: string;
  readonly grantLabel: string | null;
};

export const TOKEN_PAGE_DEFAULT = 50;
export const TOKEN_PAGE_MAX = 200;
const CURSOR = /^(\d{1,16}):([A-Za-z0-9_-]{1,128})$/;

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
    /**
     * Moves a user to another identity on purpose (P4-12, THREAT_MODEL T14): after this the next verified sign-in whose
     * email matches binds the account, at whichever provider asserts it, so it is an account-takeover primitive by design.
     * Owner only (the break-glass token counts), with a recent sign-in, never your own account through a session (ask
     * another owner or use the admin token; this also keeps the last owner from locking themselves out), and the caller
     * repeats the user's current email. The write is one compare-and-set on the binding read here. Ends nothing itself.
     */
    async unbind(id: string, confirmEmail: string): Promise<{ user: User; previousIdp: string }> {
      needOwner(actor, "clear a user's sign-in identity");
      needRecent(actor, "clearing a user's sign-in identity");
      if (self !== null && id === self) {
        throw new ForbiddenError(
          'You cannot clear your own sign-in identity: ask another owner, or use the admin token.',
        );
      }
      const target = await load(storage.users.get(id), 'user');
      if (target.idp === null || target.idpSubject === null) {
        throw new ConflictError('The user has no sign-in identity to clear.');
      }
      // Same normalisation as when the email was stored (trim, lowercase); never echoed back.
      if (typeof confirmEmail !== 'string' || confirmEmail.trim().toLowerCase() !== target.email) {
        throw new InvalidInputError("confirm: must repeat the user's email address");
      }
      const user = await services.users.unbind(id, { idp: target.idp, idpSubject: target.idpSubject });
      return { user, previousIdp: target.idp };
    },
    /**
     * Lets a disabled user sign in again (P4-15, THREAT_MODEL T14): everything they still hold (grants and device tokens not
     * revoked) works again, so the rules are those of `disable`: an owner for owners and admins, with a recent sign-in for them
     * (the break-glass token is exempt), an admin for members. Authorization comes before the state check, so a refusal never
     * tells a caller whether the user is disabled. Creates no session: the person signs in again.
     */
    async enable(id: string): Promise<User> {
      needManager(actor);
      const target = await load(storage.users.get(id), 'user');
      if (target.role !== 'member') {
        needOwner(actor, 'enable owners or admins');
        needRecent(actor, 'enabling an owner or an admin');
      }
      if (target.disabledAt === null) throw new ConflictError('The user is not disabled.');
      return services.users.enable(id);
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
    /**
     * Owners and admins add instances. The TLS trust of an instance is the owners' (A14, the panel already says so): a CA file
     * chosen here is read from the server's disk and decides whom stored member tokens are sent to, so setting one needs an
     * owner with a recent sign-in, like a retarget (P4-09).
     */
    async create(input: Parameters<AccessServices['instances']['create']>[0]): Promise<Instance> {
      needManager(actor);
      if (input.tls !== undefined && input.tls !== null) {
        needOwner(actor, 'set the TLS trust of an instance');
        needRecent(actor, 'setting the TLS trust of an instance');
      }
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
    if (input.credentialSource === 'passthrough') {
      needOwner(actor, 'make a workspace pass-through');
      needRecent(actor, 'making a workspace pass-through');
    }
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
      // Where an owner has enabled writes, the owners also decide where they may land (ADR-0013, P4-09): another project or
      // asset type is a change of that decision, not of an administrator's.
      if (
        patch.allowedScopeIds !== undefined ||
        patch.includeChildScopes !== undefined ||
        patch.assetTypes !== undefined
      ) {
        const current = await load(storage.workspaces.get(id), 'workspace');
        const writes =
          (current.writePolicy as { enabled?: unknown }).enabled === true ||
          writeTools(current.enabledTools).length > 0;
        const widens =
          widensNames(patch.allowedScopeIds, current.allowedScopeIds) ||
          (patch.includeChildScopes === true && !current.includeChildScopes) ||
          widensAssetTypes(patch.assetTypes, current.assetTypes);
        if (writes && widens) {
          needOwner(actor, 'change the projects or asset types of a workspace that has write tools');
          needRecent(actor, 'changing the projects or asset types of a workspace that has write tools');
        }
      }
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
      // A grant an owner gave write tools keeps the projects, asset types and end date the owner chose (ADR-0013, P4-09).
      if (writeTools(current.tools).length > 0) {
        const later =
          patch.expiresAt !== undefined &&
          current.expiresAt !== null &&
          (patch.expiresAt === null || patch.expiresAt > current.expiresAt);
        if (
          widensNames(patch.scopeIds, current.scopeIds) ||
          widensAssetTypes(patch.assetTypes, current.assetTypes) ||
          later
        ) {
          needOwner(actor, 'widen a grant that has write tools');
          needRecent(actor, 'widening a grant that has write tools');
        }
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
    /**
     * Every device token the actor may see, newest first, one page at a time (P4-15). Owners and admins see all of them;
     * anyone else only the tokens of their own grants. A grant that is not yours is "not found" (no existence oracle);
     * a `userId` that is not yours matches nothing. Keyset paging on `(createdAt, id)`: a page never repeats or skips a token
     * that exists throughout, whatever is added or revoked between two calls. `after` is the previous page's `next`.
     */
    async listAll(
      query: { grantId?: string; userId?: string; after?: string; limit?: number } = {},
    ): Promise<{ data: TokenListItem[]; next: string | null }> {
      const limit = Math.max(1, Math.min(TOKEN_PAGE_MAX, Math.trunc(query.limit ?? TOKEN_PAGE_DEFAULT)));
      let cursor: { createdAt: number; id: string } | null = null;
      if (query.after !== undefined) {
        const m = CURSOR.exec(query.after);
        if (m === null) throw new InvalidInputError('after: not a cursor from a previous page.');
        cursor = { createdAt: Number(m[1]), id: m[2] as string };
      }
      // The grants the actor may read, narrowed by the filters; the tokens of exactly these grants are listed.
      let visible: Grant[];
      if (query.grantId !== undefined) {
        visible = [await ownGrant(query.grantId)];
      } else if (isManager(actor)) {
        visible = await storage.grants.list();
      } else {
        visible = self === null ? [] : await storage.grants.list({ userId: self });
      }
      if (query.userId !== undefined) visible = visible.filter((g) => g.userId === query.userId);
      const byGrant = new Map(visible.map((g) => [g.id, g]));
      let found: AccessToken[] = [];
      if (byGrant.size > 0) {
        found = await storage.accessTokens.list(
          query.grantId === undefined ? {} : { grantId: query.grantId },
        );
      }
      const newestFirst = found
        .filter((t) => byGrant.has(t.grantId))
        .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      const after =
        cursor === null
          ? newestFirst
          : newestFirst.filter(
              (t) => t.createdAt < cursor.createdAt || (t.createdAt === cursor.createdAt && t.id < cursor.id),
            );
      const page = after.slice(0, limit);
      const last = page.at(-1);
      const next = after.length > limit && last !== undefined ? `${last.createdAt}:${last.id}` : null;
      const data = page.map((t) => {
        const g = byGrant.get(t.grantId) as Grant;
        return { ...t, userId: g.userId, workspaceId: g.workspaceId, grantLabel: g.label };
      });
      return { data, next };
    },
    async issue(input: Parameters<AccessServices['tokens']['issue']>[0]) {
      const grant = await ownGrant(input.grantId);
      await needCredentialOwner(grant.credentialId, 'issue device tokens on this grant');
      // A token that outlives the default is a standing credential: it needs a recent sign-in, so a stolen older session
      // cannot mint one that survives the session (P4-09, like GitHub's sudo mode for access tokens).
      if (
        input.expiresInDays === 'never' ||
        (input.expiresInDays ?? DEFAULT_TOKEN_DAYS) > DEFAULT_TOKEN_DAYS
      ) {
        needRecent(actor, 'issuing a device token that lasts longer than 90 days');
      }
      const issued = await services.tokens.issue(input);
      // The grant may have moved to someone's personal token between the check above and the insert; the switch revokes the
      // tokens it can see, so look again now that this one exists (P4-09, L-065).
      try {
        const after = await load(storage.grants.get(grant.id), 'grant');
        if (after.credentialId !== grant.credentialId) {
          await needCredentialOwner(after.credentialId, 'issue device tokens on this grant');
        }
      } catch (error) {
        await services.tokens.revoke(issued.record.id);
        if (error instanceof ForbiddenError || error instanceof NotFoundError) {
          throw new ConflictError(
            'The grant changed while the token was issued; nothing was issued. Try again.',
          );
        }
        throw error;
      }
      return issued;
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
