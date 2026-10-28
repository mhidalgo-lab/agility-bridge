// SPDX-License-Identifier: Apache-2.0
// The `AB_OAUTH*` deployment switches (P5-01), shared by `agility-bridge serve` and the Worker. Web-standard only.
//
//   AB_OAUTH                 on | off (default off): the OAuth 2.1 server (needs AB_PUBLIC_URL, which is the issuer)
//   AB_OAUTH_ACCESS_TTL      access-token lifetime (default 1h; 60s-24h)
//   AB_OAUTH_REFRESH_TTL     absolute refresh lifetime of a device authorization (default 30d; 1h-365d)
//   AB_OAUTH_CIMD            on | off (default on): Client ID Metadata Documents (P5-03); needs a guarded fetcher
//   AB_OAUTH_CIMD_MAX_CLIENTS   stored document clients at once (default 200; 1-500)
//   AB_OAUTH_CIMD_FETCH_LIMIT   document fetches one address may cause per hour (default 20; 1-10000)
//   AB_OAUTH_DCR             on | off (default on): Dynamic Client Registration, RFC 7591 (P5-03, D-68)
//   AB_OAUTH_DCR_MAX_CLIENTS    live dynamic registrations at once (default 200; 1-500)
//   AB_OAUTH_DCR_IP_LIMIT       registrations one address may make per hour (default 10; 1-10000)
//   AB_OAUTH_DCR_REDIRECT_HOSTS comma list: https redirect hosts a dynamic client may use (default: any; loopback always)
//   AB_OAUTH_DCR_LIMIT          registrations the whole deployment accepts per hour (default 100; 1-100000) (P5-09)
//   AB_OAUTH_CIMD_LIMIT         document fetches the whole deployment makes per hour (default 200; 1-100000)
//   AB_OAUTH_AUTHORIZE_IP_LIMIT, AB_OAUTH_AUTHORIZE_LIMIT   authorization requests per 10 minutes, per address / in all (30, 600)
//   AB_OAUTH_CONSENT_IP_LIMIT, AB_OAUTH_CONSENT_LIMIT       consent form posts per 10 minutes, per address / in all (30, 300)
//   AB_OAUTH_TOKEN_FAILURE_IP_LIMIT, AB_OAUTH_TOKEN_FAILURE_LIMIT   failed token requests per 10 minutes (20, 300)
//   AB_OAUTH_DCR_UNUSED_TTL     how long a registration that never exchanged a code lives (default 24h; 1h-7d)
//   AB_OAUTH_REFRESH_REUSE_WINDOW  how long a spent refresh token is answered with the same successor (default 30s;
//                            0-120s, 0 = strict single use, not longer than the access lifetime); later reuse revokes
//   AB_OAUTH_IDLE_TTL        a device unused this long is refused at its next refresh (default off; 1h-365d) (P5-14)
// Durations: a number of seconds, or a number with s, m, h or d (`90m`, `12h`, `30d`).

/** A refused `AB_OAUTH*` value; `variable` names it for the host's error message. */
export class OAuthConfigError extends Error {
  readonly variable: string;
  constructor(variable: string, message: string) {
    super(message);
    this.name = 'OAuthConfigError';
    this.variable = variable;
  }
}

/** What the variables configure. */
export interface OAuthSettings {
  readonly accessTokenTtlSeconds?: number;
  readonly refreshTokenTtlSeconds?: number;
  /** `AB_OAUTH_CIMD=off`: never resolve a URL `client_id` (default: on when the host can fetch safely). */
  readonly clientMetadataDocuments?: boolean;
  readonly clientMetadataMaxClients?: number;
  readonly clientMetadataFetchLimit?: number;
  /** `AB_OAUTH_DCR=off`: no `/oauth/register` (default on). */
  readonly registration?: boolean;
  readonly registrationMaxClients?: number;
  readonly registrationIpLimit?: number;
  readonly registrationRedirectHosts?: readonly string[];
  readonly registrationUnusedTtlSeconds?: number;
  readonly registrationHourlyLimit?: number;
  readonly clientMetadataHourlyLimit?: number;
  readonly authorizeIpLimit?: number;
  readonly authorizeLimit?: number;
  readonly consentIpLimit?: number;
  readonly consentLimit?: number;
  readonly tokenFailureIpLimit?: number;
  readonly tokenFailureLimit?: number;
  readonly refreshReuseWindowSeconds?: number;
  readonly idleTtlSeconds?: number;
}

export type OAuthEnv = Readonly<Record<string, string | undefined>>;

