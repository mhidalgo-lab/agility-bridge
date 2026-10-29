// SPDX-License-Identifier: Apache-2.0
// The write pipeline (ADR-0013, ARCHITECTURE 6.6, P7-01): the one way to make a write tool. A tool declares its input,
// its field allowlist and three steps (plan, re-read, send); everything between is the framework's, so no write can
// skip enablement, approval, the re-check or the audit (L-105, L-108, L-109):
//
//   enablement -> plan -> dry run -> confirm -> approval found -> limiter -> re-read -> intent audit -> approval used up
//   -> send once -> outcome
//
// Never retried (the Agility client sends writes once, L-047). Nothing here keeps request data in module state (T21).
import { z } from 'zod';
import type { ToolContext } from '../context.ts';
import { AbError, ErrorCode } from '../errors.ts';
import { shapeOutput } from '../output/result.ts';
import type { InputSchema, ToolDefinition, ToolOutput } from '../tool.ts';
import { APPROVAL_SCHEMA, renderApproval, shortId } from './approval.ts';
import type { LedgerEntry } from './ledger.ts';
import {
  type CanonicalMutation,
  canonicalize,
  type FieldAllowlist,
  forDisplay,
  isNoop,
  mutationHash,
  valuesEqual,
  type WriteValue,
} from './mutation.ts';
import {
  type ApprovalPrompt,
  DEFAULT_APPROVAL_TTL_MS,
  InputRequiredSignal,
  type WriteAuditRecord,
  type WriteRuntime,
} from './runtime.ts';
import { openState, sealState } from './state.ts';

/** What `plan` returns: the canonical mutation and what the re-read compares. */
export interface WritePlan {
  readonly mutation: CanonicalMutation;
  /** An opaque version of the target when planning (for example its `ChangeDateUTC`); compared on the re-read. */
  readonly version?: string;
  /** The target's display name from Agility (untrusted): shown in the approval inside the envelope. */
  readonly label?: string;
}

/** What `reread` returns: the target's values now, for the fields the plan changes. */
export interface Reread {
  readonly values: Readonly<Record<string, WriteValue>>;
  readonly version?: string;
}

export interface SendResult {
  /** The OID of what was created or changed, when the response says. */
  readonly oid?: string;
  /** Agility answered 2xx but the body was empty or unreadable: the write is applied, the answer is not usable. */
  readonly unreadable?: boolean;
}

export interface WriteToolSpec<I extends InputSchema> {
  /** Names follow the tool conventions (`add_…`, `update_…`, `log_…`, ...). */
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** `destructive` for closing and reopening. */
  readonly kind: 'write' | 'destructive';
  /** Worst-case Agility requests: the plan's reads, the re-read and the one send (L-114). */
  readonly cost: number;
  /** The tool's own arguments. `dry_run` and `confirm` are added by the framework and may not appear here. */
  readonly inputSchema: I;
  /** Fields the tool may change, per asset type. A mutation outside it is refused. */
  readonly allowedFields: FieldAllowlist;
  /** Repeating the call has no further effect (true for set-a-field operations, false for creates and comments). */
  readonly idempotent?: boolean;
  /** The call replaces or removes an existing value: advertised as `destructiveHint` (the kind stays `write`, D-197). */
  readonly overwrites?: boolean;
  /**
   * Validates the input fully (metadata, allowed field, typed values), resolves the single target, verifies its scope,
   * reads the current values and builds the canonical mutation. Nothing is sent. Throws `AbError` to refuse.
   */
  plan(input: z.infer<I>, ctx: ToolContext): Promise<WritePlan>;
  /** Reads the target again after approval. Omit for operations that create something new (nothing to compare). */
  reread?(plan: WritePlan, ctx: ToolContext): Promise<Reread>;
  /** The one mutation. Called at most once per call, with the Agility request budget of the call. */
  send(plan: WritePlan, ctx: ToolContext): Promise<SendResult>;
}

export const WRITE_GROUP: string = 'writes';
const NOTICE = 'Changes Agility. Needs approval. Preview with dry_run.';
const READ_LAG =
  'Agility may take a moment to show the change; read the item again later instead of repeating the write.';
const UNREADABLE_NOTE =
  'Agility accepted the change but its answer could not be read, so the new state is not confirmed here: read the item to check. Do not repeat the write.';
const MAYBE_APPLIED_HINT =
  'The change may or may not have been applied: check the item before repeating. Writes are never retried.';

