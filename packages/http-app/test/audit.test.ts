// SPDX-License-Identifier: Apache-2.0
// The audit log (P2-08, THREAT_MODEL T8, T17): what a row holds and, above all, what it never holds.
import { auditFacts } from '@agility-bridge/core';
import { createMemoryStorage, type Storage } from '@agility-bridge/storage';
import { describe, expect, it } from 'vitest';
import { tamperLast } from '../../auth/test/helpers/tamper.ts';
import { purgeAudit, scheduleAuditRetention } from '../src/index.ts';
import { ALICE_AGILITY, BOB_AGILITY, connect, post, world } from './helpers/world.ts';

const SEARCH_VALUE = 'Confidential-Merger-Plan';

describe('tool-call rows', () => {
  it('record who, through which grant and device, what, how long and how many Agility requests', async () => {
    const w = await world();
    const client = await connect(w, 'team-a', w.tokens.alice);
    await client.callTool({ name: 'get_assets', arguments: { assets: ['B-00001'] } });
    await client.callTool({
      name: 'query_assets',
      arguments: { asset_type: 'Story', filters: [{ field: 'Name', op: 'contains', value: SEARCH_VALUE }] },
    });
    await client.close();
    await w.audit.flush();
    const rows = (await w.storage.audit.query({ kind: 'tool_call' })).sort((a, b) =>
      a.action.localeCompare(b.action),
    );
    expect(rows.map((r) => r.action)).toEqual(['get_assets', 'query_assets']);
    const [get, query] = rows as [(typeof rows)[0], (typeof rows)[0]];
    const tokenRow = await w.storage.accessTokens.get(w.ids.aliceToken);
    expect(get).toMatchObject({
      status: 'ok',
      grantId: w.ids.aliceGrant,
      tokenId: w.ids.aliceToken,
      workspaceId: w.ids.workspaceA,
      assetNumbers: ['B-00001'],
      details: { credential: 'personal' },
    });
    expect(get.userId).not.toBeNull();
    expect(get.agilityRequests).toBeGreaterThan(0);
    expect(get.durationMs).toBeGreaterThanOrEqual(0);
    expect(tokenRow?.id).toBe(get.tokenId);
    // The compiled query with its bound values masked.
    expect(query.query).toContain('Story');
    expect(query.query).toContain('…');
    expect(query.query).not.toContain(SEARCH_VALUE);
  });

  it('a failed tool call is recorded with its error code', async () => {
    const w = await world();
    const client = await connect(w, 'team-a', w.tokens.alice);
    await client.callTool({ name: 'query_assets', arguments: { asset_type: 'NoSuchType' } });
    await client.close();
    await w.audit.flush();
    const [row] = await w.storage.audit.query({ kind: 'tool_call' });
    expect(row).toMatchObject({ action: 'query_assets', status: 'error' });
    expect(row?.errorCode).toMatch(/^AB_/);
  });
});

describe('no secrets, bodies or Agility content in any row', () => {
  it('scans every row after tool calls, refusals and an admin change', async () => {
    const w = await world();
    const client = await connect(w, 'team-a', w.tokens.alice);
    await client.callTool({ name: 'whoami', arguments: {} });
    await client.callTool({ name: 'get_assets', arguments: { assets: ['B-00001', 'B-00002'] } });
    await client.callTool({
      name: 'query_assets',
      arguments: {
        asset_type: 'Story',
        filters: [{ field: 'Name', op: 'eq', value: SEARCH_VALUE }],
        fields: ['Name'],
      },
    });
    await client.close();
    await post(w, 'team-a', tamperLast(w.tokens.alice), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    await post(w, 'team-b', w.tokens.alice, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'whoami', arguments: { note: SEARCH_VALUE } },
    });
    w.audit.admin({
      action: 'grant.create',
      targetType: 'grant',
      targetId: w.ids.aliceGrant,
      details: { fields: ['tools'] },
      via: 'cli',
    });
    await w.audit.flush();
    const dump = JSON.stringify(await w.storage.audit.query({ limit: 1_000 }));
    expect(dump.length).toBeGreaterThan(500);
    const forbidden = [
      w.tokens.alice,
      w.tokens.alice.slice(8, 30),
      w.tokens.bob.slice(8, 30),
      ALICE_AGILITY,
      BOB_AGILITY,
      SEARCH_VALUE,
      'Mobile App', // project name
      'Ann Example', // member name
      'In A', // story title
      'Bearer',
    ];
    for (const secret of forbidden) expect(dump, secret).not.toContain(secret);
    expect(dump).toContain('mcp.unauthenticated');
    expect(dump).toContain('grant.create');
  });
});

