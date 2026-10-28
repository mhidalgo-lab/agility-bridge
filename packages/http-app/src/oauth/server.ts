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
  DENY_CLASS,
  type DenyReason,
  type EffectiveAccess,
  isRecoverableDeny,
  loadAccessRecords,
  resolveAccess,
} from '@agility-bridge/auth';
import type { Clock, Logger } from '@agility-bridge/core';
import { SLUG_RE, type Storage } from '@agility-bridge/storage';
import type {
  AuthRequest,
  ClientInfo,
  GrantSummary,
  OAuthAuthorizationServer,
  OAuthHelpers,
  AuthorizationError as ProviderAuthorizationError,
  TokenExchangeCallbackOptions,
  TokenExchangeCallbackResult,
} from '@cloudflare/workers-oauth-provider';
import type { Context } from 'hono';
import type { OAuthEvent } from '../audit.ts';
import { addressKey } from '../rate-limit.ts';
import { type AbuseRefusal, type AbuseSurface, createAbuseGuard } from './abuse.ts';
import {
  ClientMetadataError,
  type ClientMetadataFetch,
  checkRegistration,
  clientIdUrlProblem,
  fetchMetadataDocument,
  looksLikeClientIdUrl,
} from './clients.ts';
import {
  CLIENT_RECORD_PREFIX,
  DOCUMENT_CLIENT_PREFIX,
  isUnusedRegistration,
  sweepRegistrations,
} from './housekeeping.ts';
import { OAUTH_KV_PREFIX, type OAuthKvNamespace, oauthKvNamespace } from './kv-namespace.ts';
import {
  CLAIM_PREFIX,
  openSuccessor,
  ROTATED_PREFIX,
  requestClientId,
  SUCCESSOR_PREFIX,
  sealSuccessor,
} from './refresh-family.ts';

export const OAUTH_AUTHORIZE_PATH = '/oauth/authorize';
export const OAUTH_TOKEN_PATH = '/oauth/token';
export const OAUTH_REGISTER_PATH = '/oauth/register';
/** RFC 8414 metadata of an issuer without a path. */
export const OAUTH_METADATA_PATH = '/.well-known/oauth-authorization-server';
/** RFC 9728 §3.1: the well-known prefix is inserted before the resource's path (`…/w/{slug}/mcp`). */
export const OAUTH_RESOURCE_METADATA_PREFIX = '/.well-known/oauth-protected-resource';

/** The scope every MCP token carries (read-only tools). Grants, not scopes, decide what a token may do. */
export const MCP_SCOPE = 'mcp:read';
export const OAUTH_SCOPES: readonly string[] = Object.freeze([MCP_SCOPE, 'offline_access']);

export const DEFAULT_OAUTH_ACCESS_TTL_S = 3600;
export const DEFAULT_OAUTH_REFRESH_TTL_S: number = 30 * 86_400;
/** A spent refresh token presented again within this many seconds gets the same successor (P5-05, D-63); later revokes. */
export const DEFAULT_OAUTH_REFRESH_REUSE_WINDOW_S = 30;
export const MAX_OAUTH_REFRESH_REUSE_WINDOW_S = 120;
/** One refresh token is spent by one request at a time; the claim of a request that died frees itself after this. */
const REFRESH_CLAIM_TTL_MS = 15_000;
/** A request that finds its token being spent waits for the result: up to about 40 polls, 10 to 250 ms apart. */
const REFRESH_WAIT_POLLS = 40;
/** `Retry-After` of a recoverable issuance refusal (P5-21): about one access-cache lifetime. */
const RECOVERABLE_RETRY_AFTER_S = 60;

/** A refusal of an issuance that can pass: the device is kept (ADR-0018). Final reasons, and ones that are not access reasons, are not. */
const isRecoverableRefusal = (reason: string): boolean =>
  Object.hasOwn(DENY_CLASS, reason) && isRecoverableDeny(reason as DenyReason);
/** How long an authorization code may wait for its exchange (the provider's own grant TTL is the same). */
export const OAUTH_CODE_TTL_S = 600;
/** Largest token or registration request body read. */
export const OAUTH_MAX_BODY_BYTES: number = 16 * 1024;
/** A dynamic registration that exchanges nothing lives this long at least (renewed by the provider on use). */
export const OAUTH_MIN_REGISTRATION_TTL_S: number = 90 * 86_400;

/** Most OAuth devices (approved apps) one person holds; the list, "disconnect all" and the cap are the same bound. */
export const MAX_OAUTH_DEVICES_PER_USER = 25;
/** Longest device name a person can give an app on the consent screen. */
export const MAX_DEVICE_LABEL_CHARS = 60;
const DEVICE_LABEL_FORBIDDEN_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
/** Held while one approval counts a person's devices and inserts its grant (`oauth-approving:<user>`). */
const APPROVAL_LOCK_PREFIX = 'oauth-approving:';
const APPROVAL_LOCK_MS = 15_000;
/** Pages of grants read for one person's devices (the cap keeps the real number far below). */
const MAX_DEVICE_PAGES = 6;

/** A device name as stored: trimmed plain text of at most {@link MAX_DEVICE_LABEL_CHARS}, or null when it is not one. */
export function deviceLabel(text: string): string | null {
  const t = text.trim();
  return t === '' || t.length > MAX_DEVICE_LABEL_CHARS || DEVICE_LABEL_FORBIDDEN_RE.test(t) ? null : t;
}
/** A registration that exchanges nothing lives this long (the first token exchange renews it, D-68). Settable. */
export const OAUTH_DEFAULT_UNUSED_REGISTRATION_TTL_S = 86_400;
/** Dynamic registrations alive at once, per deployment (the cap P5-09 tunes). Settable. */
export const OAUTH_DEFAULT_DCR_MAX_CLIENTS = 200;
/** Dynamic registrations one address may make per hour. Settable. */
export const OAUTH_DEFAULT_DCR_IP_LIMIT = 10;
/** Stored metadata-document clients at once (each lives 5 min to 24 h). Settable. */
export const OAUTH_DEFAULT_CIMD_MAX_CLIENTS = 200;
/** Metadata-document fetches one address may cause per hour (cache misses only). Settable. */
export const OAUTH_DEFAULT_CIMD_FETCH_LIMIT = 20;
/** Registrations the whole deployment accepts per hour (a bound on storage churn, T11). Settable. */
export const OAUTH_DEFAULT_DCR_HOURLY_LIMIT = 100;
/** Metadata-document fetches the whole deployment makes per hour (outbound budget, T11). Settable. */
export const OAUTH_DEFAULT_CIMD_HOURLY_LIMIT = 200;
/** Authorization requests per address, and in all, per 10 minutes (P5-09). Settable. */
export const OAUTH_DEFAULT_AUTHORIZE_IP_LIMIT = 30;
export const OAUTH_DEFAULT_AUTHORIZE_LIMIT = 600;
/** Consent form posts per address, and in all, per 10 minutes. Settable. */
export const OAUTH_DEFAULT_CONSENT_IP_LIMIT = 30;
export const OAUTH_DEFAULT_CONSENT_LIMIT = 300;
/** Failed token requests per address, and in all (counted against addresses that already failed), per 10 minutes. */
export const OAUTH_DEFAULT_TOKEN_FAILURE_IP_LIMIT = 20;
export const OAUTH_DEFAULT_TOKEN_FAILURE_LIMIT = 300;
/** Window of the interactive-endpoint limits above. */
const ABUSE_WINDOW_S = 600;
/** Counter windows of the registration and fetch limits. */
const CAP_WINDOW_S = 3600;
/** `kv` keys outside the provider's `oauth:` namespace: per-address counters (hashed address) and cap-audit markers. */
const DCR_IP_PREFIX = 'oauth-dcr-ip:';
const CIMD_IP_PREFIX = 'oauth-cimd-ip:';
const CAP_AUDIT_PREFIX = 'oauth-cap-audit:';
/** Most keys one `kv.list` returns (the store's own cap). */
const KV_LIST_MAX = 1000;
/**
 * At the live-registration cap (P5-10): an unused registration older than this makes room for a new one (the sweep that
 * finds it looks at {@link CAP_PRESSURE_SLICE} records, a Free-plan request has 50 D1 queries, L-097). A registration is
 * used within minutes of being made, so one hour unused is abandoned or a flood.
 */
const CAP_PRESSURE_UNUSED_S = 3600;
const CAP_PRESSURE_SLICE = 10;

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
  /**
   * `metadata_document`: the client id is the https URL of a document we fetched (CIMD); the host vouches for the name
   * (show {@link clientHost}). `dynamic`: registered through RFC 7591: nothing about it was verified (say so).
   */
  readonly clientKind: 'metadata_document' | 'dynamic';
  /** CIMD: the host of the client id; null for dynamic clients. */
  readonly clientHost: string | null;
}

/** An app a person approved: one provider grant (client + user + workspace). Text fields are untrusted. */
export interface OAuthDevice {
  /** The provider's grant id (16 URL-safe characters). */
  readonly id: string;
  readonly clientId: string;
  readonly clientName: string | null;
  /** Host of the redirect URI the app was approved for. */
  readonly redirectHost: string;
  readonly workspaceId: string | null;
  /** The device name typed on the consent screen. */
  readonly label: string | null;
  /** Epoch ms. */
  readonly createdAt: number;
  /** Epoch ms, or null. */
  readonly expiresAt: number | null;
  /** Epoch ms of the last token issuance or MCP request (to within about 5 minutes); null when not seen yet (P5-14). */
  readonly lastUsedAt: number | null;
}

/** A device of any person, for the administrators' list (P5-08). */
export interface OAuthAdminDevice extends OAuthDevice {
  readonly userId: string;
}

/** One page of every person's devices; `next` is the cursor of the following page. */
export interface OAuthDevicePage {
  readonly devices: readonly OAuthAdminDevice[];
  readonly next: string | null;
}

/** A registered client (a dynamic registration or a stored metadata document), for the owners' list (P5-08). Text is untrusted. */
export interface OAuthClientSummary {
  readonly clientId: string;
  readonly kind: 'dynamic' | 'metadata_document';
  readonly name: string | null;
  readonly redirectHosts: readonly string[];
  /** Epoch ms, or null when the record carries no date. */
  readonly createdAt: number | null;
  /** The newest approval among the devices counted, epoch ms; null when none was counted. */
  readonly lastApprovedAt: number | null;
  /** Devices counted (see {@link OAuthClientPage.devicesTruncated}); null when the count could not be made. */
  readonly devices: number | null;
}

/** A client an owner revoked: its id stays refused until it is restored (metadata documents) or its tokens have all expired (dynamic). */
export interface OAuthBlockedClient {
  readonly clientId: string;
  readonly kind: 'dynamic' | 'metadata_document';
  readonly name: string | null;
  readonly at: number;
}

export interface OAuthClientPage {
  readonly clients: readonly OAuthClientSummary[];
  readonly blocked: readonly OAuthBlockedClient[];
  readonly next: string | null;
  /** More devices exist than were read, so the counts are lower bounds. */
  readonly devicesTruncated: boolean;
}

export interface OAuthClientRevocation {
  /** Devices ended now. */
  readonly devices: number;
  /** False when more grants exist than one call reads: the client is refused anyway, press revoke again to end the rest. */
  readonly complete: boolean;
}

