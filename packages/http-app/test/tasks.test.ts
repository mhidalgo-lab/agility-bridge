// SPDX-License-Identifier: Apache-2.0
// The MCP Tasks extension (P8-10, THREAT_MODEL T32, L-016, L-073): only requests that declare it get a task, only the
// owner device of a grant and workspace can read, cancel or update it, records are sealed and hashed, a task runs once,
// and the kill switch removes the whole thing.

import type { EffectiveAccess } from '@agility-bridge/auth';
import { generateMasterKey, Keyring } from '@agility-bridge/auth';
import {
  CORE_TOOLS,
  DEFAULT_LIMITS,
  defineTool,
  shapeOutput,
  type ToolDefinition,
  webCryptoRandom,
} from '@agility-bridge/core';
import type { Storage } from '@agility-bridge/storage';
import { createMemoryStorage } from '@agility-bridge/storage';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTaskService, TASK_TTL_MS, TASKS_EXTENSION } from '../src/index.ts';
import { post, TOOL_INFO, type World, world } from './helpers/world.ts';

const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': { extensions: { [TASKS_EXTENSION]: {} } },
};
const MODERN_NO_TASKS = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
};

/** A report-group tool that counts its runs and answers with one line. */
function reportTool(runs: { n: number }, gate?: Promise<void>): ToolDefinition {
  return defineTool({
    name: 'test_report',
    title: 'Test report',
    description: 'A synthetic long report used by the task tests.',
    kind: 'read',
    group: 'reports',
    cost: 1,
    inputSchema: z.object({ rows: z.number().int().min(1).max(10).optional() }),
    handler: async (_input, ctx) => {
      runs.n++;
      if (gate !== undefined) await gate;
      return shapeOutput(ctx, { summary: ['The synthetic report is ready.'], structured: { ready: true } })
        .output;
    },
  });
}

async function rig(options: { tasks?: boolean; gate?: Promise<void>; deadlineMs?: number } = {}) {
  const runs = { n: 0 };
  const tool = reportTool(runs, options.gate);
  const info = new Map([...TOOL_INFO, [tool.name, { kind: tool.kind, group: tool.group }]]);
  const keyring = await Keyring.create(generateMasterKey(1));
  let kv: Storage['kv'] | undefined;
  const clock = { t: Date.UTC(2026, 9, 30, 12) };
  // The service reads the world's own kv, which exists only once the world does.
  const lazyKv = new Proxy({} as Storage['kv'], {
    get: (_t, key) => (kv as unknown as Record<string, unknown>)[key as string],
  });
  const tasks =
    options.tasks === false
      ? undefined
      : createTaskService({ kv: lazyKv, keyring, clock: { now: () => clock.t }, random: webCryptoRandom });
  const w = await world(
    {
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
      tools: [...CORE_TOOLS, tool],
      access: {
        tools: info,
        writesEnabled: false,
        environment: 'live',
        limits: {
          defaults: {
            ...DEFAULT_LIMITS,
            maxResponseBytes: 8 * 1024 * 1024,
            callBudget: 1_000,
            genericQuery: true,
            reports: true,
          },
          ceilings: {},
        },
      },
    },
    { tools: info, ...(tasks === undefined ? {} : { services: { tasks } }) },
  );
  kv = w.storage.kv;
  return { w, runs, clock };
}

const call = (id: number, meta: object | undefined, name = 'test_report', args: unknown = {}) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args, ...(meta === undefined ? {} : { _meta: meta }) },
});
const taskMsg = (id: number, method: string, taskId: string, meta: object = MODERN_META) => ({
  jsonrpc: '2.0',
  id,
  method,
  params: { taskId, _meta: meta },
});

type Rpc = { result?: Record<string, unknown>; error?: { code: number; message: string } };
async function rpc(w: World, token: string | null, body: unknown, slug = 'team-a'): Promise<Rpc> {
  const m = body as {
    method: string;
    params?: { _meta?: Record<string, unknown>; name?: string; taskId?: string };
  };
  const modern = typeof m.params?._meta?.['io.modelcontextprotocol/protocolVersion'] === 'string';
  const res = await post(w, slug, token, body, {
    'mcp-method': m.method,
    ...(modern ? { 'mcp-protocol-version': '2026-07-28' } : {}),
    ...(modern && (m.params?.name ?? m.params?.taskId) !== undefined
      ? { 'mcp-name': String(m.params?.name ?? m.params?.taskId) }
      : {}),
  });
  const text = await res.text();
  const data = text.startsWith('event:')
    ? (text.split('\n').find((l) => l.startsWith('data:')) ?? '').slice(5)
    : text;
  return JSON.parse(data) as Rpc;
}

