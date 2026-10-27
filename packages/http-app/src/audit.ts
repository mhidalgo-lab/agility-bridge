// SPDX-License-Identifier: Apache-2.0
// The audit log (P2-08, ARCHITECTURE §4 and §5 step 8, THREAT_MODEL T8, T17): who did what, through which grant and
// device, against which assets — never tokens, credentials, request bodies or Agility content. Rows are written in the
// background (a failure is logged, never shown to the caller); refusal rows are capped per minute with a summary row;
// the intent of a write (Phase 7) is written synchronously before the mutation (L-109).
import type { Clock, Logger, Random } from '@agility-bridge/core';
import type { AuditStatus, JsonObject, NewAuditEntry, Storage } from '@agility-bridge/storage';
import type { HttpObserver, RequestEvent, ToolCallRecord } from './app.ts';

export interface AuditOptions {
  readonly storage: Storage;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly random: Random;
  /** Refusal rows per minute before they are summarised (default 60). */
  readonly refusalsPerMinute?: number;
  /** Rows waiting to be written before new ones are dropped (and counted in the log) (default 10,000). */
  readonly maxPending?: number;
  /**
   * Write each row at once instead of after the previous one (Workers, L-096): no write waits on a write started by
   * another request. The methods then return the write, for the host to keep alive (`waitUntil`).
   */
  readonly detached?: boolean;
}

export interface AdminChange {
  /** `instance.create`, `grant.revoke`, `crypto.retire_key`, … */
  readonly action: string;
  readonly status?: AuditStatus;
  readonly userId?: string | null;
  readonly workspaceId?: string | null;
  readonly instanceId?: string | null;
  readonly targetType: string;
  readonly targetId: string;
  /** Ids, versions, field names and reasons — never secrets or values typed by users. */
  readonly details?: JsonObject;
  /** Where the change came from: `api`, `cli`, … */
  readonly via?: string;
  readonly errorCode?: string | null;
  readonly requestId?: string | null;
}

/** One sign-in attempt that reached a provider (P4-01). Never the subject, email, code, token or setup code. */
export interface LoginEvent {
  readonly requestId: string;
  readonly status: 'ok' | 'denied';
  /** The URL key of the provider (`google`, `oidc-corp`, `cf-access`). */
  readonly provider: string;
  readonly idp: string | null;
  readonly userId?: string | null;
  /** The stable deny reason (`IdentityErrorCode` or `LoginDenyReason`). */
  readonly reason?: string | null;
  readonly outcome?: string | null;
  /** Keyed hash of `(idp, subject)`: correlates repeated attempts by one identity without revealing it. */
  readonly identityHash?: string | null;
  /** A setup link made an existing user the owner: the role they had before. */
  readonly previousRole?: string | null;
}

/**
 * One step of the OAuth server (P5-01): `oauth.authorize`, `oauth.token.issued`, `oauth.token.refused`,
 * `oauth.token.revoked`, `oauth.code.replayed`; client registration (P5-03): `oauth.client.registered`,
 * `oauth.client.fetched`, `oauth.client.refused` (details: `kind`, host, limits; never the document). Ids and stable reasons only: never a code, token or verifier.
 */
export interface OAuthEvent {
  readonly action: string;
  readonly status: AuditStatus;
  readonly requestId?: string | null;
  readonly userId?: string | null;
  /** The access grant the person approved. */
  readonly grantId?: string | null;
  readonly workspaceId?: string | null;
  readonly clientId?: string | null;
  /** The OAuth device authorization (`oauth_<provider grant id>`). */
  readonly tokenId?: string | null;
  /** A stable deny reason. */
  readonly reason?: string | null;
  readonly details?: JsonObject;
}

/** Refusals that are worth a row: authentication and limits, not malformed bodies from an authenticated caller. */
const AUDITED_REFUSALS = new Set([401, 429]);

export class AuditWriter {
  readonly #options: AuditOptions;
  readonly #perMinute: number;
  readonly #maxPending: number;
  #pending = 0;
  #dropped = 0;
  #tail: Promise<void> = Promise.resolve();
  readonly #inflight = new Set<Promise<void>>();
  #window = { start: 0, written: 0, suppressed: 0, firstSuppressed: 0 };

  constructor(options: AuditOptions) {
    this.#options = options;
    this.#perMinute = options.refusalsPerMinute ?? 60;
    this.#maxPending = options.maxPending ?? 10_000;
  }

