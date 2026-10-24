// SPDX-License-Identifier: Apache-2.0
// OAuth client registration policy (P5-03, ADR-0009, THREAT_MODEL T9, T10, T11). Web-standard only.
//
// - Client ID Metadata Documents (CIMD, draft-ietf-oauth-client-id-metadata-document; MCP 2025-11-25 and 2026-07-28): a
//   `client_id` that is an https URL names a JSON document describing the client. We fetch and validate it here (the
//   provider's own CIMD stays off) through a fetcher the host supplies with an SSRF guard (Node: connect-time address
//   check; Workers: `global_fetch_strictly_public`). The client id is checked before anything is fetched: canonical,
//   https, a DNS name (no IP literal or internal name), no port, not ourselves. The fetch is bounded (no redirects,
//   5 s, 5 KiB, JSON media type). Only redirect URIs on the client id's own host, or loopback, are kept.
// - Dynamic Client Registration (RFC 7591): the request is parsed and rebuilt before the provider stores anything:
//   only the fields we use are forwarded, redirect URIs are held to the same policy.
// Display names are untrusted text either way: control, format (bidi, zero-width) and separator characters and
// look-alike scripts are refused, so a consent screen can't be made to show something other than what was registered.
import { addressClass } from '@agility-bridge/core';

/** Fetches a client metadata document. Must refuse non-public destinations and must not follow redirects. */
export type ClientMetadataFetch = (url: string, init: { readonly signal: AbortSignal }) => Promise<Response>;

/** Largest metadata document read (the draft's recommended maximum). */
export const CIMD_MAX_BYTES: number = 5 * 1024;
/** Time allowed for the whole fetch, body included. */
export const CIMD_TIMEOUT_MS = 5000;
/** Cache lifetime bounds of a validated document (the draft lets the server bound HTTP cache lifetimes). */
export const CIMD_MIN_TTL_S = 300;
export const CIMD_MAX_TTL_S = 86_400;
/** Cache lifetime when the document sends no usable `Cache-Control`. */
export const CIMD_DEFAULT_TTL_S = 3600;
/** Short enough that `oauth:client:<url>` is a valid `kv` key (512 characters at most). */
export const MAX_CLIENT_ID_URL_CHARS = 400;
export const MAX_REDIRECT_URIS = 10;
export const MAX_REDIRECT_URI_CHARS = 2000;
export const MAX_CLIENT_NAME_CHARS = 100;

/** Host name suffixes that never name a public client (RFC 6761/6762/8375 special-use, common internal suffixes). */
const INTERNAL_SUFFIXES: readonly string[] = [
  'localhost',
  'local',
  'internal',
  'intranet',
  'lan',
  'home',
  'corp',
  'private',
  'arpa',
  'test',
  'invalid',
  'example',
  'onion',
];

/** A refused client: `reason` is a stable code for logs (never shown to the caller, never contains input). */
export class ClientMetadataError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`client metadata refused: ${reason}`);
    this.name = 'ClientMetadataError';
    this.reason = reason;
  }
}

// ------------------------------------------------------------------------------------------------- hosts

/** Whether `URL.hostname` is an IP literal: the parser has already rewritten every IPv4 spelling to a dotted quad. */
export function isIpLiteral(hostname: string): boolean {
  return (hostname.startsWith('[') && hostname.endsWith(']')) || addressClass(hostname) !== 'invalid';
}

/** `localhost`, 127.0.0.0/8 or `[::1]` (RFC 8252 loopback redirect hosts). `hostname` as `URL.hostname` gives it. */
export function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost') return true;
  if (hostname === '[::1]') return true;
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) && addressClass(hostname) === 'loopback';
}

// ------------------------------------------------------------------------------------------------- text

/** Refused in display names: controls, format characters (bidi overrides, zero-width), line/paragraph separators, private use. */
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}]/u;

