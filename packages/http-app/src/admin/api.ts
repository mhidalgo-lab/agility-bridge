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
  type TokenListItem,
  type ToolInfo,
} from '@agility-bridge/auth';
import {
  type Clock,
  COMPOSITE_SIBLINGS,
  CORE_TOOLS,
  type Logger,
  type WriteBudget,
} from '@agility-bridge/core';
import type {
  AccessToken,
  AuditEntry,
  AuditKind,
  AuditStatus,
  Credential,
  Storage,
} from '@agility-bridge/storage';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { LinearRouter } from 'hono/router/linear-router';
import type { RequestLimits } from '../app.ts';
import type { AuditWriter } from '../audit.ts';
import { CSRF_HEADER, isUnsafeMethod, type SessionManager } from '../session.ts';
import { AdminError, errorBody, toAdminError } from './errors.ts';
import { writeStats } from './write-stats.ts';

export const ADMIN_BASE = '/api/admin/v1';
const MAX_ADMIN_BODY_BYTES = 64 * 1024;

/**
 * The body as text, read at most `max` bytes deep: a request that goes past the cap is cancelled where it stands (`null`),
 * not buffered whole first (T20, P4-09). Any signed-in member can reach this code.
 */
async function readCapped(request: Request, max: number): Promise<string | null> {
  if (request.body === null) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      // Not awaited: on the branch of a `clone()` the promise settles only when the other branch is cancelled too.
      void reader.cancel().catch(() => undefined);
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

/** The signed-in person's OAuth devices (P5-04): what `GET /me/oauth-devices` and its revoke routes use. */
/** Declared request cost of every tool, from the same definitions the server registers (L-314). */
const DECLARED_COST: ReadonlyMap<string, number> = new Map(CORE_TOOLS.map((t) => [t.name, t.cost]));

export interface AdminOAuthDevices {
  list(userId: string): Promise<
    readonly {
      readonly id: string;
      readonly clientName: string | null;
      readonly redirectHost: string;
      readonly workspaceId: string | null;
      readonly label: string | null;
      readonly createdAt: number;
      readonly expiresAt: number | null;
      readonly lastUsedAt: number | null;
    }[]
  >;
  /** False when the id is not one of this person's devices. */
  revoke(c: Context, userId: string, deviceId: string): Promise<boolean>;
  revokeAll(c: Context, userId: string): Promise<number>;
}

/** Every person's OAuth apps and the registered clients (P5-08): what the `/oauth/*` routes use. Callers are authorized before these run. */
export interface AdminOAuthAdmin {
  devices(page: { readonly after?: string; readonly limit?: number }): Promise<{
    readonly devices: readonly {
      readonly id: string;
      readonly userId: string;
      readonly clientName: string | null;
      readonly redirectHost: string;
      readonly workspaceId: string | null;
      readonly label: string | null;
      readonly createdAt: number;
      readonly expiresAt: number | null;
    }[];
    readonly next: string | null;
  }>;
  revokeDevice(c: Context, userId: string, deviceId: string, by: string | null): Promise<boolean>;
  clients(page: { readonly after?: string; readonly limit?: number }): Promise<{
    readonly clients: readonly {
      readonly clientId: string;
      readonly kind: 'dynamic' | 'metadata_document';
      readonly name: string | null;
      readonly redirectHosts: readonly string[];
      readonly createdAt: number | null;
      readonly lastApprovedAt: number | null;
      readonly devices: number | null;
    }[];
    readonly blocked: readonly {
      readonly clientId: string;
      readonly kind: 'dynamic' | 'metadata_document';
      readonly name: string | null;
      readonly at: number;
    }[];
    readonly next: string | null;
    readonly devicesTruncated: boolean;
  }>;
  revokeClient(
    c: Context,
    clientId: string,
    by: string | null,
  ): Promise<{ readonly devices: number; readonly complete: boolean } | null>;
  restoreClient(c: Context, clientId: string, by: string | null): Promise<boolean>;
  /** The abuse limits, the registration caps against their use and the last day's refusals (P5-20). */
  abuse(): Promise<{
    readonly registrations: {
      readonly dynamic: { readonly enabled: boolean; readonly live: number; readonly cap: number };
      readonly documents: { readonly enabled: boolean; readonly stored: number; readonly cap: number };
    };
    readonly limits: Readonly<Record<string, number>>;
    readonly windowHours: number;
    readonly refusals: readonly {
      readonly action: 'oauth.request.refused' | 'oauth.client.refused';
      readonly reason: string;
      readonly surface: string | null;
      readonly scope: string | null;
      readonly kind: string | null;
      readonly count: number;
      readonly lastAt: number;
    }[];
    readonly refusalsTruncated: boolean;
  }>;
}

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
  /**
   * The sign-in providers this deployment configured, as identities (`google`, `oidc:<name>`, ...): the only values the
   * owner-only unbind may name (P4-39). Absent = none can be named.
   */
  readonly configuredIdps?: readonly string[];
  /** Reads the write budget of a grant (and the deployment's) without taking a unit; absent when write tools are off (P7-16). */
  readonly writeBudget?: (grantId: string, grantLimit?: number) => Promise<WriteBudget>;
  /** `AB_WRITE_RATE_PER_GRANT_HOURLY`: the most a grant's own hourly write limit may be (P7-15). */
  readonly writeRateCap?: number;
  /** OAuth is on (P5-04): the signed-in person's connected apps. Absent = the `/me/oauth-devices` routes answer 404. */
  readonly oauthDevices?: AdminOAuthDevices;
  /** OAuth is on (P5-08): every person's apps and the registered clients. Absent = the `/oauth/*` routes answer 404. */
  readonly oauthAdmin?: AdminOAuthAdmin;
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
const TokenListItemOut = TokenOut.extend({
  userId: z.string().nullable().openapi({ description: "The grant's user; null on a service grant." }),
  workspaceId: z.string(),
  grantLabel: z.string().nullable(),
}).openapi('DeviceTokenListItem');
const UserListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
  ids: z
    .string()
    .max(50 * 130)
    .optional(),
});

