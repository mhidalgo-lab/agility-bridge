// SPDX-License-Identifier: Apache-2.0
// OAuth 2.1 authorization server for MCP clients (P5-01, ADR-0009): `@cloudflare/workers-oauth-provider` run unmodified
// on Node and Workers, in one origin with the per-workspace MCP endpoints.
//
// - Issuer = the configured public URL (never the `Host` header): one authorization server whose resources are the
//   per-workspace URLs `{issuer}/w/{slug}/mcp`. Provider objects are built per resource set and cached by it
//   (configuration only, no request data, L-013); every request passes its own environment.
// - State lives in the storage `kv` table under `oauth:` (`kv-namespace.ts`), strongly consistent on both runtimes
//   (L-086). Nothing about an authorization is kept in process or isolate memory (L-096).
// - Authorization codes are single use under concurrency: approving writes a marker that the token endpoint consumes
//   with the atomic `kv.take` before the provider sees the code (the provider's own check is read-then-write, L-073).
// - The interactive part of `/oauth/authorize` (sign-in, choosing a grant, consent) is the `consent` handler (P5-04);
//   `approve()` re-runs the access resolver, so an approval can never bind a token to a grant its user may not use.
// - An OAuth access token on `/w/{slug}/mcp` is validated for that slug's resource only (RFC 8707 audience), its props
//   are cross-checked, and its grant goes through `resolveAccess` as an `oauth` principal (deny by default).
// - Every token issuance (code exchange, refresh) re-runs the access decision for the grant the device was approved with.
// The provider module is imported lazily: deployments that use device tokens only never load it.

import {
  type AccessSettings,
  type DenyReason,
  type EffectiveAccess,
  loadAccessRecords,
  resolveAccess,
} from '@agility-bridge/auth';
import type { Clock, Logger } from '@agility-bridge/core';
import { SLUG_RE, type Storage } from '@agility-bridge/storage';
import type {
  AuthRequest,
  ClientInfo,
  OAuthAuthorizationServer,
  OAuthHelpers,
  AuthorizationError as ProviderAuthorizationError,
  TokenExchangeCallbackOptions,
  TokenExchangeCallbackResult,
} from '@cloudflare/workers-oauth-provider';
import type { Context } from 'hono';
import type { OAuthEvent } from '../audit.ts';
import { type OAuthKvNamespace, oauthKvNamespace } from './kv-namespace.ts';

export const OAUTH_AUTHORIZE_PATH = '/oauth/authorize';
export const OAUTH_TOKEN_PATH = '/oauth/token';
export const OAUTH_REGISTER_PATH = '/oauth/register';
/** RFC 8414 metadata of an issuer without a path. */
export const OAUTH_METADATA_PATH = '/.well-known/oauth-authorization-server';

/** The scope every MCP token carries (read-only tools). Grants, not scopes, decide what a token may do. */
export const MCP_SCOPE = 'mcp:read';
export const OAUTH_SCOPES: readonly string[] = Object.freeze([MCP_SCOPE, 'offline_access']);

export const DEFAULT_OAUTH_ACCESS_TTL_S = 3600;
export const DEFAULT_OAUTH_REFRESH_TTL_S: number = 30 * 86_400;
/** How long an authorization code may wait for its exchange (the provider's own grant TTL is the same). */
export const OAUTH_CODE_TTL_S = 600;
/** Largest token or registration request body read. */
export const OAUTH_MAX_BODY_BYTES: number = 16 * 1024;
/** A dynamic registration that exchanges nothing lives this long at least (renewed by the provider on use). */
export const OAUTH_MIN_REGISTRATION_TTL_S: number = 90 * 86_400;

/** Stable reasons an OAuth bearer is refused on an MCP route (logs and audit only; the client gets the same 401). */
export type OAuthDenyReason = 'oauth_invalid' | 'oauth_mismatch';

/** What a grant's token carries (encrypted at rest by the provider; handed back on validation). */
export interface OAuthGrantProps {
  /** The access grant (`grt_…`) the person approved. */
  readonly grantId: string;
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  readonly userId: string;
  readonly clientId: string;
}

/** The authorization request as the consent step sees it (validated: client, redirect URI, PKCE S256, resource). */
export interface OAuthAuthorizationRequest {
  readonly clientId: string;
  /** From the client's registration: untrusted text, escape before display. */
  readonly clientName: string | null;
  readonly redirectUri: string;
  /** Show prominently on the consent screen (phishing resistance, P5-04). */
  readonly redirectHost: string;
  readonly scope: readonly string[];
  /** The RFC 8707 resource (`{issuer}/w/{slug}/mcp`). */
  readonly resource: string;
  /** The workspace named by the resource. Not looked up yet: unknown slugs fail at `approve()` (no slug probing). */
  readonly workspaceSlug: string;
}