/** A word mixing Latin letters with Cyrillic or Greek ones: the look-alike trick ("Clаude" with a Cyrillic "а"). */
const MIXED_SCRIPT_WORD = /(?=\S*\p{Script=Latin})(?=\S*[\p{Script=Cyrillic}\p{Script=Greek}])\S+/u;

/** A client display name, or null when it is unsafe, too long or spells a word with look-alike letters. */
export function safeClientName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (
    name.length === 0 ||
    [...name].length > MAX_CLIENT_NAME_CHARS ||
    UNSAFE_TEXT.test(name) ||
    MIXED_SCRIPT_WORD.test(name)
  )
    return null;
  return name;
}

// ------------------------------------------------------------------------------------------------- client ids

/** Whether the provider would take this client id for a metadata-document URL (then we resolve it, or refuse it). */
export function looksLikeClientIdUrl(clientId: string): boolean {
  return /^[\s\p{Cc}]*https:/iu.test(clientId);
}

/**
 * Why a CIMD `client_id` is refused before anything is fetched, or null when it may be fetched. `issuerHost` is our own
 * host name (a document on it would be fetched from ourselves).
 */
export function clientIdUrlProblem(clientId: string, issuerHost: string): string | null {
  if (clientId.length > MAX_CLIENT_ID_URL_CHARS) return 'client_id_too_long';
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return 'client_id_not_url';
  }
  // Canonical form only: no dot segments, no uppercase scheme or host, no `:443`, no `\`, nothing the parser rewrites.
  // The draft compares the document's client_id with the URL as a string, so this costs real clients nothing.
  if (url.href !== clientId) return 'client_id_not_canonical';
  if (url.protocol !== 'https:') return 'client_id_not_https';
  if (url.username !== '' || url.password !== '') return 'client_id_userinfo';
  if (clientId.includes('#')) return 'client_id_fragment';
  if (url.port !== '') return 'client_id_port';
  if (url.pathname === '/' || url.pathname === '') return 'client_id_no_path';
  const host = url.hostname;
  if (isIpLiteral(host)) return 'client_id_ip_literal';
  if (!host.includes('.') || host.endsWith('.')) return 'client_id_internal_name';
  const tld = host.slice(host.lastIndexOf('.') + 1);
  if (INTERNAL_SUFFIXES.includes(tld)) return 'client_id_internal_name';
  if (host === issuerHost) return 'client_id_self';
  return null;
}

// ------------------------------------------------------------------------------------------------- redirect URIs

/** What a redirect URI is under our policy. `bad:*` refuses the whole document or registration. */
export type RedirectVerdict = 'usable' | 'unusable' | `bad:${string}`;

export interface RedirectPolicy {
  /** CIMD: https redirects must be on this host. */
  readonly clientHost?: string;
  /** DCR: when set, https redirects must be on one of these hosts (lowercase). */
  readonly allowedHosts?: readonly string[];
}

/** Schemes that can run code or read local files when navigated to: a redirect to one is refused outright. */
const DANGEROUS_SCHEMES: readonly string[] = [
  'javascript:',
  'data:',
  'vbscript:',
  'file:',
  'blob:',
  'about:',
  'filesystem:',
  'ftp:',
  'ws:',
  'wss:',
];

/**
 * Checks one redirect URI. Structural problems (no URL, fragment, wildcard, userinfo, whitespace, too long, a scheme
 * that runs code) are `bad`. `usable`: https on a non-IP host (or a loopback IP), or http on loopback, within the
 * policy's hosts. `unusable`: anything else that is well-formed (another host for a CIMD client, a private-use scheme):
 * it is dropped and never gets a code (D-69).
 */
