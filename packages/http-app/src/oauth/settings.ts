// SPDX-License-Identifier: Apache-2.0
// The `AB_OAUTH*` deployment switches (P5-01), shared by `agility-bridge serve` and the Worker. Web-standard only.
//
//   AB_OAUTH                 on | off (default off): the OAuth 2.1 server (needs AB_PUBLIC_URL, which is the issuer)
//   AB_OAUTH_ACCESS_TTL      access-token lifetime (default 1h; 60s-24h)
//   AB_OAUTH_REFRESH_TTL     absolute refresh lifetime of a device authorization (default 30d; 1h-365d)
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
}

export type OAuthEnv = Readonly<Record<string, string | undefined>>;

/** The names this module reads (the hosts' allowlists). */
export const OAUTH_SETTING_NAMES: readonly string[] = Object.freeze([
  'AB_OAUTH',
  'AB_OAUTH_ACCESS_TTL',
  'AB_OAUTH_REFRESH_TTL',
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
  };
}
