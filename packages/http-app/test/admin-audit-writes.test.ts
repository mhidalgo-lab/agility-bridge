// SPDX-License-Identifier: Apache-2.0
// Write rows in the audit viewer, CSV and statistics (P7-11, THREAT_MODEL T17): intent and outcome are paired, an intent
// with no outcome is flagged, a member sees only their own write rows and no write statistics, and every stored string is
// inert. Real sessions and memory storage, no network; rows are written the way the write pipeline stores them (names and
// hashes only, D-160).
import type { NewAuditEntry } from '@agility-bridge/storage';
import { describe, expect, it, vi } from 'vitest';
import { setup } from './helpers/panel.ts';

const OWNER = 'owner@example.test';
const ADMIN = 'admin@example.test';
const ALICE = 'alice@example.test';
const BOB = 'bob@example.test';
const EVIL = '<img src=x onerror=alert(1)>"\'</title><script>alert(2)</script>';

type S = Awaited<ReturnType<typeof setup>>;
type Session = { cookie: string; csrf: string };

const page = (s: S, path: string, who: Session | undefined) =>
  s.send('GET', path, { ...(who === undefined ? {} : { cookie: who.cookie }), site: 'none' });

let seq = 0;
async function row(s: S, over: Partial<NewAuditEntry> = {}): Promise<NewAuditEntry> {
  seq++;
  const entry: NewAuditEntry = {
    id: `wrow-${String(seq).padStart(6, '0')}`,
    ts: s.w.now.t + seq,
    kind: 'tool_call',
    action: 'search_assets',
    status: 'ok',
    ...over,
  };
  await s.w.storage.audit.append(entry);
  return entry;
}

async function env() {
  const s = await setup();
  const owner = await s.session(OWNER);
  const admin = await s.session(ADMIN);
  const alice = await s.session(ALICE);
  const users = {
    alice: (await s.w.storage.users.getByEmail(ALICE))?.id as string,
    bob: (await s.w.storage.users.getByEmail(BOB))?.id as string,
  };
  await s.w.audit.flush();
  await s.w.storage.audit.purge(Number.MAX_SAFE_INTEGER, 10_000);
  return { s, owner, admin, alice, users };
}

interface PairOptions {
  tool?: string;
  userId?: string;
  workspaceId?: string;
  outcome?: 'ok' | 'error' | 'none';
  approval?: string;
  ts?: number;
  fields?: string[];
  target?: string;
}

/** The two rows of one write, as the pipeline stores them. */
async function writePair(
  s: S,
  over: PairOptions = {},
): Promise<{ intent: NewAuditEntry; outcome: NewAuditEntry | null }> {
  const common = {
    kind: 'write' as const,
    action: over.tool ?? 'update_fields',
    userId: over.userId ?? null,
    workspaceId: over.workspaceId ?? 'w-a',
    targetType: 'Story',
    targetId: over.target ?? 'Story:100',
    assetNumbers: ['S-1'],
  };
  const details = (phase: string) => ({
    phase,
    operation: 'update',
    hash: 'a'.repeat(64),
    fields: over.fields ?? ['Name'],
    approval: over.approval ?? 'page',
    credential: 'personal',
  });
  const ts = over.ts ?? s.w.now.t;
  const intent = await row(s, { ...common, ts, details: details('intent') });
  const state = over.outcome ?? 'ok';
  if (state === 'none') return { intent, outcome: null };
  const outcome = await row(s, {
    ...common,
    ts: ts + 5,
    status: state,
    errorCode: state === 'error' ? 'AB_AGILITY_REJECTED' : null,
    details: { ...details('outcome'), intentId: intent.id },
  });
  return { intent, outcome };
}

