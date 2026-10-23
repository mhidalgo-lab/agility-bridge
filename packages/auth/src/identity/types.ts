// SPDX-License-Identifier: Apache-2.0
// The identity provider contract (P4-01, ADR-0009 step 2).

/**
 * Who the IdP vouches for. Only produced after every check passed: signature, issuer, audience, expiry, nonce (OIDC),
 * and a **verified** email address. `email` is lowercased.
 */
export interface VerifiedIdentity {
  /** Stored as `users.idp`: `google`, `github`, `cf-access`, `oidc:<name>`. */
  readonly idp: string;
  /** Stable subject at the IdP (`sub`, or GitHub's numeric user id). Never the email or a GitHub login. */
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: true;
  readonly displayName: string | null;
  /** GitHub only: the configured organizations the user is an active member of (lowercase). */
  readonly orgs?: readonly string[];
  /**
   * When the user last authenticated at the IdP (epoch ms), when the IdP says so: the ID token's `auth_time`, or the
   * issue time of a Cloudflare Access assertion. Re-authentication (P4-02) checks it; absent for providers that do not
   * report it (Google, GitHub).
   */
  readonly authenticatedAt?: number;
}

/** What the login route hands a redirect provider to build the authorization request. */
export interface AuthorizationRequest {
  /** Exact, pre-registered redirect URI (`<public URL>/auth/callback/<provider id>`). */
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  /** PKCE S256 challenge of the transaction's verifier. */
  readonly codeChallenge: string;
  /** Re-authentication (P4-02): ask the IdP to prompt for credentials again (OIDC `prompt=login`, `max_age=0`). */
  readonly reauth?: boolean;
}

/** What the callback route hands a redirect provider to finish the login. */
export interface AuthorizationResult {
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
  readonly nonce: string;
  /** RFC 9207 `iss` callback parameter, when present. */
  readonly issuer?: string;
}

interface ProviderBase {
  /** URL key (`google`, `github`, `oidc-corp`, `cf-access`): `[a-z0-9-]{1,40}`. */
  readonly id: string;
  /** Shown on the sign-in page. */
  readonly label: string;
  /** `users.idp` value of identities from this provider. */
  readonly idp: string;
}

/** Optional per-request hooks for `complete` (P4-13). */
export interface CompleteHooks {
  /** Runs best-effort follow-up work (Workers: `waitUntil`). Without it the work is awaited. */
  readonly background?: (task: Promise<unknown>) => void;
  /** Warnings; fields never carry secrets or tokens. */
  readonly warn?: (message: string, fields: Record<string, unknown>) => void;
}

/** Authorization code flow (Google, GitHub, generic OIDC). */
export interface RedirectIdentityProvider extends ProviderBase {
  readonly kind: 'redirect';
  authorizationUrl(request: AuthorizationRequest): Promise<URL>;
  complete(result: AuthorizationResult, hooks?: CompleteHooks): Promise<VerifiedIdentity>;
}

/** Identity asserted by a header from a trusted proxy (Cloudflare Access). */
export interface HeaderIdentityProvider extends ProviderBase {
  readonly kind: 'header';
  verify(headers: Headers): Promise<VerifiedIdentity>;
}

export type IdentityProvider = RedirectIdentityProvider | HeaderIdentityProvider;

/** Provider ids double as URL path segments. */
export const PROVIDER_ID_RE: RegExp = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/**
 * An IdP-asserted email address in the one form agility-bridge compares: printable ASCII, one `@`, lowercased; null
 * otherwise. Non-ASCII addresses are refused (P4-07): case folding maps some of them onto ASCII ones (the Kelvin sign
 * `\u212A` lowercases to `k`), so an IdP account with such an address could claim another user's row.
 */
export function canonicalEmail(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[\x21-\x3f\x41-\x7e]{1,64}@[\x21-\x3f\x41-\x7e]{1,255}$/.test(value))
    return null;
  return value.toLowerCase();
}
