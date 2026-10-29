// SPDX-License-Identifier: Apache-2.0
// The write limiter (P7-03, ADR-0013, L-080/L-081/L-111): counting, failing closed, and what a refusal leaves behind
// in the pipeline (no re-read, no send, no intent audit).
import { describe, expect, it } from 'vitest';
import {
  type AbError,
  type CounterStore,
  createWriteLimiter,
  ErrorCode,
  memoryCounterStore,
  type WriteLimiter,
} from '../../src/index.ts';
import { type LimiterWorld, writeLimiterContract } from '../helpers/write-limiter-contract.ts';
import {
  answeringChannel,
  FakeItems,
  makeRuntime,
  makeTestWriteTool,
  TEST_TOOL,
  writeContext,
} from '../helpers/writes.ts';

writeLimiterContract('process memory', async () => {
  let t = 1_760_000_000_000;
  const clock = { now: () => t };
  return {
    counters: memoryCounterStore(clock),
    advance: (ms) => (t += ms),
    now: clock.now,
  } satisfies LimiterWorld;
});

const info = { tool: TEST_TOOL, requestId: 'r', actor: { id: 'u', grantId: 'g' } };
const clock = { now: () => 1_760_000_000_000 };

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as AbError).code;
  }
}

describe('the limiter is required by the type (L8)', () => {
  it('a runtime without one does not compile', () => {
    // @ts-expect-error a WriteRuntime needs a limiter: a host that forgets it must not write unlimited
    const missing: import('../../src/index.ts').WriteRuntime = {
      approval: 'required',
      tools: [],
      actor: { id: 'u' },
      ledger: makeRuntime().ledger,
      audit: makeRuntime().audit,
      stateKey: new Uint8Array(32),
    };
    expect(missing.limiter).toBeUndefined();
  });
});

describe('fails closed (L-080)', () => {
  it('refuses when the counter store throws', async () => {
    const errors: unknown[] = [];
    const counters: CounterStore = {
      increment: () => Promise.reject(new Error('database is down')),
      get: async () => null,
    };
    const l = createWriteLimiter({ counters, clock, onError: (e) => errors.push(e) });
    expect(await codeOf(l.check(info))).toBe(ErrorCode.WriteLimitUnavailable);
    expect(errors).toHaveLength(1);
  });

  it.each([0, -1, 1.5, Number.NaN, 21, '3' as unknown as number])(
    'refuses a counter answering %s',
    async (v) => {
      const l = createWriteLimiter({ counters: { increment: async () => v, get: async () => null }, clock });
      expect(await codeOf(l.check(info))).toBe(ErrorCode.WriteLimitUnavailable);
    },
  );

  it('does not leak the cause text to the agent', async () => {
    const l = createWriteLimiter({
      counters: {
        increment: () => Promise.reject(new Error('secret-host.internal:5432')),
        get: async () => null,
      },
      clock,
    });
    const e = await l.check(info).catch((x: AbError) => x);
    expect(JSON.stringify({ m: (e as AbError).message, h: (e as AbError).hint })).not.toContain(
      'secret-host',
    );
  });
});

describe('a refused check spends nothing (D-170, P7-09)', () => {
  it('a full deployment does not consume the grant unit', async () => {
    const counters = memoryCounterStore(clock);
    const l = createWriteLimiter({ counters, clock, limits: { perGrant: 2, deployment: 1 } });
    await l.check({ ...info, actor: { id: 'a', grantId: 'g-a' } });
    // The deployment is now full: every other grant is refused, and none of them spends its own unit.
    for (let i = 0; i < 5; i++) {
      const e = await l.check({ ...info, actor: { id: 'b', grantId: 'g-b' } }).catch((x: AbError) => x);
      expect((e as AbError).code).toBe(ErrorCode.LimitRate);
      expect((e as AbError).details).toMatchObject({ scope: 'deployment' });
    }
    const window = Math.floor(clock.now() / 3_600_000);
    expect(await counters.get(`wl:g:g-b:${window}`)).toBeNull();
    expect(await counters.get(`wl:g:g-a:${window}`)).toBe('1');
  });

  it('fails closed when the deployment counter cannot be read or is not a count', async () => {
    for (const get of [() => Promise.reject(new Error('down')), async () => 'abc', async () => '-3']) {
      const l = createWriteLimiter({
        counters: { increment: async () => 1, get },
        clock,
      });
      expect(await codeOf(l.check(info))).toBe(ErrorCode.WriteLimitUnavailable);
    }
  });
});

describe('refusal details', () => {
  it('names the scope, the limit and the wait; the message says nothing was changed', async () => {
    const l = createWriteLimiter({
      counters: memoryCounterStore(clock),
      clock,
      limits: { perGrant: 1, deployment: null },
    });
    await l.check(info);
    const e = (await l.check(info).catch((x: AbError) => x)) as AbError;
    expect(e.code).toBe(ErrorCode.LimitRate);
    expect(e.details).toMatchObject({ scope: 'grant', limit: 1 });
    expect(e.message).toContain('Nothing was changed');
  });

  it('counts a service grant and a user grant separately by grant id', async () => {
    const l = createWriteLimiter({
      counters: memoryCounterStore(clock),
      clock,
      limits: { perGrant: 1, deployment: null },
    });
    await l.check({ ...info, actor: { id: 'same-user', grantId: 'g1' } });
    expect(await codeOf(l.check({ ...info, actor: { id: 'same-user', grantId: 'g2' } }))).toBe('ok');
  });
});

describe('in the pipeline: a refused write leaves nothing behind', () => {
  const CONFIRMED = { item: 'B-00001', status: 'Done', confirm: true };

  async function setup(limiter: WriteLimiter) {
    const fake = new FakeItems();
    const tool = makeTestWriteTool(fake);
    const runtime = makeRuntime({ channel: answeringChannel(true), limiter });
    const ctx = writeContext(runtime);
    const call = () => tool.handler(tool.inputSchema.parse(CONFIRMED), ctx);
    return { fake, runtime, call };
  }

  it('over the limit: no re-read, no send, no intent audit', async () => {
    const { fake, runtime, call } = await setup(
      createWriteLimiter({
        counters: memoryCounterStore(clock),
        clock,
        limits: { perGrant: 1, deployment: null },
      }),
    );
    // The first call spends the unit but is a no-op only after it applied; use a second item state to force a second write.
    await call();
    expect(fake.sends).toHaveLength(1);
    const item = fake.items.get('Story:1');
    if (item !== undefined) item.status = 'In Progress';
    const readsBefore = fake.reads;
    const auditBefore = runtime.audit.records.length;
    expect(await codeOf(call())).toBe(ErrorCode.LimitRate);
    // Only the plan's own read happened; the re-read and the send did not.
    expect(fake.reads - readsBefore).toBe(1);
    expect(fake.sends).toHaveLength(1);
    expect(runtime.audit.records).toHaveLength(auditBefore);
  });

  it('limiter outage: refused, no send, no intent audit', async () => {
    const { fake, runtime, call } = await setup(
      createWriteLimiter({
        counters: { increment: () => Promise.reject(new Error('down')), get: async () => null },
        clock,
      }),
    );
    expect(await codeOf(call())).toBe(ErrorCode.WriteLimitUnavailable);
    expect(fake.sends).toHaveLength(0);
    expect(runtime.audit.records).toHaveLength(0);
  });
});
