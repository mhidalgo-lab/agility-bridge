// SPDX-License-Identifier: Apache-2.0
// The panel stays out of MCP requests (P4-03, P3-14, L-182): it is imported and built on the first panel or sign-in page,
// never by an MCP call, the admin API, a health check or a refused request, on Node and in the Workers configuration.
import { describe, expect, it, vi } from 'vitest';
import { setup } from './helpers/panel.ts';
import { post } from './helpers/world.ts';

const loads = vi.hoisted(() => ({ count: 0, failNext: false }));
vi.mock('../src/admin-ui.ts', async (original) => {
  const real = await original<typeof import('../src/admin-ui.ts')>();
  return {
    ...real,
    loadAdminUiModule: () => {
      loads.count++;
      if (loads.failNext) {
        loads.failNext = false;
        return Promise.reject(new Error('the panel could not be loaded'));
      }
      return real.loadAdminUiModule();
    },
  };
});

const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

describe.each([
  ['Node', undefined],
  ['Workers', 'request' as const],
])('the panel is loaded lazily (%s)', (_name, isolation) => {
  it('never by MCP requests, the admin API or health checks; once, by the first page; then reused', async () => {
    const s = await setup(isolation === undefined ? {} : { isolation });
    loads.count = 0;
    const host = { host: '127.0.0.1:8787' };

    const list = await post(s.w, 'team-a', s.w.tokens.alice, LIST);
    expect(list.status).toBe(200);
    expect((await post(s.w, 'team-a', null, LIST)).status).toBe(401);
    expect((await s.w.app.fetch(new Request('http://127.0.0.1:8787/health', { headers: host }))).status).toBe(
      200,
    );
    expect(
      (await s.w.app.fetch(new Request('http://127.0.0.1:8787/version', { headers: host }))).status,
    ).toBe(200);
    expect((await s.w.app.fetch(new Request('http://127.0.0.1:8787/nope', { headers: host }))).status).toBe(
      404,
    );
    expect(
      (
        await s.w.app.fetch(
          new Request('http://127.0.0.1:8787/api/admin/v1/users', {
            headers: { ...host, 'x-test-actor': 'owner' },
          }),
        )
      ).status,
    ).toBe(200);
    // A request the edge refuses never reaches a page either.
    const refused = await s.w.app.fetch(
      new Request('http://127.0.0.1:8787/admin', { headers: { host: 'evil.test' } }),
    );
    expect(refused.status).toBe(403);
    expect(loads.count).toBe(0);

    const first = await s.send('GET', '/admin', { site: 'none' });
    expect(first.status).toBe(303);
    expect(loads.count).toBe(1);
    expect((await s.send('GET', '/auth/login', { site: 'none' })).status).toBe(200);
    expect((await s.send('GET', '/admin/account', { site: 'none' })).status).toBe(303);
    // Imported once per app, however many pages follow.
    expect(loads.count).toBe(1);
  });

  it('a failed import answers 500 without detail, and the next request imports again', async () => {
    const s = await setup(isolation === undefined ? {} : { isolation });
    loads.count = 0;
    loads.failNext = true;
    const failed = await s.send('GET', '/admin', { site: 'none' });
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain('could not be loaded');
    expect(loads.count).toBe(1);
    expect((await s.send('GET', '/admin', { site: 'none' })).status).toBe(303);
    expect(loads.count).toBe(2);
    // The sign-in pages need the panel too, and fail the same way.
    const again = await setup(isolation === undefined ? {} : { isolation });
    loads.failNext = true;
    expect((await again.send('GET', '/auth/login', { site: 'none' })).status).toBe(500);
    expect((await again.send('GET', '/auth/login', { site: 'none' })).status).toBe(200);
  });
});
