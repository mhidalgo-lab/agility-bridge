// SPDX-License-Identifier: Apache-2.0
// Remote write runtime (P7-01, ADR-0013): what the core write pipeline needs, built per request from storage. The
// approval ledger lives in the `kv` table (single-use `take`), the intent of every write is stored durably before the
// mutation (`AuditWriter.writeIntent`, L-109) and the multi round-trip state is sealed with a key derived from the master
// key, so any isolate can verify what another one issued. Nothing is kept in module state (T21).

import type { ApprovalsPort } from '@agility-bridge/admin-ui';
import type { EffectiveAccess, Keyring } from '@agility-bridge/auth';
import { KeyPurpose } from '@agility-bridge/auth';
import {
  ApprovalLedger,
  type Clock,
  type WriteActor,
  type WriteAuditRecord,
  type WriteAuditSink,
  type WriteRuntime,
} from '@agility-bridge/core';
import type { Storage } from '@agility-bridge/storage';
import { type ApprovalPage, createApprovalPage } from './approval-page.ts';
import type { AdminChange, AuditWriter } from './audit.ts';

/** The host's write wiring: given to `createHttpApp` only when `AB_WRITE_TOOLS` is on. */
export interface HttpWrites {
  /** The runtime for one request of a caller that has write tools. */
  runtimeFor(access: EffectiveAccess): Promise<WriteRuntime>;
  /** The approval page's side of the panel (P7-02); absent when sign-in is not configured (no page channel then). */
  readonly approvals?: ApprovalsPort;
}

export interface HttpWritesOptions {
  readonly storage: Storage;
  readonly audit: AuditWriter;
  readonly keyring: Keyring;
  readonly clock: Clock;
  /**
   * `AB_PUBLIC_URL`'s origin, **only** when the panel is on (sign-in configured): it turns on the out-of-band approval
   * page (P7-02) for callers that cannot elicit. Without it such callers get `AB_WRITE_APPROVAL_UNAVAILABLE`.
   */
  readonly panelOrigin?: string;
  /** Admin audit for the approval page's decisions. */
  readonly auditAdmin?: (change: AdminChange) => Promise<void> | undefined;
}

const enc = new TextEncoder();

function row(record: WriteAuditRecord, access: EffectiveAccess) {
  return {
    kind: 'write' as const,
    action: record.tool,
    status: record.status ?? 'ok',
    requestId: record.requestId,
    userId: access.grant.userId,
    grantId: access.grant.id,
    tokenId: access.tokenId,
    clientId: access.clientId,
    workspaceId: record.workspaceId,
    instanceId: record.instanceId,
    assetNumbers: record.target.number === undefined ? null : [record.target.number],
    targetType: record.target.assetType,
    targetId: record.target.oid,
    errorCode: record.errorCode ?? null,
    details: {
      phase: record.phase,
      operation: record.operation,
      hash: record.hash,
      fields: [...record.fields],
      approval: record.approval,
      credential: access.credential.kind,
      ...(record.intentId === undefined || record.intentId === null ? {} : { intentId: record.intentId }),
    },
  };
}

export function createHttpWrites(options: HttpWritesOptions): HttpWrites {
  const ledger = new ApprovalLedger(options.storage.kv, options.clock);
  const page: ApprovalPage | undefined =
    options.panelOrigin === undefined
      ? undefined
      : createApprovalPage({
          kv: options.storage.kv,
          ledger,
          clock: options.clock,
          publicOrigin: options.panelOrigin,
          ...(options.auditAdmin === undefined ? {} : { audit: options.auditAdmin }),
        });
  let stateKey: Promise<Uint8Array> | undefined;
  const key = (): Promise<Uint8Array> =>
    (stateKey ??= options.keyring
      .mac(KeyPurpose.AuditIdentity, 'write-approval-state|v1')
      .then((mac) => enc.encode(mac))
      // A failure is retried by the next request instead of sticking.
      .catch((error: unknown) => {
        stateKey = undefined;
        throw error;
      }));
  return {
    ...(page === undefined ? {} : { approvals: page.port }),
    async runtimeFor(access) {
      const actor: WriteActor = {
        id: access.grant.userId ?? access.grant.id,
        grantId: access.grant.id,
        userId: access.grant.userId,
        tokenId: access.tokenId,
        clientId: access.clientId,
      };
      const audit: WriteAuditSink = {
        durable: true,
        // Stored now or the write is refused (L-109); the outcome is stored the same way but never changes the result.
        intent: (record) => options.audit.writeIntent(row(record, access)),
        outcome: async (record) => {
          await options.audit.writeIntent(row(record, access));
        },
      };
      const channel = page?.channelFor(access);
      return {
        approval: 'required',
        ...(channel === undefined ? {} : { page: channel }),
        tools: access.writeTools,
        actor,
        ledger,
        audit,
        stateKey: await key(),
      };
    },
  };
}
