// SPDX-License-Identifier: Apache-2.0
// Sign-in routes (P4-01, ADR-0009 step 2, THREAT_MODEL T14). Web-standard only (ADR-0004).
//
//   GET  /auth/login                 provider chooser
//   GET  /auth/login/:provider       starts a redirect login: transaction in storage + binding cookie -> 302 to the IdP
//   GET  /auth/callback/:provider    finishes it: consume the transaction once, exchange the code, verify, map to a user
//   GET  /auth/cf-access             Cloudflare Access: verify the `Cf-Access-Jwt-Assertion` header, map to a user
//   GET  /auth/setup                 the first-owner page; the setup code arrives in the URL fragment
//   POST /auth/setup                 starts the first-owner sign-in; the code is in the body, never in a URL
//   GET  /auth/account               redirects to the panel's account page (/admin/account)
//
// The routes end at a verified, allowed user record and hand it to `onLogin` (P4-02 creates the session there).
// Every outcome is audited (`auth` / `login.ok` | `login.denied`); the browser gets one generic failure page whose
// only detail is the request id. Nothing here reads the `Authorization` header: bearer tokens confer nothing.
import {
  consumeSetupLink,
  finishLogin,
  type IdentityErrorCode,
  type IdentityProvider,
  isIdentityError,
  LOGIN_TTL_SECONDS,
  type LoginKeys,
  type LoginOutcome,
  type LoginPolicy,
  PROVIDER_ID_RE,
  RECENT_AUTH_WINDOW_MS,
  resolveLoginUser,
  setupCodeHash,
  setupLinkUsable,
  startLogin,
  type VerifiedIdentity,
} from '@agility-bridge/auth';
import type { Clock, Logger } from '@agility-bridge/core';
import type { Role, Storage, User } from '@agility-bridge/storage';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { LinearRouter } from 'hono/router/linear-router';
import type { AdminUiModule } from './admin-ui.ts';
import type { AdminChange, LoginEvent } from './audit.ts';
import { CLEAR_SITE_DATA_VALUE, CSRF_FIELD, CSRF_HEADER, type SessionManager } from './session.ts';

export const IDENTITY_BASE: '/auth' = '/auth';
/** Where a login continues when no (valid) `next` was given. */
export const DEFAULT_LOGIN_NEXT = '/admin';
/** Largest setup form (a 74-character code and a provider id). */
const MAX_SETUP_BODY = 2048;
/** Largest logout form (a CSRF token and a flag). */
const MAX_LOGOUT_BODY = 1024;

export type StorageForIdentity = Pick<Storage, 'users' | 'kv'>;

/** A finished sign-in, handed to `onLogin` (P4-02 creates the session here). */
export interface CompletedLogin {
  readonly user: User;
  readonly identity: VerifiedIdentity;
  readonly outcome: LoginOutcome;
  /** Provider id (URL key). */
  readonly provider: string;
  /** Validated same-origin path to continue to. */
  readonly next: string;
  /** The sign-in re-authenticated the signed-in user (P4-02) instead of starting a session from nothing. */
  readonly reauth: boolean;
}

export interface IdentityOptions {
  /** Origin browsers use (`AB_PUBLIC_URL`); redirect URIs are `<publicUrl>/auth/callback/<provider>`, exactly. */
  readonly publicUrl: string;
  readonly providers: readonly IdentityProvider[];
  readonly policy: LoginPolicy;
  readonly storage: StorageForIdentity;
  /** The master key's `login` purpose: the PKCE verifier and nonce are derived from it, not stored. */
  readonly keys: LoginKeys;
  /**
   * Called with the verified, allowed user; its Response is sent. Default: create a session (`deps.sessions`), set
   * the cookie and redirect to `login.next`; without sessions a page naming the user.
   */
  readonly onLogin?: (c: Context, login: CompletedLogin) => Response | Promise<Response>;
  /** Records sign-ins (`AuditWriter.login`). */
  readonly audit?: (event: LoginEvent) => Promise<void> | undefined;
  /** Records session changes made here (logout), as `admin` rows (`AuditWriter.admin`). */
  readonly auditAdmin?: (change: AdminChange) => Promise<void> | undefined;
  /** Keyed hash of `(idp, subject)` for audit rows; omit to record none. */
  readonly identityHash?: (idp: string, subject: string) => Promise<string>;
  /** A router without a compile step on the first match (Workers). */
  readonly lightweightRouter?: boolean;
}

