// SPDX-License-Identifier: Apache-2.0
// The HTTP app (ARCHITECTURE §5, ADR-0005): `/w/{slug}/mcp` per workspace, stateless, one MCP server per request with
// only the caller's tools. Web-standard only, so the same app runs on Node (`agility-bridge serve`) and Workers.
import {
  type AccessSettings,
  type Actor,
  authenticateDeviceToken,
  bearerToken,
  type CredentialValidator,
  type EffectiveAccess,
  hashDeviceToken,
  isWellFormedDeviceToken,
  KeyPurpose,
  type Keyring,
  openCredentialToken,
  resolvePassthroughAccess,
  type TokenEnvironment,
  type ValidationResult,
} from '@agility-bridge/auth';
import {
  buildMcpServer,
  type CircuitBreakers,
  type Clock,
  CredentialLimiters,
  createBudget,
  type FetchLike,
  type Logger,
  type MetadataService,
  type Random,
  Secret,
  type ToolCallEvent,
  type ToolContext,
  type ToolDefinition,
  ToolRegistry,
} from '@agility-bridge/core';
import type { Storage } from '@agility-bridge/storage';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { LinearRouter } from 'hono/router/linear-router';
import { AccessCache } from './access-cache.ts';
import { ADMIN_BASE, type AdminApiOptions, adminAuthenticator, createAdminApi } from './admin/api.ts';
import { errorBody } from './admin/errors.ts';
import { ADMIN_UI_BASE, type AdminUiModule, adminUiDeps, loadAdminUiModule } from './admin-ui.ts';
import type { LoginEvent, OAuthEvent } from './audit.ts';
import { createEdge, type EdgeOptions } from './edge.ts';
import { createIdentityRoutes, IDENTITY_BASE, type IdentityOptions } from './identity.ts';
import { type ClassifiedRequest, classifyMcpMessage, jsonRpcError, readMcpBody } from './mcp-request.ts';
import { type ConsentScreen, createConsentScreen, OAUTH_CONSENT_PATH } from './oauth/consent.ts';
import {
  createOAuthRuntime,
  looksLikeOAuthToken,
  OAUTH_AUTHORIZE_PATH,
  OAUTH_METADATA_PATH,
  OAUTH_REGISTER_PATH,
  OAUTH_RESOURCE_METADATA_PREFIX,
  OAUTH_TOKEN_PATH,
  type OAuthOptions,
  type OAuthRegistrations,
  type OAuthRuntime,
} from './oauth/server.ts';
import { createSessionManager, type SessionManager, type SessionOptions } from './session.ts';

/** 1 MiB (ARCHITECTURE §5 step 1). */
export const MAX_BODY_BYTES = 1024 * 1024;
/** The whole exchange, a streamed response included (ARCHITECTURE §6.5). */
export const EXCHANGE_DEADLINE_MS = 180_000;

/** Why a request was refused before reaching a tool, for logs, audit and limits (never sent to the client). */
export type RefusalReason =
  | 'host'
  | 'origin'
  | 'unauthenticated'
  | 'rate_limited'
  | 'body'
  | 'unavailable'
  | string;

export interface RequestEvent {
  readonly requestId: string;
  readonly ip: string;
  readonly slug: string;
  readonly status: number;
  readonly durationMs: number;
  readonly mcp: ClassifiedRequest | null;
  /** Set once the caller is authenticated. */
  readonly access: EffectiveAccess | null;
  /** Set when the request was refused; the deny reason of the resolver for authentication failures. */
  readonly refusal: RefusalReason | null;
}

export interface ToolCallRecord extends ToolCallEvent {
  readonly requestId: string;
  readonly access: EffectiveAccess;
}

/** Observers for audit (P2-08) and access logs. They must not throw; a throw is logged and ignored. */
/** Observers may return work they started (an audit write); the app keeps it alive through `background`. */
export interface HttpObserver {
  request?(event: RequestEvent): unknown;
  toolCall?(event: ToolCallRecord): unknown;
}

export type LimitDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly retryAfterSeconds: number };

/** Rate-limit hooks (P2-07). Each answers whether the request may go on. */
export interface RequestLimits {
  /** Per client IP, before authentication. */
  beforeAuth?(ip: string, now: number): LimitDecision | Promise<LimitDecision>;
  /** Charged only when authentication fails (a valid token is never locked out by others' failures). */
  onAuthFailure?(ip: string, now: number): void | Promise<void>;
  /** Per client IP on the sign-in routes (P4-01): each start writes a row and may call the identity provider. */
  beforeSignIn?(ip: string, now: number): LimitDecision | Promise<LimitDecision>;
  /** Before an upstream validation of a new pass-through token (P2-14), per instance. */
  beforeValidation?(instanceId: string, now: number): LimitDecision | Promise<LimitDecision>;
  /** True when the IP has no failures left: a failed attempt then answers 429 instead of 401. */
  failuresExhausted?(ip: string, now: number): boolean | Promise<boolean>;
  /** Per token and grant, after authentication. */
  afterAuth?(
    access: EffectiveAccess,
    mcp: ClassifiedRequest,
    now: number,
  ): LimitDecision | Promise<LimitDecision>;
}

