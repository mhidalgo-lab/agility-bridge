// SPDX-License-Identifier: Apache-2.0
// Fake server side for the panel's tests: sessions chosen by a header, recorded admin API calls, recorded refusals.
import { Hono } from 'hono';
import { createAdminUi } from '../../src/app.ts';
import type { AdminCall, AdminCallResult, AdminUiDeps, UiPrincipal } from '../../src/kit.ts';

export const CSRF: string = 'csrf-token-of-the-session';
export const NOW: number = Date.UTC(2026, 9, 21, 12);

export const principal = (
  role: 'owner' | 'admin' | 'member',
  over: Partial<UiPrincipal> = {},
): UiPrincipal => ({
  userId: `usr_${role}`,
  email: `${role}@example.test`,
  displayName: null,
  role,
  csrf: CSRF,
  recentAuth: true,
  expiresAt: NOW + 3_600_000,
  idleExpiresAt: NOW + 1_800_000,
  ...over,
});

export interface Fake {
  readonly deps: AdminUiDeps;
  /** Admin API calls the panel made. */
  readonly calls: AdminCall[];
  /** Reasons the panel reported as refused requests. */
  readonly forbidden: string[];
  /** What the next admin API call answers. */
  answer: AdminCallResult;
  /** Answers per call, ahead of `answer` (return undefined to fall through). */
  respond?: (call: AdminCall) => AdminCallResult | undefined;
  /** The single-use handles in the fake store (key to present). */
  readonly once: Map<string, true>;
  /** The panel as the HTTP app mounts it. */
  readonly app: Hono;
}

/**
 * `x-test-session`: `owner` | `admin` | `member` (a live session), `dead` (a cookie that no longer works), absent (no cookie).
 * `x-test-problem`: the reason `checkFetchOrigin` reports for this request.
 */
export function fakeDeps(over: Partial<AdminUiDeps> = {}): Fake {
  const calls: AdminCall[] = [];
  const forbidden: string[] = [];
  const fake: Fake = {
    calls,
    forbidden,
    answer: { status: 200, body: [] },
    once: new Map<string, true>(),
    app: undefined as never,
    deps: {
      now: () => NOW,
      secureCookies: false,
      publicOrigin: 'https://bridge.example.test',
      clearSessionCookie: 'ab_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
      async authenticate(c) {
        const who = c.req.header('x-test-session');
        if (who === undefined) return { ok: false, presented: false };
        if (who === 'owner' || who === 'admin' || who === 'member')
          return { ok: true, principal: principal(who) };
        return { ok: false, presented: true };
      },
      checkFetchOrigin: (c) => c.req.header('x-test-problem') ?? null,
      csrfMatches: (p, presented) => presented === p.csrf,
      async callAdmin(_c, _p, call) {
        calls.push(call);
        return fake.respond?.(call) ?? fake.answer;
      },
      onceStore: {
        async put(key) {
          fake.once.set(key, true);
        },
        async take(key) {
          return fake.once.delete(key);
        },
        async list(prefix, limit) {
          return [...fake.once.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit);
        },
      },
      onForbidden: (_c, _p, reason) => {
        forbidden.push(reason);
      },
      ...over,
    },
  };
  const app = new Hono();
  app.use(async (c, next) => {
    c.set('requestId' as never, 'req-test' as never);
    await next();
  });
  app.route('/admin', createAdminUi(fake.deps));
  (fake as { app: Hono }).app = app;
  return fake;
}

/** A browser's own request: same origin, a GET navigation or a form post. */
export function get(
  fake: Fake,
  path: string,
  headers: Record<string, string> = {},
): Promise<Response> | Response {
  return fake.app.request(path, { headers: { 'sec-fetch-site': 'same-origin', ...headers } });
}

export function post(
  fake: Fake,
  path: string,
  fields: Record<string, string | string[]> | string,
  headers: Record<string, string> = {},
): Promise<Response> | Response {
  const body =
    typeof fields === 'string'
      ? fields
      : new URLSearchParams(
          Object.entries(fields).flatMap(([k, v]) =>
            (Array.isArray(v) ? v : [v]).map((x) => [k, x] as [string, string]),
          ),
        ).toString();
  return fake.app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'sec-fetch-site': 'same-origin',
      origin: 'http://127.0.0.1:8787',
      ...headers,
    },
    body,
  });
}
