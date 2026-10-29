// SPDX-License-Identifier: Apache-2.0
// The write framework (P7-01): public surface for hosts and write tools.
export { APPROVAL_SCHEMA, displayLabel, renderApproval, shortId } from './approval.ts';
export { APPROVAL_INPUT_KEY, elicitationChannel, supportsFormElicitation } from './elicitation.ts';
export { ApprovalLedger, type LedgerEntry, type LedgerStore, memoryLedgerStore } from './ledger.ts';
export {
  type CounterStore,
  createWriteLimiter,
  DEFAULT_WRITE_RATE_LIMITS,
  memoryCounterStore,
  WRITE_LIMIT_WINDOW_MS,
  type WriteLimiterOptions,
  type WriteRateLimits,
} from './limiter.ts';
export {
  type CanonicalMutation,
  canonicalize,
  displayOld,
  type FieldAllowlist,
  type FieldChange,
  forDisplay,
  isNoop,
  MAX_APPROVAL_CHARS,
  MAX_CHANGES,
  MAX_LIST_ITEMS,
  MAX_OLD_DISPLAY_CHARS,
  MAX_VALUE_CHARS,
  mutationHash,
  valuesEqual,
  type WriteTarget,
  type WriteValue,
} from './mutation.ts';
export {
  approvalChannelOf,
  defineWriteTool,
  type Reread,
  type SendResult,
  WRITE_GROUP,
  type WritePlan,
  type WriteToolSpec,
} from './pipeline.ts';
export {
  type ApprovalChannelPort,
  type ApprovalMode,
  type ApprovalPrompt,
  type ChannelReply,
  DEFAULT_APPROVAL_TTL_MS,
  InputRequiredSignal,
  type WriteActor,
  type WriteAuditRecord,
  type WriteAuditSink,
  type WriteLimiter,
  type WriteRuntime,
} from './runtime.ts';
export { type ApprovalState, openState, sealState } from './state.ts';
