// SPDX-License-Identifier: Apache-2.0
// Credential validation (P2-13, THREAT_MODEL A5, A9, A14): whose token it is, which Agility projects it reaches, and
// whether it works — and, before any token is sent to a new or changed instance origin, an unauthenticated `meta.v1`
// probe that the address really is Agility (L-054). Results carry a safe error code, never Agility text.
import {
  AbError,
  type CircuitBreakers,
  type Clock,
  type CredentialLimiters,
  compileQuery,
  createBudget,
  DEFAULT_LIMITS,
  ErrorCode,
  type FetchLike,
  type Logger,
  type MetadataService,
  oidsOf,
  type Random,
  resolveMember,
  runQuery,
  Secret,
  type ToolContext,
} from '@agility-bridge/core';
import type { Instance } from '@agility-bridge/storage';

export interface ValidatorServices {
  fetchFor(instance: Pick<Instance, 'id' | 'baseUrl' | 'tls'>): FetchLike;
  readonly limiters: CredentialLimiters;
  readonly breakers: CircuitBreakers;
  readonly metadata: MetadataService;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly random: Random;
}

/** At most this many reachable projects are recorded. */
const MAX_REACHABLE = 1_000;
const PROBE_TIMEOUT_MS = 10_000;

export type ValidationResult =
  | {
      readonly status: 'valid';
      readonly memberOid: string;
      readonly memberName: string;
      readonly memberUsername: string | null;
      readonly reachableScopeIds: string[];
    }
  /** The token or the instance is wrong: the credential is unusable until fixed. */
  | { readonly status: 'invalid'; readonly code: string; readonly message: string }
  /** Agility could not answer now (timeout, outage, rate limit): keep the previous status and try later. */
  | { readonly status: 'unavailable'; readonly code: string; readonly message: string };

const MESSAGES: Readonly<Record<string, string>> = {
  [ErrorCode.AgilityAuth]:
    'Agility refused the token: it is revoked, mistyped, or belongs to another instance. Create a new one on the Agility Applications page.',
  [ErrorCode.AgilityWrongInstance]:
    'The instance address does not answer like Agility (a redirect, a web page or another server): check the address you open Agility at.',
  [ErrorCode.AgilityTls]:
    "The instance's TLS certificate is not trusted; a private CA needs its bundle on the Node deployment (AB_CA_FILE / instance TLS).",
  [ErrorCode.AgilityRateLimited]: 'Agility is rate-limiting this token; validation will be retried later.',
  [ErrorCode.AgilityUnavailable]: 'Agility did not answer; validation will be retried later.',
  [ErrorCode.AgilityTimeout]: 'Agility took too long to answer; validation will be retried later.',
};
const TRANSIENT = new Set<string>([
  ErrorCode.AgilityRateLimited,
  ErrorCode.AgilityUnavailable,
  ErrorCode.AgilityTimeout,
]);

function failure(code: string): ValidationResult {
  const message = MESSAGES[code] ?? 'Agility answered in an unexpected way.';
  return TRANSIENT.has(code)
    ? { status: 'unavailable', code, message }
    : { status: 'invalid', code, message };
}

