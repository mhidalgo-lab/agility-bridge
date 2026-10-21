// SPDX-License-Identifier: Apache-2.0
// The HTTP app end to end (P2-06): both protocol eras, batch refusal, body caps, hostile Host/Origin, wrong workspace,
// uniform 401, headers on every response, method classification.
import { describe, expect, it } from 'vitest';
import { classifyMcpMessage } from '../src/index.ts';
import { ALICE_AGILITY, BOB_AGILITY, connect, type Era, ORIGIN, post, world } from './helpers/world.ts';

const ERAS: Era[] = ['legacy', { pin: '2026-07-28' }];
const text = (r: { content?: unknown }) =>
  ((r.content as { text?: string }[] | undefined) ?? []).map((c) => c.text).join('');

describe('MCP over HTTP, both protocol eras (ADR-0005)', () => {
  it.each(ERAS)('serves the granted tools and calls them with the grant credential (%o)', async (era) => {
    const w = await world();
    const client = await connect(w, 'team-a', w.tokens.alice, era);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('whoami');
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    const r = await client.callTool({ name: 'whoami', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ workspace: { id: w.ids.workspaceA, name: 'Team A' } });
    expect(w.agilityTokens.length).toBeGreaterThan(0);
    expect(new Set(w.agilityTokens)).toEqual(new Set([ALICE_AGILITY]));
    expect(w.toolCalls.map((c) => [c.tool, c.status, c.access.workspace.slug])).toEqual([
      ['whoami', 'ok', 'team-a'],
    ]);
    await client.close();
  });

  it('lists only the tools of the grant, and refuses others when called anyway', async () => {
    const w = await world();
    const client = await connect(w, 'team-b', w.tokens.bob);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['get_assets', 'whoami']);
    await expect(
      client.callTool({ name: 'query_assets', arguments: { asset_type: 'Story' } }),
    ).rejects.toThrow(/not found/);
    expect(w.agilityTokens).toEqual([]);
    await client.close();
  });

  it('keeps two workspaces and two credentials apart within one process (T21)', async () => {
    const w = await world();
    const [a, b] = await Promise.all([
      connect(w, 'team-a', w.tokens.alice),
      connect(w, 'team-b', w.tokens.bob),
    ]);
    const [ra, rb] = await Promise.all([
      a.callTool({ name: 'get_assets', arguments: { assets: ['B-00002'] } }),
      b.callTool({ name: 'get_assets', arguments: { assets: ['B-00002'] } }),
    ]);
    expect(text(ra)).not.toContain('In B');
    expect(text(rb)).toContain('In B');
    expect(w.agilityTokens).toContain(ALICE_AGILITY);
    expect(w.agilityTokens).toContain(BOB_AGILITY);
    await Promise.all([a.close(), b.close()]);
  });
});