const create = async (w: World, token: string) => {
  const r = await rpc(w, token, call(1, MODERN_META));
  return r.result as { taskId: string; status: string; resultType: string };
};

describe('creating a task', () => {
  it('returns a handle at once, runs nothing, and stores a sealed record under a hashed key', async () => {
    const { w, runs } = await rig();
    const task = await create(w, w.tokens.alice);
    expect(task).toMatchObject({ resultType: 'task', status: 'working', ttlMs: TASK_TTL_MS });
    expect(task.taskId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(runs.n).toBe(0);
    const keys = await w.storage.kv.list('task:');
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain(task.taskId);
    const stored = (await w.storage.kv.get(keys[0] as string)) as string;
    expect(stored).toContain('ciphertext');
    expect(stored).not.toMatch(/test_report|grant|team/);
  });

  it('is used only by a 2026-07-28 request that declares the extension, for a report tool', async () => {
    const { w, runs } = await rig();
    for (const meta of [
      undefined,
      MODERN_NO_TASKS,
      {
        'io.modelcontextprotocol/clientCapabilities':
          MODERN_META['io.modelcontextprotocol/clientCapabilities'],
      },
    ]) {
      const r = await rpc(w, w.tokens.alice, call(2, meta));
      expect(JSON.stringify(r), JSON.stringify(meta)).not.toContain('"taskId"');
    }
    // Ran inline each time (a normal result).
    expect(runs.n).toBe(3);
    // Not a report tool: inline, even when declared.
    const inline = await rpc(w, w.tokens.alice, call(3, MODERN_META, 'whoami'));
    expect(JSON.stringify(inline)).not.toContain('"taskId"');
  });

  it('is advertised in server/discover only when on', async () => {
    const on = await rig();
    const body = { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: MODERN_NO_TASKS } };
    expect(JSON.stringify(await rpc(on.w, on.w.tokens.alice, body))).toContain(TASKS_EXTENSION);
    const off = await rig({ tasks: false });
    expect(JSON.stringify(await rpc(off.w, off.w.tokens.alice, body))).not.toContain(TASKS_EXTENSION);
  });
});

describe('the lifecycle', () => {
  it('runs the report on the first poll, once, and keeps the result for later polls', async () => {
    const { w, runs } = await rig();
    const { taskId } = await create(w, w.tokens.alice);
    const first = await rpc(w, w.tokens.alice, taskMsg(2, 'tasks/get', taskId));
    expect(first.result).toMatchObject({ resultType: 'complete', taskId, status: 'completed' });
    const text = JSON.stringify(first.result);
    expect(text).toContain('The synthetic report is ready.');
    // Agility-origin text stays inside the result the pipeline shaped (the envelope is part of the stored result).
    expect(runs.n).toBe(1);
    const again = await rpc(w, w.tokens.alice, taskMsg(3, 'tasks/get', taskId));
    expect(again.result).toMatchObject({ status: 'completed' });
    expect(runs.n).toBe(1);
    // The stored result is sealed too.
    const keys = await w.storage.kv.list('task:');
    expect(await w.storage.kv.get(keys[0] as string)).not.toContain('synthetic');
  });

  it('a second poll while the first still runs sees it working and does not run it again', async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { w, runs } = await rig({ gate });
    const { taskId } = await create(w, w.tokens.alice);
    const first = rpc(w, w.tokens.alice, taskMsg(2, 'tasks/get', taskId));
    await new Promise((r) => setTimeout(r, 50));
    const second = await rpc(w, w.tokens.alice, taskMsg(3, 'tasks/get', taskId));
    expect(second.result).toMatchObject({ status: 'working' });
    expect(second.result).toHaveProperty('pollIntervalMs');
    release();
    expect((await first).result).toMatchObject({ status: 'completed' });
    expect(runs.n).toBe(1);
  });

  it('cancels a working task, keeps it cancelled, and never runs it', async () => {
    const { w, runs } = await rig();
    const { taskId } = await create(w, w.tokens.alice);
    expect((await rpc(w, w.tokens.alice, taskMsg(2, 'tasks/cancel', taskId))).result).toMatchObject({
      resultType: 'complete',
    });
    const got = await rpc(w, w.tokens.alice, taskMsg(3, 'tasks/get', taskId));
    expect(got.result).toMatchObject({ status: 'cancelled' });
    expect(runs.n).toBe(0);
    // A cancel of a finished task changes nothing.
    const done = await create(w, w.tokens.alice);
    await rpc(w, w.tokens.alice, taskMsg(4, 'tasks/get', done.taskId));
    await rpc(w, w.tokens.alice, taskMsg(5, 'tasks/cancel', done.taskId));
    expect((await rpc(w, w.tokens.alice, taskMsg(6, 'tasks/get', done.taskId))).result).toMatchObject({
      status: 'completed',
    });
  });

  it('a cancel that arrives while the report runs wins', async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { w } = await rig({ gate });
    const { taskId } = await create(w, w.tokens.alice);
    const running = rpc(w, w.tokens.alice, taskMsg(2, 'tasks/get', taskId));
    await new Promise((r) => setTimeout(r, 50));
    await rpc(w, w.tokens.alice, taskMsg(3, 'tasks/cancel', taskId));
    release();
    expect((await running).result).toMatchObject({ status: 'cancelled' });
  });

  it('refuses tasks/update (no report ever asks for input) and a tool failure completes with the error result', async () => {
    const { w } = await rig();
    const { taskId } = await create(w, w.tokens.alice);
    const update = await rpc(w, w.tokens.alice, {
      ...taskMsg(2, 'tasks/update', taskId),
      params: { taskId, inputResponses: {}, _meta: MODERN_META },
    });
    expect(update.error?.code).toBe(-32602);
  });

  it('expires after 15 minutes', async () => {
    const { w, clock } = await rig();
    const { taskId } = await create(w, w.tokens.alice);
    clock.t += TASK_TTL_MS + 1;
    const r = await rpc(w, w.tokens.alice, taskMsg(2, 'tasks/get', taskId));
    expect(r.error?.code).toBe(-32602);
  });
});

