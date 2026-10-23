// SPDX-License-Identifier: Apache-2.0
// Central secret redaction (THREAT_MODEL T8, L-117). Every log line, error message and audit record passes through it.
// Every pattern does work linear in its input (bounded prefixes, no nested unbounded repetition): text that came from
// Agility reaches redact() and must not be able to stall it.

export const REDACTED = '[REDACTED]';

/** Value patterns: each match is replaced; the replacer keeps a short, non-secret prefix for debugging. */
const VALUE_PATTERNS: ReadonlyArray<[RegExp, (match: string, ...groups: string[]) => string]> = [
  // agility-bridge device, admin and setup tokens (ARCHITECTURE §4): ab_live_ / ab_test_ / ab_admin_ / ab_setup_ + random.
  [/\bab_(live|test|admin|setup)_[A-Za-z0-9_-]{8,}/g, (_m, kind) => `ab_${kind}_${REDACTED}`],
  // Admin session and sign-in cookies (P4-02, P4-01): `__Host-ab_session=<user>.<secret>`, `ab_login=<binding>`.
  [/((?:__Host-)?ab_(?:session|login))(\s*=\s*)[^\s;,"]+/g, (_m, name, sep) => `${name}${sep}${REDACTED}`],
  // Bearer credentials in headers or messages (Agility access tokens travel this way).
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (_m, scheme) => `${scheme} ${REDACTED}`],
  // Authorization headers with any scheme (Basic, Token, Digest, custom): the scheme stays, the credential goes. A
  // quoted (JSON) value is cut at its closing quote; a header line to its end, because Digest-style parameters hold
  // quotes and commas.
  [
    /\b((?:proxy-)?authorization"?\s*[:=]\s*)(?:(")([A-Za-z][A-Za-z0-9-]*\s+)?(?:\\.|[^"\\\r\n])+|([A-Za-z][A-Za-z0-9-]*\s+)?[^\r\n]+)/gi,
    (_m, name, quote, quotedScheme, scheme) =>
      quote ? `${name}"${quotedScheme ?? ''}${REDACTED}` : `${name}${scheme ?? ''}${REDACTED}`,
  ],
  // key/value assignments: x-api-key: v, apiKey=v, AB_MASTER_KEY=v, AB_AGILITY_TOKEN=v, DB_PASSWORD=v,
  // client_secret=v, access_token=v. A name prefix is allowed; only its last 40 characters are matched (bounded).
  [
    /([A-Za-z0-9_.-]{0,40}?(?:api[_-]?key|(?:master|access|private)[_-]?key|passw(?:or)?d|secret|token|credentials?|cookie))("?\s*[:=]\s*"?)([^\s",;}&]+)/gi,
    (_m, name, sep) => `${name}${sep}${REDACTED}`,
  ],
];

/** Secret shapes that show up in free text (log lines, error messages, URLs) beyond the value patterns above. */
const FREE_TEXT_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // JSON web tokens, also one cut short at the end of the text.
  [
    /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.(?:[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*|[A-Za-z0-9_-]*$)/g,
    '[REDACTED_JWT]',
  ],
  // AWS access key ids; GitHub, Slack, Stripe and OpenAI-style tokens.
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[REDACTED_TOKEN]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED_TOKEN]'],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g, '[REDACTED_TOKEN]'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, '[REDACTED_TOKEN]'],
  // agility-bridge master keys: v<N>: + 32 bytes in base64 (ADR-0007).
  [/\bv[0-9]{1,3}:[A-Za-z0-9+/]{43}=/g, '[REDACTED_MASTER_KEY]'],
  // Credentials in URLs: scheme://user:password@host.
  [/([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[REDACTED]@'],
  // PEM private key bodies.
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    '[REDACTED_PRIVATE_KEY]',
  ],
];

/** Object keys whose values are always redacted, whatever they contain. */
const SECRET_KEY_RE =
  /^(api[-_]?key|x-api-key|authorization|proxy-authorization|token|access[-_]?token|refresh[-_]?token|id[-_]?token|password|secret|client[-_]?secret|master[-_]?key|cookie|set-cookie|x-csrf-token|csrf|_csrf|csrf[-_]?token)$/i;

export function isSecretKeyName(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

/** Redact secrets inside a string. Idempotent. */
export function redact(input: string): string {
  let out = input;
  for (const [re, replace] of VALUE_PATTERNS) out = out.replace(re, replace as (m: string) => string);
  for (const [re, replacement] of FREE_TEXT_PATTERNS) out = out.replace(re, replacement);
  return out;
}

const MAX_DEPTH = 8;

/**
 * Deep-redact any value for logging: strings are scrubbed, secret-named keys are blanked, `Secret` instances (and
 * anything whose `toJSON` returns REDACTED) stay redacted. Cycles and excessive depth are cut.
 */
export function redactValue(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[MAX_DEPTH]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (value instanceof Error) return { name: value.name, message: redact(value.message) };
  const maybeJson = (value as { toJSON?: () => unknown }).toJSON;
  if (typeof maybeJson === 'function' && !(value instanceof Date)) {
    return redactValue(maybeJson.call(value), depth + 1, seen);
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value))
    out[k] = isSecretKeyName(k) ? REDACTED : redactValue(v, depth + 1, seen);
  return out;
}
