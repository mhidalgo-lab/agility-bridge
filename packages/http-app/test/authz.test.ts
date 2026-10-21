// SPDX-License-Identifier: Apache-2.0
// Authorization and isolation suite (P2-12, L-121, THREAT_MODEL T3, T21, A4): route × principal × tool. Every denial
// asserts the exact status, the audit reason, zero Agility requests and zero mutations; every allowed read asserts that
// no data from another workspace or Agility project comes back, even from a hostile upstream. The admin routes have
// their own role matrix in admin.test.ts.
import { CORE_TOOLS } from '@agility-bridge/core';
import { describe, expect, it } from 'vitest';
import { connect, post, type World, world } from './helpers/world.ts';

const asset = (type: string, prefix: string, id: number, scope: string, name: string) => ({
  _oid: `${type}:${id}`,
  AssetType: type,
  Number: `${prefix}-0${id}`,
  Name: name,
  AssetState: 64,
  Scope: scope,
  'Scope.Name': scope === 'Scope:2000' ? 'Other team project' : 'Our project',
});

/** Two workspaces: team-a sees Scope:1001, team-b sees Scope:2000. Names say whose data they are. */
const ASSETS = {
  Story: [
    asset('Story', 'B', 1001, 'Scope:1001', 'A-visible story'),
    asset('Story', 'B', 1003, 'Scope:2000', 'B-only story'),
  ],
  Task: [
    asset('Task', 'TK', 1201, 'Scope:1001', 'A-visible task'),
    asset('Task', 'TK', 1203, 'Scope:2000', 'B-only task'),
  ],
  Workitem: [] as Record<string, unknown>[],
  Scope: [
    { _oid: 'Scope:1001', Name: 'Our project', AssetState: 64, ChildrenMeAndDown: ['Scope:1001'] },
    { _oid: 'Scope:2000', Name: 'Other team project', AssetState: 64, ChildrenMeAndDown: ['Scope:2000'] },
  ],
  Member: [{ _oid: 'Member:20', Name: 'Ann Example', Username: 'ann', IsSelf: true, AssetState: 64 }],
};
ASSETS.Workitem = [...ASSETS.Story, ...ASSETS.Task];
const B_ONLY = ['B-only story', 'B-only task', 'B-01003', 'TK-01203', 'Other team project'];

const authzWorld = (filters: 'evaluate' | 'ignore-filters' = 'evaluate') =>
  world({}, { assets: ASSETS, filters, projectsB: ['Scope:2000'] });

async function snapshot(w: World): Promise<string> {
  const s = w.storage;
  const grants = await s.grants.list();
  const tokens = (await Promise.all(grants.map((g) => s.accessTokens.list({ grantId: g.id })))).flat();
  return JSON.stringify([
    await s.users.list(),
    await s.credentials.list(),
    await s.workspaces.list(),
    grants,
    tokens,
  ]);
}

/** A principal that must be refused, and the audit reason it must leave. */
interface Denial {
  name: string;
  reason: string;
  prepare: (w: World) => Promise<{ slug: string; token: string | null }>;
}