/** Failures after the request started that do not prove nothing was applied (a refusal, 401/403/404/429 and 4xx do). */
const MAYBE_APPLIED_CODES: ReadonlySet<string> = new Set([
  ErrorCode.AgilityTimeout,
  ErrorCode.AgilityUnavailable,
  ErrorCode.AgilityWrongInstance,
  ErrorCode.Internal,
]);

const refuseDisabled = (): AbError =>
  new AbError(ErrorCode.ToolDisabled, 'This write tool is not enabled for this connection.', {
    hint: 'An owner enables write tools per workspace and grant. See docs/guide/write-tools.md.',
  });

/**
 * Every enablement layer again, inside the tool (defence in depth: the access layer and the server wrapper already hide
 * the tool): the server switch (a runtime exists), the workspace and grant lists (`runtime.tools`, `grantedTools`), a
 * personal credential, and the workspace's write flag (which carries OAuth `mcp:write`). Any missing layer refuses
 * before anything is read or asked.
 */
function assertEnabled(ctx: ToolContext, name: string): WriteRuntime {
  const rt = ctx.writes;
  if (
    rt === undefined ||
    !rt.tools.includes(name) ||
    ctx.grantedTools?.includes(name) !== true ||
    !ctx.workspace.writes.enabled ||
    ctx.credential.kind !== 'personal'
  ) {
    throw refuseDisabled();
  }
  return rt;
}

const auditRecord = (
  ctx: ToolContext,
  rt: WriteRuntime,
  tool: string,
  m: CanonicalMutation,
  hash: string,
  approval: WriteAuditRecord['approval'],
  phase: WriteAuditRecord['phase'],
): WriteAuditRecord => ({
  phase,
  requestId: ctx.requestId,
  tool,
  operation: m.operation,
  actor: rt.actor,
  workspaceId: ctx.workspace.id,
  instanceId: ctx.instance.id,
  hash,
  target: {
    assetType: m.target.assetType,
    oid: m.target.oid,
    ...(m.target.number === undefined ? {} : { number: m.target.number }),
  },
  fields: m.changes.map((c) => c.field),
  approval,
});

/** How this request could be approved, for `whoami` and dry runs. */
export function approvalChannelOf(ctx: ToolContext): 'elicitation' | 'page' | 'not_required' | 'unavailable' {
  const rt = ctx.writes;
  if (rt === undefined) return 'unavailable';
  if (rt.approval === 'off') return 'not_required';
  return rt.channel?.kind ?? 'unavailable';
}

/** An approval found for this change. It is used up by `consume`, just before the send (P7-28). */
interface Approval {
  readonly kind: 'elicitation' | 'page' | 'not_required';
  /** Atomic and single use: `false` means another call used it first, and nothing may be sent. */
  consume(): Promise<boolean>;
  /** A step before the send refused: keep a record that the person said yes, where none is stored yet. */
  retain(): Promise<void>;
}

const noApproval = (kind: Approval['kind'], retain: () => Promise<void> = async () => {}): Approval => ({
  kind,
  consume: async () => true,
  retain,
});

/**
 * Finds the approval for this exact change, or throws. Order: a grant recorded out of band (the page, P7-02) for this
 * actor and hash; else the retried round of a multi round-trip (sealed state verified, ledger entry read, answer read);
 * else a fresh ask on the request's channel. Anything forged, replayed, expired or for another change falls through to a
 * fresh ask: it can never approve. A stored grant or round is only *read* here and used up by `consume` after the
 * limiter, the re-read and the intent audit, so a refusal in between does not make the person approve again (P7-28); the
 * atomic take there is what keeps one approval from sending twice.
 */
