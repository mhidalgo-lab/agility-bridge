// SPDX-License-Identifier: Apache-2.0
// The approval policy "page only" (P7-26, THREAT_MODEL T31, A13): an owner with a recent sign-in sets it on a workspace
// or a grant, an administrator and a member cannot set or remove it, and the write runtime carries it to the pipeline.
// Negative authorization first: a refusal changes nothing.
import { generateMasterKey, Keyring } from '@agility-bridge/auth';
import { describe, expect, it } from 'vitest';
import { ADMIN_BASE, createHttpWrites } from '../src/index.ts';
import { ORIGIN, type World, world } from './helpers/world.ts';

type Who = 'none' | 'member' | 'admin' | 'owner' | 'owner_stale' | 'break_glass';

const call = (w: World, who: Who, method: string, path: string, body?: unknown) =>
  w.app.fetch(
    new Request(`${ORIGIN}${ADMIN_BASE}${path}`, {
      method,
      headers: {
        ...(who === 'none' ? {} : { 'x-test-actor': who }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const storedGrant = async (w: World) => (await w.storage.grants.get(w.ids.aliceGrant))?.rateLimit ?? null;
const storedPolicy = async (w: World) => (await w.storage.workspaces.get(w.ids.workspaceA))?.writePolicy;

describe('a grant that needs the approval page (admin API)', () => {
  it('an owner with a recent sign-in sets and removes it; the audit row keeps the previous value', async () => {
    const w = await world({}, { admin: true });
    const path = `/grants/${w.ids.aliceGrant}`;
    expect(
      (await call(w, 'owner', 'PATCH', path, { rateLimit: { writeApproval: 'page_only' } })).status,
    ).toBe(200);
    expect(await storedGrant(w)).toEqual({ writeApproval: 'page_only' });
    expect((await call(w, 'owner', 'PATCH', path, { rateLimit: null })).status).toBe(200);
    expect(await storedGrant(w)).toBeNull();
    await w.audit.flush();
    const rows = await w.storage.audit.query({
      kind: 'admin',
      status: 'ok',
      action: 'grant.update',
      limit: 10,
    });
    expect(rows.map((r) => r.details?.['previousWriteApproval']).sort()).toEqual(['page_only', undefined]);
  });

  it('refuses anything but page_only (the default is the absence of the setting), changing nothing', async () => {
    const w = await world({}, { admin: true });
    const path = `/grants/${w.ids.aliceGrant}`;
    for (const bad of ['any', 'page', true, 1, null, 'elicitation']) {
      const res = await call(w, 'owner', 'PATCH', path, { rateLimit: { writeApproval: bad } });
      expect(res.status, JSON.stringify(bad)).toBe(422);
    }
    expect(await storedGrant(w)).toBeNull();
  });

  it('an admin, a member, a stale sign-in and a stranger cannot set, change or remove it; nothing changes', async () => {
    const w = await world({}, { admin: true });
    const path = `/grants/${w.ids.aliceGrant}`;
    // Nobody but an owner can set it ...
    const set = { rateLimit: { writeApproval: 'page_only' } };
    expect((await call(w, 'none', 'PATCH', path, set)).status).toBe(401);
    for (const who of ['admin', 'member'] as const) {
      expect([403, 404], who).toContain((await call(w, who, 'PATCH', path, set)).status);
    }
    const stale = await call(w, 'owner_stale', 'PATCH', path, set);
    expect(stale.status).toBe(403);
    expect((await stale.json()).error.code).toBe('reauth_required');
    expect(await storedGrant(w)).toBeNull();
    // ... nor remove it once an owner set it.
    await call(w, 'owner', 'PATCH', path, set);
    const before = JSON.stringify(await w.storage.grants.list());
    for (const body of [{ rateLimit: null }, { rateLimit: { perMinute: 10 } }, { rateLimit: {} }]) {
      for (const who of ['admin', 'member'] as const) {
        expect([403, 404], `${who} ${JSON.stringify(body)}`).toContain(
          (await call(w, who, 'PATCH', path, body)).status,
        );
      }
      expect((await call(w, 'owner_stale', 'PATCH', path, body)).status).toBe(403);
    }
    // Creating a grant that carries it is the same.
    const create = { workspaceId: w.ids.workspaceA, userId: null, label: 'svc', rateLimit: set.rateLimit };
    expect((await call(w, 'admin', 'POST', '/grants', create)).status).toBe(403);
    expect((await call(w, 'owner_stale', 'POST', '/grants', create)).status).toBe(403);
    expect(JSON.stringify(await w.storage.grants.list())).toBe(before);
  });

  it('an admin may still change what is not an owner decision while the setting stays', async () => {
    const w = await world({}, { admin: true });
    const path = `/grants/${w.ids.aliceGrant}`;
    await call(w, 'owner', 'PATCH', path, { rateLimit: { writeApproval: 'page_only' } });
    expect(
      (await call(w, 'admin', 'PATCH', path, { rateLimit: { writeApproval: 'page_only', perMinute: 7 } }))
        .status,
    ).toBe(200);
    expect(await storedGrant(w)).toEqual({ writeApproval: 'page_only', perMinute: 7 });
    expect((await call(w, 'admin', 'PATCH', path, { label: 'renamed' })).status).toBe(200);
    expect(await storedGrant(w)).toEqual({ writeApproval: 'page_only', perMinute: 7 });
  });
});

describe('a workspace that needs the approval page (admin API)', () => {
  it('an owner with a recent sign-in sets it; any other value is refused', async () => {
    const w = await world({}, { admin: true });
    const path = `/workspaces/${w.ids.workspaceA}`;
    const res = await call(w, 'owner', 'PATCH', path, {
      writePolicy: { enabled: true, approval: 'page_only' },
    });
    expect(res.status).toBe(200);
    expect(await storedPolicy(w)).toEqual({ enabled: true, approval: 'page_only' });
    for (const bad of ['page', 'PAGE_ONLY', true, null]) {
      const refused = await call(w, 'owner', 'PATCH', path, {
        writePolicy: { enabled: true, approval: bad },
      });
      expect(refused.status, JSON.stringify(bad)).toBe(422);
    }
    expect(await storedPolicy(w)).toEqual({ enabled: true, approval: 'page_only' });
  });

  it('an admin, a member and a stale sign-in cannot set or remove it; nothing changes', async () => {
    const w = await world({}, { admin: true });
    const path = `/workspaces/${w.ids.workspaceA}`;
    await call(w, 'owner', 'PATCH', path, { writePolicy: { enabled: true, approval: 'page_only' } });
    const before = JSON.stringify(await w.storage.workspaces.list());
    for (const body of [
      { writePolicy: { enabled: true } },
      { writePolicy: { enabled: true, approval: 'any' } },
      { writePolicy: {} },
    ]) {
      expect((await call(w, 'none', 'PATCH', path, body)).status).toBe(401);
      for (const who of ['admin', 'member'] as const) {
        expect([403, 404], `${who} ${JSON.stringify(body)}`).toContain(
          (await call(w, who, 'PATCH', path, body)).status,
        );
      }
      expect((await call(w, 'owner_stale', 'PATCH', path, body)).status).toBe(403);
    }
    expect(JSON.stringify(await w.storage.workspaces.list())).toBe(before);
  });
});

describe('the write runtime carries the policy to the pipeline', () => {
  async function runtimeOf(writeApproval: 'any' | 'page_only' | undefined) {
    const w = await world({}, {});
    const writes = createHttpWrites({
      storage: w.storage,
      audit: w.audit,
      keyring: await Keyring.create(generateMasterKey(1)),
      clock: { now: () => w.now.t },
    });
    const access = {
      grant: { id: 'g-own', userId: 'u-1' },
      tokenId: null,
      clientId: null,
      writeTools: [],
      rateLimit: null,
      ...(writeApproval === undefined ? {} : { writeApproval }),
    } as never;
    return writes.runtimeFor(access);
  }

  it('page_only and any pass through unchanged', async () => {
    expect((await runtimeOf('page_only')).approvalPolicy).toBe('page_only');
    expect((await runtimeOf('any')).approvalPolicy).toBe('any');
  });
});
