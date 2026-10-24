// SPDX-License-Identifier: Apache-2.0
// The small pieces of the OAuth server (P5-01): the provider's KV adapter over the storage `kv` table, the `AB_OAUTH*`
// settings, and what an app without OAuth does with OAuth-shaped requests.
import { createMemoryStorage } from '@agility-bridge/storage';
import { describe, expect, it } from 'vitest';
import {
  OAuthConfigError,
  oauthSettingsFromEnv,
  parseServerSettings,
  SERVER_SETTING_NAMES,
  SettingsError,
} from '../../src/index.ts';
import { oauthKvNamespace } from '../../src/oauth/kv-namespace.ts';
import { connect, post, world } from '../helpers/world.ts';

const T0 = Date.UTC(2026, 9, 24, 12);

describe('the provider KV adapter over the storage kv table', () => {
  const make = () => {
    const clock = { t: T0 };
    const kv = createMemoryStorage({ now: () => clock.t }).kv;
    return { clock, kv, oauth: oauthKvNamespace(kv, () => clock.t) };
  };

  it('keeps every key under oauth: so no other user of the table can collide with it', async () => {
    const { kv, oauth } = make();
    await oauth.put('grant:u:g', '{"a":1}');
    await kv.set('session:u', 'not oauth');
    expect(await kv.get('oauth:grant:u:g')).toBe('{"a":1}');
    expect(await oauth.get('session:u')).toBeNull();
    expect((await oauth.list({ prefix: '' })).keys.map((k) => k.name)).toEqual(['grant:u:g']);
    await oauth.delete('grant:u:g');
    expect(await kv.get('oauth:grant:u:g')).toBeNull();
  });

  it('reads text and json, and refuses anything else', async () => {
    const { oauth } = make();
    await oauth.put('k', '{"x":[1,2]}');
    expect(await oauth.get('k')).toBe('{"x":[1,2]}');
    expect(await oauth.get('k', 'json')).toEqual({ x: [1, 2] });
    expect(await oauth.get('k', { type: 'json' })).toEqual({ x: [1, 2] });
    await expect(oauth.get('k', 'stream' as never)).rejects.toThrow(TypeError);
    await expect(oauth.put('k', 5 as never)).rejects.toThrow(TypeError);
    await expect(oauth.get('')).rejects.toThrow(TypeError);
  });

  it('expires by ttl (seconds from now) and by absolute epoch seconds, on the injected clock', async () => {
    const { clock, oauth } = make();
    await oauth.put('ttl', 'v', { expirationTtl: 60 });
    await oauth.put('abs', 'v', { expiration: (T0 + 120_000) / 1000 });
    await oauth.put('forever', 'v');
    clock.t = T0 + 59_000;
    expect(await oauth.get('ttl')).toBe('v');
    clock.t = T0 + 61_000;
    expect(await oauth.get('ttl')).toBeNull();
    expect(await oauth.get('abs')).toBe('v');
    clock.t = T0 + 121_000;
    expect(await oauth.get('abs')).toBeNull();
    expect(await oauth.get('forever')).toBe('v');
    expect((await oauth.list()).keys.map((k) => k.name)).toEqual(['forever']);
  });

  it('lists a prefix in pages with a cursor that continues where the last page ended', async () => {
    const { oauth } = make();
    for (let i = 0; i < 25; i++) await oauth.put(`grant:u:${String(i).padStart(2, '0')}`, '1');
    await oauth.put('token:x', '1');
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await oauth.list({
        prefix: 'grant:u:',
        limit: 10,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...page.keys.map((k) => k.name));
      cursor = page.list_complete ? undefined : page.cursor;
      pages++;
    } while (cursor !== undefined);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(seen.every((k) => k.startsWith('grant:u:'))).toBe(true);
  });
});

