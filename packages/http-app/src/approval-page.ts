// SPDX-License-Identifier: Apache-2.0
// The out-of-band approval of a write (P7-02, ADR-0013, THREAT_MODEL T31/A13). Web-standard only.
//
// A client that cannot elicit gets `AB_WRITE_APPROVAL_PENDING` with a link to the signed-in panel. The pipeline's `page`
// channel (`createPageChannel`) stores the exact change as a pending record and answers with the link; the panel's page
// (`createApprovalsPort`, handed to `@agility-bridge/admin-ui`) shows it to the person who made the request and, on their
// approval, records a one-use ledger *grant* bound to the actor, the workspace and the change hash. The agent then repeats
// the call and the pipeline takes the grant. Rules this file keeps:
//
// - Pending records live at `wr:pend:<userId>:<id>` and the page reads them by the **signed-in person's own id**, so
//   another person's link, and an unknown or used id, all find nothing (one answer: nothing is learned from it).
// - The record is taken (atomically, L-073) when the person answers: a second post, a replay or a double click finds
//   nothing. It expires with its time to live; an expired record is never approved even if the store still holds it.
// - The posted hash must equal the stored one: a page cannot approve another change than the one it showed.
// - The grant lives a few minutes and is for one actor, one workspace and one hash (the pipeline checks all three and
//   takes it once). Values are never written to the audit (D-160); the audit rows hold ids, field names and the hash.
// - Only requests with a person behind them (a grant with a user) get this channel: a service grant has nobody to sign in.
import type { ApprovalOutcome, ApprovalsPort, ApprovalView } from '@agility-bridge/admin-ui';
import type { EffectiveAccess } from '@agility-bridge/auth';
import {
  type ApprovalChannelPort,
  type ApprovalLedger,
  type CanonicalMutation,
  type Clock,
  DEFAULT_APPROVAL_TTL_MS,
  displayLabel,
  forDisplay,
  shortId,
} from '@agility-bridge/core';
import type { KvStore } from '@agility-bridge/storage';
import type { AdminChange } from './audit.ts';

/** Where the approval page is mounted in the panel. */
export const APPROVE_PATH = '/admin/approve';
/** Pending approvals one person may have open: past this the oldest is dropped. */
export const MAX_PENDING_PER_USER = 20;
/** How long a pending request waits for the person (the prompt's expiry; the grant that follows lives as long again). */
export const PENDING_TTL_MS: number = DEFAULT_APPROVAL_TTL_MS;

const ID_RE = /^\d{14}-[A-Za-z0-9_-]{22}$/;
const enc = (s: string): string => encodeURIComponent(s);
const pendKey = (userId: string, id: string): string => `wr:pend:${enc(userId)}:${id}`;
const pendPrefix = (userId: string): string => `wr:pend:${enc(userId)}:`;
const indexKey = (userId: string, workspaceId: string, hash: string): string =>
  `wr:pendidx:${enc(userId)}:${enc(workspaceId)}:${hash}`;

/** What is stored for one pending approval. Holds customer text (old and new values): short-lived, never audited. */
interface PendingApproval {
  readonly v: 1;
  readonly id: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly workspaceName: string | null;
  readonly tool: string;
  readonly hash: string;
  readonly mutation: CanonicalMutation;
  readonly label: string | null;
  readonly expiresAt: number;
}

export interface ApprovalPageOptions {
  readonly kv: KvStore;
  readonly ledger: ApprovalLedger;
  readonly clock: Clock;
  /** `AB_PUBLIC_URL`'s origin: the only source of the link's host (never `Host` or a forwarded header, T8). */
  readonly publicOrigin: string;
  /** Admin audit rows (`write.approval.*`); awaited, a failure never changes the answer. */
  readonly audit?: (change: AdminChange) => Promise<void> | undefined;
}

export interface ApprovalPage {
  /** The pipeline channel for one request, or `undefined` when nobody can sign in to answer (a service grant). */
  channelFor(access: EffectiveAccess): ApprovalChannelPort | undefined;
  /** What the panel's page needs. */
  readonly port: ApprovalsPort;
}

const b64u = (bytes: Uint8Array): string => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

function parse(raw: string | null): PendingApproval | null {
  if (raw === null) return null;
  try {
    const r = JSON.parse(raw) as Partial<PendingApproval> | null;
    if (
      r === null ||
      r.v !== 1 ||
      typeof r.id !== 'string' ||
      typeof r.userId !== 'string' ||
      typeof r.workspaceId !== 'string' ||
      typeof r.tool !== 'string' ||
      typeof r.hash !== 'string' ||
      typeof r.expiresAt !== 'number' ||
      typeof r.mutation !== 'object' ||
      r.mutation === null
    ) {
      return null;
    }
    return r as PendingApproval;
  } catch {
    return null;
  }
}

const requestIdOf = (c: { get?: (key: never) => unknown }): string | null => {
  const id = typeof c.get === 'function' ? c.get('requestId' as never) : undefined;
  return typeof id === 'string' && id !== '' ? id : null;
};

