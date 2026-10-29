// SPDX-License-Identifier: Apache-2.0
// The out-of-band approval page (P7-02, ADR-0013, THREAT_MODEL T31/A13): the write pipeline with the real page channel,
// and the signed-in panel page, against real sessions and memory storage. Negative authorization first: another person,
// another workspace, expired, replayed, tampered; nothing reaches Agility without the one recorded approval.
import type { EffectiveAccess } from '@agility-bridge/auth';
import {
  AbError,
  ApprovalLedger,
  ErrorCode,
  type ToolDefinition,
  type ToolOutput,
} from '@agility-bridge/core';
import { createMemoryStorage } from '@agility-bridge/storage';
import { describe, expect, it } from 'vitest';
import { FakeItems, makeRuntime, makeTestWriteTool, writeContext } from '../../core/test/helpers/writes.ts';
import { createApprovalPage, MAX_PENDING_PER_USER, PENDING_TTL_MS } from '../src/approval-page.ts';
import type { AdminChange } from '../src/audit.ts';
import { setup } from './helpers/panel.ts';

const ORIGIN = 'https://bridge.example.test';
const CALL = { item: 'B-00001', status: 'Done', confirm: true };
const run = (tool: ToolDefinition, args: Record<string, unknown>, ctx: ReturnType<typeof writeContext>) =>
  tool.handler(tool.inputSchema.parse(args), ctx) as Promise<ToolOutput>;

async function refusal(p: Promise<unknown>): Promise<AbError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AbError);
    return e as AbError;
  }
  throw new Error('expected a refusal');
}

const access = (userId: string | null, workspaceName = 'Team'): EffectiveAccess =>
  ({
    grant: { id: 'grant-1', userId, label: null },
    workspace: { id: 'ws-1', slug: 't', name: workspaceName },
  }) as never;
const principal = (userId: string) => ({ userId }) as never;
const idOf = (link: string): string => link.slice(link.lastIndexOf('/') + 1);

function rig(over: { audit?: (c: AdminChange) => void } = {}) {
  const clock = { t: Date.UTC(2026, 9, 29, 12) };
  const c = { now: () => clock.t };
  const storage = createMemoryStorage({ now: c.now });
  const ledger = new ApprovalLedger(storage.kv, c);
  const audit: AdminChange[] = [];
  const page = createApprovalPage({
    kv: storage.kv,
    ledger,
    clock: c,
    publicOrigin: ORIGIN,
    audit: async (change) => {
      audit.push(change);
      over.audit?.(change);
    },
  });
  return { clock, c, storage, ledger, page, audit };
}

/** The pipeline for `userId` ('user-1' is the test actor), asking on the real page channel. */
function pipeline(r: ReturnType<typeof rig>, fake: FakeItems, userId = 'user-1') {
  const channel = r.page.channelFor(access(userId));
  const runtime = makeRuntime({
    ledger: r.ledger,
    ...(channel === undefined ? {} : { channel, page: channel }),
    actor: { id: userId, userId, grantId: 'grant-1' },
  });
  return { tool: makeTestWriteTool(fake), ctx: writeContext(runtime), runtime };
}

