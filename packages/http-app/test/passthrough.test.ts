// SPDX-License-Identifier: Apache-2.0
// Pass-through workspaces (P2-14, D-04): the caller's own Agility token in `X-Agility-Token`, HTTPS only, validated
// against the workspace's instance, never stored or logged, every workspace control applied, never a write tool.
import {
  type CredentialValidator,
  resolvePassthroughAccess,
  type ValidationResult,
} from '@agility-bridge/auth';
import { silentLogger } from '@agility-bridge/core';
import { describe, expect, it } from 'vitest';
import { instance, SETTINGS, TOOLS, workspace } from '../../auth/test/helpers/access.ts';
import {
  createRequestLimits,
  DEFAULT_RATE_LIMITS,
  type HttpAppOptions,
  MemoryRateLimiter,
  type RateLimitConfig,
} from '../src/index.ts';
import { connect, ORIGIN, post, type World, world } from './helpers/world.ts';

const GOOD = '1.CallerOwnAgilityTokenNotReal0001';
const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

function validator(): CredentialValidator & { calls: number } {
  const v = {
    calls: 0,
    async validate(_i: unknown, _id: string, token: string): Promise<ValidationResult> {
      v.calls++;
      if (token === GOOD) {
        return {
          status: 'valid',
          memberOid: 'Member:20',
          memberName: 'Ann',
          memberUsername: null,
          reachableScopeIds: [],
        };
      }
      return { status: 'invalid', code: 'AB_AGILITY_AUTH', message: 'refused' };
    },
    probe: async () => ({ ok: true as const, fingerprint: null }),
  };
  return v;
}

async function ptWorld(enabled = true, over: Partial<HttpAppOptions> = {}, v = validator()) {
  const w = await world({
    ...(enabled
      ? {
          passthrough: {
            validator: v,
            secure: (c) => c.req.header('x-forwarded-proto') === 'https',
            identityTtlSeconds: 60,
          },
        }
      : {}),
    ...over,
  });
  await w.storage.workspaces.update(w.ids.workspaceA, { credentialSource: 'passthrough' });
  return { w, v };
}

const https = { 'x-forwarded-proto': 'https' };
const send = (
  w: World,
  token: string | null,
  body: unknown = LIST,
  slug = 'team-a',
  headers: Record<string, string> = https,
) => post(w, slug, null, body, { ...headers, ...(token === null ? {} : { 'x-agility-token': token }) });

describe('pass-through refusals', () => {
  it('refuses a missing token, plain HTTP, a disabled feature, a stored workspace and an invalid token — with zero Agility calls for the transport refusals', async () => {
    const { w, v } = await ptWorld();
    expect((await send(w, null)).status).toBe(401);
    expect((await send(w, GOOD, LIST, 'team-a', {})).status).toBe(401); // HTTP: the token is not even validated
    expect(v.calls).toBe(0);
    expect((await send(w, GOOD, LIST, 'team-b')).status).toBe(401); // a workspace with stored credentials
    expect((await send(w, 'another-instance-token')).status).toBe(401); // refused by the workspace's instance
    expect((await send(w, 'two words')).status).toBe(401);
    const off = await ptWorld(false);
    expect((await send(off.w, GOOD)).status).toBe(401);
    expect(w.agilityTokens).toEqual([]);
    expect(w.requests.map((r) => r.refusal)).toEqual([
      'no_token',
      'passthrough_insecure',
      'not_passthrough',
      'passthrough_invalid',
      'token_malformed',
    ]);
    expect(off.w.requests.map((r) => r.refusal)).toEqual(['passthrough_disabled']);
  });
});

describe('pass-through access', () => {
  it('serves the workspace with the caller token, every workspace control applied, validating once per fingerprint', async () => {
    const { w, v } = await ptWorld();
    await w.storage.workspaces.update(w.ids.workspaceA, { enabledTools: ['whoami', 'get_assets'] });
    const list = await send(w, GOOD);
    expect(list.status).toBe(200);
    const tools = (await list.text()).match(/"name":"([a-z_]+)"/g);
    expect(tools).toEqual(['"name":"whoami"', '"name":"get_assets"']);
    const call = await send(w, GOOD, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'get_assets', arguments: { assets: ['B-00001', 'B-00002'] } },
    });
    const text = await call.text();
    expect(text).toContain('In A');
    expect(text).not.toContain('In B'); // Scope:2001 is outside the workspace
    expect(new Set(w.agilityTokens)).toEqual(new Set([GOOD]));
    expect(v.calls).toBe(1); // the identity cache holds the fingerprint, not the token
    w.now.t += 61_000;
    await send(w, GOOD);
    expect(v.calls).toBe(2);
  });

  it('keeps the token out of logs and audit, which carry its HMAC fingerprint', async () => {
    const { w } = await ptWorld();
    await send(w, GOOD, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'whoami', arguments: {} },
    });
    await send(w, 'wrong-token-value-1234567890');
    await w.audit.flush();
    const rows = await w.storage.audit.query({ limit: 100 });
    const dump = JSON.stringify([rows, w.logs, w.requests.map((r) => r.access)]);
    expect(dump).not.toContain(GOOD);
    expect(dump).not.toContain('wrong-token-value');
    const call = rows.find((r) => r.kind === 'tool_call');
    expect(call?.tokenId).toMatch(/^pt:[0-9a-f]{32}$/);
    expect(call?.grantId).toBe(`passthrough:${call?.tokenId?.slice(3)}`);
    expect(call?.userId).toBeNull();
  });

  it('device tokens keep working on the same workspace', async () => {
    const { w } = await ptWorld();
    const client = await connect(w, 'team-a', w.tokens.alice);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await client.close();
    expect(ORIGIN).toContain('127.0.0.1');
  });
});