/** Asks Agility who the token belongs to and which projects it can see. */
export async function validateAgilityToken(
  services: ValidatorServices,
  instance: Pick<Instance, 'id' | 'baseUrl' | 'tls'>,
  credentialId: string,
  token: string,
): Promise<ValidationResult> {
  const ctx: ToolContext = {
    requestId: services.random.uuid(),
    instance: { id: instance.id, baseUrl: instance.baseUrl },
    workspace: {
      id: 'validation',
      name: 'Credential validation',
      groups: [],
      writes: { enabled: false, approval: 'unavailable' },
    },
    credential: { id: credentialId, kind: 'personal', token: new Secret(token) },
    // Every project the member can see: this is what we want to learn.
    projects: { allowed: [], includeChildren: true },
    assetTypes: { deny: [] },
    limits: { ...DEFAULT_LIMITS, maxRows: MAX_REACHABLE, maxResponseBytes: 2 * 1024 * 1024 },
    budget: createBudget(25),
    limiter: services.limiters.for(instance.id, credentialId),
    breaker: services.breakers.for(instance.id, credentialId),
    fetch: services.fetchFor(instance),
    metadata: services.metadata,
    logger: services.logger,
    clock: services.clock,
    random: services.random,
  };
  try {
    const member = await resolveMember(ctx, 'me');
    const compiled = await compileQuery(ctx, { assetType: 'Scope', fields: ['Name'], limit: MAX_REACHABLE });
    const { rows } = await runQuery(ctx, compiled);
    const reachable = [...new Set(rows.flatMap((r) => oidsOf(r['_oid']).slice(0, 1)))].slice(
      0,
      MAX_REACHABLE,
    );
    const username = member.row['Username'];
    return {
      status: 'valid',
      memberOid: member.oid,
      memberName: member.name.slice(0, 200),
      memberUsername: typeof username === 'string' ? username.slice(0, 200) : null,
      reachableScopeIds: reachable,
    };
  } catch (error) {
    if (error instanceof AbError) {
      // No member behind the token at all is as useless as a refused one.
      return failure(error.code === ErrorCode.NotFound ? ErrorCode.AgilityAuth : error.code);
    }
    services.logger.warn('credential validation failed', { error: (error as Error).name });
    return failure(ErrorCode.AgilityUnavailable);
  }
}

/** An upstream check refused the change (an origin that is not Agility, for example): HTTP 502 in the admin API. */
export class UpstreamCheckError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'UpstreamCheckError';
    this.code = code;
  }
}

export type ProbeResult =
  | { readonly ok: true; readonly fingerprint: string | null }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Checks, without any token, that `baseUrl` answers like Agility: `GET meta.v1/Member` (public), JSON, no redirect.
 * Run before a token is ever sent to a new or changed origin (THREAT_MODEL A14).
 */
export async function probeInstance(fetch: FetchLike, baseUrl: string): Promise<ProbeResult> {
  const wrong = (): ProbeResult => ({
    ok: false,
    code: ErrorCode.AgilityWrongInstance,
    message: MESSAGES[ErrorCode.AgilityWrongInstance] as string,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(
      new Request(`${baseUrl}/meta.v1/Member`, {
        method: 'GET',
        redirect: 'manual',
        headers: { accept: 'application/json', 'user-agent': 'agility-bridge (instance probe)' },
        signal: controller.signal,
      }),
    );
    if (res.status === 526)
      return { ok: false, code: ErrorCode.AgilityTls, message: MESSAGES[ErrorCode.AgilityTls] as string };
    if (res.status !== 200 || !(res.headers.get('content-type') ?? '').includes('json')) {
      await res.body?.cancel().catch(() => {});
      return wrong();
    }
    const text = (await res.text()).slice(0, 2 * 1024 * 1024);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return wrong();
    }
    if (body === null || typeof body !== 'object' || !('Token' in body || 'Name' in body)) return wrong();
    const etag = res.headers.get('etag');
    return { ok: true, fingerprint: etag === null ? null : etag.slice(0, 100) };
  } catch (error) {
    const text = `${(error as Error).message} ${String((error as { cause?: { code?: string } }).cause?.code ?? '')}`;
    if (/CERT|certificate|self.signed|UNABLE_TO_VERIFY|internal error/i.test(text)) {
      return { ok: false, code: ErrorCode.AgilityTls, message: MESSAGES[ErrorCode.AgilityTls] as string };
    }
    return {
      ok: false,
      code: ErrorCode.AgilityUnavailable,
      message: 'The instance did not answer the probe; check the address and the network.',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The validator the services use, bound to host services. */
export interface CredentialValidator {
  validate(
    instance: Pick<Instance, 'id' | 'baseUrl' | 'tls'>,
    credentialId: string,
    token: string,
  ): Promise<ValidationResult>;
  probe(instance: Pick<Instance, 'id' | 'baseUrl' | 'tls'>): Promise<ProbeResult>;
}

export function credentialValidator(services: ValidatorServices): CredentialValidator {
  return {
    validate: (instance, credentialId, token) =>
      validateAgilityToken(services, instance, credentialId, token),
    probe: (instance) => probeInstance(services.fetchFor(instance), instance.baseUrl),
  };
}
