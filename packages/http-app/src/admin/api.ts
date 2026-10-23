// SPDX-License-Identifier: Apache-2.0
// The admin REST API `/api/admin/v1/*` (P2-09): everything an operator manages, validated (OpenAPI + zod), guarded per
// actor (`guardedServices`, L-065), audited, and never returning a secret (tokens are shown once, credentials only as a
// hint). Without an admin authenticator the whole API is 404.
import {
  type AccessServices,
  type Actor,
  type AdminTokenVerifier,
  bearerToken,
  DEFAULT_SETUP_LINK_TTL_MS,
  guardedServices,
  type Keyring,
  MAX_SETUP_LINK_TTL_MS,
  MIN_SETUP_LINK_TTL_MS,
  setupCodeHash,
  type ToolInfo,
} from '@agility-bridge/auth';
import type { Clock, Logger } from '@agility-bridge/core';
import type { AccessToken, AuditKind, AuditStatus, Credential, Storage } from '@agility-bridge/storage';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { LinearRouter } from 'hono/router/linear-router';
import type { RequestLimits } from '../app.ts';
import type { AuditWriter } from '../audit.ts';
import { CSRF_HEADER, isUnsafeMethod, type SessionManager } from '../session.ts';
import { AdminError, errorBody, toAdminError } from './errors.ts';

export const ADMIN_BASE = '/api/admin/v1';
const MAX_ADMIN_BODY_BYTES = 64 * 1024;

export interface AdminApiOptions {
  readonly services: AccessServices;
  readonly storage: Storage;
  readonly tools: ReadonlyMap<string, ToolInfo>;
  readonly audit: AuditWriter;
  /** Called after every successful change (clears the access cache, L-068). */
  readonly onChange: () => void;
  /**
   * Who is calling: the break-glass token, or an admin session (`adminAuthenticator`). `null` = not authenticated;
   * a refusal (cross-site, CSRF) is a 403 and writes an audit row.
   */
  readonly authenticate: (c: Context) => Promise<AdminAuthResult>;
  /** Ends every session of a user (role change, disable, `POST /users/{id}/sessions/revoke`); absent = no sessions. */
  readonly revokeUserSessions?: (userId: string) => Promise<number>;
  readonly limits?: RequestLimits;
  readonly clientIp: (c: Context) => string;
  readonly logger: Logger;
  readonly clock: Clock;
  /** Recorded in admin audit rows: `api` (default) or `cli` for the in-process local client (P2-10). */
  readonly via?: string;
  /** Keeps an audit write alive after the response (Workers: `waitUntil`, L-096). */
  readonly background?: (c: Context, work: Promise<unknown>) => void;
  /** For `/keys` (P3-13): master-key versions and their retirement; without it those routes answer 403. */
  readonly keyring?: Keyring;
  /** A router without a compile step on the first match (Workers, P3-14). */
  readonly lightweightRouter?: boolean;
  /** Sign-in is configured (P4-01): owner setup links point at this origin. Absent = `POST /setup-links` is refused. */
  readonly setupLinks?: { readonly publicUrl: string };
}

/** A request the admin API refuses before any handler (the reason is audited, never the token). */
export interface AdminRefusal {
  readonly kind: 'refused';
  /** `cross_site`, `origin_mismatch`, `origin_missing`, `csrf`. */
  readonly reason: string;
  readonly userId?: string;
}

export type AdminAuthResult = Actor | AdminRefusal | null;

/** The session the request was authenticated with (set by `adminAuthenticator`), for `GET /session`. */
export type AdminSessionView = {
  readonly user: { id: string; email: string; displayName: string | null; role: string };
  readonly recentAuth: boolean;
  readonly signedInAt: number;
  readonly idleExpiresAt: number;
  readonly expiresAt: number;
  readonly csrfToken: string;
};

/**
 * Break-glass token first, then the session cookie (P4-02). A request with an `Authorization` header is only ever
 * judged as a token: a wrong token never falls back to a cookie. A cookie request passes the fetch-metadata and
 * `Origin` checks, and on an unsafe method the CSRF token, before it is anyone.
 */
export function adminAuthenticator(parts: {
  readonly token?: (c: Context) => Promise<Actor | null>;
  readonly sessions?: SessionManager;
}): (c: Context) => Promise<AdminAuthResult> {
  return async (c) => {
    if (c.req.header('authorization') !== undefined) return (await parts.token?.(c)) ?? null;
    const sessions = parts.sessions;
    // No session cookie (or no sessions): only the token authenticator is left, and it answers null without a token.
    if (sessions === undefined || sessions.readCookie(c) === undefined)
      return (await parts.token?.(c)) ?? null;
    if (sessions.readCookie(c) === null) return null; // a cookie named twice is no cookie
    const unsafe = isUnsafeMethod(c.req.method);
    const problem = sessions.checkFetchOrigin(c, unsafe);
    if (problem !== null) return { kind: 'refused', reason: problem };
    const auth = await sessions.authenticate(c);
    if (!auth.ok) return null;
    const { principal } = auth;
    if (unsafe && !sessions.csrfMatches(principal, c.req.header(CSRF_HEADER))) {
      return { kind: 'refused', reason: 'csrf', userId: principal.user.id };
    }
    const view: AdminSessionView = {
      user: {
        id: principal.user.id,
        email: principal.user.email,
        displayName: principal.user.displayName,
        role: principal.role,
      },
      recentAuth: principal.recentAuth,
      signedInAt: principal.session.record.createdAt,
      idleExpiresAt: principal.session.idleExpiresAt,
      expiresAt: principal.session.record.expiresAt,
      csrfToken: principal.session.record.csrf,
    };
    c.set('sessionView' as never, view as never);
    return {
      kind: 'user',
      userId: principal.user.id,
      role: principal.role,
      recentAuth: principal.recentAuth,
    };
  };
}