export type OAuthApproval =
  | { readonly ok: true; readonly redirectTo: string; readonly scope: readonly string[] }
  | { readonly ok: false; readonly reason: DenyReason | 'principal_mismatch' | 'device_limit' | 'busy' };

/** One of a person's grants on the requested workspace that an app could be given (it resolves right now). */
export interface OAuthGrantOption {
  readonly id: string;
  readonly label: string | null;
  /** Tool names of the effective access (read-only: writes are off for OAuth). */
  readonly tools: readonly string[];
  readonly projectCount: number;
  /** Epoch ms the access ends, or null. */
  readonly expiresAt: number | null;
}

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
  /**
   * The person's own grants on the requested workspace that resolve now, for the consent form to offer. Empty for a
   * workspace that does not exist, so an unknown slug and a missing grant look the same (no slug probing, T19).
   */
  grants(userId: string): Promise<{
    readonly workspaceName: string | null;
    readonly options: readonly OAuthGrantOption[];
  }>;
  approve(input: {
    readonly userId: string;
    readonly grantId: string;
    /** The device name (already checked with {@link deviceLabel}). */
    readonly label?: string | null;
  }): Promise<OAuthApproval>;
  /** The `access_denied` redirect (with `state` and `iss`). `userId`: who denied, for the audit row. */
  deny(description?: string, userId?: string): string;
  /** A redirect to the validated redirect URI with another error (`login_required`, `consent_required`; `state`, `iss`). */
  refuse(error: 'login_required' | 'consent_required' | 'invalid_request', description: string): string;
}

/** The interactive step of `/oauth/authorize` (P5-04: sign-in, grant choice, consent). */
export type OAuthConsentHandler = (c: Context, api: OAuthConsentApi) => Response | Promise<Response>;

/** `createHttpApp({ oauth })`: the issuer is the app's public URL. */
export interface OAuthOptions {
  /**
   * The interactive step of `/oauth/authorize`. Absent: the built-in sign-in and consent screen (P5-04), which needs
   * sign-in to be configured (`identity`). Tests inject a stand-in.
   */
  readonly consent?: OAuthConsentHandler;
  /** Access-token lifetime in seconds, 60-86400. Default 3600. Capped at the grant's expiry. */
  readonly accessTokenTtlSeconds?: number;
  /** Absolute refresh lifetime in seconds, 3600-31536000. Default 30 days. Capped at the grant's expiry. */
  readonly refreshTokenTtlSeconds?: number;
  /**
   * Client ID Metadata Documents (P5-03): fetched through this guarded fetcher (it must refuse non-public destinations and
   * not follow redirects). Absent = off: URL client ids are refused and the metadata says so.
   */
  readonly clientMetadataFetch?: ClientMetadataFetch;
  /** `false` turns CIMD off even when the host has a fetcher (`AB_OAUTH_CIMD=off`). */
  readonly clientMetadataDocuments?: boolean;
  /** Stored document clients at once. Default {@link OAUTH_DEFAULT_CIMD_MAX_CLIENTS}; 1-500. */
  readonly clientMetadataMaxClients?: number;
  /** When set, a metadata-document client id must have exactly one of these hosts (P5-16); anything else is refused before any fetch. */
  readonly clientMetadataHosts?: readonly string[];
  /** Fetches one address may cause per hour. Default {@link OAUTH_DEFAULT_CIMD_FETCH_LIMIT}. */
  readonly clientMetadataFetchLimit?: number;
  /** Fetches the whole deployment may make per hour. Default {@link OAUTH_DEFAULT_CIMD_HOURLY_LIMIT}. */
  readonly clientMetadataHourlyLimit?: number;
  /** RFC 7591 registration at `/oauth/register`; `false` = off (404, no `registration_endpoint`). Default on (D-68). */
  readonly registration?: boolean;
  /** Live dynamic registrations at once. Default {@link OAUTH_DEFAULT_DCR_MAX_CLIENTS}; 1-500. */
  readonly registrationMaxClients?: number;
  /** Registrations one address may make per hour. Default {@link OAUTH_DEFAULT_DCR_IP_LIMIT}. */
  readonly registrationIpLimit?: number;
  /** Registrations the whole deployment accepts per hour. Default {@link OAUTH_DEFAULT_DCR_HOURLY_LIMIT}. */
  readonly registrationHourlyLimit?: number;
  /** Per 10 minutes: authorization requests (`authorizeIpLimit` per address, `authorizeLimit` in all). */
  readonly authorizeIpLimit?: number;
  readonly authorizeLimit?: number;
  /** Per 10 minutes: consent form posts. */
  readonly consentIpLimit?: number;
  readonly consentLimit?: number;
  /** Per 10 minutes: failed token requests (the deployment-wide one only turns away addresses that already failed). */
  readonly tokenFailureIpLimit?: number;
  readonly tokenFailureLimit?: number;
  /** When set, `https` redirect hosts of a dynamic client must be on this list (loopback always allowed). */
  readonly registrationRedirectHosts?: readonly string[];
  /** Lifetime of a registration that never exchanged a code, seconds (1 h - 7 d). Default 24 h. */
  readonly registrationUnusedTtlSeconds?: number;
  /**
   * Seconds in which a refresh token that was just spent is answered with the same successor again (parallel refreshes,
   * a lost response), 0-120, not longer than the access lifetime. Default 30; 0 = strict single use. A repeat after the
   * window revokes the device (P5-05).
   */
  readonly refreshReuseWindowSeconds?: number;
  /**
   * Seconds without a token issuance or MCP request after which a device is refused at its next refresh (and so ends),
   * 3600-31536000. Default: off (P5-14).
   */
  readonly idleTtlSeconds?: number;
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
 * When a device was last used, `oauth-used:<userId>:<grantId>` = epoch ms and nothing else (P5-14, T25). Written at a
 * token issuance and at an MCP request, at most once per {@link USED_WRITE_INTERVAL_MS} per device and process.
 */
const USED_PREFIX = 'oauth-used:';
/** The operator's abuse view reads this window of refusal rows, at most this many of each kind (P5-20). */
const ABUSE_VIEW_WINDOW_MS = 24 * 3_600_000;
const ABUSE_VIEW_ROWS = 1000;
const USED_WRITE_INTERVAL_MS = 5 * 60_000;
/** Devices whose last write this process remembers; cleared when full (a repeat write is harmless). */
const USED_THROTTLE_MAX = 2000;
/**
 * Revoked device tombstones, `oauth-revoked:<userId>:<grantId>`: written before a device is revoked, so a token
 * request the provider was answering at that moment (it reads the grant, then writes it back) cannot bring the device
 * back: the token endpoint looks for the tombstone after the provider answered and revokes again.
 */
const TOMBSTONE_PREFIX = 'oauth-revoked:';
/**
 * Revoked clients, `oauth-client-blocked:<sha-256 of the client id>` (P5-08): written before anything else is ended, so a
 * half-finished revocation never leaves the client usable. Authorization, every token request and every MCP request
 * of a blocked client is refused. A dynamic client's block expires once every token it could hold has (its record is
 * deleted, and a new registration is a new id, D-74); a metadata document's block stays until an owner restores it.
 */
const CLIENT_BLOCK_PREFIX = 'oauth-client-blocked:';
/** Grants one client revocation reads (each is a storage read); the block makes the rest refused anyway. */
const CLIENT_REVOKE_SCAN_MAX = 1000;
/** Grants read to count devices per client on the owners' list (a Free-plan request has 50 D1 queries, L-097). */
const CLIENT_COUNT_SCAN_MAX = 100;
const CLIENT_PAGE_DEFAULT = 10;
const CLIENT_PAGE_MAX = 25;
const BLOCKED_LIST_MAX = 20;
const DEVICE_PAGE_DEFAULT = 10;
const DEVICE_PAGE_MAX = 50;
/** `userId:grantId` as the device list's cursor and a grant key's tail. */
const GRANT_TAIL_RE = /^([A-Za-z0-9_-]{1,128}):([A-Za-z0-9_-]{16})$/;
const CLIENT_ID_KEY_RE = /^[\x21-\x7e]{1,512}$/;
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

/** A uniform integer in `[0, n)` from the platform's random source. */
function randomBelow(n: number): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buffer = new Uint32Array(1);
  do crypto.getRandomValues(buffer);
  while ((buffer[0] as number) >= limit);
  return (buffer[0] as number) % n;
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
  readonly options: Omit<OAuthOptions, 'consent'> & { readonly consent: OAuthConsentHandler };
  /** Issuer origin (`https://bridge.example.com`), from the configured public URL. */
  readonly issuer: string;
  readonly storage: Storage;
  readonly access: AccessSettings;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly runInBackground: (c: Context, task: Promise<unknown>, what: string) => void;
  /** Drop cached access decisions (a device was disconnected: it must stop working at once). */
  readonly onRevocation?: () => void;
  /** The caller's address, for the per-address registration and fetch limits (hashed before it is stored). */
  readonly clientIp: (c: Context) => string;
  /** `auth` audit rows; never rejects. Called for every OAuth event, with no secret in it. */
  readonly audit?: (event: OAuthEvent) => unknown;
}

/** One app's OAuth server: the route handlers and the MCP-route token check. Holds configuration and caches only. */
export interface OAuthRuntime {
  readonly issuer: string;
  /** The resource URL of a workspace slug. */
  resourceUrl(slug: string): string;
  /** RFC 9728 document URL of a workspace's resource. */
  resourceMetadataUrl(slug: string): string;
  /**
   * RFC 9728 protected resource metadata for `/w/{slug}/mcp`, from the path alone: the same document shape for a known,
   * unknown and disabled workspace (T19). `null` when the slug is not valid slug syntax (the caller answers 404).
   */
  resourceMetadata(slug: string): Response | null;
  /**
   * The `WWW-Authenticate` challenge of a `401` on `/w/{slug}/mcp`: a function of the slug's syntax only, so no denial
   * tells a known workspace from an unknown one or a missing token from a wrong one. Plain `Bearer` for a slug that is
   * not valid syntax.
   */
  challenge(slug: string): string;
  metadata(c: Context): Promise<Response>;
  authorize(c: Context): Promise<Response>;
  /**
   * Validate an authorization request given as query parameters (the consent form re-validates the request it shows on
   * every step, P5-04): the error answer (400 page or error redirect), or the consent API for it.
   */
  prepare(c: Context, params: URLSearchParams): Promise<Response | OAuthConsentApi>;
  token(c: Context, onRevocation: () => void): Promise<Response>;
  register(c: Context): Promise<Response>;
  /**
   * Abuse controls at the route edge (P5-09): `run` is the endpoint; a refusal is `429` with `Retry-After` and `run` is
   * not called, so nothing is stored, fetched or read for it.
   */
  guard(
    surface: 'authorize' | 'consent' | 'token',
    c: Context,
    run: () => Promise<Response>,
  ): Promise<Response>;
  /** The apps this person approved (at most {@link MAX_OAUTH_DEVICES_PER_USER}), newest first. */
  devices(userId: string): Promise<OAuthDevice[]>;
  /**
   * Disconnect one of this person's apps: its access and refresh tokens stop working at once. False when the id is not
   * one of theirs. Audited (`oauth.device.revoke`).
   */
  revokeDevice(c: Context, userId: string, deviceId: string): Promise<boolean>;
  /** Disconnect every app of this person; the number disconnected. */
  revokeAllDevices(c: Context, userId: string): Promise<number>;
  /**
   * Every person's apps for the administrators (P5-08), in storage order, a page at a time (`after` is a previous
   * page's `next`). Reads at most `limit` grants (default 10, at most 50): each is a storage read.
   */
  allDevices(page: { readonly after?: string; readonly limit?: number }): Promise<OAuthDevicePage>;
  /**
   * An administrator ends one person's app (the caller has authorized it): tokens stop at once, audited
   * (`oauth.device.revoke`, `via: admin`, `by`). False when that person has no such device.
   */
  revokeDeviceFor(c: Context, userId: string, deviceId: string, by: string | null): Promise<boolean>;
  /** Registered clients and revoked ones, a page at a time (owners; the caller has authorized it). */
  clients(page: { readonly after?: string; readonly limit?: number }): Promise<OAuthClientPage>;
  /**
   * An owner revokes a client: blocks it first (no new authorization, no refresh, no access token passes), then ends
   * its devices and deletes its record. Null when no such client exists. Audited.
   */
  revokeClient(c: Context, clientId: string, by: string | null): Promise<OAuthClientRevocation | null>;
  /** The abuse limits, the registration caps against their use and the last day's refusals (owners; the caller has authorized it). */
  abuseOverview(): Promise<OAuthAbuseOverview>;
  /** Lifts a block (a metadata-document client may be used again); false when the client was not blocked. */
  restoreClient(c: Context, clientId: string, by: string | null): Promise<boolean>;
  /** Validate an OAuth bearer for `/w/{slug}/mcp` and resolve its access. Storage errors propagate (fail closed). */
  authenticate(token: string, slug: string): Promise<OAuthAuthentication>;
  /** Client registrations: counts and cleanup (the hooks P5-08 and P5-09 build on). */
  readonly registrations: OAuthRegistrations;
  /** Whether URL client ids are resolved (a guarded fetcher is present and CIMD is not switched off). */
  readonly clientMetadataDocuments: boolean;
}

