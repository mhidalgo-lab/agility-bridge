// SPDX-License-Identifier: Apache-2.0
// P0-08 spike: one runtime-agnostic fetch app that is both the OAuth 2.1 authorization server and the protected
// resource for N workspaces (/w/{slug}/mcp). Runs under workerd (worker.ts) and Node (node.ts).
//
// Differences from relic-bridge's spike (which this starts from):
// - the workspace list lives in storage (KV), never in isolate memory, so every isolate sees the same list (L-086);
// - an unknown workspace gets the same 401 challenge as a missing or invalid token (THREAT_MODEL T19);
// - adding a workspace at runtime needs the SPIKE_ADMIN secret, so a deployed copy cannot be modified by anyone else.
import {
  AuthorizationError,
  type AuthRequest,
  OAuthAuthorizationServer,
  OAuthResourceServer,
} from '@cloudflare/workers-oauth-provider';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';

export interface Env {
  OAUTH_KV: KVNamespace;
  /** Spike-only admin secret for POST /_spike/workspaces (unset: the endpoint is disabled). */
  SPIKE_ADMIN?: string;
}

/** What /authorize stores with the grant; encrypted by the provider, handed back as ctx.props. */
export interface GrantProps {
  userId: string;
  workspace: string;
  grantId: string;
}

const SCOPES = ['mcp:read', 'offline_access'];
const WORKSPACES_KEY = 'spike:workspaces';
const SEED = ['team', 'ops'];
const SLUG = /^[a-z0-9-]{1,32}$/;

/** The workspace list from storage (one KV read per request), seeded on first use. */
export async function workspaces(env: Env): Promise<string[]> {
  const stored = await env.OAUTH_KV.get<string[]>(WORKSPACES_KEY, 'json');
  if (stored) return stored;
  await env.OAUTH_KV.put(WORKSPACES_KEY, JSON.stringify(SEED));
  return SEED;
}

const resourceUrl = (origin: string, slug: string): string => `${origin}/w/${slug}/mcp`;

export interface AppOptions {
  /** CIMD needs the Workers `global_fetch_strictly_public` flag (SSRF protection); off on Node unless shimmed. */
  cimd: boolean;
}

function buildAuthorizationServer(
  origin: string,
  slugs: string[],
  options: AppOptions,
): OAuthAuthorizationServer<Env> {
  return new OAuthAuthorizationServer<Env>({
    issuer: origin,
    resources: slugs.map((slug) => resourceUrl(origin, slug)),
    scopesSupported: SCOPES,
    clientIdMetadataDocumentEnabled: options.cimd,
    clientRegistrationEndpoint: '/oauth/register',
    accessTokenTTL: 3600,
  });
}

function buildMcpServer(props: GrantProps): McpServer {
  const server = new McpServer({ name: 'agility-bridge-spike-oauth', version: '0.0.0' });
  server.registerTool(
    'whoami',
    {
      description: 'Show the workspace and grant this token is bound to.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => ({
      content: [{ type: 'text', text: JSON.stringify({ workspace: props.workspace, grant: props.grantId }) }],
    }),
  );
  return server;
}

function buildResourceServer(
  origin: string,
  slug: string,
  as: OAuthAuthorizationServer<Env>,
): OAuthResourceServer<Env, GrantProps> {
  return new OAuthResourceServer<Env, GrantProps>({
    resourceMetadata: { resource: resourceUrl(origin, slug), authorization_servers: [origin] },
    requiredScopes: ['mcp:read'],
    validateToken: (env) => (resource, token) => as.validateToken(resource, token, env),
    handler: {
      async fetch(request, _env, ctx) {
        // Defence in depth: the provider already rejected tokens whose audience is not this resource.
        if (ctx.props.workspace !== slug) return new Response('grant/workspace mismatch', { status: 403 });
        const mcp = createMcpHandler(() => buildMcpServer(ctx.props), { legacy: 'stateless' });
        return mcp.fetch(request, {
          authInfo: { token: ctx.auth.token, clientId: ctx.auth.clientId ?? '', scopes: ctx.auth.scope },
        });
      },
    },
  });
}