/** The break-glass authenticator: `Authorization: Bearer ab_admin_…` matching `AB_ADMIN_TOKEN`. */
export function adminTokenAuthenticator(verifier: AdminTokenVerifier): (c: Context) => Promise<Actor | null> {
  return async (c) =>
    (await verifier.verify(bearerToken(c.req.header('authorization')))) ? { kind: 'break_glass' } : null;
}

// ---- Schemas (documented in the OpenAPI document) ----

const Id = z.string().min(1).max(128);
const IdParam = z.object({ id: Id.openapi({ param: { name: 'id', in: 'path' } }) });
const Json = z.record(z.string(), z.unknown());
const Strings = z.array(z.string().max(256)).max(1_000);
const Ok = z.object({ ok: z.literal(true) });

const UserOut = z
  .object({
    id: z.string(),
    email: z.string(),
    displayName: z.string().nullable(),
    idp: z.string().nullable(),
    idpSubject: z.string().nullable(),
    role: z.enum(['owner', 'admin', 'member']),
    createdAt: z.number(),
    updatedAt: z.number(),
    disabledAt: z.number().nullable(),
  })
  .openapi('User');
const InstanceOut = z
  .object({
    id: z.string(),
    label: z.string(),
    baseUrl: z.string(),
    tls: Json.nullable(),
    numberPrefixes: Json.nullable(),
    metaFingerprint: z.string().nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
    disabledAt: z.number().nullable(),
  })
  .openapi('Instance');
const CredentialOut = z
  .object({
    id: z.string(),
    instanceId: z.string(),
    ownerUserId: z.string().nullable(),
    label: z.string(),
    tokenHint: z.string(),
    keyVersion: z.number(),
    validationStatus: z.enum(['unvalidated', 'valid', 'invalid']),
    validationErrorCode: z.string().nullable(),
    validatedAt: z.number().nullable(),
    memberOid: z.string().nullable(),
    memberName: z.string().nullable(),
    memberUsername: z.string().nullable(),
    reachableScopeIds: Strings.nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
    revokedAt: z.number().nullable(),
  })
  .openapi('Credential');
const WorkspaceOut = z
  .object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    instanceId: z.string(),
    allowedScopeIds: Strings,
    includeChildScopes: z.boolean(),
    assetTypes: Json.nullable(),
    enabledTools: Strings.nullable(),
    limits: Json,
    defaultCredentialId: z.string().nullable(),
    writePolicy: Json,
    credentialSource: z.enum(['stored', 'passthrough']),
    createdAt: z.number(),
    updatedAt: z.number(),
    disabledAt: z.number().nullable(),
  })
  .openapi('Workspace');
const GrantOut = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    userId: z.string().nullable(),
    label: z.string().nullable(),
    credentialId: z.string().nullable(),
    tools: Strings.nullable(),
    scopeIds: Strings.nullable(),
    assetTypes: Json.nullable(),
    limits: Json,
    rateLimit: Json.nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
    expiresAt: z.number().nullable(),
    revokedAt: z.number().nullable(),
  })
  .openapi('Grant');
const TokenOut = z
  .object({
    id: z.string(),
    grantId: z.string(),
    prefix: z.string(),
    label: z.string(),
    createdAt: z.number(),
    expiresAt: z.number().nullable(),
    lastUsedAt: z.number().nullable(),
    revokedAt: z.number().nullable(),
  })
  .openapi('DeviceToken');
const AuditOut = z.object({}).passthrough().openapi('AuditEntry');
const Warnings = z.array(z.string());
const ErrorOut = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      field: z.string().optional(),
      detail: z.string().optional(),
    }),
  })
  .openapi('Error');

const NewUser = z.strictObject({
  email: z.string().min(3).max(320),
  role: z.enum(['owner', 'admin', 'member']),
  displayName: z.string().min(1).max(200).nullable().optional(),
});
const UserPatch = z.strictObject({
  email: z.string().min(3).max(320).optional(),
  role: z.enum(['owner', 'admin', 'member']).optional(),
  displayName: z.string().min(1).max(200).nullable().optional(),
});
const NewInstance = z.strictObject({
  label: z.string().min(1).max(200),
  baseUrl: z.string().min(1).max(2_048),
  tls: Json.nullable().optional(),
  numberPrefixes: Json.nullable().optional(),
});
const InstancePatch = z.strictObject({
  label: z.string().min(1).max(200).optional(),
  numberPrefixes: Json.nullable().optional(),
  disabledAt: z.number().int().nullable().optional(),
});
const Retarget = z.strictObject({ baseUrl: z.string().min(1).max(2_048), tls: Json.nullable().optional() });
const NewCredential = z.strictObject({
  instanceId: Id,
  ownerUserId: Id.nullable(),
  label: z.string().min(1).max(200),
  /** The Agility access token: accepted here once, never returned. */
  token: z.string().min(1).max(4_000),
});
const TokenReplacement = z.strictObject({ token: z.string().min(1).max(4_000) });
const LabelPatch = z.strictObject({ label: z.string().min(1).max(200) });
const NewWorkspace = z.strictObject({
  slug: z.string().min(1).max(63),
  name: z.string().min(1).max(200),
  instanceId: Id,
  allowedScopeIds: Strings,
  includeChildScopes: z.boolean().optional(),
  assetTypes: Json.nullable().optional(),
  enabledTools: Strings.nullable().optional(),
  limits: Json.optional(),
  defaultCredentialId: Id.nullable().optional(),
  writePolicy: Json.optional(),
  credentialSource: z.enum(['stored', 'passthrough']).optional(),
});
const WorkspacePatch = NewWorkspace.omit({ instanceId: true })
  .partial()
  .extend({ disabledAt: z.number().int().nullable().optional() });