export function redirectUriVerdict(uri: unknown, policy: RedirectPolicy): RedirectVerdict {
  if (typeof uri !== 'string' || uri.length === 0) return 'bad:redirect_uri_type';
  if (uri.length > MAX_REDIRECT_URI_CHARS) return 'bad:redirect_uri_too_long';
  if (/[\s\p{Cc}]/u.test(uri)) return 'bad:redirect_uri_whitespace';
  if (uri.includes('#')) return 'bad:redirect_uri_fragment';
  if (uri.includes('*')) return 'bad:redirect_uri_wildcard';
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return 'bad:redirect_uri_not_url';
  }
  if (url.username !== '' || url.password !== '') return 'bad:redirect_uri_userinfo';
  if (DANGEROUS_SCHEMES.includes(url.protocol)) return 'bad:redirect_uri_scheme';
  const host = url.hostname;
  if (url.protocol === 'http:') return isLoopbackHost(host) ? 'usable' : 'bad:redirect_uri_http';
  if (url.protocol !== 'https:') return 'unusable';
  if (isLoopbackHost(host)) return 'usable';
  if (isIpLiteral(host)) return 'bad:redirect_uri_ip_literal';
  if (policy.clientHost !== undefined && host !== policy.clientHost) return 'unusable';
  if (policy.allowedHosts !== undefined && !policy.allowedHosts.includes(host))
    return 'bad:redirect_uri_host';
  return 'usable';
}

// ------------------------------------------------------------------------------------------------- DCR

/** `token_endpoint_auth_method` values a dynamic client may ask for (`private_key_jwt` and the like need a `jwks_uri` fetch). */
export const DCR_AUTH_METHODS: readonly string[] = ['none', 'client_secret_basic', 'client_secret_post'];
const SUPPORTED_GRANTS = ['authorization_code', 'refresh_token'];

export type RegistrationVerdict =
  | {
      readonly ok: true;
      /** What the provider is given: only the fields below, redirect URIs that are usable. */
      readonly body: string;
      readonly redirectUris: readonly string[];
    }
  | {
      readonly ok: false;
      readonly error: 'invalid_redirect_uri' | 'invalid_client_metadata';
      readonly reason: string;
    };

const refused = (
  error: 'invalid_redirect_uri' | 'invalid_client_metadata',
  reason: string,
): RegistrationVerdict => ({ ok: false, error, reason });

function stringList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > 10 || !value.every((s) => typeof s === 'string')) return null;
  return value as string[];
}

/**
 * RFC 7591 request checks, before the provider stores anything. Fields we do not use (`logo_uri`, `client_uri`,
 * `jwks_uri`, `software_statement`, contacts, ...) are not forwarded and never fetched or shown (the RFC lets a server
 * ignore metadata it does not support). An unsupported `token_endpoint_auth_method` or grant type is refused.
 */
export function checkRegistration(body: string, allowedHosts?: readonly string[]): RegistrationVerdict {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return refused('invalid_client_metadata', 'not_json');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return refused('invalid_client_metadata', 'not_object');
  }
  const meta = raw as Record<string, unknown>;
  const uris = meta['redirect_uris'];
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    return refused('invalid_redirect_uri', 'redirect_uris_count');
  }
  const policy: RedirectPolicy = allowedHosts === undefined ? {} : { allowedHosts };
  const usable: string[] = [];
  for (const uri of uris) {
    const verdict = redirectUriVerdict(uri, policy);
    if (verdict.startsWith('bad:')) return refused('invalid_redirect_uri', verdict.slice(4));
    if (verdict === 'usable') usable.push(uri as string);
  }
  if (usable.length === 0) return refused('invalid_redirect_uri', 'no_usable_redirect_uri');
  const forward: Record<string, unknown> = { redirect_uris: [...new Set(usable)] };
  if (meta['client_name'] !== undefined) {
    const name = safeClientName(meta['client_name']);
    if (name === null) return refused('invalid_client_metadata', 'client_name');
    forward['client_name'] = name;
  }
  const method = meta['token_endpoint_auth_method'];
  if (method !== undefined) {
    if (typeof method !== 'string' || !DCR_AUTH_METHODS.includes(method)) {
      return refused('invalid_client_metadata', 'token_endpoint_auth_method');
    }
    forward['token_endpoint_auth_method'] = method;
  }
  if (meta['grant_types'] !== undefined) {
    const grants = stringList(meta['grant_types']);
    if (grants === null || !grants.includes('authorization_code')) {
      return refused('invalid_client_metadata', 'grant_types');
    }
    // Grants we don't support (implicit, client_credentials, ...) are refused, not silently dropped: the client would
    // otherwise believe it holds a grant it will never get.
    if (!grants.every((g) => SUPPORTED_GRANTS.includes(g))) {
      return refused('invalid_client_metadata', 'grant_types');
    }
    forward['grant_types'] = [...new Set(grants)];
  }
  if (meta['response_types'] !== undefined) {
    const types = stringList(meta['response_types']);
    if (types === null || types.length !== 1 || types[0] !== 'code') {
      return refused('invalid_client_metadata', 'response_types');
    }
    forward['response_types'] = ['code'];
  }
  return { ok: true, body: JSON.stringify(forward), redirectUris: forward['redirect_uris'] as string[] };
}

