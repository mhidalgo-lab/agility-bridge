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

/** Refusals that are worth a row: authentication and limits, not malformed bodies from an authenticated caller. */
const AUDITED_REFUSALS = new Set([401, 429]);

export class AuditWriter {
  readonly #options: AuditOptions;
  readonly #perMinute: number;
  readonly #maxPending: number;
  #pending = 0;
  #dropped = 0;
  #tail: Promise<void> = Promise.resolve();
  #window = { start: 0, written: 0, suppressed: 0, firstSuppressed: 0 };

  constructor(options: AuditOptions) {
    this.#options = options;
    this.#perMinute = options.refusalsPerMinute ?? 60;
    this.#maxPending = options.maxPending ?? 10_000;
  }

  /** Queues a row; never throws, never blocks the request. */
  enqueue(row: Omit<NewAuditEntry, 'id' | 'ts'>): void {
    if (this.#pending >= this.#maxPending) {
      this.#dropped++;
      if (this.#dropped === 1 || this.#dropped % 1_000 === 0) {
        this.#options.logger.error('audit queue full; rows dropped', { dropped: this.#dropped });
      }
      return;
    }
    const entry: NewAuditEntry = { ...row, id: this.#options.random.uuid(), ts: this.#options.clock.now() };
    this.#pending++;
    this.#tail = this.#tail
      .then(() => this.#options.storage.audit.append(entry))
      .catch((error: unknown) => {
        this.#options.logger.error('audit write failed', {
          action: entry.action,
          error: (error as Error).name,
        });
      })
      .finally(() => {
        this.#pending--;
      });
  }

  /** Resolves when every queued row has been written (or failed). For shutdown and tests. */
  async flush(): Promise<void> {
    this.#flushWindow(Number.POSITIVE_INFINITY);
    await this.#tail;
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

  toolCall(e: ToolCallRecord): void {
    this.enqueue({
      kind: 'tool_call',
      action: e.tool,
      status: e.status,
      requestId: e.requestId,
      userId: e.access.grant.userId,
      grantId: e.access.grant.id,
      tokenId: e.access.tokenId,
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
      details: { credential: e.access.credential.kind },
    });
  }

  /** A refused MCP request (authentication or limits), capped per minute. */
  request(e: RequestEvent): void {
    if (e.refusal === null || !AUDITED_REFUSALS.has(e.status)) return;
    const now = this.#options.clock.now();
    this.#flushWindow(now);
    if (this.#window.written >= this.#perMinute) {
      if (this.#window.suppressed === 0) this.#window.firstSuppressed = now;
      this.#window.suppressed++;
      return;
    }
    this.#window.written++;
    this.enqueue({
      kind: 'auth',
      action: e.status === 429 ? 'mcp.rate_limited' : 'mcp.unauthenticated',
      status: 'denied',
      requestId: e.requestId,
      userId: e.access?.grant.userId ?? null,
      grantId: e.access?.grant.id ?? null,
      tokenId: e.access?.tokenId ?? null,
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
  }

  admin(change: AdminChange): void {
    this.enqueue(this.#adminRow(change));
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
  #flushWindow(now: number): void {
    const w = this.#window;
    if (now - w.start < 60_000) return;
    if (w.suppressed > 0) {
      this.enqueue({
        kind: 'auth',
        action: 'audit.refusals_suppressed',
        status: 'denied',
        details: { suppressed: w.suppressed, from: w.firstSuppressed, to: Math.min(now, w.start + 60_000) },
      });
    }
    this.#window = { start: Number.isFinite(now) ? now : 0, written: 0, suppressed: 0, firstSuppressed: 0 };
  }

  /** The observer to give `createHttpApp`. */
  observer(next?: HttpObserver): HttpObserver {
    return {
      request: (e) => {
        this.request(e);
        next?.request?.(e);
      },
      toolCall: (e) => {
        this.toolCall(e);
        next?.toolCall?.(e);
      },
    };
  }
}

/**
 * Deletes audit rows older than `retentionDays` (0 keeps them forever), in bounded batches. Returns the number deleted.
 */
export async function purgeAudit(storage: Storage, retentionDays: number, now: number): Promise<number> {
  if (retentionDays <= 0) return 0;
  const before = now - retentionDays * 86_400_000;
  let total = 0;
  for (let i = 0; i < 1_000; i++) {
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
