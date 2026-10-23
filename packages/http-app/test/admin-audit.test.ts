// SPDX-License-Identifier: Apache-2.0
// The audit viewer and usage statistics over HTTP (P4-05, THREAT_MODEL T13, T17, T8, T3): the admin API routes and the
// panel screens driven like a browser against real sessions and memory storage (the same storage contract as SQLite and
// D1). A member sees only their own rows whatever they send, filters narrow and never widen, keyset paging is stable while
// rows arrive, hostile strings are inert on the page and in the CSV, formulas are neutralised, a refusal reads nothing, and
// no secret reaches either. No network.
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

const page = (s: S, path: string, who: Session | undefined, headers: Record<string, string> = {}) =>
  s.send('GET', path, { ...(who === undefined ? {} : { cookie: who.cookie }), site: 'none', headers });

let seq = 0;
/** Appends a row at the world's current time (distinct ids, so ordering is by `ts` then id). */
async function row(s: S, over: Partial<NewAuditEntry> & { ts?: number } = {}): Promise<NewAuditEntry> {
  seq++;
  const entry: NewAuditEntry = {
    id: `row-${String(seq).padStart(6, '0')}`,
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
    owner: (await s.w.storage.users.getByEmail(OWNER))?.id as string,
    admin: (await s.w.storage.users.getByEmail(ADMIN))?.id as string,
    alice: (await s.w.storage.users.getByEmail(ALICE))?.id as string,
    bob: (await s.w.storage.users.getByEmail(BOB))?.id as string,
  };
  await s.w.audit.flush();
  // Start from an empty log: the sign-ins above wrote rows of their own.
  await s.w.storage.audit.purge(Number.MAX_SAFE_INTEGER, 10_000);
  return { s, owner, admin, alice, users };
}

/** The action names listed in a page (the `<code>` of the Action column). */
const actionsOn = (html: string): string[] =>
  [...html.matchAll(/<td><code>([^<]*)<\/code><br\/?>/g)].map((m) => m[1] as string);

