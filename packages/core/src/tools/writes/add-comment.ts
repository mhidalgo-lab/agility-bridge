// SPDX-License-Identifier: Apache-2.0
// add_comment (P7-04): adds a comment to one work item. The text is the caller's: bounded, line breaks normalised, no
// control or invisible characters, shown in full in the approval. A comment is an `Expression` that mentions the item
// (RESEARCH 1.5, unverified until P7-07). Repeating the call right after it worked is a no-op, not a second comment.
import { z } from 'zod';
import { AbError, ErrorCode } from '../../errors.ts';
import { resolveMember, runQuery } from '../../identity/resolve.ts';
import { oidsOf } from '../../identity/scope.ts';
import { metadataFor } from '../../metadata/service.ts';
import { hasHiddenCharacters } from '../../output/text.ts';
import { compileQuery } from '../../query/compiler.ts';
import { invalid } from '../../query/limits.ts';
import type { ToolDefinition } from '../../tool.ts';
import { defineWriteTool } from '../../writes/index.ts';
import { assetArg, text as textOf } from '../common.ts';
import {
  assertTypeAllowed,
  ITEM_TYPES,
  planTarget,
  postAsset,
  rereadTarget,
  withinWindow,
} from './common.ts';

const COST = 16;

export const MAX_COMMENT_CHARS = 4_000;
const LINE_BREAKS = /\r\n?|[\u2028\u2029]/g;

/** The comment as it will be sent: line breaks normalised, nothing hidden, not empty, not too long. */
export function commentText(raw: string): string {
  const value = raw.replace(LINE_BREAKS, '\n').trim();
  if (value === '') throw invalid('The comment is empty.', 'Give the text to add.');
  if (value.length > MAX_COMMENT_CHARS) {
    throw invalid(
      `The comment is ${value.length} characters; at most ${MAX_COMMENT_CHARS}.`,
      'Shorten it: the person approves the whole text, so it is never cut.',
    );
  }
  if (hasHiddenCharacters(value)) {
    throw invalid(
      'The comment contains control, invisible or bidirectional characters.',
      'Remove them; they would be hidden from the person who approves.',
    );
  }
  return value;
}

/** An identical comment by the same member counts as the same call only inside this window (D-194). */
export const COMMENT_REPEAT_WINDOW_MS: number = 10 * 60_000;

/** The text of the most recent comment on the item written by `memberOid` in the repeat window, or null. */
async function latestOwnComment(
  ctx: Parameters<typeof planTarget>[0],
  itemOid: string,
  memberOid: string,
): Promise<string | null> {
  const compiled = await compileQuery(ctx, {
    assetType: 'Expression',
    fields: ['Content', 'Author', 'AuthoredAt'],
    filters: [{ field: 'Mentions', op: 'eq', value: itemOid }],
    sort: [{ field: 'AuthoredAt', direction: 'desc' }],
    limit: 5,
  });
  const { rows } = await runQuery(ctx, compiled);
  const mine = rows.find((r) => oidsOf(r['Author'])[0] === memberOid);
  if (
    mine === undefined ||
    !withinWindow(textOf(mine['AuthoredAt']), ctx.clock.now(), COMMENT_REPEAT_WINDOW_MS)
  ) {
    return null;
  }
  return textOf(mine['Content']) ?? null;
}

export const addComment: ToolDefinition = defineWriteTool({
  name: 'add_comment',
  title: 'Add comment',
  description: `Add a comment to one backlog item, defect, task, test or epic. The text is shown in full to the person who approves, at most 4,000 characters. A comment identical to your latest one from the last 10 minutes is treated as already added. Not paged. Cold call: up to ${COST} Agility requests.`,
  kind: 'write',
  // Resolution, the item read, member, the latest comments, then the re-read (3) and the one write; metadata cold.
  cost: COST,
  idempotent: false,
  inputSchema: z.object({
    asset: assetArg,
    text: z
      .string()
      .min(1)
      .max(MAX_COMMENT_CHARS)
      .describe('The comment, at most 4,000 characters, plain text.'),
  }),
  allowedFields: Object.fromEntries(ITEM_TYPES.map((t) => [t, ['Comment']])),
  async plan(input, ctx) {
    const body = commentText(input.text);
    assertTypeAllowed(ctx, 'Expression');
    const target = await planTarget(ctx, input.asset, { types: ITEM_TYPES, allowClosed: true });
    const expression = await metadataFor(ctx).assetType('Expression');
    for (const attribute of ['Content', 'Mentions']) {
      if (expression.attributes.get(attribute)?.readOnly !== false) {
        throw invalid(`Comments are not writable on this instance (Expression.${attribute}).`);
      }
    }
    const me = await resolveMember(ctx, 'me');
    const latest = await latestOwnComment(ctx, target.oid, me.oid);
    return {
      mutation: {
        operation: 'add_comment',
        target: {
          assetType: target.assetType,
          oid: target.oid,
          ...(target.number === undefined ? {} : { number: target.number }),
        },
        // An identical latest comment by the same member means this call already happened: old equals new, a no-op.
        changes: [{ field: 'Comment', old: latest === body ? body : null, new: body }],
      },
      ...(target.name === undefined ? {} : { label: target.name }),
    };
  },
  async reread(plan, ctx) {
    const t = plan.mutation.target;
    await rereadTarget(ctx, t.assetType, t.oid, [], true);
    const me = await resolveMember(ctx, 'me');
    const latest = await latestOwnComment(ctx, t.oid, me.oid);
    const wanted = plan.mutation.changes[0]?.new;
    return { values: { Comment: latest !== null && latest === wanted ? latest : null } };
  },
  async send(plan, ctx) {
    const body = plan.mutation.changes[0]?.new;
    if (typeof body !== 'string') throw new AbError(ErrorCode.Internal, 'add_comment lost its text.');
    return postAsset(ctx, 'Expression', undefined, [
      { attribute: 'Content', value: body },
      { relation: 'Mentions', act: 'add', oids: [plan.mutation.target.oid] },
    ]);
  },
});