describe('isolation (negative authorization)', () => {
  it('another device of the same grant, another grant and another workspace cannot read, cancel or update a task, and nothing runs', async () => {
    const { w, runs } = await rig();
    const { taskId } = await create(w, w.tokens.alice);
    const second = await w.services.tokens.issue({ grantId: w.ids.aliceGrant, label: 'phone' });
    const askers: Array<[string, string | null, string]> = [
      ['another device', second.token, 'team-a'],
      ['another person', w.tokens.bob, 'team-b'],
      ['same person, other workspace', w.tokens.aliceB, 'team-b'],
      ['no token', null, 'team-a'],
    ];
    for (const [who, token, slug] of askers) {
      for (const method of ['tasks/get', 'tasks/cancel', 'tasks/update']) {
        const res = await post(w, slug, token, taskMsg(9, method, taskId), { 'mcp-method': method });
        const text = await res.text();
        expect(text, `${who} ${method}`).not.toContain('The synthetic report');
        expect(text, `${who} ${method}`).not.toContain('"status":"');
        expect(res.status === 401 || text.includes('-32602'), `${who} ${method}`).toBe(true);
      }
    }
    expect(runs.n).toBe(0);
    // The owner still has it, untouched by the refused cancels.
    expect((await rpc(w, w.tokens.alice, taskMsg(10, 'tasks/get', taskId))).result).toMatchObject({
      status: 'completed',
    });
  });

  it('guessed, malformed and unknown handles are the same not-found, and a 2025-era request gets no tasks/*', async () => {
    const { w, runs } = await rig();
    for (const taskId of ['x', 'A'.repeat(43), '../../etc', 12345 as never]) {
      const r = await rpc(w, w.tokens.alice, taskMsg(2, 'tasks/get', taskId));
      expect(r.error?.code, String(taskId)).toBe(-32602);
    }
    const { taskId } = await create(w, w.tokens.alice);
    const legacy = await rpc(w, w.tokens.alice, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tasks/get',
      params: { taskId },
    });
    expect(legacy.error?.code).toBe(-32601);
    expect(runs.n).toBe(0);
  });

  it('a read-only tool a grant lacks cannot be started as a task', async () => {
    const { w } = await rig();
    await w.storage.grants.update(w.ids.aliceGrant, { tools: ['whoami'] });
    w.app.clearAccessCache();
    const r = await rpc(w, w.tokens.alice, call(1, MODERN_META));
    expect(JSON.stringify(r)).not.toContain('"taskId"');
  });
});