describe('authentication', () => {
  const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

  it('answers the same 401 for no token, a bad token, a wrong workspace and an unknown workspace (T2, T19)', async () => {
    const w = await world();
    const cases: [string, string | null][] = [
      ['team-a', null],
      ['team-a', 'ab_live_not-a-token'],
      ['team-a', `${w.tokens.alice.slice(0, -1)}A`],
      ['team-a', w.tokens.bob],
      ['team-b', w.tokens.alice],
      ['nope', w.tokens.alice],
    ];
    const bodies = new Set<string>();
    for (const [slug, token] of cases) {
      const res = await post(w, slug, token, LIST);
      expect(res.status, `${slug} ${token?.slice(0, 12)}`).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
    expect(w.agilityTokens).toEqual([]);
    expect(w.requests.map((r) => r.refusal)).toEqual([
      'no_token',
      'token_malformed',
      'token_malformed',
      'wrong_workspace',
      'wrong_workspace',
      'wrong_workspace',
    ]);
  });

  it('a token for team-a used at team-b is refused even though its user has a team-b grant (L-067)', async () => {
    const w = await world();
    expect((await post(w, 'team-b', w.tokens.alice, LIST)).status).toBe(401);
    expect((await post(w, 'team-b', w.tokens.aliceB, LIST)).status).toBe(200);
    // A cached success at team-a never answers for team-b.
    expect((await post(w, 'team-a', w.tokens.alice, LIST)).status).toBe(200);
    expect((await post(w, 'team-b', w.tokens.alice, LIST)).status).toBe(401);
  });

  it('revocation applies after the access cache (≤ TTL), immediately once the cache is cleared (T15)', async () => {
    const w = await world();
    expect((await post(w, 'team-a', w.tokens.alice, LIST)).status).toBe(200);
    await w.storage.accessTokens.update(w.ids.aliceToken, { revokedAt: w.now.t });
    expect((await post(w, 'team-a', w.tokens.alice, LIST)).status).toBe(200);
    w.now.t += 30_000;
    expect((await post(w, 'team-a', w.tokens.alice, LIST)).status).toBe(401);
    const w2 = await world({ accessCacheTtlSeconds: 60 });
    expect((await post(w2, 'team-a', w2.tokens.alice, LIST)).status).toBe(200);
    await w2.storage.grants.update(w2.ids.aliceGrant, { revokedAt: w2.now.t });
    w2.app.clearAccessCache();
    expect((await post(w2, 'team-a', w2.tokens.alice, LIST)).status).toBe(401);
  });

  it('a storage failure is a 503, never an open door', async () => {
    const w = await world();
    const broken = await world({
      storage: {
        ...w.storage,
        accessTokens: { ...w.storage.accessTokens, getByHash: () => Promise.reject(new Error('disk')) },
      },
    });
    const res = await post(broken, 'team-a', broken.tokens.alice, LIST);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
  });
});

describe('request hygiene', () => {
  it('refuses JSON-RPC batches before the SDK (L-014)', async () => {
    const w = await world();
    const res = await post(w, 'team-a', w.tokens.alice, [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } },
    ]);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: -32600 } });
    expect(w.agilityTokens).toEqual([]);
  });

  it('refuses oversized bodies, declared or streamed, invalid JSON and other content types', async () => {
    const w = await world();
    const big = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { pad: 'x'.repeat(1_100_000) },
    });
    expect((await post(w, 'team-a', w.tokens.alice, big)).status).toBe(413);
    const streamed = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 20; i++) controller.enqueue(new TextEncoder().encode('x'.repeat(100_000)));
        controller.close();
      },
    });
    const res = await w.app.fetch(
      new Request(`${ORIGIN}/w/team-a/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${w.tokens.alice}` },
        body: streamed,
        duplex: 'half',
      } as RequestInit),
    );
    expect(res.status).toBe(413);
    expect((await post(w, 'team-a', w.tokens.alice, '{not json')).status).toBe(400);
    expect((await post(w, 'team-a', w.tokens.alice, '{}', { 'content-type': 'text/plain' })).status).toBe(
      415,
    );
  });

  it('refuses hostile Host and Origin headers, and Origin: null (DNS rebinding, T24)', async () => {
    const w = await world();
    const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    for (const headers of [
      { host: 'evil.example' },
      { host: 'localhost.evil.example:8787' },
      // Malformed Host values are refused, never parsed leniently into an allowed name (P2-17 review L3).
      { host: 'localhost:8787@evil.example' },
      { host: 'localhost:8787, evil.example' },
      { host: 'localhost:evil.example' },
      { host: 'localhost:' },
      { host: '[::1]junk' },
      { host: 'localhost/evil' },
      { host: 'localhost:87x' },
      { host: 'localhost:8787:1' },
      { host: 'evil.example#localhost' },
      { host: '' },
      { origin: 'null' },
      { origin: 'https://evil.example' },
    ]) {
      const res = await post(w, 'team-a', w.tokens.alice, LIST, headers);
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    }
    expect((await post(w, 'team-a', w.tokens.alice, LIST, { host: 'localhost:9999' })).status).toBe(200);
    const pub = await world({
      publicUrl: 'https://mcp.example.test',
      allowedOrigins: ['https://app.example.test'],
    });
    expect((await post(pub, 'team-a', pub.tokens.alice, LIST, { host: 'mcp.example.test' })).status).toBe(
      200,
    );
    const cors = await post(pub, 'team-a', pub.tokens.alice, LIST, {
      host: 'mcp.example.test',
      origin: 'https://app.example.test',
    });
    expect(cors.status).toBe(200);
    expect(cors.headers.get('access-control-allow-origin')).toBe('https://app.example.test');
    const noCors = await post(pub, 'team-a', pub.tokens.alice, LIST, { host: 'mcp.example.test' });
    expect(noCors.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('puts the security headers on 200, 401, 403, 404, 405 and 503 responses, with HSTS from the public URL', async () => {
    const w = await world({ publicUrl: 'https://mcp.example.test' });
    const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    const responses = [
      await post(w, 'team-a', w.tokens.alice, LIST, { host: 'mcp.example.test' }),
      await post(w, 'team-a', null, LIST, { host: 'mcp.example.test' }),
      await post(w, 'team-a', null, LIST, { host: 'evil.example' }),
      await w.app.fetch(new Request('https://mcp.example.test/nothing-here')),
      await w.app.fetch(
        new Request('https://mcp.example.test/w/team-a/mcp', {
          headers: { authorization: `Bearer ${w.tokens.alice}` },
        }),
      ),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 401, 403, 404, 405]);
    for (const r of responses) {
      expect(r.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
      expect(r.headers.get('x-frame-options')).toBe('DENY');
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(r.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    }
    const local = await world();
    expect((await post(local, 'team-a', null, LIST)).headers.get('strict-transport-security')).toBeNull();
  });

  it('health and version reveal nothing else (L-151)', async () => {
    const w = await world();
    const health = await w.app.fetch(new Request(`${ORIGIN}/health`));
    expect(await health.json()).toEqual({ status: 'ok' });
    expect(await (await w.app.fetch(new Request(`${ORIGIN}/version`))).json()).toEqual({
      version: '0.0.0-test',
    });
  });
});

describe('method classification (L-015)', () => {
  it('classifies every MCP method from the body; listen streams and notifications are not tool calls', () => {
    const c = (m: unknown) => classifyMcpMessage(m).kind;
    expect(c({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami' } })).toBe('tool_call');
    expect(c({ jsonrpc: '2.0', id: 1, method: 'subscriptions/listen' })).toBe('listen');
    expect(c({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBe('notification');
    expect(c({ jsonrpc: '2.0', id: 1, method: 'initialize' })).toBe('lifecycle');
    expect(c({ jsonrpc: '2.0', id: 1, method: 'server/discover' })).toBe('lifecycle');
    expect(c({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toBe('list');
    expect(c({ jsonrpc: '2.0', id: 1, method: 'resources/read' })).toBe('read');
    expect(c({ jsonrpc: '2.0', id: 1, method: 'tasks/get' })).toBe('task');
    expect(c({ jsonrpc: '2.0', id: 1, result: {} })).toBe('response');
    expect(c({ jsonrpc: '2.0', id: 1, method: 'x'.repeat(500) })).toBe('other');
    expect(classifyMcpMessage({ method: 'tools/call', params: { name: 'n'.repeat(500) } }).tool).toHaveLength(
      64,
    );
  });

  it('a subscriptions/listen request reaches the limits as a listen, not a tool call', async () => {
    const seen: string[] = [];
    const w = await world({
      limits: {
        afterAuth: (_access, mcp) => {
          seen.push(mcp.kind);
          return { ok: true };
        },
      },
    });
    await post(
      w,
      'team-a',
      w.tokens.alice,
      { jsonrpc: '2.0', id: 1, method: 'subscriptions/listen', params: {} },
      {
        'mcp-method': 'tools/call',
      },
    );
    await post(w, 'team-a', w.tokens.alice, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'whoami', arguments: {} },
    });
    expect(seen).toEqual(['listen', 'tool_call']);
    expect(w.requests.map((r) => r.mcp?.kind)).toEqual(['listen', 'tool_call']);
  });

  it('rate-limit hooks turn into 429 with Retry-After, before and after authentication', async () => {
    const before = await world({ limits: { beforeAuth: () => ({ ok: false, retryAfterSeconds: 7.2 }) } });
    const r1 = await post(before, 'team-a', before.tokens.alice, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    expect([r1.status, r1.headers.get('retry-after')]).toEqual([429, '8']);
    const failures: string[] = [];
    const after = await world({
      limits: {
        afterAuth: () => ({ ok: false, retryAfterSeconds: 1 }),
        onAuthFailure: (ip) => void failures.push(ip),
      },
    });
    expect(
      (await post(after, 'team-a', after.tokens.alice, { jsonrpc: '2.0', id: 1, method: 'tools/list' }))
        .status,
    ).toBe(429);
    expect((await post(after, 'team-a', null, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(
      401,
    );
    expect(failures).toEqual(['unknown']);
    expect(after.agilityTokens).toEqual([]);
  });
});
