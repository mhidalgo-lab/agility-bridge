// SPDX-License-Identifier: Apache-2.0
// Sign-in routes (P4-01, ADR-0009 step 2, THREAT_MODEL T14). Web-standard only (ADR-0004).
//
//   GET  /auth/login                 provider chooser
//   GET  /auth/login/:provider       starts a redirect login: transaction in storage + binding cookie -> 302 to the IdP
//   GET  /auth/callback/:provider    finishes it: consume the transaction once, exchange the code, verify, map to a user
//   GET  /auth/cf-access             Cloudflare Access: verify the `Cf-Access-Jwt-Assertion` header, map to a user
//   GET  /auth/setup                 the first-owner page; the setup code arrives in the URL fragment
//   GET  /auth/setup.js              the page's one script (moves the code from the fragment into the form)
//   POST /auth/setup                 starts the first-owner sign-in; the code is in the body, never in a URL
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
import type { LoginEvent } from './audit.ts';
import {
  chooserBody,
  IDENTITY_PAGE_CSP,
  messageBody,
  type PageLink,
  page,
  SETUP_SCRIPT,
  setupBody,
} from './identity-pages.ts';

export const IDENTITY_BASE: '/auth' = '/auth';
/** Where a login continues when no (valid) `next` was given. */
export const DEFAULT_LOGIN_NEXT = '/admin';
/** Largest setup form (a 74-character code and a provider id). */
const MAX_SETUP_BODY = 2048;

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
   * Called with the verified, allowed user; its Response is sent. Without it a finished sign-in shows a page naming
   * the user (the session arrives with P4-02).
   */
  readonly onLogin?: (c: Context, login: CompletedLogin) => Response | Promise<Response>;
  /** Records sign-ins (`AuditWriter.login`). */
  readonly audit?: (event: LoginEvent) => Promise<void> | undefined;
  /** Keyed hash of `(idp, subject)` for audit rows; omit to record none. */
  readonly identityHash?: (idp: string, subject: string) => Promise<string>;
  /** A router without a compile step on the first match (Workers). */
  readonly lightweightRouter?: boolean;
}

export interface IdentityRouteDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  /** The per-IP sign-in limit; a refusal is a 429 page. */
  readonly beforeSignIn?: (c: Context) => Promise<Response | undefined> | Response | undefined;
  /** Keeps work started for a request alive after the response (audit writes, the GitHub token revocation). */
  readonly runInBackground: (c: Context, task: Promise<unknown>) => void;
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

  const html = (
    status: number,
    title: string,
    body: string,
    headers: Record<string, string> = {},
    scripts: readonly string[] = [],
  ): Response =>
    new Response(page(title, body, scripts), {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': IDENTITY_PAGE_CSP,
        'cache-control': 'no-store',
        ...headers,
      },
    });
  const message = (
    status: number,
    title: string,
    paragraphs: readonly string[],
    extra: { link?: PageLink; requestId?: string; headers?: Record<string, string> } = {},
  ) => html(status, title, messageBody(paragraphs, extra.link, extra.requestId), extra.headers ?? {});

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

  /** Shared tail of every login kind: setup link, user mapping, audit, hand-off. */
  const complete = async (
    c: Context,
    provider: IdentityProvider,
    identity: VerifiedIdentity,
    setup: string | null,
    next: string,
    extra: Record<string, string>,
  ): Promise<Response> => {
    const hash = await hashIdentity(identity);
    // Consumed before the user decision, so concurrent completions of one link cannot both become owners. A sign-in
    // refused afterwards (disabled user, conflict) therefore uses the link up: the owner issues another.
    if (setup !== null && !(await consumeSetupLink(storage.kv, setup, clock))) {
      return fail(c, provider.id, provider.idp, 'setup_invalid', extra, hash);
    }
    const decision = await resolveLoginUser(storage.users, identity, policy, {
      ownerBootstrap: setup !== null,
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
    const login: CompletedLogin = {
      user: decision.user,
      identity,
      outcome: decision.outcome,
      provider: provider.id,
      // Checked again where the transaction is read: the stored value is never trusted blindly.
      next: safeNextPath(next, publicUrl) ?? DEFAULT_LOGIN_NEXT,
    };
    const res = options.onLogin
      ? await options.onLogin(c, login)
      : message(200, 'Signed in', [
          `Signed in as ${decision.user.email} (${decision.user.role}).`,
          'Browser sessions arrive with the admin panel; use the admin API with the admin token for now.',
        ]);
    for (const [k, v] of Object.entries(extra)) res.headers.append(k, v);
    return res;
  };

  const app = new Hono<{ Variables: Vars }>(
    options.lightweightRouter === true ? { router: new LinearRouter() } : undefined,
  );

  app.use('*', async (c, next) => {
    // The setup script is a static file; everything else costs a storage write or an IdP call.
    if (deps.beforeSignIn && c.req.path !== `${IDENTITY_BASE}/setup.js`) {
      const stop = await deps.beforeSignIn(c);
      if (stop) return stop;
    }
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
    return html(200, 'Sign in', chooserBody(list));
  });

  /** Starts a redirect login for `provider`, with the setup link `setup` (a hash) when there is one. */
  const start = async (
    c: Context,
    provider: IdentityProvider & { kind: 'redirect' },
    setup: string | null,
    status: 302 | 303,
  ): Promise<Response> => {
    try {
      const started = await startLogin(
        storage.kv,
        options.keys,
        { provider: provider.id, next: queryNext(c), setup },
        clock,
      );
      const url = await provider.authorizationUrl({
        redirectUri: redirectUri(provider.id),
        state: started.state,
        nonce: started.nonce,
        codeChallenge: started.codeChallenge,
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
      return await complete(c, provider, identity, tx.setup, tx.next, clear);
    } catch (error) {
      if (isIdentityError(error)) return fail(c, provider.id, provider.idp, error.code, clear);
      return internalFailure(c, provider, error, clear);
    }
  });

  const headerProvider = () => [...providers.values()].find((p) => p.kind === 'header');

  /** Header login (Cloudflare Access): verify the assertion, then the shared tail. */
  const headerLogin = async (c: Context, setup: string | null, next: string): Promise<Response> => {
    const provider = headerProvider();
    if (provider === undefined || provider.kind !== 'header') return c.json({ error: 'not_found' }, 404);
    try {
      const identity = await provider.verify(c.req.raw.headers);
      return await complete(c, provider, identity, setup, next, {});
    } catch (error) {
      if (isIdentityError(error)) return fail(c, provider.id, provider.idp, error.code);
      return internalFailure(c, provider, error, {});
    }
  };

  app.get('/cf-access', (c) => headerLogin(c, null, queryNext(c)));

  // ------------------------------------------------------------------------------------------ first-owner setup
  app.get('/setup', (c) => {
    if (providers.size === 0) return c.json({ error: 'not_found' }, 404);
    return html(200, 'Set up the first owner', setupBody([...providers.values()]), {}, [
      `${IDENTITY_BASE}/setup.js`,
    ]);
  });

  app.get('/setup.js', () => {
    return new Response(SETUP_SCRIPT, {
      headers: {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': IDENTITY_PAGE_CSP,
      },
    });
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

  return app;
}