describe('the approval page channel with the write pipeline', () => {
  it('pending with a link, the person approves, the repeated call applies once, the next one asks again', async () => {
    const r = rig();
    const fake = new FakeItems();
    const { tool, ctx, runtime } = pipeline(r, fake);
    const pending = await refusal(run(tool, CALL, ctx));
    expect(pending.code).toBe(ErrorCode.WriteApprovalPending);
    const link = /(https:\/\/\S+)/.exec(pending.hint ?? '')?.[1] as string;
    expect(link.startsWith(`${ORIGIN}/admin/approve/`)).toBe(true);
    expect(fake.sends).toHaveLength(0);

    const view = await r.page.port.view({} as never, principal('user-1'), idOf(link));
    expect(view?.changes).toEqual([{ field: 'Status', old: '"In Progress"', new: '"Done"' }]);
    expect(view?.target.number).toBe('B-00001');
    expect(view?.workspaceName).toBe('Team');
    const outcome = await r.page.port.decide({} as never, principal('user-1'), idOf(link), {
      decision: 'approve',
      hash: view?.hash as string,
    });
    expect(outcome).toBe('approved');

    const out = await run(tool, CALL, ctx);
    expect(out.structured).toMatchObject({ applied: true, approval: 'page' });
    expect(fake.sends).toHaveLength(1);
    expect(runtime.audit.records[0]).toMatchObject({ approval: 'page' });
    // Used: with the item back as it was, the same call asks again, with a new link, and nothing more is sent.
    const item = fake.items.get('Story:1');
    if (item) Object.assign(item, { status: 'In Progress', version: 5 });
    const again = await refusal(run(tool, CALL, ctx));
    expect(again.code).toBe(ErrorCode.WriteApprovalPending);
    expect(fake.sends).toHaveLength(1);
    expect(r.audit.map((a) => a.action)).toEqual(['write.approval.approved']);
    expect(JSON.stringify(r.audit)).not.toContain('In Progress');
  });

  it('the page shows the Agility title and old values cleaned and capped, like the elicitation text (L1, D-192)', async () => {
    const r = rig();
    const fake = new FakeItems();
    const item = fake.items.get('Story:1');
    if (item) {
      item.title = `Sign\u202Ein ${'x'.repeat(600)}`;
      item.status = `Open\u200B${'y'.repeat(5_000)}`;
    }
    const { tool, ctx } = pipeline(r, fake);
    const pending = await refusal(run(tool, CALL, ctx));
    const link = /(https:\/\/\S+)/.exec(pending.hint ?? '')?.[1] as string;
    const view = await r.page.port.view({} as never, principal('user-1'), idOf(link));
    expect(view?.label).not.toMatch(/[\u202E\u200B]/);
    expect((view?.label ?? '').length).toBeLessThanOrEqual(200);
    const old = view?.changes[0]?.old ?? '';
    expect(old).not.toMatch(/[\u202E\u200B]/);
    expect(old).toContain('shortened for display');
    expect(old.length).toBeLessThan(2_200);
  });

  it('the agent repeating the call before the person acts gets the same link, not a new one each time', async () => {
    const r = rig();
    const { tool, ctx } = pipeline(r, new FakeItems());
    const first = await refusal(run(tool, CALL, ctx));
    const second = await refusal(run(tool, CALL, ctx));
    expect(second.hint).toBe(first.hint);
  });

  it('declining refuses the repeated call as declined, once, and sends nothing', async () => {
    const r = rig();
    const fake = new FakeItems();
    const { tool, ctx } = pipeline(r, fake);
    const link = (await refusal(run(tool, CALL, ctx))).hint?.match(/(https:\/\/\S+)/)?.[1] as string;
    const view = await r.page.port.view({} as never, principal('user-1'), idOf(link));
    expect(
      await r.page.port.decide({} as never, principal('user-1'), idOf(link), {
        decision: 'decline',
        hash: view?.hash as string,
      }),
    ).toBe('declined');
    expect((await refusal(run(tool, CALL, ctx))).code).toBe(ErrorCode.WriteApprovalDeclined);
    expect((await refusal(run(tool, CALL, ctx))).code).toBe(ErrorCode.WriteApprovalPending);
    expect(fake.sends).toHaveLength(0);
  });

  it('another person cannot see or approve the request, and their attempt approves nothing', async () => {
    const r = rig();
    const fake = new FakeItems();
    const { tool, ctx } = pipeline(r, fake);
    const link = (await refusal(run(tool, CALL, ctx))).hint?.match(/(https:\/\/\S+)/)?.[1] as string;
    const id = idOf(link);
    const view = await r.page.port.view({} as never, principal('user-1'), id);
    expect(await r.page.port.view({} as never, principal('user-2'), id)).toBeNull();
    expect(
      await r.page.port.decide({} as never, principal('user-2'), id, {
        decision: 'approve',
        hash: view?.hash as string,
      }),
    ).toBe('gone');
    expect(r.audit.map((a) => a.action)).toEqual(['write.approval.refused']);
    // The owner's request is untouched and still needs the owner.
    expect(await r.page.port.view({} as never, principal('user-1'), id)).not.toBeNull();
    expect((await refusal(run(tool, CALL, ctx))).code).toBe(ErrorCode.WriteApprovalPending);
    expect(fake.sends).toHaveLength(0);
  });

  it('an approval from one workspace never applies in another', async () => {
    const r = rig();
    const fake = new FakeItems();
    const { tool, ctx } = pipeline(r, fake);
    const link = (await refusal(run(tool, CALL, ctx))).hint?.match(/(https:\/\/\S+)/)?.[1] as string;
    const view = await r.page.port.view({} as never, principal('user-1'), idOf(link));
    await r.page.port.decide({} as never, principal('user-1'), idOf(link), {
      decision: 'approve',
      hash: view?.hash as string,
    });
    // The same person, the same change, a call made in another workspace.
    const other = writeContext(pipeline(r, fake).runtime, {
      workspace: {
        id: 'ws-2',
        name: 'Other',
        groups: ['core', 'writes'],
        writes: { enabled: true, approval: 'page' },
      },
    });
    expect((await refusal(run(tool, CALL, other))).code).toBe(ErrorCode.WriteApprovalPending);
    expect(fake.sends).toHaveLength(0);
  });

  it('an expired request cannot be approved and an expired approval is not applied', async () => {
    const r = rig();
    const fake = new FakeItems();
    const { tool, ctx } = pipeline(r, fake);
    const link = (await refusal(run(tool, CALL, ctx))).hint?.match(/(https:\/\/\S+)/)?.[1] as string;
    const view = await r.page.port.view({} as never, principal('user-1'), idOf(link));
    r.clock.t += PENDING_TTL_MS + 1;
    expect(await r.page.port.view({} as never, principal('user-1'), idOf(link))).toBeNull();
    expect(
      await r.page.port.decide({} as never, principal('user-1'), idOf(link), {
        decision: 'approve',
        hash: view?.hash as string,
      }),
    ).toBe('gone');
    expect((await refusal(run(tool, CALL, ctx))).code).toBe(ErrorCode.WriteApprovalPending);

    // Approved in time, but the agent comes back too late.
    const fresh = (await refusal(run(tool, CALL, ctx))).hint?.match(/(https:\/\/\S+)/)?.[1] as string;
    const v2 = await r.page.port.view({} as never, principal('user-1'), idOf(fresh));
    await r.page.port.decide({} as never, principal('user-1'), idOf(fresh), {
      decision: 'approve',
      hash: v2?.hash as string,
    });
    r.clock.t += PENDING_TTL_MS + 1;
    expect((await refusal(run(tool, CALL, ctx))).code).toBe(ErrorCode.WriteApprovalPending);
    expect(fake.sends).toHaveLength(0);
  });

  it('a replayed or double-sent decision approves nothing the second time', async () => {
    const r = rig();
    const { tool, ctx } = pipeline(r, new FakeItems());
    const link = (await refusal(run(tool, CALL, ctx))).hint?.match(/(https:\/\/\S+)/)?.[1] as string;
    const view = await r.page.port.view({} as never, principal('user-1'), idOf(link));
    const input = { decision: 'approve', hash: view?.hash as string } as const;
    const [a, b] = await Promise.all([
      r.page.port.decide({} as never, principal('user-1'), idOf(link), input),
      r.page.port.decide({} as never, principal('user-1'), idOf(link), input),
    ]);
    expect([a, b].sort()).toEqual(['approved', 'gone']);
  });

  it('a tampered hash approves nothing and burns the request', async () => {
    const r = rig();
    const fake = new FakeItems();
    const { tool, ctx } = pipeline(r, fake);
    const link = (await refusal(run(tool, CALL, ctx))).hint?.match(/(https:\/\/\S+)/)?.[1] as string;
    expect(
      await r.page.port.decide({} as never, principal('user-1'), idOf(link), {
        decision: 'approve',
        hash: 'a'.repeat(64),
      }),
    ).toBe('mismatch');
    expect(await r.page.port.view({} as never, principal('user-1'), idOf(link))).toBeNull();
    expect((await refusal(run(tool, CALL, ctx))).code).toBe(ErrorCode.WriteApprovalPending);
    expect(fake.sends).toHaveLength(0);
  });

  it('an approval is for the exact change: another value asks again', async () => {
    const r = rig();
    const fake = new FakeItems();
    const { tool, ctx } = pipeline(r, fake);
    const link = (await refusal(run(tool, CALL, ctx))).hint?.match(/(https:\/\/\S+)/)?.[1] as string;
    const view = await r.page.port.view({} as never, principal('user-1'), idOf(link));
    await r.page.port.decide({} as never, principal('user-1'), idOf(link), {
      decision: 'approve',
      hash: view?.hash as string,
    });
    expect((await refusal(run(tool, { ...CALL, status: 'Blocked' }, ctx))).code).toBe(
      ErrorCode.WriteApprovalPending,
    );
    expect(fake.sends).toHaveLength(0);
  });

  it('a caller without a person behind the grant (a service grant) gets no page channel', () => {
    const r = rig();
    expect(r.page.channelFor(access(null))).toBeUndefined();
  });

  it('bounds the open requests of one person', async () => {
    const r = rig();
    const channel = r.page.channelFor(access('user-1')) as NonNullable<ReturnType<typeof r.page.channelFor>>;
    const mutation = { operation: 'x', target: { assetType: 'Story', oid: 'Story:1' }, changes: [] };
    for (let i = 0; i < MAX_PENDING_PER_USER + 5; i++) {
      r.clock.t += 1_000;
      await channel.ask({
        message: 'm',
        requestedSchema: {},
        hash: `h${i}`,
        tool: 't',
        actor: { id: 'user-1' },
        expiresAt: 0,
        workspaceId: 'ws-1',
        mutation,
      });
    }
    expect(await r.storage.kv.list('wr:pend:user-1:', { limit: 1_000 })).toHaveLength(MAX_PENDING_PER_USER);
  });
});

