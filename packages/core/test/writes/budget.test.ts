// SPDX-License-Identifier: Apache-2.0
// The write budget a caller and an owner can read without taking a unit (P7-16, THREAT_MODEL T31, L-080): the count after
// N writes, a new window, a failing store (unknown, never unlimited), the grant's own cap, what a caller is told about the
// deployment, and `whoami` and the dry run that show it.
import { describe, expect, it } from 'vitest';
import {
  AbError,
  buildMcpServer,
  type CounterStore,
  callerView,
  createBudget,
  createWriteLimiter,
  ErrorCode,
  MetadataService,
  memoryCounterStore,
  type ToolContext,
  type ToolDefinition,
  WRITE_LIMIT_WINDOW_MS,
  type WriteBudget,
  type WriteLimiter,
} from '../../src/index.ts';
import { whoami } from '../../src/tools/core/whoami.ts';
import snapshotJson from '../fixtures/agility/meta-snapshot.json' with { type: 'json' };
import { FakeAgility, makeContext } from '../harness/index.ts';
import { rpc } from '../helpers/mcp.ts';
import { FakeItems, makeRuntime, makeTestWriteTool, writeContext } from '../helpers/writes.ts';

const T0 = 1_760_000_000_000;
const actor = (id: string) => ({ id: `user-${id}`, grantId: id });

function limiterOver(
  counters: CounterStore,
  t: { now: number },
  perGrant = 3,
  deployment: number | null = 5,
) {
  return createWriteLimiter({ counters, clock: { now: () => t.now }, limits: { perGrant, deployment } });
}
const budgetOf = async (l: WriteLimiter, id: string, grantLimit?: number): Promise<WriteBudget> =>
  (l.budget as NonNullable<WriteLimiter['budget']>)({
    actor: actor(id),
    ...(grantLimit === undefined ? {} : { grantLimit }),
  });

describe('limiter.budget', () => {
  it('counts the writes of this hour, takes nothing by reading, and starts again in the next window', async () => {
    const t = { now: T0 };
    const l = limiterOver(memoryCounterStore({ now: () => t.now }), t);
    const info = { tool: 't', requestId: 'r', actor: actor('g1') };
    expect(await budgetOf(l, 'g1')).toMatchObject({
      status: 'ok',
      grant: { limit: 3, used: 0, remaining: 3 },
      deployment: { limit: 5, used: 0, remaining: 5 },
    });
    await l.check(info);
    await l.check(info);
    // Reading any number of times spends nothing: the third write is still admitted and the fourth is refused.
    for (let i = 0; i < 5; i++) await budgetOf(l, 'g1');
    expect(await budgetOf(l, 'g1')).toMatchObject({
      grant: { limit: 3, used: 2, remaining: 1 },
      deployment: { used: 2, remaining: 3 },
    });
    await l.check(info);
    await expect(l.check(info)).rejects.toMatchObject({ code: ErrorCode.LimitRate });
    expect(await budgetOf(l, 'g1')).toMatchObject({ grant: { used: 3, remaining: 0 } });
    // Another grant's use is not in this grant's count, but the deployment's is.
    expect(await budgetOf(l, 'g2')).toMatchObject({
      grant: { used: 0, remaining: 3 },
      deployment: { used: 3, remaining: 2 },
    });
    // A new window.
    t.now += WRITE_LIMIT_WINDOW_MS;
    const next = await budgetOf(l, 'g1');
    expect(next).toMatchObject({ grant: { used: 0, remaining: 3 }, deployment: { used: 0 } });
    expect(next.status === 'ok' ? next.windowEndsAt : 0).toBe(
      (Math.floor((T0 + WRITE_LIMIT_WINDOW_MS) / WRITE_LIMIT_WINDOW_MS) + 1) * WRITE_LIMIT_WINDOW_MS,
    );
  });

  it("uses the grant's own cap when it is lower and never raises the limit", async () => {
    const t = { now: T0 };
    const l = limiterOver(memoryCounterStore({ now: () => t.now }), t, 3, null);
    expect(await budgetOf(l, 'g', 1)).toMatchObject({ grant: { limit: 1, remaining: 1 }, deployment: null });
    expect(await budgetOf(l, 'g', 50)).toMatchObject({ grant: { limit: 3 } });
    expect(await budgetOf(l, 'g', 0)).toMatchObject({ grant: { limit: 3 } });
  });

  it('a lowered limit below what was used shows zero left, not a negative', async () => {
    const t = { now: T0 };
    const counters = memoryCounterStore({ now: () => t.now });
    const l = limiterOver(counters, t, 5, null);
    for (let i = 0; i < 4; i++) await l.check({ tool: 't', requestId: 'r', actor: actor('g') });
    expect(await budgetOf(l, 'g', 2)).toMatchObject({ grant: { limit: 2, used: 4, remaining: 0 } });
  });

  it('is unknown, never unlimited, when the store fails or holds something that is not a count; a write still fails closed', async () => {
    const t = { now: T0 };
    const errors: unknown[] = [];
    const broken: CounterStore = {
      get: async () => {
        throw new Error('store down');
      },
      increment: async () => {
        throw new Error('store down');
      },
    };
    const l = createWriteLimiter({
      counters: broken,
      clock: { now: () => t.now },
      limits: { perGrant: 3, deployment: 5 },
      onError: (e) => errors.push(e),
    });
    expect(await budgetOf(l, 'g')).toEqual({ status: 'unknown' });
    expect(errors).toHaveLength(1);
    await expect(l.check({ tool: 't', requestId: 'r', actor: actor('g') })).rejects.toMatchObject({
      code: ErrorCode.WriteLimitUnavailable,
    });
    for (const odd of ['-1', '1.5', 'many', '']) {
      const weird = createWriteLimiter({
        counters: { get: async () => odd, increment: async () => 1 },
        clock: { now: () => t.now },
        limits: { perGrant: 3, deployment: null },
      });
      expect(await budgetOf(weird, 'g'), odd).toEqual({ status: 'unknown' });
    }
  });
});