/** One kind of limit refusal in the last 24 hours (P5-20): what the audit rows say, grouped. Never an address, client or token. */
export interface OAuthRefusalCount {
  readonly action: 'oauth.request.refused' | 'oauth.client.refused';
  /** The stable reason of the rows (`authorize_limit_address`, `client_cap`, ...). */
  readonly reason: string;
  /** The limit surface and scope for `oauth.request.refused`; null for the registration and fetch caps. */
  readonly surface: string | null;
  readonly scope: string | null;
  /** `dynamic` or `metadata_document` where the row says so. */
  readonly kind: string | null;
  /** Audit rows: a limit is recorded once per window it is reached in, so this counts windows, not requests. */
  readonly count: number;
  /** Epoch ms of the newest row. */
  readonly lastAt: number;
}

/** The OAuth abuse controls as configured, how full the registration caps are, and the refusals of the last 24 hours (P5-20). */
export interface OAuthAbuseOverview {
  readonly registrations: {
    readonly dynamic: { readonly enabled: boolean; readonly live: number; readonly cap: number };
    readonly documents: { readonly enabled: boolean; readonly stored: number; readonly cap: number };
  };
  /** The configured limits (numbers only). */
  readonly limits: Readonly<Record<string, number>>;
  readonly windowHours: number;
  readonly refusals: readonly OAuthRefusalCount[];
  /** More refusal rows exist than were read: the counts are lower bounds. */
  readonly refusalsTruncated: boolean;
}

/** What is registered right now, and the cleanup that does not wait for the store's expiry purge. */
export interface OAuthRegistrations {
  /** Live dynamic registrations and stored document clients. */
  count(): Promise<{ readonly dynamic: number; readonly documents: number }>;
  /**
   * Deletes dynamic registrations that never exchanged a code and are older than the unused lifetime now configured
   * (their store expiry still reflects the lifetime they were registered under; a shorter `AB_OAUTH_DCR_UNUSED_TTL` applies
   * through this call) and returns how many. Bounded: reads at most 1,000 records per call.
   */
  sweep(): Promise<{ readonly removed: number }>;
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
  const reuseWindow = checkInt(
    'oauth.refreshReuseWindowSeconds',
    options.refreshReuseWindowSeconds ?? DEFAULT_OAUTH_REFRESH_REUSE_WINDOW_S,
    0,
    MAX_OAUTH_REFRESH_REUSE_WINDOW_S,
  );
  if (reuseWindow > accessTtl) {
    throw new RangeError('oauth.refreshReuseWindowSeconds must not exceed the access token lifetime');
  }
  const reuseWindowMs = reuseWindow * 1000;
  const idleTtlMs =
    options.idleTtlSeconds === undefined
      ? null
      : checkInt('oauth.idleTtlSeconds', options.idleTtlSeconds, 3_600, 365 * 86_400) * 1000;
  if (typeof options.consent !== 'function') throw new TypeError('oauth.consent must be a function');
  const consent = options.consent;
  const onRevocation = deps.onRevocation ?? (() => undefined);
  const registrationEnabled = options.registration !== false;
  const dcrMaxClients = checkInt(
    'oauth.registrationMaxClients',
    options.registrationMaxClients ?? OAUTH_DEFAULT_DCR_MAX_CLIENTS,
    1,
    500,
  );
  const dcrIpLimit = checkInt(
    'oauth.registrationIpLimit',
    options.registrationIpLimit ?? OAUTH_DEFAULT_DCR_IP_LIMIT,
    1,
    10_000,
  );
  const limit = (name: string, value: number | undefined, fallback: number): number =>
    checkInt(`oauth.${name}`, value ?? fallback, 1, 100_000);
  const dcrHourlyLimit = limit(
    'registrationHourlyLimit',
    options.registrationHourlyLimit,
    OAUTH_DEFAULT_DCR_HOURLY_LIMIT,
  );
  const cimdHourlyLimit = limit(
    'clientMetadataHourlyLimit',
    options.clientMetadataHourlyLimit,
    OAUTH_DEFAULT_CIMD_HOURLY_LIMIT,
  );
  const authorizeIpLimit = limit(
    'authorizeIpLimit',
    options.authorizeIpLimit,
    OAUTH_DEFAULT_AUTHORIZE_IP_LIMIT,
  );
  const authorizeLimit = limit('authorizeLimit', options.authorizeLimit, OAUTH_DEFAULT_AUTHORIZE_LIMIT);
  const consentIpLimit = limit('consentIpLimit', options.consentIpLimit, OAUTH_DEFAULT_CONSENT_IP_LIMIT);
  const consentLimit = limit('consentLimit', options.consentLimit, OAUTH_DEFAULT_CONSENT_LIMIT);
  const tokenFailureIpLimit = limit(
    'tokenFailureIpLimit',
    options.tokenFailureIpLimit,
    OAUTH_DEFAULT_TOKEN_FAILURE_IP_LIMIT,
  );
  const tokenFailureLimit = limit(
    'tokenFailureLimit',
    options.tokenFailureLimit,
    OAUTH_DEFAULT_TOKEN_FAILURE_LIMIT,
  );
  const unusedRegistrationTtl = checkInt(
    'oauth.registrationUnusedTtlSeconds',
    options.registrationUnusedTtlSeconds ?? OAUTH_DEFAULT_UNUSED_REGISTRATION_TTL_S,
    3_600,
    7 * 86_400,
  );
  const redirectHosts = options.registrationRedirectHosts?.map((h) => {
    const host = h.trim().toLowerCase();
    if (!/^[a-z0-9.-]{1,253}$/.test(host))
      throw new TypeError('oauth.registrationRedirectHosts must be host names');
    return host;
  });
  const cimdMaxClients = checkInt(
    'oauth.clientMetadataMaxClients',
    options.clientMetadataMaxClients ?? OAUTH_DEFAULT_CIMD_MAX_CLIENTS,
    1,
    500,
  );
  const cimdFetchLimit = checkInt(
    'oauth.clientMetadataFetchLimit',
    options.clientMetadataFetchLimit ?? OAUTH_DEFAULT_CIMD_FETCH_LIMIT,
    1,
    10_000,
  );
  const cimdHosts = options.clientMetadataHosts?.map((h) => {
    const host = h.trim().toLowerCase();
    if (!/^[a-z0-9.-]{1,253}$/.test(host))
      throw new TypeError('oauth.clientMetadataHosts must be host names');
    return host;
  });
  const cimd =
    options.clientMetadataDocuments === false || options.clientMetadataFetch === undefined
      ? undefined
      : { fetch: options.clientMetadataFetch };
  const issuerHost = new URL(issuer).hostname;
  // A registration must outlive every refresh token issued to it: the provider renews it at half-life on each token
  // request, so twice the refresh lifetime is enough.
  const registrationTtl = Math.max(OAUTH_MIN_REGISTRATION_TTL_S, 2 * refreshTtl, 2 * accessTtl);
  const env: ProviderEnv = Object.freeze({ OAUTH_KV: oauthKvNamespace(storage.kv, () => clock.now()) });
  const resourceUrl = (slug: string): string => `${issuer}/w/${slug}/mcp`;
  const resourceMetadataUrl = (slug: string): string =>
    `${issuer}${OAUTH_RESOURCE_METADATA_PREFIX}/w/${slug}/mcp`;
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
      accessTokenTTL: accessTtl,
      refreshTokenTTL: refreshTtl,
      // Client ID Metadata Documents are resolved by us (`resolveClient`, an SSRF surface, L-088) and handed to the
      // provider as stored client records: its own fetcher follows redirects and needs the Workers flag.
      clientIdMetadataDocumentEnabled: false,
      ...(registrationEnabled ? { clientRegistrationEndpoint: OAUTH_REGISTER_PATH } : {}),
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

  const usedKey = (userId: string, grantId: string): string => `${USED_PREFIX}${userId}:${grantId}`;
  /** Device -> when this process last wrote its row: the throttle that keeps the MCP hot path free of storage writes. */
  const usedWritten = new Map<string, number>();
  /** Records that a device is in use (throttled unless `force`; a failure never fails the request it rides on). */
  const touchDevice = async (userId: string, grantId: string, force = false): Promise<void> => {
    const key = usedKey(userId, grantId);
    const at = clock.now();
    const last = usedWritten.get(key);
    if (!force && last !== undefined && at - last >= 0 && at - last < USED_WRITE_INTERVAL_MS) return;
    if (usedWritten.size >= USED_THROTTLE_MAX) usedWritten.clear();
    usedWritten.set(key, at);
    try {
      await storage.kv.set(key, String(at), { expiresAt: at + (refreshTtl + accessTtl) * 1000 });
    } catch (error) {
      usedWritten.delete(key);
      logger.warn('oauth device use not recorded', { error: (error as Error).name });
    }
  };
  /** When a device was last used; null when there is no row. */
  const lastUsed = async (userId: string, grantId: string): Promise<number | null> => {
    const raw = await storage.kv.get(usedKey(userId, grantId));
    const n = raw !== null && /^\d{1,16}$/.test(raw) ? Number(raw) : Number.NaN;
    return Number.isSafeInteger(n) ? n : null;
  };