/** The names this module reads (the hosts' allowlists). */
export const OAUTH_SETTING_NAMES: readonly string[] = Object.freeze([
  'AB_OAUTH',
  'AB_OAUTH_ACCESS_TTL',
  'AB_OAUTH_REFRESH_TTL',
  'AB_OAUTH_CIMD',
  'AB_OAUTH_CIMD_MAX_CLIENTS',
  'AB_OAUTH_CIMD_FETCH_LIMIT',
  'AB_OAUTH_DCR',
  'AB_OAUTH_DCR_MAX_CLIENTS',
  'AB_OAUTH_DCR_IP_LIMIT',
  'AB_OAUTH_DCR_REDIRECT_HOSTS',
  'AB_OAUTH_DCR_UNUSED_TTL',
  'AB_OAUTH_DCR_LIMIT',
  'AB_OAUTH_CIMD_LIMIT',
  'AB_OAUTH_AUTHORIZE_IP_LIMIT',
  'AB_OAUTH_AUTHORIZE_LIMIT',
  'AB_OAUTH_CONSENT_IP_LIMIT',
  'AB_OAUTH_CONSENT_LIMIT',
  'AB_OAUTH_TOKEN_FAILURE_IP_LIMIT',
  'AB_OAUTH_TOKEN_FAILURE_LIMIT',
  'AB_OAUTH_REFRESH_REUSE_WINDOW',
  'AB_OAUTH_IDLE_TTL',
]);

const DURATION_RE = /^(\d{1,8})([smhd]?)$/;
const UNIT_SECONDS: Readonly<Record<string, number>> = { '': 1, s: 1, m: 60, h: 3600, d: 86_400 };

function text(env: OAuthEnv, name: string): string | undefined {
  const t = env[name]?.trim();
  return t === undefined || t === '' ? undefined : t;
}

/** A duration variable in seconds, within [min, max]; undefined when unset. */
function duration(env: OAuthEnv, name: string, min: number, max: number, range: string): number | undefined {
  const raw = text(env, name)?.toLowerCase();
  if (raw === undefined) return undefined;
  const m = DURATION_RE.exec(raw);
  const seconds = m === null ? Number.NaN : Number(m[1]) * (UNIT_SECONDS[m[2] ?? ''] ?? Number.NaN);
  if (!Number.isSafeInteger(seconds) || seconds < min || seconds > max) {
    throw new OAuthConfigError(
      name,
      `${name} must be a duration between ${range} (e.g. 3600, 90m, 12h, 30d).`,
    );
  }
  return seconds;
}

function switchSetting(env: OAuthEnv, name: string): boolean | undefined {
  const raw = text(env, name)?.toLowerCase();
  if (raw === undefined) return undefined;
  if (raw !== 'on' && raw !== 'off') throw new OAuthConfigError(name, `${name} must be on or off.`);
  return raw === 'on';
}

function count(env: OAuthEnv, name: string, min: number, max: number): number | undefined {
  const raw = text(env, name);
  if (raw === undefined) return undefined;
  const n = /^\d{1,6}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new OAuthConfigError(name, `${name} must be a whole number between ${min} and ${max}.`);
  }
  return n;
}

/** A host name list: lowercase DNS names (no scheme, port or path), at most 50. */
function hostList(env: OAuthEnv, name: string): readonly string[] | undefined {
  const raw = text(env, name);
  if (raw === undefined) return undefined;
  const hosts = raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== '');
  const valid = hosts.every(
    (h) =>
      h.length <= 253 &&
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(h),
  );
  if (hosts.length === 0 || hosts.length > 50 || !valid) {
    throw new OAuthConfigError(name, `${name} must be a comma-separated list of host names (at most 50).`);
  }
  return [...new Set(hosts)];
}

/**
 * The OAuth settings, or null when `AB_OAUTH` is off (the default). `publicUrl`: whether `AB_PUBLIC_URL` is set; it is
 * the issuer every token and metadata document names, so OAuth cannot run without it.
 */