const DENIALS: Denial[] = [
  { name: 'no token', reason: 'no_token', prepare: async () => ({ slug: 'team-a', token: null }) },
  {
    name: 'malformed token',
    reason: 'token_malformed',
    prepare: async () => ({ slug: 'team-a', token: 'ab_live_x' }),
  },
  {
    name: 'well-formed unknown token',
    reason: 'token_unknown',
    prepare: async (w) => {
      const { generateDeviceToken } = await import('@agility-bridge/auth');
      return { slug: 'team-a', token: (await generateDeviceToken('live')).token };
    },
  },
  {
    name: "another workspace's token",
    reason: 'wrong_workspace',
    prepare: async (w) => ({ slug: 'team-a', token: w.tokens.bob }),
  },
  {
    name: 'unknown workspace',
    reason: 'wrong_workspace',
    prepare: async (w) => ({ slug: 'team-zzz', token: w.tokens.alice }),
  },
  {
    name: 'revoked token',
    reason: 'token_revoked',
    prepare: async (w) => {
      await w.storage.accessTokens.update(w.ids.aliceToken, { revokedAt: w.now.t });
      return { slug: 'team-a', token: w.tokens.alice };
    },
  },
  {
    name: 'expired token',
    reason: 'token_expired',
    prepare: async (w) => {
      await w.storage.accessTokens.update(w.ids.aliceToken, { expiresAt: w.now.t });
      return { slug: 'team-a', token: w.tokens.alice };
    },
  },
  {
    name: 'revoked grant',
    reason: 'grant_revoked',
    prepare: async (w) => {
      await w.storage.grants.update(w.ids.aliceGrant, { revokedAt: w.now.t });
      return { slug: 'team-a', token: w.tokens.alice };
    },
  },
  {
    name: 'expired grant',
    reason: 'grant_expired',
    prepare: async (w) => {
      await w.storage.grants.update(w.ids.aliceGrant, { expiresAt: w.now.t });
      return { slug: 'team-a', token: w.tokens.alice };
    },
  },
  {
    name: 'disabled workspace',
    reason: 'workspace_disabled',
    prepare: async (w) => {
      await w.storage.workspaces.update(w.ids.workspaceA, { disabledAt: w.now.t });
      return { slug: 'team-a', token: w.tokens.alice };
    },
  },
  {
    name: 'disabled user',
    reason: 'user_disabled',
    prepare: async (w) => {
      await w.storage.users.update(w.ids.alice, { disabledAt: w.now.t });
      return { slug: 'team-a', token: w.tokens.alice };
    },
  },
  {
    name: 'revoked credential',
    reason: 'credential_revoked',
    prepare: async (w) => {
      await w.storage.credentials.update(w.ids.aliceCredential, { revokedAt: w.now.t });
      return { slug: 'team-a', token: w.tokens.alice };
    },
  },
  {
    name: 'unvalidated credential',
    reason: 'credential_unvalidated',
    prepare: async (w) => {
      await w.storage.credentials.update(w.ids.aliceCredential, { validationStatus: 'invalid' });
      return { slug: 'team-a', token: w.tokens.alice };
    },
  },
  {
    name: 'disabled instance',
    reason: 'instance_disabled',
    prepare: async (w) => {
      await w.storage.instances.update(w.ids.instance, { disabledAt: w.now.t });
      return { slug: 'team-a', token: w.tokens.alice };
    },
  },
];

const METHODS = [
  {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
  },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ...CORE_TOOLS.map((t, i) => ({
    jsonrpc: '2.0',
    id: 10 + i,
    method: 'tools/call',
    params: { name: t.name, arguments: {} },
  })),
];

describe('MCP route × principal × method/tool: every denial denies', () => {
  it.each(DENIALS.map((d) => [d.name, d] as const))('%s', async (_name, denial) => {
    const w = await authzWorld();
    const { slug, token } = await denial.prepare(w);
    const before = await snapshot(w);
    const bodies = new Set<string>();
    for (const message of METHODS) {
      const res = await post(w, slug, token, message);
      expect(res.status, `${message.method} ${JSON.stringify(message.params).slice(0, 40)}`).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
      bodies.add(await res.text());
    }
    expect(bodies).toEqual(new Set([JSON.stringify({ error: 'unauthorized' })]));
    expect(w.agilityTokens).toEqual([]);
    expect(await snapshot(w)).toBe(before);
    await w.audit.flush();
    const rows = await w.storage.audit.query({ kind: 'auth', limit: 1_000 });
    expect(rows).toHaveLength(METHODS.length);
    for (const row of rows) expect(row.details).toMatchObject({ reason: denial.reason });
    expect(await w.storage.audit.query({ kind: 'tool_call' })).toEqual([]);
  });
});

describe('tools outside the grant', () => {
  it('are neither listed nor callable, and reach no Agility instance', async () => {
    const w = await authzWorld();
    await w.storage.grants.update(w.ids.aliceGrant, { tools: ['whoami'] });
    const client = await connect(w, 'team-a', w.tokens.alice);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['whoami']);
    for (const tool of CORE_TOOLS.filter((t) => t.name !== 'whoami')) {
      await expect(client.callTool({ name: tool.name, arguments: {} }), tool.name).rejects.toThrow(
        /not found/,
      );
    }
    expect(w.agilityTokens).toEqual([]);
    await client.close();
  });
});

const text = (r: { content?: unknown; structuredContent?: unknown }) =>
  JSON.stringify([r.content, r.structuredContent ?? null]);