// ------------------------------------------------------------------------------------------------- CIMD

/** The provider's client record for a metadata-document client (a public client; display fields: the name only). */
export interface MetadataDocumentClient {
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUris: readonly string[];
  readonly tokenEndpointAuthMethod: 'none';
  readonly grantTypes: readonly string[];
  readonly responseTypes: readonly string[];
  /** Epoch seconds of the fetch. */
  readonly registrationDate: number;
}

/** Validates a parsed document for `clientId` (the URL it was fetched from) into a client record. */
export function validateMetadataDocument(
  clientId: string,
  value: unknown,
  nowSeconds: number,
): MetadataDocumentClient {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ClientMetadataError('not_object');
  const doc = value as Record<string, unknown>;
  // Simple string comparison (draft §4.1): the document names exactly the URL it was served from.
  if (doc['client_id'] !== clientId) throw new ClientMetadataError('client_id_mismatch');
  const clientName = safeClientName(doc['client_name']);
  if (clientName === null) throw new ClientMetadataError('client_name');
  // Draft §4.1: no shared secrets. Only public clients here (`private_key_jwt` is out of scope).
  if ('client_secret' in doc || 'client_secret_expires_at' in doc)
    throw new ClientMetadataError('client_secret');
  const method = doc['token_endpoint_auth_method'];
  if (method !== undefined && method !== 'none') throw new ClientMetadataError('token_endpoint_auth_method');
  const strings = (v: unknown, fallback: readonly string[], what: string): readonly string[] => {
    if (v === undefined) return fallback;
    const list = stringList(v);
    if (list === null) throw new ClientMetadataError(what);
    return list;
  };
  // Grants we don't support are dropped; the code flow must be there.
  const grantTypes = strings(doc['grant_types'], ['authorization_code'], 'grant_types').filter((g) =>
    SUPPORTED_GRANTS.includes(g),
  );
  if (!grantTypes.includes('authorization_code')) throw new ClientMetadataError('grant_types');
  const responseTypes = strings(doc['response_types'], ['code'], 'response_types');
  if (!responseTypes.includes('code')) throw new ClientMetadataError('response_types');
  const uris = doc['redirect_uris'];
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    throw new ClientMetadataError('redirect_uris_count');
  }
  const clientHost = new URL(clientId).hostname;
  const redirectUris: string[] = [];
  for (const uri of uris) {
    const verdict = redirectUriVerdict(uri, { clientHost });
    if (verdict.startsWith('bad:')) throw new ClientMetadataError(verdict.slice(4));
    if (verdict === 'usable') redirectUris.push(uri as string);
  }
  if (redirectUris.length === 0) throw new ClientMetadataError('no_usable_redirect_uri');
  return Object.freeze({
    clientId,
    clientName,
    redirectUris: Object.freeze([...new Set(redirectUris)]),
    tokenEndpointAuthMethod: 'none',
    grantTypes: Object.freeze([...new Set(grantTypes)]),
    responseTypes: Object.freeze(['code']),
    registrationDate: nowSeconds,
  });
}

