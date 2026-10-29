// SPDX-License-Identifier: Apache-2.0
// The text a person approves (ADR-0013, L-106): the whole change, every field, old -> new. Agility text and the agent's
// proposed values are both untrusted, so they sit inside the untrusted-data envelope and are JSON-quoted (a newline in a
// value cannot start a line that looks like ours). A change too large to read is refused, never truncated.
import type { Random } from '../context.ts';
import { AbError, ErrorCode } from '../errors.ts';
import { envelope, newEnvelopeId } from '../output/envelope.ts';
import { cleanText } from '../output/text.ts';
import { type CanonicalMutation, MAX_APPROVAL_CHARS, type WriteValue } from './mutation.ts';

/** The elicitation form every approval uses: one boolean the person sets. */
export const APPROVAL_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: { approve: { type: 'boolean', title: 'Approve this change in Agility' } },
  required: ['approve'],
});

const quote = (v: WriteValue): string => JSON.stringify(v);

/** A short, readable form of the hash the person can match against an audit row. */
export const shortId = (hash: string): string => hash.slice(0, 12);

/**
 * Renders the approval message. `label` is the target's display name from Agility (untrusted). Throws
 * `AB_INPUT_INVALID` when the whole text would pass `MAX_APPROVAL_CHARS`.
 */
export function renderApproval(opts: {
  readonly tool: string;
  readonly mutation: CanonicalMutation;
  readonly hash: string;
  readonly label?: string;
  readonly random: Random;
}): string {
  const m = opts.mutation;
  const id = newEnvelopeId(opts.random);
  const body: string[] = [];
  if (opts.label !== undefined && opts.label !== '') {
    body.push(`Title: ${quote(cleanText(opts.label).slice(0, 200))}`);
  }
  m.changes.forEach((c, i) => {
    body.push(`${i + 1}. ${c.field}`, `   old: ${quote(c.old)}`, `   new: ${quote(c.new)}`);
  });
  const target = `${m.target.assetType}${m.target.number === undefined ? '' : ` ${m.target.number}`} (${m.target.oid})`;
  const message = [
    `Approve this change in Agility? (agility-bridge, ${opts.tool})`,
    `Operation: ${m.operation}`,
    `Target: ${target}`,
    `Changes: ${m.changes.length}`,
    envelope(body.join('\n'), id, 'proposed change'),
    `Change id: ${shortId(opts.hash)}`,
  ].join('\n');
  if (message.length > MAX_APPROVAL_CHARS) {
    throw new AbError(
      ErrorCode.InputInvalid,
      `The change is too large to show in full for approval (${message.length} characters, at most ${MAX_APPROVAL_CHARS}).`,
      {
        hint: 'Make a smaller change: fewer fields or shorter values. An approval is never truncated.',
        localDetails: true,
      },
    );
  }
  return message;
}