export function createApprovalPage(options: ApprovalPageOptions): ApprovalPage {
  const { kv, ledger, clock } = options;

  const record = async (change: AdminChange): Promise<void> => {
    try {
      await options.audit?.(change);
    } catch {
      // auditing never changes the answer (the grant or the refusal already stands)
    }
  };

  const auditRow = (
    action: string,
    status: 'ok' | 'denied',
    userId: string,
    p: PendingApproval | null,
    requestId: string | null,
    reason?: string,
  ): AdminChange => ({
    action,
    status,
    userId,
    ...(p === null ? {} : { workspaceId: p.workspaceId }),
    targetType: 'write_change',
    targetId: p === null ? '-' : shortId(p.hash),
    ...(reason === undefined ? {} : { errorCode: reason }),
    requestId,
    details:
      p === null
        ? {}
        : {
            tool: p.tool,
            operation: p.mutation.operation,
            targetType: p.mutation.target.assetType,
            targetOid: p.mutation.target.oid,
            fields: p.mutation.changes.map((c) => c.field),
            hash: p.hash,
          },
  });

  const channelFor = (access: EffectiveAccess): ApprovalChannelPort | undefined => {
    const userId = access.grant.userId;
    if (userId === null) return undefined;
    return {
      kind: 'page',
      async ask(prompt) {
        // The person who may answer is the actor the approval binds. A mismatch is a wiring error: no channel.
        if (prompt.actor.id !== userId) throw new TypeError('the approval page needs a user actor');
        const now = clock.now();
        // The same change asked again (the agent repeated the call before the person acted) gets the same link.
        const index = indexKey(userId, prompt.workspaceId, prompt.hash);
        const knownId = await kv.get(index);
        if (knownId !== null && ID_RE.test(knownId)) {
          const existing = parse(await kv.get(pendKey(userId, knownId)));
          if (existing !== null && existing.hash === prompt.hash && existing.expiresAt > now) {
            return {
              status: 'pending',
              link: `${options.publicOrigin}${APPROVE_PATH}/${knownId}`,
              expiresAt: existing.expiresAt,
            };
          }
        }
        const expiresAt = now + PENDING_TTL_MS;
        const id = `${String(expiresAt).padStart(14, '0')}-${b64u(crypto.getRandomValues(new Uint8Array(16)))}`;
        const open = await kv.list(pendPrefix(userId), { limit: MAX_PENDING_PER_USER + 1 });
        if (open.length >= MAX_PENDING_PER_USER) {
          for (const key of open.slice(0, open.length - MAX_PENDING_PER_USER + 1)) await kv.delete(key);
        }
        const pending: PendingApproval = {
          v: 1,
          id,
          userId,
          workspaceId: prompt.workspaceId,
          workspaceName: access.workspace.name,
          tool: prompt.tool,
          hash: prompt.hash,
          // Display forms: Agility's old values cleaned and shortened, the title cleaned and capped (every channel alike).
          mutation: forDisplay(prompt.mutation),
          label: prompt.label === undefined ? null : displayLabel(prompt.label),
          expiresAt,
        };
        await kv.set(pendKey(userId, id), JSON.stringify(pending), { expiresAt });
        await kv.set(index, id, { expiresAt });
        return { status: 'pending', link: `${options.publicOrigin}${APPROVE_PATH}/${id}`, expiresAt };
      },
    };
  };

  const port: ApprovalsPort = {
    async view(_c, principal, id): Promise<ApprovalView | null> {
      const p = parse(await kv.get(pendKey(principal.userId, id)));
      if (p === null || p.userId !== principal.userId || p.expiresAt <= clock.now()) return null;
      const m = p.mutation;
      return {
        id: p.id,
        tool: p.tool,
        operation: m.operation,
        workspaceName: p.workspaceName,
        target: { assetType: m.target.assetType, oid: m.target.oid, number: m.target.number ?? null },
        label: p.label,
        changes: m.changes.map((c) => ({
          field: c.field,
          old: JSON.stringify(c.old),
          new: JSON.stringify(c.new),
        })),
        hash: p.hash,
        changeId: shortId(p.hash),
        expiresAt: p.expiresAt,
      };
    },

    async decide(c, principal, id, input): Promise<ApprovalOutcome> {
      const requestId = requestIdOf(c as never);
      const refused = async (reason: string, p: PendingApproval | null): Promise<ApprovalOutcome> => {
        await record(auditRow('write.approval.refused', 'denied', principal.userId, p, requestId, reason));
        return reason === 'hash_mismatch' ? 'mismatch' : 'gone';
      };
      // Taken first, whatever happens next: a replay, a double click or a second tab approves nothing.
      const p = parse(await kv.take(pendKey(principal.userId, id)));
      if (p === null) return refused('unknown_used_or_expired', null);
      const now = clock.now();
      if (p.userId !== principal.userId || p.expiresAt <= now) return refused('expired_or_not_yours', p);
      await kv.delete(indexKey(p.userId, p.workspaceId, p.hash));
      if (p.hash !== input.hash) return refused('hash_mismatch', p);
      const entry = {
        hash: p.hash,
        actor: p.userId,
        tool: p.tool,
        expiresAt: now + PENDING_TTL_MS,
        scope: p.workspaceId,
      };
      if (input.decision === 'approve') {
        await ledger.grant(entry);
        await record(auditRow('write.approval.approved', 'ok', principal.userId, p, requestId));
        return 'approved';
      }
      await ledger.deny(entry);
      await record(auditRow('write.approval.declined', 'ok', principal.userId, p, requestId));
      return 'declined';
    },
  };

  return { channelFor, port };
}
