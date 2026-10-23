// SPDX-License-Identifier: Apache-2.0
// Admin browser sessions over HTTP (P4-02, THREAT_MODEL T13/T14). Web-standard only (ADR-0004).
//
// - Sign-in (`onLogin`) ends the browser's previous session, creates a new one in storage and sets the cookie
//   `__Host-ab_session` (`ab_session` on http loopback): HttpOnly, Secure, SameSite=Lax, Path=/, no Domain. Lax rather
//   than Strict: sign-in finishes in a redirect chain the IdP started, and Strict would withhold the cookie on the
//   first page after it. Unsafe methods are covered by the CSRF token and the Origin check; cross-site reads by
//   `Sec-Fetch-Site`.
// - Every cookie-authenticated request loads the session from storage (a logout anywhere ends it everywhere at once)
//   and the user row, so the role is the current one and a disabled or deleted user fails on the next request. There
//   is no cache of users or sessions: nothing here outlives a request (L-013, L-096).
import {
  type ActiveSession,
  checkSessionTimeouts,
  createSession,
  csrfTokenMatches,
  DEFAULT_MAX_SESSIONS_PER_USER,
  DEFAULT_SESSION_TIMEOUTS,
  INSECURE_SESSION_COOKIE,
  isRecentAuth,
  loadSession,
  revokeSession,
  revokeUserSessions,
  SESSION_COOKIE,
  type SessionTimeouts,
} from '@agility-bridge/auth';
import type { Clock } from '@agility-bridge/core';
import type { Role, Storage, User } from '@agility-bridge/storage';
import type { Context } from 'hono';
import type { AdminChange } from './audit.ts';
import type { CompletedLogin } from './identity.ts';

export interface SessionOptions {
  /** Idle and absolute timeouts (default 30 minutes / 12 hours). */
  readonly timeouts?: SessionTimeouts;
  /** Live sessions per user (default 20). */
  readonly maxPerUser?: number;
  /** Send `Clear-Site-Data: "cookies"` on logout (default true; see the admin access guide for the scope). */
  readonly clearSiteData?: boolean;
}

/** Header carrying the CSRF token on admin API calls. */
export const CSRF_HEADER = 'x-csrf-token';
/** Form field carrying the CSRF token on HTML form posts (`POST /auth/logout`). */
export const CSRF_FIELD = '_csrf';
/** The value of `Clear-Site-Data` on logout: quoted, as the header's grammar requires. */
export const CLEAR_SITE_DATA_VALUE = '"cookies"';

/** A request that came with a valid session, and whose user is still allowed in. */
export interface SessionPrincipal {
  readonly user: User;
  /** The user's current role (from the user row, never from the session). */
  readonly role: Role;
  readonly session: ActiveSession;
  /** Signed in within the last 10 minutes. */
  readonly recentAuth: boolean;
}

export type SessionAuth =
  | { readonly ok: true; readonly principal: SessionPrincipal }
  /** `none`: no session cookie at all. */
  | { readonly ok: false; readonly reason: 'none' | 'session_user_disabled' | string };

/** Why a cookie-authenticated request is refused before its handler (403). */
export type FetchOriginProblem = 'cross_site' | 'origin_mismatch' | 'origin_missing';

export interface SessionManager {
  readonly cookieName: string;
  /** `AB_PUBLIC_URL`'s origin: the only `Origin` cookie-authenticated unsafe requests may carry. */
  readonly publicOrigin: string;
  readonly timeouts: SessionTimeouts;
  readonly clearSiteData: boolean;
  /** The session cookie value; null when the header names it more than once (cookie tossing: treated as malformed). */
  readCookie(c: Context): string | null | undefined;
  /** Load and check the session of this request, and its user. */
  authenticate(c: Context): Promise<SessionAuth>;
  /** Fetch-metadata and Origin checks for a cookie-authenticated request (null when fine). */
  checkFetchOrigin(c: Context, unsafe: boolean): FetchOriginProblem | null;
  csrfMatches(principal: SessionPrincipal, presented: string | undefined): boolean;
  /** `onLogin`: rotate, create, set the cookie, 303 to `next`. */
  login(c: Context, login: CompletedLogin): Promise<Response>;
  /** End the session this request presents (logout). */
  revokeCurrent(c: Context): Promise<boolean>;
  /** End every session of a user (logout everywhere, role change, disable). Returns how many rows went. */
  revokeUser(userId: string): Promise<number>;
  readonly clearCookie: string;
}