describe('GET /audit/write-stats', () => {
  it('pairs intents with outcomes and flags an intent with no outcome', async () => {
    const { s, owner, admin, users } = await env();
    const now = s.w.now.t;
    await writePair(s, { userId: users.alice, outcome: 'ok', approval: 'page' });
    await writePair(s, {
      userId: users.alice,
      outcome: 'error',
      approval: 'elicitation',
      tool: 'add_comment',
    });
    await writePair(s, { userId: users.bob, outcome: 'ok', approval: 'page' });
    // A crash between the two rows, well past the grace period, and a write that is still running.
    const lost = await writePair(s, { userId: users.bob, outcome: 'none', ts: now - 3_600_000 });
    await writePair(s, { userId: users.bob, outcome: 'none', ts: now - 1_000, tool: 'close_asset' });
    // An outcome whose intent is older than the window still counts as one write.
    await row(s, {
      kind: 'write',
      action: 'update_status',
      status: 'ok',
      details: { phase: 'outcome', intentId: 'gone', approval: 'page', fields: ['Status'] },
    });
    await row(s, { action: 'search_assets' });
    for (const who of [owner, admin]) {
      const res = await s.api('GET', '/audit/write-stats', who);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        total: unknown;
        byTool: { key: string }[];
        byChannel: { key: string; writes: number }[];
        unpaired: unknown[];
        scanned: number;
        truncated: boolean;
      };
      expect(body.total).toEqual({ key: 'all', writes: 6, ok: 3, error: 1, noOutcome: 1, inProgress: 1 });
      expect(body.byTool.find((r) => r.key === 'update_fields')).toMatchObject({
        writes: 3,
        ok: 2,
        noOutcome: 1,
      });
      expect(body.byTool.find((r) => r.key === 'add_comment')).toMatchObject({ writes: 1, error: 1 });
      expect(body.byChannel.map((r) => [r.key, r.writes])).toEqual([
        ['page', 5],
        ['elicitation', 1],
      ]);
      expect(body.unpaired).toEqual([
        expect.objectContaining({ intentId: lost.intent.id, tool: 'update_fields', targetId: 'Story:100' }),
      ]);
      expect(body.scanned).toBe(9);
      expect(body.truncated).toBe(false);
    }
    const none = (await (await s.api('GET', '/audit/write-stats?workspaceId=nope', owner)).json()) as {
      total: { writes: number };
    };
    expect(none.total.writes).toBe(0);
  });

  it('is refused to a member and to strangers, and reads nothing', async () => {
    const { s, alice, owner, users } = await env();
    await writePair(s, { userId: users.alice });
    const read = vi.spyOn(s.w.storage.audit, 'query');
    const denied = await s.api('GET', '/audit/write-stats', alice);
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain('update_fields');
    const anon = await s.send('GET', '/api/admin/v1/audit/write-stats', { site: 'none' });
    expect(anon.status).toBe(401);
    for (const query of ['from=abc', `workspaceId=${'x'.repeat(129)}`]) {
      expect((await s.api('GET', `/audit/write-stats?${query}`, owner)).status, query).toBe(422);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('reads at most three pages of write rows and says when it stopped there', async () => {
    const { s, owner } = await env();
    const read = vi.spyOn(s.w.storage.audit, 'query');
    for (let i = 0; i < 3_001; i++)
      await row(s, {
        kind: 'write',
        action: 'update_fields',
        details: { phase: 'outcome', intentId: `i-${i}`, approval: 'page', fields: [] },
      });
    const body = (await (await s.api('GET', '/audit/write-stats', owner)).json()) as {
      scanned: number;
      truncated: boolean;
    };
    expect(body).toMatchObject({ scanned: 3_000, truncated: true });
    expect(read).toHaveBeenCalledTimes(3);
  });
});

describe('write rows in the viewer and CSV', () => {
  it('a member reads only their own write rows, intent and outcome; another person is refused', async () => {
    const { s, alice, users } = await env();
    await writePair(s, { userId: users.alice, tool: 'mine_write' });
    await writePair(s, { userId: users.bob, tool: 'theirs_write' });
    const rows = (await (await s.api('GET', '/audit?kind=write', alice)).json()) as {
      action: string;
      details: { phase: string };
    }[];
    expect(rows.map((r) => `${r.action}:${r.details.phase}`)).toEqual([
      'mine_write:outcome',
      'mine_write:intent',
    ]);
    const forged = await s.api('GET', `/audit?kind=write&userId=${users.bob}`, alice);
    expect(forged.status).toBe(403);
    expect(await forged.text()).not.toContain('theirs_write');
    const html = await (await page(s, `/admin/audit?kind=write&user=${users.bob}`, alice)).text();
    expect(html).toContain('mine_write');
    expect(html).not.toContain('theirs_write');
    const csv = await (await page(s, '/admin/audit.csv?kind=write', alice)).text();
    expect(csv).toContain('mine_write');
    expect(csv).not.toContain('theirs_write');
  });

  it('shows phase, field names, channel and the pair; an old intent with no outcome is flagged', async () => {
    const { s, owner } = await env();
    const now = s.w.now.t;
    await writePair(s, { tool: 'tool_ok', outcome: 'ok', fields: ['Name', 'Description'] });
    await writePair(s, { tool: 'tool_err', outcome: 'error', approval: 'elicitation' });
    await writePair(s, { tool: 'tool_lost', outcome: 'none', ts: now - 3_600_000 });
    await writePair(s, { tool: 'tool_busy', outcome: 'none', ts: now - 1_000 });
    const html = await (await page(s, '/admin/audit?kind=write', owner)).text();
    expect(html).toContain('intent update');
    expect(html).toContain('outcome update');
    expect(html).toContain('fields: Name, Description');
    expect(html).toContain('approval: elicitation');
    expect(html).toContain('change aaaaaaaaaaaa');
    expect(html).toContain('outcome: ok');
    expect(html).toContain('outcome: error AB_AGILITY_REJECTED');
    expect(html).toContain('no outcome yet (in progress)');
    expect(html.match(/NO OUTCOME RECORDED/g)).toHaveLength(1);
    // An outcome filter hides the intents: nothing claims that a partner is missing.
    const filtered = await (await page(s, '/admin/audit?kind=write&status=error', owner)).text();
    expect(filtered).not.toContain('NO OUTCOME RECORDED');
    expect(filtered).toContain('outside this view');
  });

  it('the CSV has columns for phase, operation, channel, hash, field names and the pair, and empty ones for other rows', async () => {
    const { s, owner } = await env();
    const now = s.w.now.t;
    await row(s, { action: 'search_assets' });
    const ok = await writePair(s, { tool: 'tool_ok', outcome: 'ok', fields: ['Name', 'Estimate'] });
    await writePair(s, { tool: 'tool_lost', outcome: 'none', ts: now - 3_600_000 });
    const lines = (await (await page(s, '/admin/audit.csv', owner)).text()).trimEnd().split('\r\n');
    expect((lines[0] as string).split(',').slice(-7)).toEqual([
      'write_phase',
      'write_operation',
      'write_approval',
      'write_hash',
      'write_fields',
      'write_intent_id',
      'write_pair',
    ]);
    const tail = (action: string, phase?: string) => {
      const line = lines.find(
        (l) => l.includes(`"${action}"`) && (phase === undefined || l.includes(`,"${phase}","update"`)),
      );
      return (line as string).split(',').slice(-7);
    };
    expect(tail('tool_ok', 'intent')).toEqual([
      '"intent"',
      '"update"',
      '"page"',
      `"${'a'.repeat(64)}"`,
      '"Name Estimate"',
      `"${ok.intent.id}"`,
      '"outcome_found"',
    ]);
    expect(tail('tool_ok', 'outcome')[6]).toBe('"intent_found"');
    expect(tail('tool_lost', 'intent')[6]).toBe('"outcome_missing"');
    expect(tail('search_assets')).toEqual(['', '', '', '', '', '', '']);
  });

  it('hostile field names, tools and targets are inert on the page and in the CSV', async () => {
    const { s, owner } = await env();
    await writePair(s, { tool: 'evil_tool', fields: [EVIL, '=cmd|calc'], target: EVIL });
    const html = await (await page(s, '/admin/audit?kind=write', owner)).text();
    expect(html).not.toContain('<script>alert(2)');
    expect(html).not.toMatch(/<img[^>]*onerror/);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    const usage = await (await page(s, '/admin/usage', owner)).text();
    expect(usage).not.toContain('<script>alert(2)');
    expect(usage).toContain('Writes');
    const csv = await (await page(s, '/admin/audit.csv?kind=write', owner)).text();
    expect(csv).not.toContain('<script>alert(2)'.replace('<', '\n<'));
    // The details JSON cell holds the field name; the write_fields cell is quoted text (a formula would be neutralised).
    expect(csv).toContain('"update"');
  });
});