export function oauthSettingsFromEnv(env: OAuthEnv, publicUrl: boolean): OAuthSettings | null {
  const flag = text(env, 'AB_OAUTH')?.toLowerCase();
  if (flag !== undefined && flag !== 'on' && flag !== 'off') {
    throw new OAuthConfigError('AB_OAUTH', 'AB_OAUTH must be on or off.');
  }
  const accessTokenTtlSeconds = duration(env, 'AB_OAUTH_ACCESS_TTL', 60, 86_400, '60s and 24h');
  const refreshTokenTtlSeconds = duration(env, 'AB_OAUTH_REFRESH_TTL', 3_600, 365 * 86_400, '1h and 365d');
  if (
    accessTokenTtlSeconds !== undefined &&
    refreshTokenTtlSeconds !== undefined &&
    refreshTokenTtlSeconds < accessTokenTtlSeconds
  ) {
    throw new OAuthConfigError(
      'AB_OAUTH_REFRESH_TTL',
      'AB_OAUTH_REFRESH_TTL must not be shorter than AB_OAUTH_ACCESS_TTL.',
    );
  }
  const clientMetadataDocuments = switchSetting(env, 'AB_OAUTH_CIMD');
  const clientMetadataMaxClients = count(env, 'AB_OAUTH_CIMD_MAX_CLIENTS', 1, 500);
  const clientMetadataFetchLimit = count(env, 'AB_OAUTH_CIMD_FETCH_LIMIT', 1, 10_000);
  const registration = switchSetting(env, 'AB_OAUTH_DCR');
  const registrationMaxClients = count(env, 'AB_OAUTH_DCR_MAX_CLIENTS', 1, 500);
  const registrationIpLimit = count(env, 'AB_OAUTH_DCR_IP_LIMIT', 1, 10_000);
  const registrationRedirectHosts = hostList(env, 'AB_OAUTH_DCR_REDIRECT_HOSTS');
  const registrationUnusedTtlSeconds = duration(
    env,
    'AB_OAUTH_DCR_UNUSED_TTL',
    3_600,
    7 * 86_400,
    '1h and 7d',
  );
  const registrationHourlyLimit = count(env, 'AB_OAUTH_DCR_LIMIT', 1, 100_000);
  const clientMetadataHourlyLimit = count(env, 'AB_OAUTH_CIMD_LIMIT', 1, 100_000);
  const authorizeIpLimit = count(env, 'AB_OAUTH_AUTHORIZE_IP_LIMIT', 1, 100_000);
  const authorizeLimit = count(env, 'AB_OAUTH_AUTHORIZE_LIMIT', 1, 100_000);
  const consentIpLimit = count(env, 'AB_OAUTH_CONSENT_IP_LIMIT', 1, 100_000);
  const consentLimit = count(env, 'AB_OAUTH_CONSENT_LIMIT', 1, 100_000);
  const tokenFailureIpLimit = count(env, 'AB_OAUTH_TOKEN_FAILURE_IP_LIMIT', 1, 100_000);
  const tokenFailureLimit = count(env, 'AB_OAUTH_TOKEN_FAILURE_LIMIT', 1, 100_000);
  const refreshReuseWindowSeconds = duration(env, 'AB_OAUTH_REFRESH_REUSE_WINDOW', 0, 120, '0s and 120s');
  if (
    refreshReuseWindowSeconds !== undefined &&
    refreshReuseWindowSeconds > (accessTokenTtlSeconds ?? 3_600)
  ) {
    throw new OAuthConfigError(
      'AB_OAUTH_REFRESH_REUSE_WINDOW',
      'AB_OAUTH_REFRESH_REUSE_WINDOW must not be longer than AB_OAUTH_ACCESS_TTL.',
    );
  }
  const idleTtlSeconds = duration(env, 'AB_OAUTH_IDLE_TTL', 3_600, 365 * 86_400, '1h and 365d');
  if (flag !== 'on') return null;
  if (!publicUrl) {
    throw new OAuthConfigError(
      'AB_OAUTH',
      'AB_OAUTH=on needs AB_PUBLIC_URL: the public address is the issuer of every token.',
    );
  }
  return {
    ...(accessTokenTtlSeconds === undefined ? {} : { accessTokenTtlSeconds }),
    ...(refreshTokenTtlSeconds === undefined ? {} : { refreshTokenTtlSeconds }),
    ...(clientMetadataDocuments === undefined ? {} : { clientMetadataDocuments }),
    ...(clientMetadataMaxClients === undefined ? {} : { clientMetadataMaxClients }),
    ...(clientMetadataFetchLimit === undefined ? {} : { clientMetadataFetchLimit }),
    ...(registration === undefined ? {} : { registration }),
    ...(registrationMaxClients === undefined ? {} : { registrationMaxClients }),
    ...(registrationIpLimit === undefined ? {} : { registrationIpLimit }),
    ...(registrationRedirectHosts === undefined ? {} : { registrationRedirectHosts }),
    ...(registrationUnusedTtlSeconds === undefined ? {} : { registrationUnusedTtlSeconds }),
    ...(registrationHourlyLimit === undefined ? {} : { registrationHourlyLimit }),
    ...(clientMetadataHourlyLimit === undefined ? {} : { clientMetadataHourlyLimit }),
    ...(authorizeIpLimit === undefined ? {} : { authorizeIpLimit }),
    ...(authorizeLimit === undefined ? {} : { authorizeLimit }),
    ...(consentIpLimit === undefined ? {} : { consentIpLimit }),
    ...(consentLimit === undefined ? {} : { consentLimit }),
    ...(tokenFailureIpLimit === undefined ? {} : { tokenFailureIpLimit }),
    ...(tokenFailureLimit === undefined ? {} : { tokenFailureLimit }),
    ...(refreshReuseWindowSeconds === undefined ? {} : { refreshReuseWindowSeconds }),
    ...(idleTtlSeconds === undefined ? {} : { idleTtlSeconds }),
  };
}