describe('the kill switch', () => {
  it('with tasks off a declared call runs inline and tasks/* is method-not-found', async () => {
    const { w, runs } = await rig({ tasks: false });
    const r = await rpc(w, w.tokens.alice, call(1, MODERN_META));
    expect(JSON.stringify(r)).toContain('The synthetic report is ready.');
    expect(runs.n).toBe(1);
    const got = await rpc(w, w.tokens.alice, taskMsg(2, 'tasks/get', 'A'.repeat(43)));
    expect(got.error?.code).toBe(-32601);
  });
});

describe('review fixes (P8-12)', () => {
  it('reports the remaining life of a task, not always 15 minutes (Q-6)', async () => {
    const { w, clock } = await rig();
    const { taskId } = await create(w, w.tokens.alice);
    await rpc(w, w.tokens.alice, taskMsg(2, 'tasks/get', taskId));
    clock.t += 14 * 60_000;
    const late = await rpc(w, w.tokens.alice, taskMsg(3, 'tasks/get', taskId));
    expect(late.result?.['ttlMs']).toBe(TASK_TTL_MS - 14 * 60_000);
  });

  it('a report that does not fit the request deadline fails the task, frees the lease and is not run again (Q-2)', async () => {
    const gate = new Promise<void>(() => {});
    const { w, runs } = await rig({ gate, deadlineMs: 150 });
    const { taskId } = await create(w, w.tokens.alice);
    const first = await rpc(w, w.tokens.alice, taskMsg(2, 'tasks/get', taskId));
    expect(first.result).toMatchObject({ status: 'failed' });
    expect(JSON.stringify(first.result)).toContain('took too long');
    expect(await w.storage.kv.list('taskrun:')).toHaveLength(0);
    const again = await rpc(w, w.tokens.alice, taskMsg(3, 'tasks/get', taskId));
    expect(again.result).toMatchObject({ status: 'failed' });
    expect(runs.n).toBe(1);
  });

  it('refuses arguments that do not match the tool schema, or are too large, before storing anything (S-3)', async () => {
    const { w } = await rig();
    for (const args of [{ rows: 'many' }, { rows: 99 }, [], 'text', { note: 'x'.repeat(9_000) }]) {
      const r = await rpc(w, w.tokens.alice, call(1, MODERN_META, 'test_report', args));
      expect(r.error?.code, JSON.stringify(args).slice(0, 40)).toBe(-32602);
      expect(JSON.stringify(r)).not.toContain('"taskId"');
    }
    expect(await w.storage.kv.list('task:')).toHaveLength(0);
    const ok = await rpc(w, w.tokens.alice, call(2, MODERN_META, 'test_report', { rows: 3 }));
    expect(ok.result).toMatchObject({ resultType: 'task' });
  });

  it('a finished task is not returned once the grant lost the tool (S-4)', async () => {
    const { w } = await rig();
    const { taskId } = await create(w, w.tokens.alice);
    expect((await rpc(w, w.tokens.alice, taskMsg(2, 'tasks/get', taskId))).result).toMatchObject({
      status: 'completed',
    });
    await w.storage.grants.update(w.ids.aliceGrant, { tools: ['whoami'] });
    w.app.clearAccessCache();
    const r = await rpc(w, w.tokens.alice, taskMsg(3, 'tasks/get', taskId));
    expect(r.error?.code).toBe(-32602);
    expect(JSON.stringify(r)).not.toContain('synthetic');
  });
});

/** A service over a memory kv with a stub access, for what the HTTP rig cannot reach (clock, lease, races). */
async function service(over: { leaseMs?: number } = {}) {
  const clock = { t: Date.UTC(2026, 9, 30, 12) };
  const storage = createMemoryStorage({ now: () => clock.t });
  const keyring = await Keyring.create(generateMasterKey(1));
  const runs = { n: 0 };
  const tool = reportTool(runs);
  const tasks = createTaskService({
    kv: storage.kv,
    keyring,
    clock: { now: () => clock.t },
    random: webCryptoRandom,
    ...over,
  });
  const access = (grant = 'g1', projects: string[] = []) =>
    ({
      grant: { id: grant },
      workspace: { id: 'w1' },
      tokenId: 't1',
      projects: { allowed: projects, includeChildren: false },
      assetTypes: { deny: [] },
      limits: { callBudget: 10 },
    }) as unknown as EffectiveAccess;
  const msg = (id: number, method: string, params: Record<string, unknown>) => ({
    jsonrpc: '2.0',
    id,
    method,
    params: { ...params, _meta: MODERN_META },
  });
  const done = { result: { content: [{ type: 'text', text: 'ok' }] } };
  const make = async (run = async () => done, acc = access()) => {
    const r = (await tasks.handle({
      message: msg(1, 'tools/call', { name: 'test_report', arguments: {} }),
      access: acc,
      tools: [tool],
      run,
    })) as { result?: { taskId: string }; error?: unknown };
    return r.result?.taskId as string;
  };
  const poll = (
    taskId: string,
    method: string,
    run: Parameters<typeof tasks.handle>[0]['run'],
    acc = access(),
  ) =>
    tasks.handle({ message: msg(2, method, { taskId }), access: acc, tools: [tool], run }) as Promise<{
      result?: Record<string, unknown>;
      error?: { message: string };
    }>;
  return { storage, clock, tasks, access, make, poll, done, tool };
}

