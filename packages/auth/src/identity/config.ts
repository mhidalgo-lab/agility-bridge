// SPDX-License-Identifier: Apache-2.0
// Identity configuration from `AB_*` variables, shared by `agility-bridge serve` and the Worker (P4-01). Validation
// errors name the variable, never its value. Secrets (client secrets) are wrapped in `Secret` at once.
import { type Clock, type FetchLike, Secret } from '@agility-bridge/core';
import { createCloudflareAccessProvider, isAccessAudience, normalizeAccessTeam } from './cf-access.ts';
import { IdentityConfigError } from './errors.ts';
import { createGitHubProvider, GITHUB_ORG_RE } from './github.ts';
import { createGoogleProvider } from './google.ts';
import { checkEndpoint, isLoopbackHostname } from './http.ts';
import { createOidcProvider } from './oidc.ts';
import type { AutoProvision, LoginPolicy } from './policy.ts';
import type { IdentityProvider } from './types.ts';

/** Every identity setting; secrets (`*_CLIENT_SECRET`) are environment or Worker secrets, never `vars` or flags. */
export const IDENTITY_SETTING_NAMES: readonly string[] = Object.freeze([
  'AB_GOOGLE_CLIENT_ID',
  'AB_GOOGLE_CLIENT_SECRET',
  'AB_GOOGLE_HOSTED_DOMAIN',
  'AB_GITHUB_CLIENT_ID',
  'AB_GITHUB_CLIENT_SECRET',
  'AB_OIDC_ISSUER',
  'AB_OIDC_CLIENT_ID',
  'AB_OIDC_CLIENT_SECRET',
  'AB_OIDC_NAME',
  'AB_OIDC_LABEL',
  'AB_OIDC_SCOPES',
  'AB_CF_ACCESS_TEAM',
  'AB_CF_ACCESS_AUD',
  'AB_LOGIN_ALLOW_EMAILS',
  'AB_LOGIN_ALLOW_DOMAINS',
  'AB_LOGIN_ALLOW_GITHUB_ORGS',
  'AB_LOGIN_AUTO_PROVISION',
]);

/** The client secrets that Node also accepts from a 0600 file (`<name>_FILE`). */
export const IDENTITY_SECRET_NAMES: readonly string[] = Object.freeze([
  'AB_GOOGLE_CLIENT_SECRET',
  'AB_GITHUB_CLIENT_SECRET',
  'AB_OIDC_CLIENT_SECRET',
]);

export type IdentityEnv = Readonly<Record<string, string | undefined>>;

export type ProviderSettings =
  | {
      readonly kind: 'google';
      readonly clientId: string;
      readonly clientSecret: Secret;
      readonly hostedDomain?: string;
    }
  | { readonly kind: 'github'; readonly clientId: string; readonly clientSecret: Secret }
  | {
      readonly kind: 'oidc';
      readonly name: string;
      readonly label: string;
      readonly issuer: string;
      readonly clientId: string;
      readonly clientSecret: Secret;
      readonly scopes?: readonly string[];
    }
  | { readonly kind: 'cf-access'; readonly team: string; readonly audience: string };

export interface IdentitySettings {
  /** Origin the browser uses (`https://bridge.example.com`); redirect URIs are built from it. */
  readonly publicUrl: string;
  readonly providers: readonly ProviderSettings[];
  readonly policy: LoginPolicy;
  /** Boot warnings (never values). */
  readonly warnings: readonly string[];
}

const EMAIL_RE = /^[^\s@,]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}$/;
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const CLIENT_ID_RE = /^[\x21-\x7e]{1,512}$/;

const get = (env: IdentityEnv, name: string): string | undefined => {
  const v = env[name]?.trim();
  return v === undefined || v === '' ? undefined : v;
};

const list = (env: IdentityEnv, name: string): string[] =>
  (get(env, name) ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '');

function clientPair(
  env: IdentityEnv,
  idName: string,
  secretName: string,
): { clientId: string; clientSecret: Secret } | undefined {
  const clientId = get(env, idName);
  const secret = get(env, secretName);
  if (clientId === undefined) {
    if (secret !== undefined)
      throw new IdentityConfigError(idName, `${secretName} is set but ${idName} is not.`);
    return undefined;
  }
  if (!CLIENT_ID_RE.test(clientId))
    throw new IdentityConfigError(idName, `${idName} is not a valid client id.`);
  if (secret === undefined) {
    throw new IdentityConfigError(secretName, `${idName} is set but its secret ${secretName} is not.`);
  }
  return { clientId, clientSecret: new Secret(secret) };
}

/** Origin-only URL: https, or http for a loopback host (local `serve`). */
export function parsePublicUrl(value: string): string | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '') return null;
  if (u.pathname !== '/' && u.pathname !== '') return null;
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHostname(u.hostname))) return null;
  return u.origin;
}

/**
 * Read the identity settings. Returns `null` when no provider is configured (the `/auth/*` routes stay off). Throws
 * `IdentityConfigError` for a half-configured provider or an invalid value.
 */