describe('GET /audit (admin API)', () => {
  it('owner and admin read every row, newest first, with every filter narrowing as stated', async () => {
    const { s, owner, admin, users } = await env();
    await row(s, { action: 'get_work_item', userId: users.alice, workspaceId: 'w-a' });
    await row(s, { action: 'get_work_item', userId: users.bob, workspaceId: 'w-b', status: 'error' });
    await row(s, { action: 'grant.revoke', kind: 'admin', userId: users.owner, workspaceId: 'w-a' });
    await row(s, { action: 'mcp.unauthenticated', kind: 'auth', status: 'denied' });
    for (const who of [owner, admin]) {
      const all = (await (await s.api('GET', '/audit', who)).json()) as { action: string }[];
      expect(all.map((r) => r.action)).toEqual([
        'mcp.unauthenticated',
        'grant.revoke',
        'get_work_item',
        'get_work_item',
      ]);
    }
    const q = async (query: string) =>
      ((await (await s.api('GET', `/audit?${query}`, owner)).json()) as { userId: string | null }[]).length;
    expect(await q('action=get_work_item')).toBe(2);
    expect(await q(`action=get_work_item&userId=${users.bob}`)).toBe(1);
    expect(await q('action=get_work_item&workspaceId=w-a')).toBe(1);
    expect(await q('kind=admin')).toBe(1);
    expect(await q('status=denied')).toBe(1);
    expect(await q('status=error&workspaceId=w-a')).toBe(0);
    expect(await q(`from=${s.w.now.t + 1_000_000}`)).toBe(0);
  });

  it('a member reads only their own rows, whatever they send; another userId is refused', async () => {
    const { s, alice, users } = await env();
    await row(s, { action: 'mine_1', userId: users.alice, workspaceId: 'w-a' });
    await row(s, { action: 'theirs_1', userId: users.bob, workspaceId: 'w-a' });
    await row(s, { action: 'mine_2', kind: 'admin', userId: users.alice, workspaceId: 'w-b' });
    await row(s, { action: 'nobody', kind: 'auth', status: 'denied' });
    await row(s, { action: 'theirs_2', userId: users.owner });
    const seen = async (query = '') => {
      const res = await s.api('GET', `/audit${query}`, alice);
      expect(res.status, query).toBe(200);
      return ((await res.json()) as { action: string }[]).map((r) => r.action);
    };
    expect(await seen()).toEqual(['mine_2', 'mine_1']);
    // Filters narrow within their own rows and never widen them.
    expect(await seen('?workspaceId=w-a')).toEqual(['mine_1']);
    expect(await seen('?kind=auth')).toEqual([]);
    expect(await seen('?status=denied')).toEqual([]);
    expect(await seen('?action=theirs_1')).toEqual([]);
    expect(await seen(`?userId=${users.alice}`)).toEqual(['mine_2', 'mine_1']);
    expect(await seen('?limit=1000&from=0')).toEqual(['mine_2', 'mine_1']);
    // A cursor into someone else's rows reveals none of them.
    const all = await s.w.storage.audit.query();
    const cursor = all.find((r) => r.action === 'theirs_2');
    expect(await seen(`?afterTs=${(cursor?.ts ?? 0) + 1}&afterId=${cursor?.id}`)).toEqual([
      'mine_2',
      'mine_1',
    ]);
    for (const other of [users.bob, users.owner, 'nobody', "x' OR '1'='1"]) {
      const res = await s.api('GET', `/audit?userId=${encodeURIComponent(other)}`, alice);
      expect(res.status, other).toBe(403);
      const text = await res.text();
      expect(text).not.toContain('theirs');
      expect(text).not.toContain('mine_');
    }
  });

  it('refuses a bad filter, cursor, limit or action without reading the log', async () => {
    const { s, owner } = await env();
    const read = vi.spyOn(s.w.storage.audit, 'query');
    for (const query of [
      'limit=0',
      'limit=1001',
      'afterTs=-1&afterId=x',
      'from=abc',
      'kind=other',
      'status=nope',
      `action=${encodeURIComponent("x' OR 1=1 --")}`,
      `action=${'a'.repeat(101)}`,
    ]) {
      const res = await s.api('GET', `/audit?${query}`, owner);
      expect(res.status, query).toBe(422);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('is refused without credentials and reads nothing', async () => {
    const { s } = await env();
    const read = vi.spyOn(s.w.storage.audit, 'query');
    const stats = vi.spyOn(s.w.storage.audit, 'stats');
    for (const path of ['/audit', '/audit/stats?groupBy=tool']) {
      const res = await s.send('GET', `/api/admin/v1${path}`, { site: 'none' });
      expect(res.status, path).toBe(401);
    }
    expect(read).not.toHaveBeenCalled();
    expect(stats).not.toHaveBeenCalled();
  });
});

describe('GET /audit/stats (admin API)', () => {
  it('owner and admin get bounded aggregates; a member is refused and nothing is read', async () => {
    const { s, owner, admin, alice, users } = await env();
    await row(s, {
      action: 'get_work_item',
      userId: users.alice,
      workspaceId: 'w-a',
      grantId: 'g-1',
      durationMs: 100,
      agilityRequests: 2,
    });
    await row(s, {
      action: 'get_work_item',
      userId: users.bob,
      workspaceId: 'w-a',
      grantId: 'g-2',
      durationMs: 300,
      status: 'error',
    });
    await row(s, {
      action: 'search_assets',
      userId: users.alice,
      workspaceId: 'w-b',
      grantId: 'g-1',
      status: 'denied',
    });
    await row(s, { action: 'grant.revoke', kind: 'admin' });
    for (const who of [owner, admin]) {
      const res = await s.api('GET', '/audit/stats?groupBy=tool', who);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        data: [
          {
            key: 'get_work_item',
            calls: 2,
            errors: 1,
            denied: 0,
            agilityRequests: 2,
            durationSumMs: 400,
            durationCount: 2,
            maxDurationMs: 300,
          },
          {
            key: 'search_assets',
            calls: 1,
            errors: 0,
            denied: 1,
            agilityRequests: 0,
            durationSumMs: 0,
            durationCount: 0,
            maxDurationMs: null,
          },
        ],
        scanned: 3,
        truncated: false,
      });
    }
    const keys = async (query: string) =>
      (
        (await (await s.api('GET', `/audit/stats?${query}`, owner)).json()) as { data: { key: string }[] }
      ).data.map((r) => r.key);
    expect(await keys('groupBy=workspace')).toEqual(['w-a', 'w-b']);
    expect(await keys('groupBy=grant')).toEqual(['g-1', 'g-2']);
    expect(await keys('groupBy=user&workspaceId=w-b')).toEqual([users.alice]);
    expect(await keys('groupBy=day')).toHaveLength(1);
    expect(await keys('groupBy=tool&limit=1')).toHaveLength(1);

    const stats = vi.spyOn(s.w.storage.audit, 'stats');
    const denied = await s.api('GET', '/audit/stats?groupBy=tool', alice);
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain('get_work_item');
    expect(stats).not.toHaveBeenCalled();
  });

  it('refuses unknown groupings and oversized limits', async () => {
    const { s, owner } = await env();
    for (const query of [
      '',
      'groupBy=password',
      'groupBy=tool&limit=101',
      'groupBy=tool&limit=0',
      'groupBy=tool&from=-5',
    ]) {
      expect((await s.api('GET', `/audit/stats?${query}`, owner)).status, query).toBe(422);
    }
  });
});

describe('audit screen', () => {
  it('renders for every role as the API allows; usage is for owners and admins; strangers sign in first', async () => {
    const { s, owner, admin, alice } = await env();
    await row(s);
    for (const who of [owner, admin, alice]) {
      const res = await page(s, '/admin/audit', who);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const html = await res.text();
      // The role matrix of the controls equals the API's: owner filters and the usage link only for owner and admin.
      const adminControls = who !== alice;
      expect(html.includes('name="user"'), 'user filter').toBe(adminControls);
      expect(html.includes('name="workspace"'), 'workspace filter').toBe(adminControls);
      expect(html.includes('/admin/usage'), 'usage link').toBe(adminControls);
      expect(html.includes('href="/admin/audit.csv'), 'csv link').toBe(true);
      expect((await page(s, '/admin/usage', who)).status).toBe(adminControls ? 200 : 403);
    }
    for (const path of ['/admin/audit', '/admin/audit.csv', '/admin/usage']) {
      const res = await page(s, path, undefined);
      expect(res.status, path).toBe(303);
      expect(res.headers.get('location')).toMatch(/^\/auth\/login/);
    }
  });

  it('a member sees only their own rows and cannot widen the view with the URL', async () => {
    const { s, alice, users } = await env();
    await row(s, { action: 'mine_one', userId: users.alice });
    await row(s, { action: 'theirs_one', userId: users.bob });
    await row(s, { action: 'theirs_two', userId: users.owner, kind: 'admin' });
    await row(s, { action: 'stranger', kind: 'auth', status: 'denied' });
    for (const query of [
      '',
      `?user=${users.bob}`,
      `?user=${users.owner}&kind=admin`,
      '?workspace=x&status=denied',
      `?after=${Date.now() + 1}.zzz`,
    ]) {
      const res = await page(s, `/admin/audit${query}`, alice);
      expect(res.status, query).toBe(200);
      const html = await res.text();
      expect(html, query).not.toMatch(/theirs_|stranger/);
      if (query === '' || query === `?user=${users.bob}` || query.startsWith('?after='))
        expect(actionsOn(html), query).toEqual(['mine_one']);
      else expect(actionsOn(html), query).toEqual([]);
    }
    const csv = await (await page(s, `/admin/audit.csv?user=${users.bob}`, alice)).text();
    expect(csv).toContain('mine_one');
    expect(csv).not.toMatch(/theirs_|stranger/);
  });

  it('filters by time range, kind, outcome, action, workspace and user, and ignores values it does not know', async () => {
    const { s, owner, users } = await env();
    const now = s.w.now.t;
    await row(s, { action: 'old_call', ts: now - 3 * 86_400_000, userId: users.alice, workspaceId: 'w-a' });
    await row(s, { action: 'new_call', userId: users.alice, workspaceId: 'w-a' });
    await row(s, { action: 'other_user', userId: users.bob, workspaceId: 'w-b', status: 'error' });
    await row(s, { action: 'admin_change', kind: 'admin', userId: users.owner, status: 'denied' });
    const on = async (query: string) =>
      actionsOn(await (await page(s, `/admin/audit${query}`, owner)).text());
    s.w.now.t = now;
    expect(await on('')).toEqual(
      expect.arrayContaining(['new_call', 'other_user', 'admin_change', 'old_call']),
    );
    expect(await on('?range=24h')).toEqual(['admin_change', 'other_user', 'new_call']);
    expect(await on('?range=1h&kind=tool_call')).toEqual(['other_user', 'new_call']);
    expect(await on('?kind=admin')).toEqual(['admin_change']);
    expect(await on('?status=error')).toEqual(['other_user']);
    expect(await on('?action=new_call')).toEqual(['new_call']);
    expect(await on('?workspace=w-b')).toEqual(['other_user']);
    expect(await on(`?user=${users.alice}&range=24h`)).toEqual(['new_call']);
    expect(await on('?workspace=w-a&status=error')).toEqual([]);
    // Unknown or hostile values are dropped (the default view) and never reach the API or a link.
    const odd = await page(
      s,
      `/admin/audit?range=forever&kind=${encodeURIComponent(EVIL)}&user=${encodeURIComponent(EVIL)}&action=${encodeURIComponent(EVIL)}&after=nope`,
      owner,
    );
    expect(odd.status).toBe(200);
    const html = await odd.text();
    expect(html).not.toContain('<script>alert(2)');
    expect(html).not.toContain('onerror=alert');
  });

  it('pages by keyset, 50 at a time: nothing repeated or skipped while rows keep arriving', async () => {
    const { s, owner, users } = await env();
    // Equal timestamps in blocks exercise the id tie-break.
    const base = s.w.now.t;
    for (let i = 0; i < 120; i++)
      await row(s, {
        action: `act_${String(i).padStart(3, '0')}`,
        ts: base + Math.floor(i / 7),
        userId: users.alice,
      });
    const seen: string[] = [];
    let path: string | null = '/admin/audit';
    let pages = 0;
    while (path !== null) {
      const html = await (await page(s, path, owner)).text();
      const shown = actionsOn(html);
      expect(shown.length).toBeLessThanOrEqual(50);
      seen.push(...shown);
      pages++;
      // Rows arrive between pages: newest of all, so a page boundary must not shift.
      await row(s, { action: `late_${pages}`, ts: base + 1_000 + pages });
      const next: string | null = /href="([^"]+)">Next page/.exec(html)?.[1] ?? null;
      path = next === null ? null : next.replaceAll('&amp;', '&');
      expect(pages).toBeLessThan(10);
    }
    const originals = seen.filter((a) => a.startsWith('act_'));
    expect(pages).toBe(3);
    expect(new Set(originals).size).toBe(120);
    expect(new Set(seen).size).toBe(seen.length);
    // Newest first, with the id order inside equal timestamps.
    const rows = await s.w.storage.audit.query({ limit: 1_000 });
    expect(originals).toEqual(rows.filter((r) => r.action.startsWith('act_')).map((r) => r.action));
    // The first page link returns to the newest page and a page past the end is just empty.
    const second = await (await page(s, `/admin/audit?after=${base + 1}.zzzzzz`, owner)).text();
    expect(second).toContain('Newest entries');
  });

  it('shows every stored string as text: hostile actions, codes, queries, targets and details are inert', async () => {
    const { s, owner, admin } = await env();
    await row(s, {
      action: EVIL,
      errorCode: EVIL,
      targetType: EVIL,
      targetId: EVIL,
      requestId: EVIL,
      clientId: EVIL,
      assetNumbers: [EVIL],
      query: `{ ${EVIL} } with $v0=... ${'x'.repeat(5_000)}`,
      details: { reason: EVIL, nested: { a: [EVIL] } },
    });
    for (const who of [owner, admin]) {
      for (const path of ['/admin/audit', '/admin/audit?kind=tool_call']) {
        const html = await (await page(s, path, who)).text();
        expect(html).not.toContain('<script>alert(2)');
        expect(html).not.toMatch(/<img[^>]*onerror/);
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
        // Long queries are cut for display.
        expect(html).not.toContain('x'.repeat(2_000));
      }
    }
    const usage = await (await page(s, '/admin/usage?by=tool', owner)).text();
    expect(usage).not.toContain('<script>alert(2)');
    expect(usage).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('never shows a secret the log does not hold: a device token, credential token and session are in no row, page or file', async () => {
    const { s, owner } = await env();
    const token = `1.${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
    const created = await s.api('POST', '/credentials', owner, {
      instanceId: s.w.ids.instance,
      ownerUserId: null,
      label: 'shared',
      token,
    });
    expect(created.status).toBe(201);
    const issued = await (
      await s.api('POST', `/grants/${s.w.ids.aliceGrant}/tokens`, owner, { label: 'laptop' })
    ).json();
    await s.w.audit.flush();
    const html = await (await page(s, '/admin/audit', owner)).text();
    const csv = await (await page(s, '/admin/audit.csv', owner)).text();
    const usage = await (await page(s, '/admin/usage', owner)).text();
    expect(html).toContain('credential.create');
    for (const secret of [token, issued.token as string, owner.cookie.split('=')[1] as string]) {
      for (const text of [html, csv, usage]) expect(text).not.toContain(secret);
    }
  });
});

describe('audit CSV', () => {
  it('is a download with the log filter, safe headers and one quoted, escaped cell per value', async () => {
    const { s, owner, users } = await env();
    await row(s, {
      action: 'search_assets',
      userId: users.alice,
      query: 'say "hi", then\nbye',
      assetNumbers: ['B-1', 'B-2'],
      durationMs: 12,
    });
    await row(s, { action: 'other', kind: 'admin' });
    const res = await page(s, '/admin/audit.csv?kind=tool_call', owner);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="audit-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-export-truncated')).toBeNull();
    const text = await res.text();
    const [header, ...lines] = text.split('\r\n');
    expect(header?.split(',')[0]).toBe('time');
    expect(text).toContain('"search_assets"');
    expect(text).toContain('"say ""hi"", then\nbye"');
    expect(text).toContain('"B-1 B-2"');
    expect(text).not.toContain('other');
    expect(lines.filter((l) => l !== '').length).toBeGreaterThanOrEqual(1);
  });

  it('neutralises formulas in every column a caller can influence', async () => {
    const { s, owner } = await env();
    const hostile = [
      '=HYPERLINK("http://evil.test","x")',
      '+1+1',
      '-2',
      '@SUM(1)',
      '\tcmd',
      '\rcmd',
      '\ncmd',
      '  =1+1',
      ' \t@x',
    ];
    for (const h of hostile) {
      // Only the query may hold control characters (storage refuses them in every other column).
      const plain = !/[\t\r\n]/.test(h);
      await row(
        s,
        plain
          ? { action: h, errorCode: h, targetId: h, targetType: h, query: h, requestId: h, details: { a: h } }
          : { query: h, details: { a: h } },
      );
    }
    const text = await (await page(s, '/admin/audit.csv', owner)).text();
    for (const h of hostile) {
      const quoted = h.replaceAll('"', '""');
      // The neutralised cell is there, and no cell carries the value unprefixed (after a comma or at a line start).
      expect(text, JSON.stringify(h)).toContain(`"'${quoted}"`);
      expect(text, JSON.stringify(h)).not.toContain(`,"${quoted}"`);
      expect(text, JSON.stringify(h)).not.toContain(`\r\n"${quoted}"`);
    }
    // Details are JSON, so they start with a brace: safe by construction.
    expect(text).toContain('"\'=HYPERLINK(');
  });

  it('is capped at 1,000 rows and says so; a cross-site navigation lands on the page instead of downloading', async () => {
    const { s, owner } = await env();
    for (let i = 0; i < 1_001; i++) await row(s, { action: `bulk_${i}` });
    const res = await page(s, '/admin/audit.csv', owner);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-export-truncated')).toBe('1000');
    const text = await res.text();
    expect(text.split('\r\n').length).toBe(1_002);
    const cross = await s.send('GET', '/admin/audit.csv?kind=admin', {
      cookie: owner.cookie,
      site: 'cross-site',
      headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
    });
    expect(cross.status).toBe(303);
    expect(cross.headers.get('location')).toBe('/admin/audit?kind=admin');
    expect(cross.headers.get('content-disposition')).toBeNull();
    // A cross-site subresource request is refused outright.
    const sub = await s.send('GET', '/admin/audit.csv', {
      cookie: owner.cookie,
      site: 'cross-site',
      headers: { 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' },
    });
    expect(sub.status).toBe(403);
    expect(await sub.text()).not.toContain('bulk_');
  });
});

describe('usage screen', () => {
  it('shows calls, errors, denials, Agility requests and durations per group, and nothing for a member', async () => {
    const { s, owner, admin, alice, users } = await env();
    await row(s, {
      action: 'get_work_item',
      userId: users.alice,
      workspaceId: s.w.ids.workspaceA,
      durationMs: 100,
      agilityRequests: 3,
    });
    await row(s, {
      action: 'get_work_item',
      userId: users.bob,
      workspaceId: s.w.ids.workspaceA,
      durationMs: 300,
      status: 'error',
    });
    await row(s, { action: EVIL, userId: users.alice, status: 'denied' });
    await row(s, { action: 'grant.revoke', kind: 'admin' });
    for (const who of [owner, admin]) {
      const html = await (await page(s, '/admin/usage', who)).text();
      expect(html).toContain('get_work_item');
      expect(html).toContain('1 (50.0%)'); // one error of two calls
      expect(html).toContain('200 ms'); // mean of 100 and 300
      expect(html).toContain('300 ms'); // slowest
      expect(html).not.toContain('grant.revoke');
      expect(html).not.toContain('<script>alert(2)');
      expect(html).toMatch(/<meter[^>]*max="2"[^>]*value="2"/);
      expect(html).not.toMatch(/style=/);
      const byWorkspace = await (await page(s, '/admin/usage?by=workspace', who)).text();
      expect(byWorkspace).toContain('team-a');
      const byUser = await (await page(s, '/admin/usage?by=user&window=30d', who)).text();
      expect(byUser).toContain(ALICE);
      expect((await page(s, '/admin/usage?by=nonsense&window=never', who)).status).toBe(200);
    }
    const denied = await page(s, '/admin/usage', alice);
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain('get_work_item');
  });

  it('asks the API only for bounded statistics (one aggregate, at most 50 groups)', async () => {
    const { s, owner } = await env();
    const stats = vi.spyOn(s.w.storage.audit, 'stats');
    const query = vi.spyOn(s.w.storage.audit, 'query');
    await page(s, '/admin/usage?by=tool&window=24h', owner);
    expect(stats).toHaveBeenCalledTimes(1);
    expect(stats.mock.calls[0]?.[0]).toMatchObject({ groupBy: 'tool', limit: 50 });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('audit pages read through the admin API, never storage directly', () => {
  it('a page view is one API read of at most 51 rows', async () => {
    const { s, owner } = await env();
    const query = vi.spyOn(s.w.storage.audit, 'query');
    await page(s, '/admin/audit?range=7d', owner);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toMatchObject({ limit: 51 });
    query.mockClear();
    await page(s, '/admin/audit.csv', owner);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toMatchObject({ limit: 1_000 });
  });
});
