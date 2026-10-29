// SPDX-License-Identifier: Apache-2.0
// The text a person approves (ADR-0013, L-106): the whole change, every field, old -> new. Agility text and the agent's
// proposed values are both untrusted, so they sit inside the untrusted-data envelope and are JSON-quoted (a newline in a
// value cannot start a line that looks like ours). A change too large to read is refused, never truncated.
import type { Random } from '../context.ts';
import { AbError, ErrorCode } from '../errors.ts';
import { envelope, newEnvelopeId, replaceLookalikes } from '../output/envelope.ts';
import { cleanText } from '../output/text.ts';
import { type CanonicalMutation, forDisplay, MAX_APPROVAL_CHARS, type WriteValue } from './mutation.ts';

/** The elicitation form every approval uses: one boolean the person sets. */
export const APPROVAL_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: { approve: { type: 'boolean', title: 'Approve this change in Agility' } },
  required: ['approve'],
});

/**
 * A value as the person reads it: JSON, so the quotes and escapes show exactly what is sent. The envelope rewrites the
 * look-alikes of its own tag name (`untrusted data` and its spellings) to `untrusted~data`; in an approval that would show
 * a value different from the one that is sent (P7-29). So a look-alike gets its first letter written as a JSON escape
 * (`\u0075ntrusted data`): the same text once read as JSON, nothing for the envelope to rewrite, and the envelope itself
 * is untouched. `escaped.used` tells the caller to add the one-line explanation.
 */
const quoteWith =
  (escaped: { used: boolean }) =>
  (v: WriteValue): string =>
    replaceLookalikes(JSON.stringify(v), (match) => {
      escaped.used = true;
      const first = match.charCodeAt(0);
      return `\\u${first.toString(16).padStart(4, '0')}${match.slice(1)}`;
    });

/** The target's title as shown next to an approval: Agility text, so cleaned, on one line and capped (every channel). */
export const displayLabel = (label: string): string =>
  cleanText(label).replace(/\s+/g, ' ').trim().slice(0, 200);

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
  const escaped = { used: false };
  const quote = quoteWith(escaped);
  const body: string[] = [];
  if (opts.label !== undefined && opts.label !== '') {
    body.push(`Title: ${quote(displayLabel(opts.label))}`);
  }
  forDisplay(m).changes.forEach((c, i) => {
    body.push(`${i + 1}. ${c.field}`, `   old: ${quote(c.old)}`, `   new: ${quote(c.new)}`);
  });
  const target = `${m.target.assetType}${m.target.number === undefined ? '' : ` ${m.target.number}`} (${m.target.oid})`;
  const message = [
    `Approve this change in Agility? (agility-bridge, ${opts.tool})`,
    `Operation: ${m.operation}`,
    `Target: ${target}`,
    `Changes: ${m.changes.length}`,
    envelope(body.join('\n'), id, 'proposed change'),
    ...(escaped.used
      ? [
          'Note: \\uXXXX inside a quoted value stands for that exact character; the value is shown without change.',
        ]
      : []),
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
