// SPDX-License-Identifier: Apache-2.0
// The query cache over HTTP and its shared tier (P8-01, THREAT_MODEL T16, L-098, L-113): scopes never mix, a denied
// request reaches neither the cache nor Agility, the shared tier holds sealed bodies only and proves itself by reading
// its first write back.
import { generateMasterKey, Keyring } from '@agility-bridge/auth';
import { QueryCache, randomMac, type SharedTier } from '@agility-bridge/core';
import { describe, expect, it } from 'vitest';
import { type CacheLike, DEFAULT_SHARED_ENTRY_CHARS, EdgeQueryTier } from '../src/index.ts';
import { post, world } from './helpers/world.ts';

const WHOAMI = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } };
const GET = (asset: string) => ({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name: 'get_assets', arguments: { assets: [asset] } },
});

const newCache = (now: () => number, shared?: SharedTier) =>
  new QueryCache({
    ttlMs: 30_000,
    mac: randomMac(),
    clock: { now },
    ...(shared === undefined ? {} : { shared }),
  });

describe('query cache over HTTP', () => {
  it('answers a repeated read from memory, and a different grant or workspace asks Agility again', async () => {
    let t = 1_000;
    const cache = newCache(() => t);
    const w = await world({}, { services: { queryCache: cache } });
    const asks = () => w.agilityTokens.length;

    const first = await post(w, 'team-a', w.tokens.alice, GET('B-00001'));
    expect(first.status).toBe(200);
    await first.text();
    const afterFirst = asks();
    expect(afterFirst).toBeGreaterThan(0);

    t += 5_000;
    const again = await post(w, 'team-a', w.tokens.alice, GET('B-00001'));
    expect(await again.text()).toContain('In A');
    expect(asks()).toBe(afterFirst);

    // Same person, another workspace (other grant, other projects): never answered from team A's entry.
    const other = await post(w, 'team-b', w.tokens.aliceB, GET('B-00001'));
    const otherText = await other.text();
    expect(asks()).toBeGreaterThan(afterFirst);
    expect(otherText).not.toContain('In A');

    // After the TTL the entry is gone.
    const before = asks();
    t += 31_000;
    await (await post(w, 'team-a', w.tokens.alice, GET('B-00001'))).text();
    expect(asks()).toBeGreaterThan(before);
  });

  it('never answers a denied request from the cache and reaches neither the cache nor Agility', async () => {
    const cache = newCache(() => 1_000);
    const w = await world({}, { services: { queryCache: cache } });
    await (await post(w, 'team-a', w.tokens.alice, GET('B-00001'))).text();
    const asks = w.agilityTokens.length;
    const size = cache.size;
    const info = cache.info();

    // Bob has no grant in team A: the same body gets the uniform 401, with no data, no upstream call, no lookup.
    const denied = await post(w, 'team-a', w.tokens.bob, GET('B-00001'));
    expect(denied.status).toBe(401);
    expect(await denied.text()).not.toContain('In A');
    // A revoked device token is denied the same way, even though its entries are still cached.
    await w.services.tokens.revoke(w.ids.aliceToken);
    w.app.clearAccessCache();
    const revoked = await post(w, 'team-a', w.tokens.alice, GET('B-00001'));
    expect(revoked.status).toBe(401);
    expect(await revoked.text()).not.toContain('In A');
    expect(w.agilityTokens.length).toBe(asks);
    expect(cache.size).toBe(0);
    expect(size).toBeGreaterThan(0);
    expect(cache.info().hits).toBe(info.hits);
  });

  it('is cleared with the access cache after an admin change', async () => {
    const cache = newCache(() => 1_000);
    const w = await world({}, { services: { queryCache: cache } });
    await (await post(w, 'team-a', w.tokens.alice, GET('B-00001'))).text();
    expect(cache.size).toBeGreaterThan(0);
    w.app.clearAccessCache();
    expect(cache.size).toBe(0);
  });

  it('reports the cache in whoami without counters', async () => {
    const cache = newCache(() => 1_000);
    const w = await world({}, { services: { queryCache: cache } });
    const res = await post(w, 'team-a', w.tokens.alice, WHOAMI);
    const text = await res.text();
    expect(text).toContain('"queryCache"');
    expect(text).toContain('"mode":"memory"');
    expect(text).toContain('"ttlSeconds":30');
    expect(text).not.toContain('"hits"');
    const off = await world();
    expect(await (await post(off, 'team-a', off.tokens.alice, WHOAMI)).text()).not.toContain('"queryCache"');
  });
});

