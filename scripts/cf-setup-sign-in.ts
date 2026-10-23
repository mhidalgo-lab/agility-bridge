// SPDX-License-Identifier: Apache-2.0
// The sign-in part of `pnpm cf:setup --sign-in` (P4-13): collects the identity settings from the environment and the
// terminal, validates them with the parser the server boots with, and returns what to set. Client secrets are returned
// separately: the caller sends them to `wrangler secret put` on stdin and nowhere else (T8, T23, L-026).
import {
  IDENTITY_SECRET_NAMES,
  IDENTITY_SETTING_NAMES,
  IdentityConfigError,
  identitySettingsFromEnv,
  parsePublicUrl,
  providerRouteId,
} from '../packages/auth/src/index.ts';

export class SignInError extends Error {
  override name = 'SignInError';
}

export type ProviderKey = 'google' | 'github' | 'oidc' | 'cf-access';

interface Field {
  readonly name: string;
  readonly question: string;
  readonly required?: boolean;
}

interface ProviderSpec {
  readonly label: string;
  readonly secret?: string;
  readonly fields: readonly Field[];
  /** The variable whose presence in the environment selects the provider. */
  readonly trigger: string;
}

const PROVIDERS: Readonly<Record<ProviderKey, ProviderSpec>> = {
  google: {
    label: 'Google',
    secret: 'AB_GOOGLE_CLIENT_SECRET',
    trigger: 'AB_GOOGLE_CLIENT_ID',
    fields: [
      { name: 'AB_GOOGLE_CLIENT_ID', question: 'Google client id', required: true },
      { name: 'AB_GOOGLE_HOSTED_DOMAIN', question: 'Google Workspace domain to require (optional)' },
    ],
  },
  github: {
    label: 'GitHub',
    secret: 'AB_GITHUB_CLIENT_SECRET',
    trigger: 'AB_GITHUB_CLIENT_ID',
    fields: [{ name: 'AB_GITHUB_CLIENT_ID', question: 'GitHub client id', required: true }],
  },
  oidc: {
    label: 'OpenID Connect',
    secret: 'AB_OIDC_CLIENT_SECRET',
    trigger: 'AB_OIDC_CLIENT_ID',
    fields: [
      { name: 'AB_OIDC_ISSUER', question: 'OIDC issuer URL (https://...)', required: true },
      { name: 'AB_OIDC_CLIENT_ID', question: 'OIDC client id', required: true },
      { name: 'AB_OIDC_NAME', question: 'OIDC provider name for the callback path (optional)' },
      { name: 'AB_OIDC_LABEL', question: 'OIDC button label (optional)' },
      { name: 'AB_OIDC_SCOPES', question: 'OIDC scopes, must include openid (optional)' },
    ],
  },
  'cf-access': {
    label: 'Cloudflare Access',
    trigger: 'AB_CF_ACCESS_TEAM',
    fields: [
      { name: 'AB_CF_ACCESS_TEAM', question: 'Zero Trust team name', required: true },
      { name: 'AB_CF_ACCESS_AUD', question: 'Access application audience (AUD) tag', required: true },
    ],
  },
};

const POLICY_FIELDS: readonly Field[] = [
  { name: 'AB_LOGIN_ALLOW_EMAILS', question: 'Allowed e-mail addresses, comma separated (optional)' },
  { name: 'AB_LOGIN_ALLOW_DOMAINS', question: 'Allowed e-mail domains, comma separated (optional)' },
  {
    name: 'AB_LOGIN_ALLOW_GITHUB_ORGS',
    question: 'Allowed GitHub organizations, comma separated (optional)',
  },
  {
    name: 'AB_LOGIN_AUTO_PROVISION',
    question: 'Auto-provision allowlisted people as off, member or admin (optional)',
  },
];

export interface SignInDeps {
  /** Environment for the non-interactive mode. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Present only when stdin is a terminal. */
  readonly prompt?: ((question: string) => Promise<string>) | undefined;
  /** As `prompt`, without echo. */
  readonly promptSecret?: ((question: string) => Promise<string>) | undefined;
}

export interface SignInInput {
  /** The non-secret identity variables of the previous run (local config). */
  readonly existingVars: Readonly<Record<string, string>>;
  /** Names of the client secrets already stored on the Worker. */
  readonly haveSecrets: ReadonlySet<string>;
  /** The public URL when known; sign-in is validated against `placeholderUrl` otherwise. */
  readonly publicUrl: string | undefined;
  readonly placeholderUrl: string;
}

export interface SignInResult {
  /** Non-secret variables given now. */
  readonly vars: Readonly<Record<string, string>>;
  /** Client secrets given now: name to value. Never logged. */
  readonly secrets: Readonly<Record<string, string>>;
  /** Every non-secret identity variable after the merge (existing, given now, minus cleared). */
  readonly merged: Readonly<Record<string, string>>;
  readonly warnings: readonly string[];
  /** Provider route ids (`/auth/callback/<id>`). */
  readonly routeIds: readonly string[];
}

/** Names of the identity variables that are safe to keep in a config file. */
export const IDENTITY_VAR_NAMES: ReadonlySet<string> = new Set(
  IDENTITY_SETTING_NAMES.filter((n) => !IDENTITY_SECRET_NAMES.includes(n)),
);

/** The identity variables found in a config's `vars` (client secrets never). */
export function identityVars(vars: Readonly<Record<string, unknown>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars ?? {})) {
    if (IDENTITY_VAR_NAMES.has(k) && typeof v === 'string') out[k] = v;
  }
  return out;
}