/** Cache lifetime (seconds) of a validated document from its `Cache-Control`, within our bounds. */
export function metadataCacheTtl(cacheControl: string | null): number {
  if (cacheControl === null) return CIMD_DEFAULT_TTL_S;
  const cc = cacheControl.toLowerCase();
  if (/(?:^|,)\s*(?:no-store|no-cache|private)\b/.test(cc)) return CIMD_MIN_TTL_S;
  const m =
    /(?:^|,)\s*s-maxage\s*=\s*"?(\d{1,10})/.exec(cc) ?? /(?:^|,)\s*max-age\s*=\s*"?(\d{1,10})/.exec(cc);
  if (m === null) return CIMD_DEFAULT_TTL_S;
  return Math.min(CIMD_MAX_TTL_S, Math.max(CIMD_MIN_TTL_S, Number(m[1])));
}

const JSON_TYPE = /^application\/(?:json|[a-z0-9.!#$&^_-]+\+json)$/;

/**
 * Reads at most `max` bytes of a body; null when it is larger (the stream is cancelled). Honours `signal` between chunks.
 */
export async function readBoundedBytes(
  body: ReadableStream<Uint8Array> | null,
  max: number,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  // An abort cancels the stream, which ends a pending read: a body that stops sending can't hold the request.
  const onAbort = (): void => {
    reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw new ClientMetadataError('timeout');
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new ClientMetadataError('timeout');
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return all;
}

/**
 * Fetches and validates the metadata document of `clientId` (already checked with {@link clientIdUrlProblem}).
 * Resolves the client record and its cache lifetime; throws {@link ClientMetadataError} otherwise. Nothing is cached
 * here: the caller stores a validated record only (errors are never cached, draft §4.4).
 */
export async function fetchMetadataDocument(
  clientId: string,
  fetcher: ClientMetadataFetch,
  nowSeconds: number,
  /** Tests shorten the time allowed; the server always uses {@link CIMD_TIMEOUT_MS}. */
  timeoutMs: number = CIMD_TIMEOUT_MS,
): Promise<{ readonly client: MetadataDocumentClient; readonly ttlSeconds: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response | undefined;
  try {
    try {
      // Raced with the timeout: a fetcher that ignores its signal still cannot hold the request past it.
      const timedOut = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
      });
      response = await Promise.race([fetcher(clientId, { signal: controller.signal }), timedOut]);
    } catch {
      throw new ClientMetadataError(controller.signal.aborted ? 'timeout' : 'fetch_failed');
    }
    // No redirects: a document must be served from its own URL (and a redirect could lead anywhere, T11).
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new ClientMetadataError('redirect');
    }
    if (response.status !== 200) throw new ClientMetadataError('http_status');
    const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (!JSON_TYPE.test(mediaType)) throw new ClientMetadataError('content_type');
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d{1,15}$/.test(declared) || Number(declared) > CIMD_MAX_BYTES)) {
      throw new ClientMetadataError('too_large');
    }
    let bytes: Uint8Array | null;
    try {
      bytes = await readBoundedBytes(response.body, CIMD_MAX_BYTES, controller.signal);
    } catch {
      throw new ClientMetadataError(controller.signal.aborted ? 'timeout' : 'fetch_failed');
    }
    if (bytes === null) throw new ClientMetadataError('too_large');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new ClientMetadataError('not_utf8');
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ClientMetadataError('not_json');
    }
    const client = validateMetadataDocument(clientId, value, nowSeconds);
    return { client, ttlSeconds: metadataCacheTtl(response.headers.get('cache-control')) };
  } catch (error) {
    await response?.body?.cancel().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
