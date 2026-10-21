// SPDX-License-Identifier: Apache-2.0
// Owner/admin guards on every writer (P2-09, L-065, THREAT_MODEL T3, T14, A5, A14). The admin API, the CLI and any
// future import call `guardedServices(services, actor)`, never the raw services, so the same rules hold on every path.
import {
  type AccessToken,
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

const roleOf = (a: Actor): Role => (a.kind === 'break_glass' ? 'owner' : a.role);
const userIdOf = (a: Actor): string | null => (a.kind === 'user' ? a.userId : null);
const isOwner = (a: Actor) => roleOf(a) === 'owner';
const isManager = (a: Actor) => roleOf(a) === 'owner' || roleOf(a) === 'admin';

function need(ok: boolean, message: string): void {
  if (!ok) throw new ForbiddenError(message);
}
const needManager = (a: Actor) => need(isManager(a), 'This needs an owner or an admin.');
const needOwner = (a: Actor, what: string) => need(isOwner(a), `Only an owner can ${what}.`);

export interface GuardContext {
  readonly storage: Storage;
  readonly tools: ReadonlyMap<string, ToolInfo>;
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
      if (input.role !== 'member') needOwner(actor, 'create owners or admins');
      return services.users.create(input);
    },
    async update(id: string, patch: Parameters<AccessServices['users']['update']>[1]): Promise<User> {
      needManager(actor);
      const target = await load(storage.users.get(id), 'user');
      if (target.role !== 'member' || (patch.role !== undefined && patch.role !== 'member')) {
        needOwner(actor, 'change owners, admins or roles above member');
      }
      if (target.role === 'owner' && patch.role !== undefined && patch.role !== 'owner') {
        const others = (await activeOwners()).filter((u) => u.id !== id);
        need(others.length > 0, 'The last active owner cannot lose the owner role.');
      }
      return services.users.update(id, patch);
    },
    async disable(id: string): Promise<User> {
      needManager(actor);
      const target = await load(storage.users.get(id), 'user');
      if (target.role !== 'member') needOwner(actor, 'disable owners or admins');
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
      need(
        actor.kind === 'break_glass' || actor.recentAuth,
        'Sign in again before changing an instance origin.',
      );
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
      else
        need(input.ownerUserId === self, 'Only the user themselves can store their personal Agility token.');
      return services.credentials.create(input);
    },
    async replaceToken(id: string, token: string): Promise<Credential> {
      const c = await load(storage.credentials.get(id), 'credential');
      if (c.ownerUserId === null) needManager(actor);
      else if (!mineCredential(c)) throw new NotFoundError('No credential with this id.');
      return services.credentials.replaceToken(id, token);
    },
    async update(id: string, patch: { label?: string }): Promise<Credential> {
      const c = await load(storage.credentials.get(id), 'credential');
      if (!mineCredential(c) && !isManager(actor)) throw new NotFoundError('No credential with this id.');
      return services.credentials.update(id, patch);
    },
    async revoke(id: string): Promise<Credential> {
      const c = await load(storage.credentials.get(id), 'credential');
      if (!mineCredential(c)) {
        if (!isManager(actor)) throw new NotFoundError('No credential with this id.');
      }
      return services.credentials.revoke(id);
    },
    async delete(id: string): Promise<void> {
      needManager(actor);
      await storage.credentials.delete(id);
    },
  };

  const checkWorkspaceWrites = (input: Partial<NewWorkspaceInput>) => {
    if (input.writePolicy !== undefined) needOwner(actor, 'change write settings');
    if (writeTools(input.enabledTools).length > 0) needOwner(actor, 'enable write tools');
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
      if (writeTools(input.tools).length > 0) needOwner(actor, 'grant write tools');
      return services.grants.create(input);
    },
    async update(id: string, patch: GrantPatchInput): Promise<WithWarnings<Grant>> {
      needManager(actor);
      if (writeTools(patch.tools).length > 0) needOwner(actor, 'grant write tools');
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
  const tokens = {
    async list(grantId: string): Promise<AccessToken[]> {
      await ownGrant(grantId);
      return services.tokens.list(grantId);
    },
    async issue(input: Parameters<AccessServices['tokens']['issue']>[0]) {
      await ownGrant(input.grantId);
      return services.tokens.issue(input);
    },
    async revoke(id: string): Promise<AccessToken> {
      const t = await load(storage.accessTokens.get(id), 'token');
      await ownGrant(t.grantId);
      return services.tokens.revoke(id);
    },
  };

  return Object.freeze({ actor, users, instances, credentials, workspaces, grants, tokens });
}

export type GuardedServices = ReturnType<typeof guardedServices>;