/** The same 401 a missing token gets at a real workspace: an unknown workspace is indistinguishable (T19). */
function unknownWorkspaceChallenge(origin: string, slug: string): Response {
  return new Response('Unauthorized', {
    status: 401,
    headers: {
      'www-authenticate': `Bearer realm="OAuth", resource_metadata="${origin}/.well-known/oauth-protected-resource/w/${slug}/mcp", scope="mcp:read"`,
    },
  });
}

/** Spike consent: auto-approves and binds the grant to the workspace named by the RFC 8707 `resource`. */
async function authorize(
  request: Request,
  env: Env,
  as: OAuthAuthorizationServer<Env>,
  slugs: string[],
): Promise<Response> {
  const oauth = as.getOAuthApi(env);
  let authRequest: AuthRequest;
  try {
    authRequest = await oauth.parseAuthRequest(request);
  } catch (error) {
    if (!(error instanceof AuthorizationError)) {
      // CIMD fetch failures and other client-metadata problems: a 400, not a 500 (relic-bridge finding 3).
      return new Response(`authorization error: ${(error as Error).name}`, { status: 400 });
    }
    if (error.redirectTo) return Response.redirect(error.redirectTo, 302);
    return new Response(`authorization error: ${error.description ?? error.code}`, { status: 400 });
  }
  const resource = new URL(authRequest.resource ?? 'http://invalid/');
  const slug = /^\/w\/([a-z0-9-]+)\/mcp$/.exec(resource.pathname)?.[1];
  if (!slug || !slugs.includes(slug)) return new Response('unknown workspace', { status: 400 });
  const userId = 'spike-user';
  const { redirectTo } = await oauth.completeAuthorization({
    request: authRequest,
    userId,
    metadata: { workspace: slug },
    scope: authRequest.scope.filter((s) => SCOPES.includes(s)),
    props: { userId, workspace: slug, grantId: `grant-${slug}-${crypto.randomUUID().slice(0, 8)}` },
  });
  return Response.redirect(redirectTo, 302);
}

async function addWorkspace(request: Request, env: Env): Promise<Response> {
  if (!env.SPIKE_ADMIN || request.headers.get('x-spike-admin') !== env.SPIKE_ADMIN) {
    return new Response('forbidden', { status: 403 });
  }
  const { slug } = (await request.json()) as { slug?: string };
  if (!slug || !SLUG.test(slug)) return new Response('bad slug', { status: 400 });
  const current = await workspaces(env);
  const next = current.includes(slug) ? current : [...current, slug];
  await env.OAUTH_KV.put(WORKSPACES_KEY, JSON.stringify(next));
  return Response.json({ workspaces: next });
}

export async function handle(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  options: AppOptions = { cimd: true },
): Promise<Response> {
  const url = new URL(request.url);
  const origin = url.origin;
  const slugs = await workspaces(env);
  const as = buildAuthorizationServer(origin, slugs, options);

  if (url.pathname === '/authorize') return authorize(request, env, as, slugs);
  if (url.pathname === '/_spike/workspaces' && request.method === 'POST') return addWorkspace(request, env);

  const m = /^(\/\.well-known\/oauth-protected-resource)?\/w\/([a-z0-9-]+)\/mcp(?:\/.*)?$/.exec(url.pathname);
  if (m?.[2]) {
    if (!slugs.includes(m[2])) {
      return m[1] ? new Response('not found', { status: 404 }) : unknownWorkspaceChallenge(origin, m[2]);
    }
    return buildResourceServer(origin, m[2], as).fetch(request, env, ctx);
  }
  // Discovery (RFC 8414), token, registration (RFC 7591), revocation (RFC 7009).
  return as.fetch(request, env, ctx);
}