export interface IdentityRouteDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  /** Admin sessions (P4-02): the default `onLogin`, `/logout`, `/account` and `/reauth`. */
  readonly sessions?: SessionManager;
  /** The per-IP sign-in limit; a refusal is a 429 page. */
  readonly beforeSignIn?: (c: Context) => Promise<Response | undefined> | Response | undefined;
  /** Keeps work started for a request alive after the response (audit writes, the GitHub token revocation). */
  readonly runInBackground: (c: Context, task: Promise<unknown>) => void;
  /**
   * The panel's page renderer (P4-03): `load` runs first on every request (it imports the panel on first use), `get`
   * then returns the loaded module. Sign-in pages share the panel's layout and headers.
   */
  readonly ui: { load(): Promise<unknown>; get(): AdminUiModule };
}

interface PageLink {
  readonly href: string;
  readonly label: string;
}

type Vars = { requestId: string };

/** One leading `/`, not followed by `/` or `\`: a path on this origin, never scheme-relative. */
export const isLocalPath = (path: string): boolean => /^\/(?![/\\])/.test(path);

/** Longest post-login path: room for an OAuth authorization request (`/oauth/authorize?...`, Phase 5). */
export const MAX_NEXT_PATH_CHARS = 2048;

/**
 * A post-login path: same origin, absolute path, no scheme-relative (`//host`) or backslash tricks, no control
 * characters. Anything else is null (the caller falls back to the default), so `next` can never leave the origin.
 */
export function safeNextPath(next: string | undefined, publicUrl: string): string | null {
  if (next === undefined || next.length === 0 || next.length > MAX_NEXT_PATH_CHARS) return null;
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return null;
  // Printable ASCII only (no spaces or control characters), and no backslash (browsers read it as `/`).
  if (!/^[!-~]+$/.test(next) || next.includes('\\')) return null;
  try {
    const u = new URL(next, publicUrl);
    if (u.origin !== new URL(publicUrl).origin) return null;
    const path = `${u.pathname}${u.search}${u.hash}`;
    // Parsing removes dot segments: `/.//evil.example` becomes `//evil.example`, a scheme-relative URL (L-091). Check
    // the result, not only the input.
    return isLocalPath(path) ? path : null;
  } catch {
    return null;
  }
}

const FAILURE_STATUS: Partial<Record<string, number>> = {
  invalid_callback: 400,
  unknown_state: 400,
  binding_mismatch: 400,
  provider_mismatch: 400,
  setup_invalid: 400,
  reauth_mismatch: 403,
  reauth_stale: 403,
  idp_unavailable: 502,
  internal_error: 500,
};

const FAILURE_TEXT: Readonly<Record<number, string>> = {
  400: 'This sign-in attempt is invalid or has expired. Start again from the sign-in page.',
  502: 'The identity provider could not be reached. Try again in a moment.',
  500: 'Sign-in failed unexpectedly. Try again in a moment.',
  403: 'Sign-in was refused. If you should have access, ask an administrator.',
};