export type OAuthApproval =
  | { readonly ok: true; readonly redirectTo: string; readonly scope: readonly string[] }
  | { readonly ok: false; readonly reason: DenyReason | 'principal_mismatch' };

/** What the consent handler can do with the request. */
export interface OAuthConsentApi {
  readonly request: OAuthAuthorizationRequest;
  /** The provider's parsed request and helpers, for its consent helpers (P5-04). */
  readonly authRequest: AuthRequest;
  readonly helpers: OAuthHelpers;
  /**
   * Approve for a signed-in user and one of their grants on the workspace. Re-checks access first (grant of this user
   * and workspace, live, usable credential); on success returns the redirect carrying the code. At most once.
   */
  approve(input: { readonly userId: string; readonly grantId: string }): Promise<OAuthApproval>;
  /** The `access_denied` redirect (with `state` and `iss`). */
  deny(description?: string): string;
}

/** The interactive step of `/oauth/authorize` (P5-04: sign-in, grant choice, consent). */
export type OAuthConsentHandler = (c: Context, api: OAuthConsentApi) => Response | Promise<Response>;

/** `createHttpApp({ oauth })`: the issuer is the app's public URL. */
export interface OAuthOptions {
  /** The interactive step of `/oauth/authorize`. */
  readonly consent: OAuthConsentHandler;
  /** Access-token lifetime in seconds, 60-86400. Default 3600. Capped at the grant's expiry. */
  readonly accessTokenTtlSeconds?: number;
  /** Absolute refresh lifetime in seconds, 3600-31536000. Default 30 days. Capped at the grant's expiry. */
  readonly refreshTokenTtlSeconds?: number;
}

export type OAuthAuthentication =
  | {
      readonly ok: true;
      /** Resolved like a device token's, with `tokenId` `oauth_<provider grant id>` and the `clientId`. */
      readonly access: EffectiveAccess;
    }
  | { readonly ok: false; readonly stage: 'token'; readonly reason: OAuthDenyReason }
  | {
      readonly ok: false;
      readonly stage: 'access';
      readonly tokenId: string;
      readonly reason: DenyReason | 'principal_mismatch';
    };

type ProviderModule = typeof import('@cloudflare/workers-oauth-provider');
interface ProviderEnv {
  readonly OAUTH_KV: OAuthKvNamespace;
  /** The request being served (audit rows); absent for calls outside a request. */
  readonly AB_REQUEST_ID?: string;
  /** Records an audit row for the request being served (the issuance check runs inside the provider). */
  readonly AB_RECORD?: (event: OAuthEvent) => void;
}

/** `userId:grantId:secret` as the provider issues them (user ids are ours: `usr_` + 32 hex). */
const PROVIDER_TOKEN_RE = /^([A-Za-z0-9_-]{1,128}):([A-Za-z0-9_-]{16}):([A-Za-z0-9_-]{32})$/;
/** Longest provider-issued token accepted (`userId` ≤ 128 characters, ours are 36). */
export const MAX_OAUTH_TOKEN_CHARS = 200;
const MAX_CACHED_SERVERS = 64;
const CODE_MARKER_PREFIX = 'oauth-code:';
/**
 * Revoked device tombstones, `oauth-revoked:<userId>:<grantId>`: written before a device is revoked, so a token
 * request the provider was answering at that moment (it reads the grant, then writes it back) cannot bring the device
 * back: the token endpoint looks for the tombstone after the provider answered and revokes again.
 */
const TOMBSTONE_PREFIX = 'oauth-revoked:';
/** RFC 7636 §4.1 `code-verifier = 43*128unreserved`. */
const PKCE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

/** Cheap offline check: could this be a provider-issued token (access, refresh or code)? */
export function looksLikeOAuthToken(token: string): boolean {
  return token.length <= MAX_OAUTH_TOKEN_CHARS && PROVIDER_TOKEN_RE.test(token);
}

/** Whether any parameter appears more than once. */
function repeated(params: URLSearchParams): boolean {
  const seen = new Set<string>();
  for (const name of params.keys()) {
    if (seen.has(name)) return true;
    seen.add(name);
  }
  return false;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

function checkInt(name: string, value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function jsonError(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Pragma: 'no-cache' },
  });
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store' } });
}