describe('query cache and pass-through callers', () => {
  it('binds the caller own Agility token: two callers of one workspace never share an entry', async () => {
    const validator = {
      validate: async () => ({
        status: 'valid' as const,
        memberOid: 'Member:20',
        memberName: 'Ann',
        memberUsername: null,
        reachableScopeIds: [],
      }),
      probe: async () => ({ ok: true as const, fingerprint: null }),
    };
    const cache = newCache(() => 1_000);
    const w = await world(
      { passthrough: { validator, secure: () => true } },
      { services: { queryCache: cache } },
    );
    await w.storage.workspaces.update(w.ids.workspaceA, { credentialSource: 'passthrough' });
    const as = (token: string) => post(w, 'team-a', null, GET('B-00001'), { 'x-agility-token': token });
    await (await as('1.FirstCallerTokenNotReal000001')).text();
    const afterFirst = w.agilityTokens.length;
    await (await as('1.FirstCallerTokenNotReal000001')).text();
    expect(w.agilityTokens.length).toBe(afterFirst);
    await (await as('1.SecondCallerTokenNotReal00002')).text();
    expect(w.agilityTokens.length).toBeGreaterThan(afterFirst);
    expect(w.agilityTokens.at(-1)).toBe('1.SecondCallerTokenNotReal00002');
  });
});

/** A Cache API stand-in; `noop` models `workers.dev`, where `put` succeeds and nothing is stored. */
function fakeCache(noop = false): CacheLike & { stored: Map<string, string> } {
  const stored = new Map<string, string>();
  return {
    stored,
    async match(request) {
      const body = stored.get(request.url);
      return body === undefined ? undefined : new Response(body);
    },
    async put(request, response) {
      if (!noop) stored.set(request.url, await response.text());
    },
  };
}