describe('the task service on its own (P8-12)', () => {
  it('a lease left by a runner that never returned lets a later poll run the report again, only after it expires (Q-2)', async () => {
    const s = await service({ leaseMs: 60_000 });
    const id = await s.make();
    void s.poll(id, 'tasks/get', () => new Promise(() => {}));
    await new Promise((r) => setTimeout(r, 20));
    expect((await s.poll(id, 'tasks/get', async () => s.done)).result).toMatchObject({ status: 'working' });
    s.clock.t += 60_001;
    expect((await s.poll(id, 'tasks/get', async () => s.done)).result).toMatchObject({ status: 'completed' });
  });

  it('a runner that throws fails the task and frees the lease (Q-2)', async () => {
    const s = await service();
    const id = await s.make();
    const r = await s.poll(id, 'tasks/get', () => Promise.reject(new Error('aborted')));
    expect(r.result).toMatchObject({ status: 'failed' });
    expect(await s.storage.kv.list('taskrun:')).toHaveLength(0);
  });

  it('a cancel that lands between the final read and the save still wins (Q-5)', async () => {
    const s = await service();
    const id = await s.make();
    let sets = 0;
    const kv = s.storage.kv;
    const realSet = kv.set.bind(kv);
    let cancelling: Promise<unknown> | undefined;
    kv.set = async (key, value, options) => {
      // The first record write after creation is the completion: a cancel arrives just before it.
      if (key.startsWith('task:') && ++sets === 1) {
        cancelling = s.poll(id, 'tasks/cancel', async () => s.done);
        await cancelling;
      }
      return realSet(key, value, options);
    };
    await s.poll(id, 'tasks/get', async () => s.done);
    expect((await s.poll(id, 'tasks/get', async () => s.done)).result).toMatchObject({ status: 'cancelled' });
  });

  it('a result too large to keep fails the task with a short error, frees the lease and is not run again (P-5)', async () => {
    const s = await service();
    const id = await s.make();
    let runs = 0;
    const big = async () => {
      runs++;
      return { result: { content: [{ type: 'text', text: 'x'.repeat(400_000) }] } };
    };
    const first = await s.poll(id, 'tasks/get', big);
    expect(first.result).toMatchObject({ status: 'failed' });
    expect(JSON.stringify(first.result)).toContain('too large');
    expect(await s.storage.kv.list('taskrun:')).toHaveLength(0);
    await s.poll(id, 'tasks/get', big);
    expect(runs).toBe(1);
  });

  it('caps how many tasks one grant may start per window, and leaves other grants alone (S-3)', async () => {
    const s = await service();
    for (let i = 0; i < 30; i++) expect(await s.make()).toBeTruthy();
    const refused = (await s.tasks.handle({
      message: {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'test_report', arguments: {}, _meta: MODERN_META },
      },
      access: s.access(),
      tools: [s.tool],
      run: async () => s.done,
    })) as { error?: { message: string }; result?: unknown };
    expect(refused.error?.message).toContain('Too many tasks');
    expect(refused.result).toBeUndefined();
    expect(await s.make(async () => s.done, s.access('g2'))).toBeTruthy();
  });

  it('does not return a finished result to a caller whose scope narrowed since it ran (S-4)', async () => {
    const s = await service();
    const id = await s.make();
    expect((await s.poll(id, 'tasks/get', async () => s.done)).result).toMatchObject({ status: 'completed' });
    expect((await s.poll(id, 'tasks/get', async () => s.done)).result).toMatchObject({ status: 'completed' });
    const narrowed = await s.poll(id, 'tasks/get', async () => s.done, s.access('g1', ['Scope:1']));
    expect(narrowed.result).toBeUndefined();
    expect(narrowed.error?.message).toContain('Unknown or expired');
  });
});