async function obtainApproval(
  ctx: ToolContext,
  rt: WriteRuntime,
  tool: string,
  hash: string,
  message: string,
  plan: WritePlan,
): Promise<Approval> {
  if (rt.approval === 'off') return noApproval('not_required');
  const now = ctx.clock.now();
  const scope = ctx.workspace.id;
  const declined = (): AbError =>
    new AbError(ErrorCode.WriteApprovalDeclined, 'The change was not approved, so nothing was changed.', {
      hint: 'Ask the person what to change instead; do not repeat the same call unprompted.',
    });
  const mine = (e: LedgerEntry | null): e is LedgerEntry =>
    e !== null && e.tool === tool && e.actor === rt.actor.id && e.hash === hash;
  // A grant or a denial can exist only where the approval page does (P7-02), or where a push answer can be kept after a
  // refusal (P7-28): without them these two reads (each a storage round trip) can never hit, so they are skipped
  // (P7-09). Fail closed: no entry read, no approval from one.
  const channel = rt.channel;
  if (rt.page !== undefined || channel?.kind === 'page' || channel?.sameCall === true) {
    const grant = await rt.ledger.peekGrant(rt.actor.id, hash, scope);
    if (mine(grant)) {
      return {
        kind: grant.via ?? 'page',
        consume: async () => mine(await rt.ledger.takeGrant(rt.actor.id, hash, scope)),
        retain: async () => {},
      };
    }
    // A denial is final: used up at once.
    if (mine(await rt.ledger.takeDenial(rt.actor.id, hash, scope))) throw declined();
  }
  if (channel === undefined) {
    throw new AbError(
      ErrorCode.WriteApprovalUnavailable,
      'This write needs a person to approve it, and this client cannot be asked.',
      {
        hint: 'Use a client that supports elicitation (Claude Code, Copilot CLI, VS Code), or ask the owner about the approval page. See docs/guide/write-tools.md.',
      },
    );
  }
  if (channel.resume !== undefined && channel.resume.answer !== 'none') {
    const state = await openState(rt.stateKey, channel.resume.state);
    if (
      state !== null &&
      state.h === hash &&
      state.a === rt.actor.id &&
      state.e > now &&
      state.w === scope &&
      state.i === ctx.instance.id
    ) {
      if (channel.resume.answer === 'approve') {
        if (mine(await rt.ledger.peekRound(state.n, scope))) {
          return {
            kind: channel.kind,
            consume: async () => mine(await rt.ledger.takeRound(state.n, scope)),
            retain: async () => {},
          };
        }
      } else if (mine(await rt.ledger.takeRound(state.n, scope))) {
        throw declined();
      }
    }
  }
  const expiresAt = now + (rt.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS);
  const prompt: ApprovalPrompt = {
    message,
    requestedSchema: APPROVAL_SCHEMA,
    hash,
    tool,
    actor: rt.actor,
    expiresAt,
    workspaceId: scope,
    mutation: plan.mutation,
    ...(plan.label === undefined ? {} : { label: plan.label }),
  };
  // A person is about to be asked: count it first, so a flood of varying proposals cannot become a flood of prompts or
  // pending records (P7-27). Past the limit nothing is asked, stored or opened.
  await rt.limiter.check({ tool, actor: rt.actor, requestId: ctx.requestId, purpose: 'approval_request' });
  const reply = await channel.ask(prompt);
  switch (reply.status) {
    case 'answered':
      if (!reply.approved) throw declined();
      return noApproval(channel.kind, () =>
        rt.ledger.grant({ hash, actor: rt.actor.id, tool, expiresAt, scope, via: 'elicitation' }),
      );
    case 'needs_input': {
      const nonce = ctx.random.uuid();
      await rt.ledger.openRound(nonce, { hash, actor: rt.actor.id, tool, expiresAt, scope });
      throw new InputRequiredSignal(
        prompt,
        await sealState(rt.stateKey, {
          n: nonce,
          h: hash,
          a: rt.actor.id,
          e: expiresAt,
          w: scope,
          i: ctx.instance.id,
        }),
      );
    }
    case 'pending':
      throw new AbError(
        ErrorCode.WriteApprovalPending,
        'The change needs approval on a page: open the link, review the exact change, approve it, then repeat this call.',
        { hint: `Approval link: ${reply.link}`, details: { expiresAt: reply.expiresAt }, localDetails: true },
      );
  }
}

type Channel = ReturnType<typeof approvalChannelOf>;

function planOutput(
  ctx: ToolContext,
  head: string,
  plan: WritePlan,
  hash: string,
  extra: Record<string, unknown>,
  notes: readonly string[],
): ToolOutput {
  const m = plan.mutation;
  const shaped = shapeOutput(ctx, {
    summary: head,
    notes,
    blocks: [
      {
        title: 'Change',
        source: 'proposed change',
        rows: forDisplay(m).changes.map((c) => ({ field: c.field, old: c.old, new: c.new })),
        columns: ['field', 'old', 'new'],
      },
    ],
    format: 'json',
    structured: {
      operation: m.operation,
      target: { ...m.target },
      fields: m.changes.map((c) => c.field),
      changeId: shortId(hash),
      ...extra,
    },
  });
  return shaped.output;
}

/**
 * Builds a write tool. The result is a `ToolDefinition` of the `writes` group whose handler runs the pipeline; the
 * registry refuses any other non-read tool.
 */