/** Per-process services the tool context needs (owned by the host). */
export interface HostServices {
  /** The `fetch` pinned to an instance's TLS settings (custom CA on Node, ADR-0014). */
  fetchFor(instance: EffectiveAccess['instance']): FetchLike;
  readonly limiters: CredentialLimiters;
  readonly breakers: CircuitBreakers;
  readonly metadata: MetadataService;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly random: Random;
}

export interface HttpAppOptions extends EdgeOptions {
  readonly storage: Storage;
  readonly keyring: Keyring;
  readonly access: AccessSettings & { readonly environment: TokenEnvironment };
  /** Every tool definition the server knows (`CORE_TOOLS`). */
  readonly tools: readonly ToolDefinition[];
  readonly services: HostServices;
  /** Seconds a resolved access is reused (0-60, default 30, L-068). */
  readonly accessCacheTtlSeconds?: number;
  readonly limits?: RequestLimits;
  readonly observer?: HttpObserver;
  /** The client address (the host knows the socket and trusted proxies, P2-07). */
  readonly clientIp?: (c: Context) => string;
  readonly version: string;
  readonly maxBodyBytes?: number;
  readonly deadlineMs?: number;
  /**
   * Pass-through workspaces (`AB_PASSTHROUGH=on`, P2-14): callers of a workspace whose `credentialSource` is
   * `passthrough` send their own Agility token in `X-Agility-Token`. Absent = such requests are refused.
   */
  readonly passthrough?: {
    readonly validator: CredentialValidator;
    /** Whether this request reached the server over HTTPS (directly, or through a trusted proxy). */
    readonly secure: (c: Context) => boolean;
    /** Seconds a validated token's identity is reused (default 300). */
    readonly identityTtlSeconds?: number;
  };
  /**
   * The OAuth 2.1 authorization server (P5-01): metadata, `/oauth/authorize`, `/oauth/token`, `/oauth/register`, and
   * OAuth access tokens accepted on `/w/{slug}/mcp` next to device tokens. Absent = those routes answer 404 and only
   * device tokens work. Needs `publicUrl` (the issuer).
   */
  readonly oauth?: OAuthOptions & {
    /** Records OAuth steps as `auth` audit rows (`AuditWriter.oauth`). */
    readonly audit?: (event: OAuthEvent) => unknown;
  };
  /** The admin API at `/api/admin/v1` (P2-09); absent = the whole API answers 404. */
  readonly admin?: Pick<AdminApiOptions, 'services' | 'audit' | 'authenticate'>;
  /** Admin session timeouts, cap and logout behaviour (P4-02); used when sign-in (`identity`) is configured. */
  readonly session?: SessionOptions;
  /**
   * The sign-in routes at `/auth` (P4-01); absent = they answer 404. Needs the keyring (the `login` purpose key).
   */
  readonly identity?: Pick<
    IdentityOptions,
    'publicUrl' | 'providers' | 'policy' | 'onLogin' | 'auditAdmin'
  > & {
    /** Records sign-ins (`AuditWriter.login`). */
    readonly audit?: (event: LoginEvent) => Promise<void> | undefined;
  };
  /**
   * `process` (Node, default): one process serves every request. `request` (Workers, L-096): nothing in flight is shared
   * between requests: a concurrency limiter per request and no shared pass-through validation. Pair it with a
   * detached `AuditWriter`, `MetadataService({ shareInflight: false })` and `background`.
   */
  readonly isolation?: 'process' | 'request';
  /** Keeps work started for a request alive after the response (Workers: `c.executionCtx.waitUntil`). */
  readonly background?: (c: Context, work: Promise<unknown>) => void;
  /**
   * The tools, registered once (their JSON Schemas converted, L-020). Workers build it at module scope, outside the
   * request's CPU budget (P3-14); default: built here from `tools`.
   */
  readonly registry?: ToolRegistry;
}

export interface HttpApp {
  readonly app: Hono;
  /** `executionCtx`: the Workers `ExecutionContext` (`waitUntil`); absent on Node. */
  readonly fetch: (
    request: Request,
    env?: unknown,
    executionCtx?: { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void },
  ) => Response | Promise<Response>;
  /** Forget cached access decisions (call after local admin changes). */
  clearAccessCache(): void;
  /** Counts and cleanup of OAuth client registrations (P5-03); absent when OAuth is off. */
  readonly oauthRegistrations?: OAuthRegistrations;
}

interface PreparedRequest {
  readonly tools: readonly ToolDefinition[];
  readonly ctx: ToolContext;
  readonly onToolCall: (event: ToolCallEvent) => void;
}