export function identitySettingsFromEnv(env: IdentityEnv): IdentitySettings | null {
  const providers: ProviderSettings[] = [];
  const warnings: string[] = [];

  const google = clientPair(env, 'AB_GOOGLE_CLIENT_ID', 'AB_GOOGLE_CLIENT_SECRET');
  if (google) {
    const hd = get(env, 'AB_GOOGLE_HOSTED_DOMAIN')?.toLowerCase();
    if (hd !== undefined && !DOMAIN_RE.test(hd)) {
      throw new IdentityConfigError(
        'AB_GOOGLE_HOSTED_DOMAIN',
        'AB_GOOGLE_HOSTED_DOMAIN is not a domain name.',
      );
    }
    providers.push({ kind: 'google', ...google, ...(hd === undefined ? {} : { hostedDomain: hd }) });
  }

  const github = clientPair(env, 'AB_GITHUB_CLIENT_ID', 'AB_GITHUB_CLIENT_SECRET');
  if (github) providers.push({ kind: 'github', ...github });

  const oidc = clientPair(env, 'AB_OIDC_CLIENT_ID', 'AB_OIDC_CLIENT_SECRET');
  const issuerRaw = get(env, 'AB_OIDC_ISSUER');
  if (oidc || issuerRaw !== undefined) {
    if (!oidc)
      throw new IdentityConfigError(
        'AB_OIDC_CLIENT_ID',
        'AB_OIDC_ISSUER is set but AB_OIDC_CLIENT_ID is not.',
      );
    if (issuerRaw === undefined) {
      throw new IdentityConfigError('AB_OIDC_ISSUER', 'AB_OIDC_CLIENT_ID is set but AB_OIDC_ISSUER is not.');
    }
    const issuerUrl = checkEndpoint(issuerRaw, true);
    if (issuerUrl === null || issuerUrl.search !== '') {
      throw new IdentityConfigError(
        'AB_OIDC_ISSUER',
        'AB_OIDC_ISSUER must be the https issuer URL (http only for a loopback test IdP).',
      );
    }
    const name = get(env, 'AB_OIDC_NAME')?.toLowerCase() ?? 'oidc';
    if (!NAME_RE.test(name)) {
      throw new IdentityConfigError(
        'AB_OIDC_NAME',
        'AB_OIDC_NAME must be 1-32 lowercase letters, digits or dashes.',
      );
    }
    const scopes = get(env, 'AB_OIDC_SCOPES')
      ?.split(/[\s,]+/)
      .filter((s) => s !== '');
    if (
      scopes !== undefined &&
      (!scopes.includes('openid') || scopes.some((s) => !/^[\x21-\x7e]{1,100}$/.test(s)))
    ) {
      throw new IdentityConfigError('AB_OIDC_SCOPES', 'AB_OIDC_SCOPES must include openid.');
    }
    const label = (get(env, 'AB_OIDC_LABEL') ?? 'Single sign-on').slice(0, 60);
    // The configured string is the issuer identifier, compared exactly with discovery and tokens.
    providers.push({
      kind: 'oidc',
      name,
      label,
      issuer: issuerRaw,
      ...oidc,
      ...(scopes === undefined ? {} : { scopes }),
    });
  }

  const team = get(env, 'AB_CF_ACCESS_TEAM');
  const aud = get(env, 'AB_CF_ACCESS_AUD');
  if (team !== undefined || aud !== undefined) {
    if (team === undefined || normalizeAccessTeam(team) === null) {
      throw new IdentityConfigError(
        'AB_CF_ACCESS_TEAM',
        'AB_CF_ACCESS_TEAM must be your Zero Trust team name (or <team>.cloudflareaccess.com) when AB_CF_ACCESS_AUD is set.',
      );
    }
    if (aud === undefined || !isAccessAudience(aud)) {
      throw new IdentityConfigError(
        'AB_CF_ACCESS_AUD',
        "AB_CF_ACCESS_AUD must be the Access application's Application Audience (AUD) tag.",
      );
    }
    providers.push({ kind: 'cf-access', team: normalizeAccessTeam(team) as string, audience: aud });
  }

  const emails = list(env, 'AB_LOGIN_ALLOW_EMAILS');
  for (const e of emails) {
    if (!EMAIL_RE.test(e))
      throw new IdentityConfigError('AB_LOGIN_ALLOW_EMAILS', 'AB_LOGIN_ALLOW_EMAILS has an invalid address.');
  }
  const domains = list(env, 'AB_LOGIN_ALLOW_DOMAINS').map((d) => d.replace(/^@/, ''));
  for (const d of domains) {
    if (!DOMAIN_RE.test(d))
      throw new IdentityConfigError(
        'AB_LOGIN_ALLOW_DOMAINS',
        'AB_LOGIN_ALLOW_DOMAINS has an invalid domain.',
      );
  }
  const githubOrgs = list(env, 'AB_LOGIN_ALLOW_GITHUB_ORGS');
  for (const o of githubOrgs) {
    if (!GITHUB_ORG_RE.test(o)) {
      throw new IdentityConfigError(
        'AB_LOGIN_ALLOW_GITHUB_ORGS',
        'AB_LOGIN_ALLOW_GITHUB_ORGS has an invalid organization name.',
      );
    }
  }
  const autoRaw = (get(env, 'AB_LOGIN_AUTO_PROVISION') ?? 'off').toLowerCase();
  if (autoRaw !== 'off' && autoRaw !== 'member' && autoRaw !== 'admin') {
    throw new IdentityConfigError(
      'AB_LOGIN_AUTO_PROVISION',
      'AB_LOGIN_AUTO_PROVISION must be off, member or admin.',
    );
  }
  const autoProvision = autoRaw as AutoProvision;

  if (providers.length === 0) {
    const stray = ['AB_LOGIN_ALLOW_EMAILS', 'AB_LOGIN_ALLOW_DOMAINS', 'AB_LOGIN_ALLOW_GITHUB_ORGS'].filter(
      (n) => get(env, n) !== undefined,
    );
    if (stray.length > 0) {
      throw new IdentityConfigError(
        stray[0] as string,
        `${stray[0]} is set but no identity provider is configured.`,
      );
    }
    return null;
  }

  const publicRaw = get(env, 'AB_PUBLIC_URL');
  const publicUrl = publicRaw === undefined ? null : parsePublicUrl(publicRaw);
  if (publicUrl === null) {
    throw new IdentityConfigError(
      'AB_PUBLIC_URL',
      'Sign-in needs AB_PUBLIC_URL: the origin browsers use, e.g. https://bridge.example.com (http only for localhost).',
    );
  }
  if (githubOrgs.length > 0 && !providers.some((p) => p.kind === 'github')) {
    warnings.push(
      'AB_LOGIN_ALLOW_GITHUB_ORGS is set but GitHub sign-in is not configured: it has no effect.',
    );
  }
  if (autoProvision !== 'off' && emails.length + domains.length + githubOrgs.length === 0) {
    warnings.push(
      `AB_LOGIN_AUTO_PROVISION=${autoProvision} has no effect without an AB_LOGIN_ALLOW_* allowlist.`,
    );
  }
  if (autoProvision === 'off' && emails.length + domains.length + githubOrgs.length > 0) {
    warnings.push(
      'An AB_LOGIN_ALLOW_* allowlist is set but AB_LOGIN_AUTO_PROVISION=off: only users who already exist can sign in; unknown identities are refused.',
    );
  }
  if (autoProvision === 'admin') {
    warnings.push(
      'AB_LOGIN_AUTO_PROVISION=admin: every allowlisted identity becomes an administrator on first sign-in.',
    );
  }
  return Object.freeze({
    publicUrl,
    providers: Object.freeze(providers),
    policy: Object.freeze({
      emails: Object.freeze(emails),
      domains: Object.freeze(domains),
      githubOrgs: Object.freeze(githubOrgs),
      autoProvision,
    }),
    warnings: Object.freeze(warnings),
  });
}