export function createIdentityRoutes(
  options: IdentityOptions,
  deps: IdentityRouteDeps,
): Hono<{ Variables: Vars }> {
  const { storage, policy } = options;
  const { clock, logger } = deps;
  const publicUrl = new URL(options.publicUrl).origin;
  const secure = publicUrl.startsWith('https:');
  // `__Host-`: Secure, Path=/, no Domain, so no sibling subdomain can set or read it. Plain name on http loopback.
  const cookieName = secure ? '__Host-ab_login' : 'ab_login';
  const providers = new Map<string, IdentityProvider>();
  for (const p of options.providers) {
    if (!PROVIDER_ID_RE.test(p.id)) throw new TypeError(`invalid identity provider id ${p.id}`);
    if (providers.has(p.id)) throw new TypeError(`duplicate identity provider ${p.id}`);
    providers.set(p.id, p);
  }
  const redirectUri = (id: string) => `${publicUrl}${IDENTITY_BASE}/callback/${id}`;
  const cookie = (value: string, maxAge: number) =>
    `${cookieName}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  const clearCookie = cookie('', 0);
  const readCookie = (c: Context): string | undefined => {
    const header = c.req.header('cookie');
    if (header === undefined) return undefined;
    // A header naming the cookie more than once (cookie tossing) is no cookie at all (L-189).
    let found: string | undefined;
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === cookieName) {
        if (found !== undefined) return undefined;
        found = part.slice(i + 1).trim();
      }
    }
    return found;
  };

  const message = (
    status: number,
    title: string,
    paragraphs: readonly string[],
    extra: { link?: PageLink; requestId?: string; headers?: Record<string, string> } = {},
  ) =>
    deps.ui
      .get()
      .messagePageResponse(
        status,
        { title, paragraphs, link: extra.link, requestId: extra.requestId },
        extra.headers ?? {},
      );

  const requestId = (c: Context): string => (c.get('requestId' as never) as string | undefined) ?? '';
  const audit = (c: Context, event: Omit<LoginEvent, 'requestId'>) => {
    const work = options.audit?.({ requestId: requestId(c), ...event });
    if (work !== undefined) deps.runInBackground(c, work);
  };

  /** The keyed identity hash, or null (not configured, or the keyring failed: the row is still written). */
  const hashIdentity = async (identity: VerifiedIdentity): Promise<string | null> => {
    if (options.identityHash === undefined) return null;
    try {
      return await options.identityHash(identity.idp, identity.subject);
    } catch {
      logger.warn('identity hash failed', { event: 'login_identity_hash_failed' });
      return null;
    }
  };

  const fail = (
    c: Context,
    provider: string,
    idp: string | null,
    reason: IdentityErrorCode | string,
    extra: Record<string, string> = {},
    identityHash: string | null = null,
  ): Response => {
    audit(c, { status: 'denied', provider, idp, reason, ...(identityHash === null ? {} : { identityHash }) });
    const status = FAILURE_STATUS[reason] ?? 403;
    return message(status, 'Sign-in failed', [FAILURE_TEXT[status] as string], {
      link: { href: `${IDENTITY_BASE}/login`, label: 'Sign in again' },
      requestId: requestId(c),
      headers: extra,
    });
  };

  const internalFailure = (
    c: Context,
    provider: IdentityProvider,
    error: unknown,
    extra: Record<string, string>,
  ) => {
    logger.error('login failed', {
      requestId: requestId(c),
      provider: provider.id,
      error: error instanceof Error ? error.name : typeof error,
    });
    return fail(c, provider.id, provider.idp, 'internal_error', extra);
  };

  /** The hand-off every successful sign-in ends in. */
  const handOff = async (c: Context, login: CompletedLogin, extra: Record<string, string>) => {
    const res = options.onLogin
      ? await options.onLogin(c, login)
      : deps.sessions
        ? await deps.sessions.login(c, login)
        : message(200, 'Signed in', [
            `Signed in as ${login.user.email} (${login.user.role}).`,
            'Browser sessions are not configured; use the admin API with the admin token.',
          ]);
    for (const [k, v] of Object.entries(extra)) res.headers.append(k, v);
    return res;
  };

  /**
   * Re-authentication (P4-02, L-093): the same person again, recently. No user is created or bound here: the identity
   * must already be the one bound to the signed-in user. Header providers must prove recency (the Access assertion's
   * issue time); redirect providers that report `auth_time` must show a recent one.
   */
  const completeReauth = async (
    c: Context,
    provider: IdentityProvider,
    identity: VerifiedIdentity,
    userId: string,
    next: string,
    extra: Record<string, string>,
    hash: string | null,
  ): Promise<Response> => {
    const at = identity.authenticatedAt;
    const recent = at !== undefined && clock.now() - at < RECENT_AUTH_WINDOW_MS && at <= clock.now() + 60_000;
    if (provider.kind === 'header' ? !recent : at !== undefined && !recent) {
      return fail(c, provider.id, provider.idp, 'reauth_stale', extra, hash);
    }
    const user = await storage.users.get(userId);
    if (
      user === null ||
      user.disabledAt !== null ||
      user.idp !== identity.idp ||
      user.idpSubject !== identity.subject
    ) {
      return fail(c, provider.id, provider.idp, 'reauth_mismatch', extra, hash);
    }
    audit(c, {
      status: 'ok',
      provider: provider.id,
      idp: provider.idp,
      userId: user.id,
      outcome: 'reauth',
      ...(hash === null ? {} : { identityHash: hash }),
    });
    return handOff(
      c,
      {
        user,
        identity,
        outcome: 'existing',
        provider: provider.id,
        next: safeNextPath(next, publicUrl) ?? DEFAULT_LOGIN_NEXT,
        reauth: true,
      },
      extra,
    );
  };

  /** Shared tail of every login kind: setup link, user mapping, audit, hand-off. */
  const complete = async (
    c: Context,
    provider: IdentityProvider,
    identity: VerifiedIdentity,
    setup: string | null,
    next: string,
    extra: Record<string, string>,
    /** Re-authentication: the id of the signed-in user this sign-in must be the same person as. */
    reauth: string | null = null,
  ): Promise<Response> => {
    const hash = await hashIdentity(identity);
    if (reauth !== null) return completeReauth(c, provider, identity, reauth, next, extra, hash);
    // Consumed before the user decision, so concurrent completions of one link cannot both become owners. A sign-in
    // refused afterwards (disabled user, conflict) therefore uses the link up: the owner issues another.
    if (setup !== null && !(await consumeSetupLink(storage.kv, setup, clock))) {
      return fail(c, provider.id, provider.idp, 'setup_invalid', extra, hash);
    }
    const decision = await resolveLoginUser(storage.users, identity, policy, {
      ownerBootstrap: setup !== null,
      kv: storage.kv,
    });
    if (!decision.ok) return fail(c, provider.id, provider.idp, decision.reason, extra, hash);
    audit(c, {
      status: 'ok',
      provider: provider.id,
      idp: provider.idp,
      userId: decision.user.id,
      outcome: decision.outcome,
      ...(hash === null ? {} : { identityHash: hash }),
      ...(decision.previousRole === undefined ? {} : { previousRole: decision.previousRole satisfies Role }),
    });
    return handOff(
      c,
      {
        user: decision.user,
        identity,
        outcome: decision.outcome,
        provider: provider.id,
        // Checked again where the transaction is read: the stored value is never trusted blindly.
        next: safeNextPath(next, publicUrl) ?? DEFAULT_LOGIN_NEXT,
        reauth: false,
      },
      extra,
    );
  };

  const app = new Hono<{ Variables: Vars }>(
    options.lightweightRouter === true ? { router: new LinearRouter() } : undefined,
  );

  app.use('*', async (c, next) => {
    // Every route costs a storage write or an IdP call.
    if (deps.beforeSignIn) {
      const stop = await deps.beforeSignIn(c);
      if (stop) return stop;
    }
    // The pages share the panel's layout; import it before any handler renders one.
    await deps.ui.load();
    await next();
    return undefined;
  });

  const queryNext = (c: Context) => safeNextPath(c.req.query('next'), publicUrl) ?? DEFAULT_LOGIN_NEXT;

  app.get('/login', (c) => {
    const next = safeNextPath(c.req.query('next'), publicUrl);
    const qs = next === null ? '' : `?next=${encodeURIComponent(next)}`;
    const list = [...providers.values()].map((p) => ({
      href: p.kind === 'header' ? `${IDENTITY_BASE}/cf-access${qs}` : `${IDENTITY_BASE}/login/${p.id}${qs}`,
      label: p.label,
    }));
    return deps.ui.get().loginPageResponse(list);
  });

  /** Starts a redirect login for `provider`, with the setup link `setup` (a hash) when there is one. */
  const start = async (
    c: Context,
    provider: IdentityProvider & { kind: 'redirect' },
    setup: string | null,
    status: 302 | 303,
    reauth: string | null = null,
  ): Promise<Response> => {
    try {
      const started = await startLogin(
        storage.kv,
        options.keys,
        { provider: provider.id, next: queryNext(c), setup, reauth },
        clock,
      );
      const url = await provider.authorizationUrl({
        redirectUri: redirectUri(provider.id),
        state: started.state,
        nonce: started.nonce,
        codeChallenge: started.codeChallenge,
        ...(reauth === null ? {} : { reauth: true }),
      });
      return new Response(null, {
        status,
        headers: { Location: url.href, 'Set-Cookie': cookie(started.binding, LOGIN_TTL_SECONDS) },
      });
    } catch (error) {
      if (isIdentityError(error)) return fail(c, provider.id, provider.idp, error.code);
      return internalFailure(c, provider, error, {});
    }
  };

  app.get('/login/:provider', async (c) => {
    const provider = providers.get(c.req.param('provider'));
    if (provider === undefined || provider.kind !== 'redirect') return c.json({ error: 'not_found' }, 404);
    return await start(c, provider, null, 302);
  });

  app.get('/callback/:provider', async (c) => {
    const provider = providers.get(c.req.param('provider'));
    if (provider === undefined || provider.kind !== 'redirect') return c.json({ error: 'not_found' }, 404);
    const clear = { 'Set-Cookie': clearCookie };
    const q = (k: string) => {
      const v = c.req.query(k);
      return v !== undefined && v.length <= 2048 ? v : undefined;
    };
    try {
      // The transaction is consumed first (single use), whatever else the callback says.
      const tx = await finishLogin(
        storage.kv,
        options.keys,
        { state: q('state'), binding: readCookie(c), provider: provider.id },
        clock,
      );
      if (q('error') !== undefined) return fail(c, provider.id, provider.idp, 'idp_error', clear);
      const code = q('code');
      if (code === undefined || code === '')
        return fail(c, provider.id, provider.idp, 'invalid_callback', clear);
      const iss = q('iss');
      const identity = await provider.complete(
        {
          code,
          redirectUri: redirectUri(provider.id),
          codeVerifier: tx.codeVerifier,
          nonce: tx.nonce,
          ...(iss === undefined ? {} : { issuer: iss }),
        },
        {
          background: (task) => deps.runInBackground(c, task),
          warn: (msg, fields) => logger.warn(msg, { requestId: requestId(c), ...fields }),
        },
      );
      return await complete(c, provider, identity, tx.setup, tx.next, clear, tx.reauth);
    } catch (error) {
      if (isIdentityError(error)) return fail(c, provider.id, provider.idp, error.code, clear);
      return internalFailure(c, provider, error, clear);
    }
  });

  const headerProvider = () => [...providers.values()].find((p) => p.kind === 'header');

  /** Header login (Cloudflare Access): verify the assertion, then the shared tail. */
  const headerLogin = async (
    c: Context,
    setup: string | null,
    next: string,
    reauth: string | null = null,
  ): Promise<Response> => {
    const provider = headerProvider();
    if (provider === undefined || provider.kind !== 'header') return c.json({ error: 'not_found' }, 404);
    try {
      const identity = await provider.verify(c.req.raw.headers);
      return await complete(c, provider, identity, setup, next, {}, reauth);
    } catch (error) {
      if (isIdentityError(error)) return fail(c, provider.id, provider.idp, error.code);
      return internalFailure(c, provider, error, {});
    }
  };

  app.get('/cf-access', (c) => headerLogin(c, null, queryNext(c)));

  // ------------------------------------------------------------------------------------------ first-owner setup
  app.get('/setup', (c) => {
    if (providers.size === 0) return c.json({ error: 'not_found' }, 404);
    return deps.ui.get().setupPageResponse([...providers.values()]);
  });

  const capped = bodyLimit({
    maxSize: MAX_SETUP_BODY,
    onError: () => message(413, 'Request too large', ['The request is too large.']),
  });

  app.post('/setup', capped, async (c) => {
    // The form lives on this origin only: a cross-site request (a forged form on another site) is refused. `Origin`
    // was already checked against the allowlist by the edge; the fetch metadata catches the rest.
    const site = c.req.header('sec-fetch-site');
    const origin = c.req.header('origin');
    if ((site !== undefined && site !== 'same-origin') || (origin !== undefined && origin !== publicUrl)) {
      return message(403, 'Sign-in refused', ['This request did not come from this site.']);
    }
    if (!/^application\/x-www-form-urlencoded\s*(;|$)/i.test(c.req.header('content-type') ?? '')) {
      return message(415, 'Sign-in refused', ['Use the form on the setup page.']);
    }
    const form = new URLSearchParams(await c.req.text());
    const provider = providers.get(form.get('provider') ?? '');
    if (provider === undefined) return message(400, 'Sign-in failed', ['Choose a sign-in provider.']);
    // A malformed code is refused before any storage read.
    const hash = await setupCodeHash(form.get('code') ?? undefined);
    if (hash === null || !(await setupLinkUsable(storage.kv, hash, clock))) {
      return fail(c, provider.id, provider.idp, 'setup_invalid');
    }
    // 303: the browser follows a POST with a GET, and the code is gone from the next request.
    if (provider.kind === 'redirect') return start(c, provider, hash, 303);
    return headerLogin(c, hash, DEFAULT_LOGIN_NEXT);
  });

  if (deps.sessions) registerSessionRoutes(app, deps.sessions);
  return app;

  // ------------------------------------------------------------------------------------------ session routes
  function registerSessionRoutes(router: Hono<{ Variables: Vars }>, sessions: SessionManager): void {
    const refused = (c: Context, reason: string) => {
      const work = options.auditAdmin?.({
        requestId: requestId(c),
        action: 'admin.forbidden',
        status: 'denied',
        targetType: 'session',
        targetId: '-',
        errorCode: 'forbidden',
        details: { reason, route: `${c.req.method} ${c.req.path}` },
      });
      if (work !== undefined) deps.runInBackground(c, work);
      return message(403, 'Request refused', ['This request did not come from this site.']);
    };
    const toLogin = (next?: string): Response =>
      new Response(null, {
        status: 303,
        headers: {
          Location: `${IDENTITY_BASE}/login${next === undefined ? '' : `?next=${encodeURIComponent(next)}`}`,
        },
      });

    // The account page is part of the panel now (P4-03); the old address keeps working.
    router.get(
      '/account',
      () => new Response(null, { status: 303, headers: { Location: '/admin/account' } }),
    );

    /** Re-authentication: the signed-in user signs in again, with the same provider, and returns to `next`. */
    router.get('/reauth', async (c) => {
      const problem = sessions.checkFetchOrigin(c, false);
      if (problem !== null) return refused(c, problem);
      const next = queryNext(c);
      const auth = await sessions.authenticate(c);
      if (!auth.ok) return toLogin(next);
      const provider = providers.get(auth.principal.session.record.provider);
      if (provider === undefined) return toLogin(next);
      if (provider.kind === 'redirect') return start(c, provider, null, 302, auth.principal.user.id);
      return headerLogin(c, null, next, auth.principal.user.id);
    });

    const capped = bodyLimit({
      maxSize: MAX_LOGOUT_BODY,
      onError: () => message(413, 'Sign-out refused', ['The request is too large.']),
    });

    /** Sign out: POST only; the CSRF token, same origin; the session is deleted and the browser told to drop cookies. */
    router.post('/logout', capped, async (c) => {
      const auth = await sessions.authenticate(c);
      // No live session: nothing to protect, only drop the cookie that was presented (an expired or revoked one).
      // Without a cookie (a cross-site form: SameSite=Lax withholds it) nothing happens, so another site cannot sign
      // this browser out.
      if (!auth.ok) {
        const presented = sessions.readCookie(c) !== undefined;
        if (presented) await sessions.revokeCurrent(c);
        return message(200, 'Signed out', ['You are not signed in.'], {
          link: { href: `${IDENTITY_BASE}/login`, label: 'Sign in' },
          headers: presented ? { 'set-cookie': sessions.clearCookie } : {},
        });
      }
      const { principal } = auth;
      let token = c.req.header(CSRF_HEADER);
      let everywhere = false;
      if (/^application\/x-www-form-urlencoded\s*(;|$)/i.test(c.req.header('content-type') ?? '')) {
        const form = new URLSearchParams(await c.req.text());
        token ??= form.get(CSRF_FIELD) ?? undefined;
        everywhere = form.get('everywhere') === '1';
      }
      const problem =
        sessions.checkFetchOrigin(c, true) ?? (sessions.csrfMatches(principal, token) ? null : 'csrf');
      if (problem !== null) return refused(c, problem);
      const userId = principal.user.id;
      let revoked = 1;
      if (everywhere) revoked = await sessions.revokeUser(userId);
      else await sessions.revokeCurrent(c);
      const work = options.auditAdmin?.({
        requestId: requestId(c),
        action: everywhere ? 'session.revoke_all' : 'session.revoke',
        userId,
        targetType: everywhere ? 'user' : 'session',
        targetId: everywhere ? userId : principal.session.ref,
        details: { reason: everywhere ? 'logout_everywhere' : 'logout', revoked },
      });
      if (work !== undefined) deps.runInBackground(c, work);
      return message(200, 'Signed out', ['You are signed out.'], {
        link: { href: `${IDENTITY_BASE}/login`, label: 'Sign in' },
        headers: {
          'set-cookie': sessions.clearCookie,
          ...(sessions.clearSiteData ? { 'clear-site-data': CLEAR_SITE_DATA_VALUE } : {}),
        },
      });
    });
  }
}