const UNAUTHORIZED = JSON.stringify({ error: 'unauthorized' });
/** Carries the request id into the lazily built admin app (Workers); set by the server, never trusted from clients. */
const INTERNAL_REQUEST_ID = 'x-agility-bridge-internal-request-id';
/** Pass-through identities kept at most (P2-14). */
const MAX_IDENTITIES = 10_000;

/** Runs an app mounted behind this one for `request`, with this request's environment and execution context. */
function dispatch(target: Hono, request: Request, c: Context): Response | Promise<Response> {
  let ctx: { waitUntil(p: Promise<unknown>): void; passThroughOnException(): void } | undefined;
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = undefined;
  }
  return ctx === undefined ? target.fetch(request, c.env) : target.fetch(request, c.env, ctx as never);
}

/** A copy of the request for an app mounted behind this one, carrying the request id in the internal header. */
function forwardRequest(c: Context): Request {
  const headers = new Headers(c.req.raw.headers);
  headers.set(INTERNAL_REQUEST_ID, (c.get('requestId' as never) as string | undefined) ?? '');
  const method = c.req.method;
  if (method === 'GET' || method === 'HEAD') return new Request(c.req.url, { method, headers });
  return new Request(c.req.url, { method, headers, body: c.req.raw.body, duplex: 'half' } as RequestInit);
}