  /**
   * Queues a row; never throws, never blocks the request. Detached, it returns the write (which never rejects) for the
   * host to keep alive; queued, it returns nothing.
   */
  enqueue(row: Omit<NewAuditEntry, 'id' | 'ts'>): Promise<void> | undefined {
    if (this.#pending >= this.#maxPending) {
      this.#dropped++;
      if (this.#dropped === 1 || this.#dropped % 1_000 === 0) {
        this.#options.logger.error('audit queue full; rows dropped', { dropped: this.#dropped });
      }
      return undefined;
    }
    const entry: NewAuditEntry = { ...row, id: this.#options.random.uuid(), ts: this.#options.clock.now() };
    this.#pending++;
    const write = () =>
      this.#options.storage.audit
        .append(entry)
        .catch((error: unknown) => {
          this.#options.logger.error('audit write failed', {
            action: entry.action,
            error: (error as Error).name,
          });
        })
        .finally(() => {
          this.#pending--;
        });
    if (this.#options.detached === true) {
      const written = write();
      this.#inflight.add(written);
      void written.finally(() => this.#inflight.delete(written));
      return written;
    }
    this.#tail = this.#tail.then(write);
    return undefined;
  }

  /** Resolves when every queued row has been written (or failed). For shutdown and tests. */
  async flush(): Promise<void> {
    this.#flushWindow(Number.POSITIVE_INFINITY);
    await this.#tail;
    await Promise.all([...this.#inflight]);
  }

  /**
   * Writes a row now and fails if it cannot be stored: for the intent of a write, recorded before the mutation (L-109,
   * P7-01). A failure must stop the write.
   */
  async writeIntent(row: Omit<NewAuditEntry, 'id' | 'ts'>): Promise<string> {
    const id = this.#options.random.uuid();
    await this.#options.storage.audit.append({ ...row, id, ts: this.#options.clock.now() });
    return id;
  }

  toolCall(e: ToolCallRecord): Promise<void> | undefined {
    return this.enqueue({
      kind: 'tool_call',
      action: e.tool,
      status: e.status,
      requestId: e.requestId,
      userId: e.access.grant.userId,
      grantId: e.access.grant.id,
      tokenId: e.access.tokenId,
      clientId: e.access.clientId,
      workspaceId: e.access.workspace.id,
      instanceId: e.access.instance.id,
      assetNumbers: e.assetNumbers.length > 0 ? [...e.assetNumbers] : null,
      query:
        e.queries.length === 0
          ? null
          : e.queries.length === 1
            ? (e.queries[0] as string)
            : JSON.stringify(e.queries),
      durationMs: Math.max(0, Math.round(e.durationMs)),
      agilityRequests: e.requestsUsed,
      errorCode: e.errorCode,
      details: {
        credential: e.access.credential.kind,
        ...(e.download === undefined ? {} : { download: { ...e.download } }),
      },
    });
  }

  /** A refused MCP request (authentication or limits), capped per minute. */
  request(e: RequestEvent): Promise<void> | undefined {
    if (e.refusal === null || !AUDITED_REFUSALS.has(e.status)) return undefined;
    const now = this.#options.clock.now();
    const summary = this.#flushWindow(now);
    if (this.#window.written >= this.#perMinute) {
      if (this.#window.suppressed === 0) this.#window.firstSuppressed = now;
      this.#window.suppressed++;
      return summary;
    }
    this.#window.written++;
    const row = this.enqueue({
      kind: 'auth',
      action: e.status === 429 ? 'mcp.rate_limited' : 'mcp.unauthenticated',
      status: 'denied',
      requestId: e.requestId,
      userId: e.access?.grant.userId ?? null,
      grantId: e.access?.grant.id ?? null,
      tokenId: e.access?.tokenId ?? null,
      clientId: e.access?.clientId ?? null,
      workspaceId: e.access?.workspace.id ?? null,
      instanceId: e.access?.instance.id ?? null,
      durationMs: Math.max(0, Math.round(e.durationMs)),
      errorCode: e.status === 429 ? 'AB_LIMIT_RATE' : 'AB_AUTH_UNAUTHORIZED',
      details: {
        reason: String(e.refusal).slice(0, 64),
        slug: e.slug.slice(0, 63),
        ip: e.ip.slice(0, 64),
        ...(e.mcp?.method ? { method: e.mcp.method } : {}),
      },
    });
    return both(summary, row);
  }

  /** A sign-in attempt: `auth` / `login.ok` or `login.denied`. */
  login(e: LoginEvent): Promise<void> | undefined {
    return this.enqueue({
      kind: 'auth',
      action: e.status === 'ok' ? 'login.ok' : 'login.denied',
      status: e.status,
      requestId: e.requestId,
      userId: e.userId ?? null,
      errorCode: e.status === 'ok' ? null : (e.reason ?? null),
      targetType: 'provider',
      targetId: e.provider.slice(0, 64),
      details: {
        provider: e.provider.slice(0, 64),
        idp: e.idp,
        ...(e.reason == null ? {} : { reason: e.reason.slice(0, 64) }),
        ...(e.outcome == null ? {} : { outcome: e.outcome }),
        ...(e.identityHash == null ? {} : { identityHash: e.identityHash }),
        ...(e.previousRole == null ? {} : { previousRole: e.previousRole }),
      },
    });
  }

  /** An OAuth server step: an `auth` row (`oauth.*`). */
  oauth(e: OAuthEvent): Promise<void> | undefined {
    return this.enqueue({
      kind: 'auth',
      action: e.action.slice(0, 100),
      status: e.status,
      requestId: e.requestId ?? null,
      userId: e.userId ?? null,
      grantId: e.grantId ?? null,
      tokenId: e.tokenId ?? null,
      clientId: e.clientId === undefined || e.clientId === null ? null : e.clientId.slice(0, 200),
      workspaceId: e.workspaceId ?? null,
      errorCode: e.status === 'ok' ? null : (e.reason ?? null),
      targetType: 'oauth_device',
      targetId: e.tokenId ?? null,
      details: { ...(e.details ?? {}), ...(e.reason == null ? {} : { reason: e.reason.slice(0, 64) }) },
    });
  }

  admin(change: AdminChange): Promise<void> | undefined {
    return this.enqueue(this.#adminRow(change));
  }

  #adminRow(change: AdminChange): Omit<NewAuditEntry, 'id' | 'ts'> {
    return {
      kind: 'admin',
      action: change.action.slice(0, 100),
      status: change.status ?? 'ok',
      requestId: change.requestId ?? null,
      userId: change.userId ?? null,
      workspaceId: change.workspaceId ?? null,
      instanceId: change.instanceId ?? null,
      targetType: change.targetType,
      targetId: change.targetId,
      errorCode: change.errorCode ?? null,
      details: { ...(change.details ?? {}), ...(change.via === undefined ? {} : { via: change.via }) },
    };
  }

  /** Ends the refusal window once a minute has passed, writing a summary of what was suppressed. */
  #flushWindow(now: number): Promise<void> | undefined {
    const w = this.#window;
    if (now - w.start < 60_000) return undefined;
    let summary: Promise<void> | undefined;
    if (w.suppressed > 0) {
      summary = this.enqueue({
        kind: 'auth',
        action: 'audit.refusals_suppressed',
        status: 'denied',
        details: { suppressed: w.suppressed, from: w.firstSuppressed, to: Math.min(now, w.start + 60_000) },
      });
    }
    this.#window = { start: Number.isFinite(now) ? now : 0, written: 0, suppressed: 0, firstSuppressed: 0 };
    return summary;
  }

  /** The observer to give `createHttpApp`; it returns the writes it started (detached) for the host to keep alive. */
  observer(next?: HttpObserver): HttpObserver {
    return {
      request: (e) => both(this.request(e), next?.request?.(e)),
      toolCall: (e) => both(this.toolCall(e), next?.toolCall?.(e)),
    };
  }
}

/** One promise for the work two steps started, or nothing when neither started any. */
function both(a: unknown, b: unknown): Promise<void> | undefined {
  const work = [a, b].filter((w): w is Promise<unknown> => w instanceof Promise);
  if (work.length === 0) return undefined;
  return Promise.all(work).then(() => undefined);
}

/**
 * Deletes audit rows older than `retentionDays` (0 keeps them forever), in batches of 1,000, at most `maxBatches`
 * (default 1,000; Workers use a few per scheduled run, P3-08). Returns the number deleted.
 */
export async function purgeAudit(
  storage: Storage,
  retentionDays: number,
  now: number,
  maxBatches = 1_000,
): Promise<number> {
  if (retentionDays <= 0) return 0;
  const before = now - retentionDays * 86_400_000;
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const n = await storage.audit.purge(before, 1_000);
    total += n;
    if (n < 1_000) break;
  }
  return total;
}

/** Purges at start and then hourly; the timer does not keep the process alive. Returns a stop function. */
export function scheduleAuditRetention(
  storage: Storage,
  retentionDays: number,
  clock: Clock,
  logger: Logger,
  everyMs = 3_600_000,
): () => void {
  if (retentionDays <= 0) return () => {};
  const run = () =>
    purgeAudit(storage, retentionDays, clock.now())
      .then((n) => {
        if (n > 0) logger.info('audit retention', { deleted: n, retentionDays });
      })
      .catch((error: unknown) => logger.error('audit retention failed', { error: (error as Error).name }));
  void run();
  const timer = setInterval(run, everyMs);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