/** The request body as text, at most `max` bytes (declared or streamed); `null` when it is larger. */
async function readBounded(request: Request, max: number): Promise<string | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d{1,12}$/.test(declared) || Number(declared) > max)) return null;
  if (request.body === null) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

export interface OAuthRuntimeDeps {
  readonly options: OAuthOptions;
  /** Issuer origin (`https://bridge.example.com`), from the configured public URL. */
  readonly issuer: string;
  readonly storage: Storage;
  readonly access: AccessSettings;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly runInBackground: (c: Context, task: Promise<unknown>, what: string) => void;
  /** `auth` audit rows; never rejects. Called for every OAuth event, with no secret in it. */
  readonly audit?: (event: OAuthEvent) => unknown;
}

/** One app's OAuth server: the route handlers and the MCP-route token check. Holds configuration and caches only. */
export interface OAuthRuntime {
  readonly issuer: string;
  /** The resource URL of a workspace slug. */
  resourceUrl(slug: string): string;
  metadata(c: Context): Promise<Response>;
  authorize(c: Context): Promise<Response>;
  /**
   * Validate an authorization request given as query parameters (the consent form re-validates the request it shows on
   * every step, P5-04): the error answer (400 page or error redirect), or the consent API for it.
   */
  prepare(c: Context, params: URLSearchParams): Promise<Response | OAuthConsentApi>;
  token(c: Context, onRevocation: () => void): Promise<Response>;
  register(c: Context): Promise<Response>;
  /** Validate an OAuth bearer for `/w/{slug}/mcp` and resolve its access. Storage errors propagate (fail closed). */
  authenticate(token: string, slug: string): Promise<OAuthAuthentication>;
}