describe('the panel page', () => {
  const MIN = 60_000;

  async function panel() {
    const clock = { now: () => 0 };
    // biome-ignore lint/style/useConst: assigned once the world (and its storage) exists
    let page: ReturnType<typeof createApprovalPage>;
    const s = await setup({
      publicUrl: 'http://127.0.0.1:8787',
      writes: {
        runtimeFor: () => Promise.reject(new Error('not used')),
        approvals: {
          view: (...a) => page.port.view(...a),
          list: (...a) => page.port.list(...a),
          decide: (...a) => page.port.decide(...a),
        },
      },
    });
    clock.now = () => s.w.now.t;
    const ledger = new ApprovalLedger(s.w.storage.kv, clock);
    page = createApprovalPage({
      kv: s.w.storage.kv,
      ledger,
      clock,
      publicOrigin: s.publicUrl,
      audit: (c) => s.w.audit.admin(c),
    });
    const alice = await s.session('alice@example.test');
    const bob = await s.session('bob@example.test');
    const aliceId = s.w.ids.alice;
    const ask = async (over: { value?: string; userId?: string; hash?: string; workspace?: string } = {}) => {
      const userId = over.userId ?? aliceId;
      const channel = page.channelFor({
        grant: { id: 'g', userId, label: null },
        workspace: { id: 'ws', name: 'Team A' },
      } as never);
      const reply = await channel?.ask({
        message: 'm',
        requestedSchema: {},
        hash: over.hash ?? 'b'.repeat(64),
        tool: 'update_test_item',
        actor: { id: userId },
        expiresAt: 0,
        workspaceId: 'ws',
        mutation: {
          operation: 'update_status',
          target: { assetType: 'Story', oid: 'Story:1', number: 'B-00001' },
          changes: [{ field: 'Description', old: 'x', new: over.value ?? '<script>alert(1)</script>' }],
        },
        label: '<img src=x onerror=alert(1)>',
      });
      if (reply?.status !== 'pending') throw new Error('expected pending');
      return { path: new URL(reply.link).pathname, hash: over.hash ?? 'b'.repeat(64) };
    };
    const get = (path: string, who: { cookie: string }) =>
      s.send('GET', path, { cookie: who.cookie, site: 'none' });
    const post = (path: string, who: { cookie: string; csrf: string }, fields: Record<string, string>) =>
      s.send('POST', path, {
        cookie: who.cookie,
        form: new URLSearchParams({ _csrf: who.csrf, ...fields }).toString(),
      });
    return { s, alice, bob, ask, get, post, ledger, aliceId };
  }

  it('shows the whole change escaped, to the person who made the request, with the panel CSP', async () => {
    const p = await panel();
    const { path } = await p.ask();
    const res = await p.get(path, p.alice);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("form-action 'self'");
    expect(res.headers.get('cache-control')).toContain('no-store');
    const html = await res.text();
    expect(html).toContain('B-00001');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('Approve this change');
  });

  it("lists only the signed-in person's open requests, without values, and the list is not another person's", async () => {
    const p = await panel();
    const mine = await p.ask({ hash: '1'.repeat(64) });
    const mine2 = await p.ask({ hash: '2'.repeat(64) });
    const bobs = await p.ask({ hash: '3'.repeat(64), userId: p.s.w.ids.bob });
    const res = await p.get('/admin/approve', p.alice);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const html = await res.text();
    expect(html).toContain(mine.path.split('/').pop() as string);
    expect(html).toContain(mine2.path.split('/').pop() as string);
    expect(html).not.toContain(bobs.path.split('/').pop() as string);
    expect(html).toContain('B-00001');
    expect(html).toContain('Description');
    // Names only: not the title, not an old or new value.
    expect(html).not.toContain('alert(1)');
    expect(html).not.toContain('onerror');
    const bobHtml = await (await p.get('/admin/approve', p.bob)).text();
    expect(bobHtml).toContain(bobs.path.split('/').pop() as string);
    expect(bobHtml).not.toContain(mine.path.split('/').pop() as string);
    // Nothing waiting, and a request that was answered or has expired, are not listed.
    await p.post(mine.path, p.alice, { decision: 'decline', hash: mine.hash });
    const after = await (await p.get('/admin/approve', p.alice)).text();
    expect(after).not.toContain(mine.path.split('/').pop() as string);
    expect(after).toContain(mine2.path.split('/').pop() as string);
    p.s.w.now.t += PENDING_TTL_MS + 1;
    // A fresh sign-in is not needed to look; an expired request is simply gone.
    const expired = await p.get('/admin/approve', p.alice);
    expect(expired.status).toBe(200);
    expect(await expired.text()).toContain('Nothing is waiting for you.');
  });

  it('the list needs a sign-in and a bad method changes nothing', async () => {
    const p = await panel();
    await p.ask();
    const anon = await p.s.send('GET', '/admin/approve', { site: 'none' });
    expect(anon.status).toBe(303);
    expect(anon.headers.get('location')).toContain('/auth/login');
    const post = await p.post('/admin/approve', p.alice, { decision: 'approve' });
    expect([404, 405]).toContain(post.status);
    expect(await p.ledger.takeGrant(p.aliceId, 'b'.repeat(64), 'ws')).toBeNull();
  });

  it('is a 404 for another signed-in person and for a signed-out visitor goes to sign-in', async () => {
    const p = await panel();
    const { path } = await p.ask();
    expect((await p.get(path, p.bob)).status).toBe(404);
    const anon = await p.s.send('GET', path, { site: 'none' });
    expect(anon.status).toBe(303);
    expect(anon.headers.get('location')).toContain('/auth/login');
    expect((await p.get('/admin/approve/not-an-id', p.alice)).status).toBe(404);
  });

  it('approves with the CSRF token and a recent sign-in, then records one grant and an audit row without values', async () => {
    const p = await panel();
    const { path, hash } = await p.ask();
    const res = await p.post(path, p.alice, { decision: 'approve', hash });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Approved');
    expect(await p.ledger.takeGrant(p.aliceId, hash, 'ws')).toMatchObject({ tool: 'update_test_item' });
    const rows = await p.s.rows();
    const row = rows.find((r) => r.action === 'write.approval.approved');
    expect(row?.userId).toBe(p.aliceId);
    expect(JSON.stringify(rows)).not.toContain('alert(1)');
    // Replay of the same form.
    const again = await p.post(path, p.alice, { decision: 'approve', hash });
    expect(again.status).toBe(409);
    expect(await p.ledger.takeGrant(p.aliceId, hash, 'ws')).toBeNull();
  });

  it('refuses a post without or with a wrong CSRF token, from another origin, and from another person', async () => {
    const p = await panel();
    const { path, hash } = await p.ask();
    const form = (csrf: string) => new URLSearchParams({ _csrf: csrf, decision: 'approve', hash }).toString();
    expect((await p.s.send('POST', path, { cookie: p.alice.cookie, form: form('wrong') })).status).toBe(403);
    expect(
      (await p.s.send('POST', path, { cookie: p.alice.cookie, form: form(p.alice.csrf), site: 'cross-site' }))
        .status,
    ).toBe(403);
    // Bob's own session and token, Alice's request id.
    expect((await p.post(path, p.bob, { decision: 'approve', hash })).status).toBe(409);
    // Nothing was approved by any of it.
    expect(await p.ledger.takeGrant(p.aliceId, hash, 'ws')).toBeNull();
    expect((await p.get(path, p.alice)).status).toBe(200);
  });

  it('refuses a tampered hash and malformed fields', async () => {
    const p = await panel();
    const { path } = await p.ask();
    expect((await p.post(path, p.alice, { decision: 'approve', hash: 'c'.repeat(64) })).status).toBe(409);
    const next = await p.ask();
    expect((await p.post(next.path, p.alice, { decision: 'maybe', hash: next.hash })).status).toBe(400);
    expect((await p.post(next.path, p.alice, { decision: 'approve', hash: 'short' })).status).toBe(400);
    expect(await p.ledger.takeGrant(p.aliceId, next.hash, 'ws')).toBeNull();
  });

  it('asks for a sign-in again when the last one is stale, and records nothing until then', async () => {
    const p = await panel();
    p.s.w.now.t += 11 * MIN;
    const { path, hash } = await p.ask();
    const view = await (await p.get(path, p.alice)).text();
    expect(view).toContain('Sign in again');
    expect(view).not.toContain('Approve this change');
    const res = await p.post(path, p.alice, { decision: 'approve', hash });
    expect(res.status).toBe(403);
    expect(await p.ledger.takeGrant(p.aliceId, hash, 'ws')).toBeNull();
  });

  it('declining needs no recent sign-in and records a denial', async () => {
    const p = await panel();
    p.s.w.now.t += 11 * MIN;
    const { path, hash } = await p.ask();
    const res = await p.post(path, p.alice, { decision: 'decline', hash });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Declined');
    expect(await p.ledger.takeDenial(p.aliceId, hash, 'ws')).not.toBeNull();
  });
});
