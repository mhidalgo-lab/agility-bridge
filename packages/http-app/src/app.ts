// SPDX-License-Identifier: Apache-2.0
// The HTTP app (ARCHITECTURE §5, ADR-0005): `/w/{slug}/mcp` per workspace, stateless, one MCP server per request with
// only the caller's tools. Web-standard only, so the same app runs on Node (`agility-bridge serve`) and Workers.
import {
  type AccessSettings,
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
import { AccessCache } from './access-cache.ts';
import { ADMIN_BASE, type AdminApiOptions, createAdminApi } from './admin/api.ts';
import { createEdge, type EdgeOptions } from './edge.ts';
import { type ClassifiedRequest, classifyMcpMessage, jsonRpcError, readMcpBody } from './mcp-request.ts';

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
  /** The admin API at `/api/admin/v1` (P2-09); absent = the whole API answers 404. */
  readonly admin?: Pick<AdminApiOptions, 'services' | 'audit' | 'authenticate'>;
  /**
   * `process` (Node, default): one process serves every request. `request` (Workers, L-096): nothing in flight is shared
   * between requests: a concurrency limiter per request and no shared pass-through validation. Pair it with a
   * detached `AuditWriter`, `MetadataService({ shareInflight: false })` and `background`.
   */
  readonly isolation?: 'process' | 'request';
  /** Keeps work started for a request alive after the response (Workers: `c.executionCtx.waitUntil`). */
  readonly background?: (c: Context, work: Promise<unknown>) => void;
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
}

interface PreparedRequest {
  readonly tools: readonly ToolDefinition[];
  readonly ctx: ToolContext;
  readonly onToolCall: (event: ToolCallEvent) => void;
}

const UNAUTHORIZED = JSON.stringify({ error: 'unauthorized' });
/** Pass-through identities kept at most (P2-14). */
const MAX_IDENTITIES = 10_000;

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
  const registry = new ToolRegistry();
  for (const tool of options.tools) registry.register(tool);
  const clientIp = options.clientIp ?? (() => 'unknown');

  const keepAlive = (c: Context, work: Promise<unknown>) => {
    const settled = work.catch((error: unknown) => {
      services.logger.warn('background work failed', { error: (error as Error).name });
    });
    options.background?.(c, settled);
  };
  const perRequest = options.isolation === 'request';
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

  const app = new Hono();

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
    for (const [k, v] of Object.entries(edge.securityHeaders)) res.headers.set(k, v);
    for (const [k, v] of Object.entries(edge.corsHeaders(origin))) res.headers.set(k, v);
    res.headers.set('x-request-id', requestId);
    if (refusal !== undefined) c.res = refusal;
  });

  app.onError((error, c) => {
    services.logger.error('unhandled error', { error: error.name });
    return c.json({ error: 'internal error' }, 500);
  });
  app.notFound((c) => c.json({ error: 'not found' }, 404));

  if (options.admin !== undefined) {
    app.route(
      ADMIN_BASE,
      createAdminApi({
        ...options.admin,
        storage: options.storage,
        tools: options.access.tools,
        onChange: () => cache.clear(),
        ...(options.limits === undefined ? {} : { limits: options.limits }),
        clientIp,
        logger: services.logger,
        clock: services.clock,
        background: keepAlive,
        keyring: options.keyring,
      }),
    );
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
          headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer' },
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
    } else {
      if (presented === null || !isWellFormedDeviceToken(presented, options.access.environment)) {
        return unauthorized(presented === null ? 'no_token' : 'token_malformed');
      }
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
  };
}