export function defineWriteTool<I extends InputSchema>(spec: WriteToolSpec<I>): ToolDefinition {
  const own = Object.keys(spec.inputSchema.shape);
  if (own.includes('dry_run') || own.includes('confirm')) {
    throw new Error(`${spec.name}: dry_run and confirm are added by the write framework.`);
  }
  const inputSchema = spec.inputSchema.extend({
    dry_run: z
      .boolean()
      .optional()
      .describe('Preview the full change and the approval channel without applying anything.'),
    confirm: z
      .boolean()
      .optional()
      .describe('Required (true) to apply. It is not approval: the person still approves.'),
  });
  const description = spec.description.includes('Changes Agility.')
    ? spec.description
    : `${spec.description} ${NOTICE}`;

  const handler = async (input: z.infer<typeof inputSchema>, ctx: ToolContext): Promise<ToolOutput> => {
    const rt = assertEnabled(ctx, spec.name);
    const { dry_run: dryRun, confirm, ...rest } = input as Record<string, unknown>;
    const plan0 = await spec.plan(rest as z.infer<I>, ctx);
    const mutation = canonicalize(plan0.mutation, spec.allowedFields);
    const plan: WritePlan = {
      mutation,
      ...(plan0.version === undefined ? {} : { version: plan0.version }),
      ...(plan0.label === undefined ? {} : { label: plan0.label }),
    };
    const hash = await mutationHash(spec.name, rt.actor.id, mutation);
    const message = renderApproval({
      tool: spec.name,
      mutation,
      hash,
      ...(plan.label === undefined ? {} : { label: plan.label }),
      random: ctx.random,
    });
    const channel: Channel = approvalChannelOf(ctx);

    if (dryRun === true) {
      const noop = isNoop(mutation);
      return planOutput(
        ctx,
        noop
          ? `Dry run: nothing to change, ${mutation.target.number ?? mutation.target.oid} already has these values.`
          : `Dry run: ${mutation.operation} on ${mutation.target.number ?? mutation.target.oid} would change ${mutation.changes.length} field(s). Nothing was sent.`,
        plan,
        hash,
        { applied: false, dryRun: true, noop, approval: 'dry_run', approvalChannel: channel },
        [
          channel === 'unavailable'
            ? 'A real call would be refused: no approval channel is available for this client (AB_WRITE_APPROVAL_UNAVAILABLE).'
            : channel === 'not_required'
              ? 'Approval is switched off for this server (stdio).'
              : channel === 'page'
                ? 'A real call needs the person to approve on a page.'
                : 'A real call asks the person to approve in the client.',
          'To apply: repeat the call with confirm: true and without dry_run.',
        ],
      );
    }
    if (isNoop(mutation)) {
      return planOutput(
        ctx,
        `Nothing to change: ${mutation.target.number ?? mutation.target.oid} already has these values.`,
        plan,
        hash,
        { applied: false, noop: true, approval: 'not_required' },
        [],
      );
    }
    if (confirm !== true) {
      throw new AbError(
        ErrorCode.InputInvalid,
        'This tool changes Agility and needs confirm: true. confirm is not approval: the person still approves.',
        { hint: 'Preview the change with dry_run: true, then repeat the call with confirm: true.' },
      );
    }

    const held = await obtainApproval(ctx, rt, spec.name, hash, message, plan);
    const approval = held.kind;

    // Everything that can refuse comes before the approval is used up (P7-28): a limiter refusal, a conflict or an audit
    // outage leaves it usable. A push answer, kept nowhere, is stored as a grant so the repeated call is not asked again.
    let intentId: string | null;
    try {
      await rt.limiter.check({ tool: spec.name, actor: rt.actor, requestId: ctx.requestId });

      if (spec.reread !== undefined) {
        const now = await spec.reread(plan, ctx);
        const applied = mutation.changes.every((c) => {
          const cur = now.values[c.field];
          return cur !== undefined && valuesEqual(cur, c.new);
        });
        if (applied) {
          // Nothing left to approve: the approval is used up.
          await held.consume();
          return planOutput(
            ctx,
            `Nothing to change: ${mutation.target.number ?? mutation.target.oid} already has these values (changed since the plan).`,
            plan,
            hash,
            { applied: false, noop: true, approval },
            [],
          );
        }
        const moved =
          (plan.version !== undefined && now.version !== plan.version) ||
          mutation.changes.some((c) => {
            const cur = now.values[c.field];
            return cur === undefined || !valuesEqual(cur, c.old);
          });
        if (moved) {
          throw new AbError(
            ErrorCode.WriteConflict,
            `${mutation.target.number ?? mutation.target.oid} changed after the plan was made, so nothing was changed.`,
            {
              hint: 'Read the item again, make a new plan with dry_run: true, and repeat the call. The approval is kept for the same change until it expires.',
            },
          );
        }
      }

      try {
        intentId = await rt.audit.intent(auditRecord(ctx, rt, spec.name, mutation, hash, approval, 'intent'));
      } catch (error) {
        ctx.logger.error('write refused: intent audit failed', { tool: spec.name, error });
        throw new AbError(
          ErrorCode.WriteAuditUnavailable,
          'The change was not made because its audit record could not be stored.',
          { hint: 'Try again later; if it keeps failing, ask the administrator to check the audit storage.' },
        );
      }
    } catch (error) {
      await held
        .retain()
        .catch((e: unknown) =>
          ctx.logger.error('write approval could not be kept', { tool: spec.name, error: e }),
        );
      throw error;
    }

    // The single use: the atomic take. Of two calls on one approval exactly one gets past here; the other has an intent
    // row and gets an error outcome, and nothing is sent for it.
    let used = false;
    try {
      used = await held.consume();
    } catch (error) {
      ctx.logger.error('write approval could not be consumed', { tool: spec.name, error });
    }
    if (!used) {
      await rt.audit
        .outcome({
          ...auditRecord(ctx, rt, spec.name, mutation, hash, approval, 'outcome'),
          status: 'error',
          errorCode: ErrorCode.WriteApprovalDeclined,
          intentId,
          note: 'approval already used or unavailable: nothing was sent',
        })
        .catch((e: unknown) => ctx.logger.error('write outcome audit failed', { tool: spec.name, error: e }));
      throw new AbError(
        ErrorCode.WriteApprovalDeclined,
        'The approval for this change was already used, so nothing was changed.',
        { hint: 'If the change is still wanted, repeat the call and ask the person to approve it again.' },
      );
    }

    let sent: SendResult;
    try {
      sent = await spec.send(plan, ctx);
    } catch (error) {
      const code = error instanceof AbError ? error.code : ErrorCode.Internal;
      await rt.audit
        .outcome({
          ...auditRecord(ctx, rt, spec.name, mutation, hash, approval, 'outcome'),
          status: 'error',
          errorCode: code,
          intentId,
          ...(MAYBE_APPLIED_CODES.has(code)
            ? { note: 'outcome unknown: the change may have been applied' }
            : {}),
        })
        .catch((e: unknown) => ctx.logger.error('write outcome audit failed', { tool: spec.name, error: e }));
      if (error instanceof AbError && MAYBE_APPLIED_CODES.has(code)) {
        // The client's own hint ("try again") is advice for a read: for a write it replaces it (P7-09, L-404).
        throw new AbError(code, error.message, {
          hint: MAYBE_APPLIED_HINT,
          ...(error.details === undefined ? {} : { details: error.details }),
          localDetails: error.localDetails,
          cause: error,
        });
      }
      throw error;
    }
    await rt.audit
      .outcome({
        ...auditRecord(ctx, rt, spec.name, mutation, hash, approval, 'outcome'),
        status: 'ok',
        errorCode: null,
        intentId,
        ...(sent.unreadable === true ? { note: 'applied; the Agility response could not be read' } : {}),
      })
      .catch((e: unknown) => ctx.logger.error('write outcome audit failed', { tool: spec.name, error: e }));
    ctx.logger.info('write applied', { tool: spec.name, change: shortId(hash), approval });
    return planOutput(
      ctx,
      `Applied: ${mutation.operation} on ${mutation.target.number ?? mutation.target.oid} changed ${mutation.changes.length} field(s).`,
      plan,
      hash,
      {
        applied: true,
        approval,
        ...(sent.oid === undefined ? {} : { resultOid: sent.oid }),
        ...(sent.unreadable === true ? { responseReadable: false } : {}),
      },
      sent.unreadable === true ? [UNREADABLE_NOTE, READ_LAG] : [READ_LAG],
    );
  };

  return {
    name: spec.name,
    title: spec.title,
    description,
    kind: spec.kind,
    group: WRITE_GROUP,
    cost: spec.cost,
    inputSchema,
    ...(spec.idempotent === undefined ? {} : { idempotent: spec.idempotent }),
    ...(spec.overwrites === true ? { overwrites: true } : {}),
    writePipeline: true,
    handler: handler as ToolDefinition['handler'],
  };
}
