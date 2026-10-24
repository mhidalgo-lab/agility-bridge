// SPDX-License-Identifier: Apache-2.0
// DNS rebinding against the client metadata fetch (P5-03, T11, L-088): the address the connection uses is the one the
// connect-time lookup returned, and the lookup refuses a name when ANY of its answers is non-public. The resolver is
// replaced, so nothing here reaches the network; a "public" answer is never connected to (the test ends at the refusal
// or at the lookup's own result).
import type { LookupAddress } from 'node:dns';
import { afterEach, describe, expect, it, vi } from 'vitest';

const answers = vi.hoisted(() => ({ next: [] as { address: string; family: number }[] }));
vi.mock('node:dns', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:dns')>();
  return {
    ...real,
    lookup: (_host: string, _options: unknown, callback: (e: Error | null, a: unknown) => void) =>
      queueMicrotask(() => callback(null, answers.next)),
  };
});

const { publicOnlyLookup, PrivateAddressError } = await import('../src/agility-fetch.ts');

afterEach(() => {
  answers.next = [];
});

const resolve = (name = 'client.example.org') =>
  new Promise<LookupAddress[] | Error>((done) => {
    publicOnlyLookup(name, { all: true }, (error, address) => done(error ?? (address as LookupAddress[])));
  });

describe('publicOnlyLookup', () => {
  it('answers a name whose every address is public', async () => {
    answers.next = [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ];
    expect(await resolve()).toEqual(answers.next);
  });

  it.each([
    ['one private address among public ones (a rebinding trick)', ['93.184.216.34', '10.0.0.7']],
    ['only loopback', ['127.0.0.1']],
    ['the metadata address', ['169.254.169.254']],
    ['an IPv4-mapped private address', ['::ffff:192.168.0.1']],
    ['a unique-local IPv6 among a public one', ['2606:2800:220:1:248:1893:25c8:1946', 'fd12::1']],
    ['no address at all', []],
  ])('refuses %s', async (_label, addresses) => {
    answers.next = addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    const result = await resolve();
    expect(result).toBeInstanceOf(Error);
    expect(result).toBeInstanceOf(PrivateAddressError);
    expect((result as Error).message).toMatch(/non-public address/);
    // The message names the host, never an address it resolved to.
    expect((result as Error).message).not.toMatch(/10\.0\.0\.7|169\.254|192\.168/);
  });

  it('judges each lookup on its own answer: a name that changes its answer is refused the moment it does', async () => {
    answers.next = [{ address: '93.184.216.34', family: 4 }];
    expect(await resolve('rebind.example.org')).toEqual(answers.next);
    answers.next = [{ address: '127.0.0.1', family: 4 }];
    expect(await resolve('rebind.example.org')).toBeInstanceOf(PrivateAddressError);
  });
});
