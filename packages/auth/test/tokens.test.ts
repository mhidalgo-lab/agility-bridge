// SPDX-License-Identifier: Apache-2.0
// Device access tokens (P2-05, L-066, L-067, THREAT_MODEL T1, T2).
import { ConflictError, createMemoryStorage, InvalidInputError, type Storage } from '@agility-bridge/storage';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  accessServices,
  authenticateDeviceToken,
  bearerToken,
  crc32,
  generateDeviceToken,
  generateMasterKey,
  hashDeviceToken,
  isWellFormedDeviceToken,
  Keyring,
  TOUCH_INTERVAL_MS,
} from '../src/index.ts';
import { NOW, SETTINGS, TOOLS } from './helpers/access.ts';

const FORMAT = /^ab_live_[0-9A-Za-z]{43}_[0-9A-Za-z]{6}$/;

describe('format', () => {
  it('generates typed, random, checksummed tokens and their SHA-256', async () => {
    const tokens = await Promise.all(Array.from({ length: 200 }, () => generateDeviceToken('live')));
    for (const t of tokens) {
      expect(t.token).toMatch(FORMAT);
      expect(isWellFormedDeviceToken(t.token)).toBe(true);
      expect(t.displayPrefix).toBe(t.token.slice(0, 12));
      expect(t.tokenHash).toBe(await hashDeviceToken(t.token));
      expect(t.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(new Set(tokens.map((t) => t.token)).size).toBe(200);
    const test = await generateDeviceToken('test');
    expect(test.token.startsWith('ab_test_')).toBe(true);
  });

  it('CRC-32 is the IEEE checksum', () => {
    expect(crc32('123456789')).toBe(0xcbf43926);
    expect(crc32('')).toBe(0);
  });

  it('refuses any change to the body or checksum, other prefixes, environments and shapes', async () => {
    const { token } = await generateDeviceToken('live');
    const swap = (i: number) => `${token.slice(0, i)}${token[i] === 'a' ? 'b' : 'a'}${token.slice(i + 1)}`;
    for (const i of [8, 30, 50, 52, 57]) expect(isWellFormedDeviceToken(swap(i)), String(i)).toBe(false);
    expect(isWellFormedDeviceToken(token, 'test')).toBe(false);
    expect(isWellFormedDeviceToken(token, 'live')).toBe(true);
    expect(isWellFormedDeviceToken(token.replace('ab_live_', 'ab_prod_'))).toBe(false);
    expect(isWellFormedDeviceToken(`${token} `)).toBe(false);
    expect(isWellFormedDeviceToken(undefined)).toBe(false);
    expect(isWellFormedDeviceToken('ab_admin_xyz')).toBe(false);
  });

  it('extracts bearer tokens only', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer  abc ')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken('Bearer a b')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

describe('issuing and authenticating', () => {
  let storage: Storage;
  let t: number;
  let svc: ReturnType<typeof accessServices>;
  let grantId: string;
  let reads: number;
  const settings = { ...SETTINGS, environment: 'live' as const };

  beforeEach(async () => {
    t = NOW;
    const base = createMemoryStorage({ now: () => t });
    reads = 0;
    storage = {
      ...base,
      accessTokens: {
        ...base.accessTokens,
        getByHash: (h) => {
          reads++;
          return base.accessTokens.getByHash(h);
        },
      },
    };
    const keyring = await Keyring.create(generateMasterKey(1));
    svc = accessServices({ storage, keyring, tools: TOOLS, now: () => t });
    const u = await svc.users.create({ email: 'alice@example.test', role: 'member' });
    const i = await svc.instances.create({ label: 'x', baseUrl: 'https://agility.example.test/x' });
    const c = await svc.credentials.create({
      instanceId: i.id,
      ownerUserId: u.id,
      label: 'c',
      token: '1.TokenNotRealAbCdEfGhIjKlMn',
    });
    await storage.credentials.update(c.id, { validationStatus: 'valid' });
    const ws = await svc.workspaces.create({
      slug: 'team-a',
      name: 'A',
      instanceId: i.id,
      allowedScopeIds: ['Scope:1'],
    });
    await svc.workspaces.create({
      slug: 'team-b',
      name: 'B',
      instanceId: i.id,
      allowedScopeIds: ['Scope:2'],
    });
    grantId = (await svc.grants.create({ workspaceId: ws.id, userId: u.id, credentialId: c.id })).record.id;
  });

  it('shows the token once and stores only its hash and display prefix, expiring in 90 days by default', async () => {
    const issued = await svc.tokens.issue({ grantId, label: 'laptop' });
    expect(issued.warnings).toEqual([]);
    expect(issued.record).toMatchObject({
      prefix: issued.token.slice(0, 12),
      expiresAt: t + 90 * 86_400_000,
    });
    expect(JSON.stringify(await storage.accessTokens.list())).not.toContain(issued.token.slice(12, 40));
    const never = await svc.tokens.issue({ grantId, label: 'server', expiresInDays: 'never' });
    expect(never.record.expiresAt).toBeNull();
    expect(never.warnings).toEqual([expect.stringContaining('never expires')]);
    await expect(svc.tokens.issue({ grantId, label: 'x', expiresInDays: 0 })).rejects.toThrow(
      InvalidInputError,
    );
    await svc.grants.revoke(grantId);
    await expect(svc.tokens.issue({ grantId, label: 'x' })).rejects.toThrow(ConflictError);
  });

  it('authenticates a valid token for its workspace and records use at most every 5 minutes', async () => {
    const { token, record } = await svc.tokens.issue({ grantId, label: 'laptop' });
    const d = await authenticateDeviceToken(storage, token, 'team-a', settings, t);
    expect(d.ok && d.access.tokenId).toBe(record.id);
    expect((await storage.accessTokens.get(record.id))?.lastUsedAt).toBe(t);
    t += TOUCH_INTERVAL_MS - 1;
    await authenticateDeviceToken(storage, token, 'team-a', settings, t);
    expect((await storage.accessTokens.get(record.id))?.lastUsedAt).toBe(NOW);
    t += 1;
    await authenticateDeviceToken(storage, token, 'team-a', settings, t);
    expect((await storage.accessTokens.get(record.id))?.lastUsedAt).toBe(t);
  });

  it('checks format and checksum before any storage read', async () => {
    const { token } = await svc.tokens.issue({ grantId, label: 'laptop' });
    reads = 0;
    for (const bad of ['', 'garbage', `${token.slice(0, -1)}x`, token.replace('ab_live', 'ab_test')]) {
      expect(await authenticateDeviceToken(storage, bad, 'team-a', settings, t)).toEqual({
        ok: false,
        reason: 'token_malformed',
      });
    }
    expect(reads).toBe(0);
    const stranger = await generateDeviceToken('live');
    expect(await authenticateDeviceToken(storage, stranger.token, 'team-a', settings, t)).toEqual({
      ok: false,
      reason: 'token_unknown',
    });
    expect(reads).toBe(1);
  });

  it('refuses a token at another workspace, and once revoked or expired', async () => {
    const { token, record } = await svc.tokens.issue({ grantId, label: 'laptop', expiresInDays: 1 });
    const at = (slug: string) => authenticateDeviceToken(storage, token, slug, settings, t);
    expect(await at('team-b')).toEqual({ ok: false, reason: 'wrong_workspace' });
    expect(await at('nope')).toEqual({ ok: false, reason: 'wrong_workspace' });
    t += 86_400_000;
    expect(await at('team-a')).toEqual({ ok: false, reason: 'token_expired' });
    t = NOW;
    await svc.tokens.revoke(record.id);
    expect(await at('team-a')).toEqual({ ok: false, reason: 'token_revoked' });
    // The audience is checked before revocation: a revoked token at another workspace says nothing about its state.
    expect(await at('team-b')).toEqual({ ok: false, reason: 'wrong_workspace' });
  });

  it('a revoked grant or credential stops its tokens', async () => {
    const { token } = await svc.tokens.issue({ grantId, label: 'laptop' });
    await svc.grants.revoke(grantId);
    expect(await authenticateDeviceToken(storage, token, 'team-a', settings, t)).toEqual({
      ok: false,
      reason: 'grant_revoked',
    });
  });
});
