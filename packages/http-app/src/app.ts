// SPDX-License-Identifier: Apache-2.0
// The HTTP app (ARCHITECTURE §5, ADR-0005): `/w/{slug}/mcp` per workspace, stateless, one MCP server per request with
// only the caller's tools. Web-standard only, so the same app runs on Node (`agility-bridge serve`) and Workers.
import {
  type AccessSettings,
  authenticateDeviceToken,
  bearerToken,
  type EffectiveAccess,
  hashDeviceToken,
  isWellFormedDeviceToken,
  type Keyring,
  openCredentialToken,
  type TokenEnvironment,
} from '@agility-bridge/auth';
import {
  buildMcpServer,
  type CircuitBreakers,
  type Clock,
  type CredentialLimiters,
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
export interface HttpObserver {
  request?(event: RequestEvent): void;
  toolCall?(event: ToolCallRecord): void;
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
}

export interface HttpApp {
  readonly app: Hono;
  readonly fetch: (request: Request, env?: unknown) => Response | Promise<Response>;
  /** Forget cached access decisions (call after local admin changes). */
  clearAccessCache(): void;
}

interface PreparedRequest {
  readonly tools: readonly ToolDefinition[];
  readonly ctx: ToolContext;
  readonly onToolCall: (event: ToolCallEvent) => void;
}

const UNAUTHORIZED = JSON.stringify({ error: 'unauthorized' });

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
  const { services } = options;
  const registry = new ToolRegistry();
  for (const tool of options.tools) registry.register(tool);
  const clientIp = options.clientIp ?? (() => 'unknown');

  const observe = <K extends keyof HttpObserver>(
    kind: K,
    event: Parameters<NonNullable<HttpObserver[K]>>[0],
  ) => {
    try {
      (options.observer?.[kind] as ((e: typeof event) => void) | undefined)?.(event);
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
      observe('request', {
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
      return finish(c.json({ error: 'temporarily unavailable' }, 503, { 'retry-after': '5' }), 'unavailable');
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
      token = await openCredentialToken(options.keyring, {
        id: access.credential.id,
        ...access.credential.sealed,
      });
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
      limiter: services.limiters.for(resolved.instance.id, resolved.credential.id),
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
      onToolCall: (event) => observe('toolCall', { ...event, requestId, access: resolved }),
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
    fetch: (request, env) => app.fetch(request, env),
    clearAccessCache: () => cache.clear(),
  };
}