export function createOAuthRuntime(deps: OAuthRuntimeDeps): OAuthRuntime {
  const { options, logger, clock, storage } = deps;
  const issuer = new URL(deps.issuer).origin;
  const accessTtl = checkInt(
    'oauth.accessTokenTtlSeconds',
    options.accessTokenTtlSeconds ?? DEFAULT_OAUTH_ACCESS_TTL_S,
    60,
    86_400,
  );
  const refreshTtl = checkInt(
    'oauth.refreshTokenTtlSeconds',
    options.refreshTokenTtlSeconds ?? DEFAULT_OAUTH_REFRESH_TTL_S,
    3_600,
    365 * 86_400,
  );
  if (typeof options.consent !== 'function') throw new TypeError('oauth.consent must be a function');
  const consent = options.consent;
  // A registration must outlive every refresh token issued to it: the provider renews it at half-life on each token
  // request, so twice the refresh lifetime is enough.
  const registrationTtl = Math.max(OAUTH_MIN_REGISTRATION_TTL_S, 2 * refreshTtl, 2 * accessTtl);
  const env: ProviderEnv = Object.freeze({ OAUTH_KV: oauthKvNamespace(storage.kv, () => clock.now()) });
  const resourceUrl = (slug: string): string => `${issuer}/w/${slug}/mcp`;
  /** Declared for routes that need no workspace (metadata, registration): never a valid slug, so never a token's. */
  const placeholderResource = `${issuer}/w/-/mcp`;

  let loaded: ProviderModule | undefined;
  /** The provider module, kept once loaded (a completed value, never a pending promise, L-096). */
  const provider = async (): Promise<ProviderModule> => {
    loaded ??= await import('@cloudflare/workers-oauth-provider');
    return loaded;
  };

  const servers = new Map<string, OAuthAuthorizationServer<ProviderEnv>>();
  const server = async (resources: readonly string[]): Promise<OAuthAuthorizationServer<ProviderEnv>> => {
    const list = resources.length === 0 ? [placeholderResource] : [...new Set(resources)].sort();
    const key = list.join('\n');
    const cached = servers.get(key);
    if (cached) return cached;
    const mod = await provider();
    const built = new mod.OAuthAuthorizationServer<ProviderEnv>({
      issuer,
      resources: list,
      scopesSupported: [...OAUTH_SCOPES],
      authorizeEndpoint: OAUTH_AUTHORIZE_PATH,
      tokenEndpoint: OAUTH_TOKEN_PATH,
      clientRegistrationEndpoint: OAUTH_REGISTER_PATH,
      accessTokenTTL: accessTtl,
      refreshTokenTTL: refreshTtl,
      // Client ID Metadata Documents are P5-03 (an SSRF surface, L-088): off until a guarded fetcher exists.
      clientIdMetadataDocumentEnabled: false,
      clientRegistrationTTL: registrationTtl,
      allowTokenExchangeGrant: false,
      // Access is decided again on every issuance (code exchange and refresh).
      tokenExchangeCallback: (o) => checkIssuance(mod, o),
      // Stable server-side reasons only: never the description's echoed input or the error detail.
      onError: ({ code, status, internal }) => {
        logger.debug('oauth error response', { code, status, reason: internal?.reason ?? null });
      },
    });
    if (servers.size >= MAX_CACHED_SERVERS) servers.delete(servers.keys().next().value as string);
    servers.set(key, built);
    return built;
  };

  const requestIdOf = (c: Context): string | null => {
    const id = c.get('requestId' as never) as unknown;
    return typeof id === 'string' ? id : null;
  };
  /** Writes an audit row; the write is kept alive past the response when the writer detaches it (Workers). */
  const audit = (event: OAuthEvent, c: Context): void => {
    try {
      const work = deps.audit?.(event);
      if (work instanceof Promise) deps.runInBackground(c, work, 'oauth audit');
    } catch (error) {
      logger.warn('oauth audit failed', { error: (error as Error).name });
    }
  };

  /** A slug when `resource` is exactly one of our per-workspace resource URLs (scheme and host compare case-insensitively). */
  const slugOf = (resource: string): string | null => {
    // ASCII folding only: `toLowerCase()` would also map e.g. U+212A KELVIN SIGN to `k`.
    if (resource.slice(0, issuer.length).replace(/[A-Z]/g, (ch) => ch.toLowerCase()) !== issuer) return null;
    const path = resource.slice(issuer.length);
    if (!path.startsWith('/w/') || !path.endsWith('/mcp')) return null;
    const slug = path.slice('/w/'.length, -'/mcp'.length);
    return SLUG_RE.test(slug) ? slug : null;
  };
  /** RFC 8707 on a request: exactly one `resource`, one of ours. */
  const targetSlug = (params: URLSearchParams): string | null => {
    const resources = params.getAll('resource');
    return resources.length === 1 ? slugOf(resources[0] as string) : null;
  };

  /**
   * The access decision for a grant, as an OAuth principal for the workspace `slug`: the same resolver a device token
   * goes through. `grant.userId` must be the person the token is for (service grants have none and are refused).
   */
  const decide = async (
    props: { readonly grantId: string; readonly workspaceId: string; readonly userId: string },
    slug: string,
    who: { readonly tokenId: string; readonly clientId: string; readonly expiresAt: number | null },
  ): Promise<
    | { readonly ok: true; readonly access: EffectiveAccess }
    | { readonly ok: false; readonly reason: DenyReason | 'principal_mismatch' }
  > => {
    const records = await loadAccessRecords(storage, props.grantId);
    const decision = resolveAccess(
      {
        kind: 'oauth',
        tokenId: who.tokenId,
        clientId: who.clientId,
        grantId: props.grantId,
        workspaceId: props.workspaceId,
        writeScope: false,
        expiresAt: who.expiresAt,
      },
      slug,
      records,
      deps.access,
      clock.now(),
    );
    if (!decision.ok) return decision;
    if (decision.access.grant.userId !== props.userId) return { ok: false, reason: 'principal_mismatch' };
    return decision;
  };

  /**
   * Every token issuance (code exchange, refresh) re-runs the access decision for the grant the device was approved
   * with. A refusal is `invalid_grant`, on which the provider revokes the device's grant (its whole token family). On
   * success the access token (and, at the code exchange, the refresh lifetime) is capped at the grant's own expiry.
   */
  const checkIssuance = async (
    mod: ProviderModule,
    o: TokenExchangeCallbackOptions<ProviderEnv>,
  ): Promise<TokenExchangeCallbackResult | undefined> => {
    const code = o.grantType === mod.GrantType.AUTHORIZATION_CODE;
    if (!code && o.grantType !== mod.GrantType.REFRESH_TOKEN) {
      throw new mod.OAuthError('unsupported_grant_type', { description: 'Grant type not supported' });
    }
    const tokenId = `oauth_${o.grantId}`;
    const refuse = (reason: string, workspaceId: string | null): never => {
      logger.info('oauth token refused; device revoked', {
        reason,
        oauthGrant: o.grantId,
        grantType: o.grantType,
      });
      o.env.AB_RECORD?.({
        action: 'oauth.token.refused',
        status: 'denied',
        requestId: o.env.AB_REQUEST_ID ?? null,
        userId: o.userId,
        grantId: null,
        workspaceId,
        clientId: o.clientId,
        tokenId,
        reason,
        details: { grantType: o.grantType, revoked: true },
      });
      throw new mod.OAuthError('invalid_grant', { description: 'The authorization is no longer valid.' });
    };
    const props = o.props as Partial<OAuthGrantProps> | null;
    const slug = typeof o.resource === 'string' ? slugOf(o.resource) : null;
    if (
      props === null ||
      typeof props !== 'object' ||
      typeof props.grantId !== 'string' ||
      typeof props.workspaceId !== 'string' ||
      props.userId !== o.userId ||
      props.clientId !== o.clientId ||
      slug === null ||
      props.workspaceSlug !== slug
    ) {
      return refuse('oauth_mismatch', null);
    }
    const decision = await decide(
      { grantId: props.grantId, workspaceId: props.workspaceId, userId: o.userId },
      slug,
      { tokenId, clientId: o.clientId, expiresAt: null },
    );
    if (!decision.ok) return refuse(decision.reason, props.workspaceId);
    const grantEnd = decision.access.expiresAt;
    if (grantEnd === null) return undefined;
    const remaining = Math.floor((grantEnd - clock.now()) / 1000);
    if (remaining < 60) return refuse('grant_expired', props.workspaceId);
    return {
      accessTokenTTL: Math.min(accessTtl, remaining),
      ...(code ? { refreshTokenTTL: Math.min(refreshTtl, remaining) } : {}),
    };
  };

  /** Every workspace's resource: the token endpoint serves them all (the grant names its own). */
  const allWorkspaces = async (): Promise<OAuthAuthorizationServer<ProviderEnv>> =>
    server((await storage.workspaces.list()).map((w) => resourceUrl(w.slug)));

  /** The request re-addressed to the issuer origin (the provider compares endpoints with the issuer's URLs). */
  const atIssuer = (c: Context, body?: string): Request => {
    const url = new URL(c.req.url);
    const headers = new Headers(c.req.raw.headers);
    headers.delete('content-length');
    return new Request(`${issuer}${url.pathname}${url.search}`, {
      method: c.req.method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
  };
  /** The provider's env for one request (the request id reaches the issuance check's audit rows). */
  const requestEnv = (c: Context): ProviderEnv => {
    const requestId = requestIdOf(c);
    return {
      ...env,
      AB_RECORD: (event) => audit(event, c),
      ...(requestId === null ? {} : { AB_REQUEST_ID: requestId }),
    };
  };
  const executionContext = (c: Context) => ({
    waitUntil: (task: Promise<unknown>) => deps.runInBackground(c, task, 'oauth'),
    passThroughOnException: () => undefined,
    props: {},
  });
  const fetchProvider = async (
    as: OAuthAuthorizationServer<ProviderEnv>,
    c: Context,
    body?: string,
  ): Promise<Response> =>
    // The provider's fetch takes the Workers `ExecutionContext`; it only calls `waitUntil` on it.
    as.fetch(
      atIssuer(c, body),
      requestEnv(c),
      executionContext(c) as unknown as Parameters<typeof as.fetch>[2],
    );

  const codeMarker = async (code: string): Promise<string> => `${CODE_MARKER_PREFIX}${await sha256Hex(code)}`;
  const tombstone = (userId: string, grantId: string): string => `${TOMBSTONE_PREFIX}${userId}:${grantId}`;
  const tombstoneTtlMs = Math.max(refreshTtl, accessTtl, 60) * 1000;
  /** Revoke a device's provider grant and every token of it, leaving a tombstone first (see {@link TOMBSTONE_PREFIX}). */
  const revokeFamily = async (userId: string, grantId: string, helpers: OAuthHelpers): Promise<void> => {
    await storage.kv.set(tombstone(userId, grantId), '1', { expiresAt: clock.now() + tombstoneTtlMs });
    await helpers.revokeGrant(grantId, userId);
  };
  /**
   * After the provider issued tokens for the code in `presented`: if its device was revoked meanwhile (a concurrent
   * replay, an administrator), revoke again (the provider may have written the grant back) and refuse.
   */
  const revokedMeanwhile = async (presented: string, helpers: OAuthHelpers): Promise<boolean> => {
    const m = PROVIDER_TOKEN_RE.exec(presented);
    if (m === null) return false;
    const [, userId, grantId] = m as unknown as [string, string, string];
    if ((await storage.kv.get(tombstone(userId, grantId))) === null) return false;
    await helpers.revokeGrant(grantId, userId);
    logger.warn('oauth tokens issued for a revoked device; revoked again', { oauthGrant: grantId });
    return true;
  };

  /** A replayed (or raced) code: when it really was issued for its grant, revoke the grant and its tokens. */
  const revokeReplayed = async (c: Context, code: string, helpers: OAuthHelpers): Promise<void> => {
    const m = PROVIDER_TOKEN_RE.exec(code);
    if (m === null) return;
    const [, userId, grantId] = m as unknown as [string, string, string];
    const grant = (await env.OAUTH_KV.get(`grant:${userId}:${grantId}`, { type: 'json' })) as {
      readonly authCodeId?: unknown;
      readonly clientId?: unknown;
    } | null;
    if (grant === null || grant.authCodeId !== (await sha256Hex(code))) return;
    await revokeFamily(userId, grantId, helpers);
    logger.warn('oauth authorization code replayed; grant revoked', { oauthGrant: grantId });
    audit(
      {
        action: 'oauth.code.replayed',
        status: 'denied',
        requestId: requestIdOf(c),
        userId,
        clientId: typeof grant.clientId === 'string' ? grant.clientId : null,
        tokenId: `oauth_${grantId}`,
        reason: 'code_replayed',
        details: { revoked: true },
      },
      c,
    );
  };

  const runtime: OAuthRuntime = {
    issuer,
    resourceUrl,

    async metadata(c) {
      const response = await fetchProvider(await server([]), c);
      if (!response.ok) return response;
      // RFC 9728 `protected_resources` is optional. Workspace slugs are not public (T19), and this server only declares
      // a placeholder here: clients find a workspace's resource through its own metadata (P5-02).
      const meta = (await response.json()) as Record<string, unknown>;
      delete meta['protected_resources'];
      meta['client_id_metadata_document_supported'] = false;
      const headers = new Headers(response.headers);
      headers.delete('content-length');
      return new Response(JSON.stringify(meta), { status: response.status, headers });
    },

    async register(c) {
      const body = await readBounded(c.req.raw, OAUTH_MAX_BODY_BYTES);
      if (body === null) return jsonError(413, 'invalid_request', 'Request body too large.');
      const mediaType = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
      if (mediaType !== 'application/json') {
        return jsonError(400, 'invalid_client_metadata', 'Send the client metadata as application/json.');
      }
      return fetchProvider(await server([]), c, body);
    },

    async token(c, onRevocation) {
      const body = await readBounded(c.req.raw, OAUTH_MAX_BODY_BYTES);
      if (body === null) return jsonError(413, 'invalid_request', 'Request body too large.');
      // RFC 6749 §3.2: the token endpoint takes form-encoded parameters, none twice (else the code we consume and the
      // code the provider reads could differ).
      const mediaType = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
      if (mediaType !== 'application/x-www-form-urlencoded') {
        return jsonError(400, 'invalid_request', 'Send the request as application/x-www-form-urlencoded.');
      }
      const form = new URLSearchParams(body);
      if (repeated(form)) return jsonError(400, 'invalid_request', 'Parameters must not be repeated.');
      const grantType = form.get('grant_type');
      // RFC 8707: a `resource` on the token request must be one of ours (the provider then requires it to be the
      // grant's own, so a refresh cannot retarget). Left out, the grant's resource applies. Checked before the code is
      // consumed, so a client that sent a bad one can retry.
      if (form.has('resource') && targetSlug(form) === null) {
        return jsonError(400, 'invalid_target', 'resource must name one MCP endpoint of this server.');
      }
      const as = await allWorkspaces();
      const helpers = as.getOAuthApi(env);
      const code = form.get('code') ?? '';
      if (grantType === 'authorization_code') {
        // RFC 7636 §4.1: a verifier is 43-128 unreserved characters. Refused before the code is consumed, so a short,
        // guessable verifier (a client bug) never redeems a code.
        if (!PKCE_VERIFIER_RE.test(form.get('code_verifier') ?? '')) {
          return jsonError(400, 'invalid_request', 'code_verifier must be 43-128 characters (RFC 7636).');
        }
        // Single use, atomically: of concurrent exchanges at most one finds the marker (L-073, T9).
        const fresh = looksLikeOAuthToken(code) && (await storage.kv.take(await codeMarker(code))) !== null;
        if (!fresh) {
          if (looksLikeOAuthToken(code)) await revokeReplayed(c, code, helpers);
          return jsonError(400, 'invalid_grant', 'Invalid authorization code');
        }
      }
      // RFC 7009 revocation shares this endpoint (no grant_type).
      const revocation = grantType === null && form.has('token');
      const response = await fetchProvider(as, c, body);
      if (grantType === 'authorization_code') {
        if (response.ok && (await revokedMeanwhile(code, helpers))) {
          return jsonError(400, 'invalid_grant', 'Invalid authorization code');
        }
        const m = PROVIDER_TOKEN_RE.exec(code);
        audit(
          {
            action: 'oauth.token.issued',
            status: response.ok ? 'ok' : 'denied',
            requestId: requestIdOf(c),
            userId: m?.[1] ?? null,
            clientId: form.get('client_id'),
            tokenId: m === null ? null : `oauth_${m[2]}`,
            reason: response.ok ? null : 'provider_refused',
            details: { grantType },
          },
          c,
        );
      } else if (grantType === 'refresh_token') {
        const m = PROVIDER_TOKEN_RE.exec(form.get('refresh_token') ?? '');
        if (response.ok) {
          audit(
            {
              action: 'oauth.token.issued',
              status: 'ok',
              requestId: requestIdOf(c),
              userId: m?.[1] ?? null,
              clientId: form.get('client_id'),
              tokenId: m === null ? null : `oauth_${m[2]}`,
              details: { grantType },
            },
            c,
          );
        }
      }
      if (revocation && response.ok) {
        // Drop cached decisions at once, so a revoked token stops working here without waiting for the cache.
        onRevocation();
        const m = PROVIDER_TOKEN_RE.exec(form.get('token') ?? '');
        audit(
          {
            action: 'oauth.token.revoked',
            status: 'ok',
            requestId: requestIdOf(c),
            userId: m?.[1] ?? null,
            clientId: form.get('client_id'),
            tokenId: m === null ? null : `oauth_${m[2]}`,
          },
          c,
        );
      }
      return response;
    },

    async authorize(c) {
      const prepared = await runtime.prepare(c, new URL(c.req.url).searchParams);
      return prepared instanceof Response ? prepared : consent(c, prepared);
    },

    async prepare(c, params) {
      // RFC 6749 §3.1: no parameter twice (what the consent step is shown must be what the provider acts on).
      if (repeated(params)) return jsonError(400, 'invalid_request', 'Parameters must not be repeated.');
      // RFC 8707: exactly one resource, one of ours. Refused before the client is known, so never redirected.
      const slug = targetSlug(params);
      if (slug === null) {
        return jsonError(400, 'invalid_target', 'resource must name one MCP endpoint of this server.');
      }
      const resource = resourceUrl(slug);
      const mod = await provider();
      const as = await server([resource]);
      const helpers = as.getOAuthApi(env);
      let authRequest: AuthRequest;
      try {
        // The provider reads the request URL only: hand it the authorization endpoint with exactly these parameters.
        authRequest = await helpers.parseAuthRequest(
          new Request(`${issuer}${OAUTH_AUTHORIZE_PATH}?${params.toString()}`),
        );
      } catch (error) {
        if (error instanceof mod.AuthorizationError) {
          const e = error as ProviderAuthorizationError;
          // `redirectTo` is set only once the client and its redirect URI were validated (RFC 6749 §4.1.2.1).
          if (e.redirectTo) return redirect(e.redirectTo);
          return jsonError(400, e.code, e.description ?? 'Invalid authorization request.');
        }
        logger.debug('oauth authorize request refused', {
          error: error instanceof Error ? error.name : typeof error,
        });
        return jsonError(400, 'invalid_request', 'Invalid authorization request.');
      }
      const refuse = (
        code: 'invalid_request' | 'invalid_target' | 'unsupported_response_type',
        description: string,
      ) => redirect(mod.authorizationErrorRedirect(authRequest, code, description));
      // OAuth 2.1: PKCE for every client, S256 only (the provider insists only for public clients).
      if (!authRequest.codeChallenge || authRequest.codeChallengeMethod !== 'S256') {
        return refuse('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
      }
      if (authRequest.resource !== resource) return refuse('invalid_target', 'Unknown resource.');
      if (authRequest.responseType !== 'code') return refuse('unsupported_response_type', 'Use code.');
      const client: ClientInfo | null = await helpers.lookupClient(authRequest.clientId);
      if (client === null) return jsonError(400, 'invalid_client', 'Unknown client.');
      const requested = authRequest.scope;
      const scope = [MCP_SCOPE, ...(requested.includes('offline_access') ? ['offline_access'] : [])];
      const request: OAuthAuthorizationRequest = Object.freeze({
        clientId: authRequest.clientId,
        clientName: client.clientName ?? null,
        redirectUri: authRequest.redirectUri,
        redirectHost: new URL(authRequest.redirectUri).host,
        scope: Object.freeze(scope),
        resource,
        workspaceSlug: slug,
      });
      let used = false;
      const api: OAuthConsentApi = Object.freeze({
        request,
        authRequest,
        helpers,
        deny: (description = 'The user denied the request.') => {
          audit(
            {
              action: 'oauth.authorize',
              status: 'denied',
              requestId: requestIdOf(c),
              clientId: authRequest.clientId,
              reason: 'user_denied',
            },
            c,
          );
          return mod.authorizationErrorRedirect(authRequest, 'access_denied', description);
        },
        approve: async ({ userId, grantId }: { readonly userId: string; readonly grantId: string }) => {
          if (used) throw new Error('an authorization request is approved at most once');
          used = true;
          const workspace = await storage.workspaces.getBySlug(slug);
          const refused = (reason: DenyReason | 'principal_mismatch'): OAuthApproval => {
            audit(
              {
                action: 'oauth.authorize',
                status: 'denied',
                requestId: requestIdOf(c),
                userId,
                grantId,
                workspaceId: workspace?.id ?? null,
                clientId: authRequest.clientId,
                reason,
              },
              c,
            );
            return { ok: false, reason };
          };
          if (workspace === null) return refused('workspace_missing');
          // The same deny-by-default decision a request with the resulting token will get.
          const decision = await decide({ grantId, workspaceId: workspace.id, userId }, slug, {
            tokenId: 'oauth_pending',
            clientId: authRequest.clientId,
            expiresAt: null,
          });
          if (!decision.ok) return refused(decision.reason);
          const props: OAuthGrantProps = {
            grantId,
            workspaceId: workspace.id,
            workspaceSlug: slug,
            userId,
            clientId: authRequest.clientId,
          };
          const { redirectTo } = await helpers.completeAuthorization({
            request: authRequest,
            userId,
            // T25: grant metadata is stored unencrypted: only the access grant id (opaque), never an email or other
            // personal data.
            metadata: { grant: grantId },
            scope: [...scope],
            props,
          });
          const code = new URL(redirectTo).searchParams.get('code');
          if (code === null) throw new Error('the provider returned no authorization code');
          await storage.kv.set(await codeMarker(code), '1', {
            expiresAt: clock.now() + OAUTH_CODE_TTL_S * 1000,
          });
          audit(
            {
              action: 'oauth.authorize',
              status: 'ok',
              requestId: requestIdOf(c),
              userId,
              grantId,
              workspaceId: workspace.id,
              clientId: authRequest.clientId,
            },
            c,
          );
          return { ok: true as const, redirectTo, scope };
        },
      });
      return api;
    },

    async authenticate(token, slug) {
      if (!SLUG_RE.test(slug) || !looksLikeOAuthToken(token)) {
        return { ok: false, stage: 'token', reason: 'oauth_invalid' };
      }
      const resource = resourceUrl(slug);
      const validated = await (await server([resource])).validateToken<OAuthGrantProps>(resource, token, env);
      if (validated === null) return { ok: false, stage: 'token', reason: 'oauth_invalid' };
      const props = validated.props as Partial<OAuthGrantProps> | null;
      if (
        validated.audience !== resource ||
        !validated.scope.includes(MCP_SCOPE) ||
        props === null ||
        typeof props !== 'object' ||
        typeof props.grantId !== 'string' ||
        typeof props.workspaceId !== 'string' ||
        props.workspaceSlug !== slug ||
        props.userId !== validated.userId ||
        props.clientId !== validated.clientId
      ) {
        return { ok: false, stage: 'token', reason: 'oauth_mismatch' };
      }
      const providerGrant = (PROVIDER_TOKEN_RE.exec(token) as RegExpExecArray)[2] as string;
      const tokenId = `oauth_${providerGrant}`;
      const decision = await decide(
        { grantId: props.grantId, workspaceId: props.workspaceId, userId: props.userId },
        slug,
        { tokenId, clientId: validated.clientId, expiresAt: validated.expiresAt * 1000 },
      );
      if (!decision.ok) return { ok: false, stage: 'access', tokenId, reason: decision.reason };
      return { ok: true, access: decision.access };
    },
  };
  return runtime;
}
