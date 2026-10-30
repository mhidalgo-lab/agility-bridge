// SPDX-License-Identifier: Apache-2.0
// The kept answers of the public catalogue (P8-35): the id is substituted only where it can be shown to be the message's
// own, and the table is bounded.
import { describe, expect, it } from 'vitest';
import { createPublicAnswerCache } from '../src/public-catalog-cache.ts';

const noHeaders = () => undefined;
const msg = (id: unknown, method = 'tools/list') => ({ jsonrpc: '2.0', id, method, params: {} });
const answer = (id: unknown, extra = '') =>
  JSON.stringify({ result: { tools: [], extra }, jsonrpc: '2.0', id });
const sse = (body: string) => `event: message\ndata: ${body}\n\n`;

describe('createPublicAnswerCache', () => {
  it('substitutes the id in a JSON body and in an event stream, and drops the original length header', async () => {
    const cache = createPublicAnswerCache();
    const key = cache.keyFor(msg(1), noHeaders) as string;
    for (const wrap of [(b: string) => b, sse]) {
      const k = `${key}${wrap === sse ? 's' : 'j'}`;
      const headers = new Headers({ 'content-length': '10', 'x-a': 'b' });
      expect(cache.remember(k, 1, 200, headers, wrap(answer(1)))).toBe(true);
      const res = cache.serve(k, 'a"b') as Response;
      expect(await res.text()).toBe(wrap(answer('a"b')));
      expect(res.headers.get('content-length')).toBeNull();
      expect(res.headers.get('x-a')).toBe('b');
    }
  });

  it('keeps nothing when the id cannot be shown to be the message id, or the answer is not a 200', () => {
    const cache = createPublicAnswerCache();
    // The id's text appears twice (the tool list happens to contain it).
    expect(cache.remember('k1', 1, 200, new Headers(), '{"result":{"id":1},"jsonrpc":"2.0","id":1}')).toBe(
      false,
    );
    expect(cache.remember('k2', 1, 200, new Headers(), '{"result":{}}')).toBe(false);
    expect(cache.remember('k3', 1, 200, new Headers(), 'not json "id":1')).toBe(false);
    expect(cache.remember('k4', 1, 400, new Headers(), answer(1))).toBe(false);
    expect(cache.remember('k5', 1, 200, new Headers(), answer(1, 'x'.repeat(200_000)))).toBe(false);
    expect(cache.size).toBe(0);
  });

  it('keys on the method, the framing headers and the parameters, and only for three methods with a usable id', () => {
    const cache = createPublicAnswerCache();
    const k = (m: unknown, h: Record<string, string> = {}) => cache.keyFor(m, (n) => h[n]);
    expect(k(msg(1))).toBeDefined();
    expect(k(msg(1))).toBe(k(msg(2)));
    expect(k(msg(1))).not.toBe(k(msg(1, 'initialize')));
    expect(k(msg(1))).not.toBe(k(msg(1), { accept: 'application/json' }));
    expect(k(msg(1))).not.toBe(k(msg(1), { 'mcp-protocol-version': '2026-07-28' }));
    expect(k({ ...msg(1), params: { cursor: 'x' } })).not.toBe(k(msg(1)));
    const bad = [
      msg(1, 'ping'),
      msg(null),
      msg({}),
      msg(Number.NaN),
      [msg(1)],
      null,
      'x',
      { ...msg(1), params: { a: 'x'.repeat(3000) } },
    ];
    for (const b of bad) expect(k(b), JSON.stringify(b)?.slice(0, 40)).toBeUndefined();
  });

  it('holds at most a few entries, dropping the oldest', () => {
    const cache = createPublicAnswerCache();
    for (let i = 0; i < 40; i++) cache.remember(`k${i}`, 1, 200, new Headers(), answer(1));
    expect(cache.size).toBe(16);
    expect(cache.serve('k0', 1)).toBeUndefined();
    expect(cache.serve('k39', 1)).toBeDefined();
  });
});