describe('AB_OAUTH settings', () => {
  const PUBLIC = true;

  it('is off by default and for off', () => {
    expect(oauthSettingsFromEnv({}, PUBLIC)).toBeNull();
    expect(oauthSettingsFromEnv({ AB_OAUTH: 'off' }, false)).toBeNull();
    expect(oauthSettingsFromEnv({ AB_OAUTH: '' }, false)).toBeNull();
  });

  it('on needs the public address, which is the issuer', () => {
    expect(oauthSettingsFromEnv({ AB_OAUTH: 'on' }, PUBLIC)).toEqual({});
    expect(() => oauthSettingsFromEnv({ AB_OAUTH: 'on' }, false)).toThrow(/AB_PUBLIC_URL/);
  });

  it('reads durations as seconds or with a unit, within their ranges', () => {
    const on = { AB_OAUTH: 'on' };
    expect(oauthSettingsFromEnv({ ...on, AB_OAUTH_ACCESS_TTL: '3600' }, PUBLIC)).toEqual({
      accessTokenTtlSeconds: 3600,
    });
    expect(
      oauthSettingsFromEnv({ ...on, AB_OAUTH_ACCESS_TTL: '90m', AB_OAUTH_REFRESH_TTL: '30D' }, PUBLIC),
    ).toEqual({
      accessTokenTtlSeconds: 5400,
      refreshTokenTtlSeconds: 2_592_000,
    });
    for (const [name, value] of [
      ['AB_OAUTH_ACCESS_TTL', '59'],
      ['AB_OAUTH_ACCESS_TTL', '25h'],
      ['AB_OAUTH_ACCESS_TTL', '-1'],
      ['AB_OAUTH_ACCESS_TTL', '1.5h'],
      ['AB_OAUTH_ACCESS_TTL', '1 h'],
      ['AB_OAUTH_ACCESS_TTL', '99999999999d'],
      ['AB_OAUTH_REFRESH_TTL', '59m'],
      ['AB_OAUTH_REFRESH_TTL', '366d'],
      ['AB_OAUTH_REFRESH_TTL', 'forever'],
    ] as const) {
      expect(() => oauthSettingsFromEnv({ ...on, [name]: value }, PUBLIC), `${name}=${value}`).toThrow(
        OAuthConfigError,
      );
    }
    expect(() =>
      oauthSettingsFromEnv({ ...on, AB_OAUTH_ACCESS_TTL: '12h', AB_OAUTH_REFRESH_TTL: '2h' }, PUBLIC),
    ).toThrow(/shorter/);
  });

  it('the shared parser names the variable, never the value, and is registered for both hosts', () => {
    const defaults = { callBudget: 1000, maxResponseBytes: 8_388_608 };
    expect(SERVER_SETTING_NAMES).toEqual(
      expect.arrayContaining(['AB_OAUTH', 'AB_OAUTH_ACCESS_TTL', 'AB_OAUTH_REFRESH_TTL']),
    );
    const secretish = 'hunter2-not-a-duration';
    try {
      parseServerSettings({ AB_OAUTH_ACCESS_TTL: secretish }, defaults);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SettingsError);
      expect((error as Error).message).toContain('AB_OAUTH_ACCESS_TTL');
      expect((error as Error).message).not.toContain(secretish);
    }
    // No host has a consent screen yet: on is refused; with one it parses.
    const on = { AB_OAUTH: 'on', AB_PUBLIC_URL: 'https://mcp.example.com' };
    expect(() => parseServerSettings(on, defaults)).toThrow(/consent screen/);
    expect(parseServerSettings(on, defaults, { oauthConsent: true }).oauth).toEqual({});
    expect(parseServerSettings({}, defaults, { oauthConsent: true }).oauth).toBeUndefined();
  });
});

describe('an app without OAuth', () => {
  it('has no OAuth routes, and an OAuth-shaped bearer is just a malformed token', async () => {
    const w = await world();
    for (const [method, path] of [
      ['GET', '/.well-known/oauth-authorization-server'],
      ['GET', '/.well-known/oauth-protected-resource/w/team-a/mcp'],
      ['GET', '/.well-known/oauth-protected-resource'],
      ['GET', '/oauth/authorize'],
      ['POST', '/oauth/token'],
      ['POST', '/oauth/register'],
    ] as const) {
      const res = await w.app.fetch(new Request(`http://127.0.0.1:8787${path}`, { method }));
      expect(res.status, path).toBe(404);
    }
    const lookalike = `usr_${'a'.repeat(32)}:${'B'.repeat(16)}:${'c'.repeat(32)}`;
    const res = await post(w, 'team-a', lookalike, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    // OAuth off: the plain challenge, no metadata to point at (P5-02).
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(w.requests.at(-1)?.refusal).toBe('token_malformed');
    // Device tokens are unchanged.
    const client = await connect(w, 'team-a', w.tokens.alice);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await client.close();
  });

  it('refuses to build the OAuth routes without a public URL: the issuer must be configured, not guessed', async () => {
    await expect(world({ oauth: { consent: async () => new Response(null) } })).rejects.toThrow(/publicUrl/);
  });
});

describe('the protected resource metadata route (P5-02)', () => {
  it('is limited per IP before any work, like the other unauthenticated OAuth routes', async () => {
    let calls = 0;
    const w = await world({
      oauth: { consent: async () => new Response(null) },
      publicUrl: 'http://127.0.0.1:8787',
      limits: {
        beforeAuth: async () => {
          calls += 1;
          return calls > 2 ? { ok: false, retryAfterSeconds: 30 } : { ok: true };
        },
      },
    });
    const get = () =>
      w.app.fetch(new Request('http://127.0.0.1:8787/.well-known/oauth-protected-resource/w/team-a/mcp'));
    expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(200);
    const limited = await get();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('30');
    expect(JSON.stringify(await limited.json())).not.toContain('authorization_servers');
  });
});