const NewGrant = z.strictObject({
  workspaceId: Id,
  userId: Id.nullable(),
  label: z.string().min(1).max(200).nullable().optional(),
  credentialId: Id.nullable().optional(),
  tools: Strings.nullable().optional(),
  scopeIds: Strings.nullable().optional(),
  assetTypes: Json.nullable().optional(),
  limits: Json.optional(),
  rateLimit: Json.nullable().optional(),
  expiresAt: z.number().int().nullable().optional(),
});
const GrantPatch = NewGrant.omit({ workspaceId: true, userId: true }).partial();
const NewToken = z.strictObject({
  label: z.string().min(1).max(200),
  expiresInDays: z.union([z.number().int().min(1).max(3_650), z.literal('never')]).optional(),
});
const AuditQuery = z.object({
  workspaceId: z.string().max(128).optional(),
  userId: z.string().max(128).optional(),
  kind: z.enum(['tool_call', 'write', 'auth', 'admin']).optional(),
  status: z.enum(['ok', 'error', 'denied']).optional(),
  /** Exact tool or action name. */
  action: z
    .string()
    .regex(/^[A-Za-z0-9_.:-]{1,100}$/i, 'letters, digits and _ . : - only')
    .optional(),
  from: z.coerce.number().int().min(0).optional(),
  to: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(1_000).optional(),
  afterTs: z.coerce.number().int().min(0).optional(),
  afterId: z.string().max(128).optional(),
});
const AuditStatsQuery = z.object({
  groupBy: z.enum(['tool', 'workspace', 'grant', 'user', 'day']),
  workspaceId: z.string().max(128).optional(),
  from: z.coerce.number().int().min(0).optional(),
  to: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const AuditStatsOut = z
  .object({
    data: z.array(
      z.object({
        key: z.string().nullable(),
        calls: z.number(),
        errors: z.number(),
        denied: z.number(),
        agilityRequests: z.number(),
        durationSumMs: z.number(),
        durationCount: z.number(),
        maxDurationMs: z.number().nullable(),
      }),
    ),
    scanned: z.number(),
    truncated: z.boolean(),
  })
  .openapi('AuditStats');

// ---- Output shaping: never a secret ----

function credentialOut(c: Credential) {
  const { tokenCiphertext: _c, tokenIv: _i, ...rest } = c;
  return rest;
}
function tokenOut(t: AccessToken) {
  const { tokenHash: _h, ...rest } = t;
  return rest;
}

type Method = 'get' | 'post' | 'patch' | 'delete';

interface RouteSpec {
  method: Method;
  path: string;
  tag: string;
  summary: string;
  params?: boolean;
  query?: z.ZodType;
  body?: z.ZodType;
  /** Response body schema for 200/201. */
  out: z.ZodType;
  status?: 200 | 201;
  /** For the audit row; undefined = a read (not audited). */
  audit?: { action: string; targetType: string };
  /** Body values recorded with the audit row (operator reasons only; never secrets or names, P3-11 review). */
  auditBody?: readonly string[];
}

const ERROR_RESPONSES = Object.fromEntries(
  [400, 401, 403, 404, 409, 413, 415, 422, 429, 502, 503].map((s) => [
    s,
    { content: { 'application/json': { schema: ErrorOut } }, description: 'Error' },
  ]),
);

export function createAdminApi(options: AdminApiOptions): OpenAPIHono {
  const keep = (c: Context, work: Promise<unknown> | undefined) => {
    if (work !== undefined) options.background?.(c, work);
  };
  const api = new OpenAPIHono({
    ...(options.lightweightRouter === true ? { router: new LinearRouter() } : {}),
    defaultHook: (result, c) => {
      if (!result.success) {
        const issue = result.error.issues[0];
        const field = issue?.path.map(String).join('.') || undefined;
        return c.json(
          errorBody('invalid_input', `${field ?? 'request'}: ${issue?.message ?? 'invalid'}.`, field),
          422,
        );
      }
      return undefined;
    },
  });

  // Authentication, failure limits, body checks — before any route.
  api.use('*', async (c, next) => {
    const ip = options.clientIp(c);
    const now = options.clock.now();
    const before = await options.limits?.beforeAuth?.(ip, now);
    if (before !== undefined && !before.ok) {
      return c.json(errorBody('rate_limited', 'Too many requests.'), 429, {
        'retry-after': String(Math.ceil(before.retryAfterSeconds)),
      });
    }
    const result = await options.authenticate(c);
    if (result !== null && result.kind === 'refused') {
      keep(
        c,
        options.audit.admin({
          action: 'admin.forbidden',
          status: 'denied',
          userId: result.userId ?? null,
          targetType: 'session',
          targetId: '-',
          errorCode: 'forbidden',
          requestId: (c.get('requestId' as never) as string | undefined) ?? null,
          via: options.via ?? 'api',
          details: {
            reason: result.reason,
            route: `${c.req.method} ${new URL(c.req.url).pathname}`.slice(0, 200),
          },
        }),
      );
      return c.json(
        errorBody('forbidden', 'This request did not come from this site, or its CSRF token is missing.'),
        403,
      );
    }
    const actor = result;
    if (actor === null) {
      if ((await options.limits?.failuresExhausted?.(ip, now)) === true) {
        return c.json(errorBody('rate_limited', 'Too many failed attempts.'), 429, { 'retry-after': '300' });
      }
      await options.limits?.onAuthFailure?.(ip, now);
      keep(
        c,
        options.audit.request({
          requestId: c.get('requestId' as never) ?? '',
          ip,
          slug: '(admin)',
          status: 401,
          durationMs: 0,
          mcp: null,
          access: null,
          refusal: 'admin_unauthenticated',
        }),
      );
      return c.json(errorBody('unauthorized', 'Authentication required.'), 401, {
        'www-authenticate': 'Bearer',
      });
    }
    c.set('actor' as never, actor as never);
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(c.req.method)) {
      const length = Number(c.req.header('content-length'));
      if (Number.isFinite(length) && length > MAX_ADMIN_BODY_BYTES) {
        return c.json(
          errorBody('payload_too_large', `The body is larger than ${MAX_ADMIN_BODY_BYTES} bytes.`),
          413,
        );
      }
      const text = await c.req.raw.clone().text();
      if (new TextEncoder().encode(text).length > MAX_ADMIN_BODY_BYTES) {
        return c.json(
          errorBody('payload_too_large', `The body is larger than ${MAX_ADMIN_BODY_BYTES} bytes.`),
          413,
        );
      }
      // Actions such as `/revoke` take no body; a body, when present, is JSON.
      if (text !== '') {
        if (!/^application\/json\s*(?:;|$)/i.test(c.req.header('content-type') ?? '')) {
          return c.json(errorBody('unsupported_media_type', 'Send JSON (application/json).'), 415);
        }
        try {
          JSON.parse(text);
        } catch {
          return c.json(errorBody('bad_request', 'The body is not valid JSON.'), 400);
        }
      }
    }
    await next();
    return undefined;
  });

  const services = (c: Context) =>
    guardedServices(
      options.services,
      {
        storage: options.storage,
        tools: options.tools,
        ...(options.keyring === undefined ? {} : { keyring: options.keyring }),
      },
      c.get('actor' as never) as Actor,
    );

  function auditRow(
    c: Context,
    spec: RouteSpec,
    status: AuditStatus,
    targetId: string,
    extra: Record<string, unknown> = {},
  ) {
    if (spec.audit === undefined) return;
    const actor = c.get('actor' as never) as Actor;
    keep(
      c,
      options.audit.admin({
        action: spec.audit.action,
        status,
        userId: actor.kind === 'user' ? actor.userId : null,
        targetType: spec.audit.targetType,
        targetId: targetId.slice(0, 128),
        requestId: (c.get('requestId' as never) as string | undefined) ?? null,
        via: options.via ?? 'api',
        details: {
          actor: actor.kind === 'user' ? actor.role : 'break_glass',
          ...(extra as Record<string, never>),
        },
      }),
    );
  }

  function add(
    spec: RouteSpec,
    handler: (
      c: Context,
      input: { id: string; body: Record<string, unknown>; query: Record<string, unknown> },
    ) => Promise<unknown>,
  ): void {
    const route = createRoute({
      method: spec.method,
      path: spec.path,
      tags: [spec.tag],
      summary: spec.summary,
      security: [{ bearer: [] }, { sessionCookie: [] }],
      request: {
        ...(spec.params ? { params: IdParam } : {}),
        ...(spec.query === undefined ? {} : { query: spec.query as never }),
        ...(spec.body === undefined
          ? {}
          : { body: { content: { 'application/json': { schema: spec.body as never } }, required: true } }),
      },
      responses: {
        [spec.status ?? 200]: { content: { 'application/json': { schema: spec.out } }, description: 'OK' },
        ...ERROR_RESPONSES,
      },
    });
    api.openapi(route, (async (c: Context) => {
      const req = c.req as unknown as { valid: (t: string) => Record<string, unknown> };
      const id = spec.params ? String(req.valid('param')['id']) : '';
      const body = spec.body === undefined ? {} : req.valid('json');
      const query = spec.query === undefined ? {} : req.valid('query');
      try {
        const result = await handler(c, { id, body, query });
        if (spec.audit !== undefined) {
          const target =
            id ||
            ((result as { id?: string; record?: { id?: string } })?.record?.id ??
              (result as { id?: string })?.id ??
              '');
          auditRow(c, spec, 'ok', target, {
            fields: Object.keys(body).filter((k) => k !== 'token'),
            ...Object.fromEntries(
              (spec.auditBody ?? []).map((k) => [
                k,
                String((body as Record<string, unknown>)[k] ?? '').slice(0, 200),
              ]),
            ),
          });
          options.onChange();
        }
        return c.json(result as never, spec.status ?? 200);
      } catch (error) {
        const mapped = toAdminError(error);
        if (!mapped.expected) {
          options.logger.error('admin API error', { path: spec.path, error: (error as Error).name });
        }
        if (spec.audit !== undefined) {
          auditRow(c, spec, mapped.status === 403 ? 'denied' : 'error', id || '-', {
            error: mapped.body.error.code,
          });
        }
        return c.json(mapped.body as never, mapped.status as never);
      }
    }) as never);
  }

  /** Ends all of a user's sessions and records why; a failure here must not hide the change that caused it. */
  async function endSessions(c: Context, userId: string, reason: string, record = true): Promise<number> {
    if (options.revokeUserSessions === undefined) return 0;
    const actor = c.get('actor' as never) as Actor;
    const revoked = await options.revokeUserSessions(userId);
    if (record) {
      keep(
        c,
        options.audit.admin({
          action: 'session.revoke_all',
          userId: actor.kind === 'user' ? actor.userId : null,
          targetType: 'user',
          targetId: userId.slice(0, 128),
          requestId: (c.get('requestId' as never) as string | undefined) ?? null,
          via: options.via ?? 'api',
          details: { reason, revoked, actor: actor.kind === 'user' ? actor.role : 'break_glass' },
        }),
      );
    }
    return revoked;
  }

  const SessionOut = z
    .object({
      actor: z.enum(['session', 'break_glass', 'user']),
      user: z
        .object({ id: z.string(), email: z.string(), displayName: z.string().nullable(), role: z.string() })
        .nullable(),
      recentAuth: z.boolean(),
      signedInAt: z.number().nullable(),
      idleExpiresAt: z.number().nullable(),
      expiresAt: z.number().nullable(),
      csrfToken: z.string().nullable().openapi({
        description: 'Send as `X-CSRF-Token` on every POST, PATCH and DELETE made with the session cookie.',
      }),
    })
    .openapi('Session');
  add(
    {
      method: 'get',
      path: '/session',
      tag: 'session',
      summary: 'The current session: user, role, whether the sign-in is recent, expiry and the CSRF token',
      out: SessionOut,
    },
    async (c) => {
      const view = c.get('sessionView' as never) as AdminSessionView | undefined;
      const actor = c.get('actor' as never) as Actor;
      if (view === undefined) {
        return {
          actor: actor.kind === 'user' ? 'user' : 'break_glass',
          user: null,
          recentAuth: actor.kind === 'break_glass' || actor.recentAuth,
          signedInAt: null,
          idleExpiresAt: null,
          expiresAt: null,
          csrfToken: null,
        };
      }
      return {
        actor: 'session',
        user: view.user,
        recentAuth: view.recentAuth,
        signedInAt: view.signedInAt,
        idleExpiresAt: view.idleExpiresAt,
        expiresAt: view.expiresAt,
        csrfToken: view.csrfToken,
      };
    },
  );

  const user = { tag: 'users' };
  add({ method: 'get', path: '/users', ...user, summary: 'List users', out: z.array(UserOut) }, (c) =>
    services(c).users.list(),
  );
  add(
    {
      method: 'post',
      path: '/users',
      ...user,
      summary: 'Create a user',
      body: NewUser,
      out: UserOut,
      status: 201,
      audit: { action: 'user.create', targetType: 'user' },
    },
    (c, { body }) => services(c).users.create(body as never),
  );
  add(
    { method: 'get', path: '/users/{id}', ...user, params: true, summary: 'Get a user', out: UserOut },
    async (c, { id }) => found(await services(c).users.get(id), 'user'),
  );
  add(
    {
      method: 'patch',
      path: '/users/{id}',
      ...user,
      params: true,
      summary: 'Change a user',
      body: UserPatch,
      out: UserOut,
      audit: { action: 'user.update', targetType: 'user' },
    },
    async (c, { id, body }) => {
      const updated = await services(c).users.update(id, body as never);
      // A role change takes effect at once: the user's sessions end (the role is read per request anyway, P4-02).
      if ((body as { role?: string }).role !== undefined) await endSessions(c, id, 'role_change');
      return updated;
    },
  );
  add(
    {
      method: 'post',
      path: '/users/{id}/disable',
      ...user,
      params: true,
      summary: 'Disable a user',
      out: UserOut,
      audit: { action: 'user.disable', targetType: 'user' },
    },
    async (c, { id }) => {
      const disabled = await services(c).users.disable(id);
      await endSessions(c, id, 'disabled');
      return disabled;
    },
  );

  add(
    {
      method: 'post',
      path: '/users/{id}/sessions/revoke',
      ...user,
      params: true,
      summary:
        "End all of a user's browser sessions (yourself; an owner anyone; an admin members; the break-glass token anyone)",
      out: z.object({ ok: z.literal(true), revoked: z.number() }),
      audit: { action: 'session.revoke_all', targetType: 'user' },
    },
    async (c, { id }) => {
      // The guard decides first and ends nothing; a refusal is audited by the generic denied row below.
      await services(c).users.authorizeEndSessions(id);
      return { ok: true as const, revoked: await endSessions(c, id, 'ended_by_request', false) };
    },
  );

  const inst = { tag: 'instances' };
  add(
    { method: 'get', path: '/instances', ...inst, summary: 'List instances', out: z.array(InstanceOut) },
    (c) => services(c).instances.list(),
  );
  add(
    {
      method: 'post',
      path: '/instances',
      ...inst,
      summary: 'Add an Agility instance',
      body: NewInstance,
      out: InstanceOut,
      status: 201,
      audit: { action: 'instance.create', targetType: 'instance' },
    },
    (c, { body }) => services(c).instances.create(body as never),
  );
  add(
    {
      method: 'get',
      path: '/instances/{id}',
      ...inst,
      params: true,
      summary: 'Get an instance',
      out: InstanceOut,
    },
    async (c, { id }) => found(await services(c).instances.get(id), 'instance'),
  );
  add(
    {
      method: 'patch',
      path: '/instances/{id}',
      ...inst,
      params: true,
      summary: 'Change label, number prefixes or disabled state',
      body: InstancePatch,
      out: InstanceOut,
      audit: { action: 'instance.update', targetType: 'instance' },
    },
    (c, { id, body }) => services(c).instances.update(id, body as never),
  );
  add(
    {
      method: 'post',
      path: '/instances/{id}/retarget',
      ...inst,
      params: true,
      summary: "Change an instance's origin or TLS trust (owner; revokes its credentials and grants)",
      body: Retarget,
      out: z.object({ instance: InstanceOut, revokedCredentials: z.number(), revokedGrants: z.number() }),
      audit: { action: 'instance.retarget', targetType: 'instance' },
    },
    (c, { id, body }) => services(c).instances.retarget(id, body as never),
  );
  add(
    {
      method: 'delete',
      path: '/instances/{id}',
      ...inst,
      params: true,
      summary: 'Delete an unused instance',
      out: Ok,
      audit: { action: 'instance.delete', targetType: 'instance' },
    },
    async (c, { id }) => {
      await services(c).instances.delete(id);
      return { ok: true };
    },
  );

  const cred = { tag: 'credentials' };
  add(
    {
      method: 'get',
      path: '/credentials',
      ...cred,
      summary: 'List credentials (never their tokens)',
      query: z.object({ instanceId: z.string().max(128).optional() }),
      out: z.array(CredentialOut),
    },
    async (c, { query }) => (await services(c).credentials.list(query as never)).map(credentialOut),
  );
  add(
    {
      method: 'post',
      path: '/credentials',
      ...cred,
      summary: 'Store an Agility access token (encrypted; shown never again)',
      body: NewCredential,
      out: CredentialOut,
      status: 201,
      audit: { action: 'credential.create', targetType: 'credential' },
    },
    async (c, { body }) => credentialOut(await services(c).credentials.create(body as never)),
  );
  add(
    {
      method: 'get',
      path: '/credentials/{id}',
      ...cred,
      params: true,
      summary: 'Get a credential',
      out: CredentialOut,
    },
    async (c, { id }) => credentialOut(found(await services(c).credentials.get(id), 'credential')),
  );
  add(
    {
      method: 'patch',
      path: '/credentials/{id}',
      ...cred,
      params: true,
      summary: 'Rename a credential',
      body: LabelPatch,
      out: CredentialOut,
      audit: { action: 'credential.update', targetType: 'credential' },
    },
    async (c, { id, body }) => credentialOut(await services(c).credentials.update(id, body as never)),
  );
  add(
    {
      method: 'post',
      path: '/credentials/{id}/token',
      ...cred,
      params: true,
      summary: "Replace a credential's token (it becomes unvalidated)",
      body: TokenReplacement,
      out: CredentialOut,
      audit: { action: 'credential.replace_token', targetType: 'credential' },
    },
    async (c, { id, body }) =>
      credentialOut(await services(c).credentials.replaceToken(id, String(body['token']))),
  );
  add(
    {
      method: 'post',
      path: '/credentials/{id}/validate',
      ...cred,
      params: true,
      summary: 'Validate a credential against Agility now (member, reachable projects, status)',
      out: CredentialOut,
      audit: { action: 'credential.validate', targetType: 'credential' },
    },
    async (c, { id }) => credentialOut(await services(c).credentials.validate(id)),
  );
  add(
    {
      method: 'post',
      path: '/credentials/{id}/revoke',
      ...cred,
      params: true,
      summary: 'Revoke a credential',
      out: CredentialOut,
      audit: { action: 'credential.revoke', targetType: 'credential' },
    },
    async (c, { id }) => credentialOut(await services(c).credentials.revoke(id)),
  );
  add(
    {
      method: 'delete',
      path: '/credentials/{id}',
      ...cred,
      params: true,
      summary: 'Delete an unused credential',
      out: Ok,
      audit: { action: 'credential.delete', targetType: 'credential' },
    },
    async (c, { id }) => {
      await services(c).credentials.delete(id);
      return { ok: true };
    },
  );

  const ws = { tag: 'workspaces' };
  add(
    { method: 'get', path: '/workspaces', ...ws, summary: 'List workspaces', out: z.array(WorkspaceOut) },
    (c) => services(c).workspaces.list(),
  );
  add(
    {
      method: 'post',
      path: '/workspaces',
      ...ws,
      summary: 'Create a workspace',
      body: NewWorkspace,
      out: WorkspaceOut,
      status: 201,
      audit: { action: 'workspace.create', targetType: 'workspace' },
    },
    (c, { body }) => services(c).workspaces.create(body as never),
  );
  add(
    {
      method: 'get',
      path: '/workspaces/{id}',
      ...ws,
      params: true,
      summary: 'Get a workspace',
      out: WorkspaceOut,
    },
    async (c, { id }) => found(await services(c).workspaces.get(id), 'workspace'),
  );
  add(
    {
      method: 'patch',
      path: '/workspaces/{id}',
      ...ws,
      params: true,
      summary: 'Change a workspace',
      body: WorkspacePatch,
      out: WorkspaceOut,
      audit: { action: 'workspace.update', targetType: 'workspace' },
    },
    (c, { id, body }) => services(c).workspaces.update(id, body as never),
  );
  add(
    {
      method: 'post',
      path: '/workspaces/{id}/disable',
      ...ws,
      params: true,
      summary: 'Disable a workspace',
      out: WorkspaceOut,
      audit: { action: 'workspace.disable', targetType: 'workspace' },
    },
    (c, { id }) => services(c).workspaces.disable(id),
  );
  add(
    {
      method: 'delete',
      path: '/workspaces/{id}',
      ...ws,
      params: true,
      summary: 'Delete a workspace, its grants and their tokens',
      out: Ok,
      audit: { action: 'workspace.delete', targetType: 'workspace' },
    },
    async (c, { id }) => {
      await services(c).workspaces.delete(id);
      return { ok: true };
    },
  );

  const gr = { tag: 'grants' };
  const GrantWithWarnings = z.object({ record: GrantOut, warnings: Warnings });
  add(
    {
      method: 'get',
      path: '/grants',
      ...gr,
      summary: 'List grants',
      query: z.object({ workspaceId: z.string().max(128).optional() }),
      out: z.array(GrantOut),
    },
    (c, { query }) => services(c).grants.list(query as never),
  );
  add(
    {
      method: 'post',
      path: '/grants',
      ...gr,
      summary: 'Grant a user or service access to a workspace',
      body: NewGrant,
      out: GrantWithWarnings,
      status: 201,
      audit: { action: 'grant.create', targetType: 'grant' },
    },
    (c, { body }) => services(c).grants.create(body as never),
  );
  add(
    { method: 'get', path: '/grants/{id}', ...gr, params: true, summary: 'Get a grant', out: GrantOut },
    async (c, { id }) => found(await services(c).grants.get(id), 'grant'),
  );
  add(
    {
      method: 'patch',
      path: '/grants/{id}',
      ...gr,
      params: true,
      summary: 'Change a grant',
      body: GrantPatch,
      out: GrantWithWarnings,
      audit: { action: 'grant.update', targetType: 'grant' },
    },
    (c, { id, body }) => services(c).grants.update(id, body as never),
  );
  add(
    {
      method: 'post',
      path: '/grants/{id}/revoke',
      ...gr,
      params: true,
      summary: 'Revoke a grant',
      out: GrantOut,
      audit: { action: 'grant.revoke', targetType: 'grant' },
    },
    (c, { id }) => services(c).grants.revoke(id),
  );
  add(
    {
      method: 'delete',
      path: '/grants/{id}',
      ...gr,
      params: true,
      summary: 'Delete a grant and its tokens',
      out: Ok,
      audit: { action: 'grant.delete', targetType: 'grant' },
    },
    async (c, { id }) => {
      await services(c).grants.delete(id);
      return { ok: true };
    },
  );

  const tk = { tag: 'tokens' };
  add(
    {
      method: 'get',
      path: '/grants/{id}/tokens',
      ...tk,
      params: true,
      summary: "List a grant's device tokens",
      out: z.array(TokenOut),
    },
    async (c, { id }) => (await services(c).tokens.list(id)).map(tokenOut),
  );
  add(
    {
      method: 'post',
      path: '/grants/{id}/tokens',
      ...tk,
      params: true,
      summary: 'Issue a device token (shown once)',
      body: NewToken,
      out: z.object({ token: z.string(), record: TokenOut, warnings: Warnings }),
      status: 201,
      audit: { action: 'token.issue', targetType: 'grant' },
    },
    async (c, { id, body }) => {
      const issued = await services(c).tokens.issue({ grantId: id, ...(body as { label: string }) });
      return { token: issued.token, record: tokenOut(issued.record), warnings: issued.warnings };
    },
  );
  add(
    {
      method: 'post',
      path: '/tokens/{id}/revoke',
      ...tk,
      params: true,
      summary: 'Revoke a device token',
      out: TokenOut,
      audit: { action: 'token.revoke', targetType: 'token' },
    },
    async (c, { id }) => tokenOut(await services(c).tokens.revoke(id)),
  );

  // Member self-service (P4-07): the signed-in person's own grants, credential choice and recent changes, open to every
  // role. No route takes a user id; the guards work from the actor, and the admin token (nobody) is refused.
  const me = { tag: 'me' };
  const MyGrantOut = z
    .object({
      grant: GrantOut,
      workspace: z
        .object({
          id: z.string(),
          slug: z.string(),
          name: z.string(),
          instanceId: z.string(),
          credentialSource: z.enum(['stored', 'passthrough']),
          hasDefaultCredential: z.boolean(),
          disabledAt: z.number().nullable(),
        })
        .nullable(),
    })
    .openapi('MyGrant');
  add(
    {
      method: 'get',
      path: '/me/grants',
      ...me,
      summary: 'My grants, each with its workspace (any signed-in role)',
      out: z.array(MyGrantOut),
    },
    async (c) =>
      (await services(c).me.grants()).map(({ grant, workspace }) => ({
        grant,
        workspace:
          workspace === null
            ? null
            : {
                id: workspace.id,
                slug: workspace.slug,
                name: workspace.name,
                instanceId: workspace.instanceId,
                credentialSource: workspace.credentialSource,
                hasDefaultCredential: workspace.defaultCredentialId !== null,
                disabledAt: workspace.disabledAt,
              },
      })),
  );
  add(
    {
      method: 'post',
      path: '/me/grants/{id}/credential',
      ...me,
      params: true,
      summary:
        'Use one of my own valid personal Agility tokens on my grant, or (null) go back to the workspace default',
      body: z.strictObject({ credentialId: Id.nullable() }),
      out: GrantWithWarnings,
      audit: { action: 'grant.set_credential', targetType: 'grant' },
      auditBody: ['credentialId'],
    },
    (c, { id, body }) =>
      services(c).me.setGrantCredential(id, (body as { credentialId: string | null }).credentialId),
  );
  add(
    {
      method: 'get',
      path: '/me/audit',
      ...me,
      summary: 'My recent administrative changes (newest first, at most 50)',
      query: z.object({ limit: z.coerce.number().int().min(1).max(50).optional() }),
      out: z.array(AuditOut),
    },
    async (c, { query }) => services(c).me.audit((query as { limit?: number }).limit),
  );

  add(
    {
      method: 'get',
      path: '/audit',
      tag: 'audit',
      summary:
        'Read the audit log, newest first (owner and admin: every row; a member: only their own rows, and another userId is refused)',
      query: AuditQuery,
      out: z.array(AuditOut),
    },
    async (c, { query }) => {
      const actor = c.get('actor' as never) as Actor;
      const q = query as z.infer<typeof AuditQuery>;
      // The reader's own id is the scope of a member (L-065): taken from the session, never from the query.
      let userId = q.userId;
      if (actor.kind === 'user' && actor.role === 'member') {
        if (userId !== undefined && userId !== actor.userId)
          throw new AdminError('forbidden', 'Members can read only their own audit rows.');
        userId = actor.userId;
      }
      return options.storage.audit.query({
        ...(q.workspaceId === undefined ? {} : { workspaceId: q.workspaceId }),
        ...(userId === undefined ? {} : { userId }),
        ...(q.kind === undefined ? {} : { kind: q.kind as AuditKind }),
        ...(q.status === undefined ? {} : { status: q.status as AuditStatus }),
        ...(q.action === undefined ? {} : { action: q.action }),
        ...(q.from === undefined ? {} : { from: q.from }),
        ...(q.to === undefined ? {} : { to: q.to }),
        ...(q.limit === undefined ? {} : { limit: q.limit }),
        ...(q.afterTs !== undefined && q.afterId !== undefined
          ? { after: { ts: q.afterTs, id: q.afterId } }
          : {}),
      });
    },
  );

  add(
    {
      method: 'get',
      path: '/audit/stats',
      tag: 'audit',
      summary:
        'Usage statistics from tool calls: calls, errors, denials, Agility requests and durations per tool, workspace, grant, user or day (owner, admin). Reads at most the newest 10,000 rows of the window and says when it stopped there.',
      query: AuditStatsQuery,
      out: AuditStatsOut,
    },
    async (c, { query }) => {
      const actor = c.get('actor' as never) as Actor;
      if (actor.kind === 'user' && actor.role === 'member')
        throw new AdminError('forbidden', 'This needs an owner or an admin.');
      const q = query as z.infer<typeof AuditStatsQuery>;
      const stats = await options.storage.audit.stats({
        groupBy: q.groupBy,
        ...(q.workspaceId === undefined ? {} : { workspaceId: q.workspaceId }),
        ...(q.from === undefined ? {} : { from: q.from }),
        ...(q.to === undefined ? {} : { to: q.to }),
        ...(q.limit === undefined ? {} : { limit: q.limit }),
      });
      return { data: stats.rows, scanned: stats.scanned, truncated: stats.truncated };
    },
  );

  const ToolOut = z
    .object({ name: z.string(), kind: z.enum(['read', 'write', 'destructive']), group: z.string() })
    .openapi('Tool');
  add(
    {
      method: 'get',
      path: '/tools',
      tag: 'tools',
      summary:
        'The tool catalogue: name, kind and group of every tool (owner, admin); what workspaces and grants choose from',
      out: z.array(ToolOut),
    },
    async (c) => {
      const actor = c.get('actor' as never) as Actor;
      if (actor.kind === 'user' && actor.role === 'member')
        throw new AdminError('forbidden', 'This needs an owner or an admin.');
      return [...options.tools.entries()]
        .map(([name, info]) => ({ name, kind: info.kind, group: info.group }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  );

  const KeyVersionOut = z
    .object({
      version: z.number(),
      credentials: z.number(),
      loaded: z.boolean(),
      current: z.boolean(),
      retired: z.boolean(),
    })
    .openapi('KeyVersion');
  const keys = { tag: 'keys' };
  add(
    {
      method: 'get',
      path: '/keys',
      ...keys,
      summary: 'Master-key versions: credentials on each, loaded, current, retired (owner)',
      out: z.array(KeyVersionOut),
    },
    (c) => services(c).keys.status(),
  );
  add(
    {
      method: 'post',
      path: '/keys/{id}/retire',
      ...keys,
      params: true,
      summary: 'Retire a master-key version no credential uses any more (owner; recorded in the audit log)',
      body: z.object({ reason: z.string().min(1).max(200) }),
      out: z.array(KeyVersionOut),
      audit: { action: 'crypto.retire_key', targetType: 'key_version' },
      auditBody: ['reason'],
    },
    (c, { id, body }) => {
      const version = Number(id);
      if (!Number.isInteger(version) || version < 1) {
        throw new AdminError('invalid_input', 'The key version is a whole number ≥ 1.', 'id');
      }
      return services(c).keys.retire(version, (body as { reason: string }).reason);
    },
  );

  const SetupLinkOut = z
    .object({
      id: z.string(),
      url: z.string().openapi({
        description:
          'Shown once. The code sits in the URL fragment: open it in a browser, never paste it where a server logs URLs.',
      }),
      expiresAt: z.number(),
    })
    .openapi('SetupLink');
  add(
    {
      method: 'post',
      path: '/setup-links',
      tag: 'users',
      summary:
        'Issue a single-use owner setup link (owner; the link makes whoever signs in with it an owner; recorded in the audit log)',
      body: z.strictObject({
        ttlMinutes: z
          .number()
          .int()
          .min(MIN_SETUP_LINK_TTL_MS / 60_000)
          .max(MAX_SETUP_LINK_TTL_MS / 60_000)
          .optional(),
      }),
      out: SetupLinkOut,
      status: 201,
      audit: { action: 'setup_link.create', targetType: 'setup_link' },
    },
    async (c, { body }) => {
      // The guard comes first: a non-owner learns nothing about the configuration.
      const guarded = services(c).setupLinks;
      const settings = options.setupLinks;
      const ttl =
        ((body as { ttlMinutes?: number }).ttlMinutes ?? DEFAULT_SETUP_LINK_TTL_MS / 60_000) * 60_000;
      guarded.authorize();
      if (settings === undefined) {
        throw new AdminError(
          'conflict',
          'Sign-in is not configured: set AB_PUBLIC_URL and an identity provider first.',
        );
      }
      const link = await guarded.create(ttl, options.clock);
      const hash = (await setupCodeHash(link.code)) as string;
      return {
        id: hash.slice(0, 12),
        // In the fragment: it never reaches a server, a log or a Referer (L-085).
        url: `${settings.publicUrl}/auth/setup#${link.code}`,
        expiresAt: link.expiresAt,
      };
    },
  );

  api.openAPIRegistry.registerComponent('securitySchemes', 'bearer', { type: 'http', scheme: 'bearer' });
  api.openAPIRegistry.registerComponent('securitySchemes', 'sessionCookie', {
    type: 'apiKey',
    in: 'cookie',
    name: '__Host-ab_session',
    description:
      'The browser session cookie set by /auth. Unsafe methods also need the CSRF token from GET /session in X-CSRF-Token.',
  });
  api.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: { title: 'agility-bridge admin API', version: '1' },
    servers: [{ url: ADMIN_BASE }],
  });
  return api;
}

function found<T>(row: T | null, what: string): T {
  if (row === null) throw new AdminError('not_found', `No ${what} with this id.`);
  return row;
}