/** Ends a streamed body at the deadline. */
function withDeadline(response: Response, ms: number, onTimeout: () => void): Response {
  if (response.body === null) return response;
  const reader = response.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setTimeout(() => {
        onTimeout();
        reader.cancel().catch(() => {});
        controller.error(new Error('deadline'));
      }, ms);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          clearTimeout(timer);
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        clearTimeout(timer);
        controller.error(error);
      }
    },
    cancel(reason) {
      clearTimeout(timer);
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function createHttpApp(options: HttpAppOptions): HttpApp {
  const edge = createEdge(options);
  const maxBody = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const deadlineMs = options.deadlineMs ?? EXCHANGE_DEADLINE_MS;
  const cache = new AccessCache((options.accessCacheTtlSeconds ?? 30) * 1000);
  /** Pass-through identities validated recently: HMAC fingerprint → valid until (P2-14). */
  const identities = new Map<string, number>();
  /** Validations in flight by the same key: concurrent requests with one new token share one upstream check. */
  const validating = new Map<string, Promise<ValidationResult>>();
  const remember = (key: string, until: number, now: number) => {
    // Bounded: drop expired entries first, then the oldest (P2-17 review F4); never a wholesale clear that would
    // make every caller validate again at once.
    if (identities.size >= MAX_IDENTITIES) {
      for (const [k, expires] of identities) if (expires <= now) identities.delete(k);
      while (identities.size >= MAX_IDENTITIES) {
        const oldest = identities.keys().next();
        if (oldest.done === true) break;
        identities.delete(oldest.value);
      }
    }
    identities.delete(key);
    identities.set(key, until);
  };
  const { services } = options;
  const registry = options.registry ?? new ToolRegistry();
  if (options.registry === undefined) for (const tool of options.tools) registry.register(tool);
  const clientIp = options.clientIp ?? (() => 'unknown');

  const keepAlive = (c: Context, work: Promise<unknown>) => {
    const settled = work.catch((error: unknown) => {
      services.logger.warn('background work failed', { error: (error as Error).name });
    });
    options.background?.(c, settled);
  };
  const perRequest = options.isolation === 'request';
  /**
   * The admin panel, imported the first time a panel or sign-in page is needed and never by an MCP request (P3-14,
   * L-182). The module namespace holds no request data (L-013); a failed import is retried by the next request.
   */
  let uiModule: AdminUiModule | undefined;
  const loadUi = async (): Promise<AdminUiModule> => (uiModule ??= await loadAdminUiModule());
  // Admin sessions exist when sign-in does (P4-02). Stateless: everything is read from storage per request (L-013).
  const sessions: SessionManager | undefined =
    options.identity === undefined
      ? undefined
      : createSessionManager({
          publicUrl: options.identity.publicUrl,
          storage: options.storage,
          clock: services.clock,
          ...(options.session === undefined ? {} : { options: options.session }),
          ...(options.identity.auditAdmin === undefined ? {} : { audit: options.identity.auditAdmin }),
          runInBackground: keepAlive,
        });
  const observe = <K extends keyof HttpObserver>(
    c: Context,
    kind: K,
    event: Parameters<NonNullable<HttpObserver[K]>>[0],
  ) => {
    try {
      const work = (options.observer?.[kind] as ((e: typeof event) => unknown) | undefined)?.(event);
      if (work instanceof Promise) keepAlive(c, work);
    } catch (error) {
      services.logger.warn('observer failed', { kind, error: (error as Error).name });
    }
  };

  // One handler per app; the per-request tools and context reach the factory through authInfo (ADR-0005, L-013).
  const handler = createMcpHandler(
    ({ authInfo }) => {
      const prepared = authInfo?.extra?.['prepared'] as PreparedRequest | undefined;
      if (prepared === undefined) throw new Error('unreachable: the route authenticates first');
      return buildMcpServer({ tools: prepared.tools, ctx: prepared.ctx, onToolCall: prepared.onToolCall });
    },
    { legacy: 'stateless' },
  );

  // Workers build the app in a request: the linear router has no compile step on its first match (P3-14).
  const app = perRequest ? new Hono({ router: new LinearRouter() }) : new Hono();

  // Request id, security headers on every response (errors and 404s too), Host/Origin allowlists.
  app.use('*', async (c, next) => {
    const requestId = services.random.uuid();
    c.set('requestId' as never, requestId as never);
    const origin = c.req.header('origin');
    let refusal: Response | undefined;
    if (!edge.hostAllowed(c.req.header('host') ?? new URL(c.req.url).host))
      refusal = c.json({ error: 'host not allowed' }, 403);
    else if (!edge.originAllowed(origin)) refusal = c.json({ error: 'origin not allowed' }, 403);
    else if (c.req.method === 'OPTIONS') refusal = c.body(null, 204);
    if (refusal === undefined) await next();
    const res = refusal ?? c.res;
    // A panel page (or sign-in page) keeps its own policy when it is exactly one of the panel's; any other CSP a handler
    // set is replaced, so a mistake in one page cannot loosen the response (P4-03).
    const panelPage = uiModule?.isUiCsp(res.headers.get('content-security-policy')) === true;
    for (const [k, v] of Object.entries(edge.securityHeaders)) {
      if (k === 'content-security-policy' && panelPage) continue;
      // Under `no-referrer` a browser posts its forms with `Origin: null`, which the CSRF check (rightly) refuses
      // (L-191): panel pages say `same-origin`, and nothing else may loosen the app-wide policy.
      if (k === 'referrer-policy' && panelPage) {
        res.headers.set(k, uiModule?.UI_REFERRER_POLICY ?? v);
        continue;
      }
      // The panel's hashed assets are immutable; every other response is `no-store`.
      if (
        k === 'cache-control' &&
        uiModule !== undefined &&
        res.headers.get(k) === uiModule.ASSET_CACHE_CONTROL
      )
        continue;
      res.headers.set(k, v);
    }
    for (const [k, v] of Object.entries(edge.corsHeaders(origin))) res.headers.set(k, v);
    res.headers.set('x-request-id', requestId);
    if (refusal !== undefined) c.res = refusal;
  });

  app.onError((error, c) => {
    // A JSON-typed request with an empty body: the validator's 400, not an internal error (found by P4-08).
    if (error instanceof HTTPException && error.status === 400) {
      return c.json(errorBody('bad_request', 'The body is not valid JSON.'), 400);
    }
    services.logger.error('unhandled error', { error: error.name });
    return c.json({ error: 'internal error' }, 500);
  });
  app.notFound((c) => c.json({ error: 'not found' }, 404));

  // The OAuth runtime (P5-01) and its consent screen (P5-04): built before the admin API, whose "connected apps" routes
  // use the runtime, and kept for the routes registered below.
  let oauth: OAuthRuntime | undefined;
  let consentScreen: ConsentScreen | undefined;
  if (options.oauth !== undefined) {
    const { audit: oauthAudit, ...oauthOptions } = options.oauth;
    if (options.publicUrl === undefined) throw new TypeError('oauth needs publicUrl: it is the issuer');
    let consent = oauthOptions.consent;
    if (consent === undefined) {
      const identity = options.identity;
      if (identity === undefined || sessions === undefined) {
        throw new TypeError(
          'oauth needs sign-in (identity) for its consent screen, or an oauth.consent handler',
        );
      }
      consentScreen = createConsentScreen({
        loadUi,
        ui: adminUiDeps({
          sessions,
          kv: options.storage.kv,
          publicOrigin: new URL(identity.publicUrl).origin,
          now: () => services.clock.now(),
          ...(identity.auditAdmin === undefined ? {} : { audit: identity.auditAdmin }),
          runInBackground: keepAlive,
          onError: (_c, error) =>
            services.logger.error('consent screen error', {
              error: error instanceof Error ? error.name : typeof error,
            }),
        }),
        kv: options.storage.kv,
        clock: services.clock,
        logger: services.logger,
        ...(identity.auditAdmin === undefined ? {} : { audit: identity.auditAdmin }),
        runInBackground: keepAlive,
      });
      consent = consentScreen.handler;
    }
    oauth = createOAuthRuntime({
      options: { ...oauthOptions, consent },
      issuer: options.publicUrl,
      storage: options.storage,
      access: options.access,
      clock: services.clock,
      logger: services.logger,
      runInBackground: (c, work) => keepAlive(c, work),
      clientIp,
      onRevocation: () => cache.clear(),
      ...(oauthAudit === undefined
        ? {}
        : {
            audit: (event: OAuthEvent) => {
              const work = oauthAudit(event);
              if (work instanceof Promise) return work;
              return undefined;
            },
          }),
    });
  }
  const oauthRuntime = oauth;

  /** Enters the admin API app in-process (set when the admin API exists): the panel's changes use the API's own handlers. */
  let adminInProcess: ((request: Request, c: Context) => Response | Promise<Response>) | undefined;

  if (options.admin !== undefined) {
    const admin = options.admin;
    const build = () =>
      createAdminApi({
        ...admin,
        authenticate: adminAuthenticator({
          token: admin.authenticate as (c: Context) => Promise<Actor | null>,
          ...(sessions === undefined ? {} : { sessions }),
        }),
        ...(sessions === undefined ? {} : { revokeUserSessions: (id: string) => sessions.revokeUser(id) }),
        storage: options.storage,
        tools: options.access.tools,
        onChange: () => cache.clear(),
        ...(options.limits === undefined ? {} : { limits: options.limits }),
        clientIp,
        logger: services.logger,
        clock: services.clock,
        background: keepAlive,
        keyring: options.keyring,
        ...(options.identity === undefined ? {} : { setupLinks: { publicUrl: options.identity.publicUrl } }),
        ...(oauthRuntime === undefined
          ? {}
          : {
              oauthDevices: {
                list: (userId: string) => oauthRuntime.devices(userId),
                revoke: (ic: Context, userId: string, id: string) =>
                  oauthRuntime.revokeDevice(ic, userId, id),
                revokeAll: (ic: Context, userId: string) => oauthRuntime.revokeAllDevices(ic, userId),
              },
            }),
        ...(perRequest ? { lightweightRouter: true } : {}),
      });
    // The admin API app is built once, on first use. Workers: on the first admin request, not at every boot, so MCP
    // requests never pay for it (P3-14); it is kept only once complete (L-096).
    let api: ReturnType<typeof createAdminApi> | undefined;
    const getApi = (): ReturnType<typeof createAdminApi> => (api ??= build());
    let inner: Hono | undefined;
    // The app the HTTP route (Workers) and the panel's in-process calls both enter: the API under its base path, with
    // the outer request's id carried in an internal header the caller sets itself (any client copy is replaced).
    const getInner = (): Hono => {
      if (inner === undefined) {
        const built = new Hono({ router: new LinearRouter() });
        built.use(async (ic, next) => {
          ic.set('requestId' as never, (ic.req.header(INTERNAL_REQUEST_ID) ?? '') as never);
          await next();
        });
        built.route(ADMIN_BASE, getApi());
        // The same JSON answers as the main app, and errors logged by name only (P3-11 review).
        built.onError((error, ic) => {
          // A JSON-typed request with an empty body: the validator's 400, not an internal error (found by P4-08).
          if (error instanceof HTTPException && error.status === 400) {
            return ic.json(errorBody('bad_request', 'The body is not valid JSON.'), 400);
          }
          services.logger.error('unhandled error', { error: error.name });
          return ic.json({ error: 'internal error' }, 500);
        });
        built.notFound((ic) => ic.json({ error: 'not found' }, 404));
        inner = built;
      }
      return inner;
    };
    adminInProcess = (request, c) => {
      request.headers.set(INTERNAL_REQUEST_ID, (c.get('requestId' as never) as string | undefined) ?? '');
      return dispatch(getInner(), request, c);
    };
    if (!perRequest) {
      app.route(ADMIN_BASE, getApi());
    } else {
      app.all(`${ADMIN_BASE}/*`, (c) => {
        const headers = new Headers(c.req.raw.headers);
        headers.set(INTERNAL_REQUEST_ID, c.get('requestId' as never) as string);
        return dispatch(getInner(), new Request(c.req.raw, { headers }), c);
      });
    }
  }

  if (options.identity !== undefined) {
    const identity = options.identity;
    const keyring = options.keyring;
    const tooManySignIns = (retryAfterSeconds: number) =>
      new Response('Too many sign-in attempts. Try again in a few minutes.', {
        status: 429,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'retry-after': String(Math.max(1, Math.ceil(retryAfterSeconds))),
        },
      });
    app.route(
      IDENTITY_BASE,
      createIdentityRoutes(
        {
          ...identity,
          storage: options.storage,
          keys: keyring,
          ...(identity.audit === undefined ? {} : { audit: identity.audit }),
          identityHash: async (idp, subject) =>
            `v${keyring.currentVersion}.${(await keyring.mac(KeyPurpose.AuditIdentity, `login|${idp}|${subject}`)).slice(0, 32)}`,
          ...(perRequest ? { lightweightRouter: true } : {}),
        },
        {
          clock: services.clock,
          logger: services.logger,
          ...(sessions === undefined ? {} : { sessions }),
          runInBackground: keepAlive,
          ui: {
            load: loadUi,
            get: () => {
              if (uiModule === undefined)
                throw new Error('unreachable: the sign-in routes load the panel first');
              return uiModule;
            },
          },
          // The general per-IP limit first, then the sign-in one: every start writes a row and may call the IdP.
          async beforeSignIn(c) {
            const ip = clientIp(c);
            const now = services.clock.now();
            const general = await options.limits?.beforeAuth?.(ip, now);
            if (general !== undefined && !general.ok) return tooManySignIns(general.retryAfterSeconds);
            const signIn = await options.limits?.beforeSignIn?.(ip, now);
            if (signIn !== undefined && !signIn.ok) return tooManySignIns(signIn.retryAfterSeconds);
            return undefined;
          },
        },
      ),
    );
  }

  // The admin panel at /admin (P4-03): on whenever sign-in is (it needs a session). Built on its first request, never by an
  // MCP request, and shared by every later one (it holds no request data, L-013).
  if (options.identity !== undefined && sessions !== undefined) {
    const identity = options.identity;
    const gate = sessions;
    let panel: Hono | undefined;
    const buildPanel = (mod: AdminUiModule): Hono => {
      const publicOrigin = new URL(identity.publicUrl).origin;
      const root = new Hono({ router: new LinearRouter() });
      root.use(async (ic, next) => {
        ic.set('requestId' as never, (ic.req.header(INTERNAL_REQUEST_ID) ?? '') as never);
        await next();
      });
      root.route(
        ADMIN_UI_BASE,
        mod.createAdminUi(
          adminUiDeps({
            sessions: gate,
            kv: options.storage.kv,
            publicOrigin,
            now: () => services.clock.now(),
            ...(identity.auditAdmin === undefined ? {} : { audit: identity.auditAdmin }),
            runInBackground: keepAlive,
            async beforeAuth(ic) {
              const decision = await options.limits?.beforeAuth?.(clientIp(ic), services.clock.now());
              if (decision === undefined || decision.ok) return undefined;
              const res = mod.errorPage(
                429,
                (ic.get('requestId' as never) as string | undefined) || undefined,
              );
              res.headers.set('retry-after', String(Math.max(1, Math.ceil(decision.retryAfterSeconds))));
              return res;
            },
            onError: (_ic, error) =>
              services.logger.error('admin panel error', {
                error: error instanceof Error ? error.name : typeof error,
              }),
            ...(adminInProcess === undefined ? {} : { callApi: adminInProcess }),
          }),
        ),
      );
      return root;
    };
    const servePanel = async (c: Context): Promise<Response> => {
      const mod = await loadUi();
      panel ??= buildPanel(mod);
      return dispatch(panel, forwardRequest(c), c);
    };
    app.all(ADMIN_UI_BASE, servePanel);
    app.all(`${ADMIN_UI_BASE}/*`, servePanel);
  }

  // OAuth 2.1 authorization server (P5-01): unauthenticated routes, limited per IP before any work, bodies capped by
  // the runtime. All state is in storage (L-086); the runtime holds configuration only (L-013, L-096). The runtime and
  // the consent screen are built above (the admin API's connected-apps routes need them).
  if (oauth !== undefined) {
    const runtime = oauth;
    const limited = async (c: Context, run: () => Promise<Response>): Promise<Response> => {
      const now = services.clock.now();
      const decision = await options.limits?.beforeAuth?.(clientIp(c), now);
      if (decision !== undefined && !decision.ok) {
        return c.json(
          { error: 'temporarily_unavailable', error_description: 'Too many requests; retry later.' },
          429,
          { 'retry-after': String(Math.max(1, Math.ceil(decision.retryAfterSeconds))) },
        );
      }
      return run();
    };
    app.get(OAUTH_METADATA_PATH, (c) => limited(c, () => runtime.metadata(c)));
    // RFC 9728: one document per workspace resource, from the path alone (T19). Anything else under the prefix,
    // the root included, is a 404 like an app without OAuth.
    app.get(`${OAUTH_RESOURCE_METADATA_PREFIX}/w/:slug/mcp`, (c) =>
      limited(c, async () => runtime.resourceMetadata(c.req.param('slug')) ?? c.notFound()),
    );
    app.get(OAUTH_AUTHORIZE_PATH, (c) => limited(c, () => runtime.authorize(c)));
    app.post(OAUTH_TOKEN_PATH, (c) => limited(c, () => runtime.token(c, () => cache.clear())));
    app.post(OAUTH_REGISTER_PATH, (c) => limited(c, () => runtime.register(c)));
    const screen = consentScreen;
    // The built-in consent screen's form post (P5-04); a stand-in handler has no such route.
    if (screen !== undefined)
      app.post(OAUTH_CONSENT_PATH, (c) => limited(c, () => screen.decide(c, runtime)));
  }

  // Liveness and version only (L-151).
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.get('/version', (c) => c.json({ version: options.version }));

  app.all('/w/:slug/mcp', async (c) => {
    const started = services.clock.now();
    const requestId = c.get('requestId' as never) as string;
    const slug = c.req.param('slug');
    const ip = clientIp(c);
    let mcp: ClassifiedRequest | null = null;
    let access: EffectiveAccess | null = null;
    const finish = (res: Response, refusal: RefusalReason | null): Response => {
      observe(c, 'request', {
        requestId,
        ip,
        slug: slug.slice(0, 63),
        status: res.status,
        durationMs: services.clock.now() - started,
        mcp,
        access,
        refusal,
      });
      return res;
    };
    const tooMany = (retryAfterSeconds: number) =>
      finish(
        new Response(JSON.stringify({ error: 'rate limited' }), {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'retry-after': String(Math.max(1, Math.ceil(retryAfterSeconds))),
          },
        }),
        'rate_limited',
      );
    const unauthorized = async (reason: string) => {
      const now = services.clock.now();
      if ((await options.limits?.failuresExhausted?.(ip, now)) === true) {
        return tooMany(300);
      }
      await options.limits?.onAuthFailure?.(ip, now);
      return finish(
        new Response(UNAUTHORIZED, {
          status: 401,
          headers: {
            'content-type': 'application/json',
            // With OAuth on, every denial names the workspace's resource metadata (P5-02): a function of the path only.
            'www-authenticate': oauth === undefined ? 'Bearer' : oauth.challenge(slug),
          },
        }),
        reason,
      );
    };

    const ipLimit = await options.limits?.beforeAuth?.(ip, started);
    if (ipLimit !== undefined && !ipLimit.ok) return tooMany(ipLimit.retryAfterSeconds);

    // Authenticate: the same 401 for an unknown workspace, a bad token or any denial (T19).
    const presented = bearerToken(c.req.header('authorization'));
    const agilityToken = c.req.header('x-agility-token');
    /** The caller's own Agility token on a pass-through workspace (P2-14); never stored, never logged. */
    let passthroughToken: string | null = null;
    if (presented === null && agilityToken !== undefined) {
      const pt = options.passthrough;
      if (pt === undefined) return unauthorized('passthrough_disabled');
      if (!pt.secure(c)) return unauthorized('passthrough_insecure');
      if (agilityToken.length === 0 || agilityToken.length > 4_000 || /[\s\p{Cc}]/u.test(agilityToken)) {
        return unauthorized('token_malformed');
      }
      try {
        const workspace = await options.storage.workspaces.getBySlug(slug);
        const instance =
          workspace === null ? null : await options.storage.instances.get(workspace.instanceId);
        const fingerprint =
          instance === null
            ? ''
            : await options.keyring.mac(KeyPurpose.AuditIdentity, `${instance.id}|${agilityToken}`);
        const decision = resolvePassthroughAccess(slug, { workspace, instance }, fingerprint, options.access);
        if (!decision.ok || instance === null)
          return unauthorized(decision.ok ? 'instance_missing' : decision.reason);
        // The token must work on this workspace's instance: validated once, then trusted for a short while by
        // fingerprint (the identity cache holds no token).
        const key = `${fingerprint}|${instance.id}`;
        if ((identities.get(key) ?? 0) <= started) {
          // An IP out of failed attempts gets no further upstream checks (P2-17 review F2).
          if ((await options.limits?.failuresExhausted?.(ip, started)) === true) return tooMany(300);
          let pending = validating.get(key);
          if (pending === undefined) {
            const cap = await options.limits?.beforeValidation?.(instance.id, started);
            if (cap !== undefined && !cap.ok) return tooMany(cap.retryAfterSeconds);
            const credentialId = decision.access.credential.id;
            pending = pt.validator
              .validate(instance, credentialId, agilityToken)
              .finally(() => validating.delete(key));
            // Workers: never shared with another request (L-096); the map stays empty.
            if (!perRequest) validating.set(key, pending);
          }
          const result = await pending;
          if (result.status === 'unavailable') {
            return finish(
              c.json({ error: 'temporarily unavailable' }, 503, { 'retry-after': '5' }),
              'unavailable',
            );
          }
          if (result.status !== 'valid') return unauthorized('passthrough_invalid');
          remember(key, started + (pt.identityTtlSeconds ?? 300) * 1000, started);
        }
        access = decision.access;
        passthroughToken = agilityToken;
      } catch (error) {
        services.logger.error('access resolution failed', { requestId, error: (error as Error).name });
        return finish(
          c.json({ error: 'temporarily unavailable' }, 503, { 'retry-after': '5' }),
          'unavailable',
        );
      }
    } else if (presented === null) {
      return unauthorized('no_token');
    } else if (isWellFormedDeviceToken(presented, options.access.environment)) {
      try {
        const hash = await hashDeviceToken(presented);
        access = cache.get(hash, slug, started) ?? null;
        if (access === null) {
          const decision = await authenticateDeviceToken(
            options.storage,
            presented,
            slug,
            options.access,
            started,
          );
          if (!decision.ok) return unauthorized(decision.reason);
          access = decision.access;
          cache.set(hash, slug, access, started);
        }
      } catch (error) {
        services.logger.error('access resolution failed', { requestId, error: (error as Error).name });
        return finish(
          c.json({ error: 'temporarily unavailable' }, 503, { 'retry-after': '5' }),
          'unavailable',
        );
      }
    } else if (oauth !== undefined && looksLikeOAuthToken(presented)) {
      // An OAuth access token (P5-01): valid for this workspace's resource only, its grant resolved like a device
      // token's (same cache keyed by the token's hash and the slug, same single 401 for every denial).
      try {
        const hash = await hashDeviceToken(presented);
        access = cache.get(hash, slug, started) ?? null;
        if (access === null) {
          const outcome = await oauth.authenticate(presented, slug);
          if (!outcome.ok) return unauthorized(outcome.reason);
          access = outcome.access;
          cache.set(hash, slug, access, started);
        }
      } catch (error) {
        services.logger.error('access resolution failed', { requestId, error: (error as Error).name });
        return finish(
          c.json({ error: 'temporarily unavailable' }, 503, { 'retry-after': '5' }),
          'unavailable',
        );
      }
    } else {
      return unauthorized('token_malformed');
    }

    if (c.req.method !== 'POST') {
      // Stateless HTTP: no GET stream, no session to DELETE (ADR-0005).
      return finish(c.json({ error: 'method not allowed' }, 405, { allow: 'POST' }), 'method');
    }
    const body = await readMcpBody(c.req.raw, maxBody);
    if (!body.ok) {
      return finish(
        new Response(jsonRpcError(body.code, body.message), {
          status: body.status,
          headers: { 'content-type': 'application/json' },
        }),
        'body',
      );
    }
    mcp = classifyMcpMessage(body.message);
    const limit = await options.limits?.afterAuth?.(access, mcp, started);
    if (limit !== undefined && !limit.ok) return tooMany(limit.retryAfterSeconds);

    let token: string;
    try {
      const sealed = access.credential.sealed;
      token =
        sealed === null
          ? (passthroughToken as string)
          : await openCredentialToken(options.keyring, { id: access.credential.id, ...sealed });
    } catch (error) {
      services.logger.error('credential could not be decrypted', { requestId, error: (error as Error).name });
      return finish(c.json({ error: 'temporarily unavailable' }, 503, { 'retry-after': '5' }), 'unavailable');
    }
    const resolved = access;
    const tools = registry.select({ allowed: [...resolved.tools], maxCost: resolved.limits.callBudget });
    const groups = [...new Set(tools.map((t) => t.group))];
    const ctx: ToolContext = {
      requestId,
      instance: { id: resolved.instance.id, baseUrl: resolved.instance.baseUrl },
      workspace: {
        id: resolved.workspace.id,
        name: resolved.workspace.name,
        groups,
        writes: { enabled: resolved.writeTools.length > 0, approval: 'unavailable' },
      },
      credential: { id: resolved.credential.id, kind: resolved.credential.kind, token: new Secret(token) },
      projects: {
        allowed: [...resolved.projects.allowed],
        includeChildren: resolved.projects.includeChildren,
      },
      assetTypes: {
        ...(resolved.assetTypes.allow === undefined ? {} : { allow: [...resolved.assetTypes.allow] }),
        deny: [...resolved.assetTypes.deny],
      },
      limits: resolved.limits,
      budget: createBudget(resolved.limits.callBudget),
      // Workers: a limiter per request, never one another request releases (L-096).
      limiter: (perRequest ? new CredentialLimiters() : services.limiters).for(
        resolved.instance.id,
        resolved.credential.id,
      ),
      breaker: services.breakers.for(resolved.instance.id, resolved.credential.id),
      fetch: services.fetchFor(resolved.instance),
      metadata: services.metadata,
      logger: services.logger,
      clock: services.clock,
      random: services.random,
    };
    const prepared: PreparedRequest = {
      tools,
      ctx,
      onToolCall: (event) => observe(c, 'toolCall', { ...event, requestId, access: resolved }),
    };

    const forward = new Request(c.req.url, { method: 'POST', headers: c.req.raw.headers, body: body.bytes });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<Response>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve(
          new Response(jsonRpcError(-32603, 'The request took too long.'), {
            status: 504,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }, deadlineMs);
    });
    const response = await Promise.race([
      handler.fetch(forward, {
        authInfo: {
          token: 'device',
          clientId: resolved.tokenId ?? 'device',
          scopes: [],
          extra: { prepared },
        },
      }),
      deadline,
    ]);
    clearTimeout(timer);
    if (timedOut) return finish(response, 'deadline');
    const remaining = Math.max(1, deadlineMs - (services.clock.now() - started));
    return finish(
      withDeadline(response, remaining, () =>
        services.logger.warn('response stream hit the deadline', { requestId }),
      ),
      null,
    );
  });

  return {
    app,
    fetch: (request, env, executionCtx) =>
      executionCtx === undefined ? app.fetch(request, env) : app.fetch(request, env, executionCtx as never),
    clearAccessCache: () => cache.clear(),
    ...(oauth === undefined ? {} : { oauthRegistrations: oauth.registrations }),
  };
}