/**
 * The id a provider is reached by: the `/auth/login/<id>` path segment and the admin API's `provider` value. Generic
 * OIDC providers are `oidc` (default name) or `oidc-<name>`; every other provider is its kind. One function so that the
 * CLI's local `setup-link` and the HTTP app never disagree (phase 4 review L2).
 */
export function providerRouteId(p: ProviderSettings): string {
  if (p.kind !== 'oidc') return p.kind;
  return p.name === 'oidc' ? 'oidc' : `oidc-${p.name}`;
}

/** Build the providers of `settings`. `fetch` reaches the IdPs (tests inject a mock IdP). */
export function createIdentityProviders(
  settings: Pick<IdentitySettings, 'providers' | 'policy'>,
  deps: { readonly fetch?: FetchLike; readonly clock?: Clock } = {},
): IdentityProvider[] {
  const common = {
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
  };
  return settings.providers.map((p): IdentityProvider => {
    switch (p.kind) {
      case 'google':
        return createGoogleProvider({
          clientId: p.clientId,
          clientSecret: p.clientSecret,
          ...(p.hostedDomain === undefined ? {} : { hostedDomain: p.hostedDomain }),
          ...common,
        });
      case 'github':
        return createGitHubProvider({
          clientId: p.clientId,
          clientSecret: p.clientSecret,
          orgs: settings.policy.githubOrgs,
          ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
        });
      case 'oidc':
        return createOidcProvider({
          id: providerRouteId(p),
          label: p.label,
          idp: `oidc:${p.name}`,
          issuer: p.issuer,
          clientId: p.clientId,
          clientSecret: p.clientSecret,
          ...(p.scopes === undefined ? {} : { scopes: p.scopes }),
          ...common,
        });
      default:
        return createCloudflareAccessProvider({ team: p.team, audience: p.audience, ...common });
    }
  });
}
