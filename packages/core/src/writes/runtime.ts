// SPDX-License-Identifier: Apache-2.0
// What a host gives the write pipeline (ADR-0013): the ledger, the audit sink, the actor, the approval mode and the
// approval channel of the request. Ports only: core knows neither storage nor the HTTP stack. Built per request by the
// host (the channel by the server wrapper), never kept in module state (THREAT_MODEL T21, L-013).
import type { ApprovalLedger } from './ledger.ts';
import type { CanonicalMutation } from './mutation.ts';

/** `required`: a person approves every write (default). `off`: stdio only, single user with their own token (D-10). */
export type ApprovalMode = 'required' | 'off';

/** Who a write is attributed to in the audit and the approval binding. Ids only. */
export interface WriteActor {
  /** The grant's user id, or the grant id for a service grant; stdio: `stdio`. Part of the approval hash. */
  readonly id: string;
  readonly grantId?: string | null;
  readonly userId?: string | null;
  readonly tokenId?: string | null;
  readonly clientId?: string | null;
}

export interface WriteAuditRecord {
  readonly phase: 'intent' | 'outcome';
  readonly requestId: string;
  readonly tool: string;
  readonly operation: string;
  readonly actor: WriteActor;
  readonly workspaceId: string;
  readonly instanceId: string;
  /** Hash of the canonical mutation: what the approval bound. */
  readonly hash: string;
  readonly target: { readonly assetType: string; readonly oid: string; readonly number?: string };
  /** Field names only, never values (values may be customer text). */
  readonly fields: readonly string[];
  readonly approval: 'elicitation' | 'page' | 'not_required';
  /** Outcome only. */
  readonly status?: 'ok' | 'error';
  readonly errorCode?: string | null;
  /** Outcome only: the id of the intent row. */
  readonly intentId?: string | null;
  /** Outcome only: a short fixed note (no Agility text), e.g. that the answer could not be read or the outcome is unknown. */
  readonly note?: string;
}

/**
 * Where write audit goes. `intent` must be stored before anything is sent: if it rejects, the write is refused
 * (L-109). `outcome` is best effort: the mutation already happened, so its failure is logged, not shown as a failure.
 */
export interface WriteAuditSink {
  /** Durable storage (remote modes) or a log line (stdio, documented as weaker). */
  readonly durable: boolean;
  intent(record: WriteAuditRecord): Promise<string | null>;
  outcome(record: WriteAuditRecord): Promise<void>;
}

/** Write rate limit seam (P7-03): throws `AB_LIMIT_RATE` / `AB_LIMIT_QUOTA` to refuse. Fails closed. */
export interface WriteLimiter {
  check(info: {
    readonly tool: string;
    readonly actor: WriteActor;
    readonly requestId: string;
    /**
     * `approval_request`: a person is about to be asked (P7-27); counts only against the grant's own request counter.
     * Absent or `write`: a write is about to run.
     */
    readonly purpose?: 'write' | 'approval_request';
  }): Promise<void>;
}

/** What to show the person and how to ask. */
export interface ApprovalPrompt {
  /** The whole change, rendered. Never truncated. */
  readonly message: string;
  /** Elicitation form: one boolean. */
  readonly requestedSchema: Readonly<Record<string, unknown>>;
  readonly hash: string;
  readonly tool: string;
  readonly actor: WriteActor;
  readonly expiresAt: number;
  /** The workspace asking (an out-of-band approval is bound to it). */
  readonly workspaceId: string;
  /** The change as data, for a channel that renders it itself (the approval page, P7-02). Untrusted values inside. */
  readonly mutation: CanonicalMutation;
  /** The target's display name from Agility (untrusted). */
  readonly label?: string;
}

export type ChannelReply =
  /** The person answered this very call (push elicitation, or the retried round of a multi round-trip). */
  | { readonly status: 'answered'; readonly approved: boolean }
  /** 2026-07-28: ask the client and have it repeat the call (the pipeline mints the sealed state). */
  | { readonly status: 'needs_input' }
  /** Out of band (P7-02): the person approves on a page; the agent repeats the call. */
  | { readonly status: 'pending'; readonly link: string; readonly expiresAt: number };

/** One way of getting a person's approval for this request. */
export interface ApprovalChannelPort {
  readonly kind: 'elicitation' | 'page';
  /** The answer comes within this very call (push elicitation) and is kept nowhere: a refusal after it would lose it (P7-28). */
  readonly sameCall?: boolean;
  /** A retried multi round-trip round: the (untrusted, sealed) state the client echoed and its answer. */
  readonly resume?: { readonly state: string; readonly answer: 'approve' | 'decline' | 'none' };
  ask(prompt: ApprovalPrompt): Promise<ChannelReply>;
}

export interface WriteRuntime {
  readonly approval: ApprovalMode;
  /** Write tools this caller is enabled for: every layer holds (server switch, lists, credential, scope). */
  readonly tools: readonly string[];
  readonly actor: WriteActor;
  readonly ledger: ApprovalLedger;
  readonly audit: WriteAuditSink;
  /** At least 32 bytes; seals multi round-trip state (per-process random in stdio, derived from the master key remotely). */
  readonly stateKey: Uint8Array;
  /** How long an approval stays valid (default 10 minutes). */
  readonly approvalTtlMs?: number;
  /** Required: a host without a write limiter does not compile (P7-09). Stdio uses in-process counters. */
  readonly limiter: WriteLimiter;
  /** The out-of-band channel (P7-02), used when the request cannot be elicited. */
  readonly page?: ApprovalChannelPort;
  /** The channel of this request; set per call by the server wrapper from the request's declared capabilities. */
  readonly channel?: ApprovalChannelPort;
}

export const DEFAULT_APPROVAL_TTL_MS: number = 10 * 60_000;

/**
 * Thrown by the pipeline when the client must be asked and repeat the call (2026-07-28 multi round-trip). The server
 * wrapper turns it into an `input_required` result; it never reaches a client as an error.
 */
export class InputRequiredSignal extends Error {
  /** The question for the person. */
  readonly text: string;
  readonly requestedSchema: Readonly<Record<string, unknown>>;
  readonly state: string;

  constructor(prompt: Pick<ApprovalPrompt, 'message' | 'requestedSchema'>, state: string) {
    super('input required');
    this.name = 'InputRequiredSignal';
    this.text = prompt.message;
    this.requestedSchema = prompt.requestedSchema;
    this.state = state;
  }
}