describe('what a caller is told', () => {
  const ok = (deploymentRemaining: number | null): WriteBudget => ({
    status: 'ok',
    windowEndsAt: T0,
    grant: { limit: 20, used: 4, remaining: 16 },
    deployment:
      deploymentRemaining === null
        ? null
        : { limit: 777, used: 777 - deploymentRemaining, remaining: deploymentRemaining },
  });

  it("is the grant's own count and reset time, and never the deployment's number", () => {
    const view = callerView(ok(555));
    expect(view).toEqual({
      status: 'ok',
      limit: 20,
      used: 4,
      remaining: 16,
      resetsAt: new Date(T0).toISOString(),
    });
    expect(JSON.stringify(view)).not.toMatch(/777|555|deployment(?!Full)/);
    expect(callerView(ok(null))).not.toHaveProperty('deploymentFull');
  });

  it('says only that the deployment is spent when it is', () => {
    expect(callerView(ok(0))).toMatchObject({ remaining: 16, deploymentFull: true });
    expect(callerView({ status: 'unknown' })).toEqual({ status: 'unknown' });
  });
});

describe('the dry run and whoami show the budget', () => {
  const dry = async (limiter: WriteLimiter | undefined) => {
    const tool = makeTestWriteTool(new FakeItems());
    const runtime = makeRuntime(limiter === undefined ? {} : { limiter });
    const out = await tool.handler(
      tool.inputSchema.parse({ item: 'B-00001', status: 'Done', dry_run: true }),
      writeContext(runtime),
    );
    return { structured: out.structured as Record<string, unknown>, text: out.text };
  };

  it('a dry run reports what is left, takes no unit, and says a real call would be refused at zero', async () => {
    const t = { now: T0 };
    const l = limiterOver(memoryCounterStore({ now: () => t.now }), t, 2, null);
    const a = await dry(l);
    expect(a.structured['writeBudget']).toMatchObject({ status: 'ok', limit: 2, used: 0, remaining: 2 });
    expect(a.text).not.toContain('would be refused: this connection');
    // The dry runs above took nothing: both writes are still admitted.
    const info = { tool: 't', requestId: 'r', actor: actor('g') };
    const ran = makeRuntime({ limiter: l });
    expect(ran.limiter).toBe(l);
    await l.check({ ...info, actor: { id: 'u', grantId: 'g' } });
    await l.check({ ...info, actor: { id: 'u', grantId: 'g' } });
    const b = await dry(
      // The same counters, read for the runtime's actor.
      {
        check: l.check,
        budget: () => l.budget?.({ actor: { id: 'u', grantId: 'g' } }) as Promise<WriteBudget>,
      },
    );
    expect(b.structured['writeBudget']).toMatchObject({ remaining: 0 });
    expect(b.text).toContain('A real call would be refused: this connection has used its 2 writes');
  });

  it('a dry run with a limiter that cannot say shows nothing, and one that fails shows unknown', async () => {
    expect((await dry(undefined)).structured).not.toHaveProperty('writeBudget');
    const failing: WriteLimiter = {
      check: async () => {},
      budget: async () => {
        throw new Error('boom');
      },
    };
    expect((await dry(failing)).structured['writeBudget']).toEqual({ status: 'unknown' });
  });

  const fake = new FakeAgility({
    meta: snapshotJson as unknown as Record<string, unknown>,
    assets: {
      Member: [{ _oid: 'Member:20', Name: 'Ann Example', Username: 'ann', IsSelf: true, AssetState: 64 }],
    },
  });
  const who = async (over: Partial<ToolContext>) => {
    const ctx = makeContext({
      fetch: fake.fetch,
      metadata: new MetadataService(),
      budget: createBudget(100),
      ...over,
    });
    const tool: ToolDefinition = whoami;
    const r = await rpc(() => buildMcpServer({ tools: [tool], ctx }), 'tools/call', {
      name: 'whoami',
      arguments: {},
    });
    return r as { structuredContent: { writes: Record<string, unknown> }; content: { text: string }[] };
  };

  it('whoami shows the grant budget only when writes are enabled, and unknown when the read fails', async () => {
    const t = { now: T0 };
    const l = limiterOver(memoryCounterStore({ now: () => t.now }), t, 20, 777);
    const runtime = makeRuntime({
      limiter: { check: l.check, budget: () => l.budget?.({ actor: actor('g') }) as Promise<WriteBudget> },
    });
    const on = await who({
      workspace: { id: 'w', name: 'W', groups: ['core'], writes: { enabled: true, approval: 'page' } },
      writes: runtime,
    });
    expect(on.structuredContent.writes).toMatchObject({
      enabled: true,
      budget: { status: 'ok', limit: 20, used: 0, remaining: 20 },
    });
    expect(on.content[0]?.text).toContain('20 of 20 writes left this hour');
    // The deployment's number is not in what a caller reads.
    expect(JSON.stringify(on.structuredContent)).not.toContain('777');
    const off = await who({
      workspace: {
        id: 'w',
        name: 'W',
        groups: ['core'],
        writes: { enabled: false, approval: 'unavailable' },
      },
      writes: runtime,
    });
    expect(off.structuredContent.writes).not.toHaveProperty('budget');
    const none = await who({});
    expect(none.structuredContent.writes).not.toHaveProperty('budget');
    const unknown = await who({
      workspace: { id: 'w', name: 'W', groups: ['core'], writes: { enabled: true, approval: 'page' } },
      writes: makeRuntime({
        limiter: { check: async () => {}, budget: async () => ({ status: 'unknown' }) },
      }),
    });
    expect(unknown.structuredContent.writes).toMatchObject({ budget: { status: 'unknown' } });
    expect(unknown.content[0]?.text).toContain('unknown right now');
  });
});

describe('AbError is not involved in a read', () => {
  it('a budget read never throws, whatever the store does', async () => {
    const t = { now: T0 };
    const l = createWriteLimiter({
      counters: {
        get: () => Promise.reject(new AbError(ErrorCode.Internal, 'x')),
        increment: async () => 1,
      },
      clock: { now: () => t.now },
    });
    await expect(budgetOf(l, 'g')).resolves.toEqual({ status: 'unknown' });
  });
});