const TokenListQuery = z.object({
  grantId: z.string().max(128).optional(),
  userId: z.string().max(128).optional(),
  after: z
    .string()
    .max(160)
    .optional()
    .openapi({ description: 'The `next` of the previous page; anything else is a 422.' }),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
/** Pages of 1,000 write rows the statistics read at most (three queries). */
const WRITE_STATS_PAGES = 3;
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
const BudgetCount = z.object({ limit: z.number(), used: z.number(), remaining: z.number() });
const WriteBudgetOut = z
  .object({
    enabled: z.boolean(),
    status: z.enum(['ok', 'unknown']).optional(),
    windowEndsAt: z.number().optional(),
    grant: BudgetCount.optional(),
    deployment: BudgetCount.nullable().optional(),
  })
  .openapi('WriteBudget');
const WriteStatsQuery = z.object({
  workspaceId: z.string().max(128).optional(),
  from: z.coerce.number().int().min(0).optional(),
  to: z.coerce.number().int().min(0).optional(),
});
const WriteStatsRowOut = z.object({
  key: z.string(),
  writes: z.number(),
  ok: z.number(),
  error: z.number(),
  noOutcome: z.number(),
  inProgress: z.number(),
});
const WriteStatsOut = z
  .object({
    byTool: z.array(WriteStatsRowOut),
    byChannel: z.array(WriteStatsRowOut),
    total: WriteStatsRowOut,
    unpaired: z.array(
      z.object({
        intentId: z.string(),
        ts: z.number(),
        tool: z.string(),
        targetType: z.string().nullable(),
        targetId: z.string().nullable(),
        workspaceId: z.string().nullable(),
        userId: z.string().nullable(),
      }),
    ),
    scanned: z.number(),
    truncated: z.boolean(),
  })
  .openapi('WriteStats');
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

/**
 * One body value as it goes into an audit row: text as it is, lists and objects as JSON, at most 200 characters. Only for
 * the fields a route names in `auditBody`: roles, ids, project and tool lists, switches and reasons (P4-09).
 */
function auditValue(value: unknown): string {
  if (value === undefined) return '';
  return (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 200);
}

function tokenListItem(t: TokenListItem) {
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
  /**
   * Body values recorded with the audit row: roles, ids, project and tool lists, switches and operator reasons, never
   * secrets or names typed by people (P3-11 review, P4-09).
   */
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
      const text = await readCapped(c.req.raw.clone(), MAX_ADMIN_BODY_BYTES);
      if (text === null) {
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
        now: () => options.clock.now(),
        ...(options.configuredIdps === undefined ? {} : { configuredIdps: options.configuredIdps }),
        ...(options.writeRateCap === undefined ? {} : { writeRateCap: options.writeRateCap }),
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
            ...(c.get('auditDetails' as never) as Record<string, unknown> | undefined),
            fields: Object.keys(body).filter((k) => k !== 'token'),
            ...Object.fromEntries(
              (spec.auditBody ?? [])
                .filter((k) => k in body)
                .map((k) => [k, auditValue((body as Record<string, unknown>)[k])]),
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
            ...(c.get('auditDetails' as never) as Record<string, unknown> | undefined),
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
  add(
    {
      method: 'get',
      path: '/users',
      ...user,
      summary:
        'List users, oldest first. `limit` and `offset` return one page, `ids` (comma-separated, at most 50) only those users',
      query: UserListQuery,
      out: z.array(UserOut),
    },
    async (c, { query }) => {
      const q = query as z.infer<typeof UserListQuery>;
      // The same authorization as the full list; the slice is taken before the rows are validated and serialized (P4-28).
      const all = await services(c).users.list();
      if (q.ids !== undefined) {
        const wanted = new Set(q.ids.split(',').slice(0, 50));
        return all.filter((u) => wanted.has(u.id));
      }
      const from = q.offset ?? 0;
      return q.limit === undefined && from === 0 ? all : all.slice(from, from + (q.limit ?? all.length));
    },
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
      auditBody: ['role'],
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
      auditBody: ['role'],
    },
    async (c, { id, body }) => {
      // The role before the change, so a promotion can be told from a demotion in the audit log (P4-09).
      const before = (body as { role?: string }).role === undefined ? null : await services(c).users.get(id);
      const updated = await services(c).users.update(id, body as never);
      if (before !== null) c.set('auditDetails' as never, { previousRole: before.role } as never);
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
      path: '/users/{id}/enable',
      ...user,
      params: true,
      summary:
        'Enable a disabled user again (owners for owners and admins, with a recent sign-in; admins for members; 409 when the user is not disabled). Restores nothing but the right to sign in: grants and device tokens that were not revoked work again',
      out: UserOut,
      audit: { action: 'user.enable', targetType: 'user' },
    },
    (c, { id }) => services(c).users.enable(id),
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

  add(
    {
      method: 'post',
      path: '/users/{id}/unbind',
      ...user,
      params: true,
      summary:
        "Clear a user's sign-in identity so the next verified sign-in with their email binds again, optionally only at a named `provider` for `ttlMinutes` (owner, recent sign-in, never yourself through a session; the body repeats the user's email; ends their sessions)",
      body: z.strictObject({
        confirm: z.string().min(3).max(320).openapi({
          description:
            "The user's current email address, typed again. Anyone who then signs in with a provider that asserts this verified email takes over the account.",
        }),
        provider: z
          .string()
          .regex(/^[a-z0-9][a-z0-9:_.-]{0,63}$/i)
          .optional()
          .openapi({
            description:
              'Only this provider may bind the account next; it must be one this deployment has configured (google, github, cf-access or oidc:<name>), otherwise the request is refused with 422. A sign-in at another provider is refused while the claim lasts.',
          }),
        ttlMinutes: z.number().int().min(1).max(10_080).optional().openapi({
          description:
            'How long the provider claim lasts, in minutes (default 1440, at most 10080). Needs `provider`.',
        }),
      }),
      out: UserOut,
      audit: { action: 'user.unbind', targetType: 'user' },
    },
    async (c, { id, body }) => {
      // The guard decides first and changes nothing on a refusal (a denied audit row is written by the generic path).
      const b = body as { confirm: string; provider?: string; ttlMinutes?: number };
      const {
        user: cleared,
        previousIdp,
        requiredIdp,
        claimMinutes,
      } = await services(c).users.unbind(id, b.confirm, {
        ...(b.provider === undefined ? {} : { provider: b.provider }),
        ...(b.ttlMinutes === undefined ? {} : { ttlMinutes: b.ttlMinutes }),
      });
      // Never the subject or the typed confirmation: the previous provider id and the provider asked for (P4-24).
      c.set(
        'auditDetails' as never,
        {
          previousIdp,
          ...(requiredIdp === null ? {} : { requiredIdp, claimMinutes }),
        } as never,
      );
      // After the compare-and-set: a session that existed at that moment is ended, and so is any created since.
      await endSessions(c, id, 'unbind');
      return cleared;
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
      summary:
        'Add an Agility instance (owners and admins; a CA file in `tls` is an owner with a recent sign-in)',
      body: NewInstance,
      out: InstanceOut,
      status: 201,
      audit: { action: 'instance.create', targetType: 'instance' },
    },
    async (c, { body }) => {
      const created = await services(c).instances.create(body as never);
      // Where member tokens will be sent: the host only (never a path or a query), P4-09.
      c.set('auditDetails' as never, { host: hostOf(created.baseUrl) } as never);
      return created;
    },
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
    async (c, { id, body }) => {
      const before = await services(c).instances.get(id);
      const result = await services(c).instances.retarget(id, body as never);
      c.set(
        'auditDetails' as never,
        {
          host: hostOf(result.instance.baseUrl),
          ...(before === null ? {} : { previousHost: hostOf(before.baseUrl) }),
          revokedCredentials: result.revokedCredentials,
          revokedGrants: result.revokedGrants,
        } as never,
      );
      return result;
    },
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
      auditBody: ['instanceId', 'ownerUserId'],
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
      auditBody: [
        'allowedScopeIds',
        'includeChildScopes',
        'assetTypes',
        'enabledTools',
        'writePolicy',
        'credentialSource',
        'defaultCredentialId',
      ],
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
      summary:
        'Change a workspace (owners and admins; write settings and pass-through: an owner with a recent sign-in; so is adding projects or asset types to a workspace that has write tools)',
      body: WorkspacePatch,
      out: WorkspaceOut,
      audit: { action: 'workspace.update', targetType: 'workspace' },
      auditBody: [
        'allowedScopeIds',
        'includeChildScopes',
        'assetTypes',
        'enabledTools',
        'writePolicy',
        'credentialSource',
        'defaultCredentialId',
      ],
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
      auditBody: ['userId', 'credentialId', 'tools', 'scopeIds', 'assetTypes', 'expiresAt', 'rateLimit'],
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
      summary:
        "Change a grant (owners and admins; write tools, widening the projects, asset types or end date of a grant that has them, and the grant's own hourly write limit `rateLimit.writesPerHour`, which can only lower the server's: an owner with a recent sign-in)",
      body: GrantPatch,
      out: GrantWithWarnings,
      audit: { action: 'grant.update', targetType: 'grant' },
      auditBody: ['credentialId', 'tools', 'scopeIds', 'assetTypes', 'expiresAt', 'rateLimit'],
    },
    async (c, { id, body }) => {
      // The hourly write limit before the change, so a loosening can be told from a tightening in the audit log (P7-15).
      const before = (await services(c).grants.get(id))?.rateLimit as
        | { writesPerHour?: unknown }
        | null
        | undefined;
      if (typeof before?.writesPerHour === 'number')
        c.set('auditDetails' as never, { previousWritesPerHour: before.writesPerHour } as never);
      return services(c).grants.update(id, body as never);
    },
  );
  add(
    {
      method: 'get',
      path: '/grants/{id}/write-budget',
      ...gr,
      params: true,
      summary:
        "One grant's writes used this hour and its limit (the lower of the server's and the grant's own cap), read without taking a unit. Owners and admins any grant, a member only their own (another is a 404). `{ enabled: false }` when write tools are off.",
      out: WriteBudgetOut,
    },
    async (c, { id }) => {
      // The guarded read decides visibility: a member's other grants are "not found".
      const grant = found(await services(c).grants.get(id), 'grant');
      const own = (grant.rateLimit as { writesPerHour?: unknown } | null)?.writesPerHour;
      return budgetOut(await options.writeBudget?.(id, typeof own === 'number' ? own : undefined), {
        grant: true,
        deployment: false,
      });
    },
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
      method: 'get',
      path: '/tokens',
      ...tk,
      summary:
        'List the device tokens you may see, newest first, one page at a time (owners and admins: every token; others: the tokens of their own grants). Never a hash or a token value',
      query: TokenListQuery,
      out: z.object({
        data: z.array(TokenListItemOut),
        next: z
          .string()
          .nullable()
          .openapi({ description: 'Pass as `after` for the next page; null on the last.' }),
      }),
    },
    async (c, { query }) => {
      const q = query as z.infer<typeof TokenListQuery>;
      const page = await services(c).tokens.listAll({
        ...(q.grantId === undefined ? {} : { grantId: q.grantId }),
        ...(q.userId === undefined ? {} : { userId: q.userId }),
        ...(q.after === undefined ? {} : { after: q.after }),
        ...(q.limit === undefined ? {} : { limit: q.limit }),
      });
      return { data: page.data.map(tokenListItem), next: page.next };
    },
  );
  add(
    {
      method: 'post',
      path: '/grants/{id}/tokens',
      ...tk,
      params: true,
      summary:
        'Issue a device token (shown once; your own grants, or any for owners and admins). A lifetime over 90 days or `never` needs a sign-in from the last 10 minutes',
      body: NewToken,
      out: z.object({ token: z.string(), record: TokenOut, warnings: Warnings }),
      status: 201,
      audit: { action: 'token.issue', targetType: 'grant' },
      auditBody: ['expiresInDays'],
    },
    async (c, { id, body }) => {
      const issued = await services(c).tokens.issue({ grantId: id, ...(body as { label: string }) });
      // Which token, and until when: a tool call carries the token id, so it can be traced back to who issued it (P4-09).
      c.set(
        'auditDetails' as never,
        { tokenId: issued.record.id, tokenExpiresAt: issued.record.expiresAt } as never,
      );
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
  const OAuthDeviceOut = z
    .object({
      id: z.string().openapi({ description: 'The device id (send it to `/me/oauth-devices/{id}/revoke`).' }),
      clientName: z
        .string()
        .nullable()
        .openapi({ description: 'The name the app gave itself: untrusted text, never verified.' }),
      redirectHost: z.string().openapi({ description: 'Host the app was approved to send the answer to.' }),
      workspaceId: z.string().nullable(),
      workspaceName: z.string().nullable(),
      workspaceSlug: z.string().nullable(),
      label: z.string().nullable().openapi({ description: 'The device name typed on the consent screen.' }),
      createdAt: z.number(),
      expiresAt: z.number().nullable(),
      lastUsedAt: z.number().nullable().openapi({
        description:
          'When a token was last issued or the app last made a request, to within about 5 minutes; null when not seen yet.',
      }),
    })
    .openapi('OAuthDevice');
  /** The signed-in person's id for the OAuth device routes: a session only, never the break-glass token. */
  const deviceOwner = (c: Context): { userId: string; devices: AdminOAuthDevices } => {
    const devices = options.oauthDevices;
    if (devices === undefined) throw new AdminError('not_found', 'OAuth is not enabled on this server.');
    const actor = c.get('actor' as never) as Actor;
    if (actor.kind !== 'user') throw new AdminError('forbidden', 'This needs a signed-in person.');
    return { userId: actor.userId, devices };
  };
  const DEVICE_ID_RE = /^[A-Za-z0-9_-]{16}$/;
  add(
    {
      method: 'get',
      path: '/me/oauth-devices',
      ...me,
      summary: 'The apps I connected with OAuth, newest first (any signed-in role; 404 when OAuth is off)',
      out: z.array(OAuthDeviceOut),
    },
    async (c) => {
      const { userId, devices } = deviceOwner(c);
      const list = await devices.list(userId);
      const names = new Map<string, { name: string; slug: string }>();
      for (const id of new Set(list.flatMap((d) => (d.workspaceId === null ? [] : [d.workspaceId])))) {
        const w = await options.storage.workspaces.get(id);
        if (w !== null) names.set(id, { name: w.name, slug: w.slug });
      }
      return list.map((d) => ({
        ...d,
        workspaceName: names.get(d.workspaceId ?? '')?.name ?? null,
        workspaceSlug: names.get(d.workspaceId ?? '')?.slug ?? null,
      }));
    },
  );
  add(
    {
      method: 'post',
      path: '/me/oauth-devices/revoke-all',
      ...me,
      summary:
        'Disconnect every app I connected with OAuth: their access and refresh tokens stop working at once',
      out: z.object({ revoked: z.number() }),
    },
    async (c) => {
      const { userId, devices } = deviceOwner(c);
      return { revoked: await devices.revokeAll(c, userId) };
    },
  );
  add(
    {
      method: 'post',
      path: '/me/oauth-devices/{id}/revoke',
      ...me,
      params: true,
      summary:
        "Disconnect one of my apps: its access and refresh tokens stop working at once (another person's device answers 404)",
      out: z.object({ revoked: z.literal(true) }),
    },
    async (c, { id }) => {
      const { userId, devices } = deviceOwner(c);
      if (!DEVICE_ID_RE.test(id) || !(await devices.revoke(c, userId, id))) {
        throw new AdminError('not_found', 'No such connected app.');
      }
      return { revoked: true as const };
    },
  );
  // Connected apps of everyone and registered clients (P5-08, THREAT_MODEL T15). The guard runs first: a refused caller
  // learns nothing, not even whether OAuth is on. Every change is a POST (L-090) with the panel's CSRF checks and an audit row.
  const oauthTag = { tag: 'oauth' };
  const OAuthAdminDeviceOut = z
    .object({
      id: z
        .string()
        .openapi({ description: 'The device id (send it with `userId` to `/oauth/devices/{id}/revoke`).' }),
      userId: z.string(),
      userEmail: z.string().nullable(),
      userName: z.string().nullable(),
      userRole: z.enum(['owner', 'admin', 'member']).nullable(),
      clientName: z
        .string()
        .nullable()
        .openapi({ description: 'The name the app gave itself: untrusted text, never verified.' }),
      redirectHost: z.string(),
      workspaceId: z.string().nullable(),
      workspaceName: z.string().nullable(),
      workspaceSlug: z.string().nullable(),
      label: z.string().nullable(),
      createdAt: z.number(),
      expiresAt: z.number().nullable(),
    })
    .openapi('OAuthAdminDevice');
  const OAuthClientOut = z
    .object({
      clientId: z.string(),
      kind: z.enum(['dynamic', 'metadata_document']),
      name: z
        .string()
        .nullable()
        .openapi({ description: 'Untrusted text the client chose; never verified.' }),
      redirectHosts: z.array(z.string()),
      createdAt: z.number().nullable(),
      lastApprovedAt: z.number().nullable().openapi({
        description: 'The newest approval among the devices counted (not the last time a token was used).',
      }),
      devices: z.number().nullable().openapi({ description: 'Null when the count could not be made.' }),
    })
    .openapi('OAuthClient');
  const oauthAdmin = (): AdminOAuthAdmin => {
    const admin = options.oauthAdmin;
    if (admin === undefined) throw new AdminError('not_found', 'OAuth is not enabled on this server.');
    return admin;
  };
  const actorUserId = (c: Context): string | null => {
    const actor = c.get('actor' as never) as Actor;
    return actor.kind === 'user' ? actor.userId : null;
  };
  const DEVICE_CURSOR_RE = /^[A-Za-z0-9_-]{1,128}:[A-Za-z0-9_-]{16}$/;
  const CLIENT_CURSOR_RE = /^[\x21-\x7e]{1,512}$/;
  const OAuthDeviceListQuery = z.object({
    after: z.string().regex(DEVICE_CURSOR_RE).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  });
  const OAuthClientListQuery = z.object({
    after: z.string().regex(CLIENT_CURSOR_RE).optional(),
    limit: z.coerce.number().int().min(1).max(25).optional(),
  });
  const ClientIdBody = z.strictObject({ clientId: z.string().regex(CLIENT_CURSOR_RE) });
  add(
    {
      method: 'get',
      path: '/oauth/devices',
      ...oauthTag,
      summary:
        "Every person's connected OAuth apps, one page at a time in storage order (owners and admins; 404 when OAuth is off). Never a token",
      query: OAuthDeviceListQuery,
      out: z.object({
        data: z.array(OAuthAdminDeviceOut),
        next: z
          .string()
          .nullable()
          .openapi({ description: 'Pass as `after` for the next page; null on the last.' }),
      }),
    },
    async (c, { query }) => {
      services(c).oauth.authorizeDeviceList();
      const admin = oauthAdmin();
      const q = query as z.infer<typeof OAuthDeviceListQuery>;
      const page = await admin.devices({
        ...(q.after === undefined ? {} : { after: q.after }),
        ...(q.limit === undefined ? {} : { limit: q.limit }),
      });
      const [people, spaces] = await Promise.all([
        options.storage.users.list(),
        options.storage.workspaces.list(),
      ]);
      const byUser = new Map(people.map((u) => [u.id, u]));
      const bySpace = new Map(spaces.map((w) => [w.id, w]));
      return {
        data: page.devices.map((d) => {
          const u = byUser.get(d.userId);
          const w = bySpace.get(d.workspaceId ?? '');
          return {
            ...d,
            userEmail: u?.email ?? null,
            userName: u?.displayName ?? null,
            userRole: u?.role ?? null,
            workspaceName: w?.name ?? null,
            workspaceSlug: w?.slug ?? null,
          };
        }),
        next: page.next,
      };
    },
  );
  add(
    {
      method: 'post',
      path: '/oauth/devices/{id}/revoke',
      ...oauthTag,
      params: true,
      summary:
        "Disconnect one person's app: its access and refresh tokens stop working at once (owners: anyone's; admins: a member's). An unknown device answers 404",
      body: z.strictObject({ userId: Id }),
      out: z.object({ revoked: z.literal(true) }),
      audit: { action: 'oauth_device.revoke', targetType: 'oauth_device' },
      auditBody: ['userId'],
    },
    async (c, { id, body }) => {
      const { userId } = body as { userId: string };
      await services(c).oauth.authorizeDeviceRevoke(userId);
      const admin = oauthAdmin();
      if (!DEVICE_ID_RE.test(id) || !(await admin.revokeDevice(c, userId, id, actorUserId(c)))) {
        throw new AdminError('not_found', 'No such connected app.');
      }
      return { revoked: true as const };
    },
  );
  add(
    {
      method: 'get',
      path: '/oauth/clients',
      ...oauthTag,
      summary:
        'Registered OAuth clients (dynamic registrations and metadata documents) and revoked ones, a page at a time (owners; 404 when OAuth is off)',
      query: OAuthClientListQuery,
      out: z.object({
        data: z.array(OAuthClientOut),
        blocked: z.array(
          z.object({
            clientId: z.string(),
            kind: z.enum(['dynamic', 'metadata_document']),
            name: z.string().nullable(),
            at: z.number(),
          }),
        ),
        next: z.string().nullable(),
        devicesTruncated: z.boolean().openapi({
          description: 'More devices exist than were counted: the counts are lower bounds.',
        }),
      }),
    },
    async (c, { query }) => {
      services(c).oauth.authorizeClients();
      const admin = oauthAdmin();
      const q = query as z.infer<typeof OAuthClientListQuery>;
      const page = await admin.clients({
        ...(q.after === undefined ? {} : { after: q.after }),
        ...(q.limit === undefined ? {} : { limit: q.limit }),
      });
      return {
        data: page.clients,
        blocked: page.blocked,
        next: page.next,
        devicesTruncated: page.devicesTruncated,
      };
    },
  );
  add(
    {
      method: 'get',
      path: '/oauth/abuse',
      ...oauthTag,
      summary:
        'OAuth abuse controls (owners; 404 when OAuth is off): registration caps against their use, the configured limits, and the refusals of the last 24 hours by reason. No address, client or token is ever in it',
      out: z.object({
        registrations: z.object({
          dynamic: z.object({ enabled: z.boolean(), live: z.number(), cap: z.number() }),
          documents: z.object({ enabled: z.boolean(), stored: z.number(), cap: z.number() }),
        }),
        limits: z.record(z.string(), z.number()),
        windowHours: z.number(),
        refusals: z.array(
          z.object({
            action: z.enum(['oauth.request.refused', 'oauth.client.refused']),
            reason: z.string(),
            surface: z.string().nullable(),
            scope: z.string().nullable(),
            kind: z.string().nullable(),
            count: z.number().openapi({
              description:
                'Audit rows. A limit is recorded once per window it is reached in, so this counts windows, not requests.',
            }),
            lastAt: z.number(),
          }),
        ),
        refusalsTruncated: z.boolean(),
      }),
    },
    async (c) => {
      services(c).oauth.authorizeClients();
      return oauthAdmin().abuse();
    },
  );
  add(
    {
      method: 'post',
      path: '/oauth/clients/revoke',
      ...oauthTag,
      summary:
        'Revoke an OAuth client (owners): no new authorization, no refresh and no access token of it passes, its devices end and its registration is deleted. A new registration is a new client',
      body: ClientIdBody,
      out: z.object({ id: z.string(), revoked: z.literal(true), devices: z.number(), complete: z.boolean() }),
      audit: { action: 'oauth_client.revoke', targetType: 'oauth_client' },
      auditBody: ['clientId'],
    },
    async (c, { body }) => {
      services(c).oauth.authorizeClients();
      const admin = oauthAdmin();
      const { clientId } = body as { clientId: string };
      const result = await admin.revokeClient(c, clientId, actorUserId(c));
      if (result === null) throw new AdminError('not_found', 'No such client.');
      return { id: clientId, revoked: true as const, ...result };
    },
  );
  add(
    {
      method: 'post',
      path: '/oauth/clients/restore',
      ...oauthTag,
      summary:
        'Lift the revocation of a client (owners): a metadata-document client may be used again, a deleted dynamic registration does not come back',
      body: ClientIdBody,
      out: z.object({ id: z.string(), restored: z.literal(true) }),
      audit: { action: 'oauth_client.restore', targetType: 'oauth_client' },
      auditBody: ['clientId'],
    },
    async (c, { body }) => {
      services(c).oauth.authorizeClients();
      const admin = oauthAdmin();
      const { clientId } = body as { clientId: string };
      if (!(await admin.restoreClient(c, clientId, actorUserId(c)))) {
        throw new AdminError('not_found', 'That client is not revoked.');
      }
      return { id: clientId, restored: true as const };
    },
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

  /** The shape both budget routes answer: only what the route asks for is in it. */
  const budgetOut = (b: WriteBudget | undefined, parts: { grant: boolean; deployment: boolean }) =>
    b === undefined
      ? { enabled: false }
      : b.status !== 'ok'
        ? { enabled: true, status: 'unknown' as const }
        : {
            enabled: true,
            status: 'ok' as const,
            windowEndsAt: b.windowEndsAt,
            ...(parts.grant ? { grant: b.grant } : {}),
            ...(parts.deployment ? { deployment: b.deployment } : {}),
          };
  add(
    {
      method: 'get',
      path: '/writes/budget',
      tag: 'audit',
      summary:
        'The deployment\'s writes used this hour and its limit, read without taking a unit (owner, admin). `{ enabled: false }` when write tools are off; `unknown` when the counters cannot be read, never "unlimited".',
      out: WriteBudgetOut,
    },
    async (c) => {
      const actor = c.get('actor' as never) as Actor;
      if (actor.kind === 'user' && actor.role === 'member')
        throw new AdminError('forbidden', 'This needs an owner or an admin.');
      return budgetOut(await options.writeBudget?.('-'), { grant: false, deployment: true });
    },
  );

  add(
    {
      method: 'get',
      path: '/audit/write-stats',
      tag: 'audit',
      summary:
        'Write statistics (P7-11): writes by tool and approval channel, and by outcome (ok, error, no outcome recorded), counting each intent with its outcome once, and the intents with no outcome (owner, admin). Reads at most the newest 3,000 write rows of the window and says when it stopped there.',
      query: WriteStatsQuery,
      out: WriteStatsOut,
    },
    async (c, { query }) => {
      const actor = c.get('actor' as never) as Actor;
      if (actor.kind === 'user' && actor.role === 'member')
        throw new AdminError('forbidden', 'This needs an owner or an admin.');
      const q = query as z.infer<typeof WriteStatsQuery>;
      const rows: AuditEntry[] = [];
      let after: { ts: number; id: string } | undefined;
      let truncated = false;
      for (let page = 0; page < WRITE_STATS_PAGES; page++) {
        const got = await options.storage.audit.query({
          kind: 'write',
          limit: 1_000,
          ...(q.workspaceId === undefined ? {} : { workspaceId: q.workspaceId }),
          ...(q.from === undefined ? {} : { from: q.from }),
          ...(q.to === undefined ? {} : { to: q.to }),
          ...(after === undefined ? {} : { after }),
        });
        rows.push(...got);
        const last = got[got.length - 1];
        if (got.length < 1_000 || last === undefined) break;
        if (page === WRITE_STATS_PAGES - 1) truncated = true;
        after = { ts: last.ts, id: last.id };
      }
      return { ...writeStats(rows, options.clock.now()), scanned: rows.length, truncated };
    },
  );

  const ToolOut = z
    .object({
      name: z.string(),
      kind: z.enum(['read', 'write', 'destructive']),
      group: z.string(),
      cost: z.number().int().min(0).optional(),
      siblings: z.array(z.string()).optional(),
    })
    .openapi('Tool');
  add(
    {
      method: 'get',
      path: '/tools',
      tag: 'tools',
      summary:
        'The tool catalogue: name, kind, group and (for a composite) the sibling tools it reads, of every tool (owner, admin); what workspaces and grants choose from',
      out: z.array(ToolOut),
    },
    async (c) => {
      const actor = c.get('actor' as never) as Actor;
      if (actor.kind === 'user' && actor.role === 'member')
        throw new AdminError('forbidden', 'This needs an owner or an admin.');
      return [...options.tools.entries()]
        .map(([name, info]) => ({
          name,
          kind: info.kind,
          group: info.group,
          // The tools a composite reads: the panel warns when it is granted without them (P6-11).
          siblings: [...(COMPOSITE_SIBLINGS[name] ?? [])],
          // The declared worst-case request cost: the panel notes a tool a lower callBudget hides (P6-36).
          cost: DECLARED_COST.get(name) ?? 0,
        }))
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

/** The host of an instance address, for audit rows (never the path or query); empty when it does not parse. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return '';
  }
}

function found<T>(row: T | null, what: string): T {
  if (row === null) throw new AdminError('not_found', `No ${what} with this id.`);
  return row;
}