export interface SessionManagerDeps {
  readonly publicUrl: string;
  readonly storage: Pick<Storage, 'kv' | 'users'>;
  readonly clock: Clock;
  readonly options?: SessionOptions;
  /** Records session changes; its work is kept alive with `runInBackground`. */
  readonly audit?: (change: AdminChange) => Promise<void> | undefined;
  readonly runInBackground: (c: Context, task: Promise<unknown>) => void;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const isUnsafeMethod = (method: string): boolean => !SAFE_METHODS.has(method.toUpperCase());

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const publicOrigin = new URL(deps.publicUrl).origin;
  const secure = publicOrigin.startsWith('https:');
  const cookieName = secure ? SESSION_COOKIE : INSECURE_SESSION_COOKIE;
  const timeouts = checkSessionTimeouts(deps.options?.timeouts ?? DEFAULT_SESSION_TIMEOUTS);
  const maxPerUser = deps.options?.maxPerUser ?? DEFAULT_MAX_SESSIONS_PER_USER;
  const { clock } = deps;
  const kv = deps.storage.kv;
  const maxAge = Math.round(timeouts.absoluteMs / 1000);

  const cookie = (value: string, age: number) =>
    `${cookieName}=${value}; Path=/; Max-Age=${age}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  const clearCookie = cookie('', 0);

  const readCookie = (c: Context): string | null | undefined => {
    const header = c.req.header('cookie');
    if (header === undefined) return undefined;
    let found: string | undefined;
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === cookieName) {
        // A header naming the cookie more than once (cookie tossing) is no cookie at all (L-189).
        if (found !== undefined) return null;
        found = part.slice(i + 1).trim();
      }
    }
    return found;
  };

  const audit = (c: Context, change: AdminChange) => {
    const work = deps.audit?.({
      requestId: (c.get('requestId' as never) as string | undefined) ?? null,
      ...change,
    });
    if (work !== undefined) deps.runInBackground(c, work);
  };

  return {
    cookieName,
    publicOrigin,
    timeouts,
    clearSiteData: deps.options?.clearSiteData ?? true,
    readCookie,
    clearCookie,

    async authenticate(c) {
      const value = readCookie(c);
      if (value === undefined) return { ok: false, reason: 'none' };
      const found = await loadSession(kv, value ?? '', timeouts, clock);
      if (!found.ok) return { ok: false, reason: found.reason };
      const user = await deps.storage.users.get(found.session.record.userId);
      // Fail closed: a user disabled any way at all loses this session, and it is deleted, so enabling the user later
      // does not revive a cookie stolen before.
      if (user === null || user.disabledAt !== null) {
        await revokeSession(kv, value ?? '').catch(() => false);
        return { ok: false, reason: 'session_user_disabled' };
      }
      return {
        ok: true,
        principal: {
          user,
          role: user.role,
          session: found.session,
          recentAuth: isRecentAuth(found.session.record.createdAt, clock.now()),
        },
      };
    },

    checkFetchOrigin(c, unsafe) {
      const site = c.req.header('sec-fetch-site');
      const origin = c.req.header('origin');
      if (unsafe) {
        // A change comes from our own pages only: `none` (typed URL) and every other site are refused.
        if (site !== undefined && site !== 'same-origin') return 'cross_site';
        if (origin !== undefined) return origin === publicOrigin ? null : 'origin_mismatch';
        return site === 'same-origin' ? null : 'origin_missing';
      }
      if (site === undefined || site === 'same-origin' || site === 'none') return null;
      // A link from mail or chat is a cross-site top-level navigation: the page may open, but no script elsewhere may
      // read with the session (cookies would arrive under Lax only for navigations anyway).
      const navigation =
        c.req.method === 'GET' &&
        c.req.header('sec-fetch-mode') === 'navigate' &&
        c.req.header('sec-fetch-dest') === 'document';
      return navigation ? null : 'cross_site';
    },

    csrfMatches: (principal, presented) => csrfTokenMatches(principal.session.record, presented),

    async login(c, login) {
      // Rotation: whatever session this browser had ends here, so a planted or older cookie never survives sign-in.
      const previous = readCookie(c);
      if (previous) await revokeSession(kv, previous);
      const issued = await createSession(
        kv,
        { userId: login.user.id, provider: login.provider, idp: login.identity.idp },
        timeouts,
        clock,
        maxPerUser,
      );
      audit(c, {
        action: 'session.create',
        userId: login.user.id,
        targetType: 'session',
        targetId: issued.ref,
        details: {
          via: login.reauth ? 'reauth' : 'sign_in',
          provider: login.provider,
          idp: login.identity.idp,
          outcome: login.outcome,
          role: login.user.role,
          rotated: Boolean(previous),
          evicted: issued.evicted,
        },
      });
      return new Response(null, {
        status: 303,
        headers: {
          // `next` was checked when the login started; check again so no path can ever leave the origin (L-091).
          Location: /^\/(?![/\\])/.test(login.next) ? login.next : '/admin',
          'Set-Cookie': cookie(issued.cookieValue, maxAge),
        },
      });
    },

    async revokeCurrent(c) {
      const value = readCookie(c);
      return value ? revokeSession(kv, value) : false;
    },

    revokeUser: (userId) => revokeUserSessions(kv, userId),
  };
}