describe('EdgeQueryTier', () => {
  const setup = async (cache: CacheLike, clock = { t: 0 }) => {
    const keyring = await Keyring.create(generateMasterKey(1));
    const tier = new EdgeQueryTier({ cache, keyring, clock: { now: () => clock.t }, retryAfterMs: 1_000 });
    return { tier, keyring, clock };
  };

  it('stores sealed bodies only, reads them back and reports verified', async () => {
    const cache = fakeCache();
    const { tier } = await setup(cache);
    expect(tier.status()).toBe('unverified');
    const secret = '{"d":"A synthetic story title that must not appear in the cache"}';
    await tier.set('id1', secret, 30_000);
    expect(tier.status()).toBe('verified');
    expect(await tier.get('id1')).toBe(secret);
    for (const body of cache.stored.values()) {
      expect(body).not.toContain('synthetic');
      expect(body).toContain('ciphertext');
    }
  });

  it('reports unavailable when the cache keeps nothing, and tries again after a pause', async () => {
    const cache = fakeCache(true);
    const { tier, clock } = await setup(cache);
    await tier.set('id1', 'x', 30_000);
    expect(tier.status()).toBe('unavailable');
    expect(await tier.get('id1')).toBeUndefined();
    const working = fakeCache();
    // Still unavailable inside the pause: nothing is written.
    clock.t = 500;
    await tier.set('id2', 'y', 30_000);
    expect(working.stored.size).toBe(0);
    expect(tier.status()).toBe('unavailable');
  });

  it('reports unavailable when put throws', async () => {
    const { tier } = await setup({
      match: async () => undefined,
      put: () => Promise.reject(new Error('no cache here')),
    });
    await tier.set('id1', 'x', 1_000);
    expect(tier.status()).toBe('unavailable');
  });

  it('treats tampered, replayed or foreign-key entries as misses', async () => {
    const cache = fakeCache();
    const { tier } = await setup(cache);
    await tier.set('id1', 'value one', 30_000);
    await tier.set('id2', 'value two', 30_000);
    const [url1, url2] = [...cache.stored.keys()];
    // A sealed body copied to another entry id fails (the id is bound as additional data).
    cache.stored.set(url2 as string, cache.stored.get(url1 as string) as string);
    expect(await tier.get('id2')).toBeUndefined();
    // Tampering fails.
    const sealed = JSON.parse(cache.stored.get(url1 as string) as string) as { ciphertext: string };
    cache.stored.set(
      url1 as string,
      JSON.stringify({
        ...sealed,
        ciphertext: `${sealed.ciphertext.startsWith('A') ? 'B' : 'A'}${sealed.ciphertext.slice(1)}`,
      }),
    );
    expect(await tier.get('id1')).toBeUndefined();
    // Another deployment's key cannot read it.
    const other = await setup(cache);
    expect(await other.tier.get('id2')).toBeUndefined();
    // Garbage is a miss.
    cache.stored.set(url1 as string, 'not json');
    expect(await tier.get('id1')).toBeUndefined();
  });

  it('lets a second isolate answer from the shared tier', async () => {
    const cache = fakeCache();
    const { tier } = await setup(cache);
    const first = newCache(() => 1_000, tier);
    const w1 = await world({}, { services: { queryCache: first } });
    await (await post(w1, 'team-a', w1.tokens.alice, GET('B-00001'))).text();
    expect(tier.status()).toBe('verified');
    expect(cache.stored.size).toBeGreaterThan(0);
    // A second isolate of the same deployment (same entry-id key space needs the same mac), fresh memory.
    const mac = randomMac();
    const a = new QueryCache({ ttlMs: 30_000, mac, clock: { now: () => 1_000 }, shared: tier });
    await a.put('shared-id', 'cached text', true);
    const b = new QueryCache({ ttlMs: 30_000, mac, clock: { now: () => 1_000 }, shared: tier });
    const c = new QueryCache({ ttlMs: 30_000, mac, clock: { now: () => 1_000 }, shared: tier });
    // A caller that may not use the shared tier (write tools) never reads it.
    expect(await c.get('shared-id', false)).toBeUndefined();
    expect(await b.get('shared-id', true)).toBe('cached text');
    expect(b.info().shared).toBe('verified');
  });

  it('skips an entry above its size cap: nothing is sealed or stored, the status is untouched (P8-38)', async () => {
    const cache = fakeCache();
    const { tier } = await setup(cache);
    // The cap is pinned: 64 KiB of characters, an option of the tier.
    expect(DEFAULT_SHARED_ENTRY_CHARS).toBe(65_536);
    expect(tier.maxEntryChars).toBe(65_536);
    await tier.set('big', 'x'.repeat(65_537), 30_000);
    expect(cache.stored.size).toBe(0);
    expect(tier.status()).toBe('unverified');
    await tier.set('edge', 'x'.repeat(65_536), 30_000);
    expect(cache.stored.size).toBe(1);
    expect(tier.status()).toBe('verified');
    // A smaller cap is the operator's option.
    const small = new EdgeQueryTier({
      cache: fakeCache(),
      keyring: await Keyring.create(generateMasterKey(1)),
      clock: { now: () => 0 },
      maxEntryChars: 100,
    });
    await small.set('a', 'y'.repeat(101), 1_000);
    expect(small.status()).toBe('unverified');
    expect(await small.get('a')).toBeUndefined();
  });

  it('keeps a big answer in memory only, never offers it to the tier, and whoami says what the tier takes (P8-38)', async () => {
    const cache = fakeCache();
    const { tier } = await setup(cache);
    const mac = randomMac();
    const qc = new QueryCache({ ttlMs: 30_000, mac, clock: { now: () => 1_000 }, shared: tier });
    await qc.put('big', 'z'.repeat(70_000), true);
    await qc.put('small', 'z'.repeat(100), true);
    expect(await qc.get('big', false)).toHaveLength(70_000);
    expect(cache.stored.size).toBe(1);
    expect(qc.info().sharedMaxEntryChars).toBe(65_536);
    // Through the tool: the cap is configuration, shown next to the tier's proof.
    const w = await world({}, { services: { queryCache: qc } });
    const text = await (await post(w, 'team-a', w.tokens.alice, WHOAMI)).text();
    expect(text).toContain('"sharedMaxEntryChars":65536');
    expect(text).not.toContain('"hits"');
    // A deployment without the tier reports no cap.
    expect(newCache(() => 1).info()).not.toHaveProperty('sharedMaxEntryChars');
  });
});
