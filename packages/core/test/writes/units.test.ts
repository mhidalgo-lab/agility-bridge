// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  type AbError,
  ApprovalLedger,
  type CanonicalMutation,
  canonicalize,
  memoryLedgerStore,
  mutationHash,
  openState,
  sealState,
  supportsFormElicitation,
  valuesEqual,
} from '../../src/index.ts';

const allowed = { Story: ['Status', 'Name', 'Owners'] };
const base = (over: Partial<CanonicalMutation> = {}): CanonicalMutation => ({
  operation: 'update_fields',
  target: { assetType: 'Story', oid: 'Story:1', number: 'B-00001' },
  changes: [{ field: 'Status', old: 'A', new: 'B' }],
  ...over,
});

describe('canonicalize', () => {
  it('sorts the changes, freezes the result and keeps one target', () => {
    const m = canonicalize(
      base({
        changes: [
          { field: 'Status', old: 'A', new: 'B' },
          { field: 'Name', old: 'x', new: 'y' },
        ],
      }),
      allowed,
    );
    expect(m.changes.map((c) => c.field)).toEqual(['Name', 'Status']);
    expect(Object.isFrozen(m)).toBe(true);
  });

  it.each([
    ['an unknown asset type', base({ target: { assetType: 'Epic', oid: 'Epic:1' } })],
    ['an OID of another type', base({ target: { assetType: 'Story', oid: 'Defect:1' } })],
    ['a malformed OID', base({ target: { assetType: 'Story', oid: 'Story:abc' } })],
    ['no change', base({ changes: [] })],
    ['a field outside the allowlist', base({ changes: [{ field: 'Estimate', old: 1, new: 2 }] })],
    [
      'a field twice',
      base({
        changes: [
          { field: 'Name', old: 'a', new: 'b' },
          { field: 'Name', old: 'a', new: 'c' },
        ],
      }),
    ],
    ['a bad number', base({ target: { assetType: 'Story', oid: 'Story:1', number: 'nope' } })],
  ])('refuses %s as a tool bug (AB_INTERNAL)', (_n, m) => {
    try {
      canonicalize(m, allowed);
      throw new Error('should refuse');
    } catch (e) {
      expect((e as AbError).code).toBe('AB_INTERNAL');
    }
  });

  it('refuses unsupported value types, non-finite numbers and long lists as input errors', () => {
    for (const v of [{ a: 1 }, Number.NaN, Array.from({ length: 51 }, () => 'x'), [1, 2]]) {
      try {
        canonicalize(base({ changes: [{ field: 'Owners', old: null, new: v as never }] }), allowed);
        throw new Error('should refuse');
      } catch (e) {
        expect((e as AbError).code).toBe('AB_INPUT_INVALID');
      }
    }
  });
});

describe('mutationHash', () => {
  const m = canonicalize(base(), allowed);
  it('is stable and binds tool, actor, target, field, old and new', async () => {
    const h = await mutationHash('t', 'u', m);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await mutationHash('t', 'u', m)).toBe(h);
    expect(await mutationHash('t2', 'u', m)).not.toBe(h);
    expect(await mutationHash('t', 'u2', m)).not.toBe(h);
    const other = (over: Partial<CanonicalMutation>) =>
      mutationHash('t', 'u', canonicalize(base(over), allowed));
    expect(await other({ target: { assetType: 'Story', oid: 'Story:2' } })).not.toBe(h);
    expect(await other({ changes: [{ field: 'Status', old: 'A', new: 'C' }] })).not.toBe(h);
    expect(await other({ changes: [{ field: 'Status', old: 'Z', new: 'B' }] })).not.toBe(h);
    expect(await other({ operation: 'other' })).not.toBe(h);
    // Display-only data is not bound.
    expect(await other({ target: { assetType: 'Story', oid: 'Story:1' } })).toBe(h);
  });
});

describe('valuesEqual', () => {
  it('compares scalars and lists', () => {
    expect(valuesEqual('a', 'a')).toBe(true);
    expect(valuesEqual(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(valuesEqual(['a'], ['a', 'b'])).toBe(false);
    expect(valuesEqual(null, 'null')).toBe(false);
    expect(valuesEqual(1, '1')).toBe(false);
  });
});

describe('sealed approval state', () => {
  const key = new Uint8Array(32).fill(3);
  const state = { n: 'nonce', h: 'hash', a: 'actor', e: 123, w: 'ws', i: 'inst' };
  it('round-trips and rejects any change, another key and a short key', async () => {
    const sealed = await sealState(key, state);
    expect(await openState(key, sealed)).toEqual(state);
    expect(await openState(new Uint8Array(32).fill(4), sealed)).toBeNull();
    expect(await openState(key, `${sealed}x`)).toBeNull();
    expect(await openState(key, sealed.replace('.', 'A.'))).toBeNull();
    expect(await openState(key, 'a.b.c')).toBeNull();
    expect(await openState(new Uint8Array(8), sealed)).toBeNull();
    await expect(sealState(new Uint8Array(8), state)).rejects.toThrow(/32 bytes/);
  });
});

describe('ApprovalLedger', () => {
  it('hands each entry out once, only while it is live, and never across keys', async () => {
    let now = 1_000;
    const clock = { now: () => now };
    const ledger = new ApprovalLedger(memoryLedgerStore(clock), clock);
    const entry = { hash: 'h', actor: 'u', tool: 't', expiresAt: 2_000 };
    await ledger.openRound('n1', entry);
    expect(await ledger.takeRound('n2')).toBeNull();
    expect(await ledger.takeRound('n1')).toEqual(entry);
    expect(await ledger.takeRound('n1')).toBeNull();
    await ledger.grant(entry);
    expect(await ledger.takeGrant('other', 'h')).toBeNull();
    expect(await ledger.takeGrant('u', 'h2')).toBeNull();
    // A round and a grant never answer for each other.
    expect(await ledger.takeRound('h')).toBeNull();
    expect(await ledger.takeGrant('u', 'h')).toEqual(entry);
    expect(await ledger.takeGrant('u', 'h')).toBeNull();
    await ledger.grant(entry);
    now = 2_000;
    expect(await ledger.takeGrant('u', 'h')).toBeNull();
  });

  it('refuses a value that is not a ledger entry', async () => {
    const clock = { now: () => 0 };
    const store = memoryLedgerStore(clock);
    const ledger = new ApprovalLedger(store, clock);
    await store.set('wr:round:x', '{"hash":1}');
    expect(await ledger.takeRound('x')).toBeNull();
    await store.set('wr:round:y', 'not json');
    expect(await ledger.takeRound('y')).toBeNull();
  });

  it('keeps the in-memory store bounded', async () => {
    const clock = { now: () => 0 };
    const store = memoryLedgerStore(clock, 3);
    for (let i = 0; i < 10; i++) await store.set(`k${i}`, 'v', { expiresAt: 10 });
    expect(await store.take('k0')).toBeNull();
    expect(await store.take('k9')).toBe('v');
  });
});

describe('supportsFormElicitation', () => {
  it('accepts {} and { form } and refuses URL-only and none', () => {
    expect(supportsFormElicitation({ elicitation: {} })).toBe(true);
    expect(supportsFormElicitation({ elicitation: { form: {} } })).toBe(true);
    expect(supportsFormElicitation({ elicitation: { url: {} } })).toBe(false);
    expect(supportsFormElicitation({})).toBe(false);
    expect(supportsFormElicitation(undefined)).toBe(false);
  });
});