describe.each(['evaluate', 'ignore-filters'] as const)('isolation of data (upstream %s)', (filters) => {
  it('direct scope (Story) and derived scope (Task): only the workspace project, single assets outside are not found', async () => {
    const w = await authzWorld(filters);
    const a = await connect(w, 'team-a', w.tokens.alice);
    for (const type of ['Story', 'Task']) {
      const r = await a.callTool({ name: 'query_assets', arguments: { asset_type: type, fields: ['Name'] } });
      expect(r.isError, text(r)).toBeFalsy();
      for (const leak of B_ONLY) expect(text(r)).not.toContain(leak);
      expect(text(r)).toContain(type === 'Story' ? 'B-01001' : 'TK-01201');
    }
    // Guessing numbers or OIDs of the other project (A4, L-145): not found, nothing leaks.
    for (const ref of ['B-01003', 'Story:1003', 'TK-01203', 'Task:1203']) {
      const r = await a.callTool({ name: 'get_assets', arguments: { assets: [ref] } });
      // Reported as not found, and no other asset stands in for it (a hostile upstream ignores the filter).
      expect(r.structuredContent, ref).toMatchObject({ items: [], notFound: [ref] });
      for (const leak of B_ONLY) expect(text(r).replace(ref, ''), ref).not.toContain(leak);
      expect(text(r)).not.toContain('A-visible');
      const item = await a.callTool({
        name: 'get_work_item',
        arguments: { asset: ref, minimal_output: true },
      });
      expect(text(item), ref).toContain('AB_NOT_FOUND');
      expect(text(item)).not.toContain('A-visible');
    }
    await a.close();
  });

  it('workspace-bounded (Scope): only the allowed projects', async () => {
    const w = await authzWorld(filters);
    const a = await connect(w, 'team-a', w.tokens.alice);
    const r = await a.callTool({
      name: 'query_assets',
      arguments: { asset_type: 'Scope', fields: ['Name'] },
    });
    expect(text(r)).toContain('Our project');
    expect(text(r)).not.toContain('Other team project');
    await a.close();
  });

  it('global (Member) only when the workspace allows it; denied types (Role) never', async () => {
    const w = await authzWorld(filters);
    const a = await connect(w, 'team-a', w.tokens.alice);
    const member = await a.callTool({
      name: 'query_assets',
      arguments: { asset_type: 'Member', fields: ['Name'] },
    });
    expect(text(member)).toContain('AB_AUTH_FORBIDDEN');
    expect(text(member)).not.toContain('Ann Example');
    const role = await a.callTool({
      name: 'query_assets',
      arguments: { asset_type: 'Role', fields: ['Name'] },
    });
    expect(text(role)).toContain('AB_AUTH_FORBIDDEN');
    await a.close();
    await w.storage.workspaces.update(w.ids.workspaceA, { assetTypes: { allow: ['Member', 'Story'] } });
    w.app.clearAccessCache();
    const allowed = await connect(w, 'team-a', w.tokens.alice);
    const r = await allowed.callTool({
      name: 'query_assets',
      arguments: { asset_type: 'Member', fields: ['Name'] },
    });
    expect(r.isError, text(r)).toBeFalsy();
    await allowed.close();
  });
});

describe('two workspaces, two credentials, one process (T21)', () => {
  it('interleaved concurrent calls never mix data or credentials', async () => {
    const w = await authzWorld('ignore-filters');
    const [a, b] = await Promise.all([
      connect(w, 'team-a', w.tokens.alice),
      connect(w, 'team-b', w.tokens.bob),
    ]);
    const calls = Array.from({ length: 24 }, (_, i) => {
      const mine = i % 2 === 0 ? 'a' : 'b';
      const client = mine === 'a' ? a : b;
      return client
        .callTool({ name: 'get_assets', arguments: { assets: ['B-01001', 'B-01003'] } })
        .then((r) => ({ mine, r }));
    });
    for (const { mine, r } of await Promise.all(calls)) {
      const out = text(r);
      if (mine === 'a') {
        expect(out).toContain('A-visible story');
        expect(out).not.toContain('B-only story');
      } else {
        expect(out).toContain('B-only story');
        expect(out).not.toContain('A-visible story');
      }
    }
    await Promise.all([a.close(), b.close()]);
    await w.audit.flush();
    const rows = await w.storage.audit.query({ kind: 'tool_call', limit: 100 });
    expect(rows).toHaveLength(24);
    const byWorkspace = new Map(rows.map((r) => [r.grantId, r.workspaceId]));
    expect(new Set(byWorkspace.values()).size).toBe(2);
  });
});
