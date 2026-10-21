// SPDX-License-Identifier: Apache-2.0
// The admin REST API `/api/admin/v1/*` (P2-09): everything an operator manages, validated (OpenAPI + zod), guarded per
// actor (`guardedServices`, L-065), audited, and never returning a secret (tokens are shown once, credentials only as a
// hint). Without an admin authenticator the whole API is 404.
import {
  type AccessServices,
  type Actor,
  type AdminTokenVerifier,
  bearerToken,
  guardedServices,
  type ToolInfo,
} from '@agility-bridge/auth';
import type { Clock, Logger } from '@agility-bridge/core';
import type { AccessToken, AuditKind, AuditStatus, Credential, Storage } from '@agility-bridge/storage';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { RequestLimits } from '../app.ts';
import type { AuditWriter } from '../audit.ts';
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
  /** Who is calling; `null` = not authenticated. The break-glass token today, admin sessions from P4-02. */
  readonly authenticate: (c: Context) => Promise<Actor | null>;
  readonly limits?: RequestLimits;
  readonly clientIp: (c: Context) => string;
  readonly logger: Logger;
  readonly clock: Clock;
  /** Recorded in admin audit rows: `api` (default) or `cli` for the in-process local client (P2-10). */
  readonly via?: string;
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
  from: z.coerce.number().int().min(0).optional(),
  to: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(1_000).optional(),
  afterTs: z.coerce.number().int().min(0).optional(),
  afterId: z.string().max(128).optional(),
});

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
}

const ERROR_RESPONSES = Object.fromEntries(
  [400, 401, 403, 404, 409, 413, 415, 422, 429, 502, 503].map((s) => [
    s,
    { content: { 'application/json': { schema: ErrorOut } }, description: 'Error' },
  ]),
);

export function createAdminApi(options: AdminApiOptions): OpenAPIHono {
  const api = new OpenAPIHono({
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
    const actor = await options.authenticate(c);
    if (actor === null) {
      if ((await options.limits?.failuresExhausted?.(ip, now)) === true) {
        return c.json(errorBody('rate_limited', 'Too many failed attempts.'), 429, { 'retry-after': '300' });
      }
      await options.limits?.onAuthFailure?.(ip, now);
      options.audit.request({
        requestId: c.get('requestId' as never) ?? '',
        ip,
        slug: '(admin)',
        status: 401,
        durationMs: 0,
        mcp: null,
        access: null,
        refusal: 'admin_unauthenticated',
      });
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
      { storage: options.storage, tools: options.tools },
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
    });
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
      security: [{ bearer: [] }],
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
          auditRow(c, spec, 'ok', target, { fields: Object.keys(body).filter((k) => k !== 'token') });
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
    (c, { id, body }) => services(c).users.update(id, body as never),
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
    (c, { id }) => services(c).users.disable(id),
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

  add(
    {
      method: 'get',
      path: '/audit',
      tag: 'audit',
      summary: 'Read the audit log (newest first)',
      query: AuditQuery,
      out: z.array(AuditOut),
    },
    async (c, { query }) => {
      const actor = c.get('actor' as never) as Actor;
      if (actor.kind === 'user' && actor.role === 'member')
        throw new AdminError('forbidden', 'This needs an owner or an admin.');
      const q = query as z.infer<typeof AuditQuery>;
      return options.storage.audit.query({
        ...(q.workspaceId === undefined ? {} : { workspaceId: q.workspaceId }),
        ...(q.userId === undefined ? {} : { userId: q.userId }),
        ...(q.kind === undefined ? {} : { kind: q.kind as AuditKind }),
        ...(q.status === undefined ? {} : { status: q.status as AuditStatus }),
        ...(q.from === undefined ? {} : { from: q.from }),
        ...(q.to === undefined ? {} : { to: q.to }),
        ...(q.limit === undefined ? {} : { limit: q.limit }),
        ...(q.afterTs !== undefined && q.afterId !== undefined
          ? { after: { ts: q.afterTs, id: q.afterId } }
          : {}),
      });
    },
  );

  api.openAPIRegistry.registerComponent('securitySchemes', 'bearer', { type: 'http', scheme: 'bearer' });
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