describe('refusal rows', () => {
  it('record authentication refusals with the reason, and cap them per minute with a summary', async () => {
    const w = await world();
    for (let i = 0; i < 70; i++)
      await post(w, 'team-a', null, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    await w.audit.flush();
    let rows = await w.storage.audit.query({ kind: 'auth', limit: 1_000 });
    // 60 rows, plus the summary of the 10 suppressed ones (a flush writes it, as at shutdown).
    expect(rows.filter((r) => r.action === 'mcp.unauthenticated')).toHaveLength(60);
    expect(rows.find((r) => r.action === 'audit.refusals_suppressed')?.details).toMatchObject({
      suppressed: 10,
    });
    expect(rows.find((r) => r.action === 'mcp.unauthenticated')).toMatchObject({
      action: 'mcp.unauthenticated',
      status: 'denied',
      errorCode: 'AB_AUTH_UNAUTHORIZED',
      // No method: the body of an unauthenticated request is never read.
      details: { reason: 'no_token', slug: 'team-a', ip: 'unknown' },
    });
    w.now.t += 60_000;
    await post(w, 'team-a', null, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    await w.audit.flush();
    rows = await w.storage.audit.query({ kind: 'auth', limit: 1_000 });
    expect(rows).toHaveLength(62);
    // Without a flush, the summary is written when the next minute's first refusal arrives.
    const v = await world();
    for (let i = 0; i < 62; i++)
      await post(v, 'team-a', null, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    v.now.t += 61_000;
    await post(v, 'team-a', null, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    await v.audit.flush();
    const vr = await v.storage.audit.query({ kind: 'auth', limit: 1_000 });
    expect(vr.find((r) => r.action === 'audit.refusals_suppressed')?.details).toMatchObject({
      suppressed: 2,
    });
  });

  it('a failing audit store never fails or slows the request; the failure is logged', async () => {
    const failing = (s: Storage): Storage => ({
      ...s,
      audit: { ...s.audit, append: () => Promise.reject(new Error('disk full')) },
    });
    const w = await world({}, { auditStorage: failing });
    const client = await connect(w, 'team-a', w.tokens.alice);
    const r = await client.callTool({ name: 'whoami', arguments: {} });
    expect(r.isError).toBeFalsy();
    await client.close();
    await w.audit.flush();
    expect(w.logs.some((l) => l.includes('audit write failed'))).toBe(true);
    await expect(w.audit.writeIntent({ kind: 'write', action: 'add_comment', status: 'ok' })).rejects.toThrow(
      'disk full',
    );
  });
});

describe('retention', () => {
  it('purges rows older than the retention in batches; 0 keeps everything', async () => {
    const day = 86_400_000;
    const now = Date.UTC(2026, 9, 21);
    const s = createMemoryStorage({ now: () => now });
    for (let i = 0; i < 2_500; i++) {
      await s.audit.append({
        id: `old-${i}`,
        ts: now - 100 * day,
        kind: 'tool_call',
        action: 'x',
        status: 'ok',
      });
    }
    await s.audit.append({ id: 'recent', ts: now - 10 * day, kind: 'tool_call', action: 'x', status: 'ok' });
    expect(await purgeAudit(s, 0, now)).toBe(0);
    expect(await purgeAudit(s, 90, now)).toBe(2_500);
    expect((await s.audit.query()).map((r) => r.id)).toEqual(['recent']);
  });

  it('runs at start and on its interval, and stops', async () => {
    const now = Date.UTC(2026, 9, 21);
    const s = createMemoryStorage({ now: () => now });
    await s.audit.append({
      id: 'old',
      ts: now - 100 * 86_400_000,
      kind: 'auth',
      action: 'x',
      status: 'denied',
    });
    const logs: string[] = [];
    const logger = { info: (m: string) => logs.push(m), error: (m: string) => logs.push(m) } as never;
    const stop = scheduleAuditRetention(s, 90, { now: () => now }, logger, 10);
    await new Promise((r) => setTimeout(r, 30));
    stop();
    expect(await s.audit.query()).toEqual([]);
    expect(logs).toContain('audit retention');
    expect(scheduleAuditRetention(s, 0, { now: () => now }, logger)).toBeTypeOf('function');
  });
});

describe('auditFacts', () => {
  it('takes asset numbers from result rows and masked queries from _meta, bounded', () => {
    const rows = Array.from({ length: 80 }, (_, i) => ({ number: `B-${i}`, name: 'x' }));
    const facts = auditFacts({
      text: '',
      structured: { items: rows, nested: { number: 'not a number' } },
      meta: { 'agility-bridge/result': { queries: [{ from: 'Story' }, 'x'.repeat(5_000)] } },
    });
    expect(facts.assetNumbers).toHaveLength(50);
    expect(facts.assetNumbers[0]).toBe('B-0');
    expect(facts.queries[0]).toBe('{"from":"Story"}');
    expect(facts.queries[1]).toHaveLength(2_001);
    expect(auditFacts(undefined)).toEqual({ assetNumbers: [], queries: [] });
  });
});