const trim = (v: string | undefined): string => (v ?? '').trim();
const PROVIDER_KEYS = Object.keys(PROVIDERS) as ProviderKey[];

/**
 * Collect and validate. Order: the environment, then prompts; an empty answer keeps the existing value (or stored
 * secret) and `-` clears an optional variable. Throws `SignInError`; messages name variables, never values.
 */
export async function collectSignIn(deps: SignInDeps, input: SignInInput): Promise<SignInResult> {
  const ask = async (q: string): Promise<string> =>
    deps.prompt === undefined ? '' : trim(await deps.prompt(q));
  const askSecret = async (q: string): Promise<string> =>
    deps.promptSecret === undefined ? '' : trim(await deps.promptSecret(q));

  // Which providers: the environment decides when it names any; otherwise the terminal asks.
  let selected = PROVIDER_KEYS.filter((k) => trim(deps.env[PROVIDERS[k].trigger]) !== '');
  if (selected.length === 0 && deps.prompt !== undefined) {
    const answer = await ask(
      'Sign-in providers to configure now: google, github, oidc, cf-access (comma separated; empty = none): ',
    );
    const wanted = answer
      .toLowerCase()
      .split(/[\s,]+/)
      .filter((s) => s !== '');
    for (const w of wanted) {
      if (!PROVIDER_KEYS.includes(w as ProviderKey)) {
        throw new SignInError(`unknown sign-in provider "${w.slice(0, 20)}".`);
      }
    }
    selected = PROVIDER_KEYS.filter((k) => wanted.includes(k));
  }

  const vars: Record<string, string> = {};
  const clear = new Set<string>();
  const secrets: Record<string, string> = {};
  const existing = input.existingVars;

  const field = async (f: Field): Promise<void> => {
    let value = trim(deps.env[f.name]);
    if (value === '') {
      const current = existing[f.name];
      const hint = current === undefined ? '' : ` [${current.slice(0, 80)}]`;
      value = await ask(`${f.question}${hint}: `);
    }
    if (value === '') return;
    if (value === '-' && f.required !== true) clear.add(f.name);
    else vars[f.name] = value;
  };

  for (const key of selected) {
    const p = PROVIDERS[key];
    for (const f of p.fields) await field(f);
    if (p.secret !== undefined) {
      let secret = trim(deps.env[p.secret]);
      if (secret === '') {
        const kept = input.haveSecrets.has(p.secret) ? ' (empty keeps the stored one)' : '';
        secret = await askSecret(`${p.label} client secret (hidden)${kept}: `);
      }
      if (secret !== '') secrets[p.secret] = secret;
    }
  }
  if (selected.length > 0) for (const f of POLICY_FIELDS) await field(f);

  const merged: Record<string, string> = { ...existing, ...vars };
  for (const n of clear) delete merged[n];
  if (Object.keys(merged).length === 0) {
    throw new SignInError(
      '--sign-in found no provider: set a client id (AB_GOOGLE_CLIENT_ID, AB_GITHUB_CLIENT_ID, AB_OIDC_CLIENT_ID) or AB_CF_ACCESS_TEAM, or run in a terminal.',
    );
  }
  if (input.publicUrl !== undefined && parsePublicUrl(input.publicUrl) === null) {
    throw new SignInError(
      'the public URL must be an https origin (--domain or --public-url), e.g. https://bridge.example.com.',
    );
  }

  // Validate with the parser the server boots with. A secret stored on the Worker counts as present; its value is
  // never read.
  const usable: Record<string, string> = { ...merged };
  for (const name of IDENTITY_SECRET_NAMES) {
    const given = secrets[name];
    if (given !== undefined) usable[name] = given;
    else if (input.haveSecrets.has(name)) usable[name] = 'stored';
  }
  usable['AB_PUBLIC_URL'] = input.publicUrl ?? input.placeholderUrl;
  let settings: ReturnType<typeof identitySettingsFromEnv>;
  try {
    settings = identitySettingsFromEnv(usable);
  } catch (error) {
    if (error instanceof IdentityConfigError) throw new SignInError(error.message);
    throw error;
  }
  if (settings === null) throw new SignInError('--sign-in found no provider to configure.');
  return Object.freeze({
    vars,
    secrets,
    merged,
    warnings: settings.warnings,
    routeIds: settings.providers.filter((p) => p.kind !== 'cf-access').map(providerRouteId),
  });
}

/** A terminal question on stderr (stdout stays free); `hidden` turns echo off. */
export function ttyPrompt(hidden: boolean): (question: string) => Promise<string> {
  return (question) =>
    new Promise((resolveAnswer, reject) => {
      const stdin = process.stdin;
      process.stderr.write(question);
      let buf = '';
      const wasRaw = stdin.isRaw;
      if (hidden) stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');
      const done = (answer: string | Error): void => {
        stdin.off('data', onData);
        if (hidden) {
          stdin.setRawMode(wasRaw);
          process.stderr.write('\n');
        }
        stdin.pause();
        if (answer instanceof Error) reject(answer);
        else resolveAnswer(answer);
      };
      const onData = (chunk: string): void => {
        for (const ch of chunk) {
          if (ch === '\u0003') {
            done(new SignInError('cancelled'));
            return;
          }
          if (ch === '\r' || ch === '\n') {
            done(buf);
            return;
          }
          if (hidden && (ch === '\u007f' || ch === '\b')) buf = buf.slice(0, -1);
          else buf += ch;
        }
      };
      stdin.on('data', onData);
    });
}