  /**
   * Every token issuance (code exchange, refresh) re-runs the access decision for the grant the device was approved
   * with. A final refusal is `invalid_grant`, on which the provider revokes the device's grant (its whole token family);
   * a recoverable one (`DENY_CLASS`, ADR-0018) is `503 temporarily_unavailable` with `Retry-After` and keeps the device.
   * On success the access token (and, at the code exchange, the refresh lifetime) is capped at the grant's own expiry.
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
      const keep = isRecoverableRefusal(reason);
      logger.info(keep ? 'oauth token refused; device kept' : 'oauth token refused; device revoked', {
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
        details: { grantType: o.grantType, revoked: !keep },
      });
      if (keep) {
        throw new mod.OAuthError('temporarily_unavailable', {
          description: 'Access is unavailable right now; try again later.',
          statusCode: 503,
          headers: { 'Retry-After': String(RECOVERABLE_RETRY_AFTER_S) },
        });
      }
      throw new mod.OAuthError('invalid_grant', { description: 'The authorization is no longer valid.' });
    };
    // A revoked client gets nothing new, whatever its grants say (P5-08): refused here, the provider revokes the device.
    if (await isBlocked(o.clientId)) return refuse('client_revoked', null);
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
    // An idle device ends at its refresh, never at an authorization navigation (L-090); a device without a row is new
    // to this check and starts counting now.
    if (idleTtlMs !== null && !code) {
      const used = await lastUsed(o.userId, o.grantId);
      if (used !== null && clock.now() - used > idleTtlMs) return refuse('device_idle', props.workspaceId);
    }
    // A token request is not the hot path: it always records the use.
    await touchDevice(o.userId, o.grantId, true);
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

  // ------------------------------------------------------------------------------------------------ clients (P5-03)

  /**
   * The caller as the limits key it: an IPv6 address by its /64 network (one client holds a whole /64 and could rotate
   * addresses past every per-address limit, as for the general limiter; P5-10) and then hashed, so no address sits in
   * storage as written (an IPv4 hash can still be guessed back: keep these rows short-lived, T25).
   */
  const callerKey = async (c: Context): Promise<string> =>
    (await sha256Hex(addressKey(deps.clientIp(c)))).slice(0, 32);
  const hourWindow = (): number => Math.floor(clock.now() / 1000 / CAP_WINDOW_S);
  const secondsToWindowEnd = (window: number): number =>
    Math.max(1, (window + 1) * CAP_WINDOW_S - Math.floor(clock.now() / 1000));
  const rateLimited = (retryAfter: number, description: string): Response => {
    const response = jsonError(429, 'temporarily_unavailable', description);
    response.headers.set('Retry-After', String(retryAfter));
    return response;
  };
  /** Records a cap refusal once per window and reason: an anonymous flood must not become an audit-row flood (T20). */
  const auditCapOnce = async (c: Context, reason: string, event: OAuthEvent): Promise<void> => {
    const marker = `${CAP_AUDIT_PREFIX}${reason}:${hourWindow()}`;
    if (await storage.kv.setIfAbsent(marker, '1', { expiresAt: clock.now() + 2 * CAP_WINDOW_S * 1000 })) {
      audit(event, c);
    }
  };
  /** The abuse controls of the interactive and token endpoints and the deployment-wide registration and fetch budgets (P5-09). */
  const abuse = createAbuseGuard({
    kv: storage.kv,
    now: () => clock.now(),
    onError: (surface, error) =>
      logger.warn('oauth abuse limiter failed; allowing the request', {
        surface,
        error: (error as Error).name,
      }),
  });
  const SURFACE_REASON: Record<AbuseSurface, string> = {
    authorize: 'authorize_limit',
    consent: 'consent_limit',
    token_failure: 'token_failure_limit',
    registration: 'dcr_hourly_limit',
    metadata_fetch: 'fetch_hourly_limit',
  };
  /** Logs and audits a refusal once per window (the guard says which one is first), and answers it as `429`. */
  const refuseAbuse = (c: Context, refusal: AbuseRefusal): Response => {
    if (refusal.first) {
      logger.warn('oauth limit reached', {
        surface: refusal.surface,
        scope: refusal.scope,
        limit: refusal.limit,
      });
      audit(
        {
          action: 'oauth.request.refused',
          status: 'denied',
          requestId: requestIdOf(c),
          reason: `${SURFACE_REASON[refusal.surface]}_${refusal.scope}`,
          details: { surface: refusal.surface, scope: refusal.scope, limit: refusal.limit },
        },
        c,
      );
    }
    return rateLimited(refusal.retryAfterSeconds, 'Too many requests; retry later.');
  };
  /**
   * The route edge of `/oauth/authorize`, the consent post and `/oauth/token` (P5-09): authorization and consent take a
   * unit from the address and then the deployment before any work; a token request is turned away when the address (or,
   * for an address that already failed, the deployment) used up its failures, and a `4xx` answer counts as one.
   */
  const guard = async (
    surface: 'authorize' | 'consent' | 'token',
    c: Context,
    run: () => Promise<Response>,
  ): Promise<Response> => {
    const address = await callerKey(c);
    if (surface === 'token') {
      const spec = {
        surface: 'token_failure' as const,
        address,
        addressLimit: tokenFailureIpLimit,
        deploymentLimit: tokenFailureLimit,
        windowSeconds: ABUSE_WINDOW_S,
      };
      const blocked = await abuse.blocked(spec);
      if (blocked !== null) return refuseAbuse(c, blocked);
      const response = await run();
      if (response.status >= 400 && response.status < 500 && response.status !== 429) await abuse.fail(spec);
      return response;
    }
    const refusal = await abuse.take(
      surface === 'authorize'
        ? {
            surface,
            address,
            addressLimit: authorizeIpLimit,
            deploymentLimit: authorizeLimit,
            windowSeconds: ABUSE_WINDOW_S,
          }
        : {
            surface,
            address,
            addressLimit: consentIpLimit,
            deploymentLimit: consentLimit,
            windowSeconds: ABUSE_WINDOW_S,
          },
    );
    return refusal === null ? run() : refuseAbuse(c, refusal);
  };
  /** Live dynamic registrations and stored document clients (record keys the provider wrote, from the `kv` table). */
  const countClients = async (): Promise<{ dynamic: number; documents: number }> => {
    const names = await storage.kv.list(CLIENT_RECORD_PREFIX, { limit: KV_LIST_MAX });
    const documents = names.filter((n) => n.startsWith(DOCUMENT_CLIENT_PREFIX)).length;
    return { dynamic: names.length - documents, documents };
  };
  const blockKey = async (clientId: string): Promise<string> =>
    `${CLIENT_BLOCK_PREFIX}${await sha256Hex(clientId)}`;
  /** Whether an owner revoked this client (P5-08). One read; a storage error propagates (fail closed). */
  const isBlocked = async (clientId: string): Promise<boolean> =>
    (await storage.kv.get(await blockKey(clientId))) !== null;
  const hostOf = (clientId: string): string | null => {
    try {
      return new URL(clientId).hostname;
    } catch {
      return null;
    }
  };

  /**
   * CIMD (P5-03): makes sure an https client id has a live client record, fetching and validating its document when none
   * is cached. Resolves null when the request may go on (not a URL client id, or resolved), else a stable reason. Errors
   * are never cached; a validated document is stored for its (bounded) HTTP cache lifetime, in shared storage.
   */
  const resolveClient = async (clientId: string | null | undefined, c: Context): Promise<string | null> => {
    if (clientId === null || clientId === undefined) return null;
    if (await isBlocked(clientId)) return 'client_revoked';
    if (!looksLikeClientIdUrl(clientId)) return null;
    if (cimd === undefined) return 'cimd_disabled';
    const problem = clientIdUrlProblem(clientId, issuerHost, cimdHosts);
    if (problem !== null) return problem;
    if ((await env.OAUTH_KV.get(`client:${clientId}`)) !== null) return null;
    // Anonymous callers can make us fetch (T11, T20): bound the stored document clients, then the fetches one address
    // may cause (counted before the fetch, atomically; a failure is not cached, so failures count too).
    const stored = await storage.kv.list(DOCUMENT_CLIENT_PREFIX, { limit: cimdMaxClients });
    if (stored.length >= cimdMaxClients) {
      // A stored document is only a cache: evicting one costs its next request a fetch. So the cap bounds storage
      // without ever refusing a client, and a source that fills it (each document may be cached for a day) cannot keep
      // everyone else out (P5-10, D-76). The fetch limits below still bound what one source and all of them can cause.
      const victim = stored[randomBelow(stored.length)] as string;
      await storage.kv.delete(victim);
      logger.warn('oauth metadata document client cap reached; one stored document evicted', {
        limit: cimdMaxClients,
      });
      await auditCapOnce(c, 'cimd_clients', {
        action: 'oauth.client.evicted',
        status: 'ok',
        requestId: requestIdOf(c),
        reason: 'client_cap',
        details: { kind: 'metadata_document', limit: cimdMaxClients },
      });
    }
    const window = hourWindow();
    const fetches = await storage.kv.increment(`${CIMD_IP_PREFIX}${await callerKey(c)}:${window}`, {
      expiresAt: (window + 1) * CAP_WINDOW_S * 1000,
      max: cimdFetchLimit,
    });
    if (fetches === null) {
      await auditCapOnce(c, 'cimd_ip', {
        action: 'oauth.client.refused',
        status: 'denied',
        requestId: requestIdOf(c),
        reason: 'fetch_limit',
        details: { kind: 'metadata_document', limit: cimdFetchLimit },
      });
      return 'fetch_budget';
    }
    const total = await abuse.take({
      surface: 'metadata_fetch',
      deploymentLimit: cimdHourlyLimit,
      windowSeconds: CAP_WINDOW_S,
    });
    if (total !== null) {
      refuseAbuse(c, total);
      return 'fetch_budget';
    }
    try {
      const { client, ttlSeconds } = await fetchMetadataDocument(
        clientId,
        cimd.fetch,
        Math.floor(clock.now() / 1000),
      );
      await env.OAUTH_KV.put(`client:${clientId}`, JSON.stringify(client), { expirationTtl: ttlSeconds });
      audit(
        {
          action: 'oauth.client.fetched',
          status: 'ok',
          requestId: requestIdOf(c),
          clientId,
          details: { kind: 'metadata_document', host: hostOf(clientId), ttlSeconds },
        },
        c,
      );
      return null;
    } catch (error) {
      const reason = error instanceof ClientMetadataError ? error.reason : 'fetch_failed';
      audit(
        {
          action: 'oauth.client.refused',
          status: 'denied',
          requestId: requestIdOf(c),
          clientId,
          reason,
          details: { kind: 'metadata_document', host: hostOf(clientId) },
        },
        c,
      );
      return reason;
    }
  };
  /**
   * Reasons a client's document could not be had that say nothing about the client: its server is down or slow, the
   * fetch failed, or our own fetch budget is spent.
   */
  const TRANSIENT_CLIENT_REASONS: ReadonlySet<string> = new Set([
    'fetch_failed',
    'timeout',
    'unavailable',
    'fetch_budget',
  ]);
  const refusedClient = (clientId: string, reason: string, endpoint: 'authorize' | 'token'): Response => {
    // The client id is public (a URL or a random id); log its host only, never the document.
    logger.info('oauth client refused', { reason, clientHost: hostOf(clientId) });
    // At the token endpoint `invalid_client` makes a client throw away its registration and tokens and ask the person to
    // approve again (the MCP SDK does), so a passing failure to fetch its document must not look like one (P5-10).
    if (endpoint === 'token' && TRANSIENT_CLIENT_REASONS.has(reason)) {
      if (reason === 'fetch_budget') {
        return rateLimited(secondsToWindowEnd(hourWindow()), 'Too many requests; retry later.');
      }
      const unavailable = jsonError(
        503,
        'temporarily_unavailable',
        'The client metadata document is not available right now; retry later.',
      );
      unavailable.headers.set('Retry-After', '30');
      return unavailable;
    }
    if (reason === 'client_revoked') {
      return jsonError(400, 'invalid_client', 'This client was revoked by an administrator.');
    }
    return jsonError(400, 'invalid_client', 'The client metadata document could not be used.');
  };