describe('pass-through validation costs (P2-17 review F2)', () => {
  const limits = (config: Partial<RateLimitConfig>) => ({
    limits: createRequestLimits(new MemoryRateLimiter(), { ...DEFAULT_RATE_LIMITS, ...config }, silentLogger),
    clientIp: (c: { req: { header(name: string): string | undefined } }) =>
      c.req.header('x-test-ip') ?? 'unknown',
  });
  const from = (ip: string) => ({ ...https, 'x-test-ip': ip });

  it('an address out of failed attempts gets 429 without another upstream validation', async () => {
    const { w, v } = await ptWorld(true, limits({ authFailuresPer5Minutes: 2 }));
    expect((await send(w, 'wrong-token-0000000001', LIST, 'team-a', from('9.9.9.9'))).status).toBe(401);
    expect((await send(w, 'wrong-token-0000000002', LIST, 'team-a', from('9.9.9.9'))).status).toBe(401);
    expect(v.calls).toBe(2);
    expect((await send(w, 'wrong-token-0000000003', LIST, 'team-a', from('9.9.9.9'))).status).toBe(429);
    expect(v.calls).toBe(2);
    // Another address is unaffected.
    expect((await send(w, GOOD, LIST, 'team-a', from('8.8.8.8'))).status).toBe(200);
  });

  it('caps new-token validations per instance, whatever the addresses', async () => {
    const { w, v } = await ptWorld(true, limits({ validationsPerMinute: 2 }));
    expect((await send(w, 'wrong-token-0000000001', LIST, 'team-a', from('1.0.0.1'))).status).toBe(401);
    expect((await send(w, 'wrong-token-0000000002', LIST, 'team-a', from('1.0.0.2'))).status).toBe(401);
    const third = await send(w, 'wrong-token-0000000003', LIST, 'team-a', from('1.0.0.3'));
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toBe('30');
    expect(v.calls).toBe(2);
  });

  it('concurrent requests with the same new token share one upstream validation', async () => {
    const base = validator();
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow = Object.assign(base, {
      validate: async (...args: Parameters<CredentialValidator['validate']>) => {
        await gate;
        return validator()
          .validate(...args)
          .finally(() => base.calls++);
      },
    });
    const { w } = await ptWorld(true, {}, slow);
    const pending = [send(w, GOOD), send(w, GOOD), send(w, GOOD)];
    await new Promise((r) => setTimeout(r, 20));
    release();
    expect((await Promise.all(pending)).map((r) => r.status)).toEqual([200, 200, 200]);
    expect(slow.calls).toBe(1);
  });
});

describe('resolvePassthroughAccess', () => {
  const ws = (over: Parameters<typeof workspace>[0] = {}) =>
    workspace({
      credentialSource: 'passthrough',
      enabledTools: ['whoami', 'add_comment', 'close_asset', 'query_assets'],
      writePolicy: { enabled: true },
      ...over,
    });

  it('never grants write tools, even when the workspace enables and lists them', () => {
    const d = resolvePassthroughAccess(
      'team-a',
      { workspace: ws(), instance: instance() },
      'f'.repeat(64),
      SETTINGS,
    );
    expect(d.ok && d.access.tools).toEqual(['whoami', 'query_assets']);
    expect(d.ok && d.access.writeTools).toEqual([]);
    expect(d.ok && d.access.credential.sealed).toBeNull();
    expect(TOOLS.get('add_comment')?.kind).toBe('write');
  });

  it('applies the workspace limits, projects and asset types; denies other workspaces, stored ones and disabled ones', () => {
    const d = resolvePassthroughAccess(
      'team-a',
      {
        workspace: ws({ limits: { maxRows: 7, genericQuery: false }, assetTypes: { deny: ['Request'] } }),
        instance: instance(),
      },
      'a'.repeat(64),
      SETTINGS,
    );
    expect(d.ok && d.access.limits.maxRows).toBe(7);
    expect(d.ok && d.access.tools).toEqual(['whoami']);
    expect(d.ok && d.access.assetTypes).toEqual({ deny: ['Request'] });
    expect(d.ok && d.access.projects.allowed).toEqual(['Scope:1001', 'Scope:1002']);
    const deny = (over: Parameters<typeof workspace>[0], slug = 'team-a') =>
      resolvePassthroughAccess(slug, { workspace: ws(over), instance: instance() }, 'a'.repeat(64), SETTINGS);
    expect(deny({}, 'team-b')).toEqual({ ok: false, reason: 'wrong_workspace' });
    expect(deny({ credentialSource: 'stored' })).toEqual({ ok: false, reason: 'not_passthrough' });
    expect(deny({ disabledAt: 1 })).toEqual({ ok: false, reason: 'workspace_disabled' });
  });
});
