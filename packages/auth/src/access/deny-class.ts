// SPDX-License-Identifier: Apache-2.0
// Which access refusals can pass (P5-21, D-77 (b), ADR-0018). An OAuth device is approved once; every token issuance re-runs
// the access decision. A *final* refusal ends the device (the access it was approved with is gone for good); a
// *recoverable* one is a state an operator or the person can fix (a workspace switched off for maintenance, a credential
// replaced a day later), so the device is kept and the request is answered `503 temporarily_unavailable`. Per MCP request
// nothing changes: the access token is refused for every reason while it holds.
import type { DenyReason } from './resolve.ts';

export type DenyClass = 'final' | 'recoverable';

/**
 * Every `DenyReason` in exactly one class. A `Record` over the union, so a new reason does not compile until it is placed
 * here; a test also compares the keys with the union's text. When in doubt a reason is final (fail closed): the person
 * approves the app again, which costs a minute, whereas a wrongly kept device is a standing approval.
 */
export const DENY_CLASS: Readonly<Record<DenyReason, DenyClass>> = Object.freeze({
  // Final: the approval's subject is gone or no longer matches, or the record is inconsistent.
  wrong_workspace: 'final',
  token_revoked: 'final',
  token_expired: 'final',
  grant_missing: 'final',
  grant_revoked: 'final',
  grant_expired: 'final',
  workspace_missing: 'final',
  instance_missing: 'final',
  user_missing: 'final',
  credential_missing: 'final',
  credential_mismatch: 'final',
  malformed_policy: 'final',
  not_passthrough: 'final',
  // Recoverable: switched off or not ready yet, and fixable without the person.
  workspace_disabled: 'recoverable',
  instance_disabled: 'recoverable',
  user_disabled: 'recoverable',
  credential_revoked: 'recoverable',
  credential_unvalidated: 'recoverable',
  no_projects: 'recoverable',
  no_tools: 'recoverable',
});

/** True when the device may be kept after this refusal at a token issuance. */
export const isRecoverableDeny = (reason: DenyReason): boolean => DENY_CLASS[reason] === 'recoverable';