  /** The stored record of the unused dynamic registration a token request authenticates as; null for any other client. */
  const unusedRegistrationOf = async (
    c: Context,
    form: URLSearchParams,
  ): Promise<{ readonly key: string; readonly raw: string; readonly expiresAt: number } | null> => {
    const clientId = requestClientId(c.req.header('authorization') ?? null, form);
    if (clientId === null || looksLikeClientIdUrl(clientId) || !CLIENT_ID_KEY_RE.test(clientId)) return null;
    const key = `client:${clientId}`;
    const raw = (await env.OAUTH_KV.get(key)) as string | null;
    if (raw === null) return null;
    try {
      const record = JSON.parse(raw) as Record<string, unknown> | null;
      if (record === null || typeof record !== 'object' || !isUnusedRegistration(record)) return null;
      return { key, raw, expiresAt: record.registrationExpiresAt };
    } catch {
      return null;
    }
  };
  /** Puts an unused registration back as it was if the provider renewed it (a revocation never makes a client used). */
  const keepUnused = async (before: {
    readonly key: string;
    readonly raw: string;
    readonly expiresAt: number;
  }) => {
    if (before.expiresAt * 1000 <= clock.now()) return;
    const now = (await env.OAUTH_KV.get(before.key)) as string | null;
    // Gone (revoked, expired) stays gone; unchanged needs nothing.
    if (now === null || now === before.raw) return;
    try {
      const record = JSON.parse(now) as { registrationExpiresAt?: unknown } | null;
      if (
        typeof record?.registrationExpiresAt !== 'number' ||
        record.registrationExpiresAt <= before.expiresAt
      ) {
        return;
      }
    } catch {
      return;
    }
    await env.OAUTH_KV.put(before.key, before.raw, { expiration: before.expiresAt });
  };

  const registrations: OAuthRegistrations = Object.freeze({
    count: countClients,
    async sweep() {
      const { removed } = await sweepRegistrations(storage, {
        now: () => clock.now(),
        unusedTtlSeconds: unusedRegistrationTtl,
      });
      return { removed };
    },
  });

  const codeMarker = async (code: string): Promise<string> => `${CODE_MARKER_PREFIX}${await sha256Hex(code)}`;
  const tombstone = (userId: string, grantId: string): string => `${TOMBSTONE_PREFIX}${userId}:${grantId}`;
  const tombstoneTtlMs = Math.max(refreshTtl, accessTtl, 60) * 1000;
  /** Revoke a device's provider grant and every token of it, leaving a tombstone first (see {@link TOMBSTONE_PREFIX}). */
  const revokeFamily = async (userId: string, grantId: string, helpers: OAuthHelpers): Promise<void> => {
    await storage.kv.set(tombstone(userId, grantId), '1', { expiresAt: clock.now() + tombstoneTtlMs });
    await helpers.revokeGrant(grantId, userId);
    usedWritten.delete(usedKey(userId, grantId));
    await storage.kv.delete(usedKey(userId, grantId)).catch(() => undefined);
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

  // --------------------------------------------------------------------------- refresh family (P5-05, D-63, D-70)

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const pollDelay = (poll: number): number => Math.min(250, 10 * 2 ** Math.min(poll, 5));

  /** The refresh grant: one request at a time spends a token; a repeat inside the window gets the same successor. */
  const refreshGrant = async (
    c: Context,
    as: OAuthAuthorizationServer<ProviderEnv>,
    helpers: OAuthHelpers,
    form: URLSearchParams,
    body: string,
    refreshToken: string,
    onRevocation: () => void,
  ): Promise<Response> => {
    const m = PROVIDER_TOKEN_RE.exec(refreshToken) as unknown as [string, string, string];
    const [, userId, grantId] = m;
    const tokenId = `oauth_${grantId}`;
    const hash = await sha256Hex(refreshToken);
    const rotatedKey = `${ROTATED_PREFIX}${hash}`;
    const successorKey = `${SUCCESSOR_PREFIX}${hash}`;
    const claimKey = `${CLAIM_PREFIX}${hash}`;
    const invalid = (description = 'Invalid refresh token'): Response =>
      jsonError(400, 'invalid_grant', description);

    // A device that was disconnected, replaced or pushed out is gone before anything else is looked at.
    if (await revokedMeanwhile(refreshToken, helpers)) return invalid();

    const issued = (reused: boolean, clientId: string | null): void =>
      audit(
        {
          action: 'oauth.token.issued',
          status: 'ok',
          requestId: requestIdOf(c),
          userId,
          clientId,
          tokenId,
          details: { grantType: 'refresh_token', reused },
        },
        c,
      );

    /** A spent token that came back: revoke the device unless this is the reuse window's repeat. */
    const replay = async (marker: string): Promise<Response> => {
      const grant = (await env.OAUTH_KV.get(`grant:${userId}:${grantId}`, { type: 'json' })) as {
        readonly expiresAt?: unknown;
        readonly clientId?: unknown;
      } | null;
      if (grant === null) return invalid('Grant not found');
      const at = (() => {
        try {
          const v = (JSON.parse(marker) as { at?: unknown }).at;
          return typeof v === 'number' ? v : Number.NEGATIVE_INFINITY;
        } catch {
          return Number.NEGATIVE_INFINITY;
        }
      })();
      const age = clock.now() - at;
      const sealed = age < reuseWindowMs ? await storage.kv.get(successorKey) : null;
      if (sealed === null) {
        // Outside the window (or no window): the token was stolen or the client is broken; the device pays.
        await revokeFamily(userId, grantId, helpers);
        onRevocation();
        logger.warn('oauth refresh token reused; device revoked', { oauthGrant: grantId });
        audit(
          {
            action: 'oauth.refresh.reuse',
            status: 'denied',
            requestId: requestIdOf(c),
            userId,
            clientId: typeof grant.clientId === 'string' ? grant.clientId : null,
            tokenId,
            reason: 'refresh_reuse',
            details: { revoked: true, windowSeconds: reuseWindow },
          },
          c,
        );
        return invalid('The authorization is no longer valid.');
      }
      const successor = await openSuccessor(refreshToken, hash, sealed);
      if (successor === null) {
        logger.error('oauth refresh successor unreadable', { oauthGrant: grantId });
        return invalid();
      }
      // The provider's grant handler is not reached from here: it authenticates the client for us (the probe carries a
      // token that cannot be a real one, so it never rotates anything), and the rest of its checks follow.
      const probe = new URLSearchParams(form);
      probe.set('refresh_token', `${userId}:${grantId}:${'A'.repeat(32)}`);
      const probed = await fetchProvider(as, c, probe.toString());
      const probedError = probed.ok
        ? null
        : ((await probed.json().catch(() => null)) as { error?: unknown } | null)?.error;
      if (probedError !== 'invalid_grant') {
        return probed.ok
          ? invalid()
          : jsonError(probed.status, String(probedError ?? 'invalid_client'), 'Client authentication failed');
      }
      if (requestClientId(c.req.header('authorization') ?? null, form) !== successor.clientId) {
        return invalid('Client ID mismatch');
      }
      const resource = form.get('resource');
      if (resource !== null && resource !== successor.resource) {
        return jsonError(
          400,
          'invalid_target',
          'resource must be the one this authorization was issued for.',
        );
      }
      const requested = (form.get('scope') ?? '').split(' ').filter((s) => s !== '');
      const granted = successor.scope.split(' ');
      if (requested.length > 0 && !requested.some((s) => granted.includes(s))) {
        return jsonError(400, 'invalid_scope', 'None of the requested scopes were granted');
      }
      if (typeof grant.expiresAt === 'number' && grant.expiresAt - Math.floor(clock.now() / 1000) < 60) {
        return invalid('Refresh token has expired');
      }
      // Access is decided again, as at every issuance: the successor's access token carries the grant's properties.
      const summary = await helpers.unwrapToken<Partial<OAuthGrantProps>>(successor.accessToken);
      const props = summary?.grant.props;
      if (
        props === undefined ||
        props === null ||
        typeof props.grantId !== 'string' ||
        typeof props.workspaceId !== 'string' ||
        typeof props.workspaceSlug !== 'string' ||
        props.userId !== userId
      ) {
        return invalid();
      }
      const decision = await decide(
        { grantId: props.grantId, workspaceId: props.workspaceId, userId },
        props.workspaceSlug,
        { tokenId, clientId: successor.clientId, expiresAt: null },
      );
      if (!decision.ok) {
        const keep = isRecoverableRefusal(decision.reason);
        if (!keep) {
          await revokeFamily(userId, grantId, helpers);
          onRevocation();
        }
        logger.info(keep ? 'oauth token refused; device kept' : 'oauth token refused; device revoked', {
          reason: decision.reason,
          oauthGrant: grantId,
          grantType: 'refresh_token',
        });
        audit(
          {
            action: 'oauth.token.refused',
            status: 'denied',
            requestId: requestIdOf(c),
            userId,
            workspaceId: props.workspaceId,
            clientId: successor.clientId,
            tokenId,
            reason: decision.reason,
            details: { grantType: 'refresh_token', revoked: !keep },
          },
          c,
        );
        if (keep) {
          const unavailable = jsonError(
            503,
            'temporarily_unavailable',
            'Access is unavailable right now; try again later.',
          );
          unavailable.headers.set('Retry-After', String(RECOVERABLE_RETRY_AFTER_S));
          return unavailable;
        }
        return invalid('The authorization is no longer valid.');
      }
      issued(true, successor.clientId);
      return new Response(
        JSON.stringify({
          access_token: successor.accessToken,
          token_type: 'bearer',
          expires_in: Math.max(1, Math.ceil((successor.accessExpiresAt - clock.now()) / 1000)),
          refresh_token: successor.refreshToken,
          scope: successor.scope,
          ...(successor.resource === null ? {} : { resource: successor.resource }),
        }),
        { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Pragma: 'no-cache' } },
      );
    };

    /** This request spends the token: the provider rotates it, then the answer is recorded for the repeats. */
    const spend = async (): Promise<Response> => {
      const response = await fetchProvider(as, c, body);
      if (!response.ok) return response;
      // Revoked while the provider was answering: it may have written the grant back.
      if (await revokedMeanwhile(refreshToken, helpers)) return invalid();
      const answer = (await response
        .clone()
        .json()
        .catch(() => null)) as {
        access_token?: unknown;
        refresh_token?: unknown;
        expires_in?: unknown;
        scope?: unknown;
        resource?: unknown;
      } | null;
      const clientId = requestClientId(c.req.header('authorization') ?? null, form);
      const at = clock.now();
      if (
        answer !== null &&
        typeof answer.access_token === 'string' &&
        typeof answer.refresh_token === 'string' &&
        typeof answer.expires_in === 'number'
      ) {
        if (reuseWindowMs > 0 && clientId !== null) {
          await storage.kv.set(
            successorKey,
            await sealSuccessor(refreshToken, hash, {
              accessToken: answer.access_token,
              refreshToken: answer.refresh_token,
              accessExpiresAt: at + answer.expires_in * 1000,
              scope: typeof answer.scope === 'string' ? answer.scope : '',
              resource: typeof answer.resource === 'string' ? answer.resource : null,
              clientId,
            }),
            { expiresAt: at + reuseWindowMs },
          );
        }
        // After the sealed answer: whoever sees the marker finds the successor.
        await storage.kv.set(rotatedKey, JSON.stringify({ at }), {
          expiresAt: at + refreshTtl * 1000 + 60_000,
        });
      }
      issued(false, clientId);
      return response;
    };

    for (let poll = 0; poll < REFRESH_WAIT_POLLS; poll++) {
      const marker = await storage.kv.get(rotatedKey);
      if (marker !== null) return replay(marker);
      if (await storage.kv.setIfAbsent(claimKey, '1', { expiresAt: clock.now() + REFRESH_CLAIM_TTL_MS })) {
        try {
          // Another request may have finished between the read and the claim: the provider must not rotate twice.
          const late = await storage.kv.get(rotatedKey);
          return late === null ? await spend() : await replay(late);
        } finally {
          await storage.kv.delete(claimKey).catch(() => undefined);
        }
      }
      await sleep(pollDelay(poll));
    }
    return jsonError(503, 'temporarily_unavailable', 'The refresh is being processed; try again.');
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

  /** What a grant's metadata says (written by `approve()`; anything else reads as absent). */
  const metaOf = (g: GrantSummary): { readonly workspace: string | null; readonly label: string | null } => {
    const m = (typeof g.metadata === 'object' && g.metadata !== null ? g.metadata : {}) as Record<
      string,
      unknown
    >;
    return {
      workspace: typeof m['workspace'] === 'string' ? m['workspace'] : null,
      label: typeof m['label'] === 'string' ? m['label'] : null,
    };
  };
  /** Every grant of a person, a page at a time; the device cap keeps this small. */
  const allGrants = async (helpers: OAuthHelpers, userId: string): Promise<GrantSummary[]> => {
    const out: GrantSummary[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_DEVICE_PAGES; page++) {
      const result = await helpers.listUserGrants(userId, {
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      out.push(...result.items);
      cursor = result.cursor;
      if (cursor === undefined) break;
    }
    return out;
  };
  /** The same app on the same workspace and redirect address: what a new approval replaces once it is redeemed. */
  const sameApp = (
    g: GrantSummary,
    ref: { readonly clientId: string; readonly redirectUri: string; readonly workspaceId: string | null },
  ): boolean =>
    g.clientId === ref.clientId &&
    g.redirectUri === ref.redirectUri &&
    metaOf(g).workspace === ref.workspaceId;
  /** Oldest first, ties by id: every concurrent approval sees the same order. */
  const byAge = (a: GrantSummary, b: GrantSummary): number =>
    a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  /**
   * After a successful code exchange: the person's earlier devices of the same app on the same workspace are replaced
   * (revoked, tombstone first). Only the holder of the code and its PKCE verifier gets here, never a navigation (L-090).
   */
  const replaceEarlierDevices = async (c: Context, code: string, helpers: OAuthHelpers): Promise<void> => {
    const m = PROVIDER_TOKEN_RE.exec(code);
    if (m === null) return;
    const [, userId, grantId] = m as unknown as [string, string, string];
    const grants = await allGrants(helpers, userId);
    const current = grants.find((g) => g.id === grantId);
    if (current === undefined || current.redirectUri === undefined) return;
    const ref = {
      clientId: current.clientId,
      redirectUri: current.redirectUri,
      workspaceId: metaOf(current).workspace,
    };
    let replaced = 0;
    for (const g of grants) {
      if (g.id === grantId || g.createdAt > current.createdAt || !sameApp(g, ref)) continue;
      await revokeFamily(userId, g.id, helpers);
      replaced++;
      audit(
        {
          action: 'oauth.device.replaced',
          status: 'ok',
          requestId: requestIdOf(c),
          userId,
          workspaceId: ref.workspaceId,
          clientId: g.clientId,
          tokenId: `oauth_${g.id}`,
          details: { by: `oauth_${grantId}` },
        },
        c,
      );
    }
    if (replaced > 0) onRevocation();
  };

  const toDevice = async (
    helpers: OAuthHelpers,
    g: GrantSummary,
    names?: Map<string, string | null>,
    userId?: string,
  ): Promise<OAuthDevice> => {
    let name: string | null = names?.get(g.clientId) ?? null;
    if (names === undefined || !names.has(g.clientId)) {
      try {
        name = (await helpers.lookupClient(g.clientId))?.clientName ?? null;
      } catch {
        name = null;
      }
      names?.set(g.clientId, name);
    }
    const meta = metaOf(g);
    let host = '';
    try {
      host = g.redirectUri === undefined ? '' : new URL(g.redirectUri).host;
    } catch {
      host = '';
    }
    return {
      id: g.id,
      clientId: g.clientId,
      clientName: name,
      redirectHost: host,
      workspaceId: meta.workspace,
      label: meta.label,
      createdAt: g.createdAt * 1000,
      expiresAt: g.expiresAt === undefined ? null : g.expiresAt * 1000,
      lastUsedAt: userId === undefined ? null : await lastUsed(userId, g.id).catch(() => null),
    };
  };

  /** Ends one of `userId`'s devices (the caller decided that it may): tombstone, tokens, cache, audit row. */
  const revokeOneDevice = async (
    c: Context,
    userId: string,
    deviceId: string,
    via: { readonly via: string; readonly by?: string },
  ): Promise<boolean> => {
    const helpers = (await server([])).getOAuthApi(env);
    // Only grants listed under this person's id are there: any other id is simply not found.
    const grant = (await allGrants(helpers, userId)).find((g) => g.id === deviceId);
    if (grant === undefined) return false;
    await revokeFamily(userId, grant.id, helpers);
    onRevocation();
    audit(
      {
        action: 'oauth.device.revoke',
        status: 'ok',
        requestId: requestIdOf(c),
        userId,
        workspaceId: metaOf(grant).workspace,
        clientId: grant.clientId,
        tokenId: `oauth_${grant.id}`,
        details: { ...via },
      },
      c,
    );
    return true;
  };

  const runtime: OAuthRuntime = {
    issuer,
    registrations,
    guard,
    clientMetadataDocuments: cimd !== undefined,
    resourceUrl,
    resourceMetadataUrl,

    resourceMetadata(slug) {
      if (!SLUG_RE.test(slug)) return null;
      // RFC 9728. Deliberately no `resource_name`, `jwks_uri` or `resource_documentation`; `offline_access` is not a
      // scope of the resource (MCP authorization: it stays out of the challenge and the metadata).
      return new Response(
        JSON.stringify({
          resource: resourceUrl(slug),
          authorization_servers: [issuer],
          scopes_supported: [MCP_SCOPE],
          bearer_methods_supported: ['header'],
        }),
        // The app's own `no-store` applies to it like to every response (D-65).
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },

    challenge(slug) {
      if (!SLUG_RE.test(slug)) return 'Bearer';
      return `Bearer realm="agility-bridge", resource_metadata="${resourceMetadataUrl(slug)}", scope="${MCP_SCOPE}"`;
    },

    async devices(userId) {
      const helpers = (await server([])).getOAuthApi(env);
      const grants = (await allGrants(helpers, userId))
        .sort((a, b) => byAge(b, a))
        .slice(0, MAX_OAUTH_DEVICES_PER_USER);
      const names = new Map<string, string | null>();
      return Promise.all(grants.map((g) => toDevice(helpers, g, names, userId)));
    },

    async revokeDevice(c, userId, deviceId) {
      return revokeOneDevice(c, userId, deviceId, { via: 'my_access' });
    },

    async abuseOverview() {
      const now = clock.now();
      const counted = await countClients();
      const read = async (action: OAuthRefusalCount['action']) =>
        storage.audit.query({
          action,
          from: now - ABUSE_VIEW_WINDOW_MS,
          to: now + 1,
          limit: ABUSE_VIEW_ROWS,
        });
      const [requests, clients] = await Promise.all([
        read('oauth.request.refused'),
        read('oauth.client.refused'),
      ]);
      const groups = new Map<string, { -readonly [K in keyof OAuthRefusalCount]: OAuthRefusalCount[K] }>();
      for (const [action, entries] of [
        ['oauth.request.refused', requests],
        ['oauth.client.refused', clients],
      ] as const) {
        for (const e of entries) {
          const detail = e.details ?? {};
          // Allowlisted, shape-checked fields only: whatever else a row holds (a host, a client id) stays out.
          const word = (v: unknown): string | null =>
            typeof v === 'string' && /^[a-z0-9_]{1,64}$/.test(v) ? v : null;
          const reason = word(e.errorCode) ?? 'other';
          const surface = action === 'oauth.request.refused' ? word(detail['surface']) : null;
          const scope = action === 'oauth.request.refused' ? word(detail['scope']) : null;
          const kind = word(detail['kind']);
          const key = `${action}|${reason}|${surface}|${scope}|${kind}`;
          const group = groups.get(key);
          if (group === undefined)
            groups.set(key, { action, reason, surface, scope, kind, count: 1, lastAt: e.ts });
          else {
            group.count += 1;
            group.lastAt = Math.max(group.lastAt, e.ts);
          }
        }
      }
      return {
        registrations: {
          dynamic: { enabled: registrationEnabled, live: counted.dynamic, cap: dcrMaxClients },
          documents: { enabled: cimd !== undefined, stored: counted.documents, cap: cimdMaxClients },
        },
        limits: {
          authorizeIp: authorizeIpLimit,
          authorize: authorizeLimit,
          consentIp: consentIpLimit,
          consent: consentLimit,
          tokenFailureIp: tokenFailureIpLimit,
          tokenFailure: tokenFailureLimit,
          registrationIp: dcrIpLimit,
          registrationHourly: dcrHourlyLimit,
          fetchIp: cimdFetchLimit,
          fetchHourly: cimdHourlyLimit,
        },
        windowHours: 24,
        refusals: [...groups.values()].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
        refusalsTruncated: requests.length >= ABUSE_VIEW_ROWS || clients.length >= ABUSE_VIEW_ROWS,
      };
    },

    async revokeDeviceFor(c, userId, deviceId, by) {
      return revokeOneDevice(c, userId, deviceId, { via: 'admin', ...(by === null ? {} : { by }) });
    },

    async allDevices(page) {
      const limit = Math.min(Math.max(1, Math.floor(page.limit ?? DEVICE_PAGE_DEFAULT)), DEVICE_PAGE_MAX);
      const grantPrefix = `${OAUTH_KV_PREFIX}grant:`;
      const after =
        page.after !== undefined && GRANT_TAIL_RE.test(page.after)
          ? `${grantPrefix}${page.after}`
          : undefined;
      const keys = await storage.kv.list(grantPrefix, {
        limit: limit + 1,
        ...(after === undefined ? {} : { after }),
      });
      const mine = keys.slice(0, limit);
      const helpers = (await server([])).getOAuthApi(env);
      const names = new Map<string, string | null>();
      const devices: OAuthAdminDevice[] = [];
      for (const key of mine) {
        const m = GRANT_TAIL_RE.exec(key.slice(grantPrefix.length));
        // Other keys under `grant:` (none today) are skipped, not shown.
        if (m === null) continue;
        const record = (await env.OAUTH_KV.get(key.slice(OAUTH_KV_PREFIX.length), {
          type: 'json',
        })) as Partial<GrantSummary> | null;
        if (record === null || typeof record !== 'object' || typeof record.clientId !== 'string') continue;
        const summary: GrantSummary = {
          id: m[2] as string,
          clientId: record.clientId,
          userId: m[1] as string,
          scope: Array.isArray(record.scope) ? record.scope : [],
          metadata: record.metadata,
          createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
          ...(typeof record.expiresAt === 'number' ? { expiresAt: record.expiresAt } : {}),
          ...(typeof record.redirectUri === 'string' ? { redirectUri: record.redirectUri } : {}),
        };
        devices.push({ ...(await toDevice(helpers, summary, names)), userId: summary.userId });
      }
      const last = mine[mine.length - 1];
      return {
        devices,
        next: keys.length > limit && last !== undefined ? last.slice(grantPrefix.length) : null,
      };
    },

    async clients(page) {
      const limit = Math.min(Math.max(1, Math.floor(page.limit ?? CLIENT_PAGE_DEFAULT)), CLIENT_PAGE_MAX);
      const after =
        page.after !== undefined && CLIENT_ID_KEY_RE.test(page.after)
          ? `${CLIENT_RECORD_PREFIX}${page.after}`
          : undefined;
      const keys = await storage.kv.list(CLIENT_RECORD_PREFIX, {
        limit: limit + 1,
        ...(after === undefined ? {} : { after }),
      });
      const mine = keys.slice(0, limit);
      const rows: { clientId: string; name: string | null; hosts: string[]; createdAt: number | null }[] = [];
      for (const key of mine) {
        const clientId = key.slice(CLIENT_RECORD_PREFIX.length);
        const record = (await env.OAUTH_KV.get(key.slice(OAUTH_KV_PREFIX.length), {
          type: 'json',
        })) as {
          readonly clientName?: unknown;
          readonly redirectUris?: unknown;
          readonly registrationDate?: unknown;
        } | null;
        if (record === null || typeof record !== 'object') continue;
        const hosts = new Set<string>();
        for (const uri of Array.isArray(record.redirectUris) ? record.redirectUris.slice(0, 20) : []) {
          try {
            if (typeof uri === 'string') hosts.add(new URL(uri).host);
          } catch {
            // not a URL: nothing to show
          }
        }
        rows.push({
          clientId,
          name: typeof record.clientName === 'string' ? record.clientName.slice(0, 200) : null,
          hosts: [...hosts],
          createdAt: typeof record.registrationDate === 'number' ? record.registrationDate * 1000 : null,
        });
      }
      // Devices per client: the grants are keyed by person, so this reads them (a bounded number: L-097). A failure
      // leaves the counts unknown rather than the list unavailable.
      const counts = new Map<string, { n: number; last: number }>();
      let counted = true;
      let truncated = false;
      try {
        const grantPrefix = `${OAUTH_KV_PREFIX}grant:`;
        const grantKeys = await storage.kv.list(grantPrefix, { limit: CLIENT_COUNT_SCAN_MAX + 1 });
        truncated = grantKeys.length > CLIENT_COUNT_SCAN_MAX;
        for (const key of grantKeys.slice(0, CLIENT_COUNT_SCAN_MAX)) {
          if (!GRANT_TAIL_RE.test(key.slice(grantPrefix.length))) continue;
          const record = (await env.OAUTH_KV.get(key.slice(OAUTH_KV_PREFIX.length), {
            type: 'json',
          })) as { readonly clientId?: unknown; readonly createdAt?: unknown } | null;
          if (record === null || typeof record.clientId !== 'string') continue;
          const at = typeof record.createdAt === 'number' ? record.createdAt * 1000 : 0;
          const seen = counts.get(record.clientId) ?? { n: 0, last: 0 };
          counts.set(record.clientId, { n: seen.n + 1, last: Math.max(seen.last, at) });
        }
      } catch {
        counted = false;
        logger.warn('oauth client device counts unavailable');
      }
      const blockedKeys = await storage.kv.list(CLIENT_BLOCK_PREFIX, { limit: BLOCKED_LIST_MAX });
      const blocked: OAuthBlockedClient[] = [];
      for (const key of blockedKeys) {
        const raw = await storage.kv.get(key);
        try {
          const v = JSON.parse(raw ?? 'null') as {
            clientId?: unknown;
            kind?: unknown;
            name?: unknown;
            at?: unknown;
          } | null;
          if (v === null || typeof v.clientId !== 'string') continue;
          blocked.push({
            clientId: v.clientId,
            kind: v.kind === 'metadata_document' ? 'metadata_document' : 'dynamic',
            name: typeof v.name === 'string' ? v.name.slice(0, 200) : null,
            at: typeof v.at === 'number' ? v.at : 0,
          });
        } catch {
          // a row we did not write: not shown
        }
      }
      const last = mine[mine.length - 1];
      return {
        clients: rows.map((r) => {
          const seen = counts.get(r.clientId);
          return {
            clientId: r.clientId,
            kind: looksLikeClientIdUrl(r.clientId) ? 'metadata_document' : 'dynamic',
            name: r.name,
            redirectHosts: r.hosts,
            createdAt: r.createdAt,
            lastApprovedAt: seen === undefined || seen.last === 0 ? null : seen.last,
            devices: counted ? (seen?.n ?? 0) : null,
          } satisfies OAuthClientSummary;
        }),
        blocked,
        next: keys.length > limit && last !== undefined ? last.slice(CLIENT_RECORD_PREFIX.length) : null,
        devicesTruncated: truncated,
      };
    },

    async revokeClient(c, clientId, by) {
      if (!CLIENT_ID_KEY_RE.test(clientId)) return null;
      const record = (await env.OAUTH_KV.get(`client:${clientId}`, { type: 'json' })) as {
        readonly clientName?: unknown;
      } | null;
      const kind = looksLikeClientIdUrl(clientId) ? 'metadata_document' : 'dynamic';
      const already = await isBlocked(clientId);
      // Nothing to revoke: no such client, and it was not revoked before either (a second press finishes the first).
      if (record === null && !already) return null;
      const name = typeof record?.clientName === 'string' ? record.clientName.slice(0, 200) : null;
      // Block first: whatever fails after this, the client is already refused everywhere.
      await storage.kv.set(
        await blockKey(clientId),
        JSON.stringify({ clientId, kind, name, at: clock.now() }),
        kind === 'dynamic' ? { expiresAt: clock.now() + tombstoneTtlMs + 120_000 } : {},
      );
      await env.OAUTH_KV.delete(`client:${clientId}`);
      const helpers = (await server([])).getOAuthApi(env);
      const grantPrefix = `${OAUTH_KV_PREFIX}grant:`;
      const grantKeys = await storage.kv.list(grantPrefix, { limit: CLIENT_REVOKE_SCAN_MAX });
      let ended = 0;
      for (const key of grantKeys) {
        const m = GRANT_TAIL_RE.exec(key.slice(grantPrefix.length));
        if (m === null) continue;
        const grant = (await env.OAUTH_KV.get(key.slice(OAUTH_KV_PREFIX.length), {
          type: 'json',
        })) as { readonly clientId?: unknown; readonly metadata?: unknown } | null;
        if (grant === null || grant.clientId !== clientId) continue;
        const userId = m[1] as string;
        const grantId = m[2] as string;
        await revokeFamily(userId, grantId, helpers);
        ended++;
        audit(
          {
            action: 'oauth.device.revoke',
            status: 'ok',
            requestId: requestIdOf(c),
            userId,
            workspaceId: metaOf({ metadata: grant.metadata } as GrantSummary).workspace,
            clientId,
            tokenId: `oauth_${grantId}`,
            details: { via: 'client_revoke', ...(by === null ? {} : { by }) },
          },
          c,
        );
      }
      onRevocation();
      const complete = grantKeys.length < CLIENT_REVOKE_SCAN_MAX;
      audit(
        {
          action: 'oauth.client.revoked',
          status: 'ok',
          requestId: requestIdOf(c),
          clientId,
          details: { kind, host: hostOf(clientId), devices: ended, complete, ...(by === null ? {} : { by }) },
        },
        c,
      );
      return { devices: ended, complete };
    },

    async restoreClient(c, clientId, by) {
      if (!CLIENT_ID_KEY_RE.test(clientId)) return false;
      const removed = await storage.kv.delete(await blockKey(clientId));
      if (!removed) return false;
      audit(
        {
          action: 'oauth.client.restored',
          status: 'ok',
          requestId: requestIdOf(c),
          clientId,
          details: {
            kind: looksLikeClientIdUrl(clientId) ? 'metadata_document' : 'dynamic',
            host: hostOf(clientId),
            ...(by === null ? {} : { by }),
          },
        },
        c,
      );
      return true;
    },

    async revokeAllDevices(c, userId) {
      const helpers = (await server([])).getOAuthApi(env);
      const grants = await allGrants(helpers, userId);
      for (const grant of grants) {
        await revokeFamily(userId, grant.id, helpers);
        audit(
          {
            action: 'oauth.device.revoke',
            status: 'ok',
            requestId: requestIdOf(c),
            userId,
            workspaceId: metaOf(grant).workspace,
            clientId: grant.clientId,
            tokenId: `oauth_${grant.id}`,
            details: { via: 'my_access', all: true },
          },
          c,
        );
      }
      if (grants.length > 0) onRevocation();
      return grants.length;
    },

    async metadata(c) {
      const response = await fetchProvider(await server([]), c);
      if (!response.ok) return response;
      // RFC 9728 `protected_resources` is optional. Workspace slugs are not public (T19), and this server only declares
      // a placeholder here: clients find a workspace's resource through its own metadata (P5-02).
      const meta = (await response.json()) as Record<string, unknown>;
      delete meta['protected_resources'];
      // CIMD is ours (the provider's own stays off): advertised only when a guarded fetcher is in use.
      meta['client_id_metadata_document_supported'] = cimd !== undefined;
      const headers = new Headers(response.headers);
      headers.delete('content-length');
      return new Response(JSON.stringify(meta), { status: response.status, headers });
    },

    async register(c) {
      if (!registrationEnabled) return jsonError(404, 'not_found', 'Client registration is disabled.');
      const body = await readBounded(c.req.raw, OAUTH_MAX_BODY_BYTES);
      if (body === null) return jsonError(413, 'invalid_request', 'Request body too large.');
      const mediaType = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
      if (mediaType !== 'application/json') {
        return jsonError(400, 'invalid_client_metadata', 'Send the client metadata as application/json.');
      }
      // Our policy first, and the provider is given the rebuilt request: nothing is stored for a refused one, and
      // nothing the client sent beyond the fields we use reaches storage or a consent screen (T9, T10).
      const verdict = checkRegistration(body, redirectHosts);
      if (!verdict.ok) {
        logger.info('oauth registration refused', { reason: verdict.reason });
        return jsonError(400, verdict.error, 'The client metadata is not acceptable.');
      }
      // One source must not use up the shared cap (relic M1): the per-address count comes first, atomically.
      const window = hourWindow();
      const mine = await storage.kv.increment(`${DCR_IP_PREFIX}${await callerKey(c)}:${window}`, {
        expiresAt: (window + 1) * CAP_WINDOW_S * 1000,
        max: dcrIpLimit,
      });
      if (mine === null) {
        logger.warn('oauth registration per-address limit reached', { limit: dcrIpLimit });
        await auditCapOnce(c, 'dcr_ip', {
          action: 'oauth.client.refused',
          status: 'denied',
          requestId: requestIdOf(c),
          reason: 'ip_limit',
          details: { kind: 'dynamic', limit: dcrIpLimit },
        });
        return rateLimited(
          secondsToWindowEnd(window),
          'Too many client registrations from this address; retry later.',
        );
      }
      // Then the deployment's registrations per hour (a bound on churn), then its cap on live ones.
      const churn = await abuse.take({
        surface: 'registration',
        deploymentLimit: dcrHourlyLimit,
        windowSeconds: CAP_WINDOW_S,
      });
      if (churn !== null) return refuseAbuse(c, churn);
      // The deployment's cap on live registrations. Reads, so a burst may overshoot by its concurrency, which the
      // per-address limit and the request limiter bound.
      let live = (await countClients()).dynamic;
      if (live >= dcrMaxClients) {
        // Room first: registrations nobody used within the hour go (P5-10, D-77), so a source that filled the cap with
        // registrations it never uses cannot hold it for the unused lifetime.
        const { removed } = await sweepRegistrations(storage, {
          now: () => clock.now(),
          unusedTtlSeconds: CAP_PRESSURE_UNUSED_S,
          limit: CAP_PRESSURE_SLICE,
        });
        live -= removed;
      }
      if (live >= dcrMaxClients) {
        logger.warn('oauth registration cap reached', { limit: dcrMaxClients });
        await auditCapOnce(c, 'dcr_clients', {
          action: 'oauth.client.refused',
          status: 'denied',
          requestId: requestIdOf(c),
          reason: 'client_cap',
          details: { kind: 'dynamic', limit: dcrMaxClients },
        });
        return rateLimited(CAP_WINDOW_S, 'Too many registered clients; retry later.');
      }
      const response = await fetchProvider(await server([]), c, verdict.body);
      if (response.status !== 201) return response;
      // Unused registrations die young: until its first token exchange (which renews it, the provider's half-life rule)
      // a registration lives `unusedRegistrationTtl`, so a flood of registrations nobody uses does not stay.
      const created = (await response.clone().json()) as { readonly client_id?: unknown };
      if (typeof created.client_id === 'string') {
        const key = `client:${created.client_id}`;
        const record = (await env.OAUTH_KV.get(key, { type: 'json' })) as Record<string, unknown> | null;
        if (record !== null) {
          await env.OAUTH_KV.put(
            key,
            JSON.stringify({
              ...record,
              registrationExpiresAt: Math.floor(clock.now() / 1000) + unusedRegistrationTtl,
            }),
            { expirationTtl: unusedRegistrationTtl },
          );
        }
        audit(
          {
            action: 'oauth.client.registered',
            status: 'ok',
            requestId: requestIdOf(c),
            clientId: created.client_id,
            details: {
              kind: 'dynamic',
              redirectHosts: [...new Set(verdict.redirectUris.map((u) => new URL(u).host))].slice(0, 10),
            },
          },
          c,
        );
      }
      return response;
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
      // CIMD: a URL client id needs its (cached or fetched) document before the provider looks the client up. Before the
      // code is consumed, so a fetch failure does not burn it.
      const clientId = form.get('client_id');
      const clientProblem = await resolveClient(clientId, c);
      if (clientProblem !== null) return refusedClient(clientId as string, clientProblem, 'token');
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
      if (grantType === 'refresh_token') {
        const presented = form.get('refresh_token') ?? '';
        // Anything that is not the shape of our tokens is the provider's to refuse.
        if (PROVIDER_TOKEN_RE.test(presented)) {
          return refreshGrant(c, as, helpers, form, body, presented, onRevocation);
        }
      }
      // RFC 7009 revocation shares this endpoint (no grant_type).
      const revocation = grantType === null && form.has('token');
      // The provider renews the registration of any client that gets a `200` here, and a revocation answers `200` to
      // anything: without this a client that never exchanged a code could keep its registration for 90 days (P5-10).
      const unused = revocation ? await unusedRegistrationOf(c, form) : null;
      const response = await fetchProvider(as, c, body);
      if (unused !== null) await keepUnused(unused);
      if (grantType === 'authorization_code') {
        if (response.ok && (await revokedMeanwhile(code, helpers))) {
          return jsonError(400, 'invalid_grant', 'Invalid authorization code');
        }
        if (response.ok) {
          // A device is replaced only now, by the holder of the code and verifier, never by an authorization request.
          await replaceEarlierDevices(c, code, helpers).catch((error: unknown) => {
            logger.warn('oauth device replacement failed', {
              error: error instanceof Error ? error.name : 'error',
            });
          });
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
      // CIMD: fetch (or find cached) the client's document before the provider looks the client up. A failure is a
      // 400 page, never a redirect: no redirect URI has been validated yet.
      const requestedClient = params.get('client_id');
      const clientProblem = await resolveClient(requestedClient, c);
      if (clientProblem !== null) return refusedClient(requestedClient as string, clientProblem, 'authorize');
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
        clientKind: looksLikeClientIdUrl(authRequest.clientId) ? 'metadata_document' : 'dynamic',
        clientHost: looksLikeClientIdUrl(authRequest.clientId) ? hostOf(authRequest.clientId) : null,
      });
      let used = false;
      const api: OAuthConsentApi = Object.freeze({
        request,
        authRequest,
        helpers,
        deny: (description = 'The user denied the request.', userId?: string) => {
          audit(
            {
              action: 'oauth.authorize',
              status: 'denied',
              requestId: requestIdOf(c),
              ...(userId === undefined ? {} : { userId }),
              clientId: authRequest.clientId,
              reason: 'user_denied',
            },
            c,
          );
          return mod.authorizationErrorRedirect(authRequest, 'access_denied', description);
        },
        grants: async (userId: string) => {
          const workspace = await storage.workspaces.getBySlug(slug);
          if (workspace === null) return { workspaceName: null, options: [] };
          const mine = (await storage.grants.list({ workspaceId: workspace.id, userId }))
            .filter((g) => g.userId === userId && g.revokedAt === null)
            .slice(0, 20);
          const options: OAuthGrantOption[] = [];
          for (const g of mine) {
            const decision = await decide({ grantId: g.id, workspaceId: workspace.id, userId }, slug, {
              tokenId: 'oauth_pending',
              clientId: authRequest.clientId,
              expiresAt: null,
            });
            if (!decision.ok) continue;
            options.push({
              id: g.id,
              label: g.label,
              tools: decision.access.tools,
              projectCount: decision.access.projects.allowed.length,
              expiresAt: decision.access.expiresAt,
            });
          }
          return { workspaceName: options.length > 0 ? workspace.name : null, options };
        },
        refuse: (error: string, description: string) => {
          // The redirect URI was validated by `parseAuthRequest` (exact match against the registration).
          const u = new URL(authRequest.redirectUri);
          u.searchParams.set('error', error);
          u.searchParams.set('error_description', description);
          if (authRequest.state) u.searchParams.set('state', authRequest.state);
          u.searchParams.set('iss', issuer);
          return u.toString();
        },
        approve: async ({
          userId,
          grantId,
          label,
        }: {
          readonly userId: string;
          readonly grantId: string;
          readonly label?: string | null;
        }) => {
          if (used) throw new Error('an authorization request is approved at most once');
          used = true;
          const workspace = await storage.workspaces.getBySlug(slug);
          const refused = (
            reason: DenyReason | 'principal_mismatch' | 'device_limit' | 'busy',
          ): OAuthApproval => {
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
          const ref = {
            clientId: authRequest.clientId,
            redirectUri: authRequest.redirectUri,
            workspaceId: workspace.id,
          };
          // One approval at a time per person: the cap is counted and then a grant inserted, and two interleaved counts
          // would each see room for the last place. The lock outlives a crash by seconds, never longer.
          const lock = `${APPROVAL_LOCK_PREFIX}${userId}`;
          if (!(await storage.kv.setIfAbsent(lock, '1', { expiresAt: clock.now() + APPROVAL_LOCK_MS }))) {
            return refused('busy');
          }
          let redirectTo: string;
          let code: string;
          try {
            // The device cap (T15): the app this approval replaces does not count, as it ends once the new one is
            // redeemed.
            const others = (await allGrants(helpers, userId)).filter((g) => !sameApp(g, ref));
            if (others.length >= MAX_OAUTH_DEVICES_PER_USER) return refused('device_limit');
            const completed = await helpers.completeAuthorization({
              request: authRequest,
              userId,
              // T25: grant metadata is stored unencrypted: the access grant id and workspace id (opaque) and the device
              // name the person typed (plain text, length-limited), never an email or other personal data.
              metadata: { grant: grantId, workspace: workspace.id, ...(label ? { label } : {}) },
              scope: [...scope],
              props,
              // A request alone must never end a device (relic-bridge H1, L-090): replacement waits for the code exchange.
              revokeExistingGrants: false,
            });
            redirectTo = completed.redirectTo;
            const issued = new URL(redirectTo).searchParams.get('code');
            if (issued === null) throw new Error('the provider returned no authorization code');
            code = issued;
            const newId = PROVIDER_TOKEN_RE.exec(code)?.[2];
            if (newId === undefined)
              throw new Error('the provider returned an unexpected authorization code');
            // After the insert, again: should the lock have lapsed under a slow store, approvals that overlapped each
            // passed the count above, so the oldest places keep theirs and the rest are undone.
            const ranked = (await allGrants(helpers, userId))
              .filter((g) => g.id === newId || !sameApp(g, ref))
              .sort(byAge);
            // Whoever sees the overflow undoes it for everyone: a check that ran before the last insert cannot have seen
            // it, so the later one also revokes the grants past the cap (their approvals already answered; their codes
            // then fail at the exchange).
            const over = ranked.slice(MAX_OAUTH_DEVICES_PER_USER);
            for (const g of over) await revokeFamily(userId, g.id, helpers);
            if (over.some((g) => g.id === newId) || !ranked.some((g) => g.id === newId)) {
              return refused('device_limit');
            }
          } finally {
            await storage.kv.delete(lock).catch(() => undefined);
          }
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
      // An owner revoked this client (P5-08): its access tokens stop here even if a grant is still waiting to be ended.
      if (await isBlocked(validated.clientId)) return { ok: false, stage: 'token', reason: 'oauth_invalid' };
      const decision = await decide(
        { grantId: props.grantId, workspaceId: props.workspaceId, userId: props.userId },
        slug,
        { tokenId, clientId: validated.clientId, expiresAt: validated.expiresAt * 1000 },
      );
      if (!decision.ok) return { ok: false, stage: 'access', tokenId, reason: decision.reason };
      await touchDevice(props.userId, providerGrant);
      return { ok: true, access: decision.access };
    },
  };
  return runtime;
}
