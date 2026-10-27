// SPDX-License-Identifier: Apache-2.0
// Attachments (P6-04, D-08, THREAT_MODEL A1, A8). `list_attachments` reads metadata and external links as text and is
// always on with its group. `get_attachment` is a different product: it returns the text of one attachment, so it has
// its own `attachments` group, is off by default (workspace limit `attachmentDownload`, `AB_ATTACHMENT_DOWNLOAD` in
// stdio) and checks scope, type and size before and after the content request.
import { z } from 'zod';
import { agilityClient, mediaType } from '../../agility/client.ts';
import { ACTIVE_ATTACHMENT_TYPES, capBudget, type ToolContext } from '../../context.ts';
import { AbError, ErrorCode } from '../../errors.ts';
import { resolveAsset, runPage, runQuery } from '../../identity/resolve.ts';
import { oidsOf } from '../../identity/scope.ts';
import { metadataFor } from '../../metadata/service.ts';
import { shapeList, shapeOutput, untrusted } from '../../output/result.ts';
import { utcIso } from '../../output/text.ts';
import { compileQuery } from '../../query/compiler.ts';
import { cursorBinding, decodeCursor, encodeCursor } from '../../query/cursor.ts';
import { invalid } from '../../query/limits.ts';
import { defineTool, type ToolDefinition } from '../../tool.ts';
import { assetArg, cursorArg, formatArg, limitArg, rowOid } from '../common.ts';

const LIST_NAME = 'list_attachments';
const LIST_COST = 12;
const GET_COST = 12;
const MAX_LINKS = 50;
const DEFAULT_CHARS = 20_000;
const ATTACHMENT_ID = /^(?:Attachment:)?([1-9][0-9]{0,11})$/;

type Row = Readonly<Record<string, unknown>>;
const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/** The types `get_attachment` may return: the deployment's list without the types that run or render (A8). */
export function allowedAttachmentTypes(ctx: ToolContext): string[] {
  return ctx.limits.attachmentTypes
    .map((t) => mediaType(t))
    .filter((t) => t !== '' && !t.includes('*') && !ACTIVE_ATTACHMENT_TYPES.includes(t));
}

/** The metadata fields a type really has on this instance. */
async function present(ctx: ToolContext, type: string, candidates: readonly string[]): Promise<string[]> {
  const meta = await metadataFor(ctx).assetType(type);
  return candidates.filter((f) => meta.attributes.has(f.split('.')[0] as string));
}

const ATTACHMENT_FIELDS = [
  'Asset',
  'Name',
  'Filename',
  'ContentType',
  'ContentLength',
  'Description',
  'CreateDateUTC',
  'CreateDate',
  'CreatedBy',
  'CreatedBy.Name',
] as const;

function attachmentItem(r: Row): Record<string, unknown> {
  const author = oidsOf(r['CreatedBy'])[0];
  const created = text(r['CreateDateUTC']) ?? text(r['CreateDate']);
  const bytes = num(r['ContentLength']);
  const type = text(r['ContentType']);
  return {
    oid: rowOid(r),
    ...(text(r['Name']) ? { name: r['Name'] } : {}),
    ...(text(r['Filename']) ? { filename: r['Filename'] } : {}),
    ...(type === undefined ? {} : { contentType: mediaType(type) }),
    ...(bytes === undefined ? {} : { bytes }),
    ...(text(r['Description']) ? { description: r['Description'] } : {}),
    ...(author === undefined
      ? {}
      : { author: { oid: author, ...(text(r['CreatedBy.Name']) ? { name: r['CreatedBy.Name'] } : {}) } }),
    ...(created === undefined ? {} : { createdAt: utcIso(created) ?? created }),
  };
}

export const listAttachments: ToolDefinition = defineTool({
  name: LIST_NAME,
  title: 'List attachments and links of an asset',
  description:
    'List the attachments (files) of one asset in scope (name, file name, type, size, author, date) and, on the first page, its external links as text. Metadata only: no attachment content is fetched. Paged: pass nextCursor back as cursor. Cold call: up to 12 Agility requests.',
  kind: 'read',
  group: 'collaboration',
  // Capped at run time: resolving the asset, metadata for Attachment and Link (cold cache), the page, the links.
  cost: LIST_COST,
  inputSchema: z.object({ asset: assetArg, limit: limitArg, cursor: cursorArg, format: formatArg }),
  outputSchema: z.looseObject({
    items: z.array(z.looseObject({ oid: z.string() })),
    links: z.array(z.looseObject({ oid: z.string() })).optional(),
    nextCursor: z.string().optional(),
    truncated: z.boolean().optional(),
    partial: z.boolean().optional(),
    notes: z.array(z.string()).optional(),
    hiddenOutsideScope: z.boolean().optional(),
  }),
  handler: async (input, outer) => {
    const ctx = { ...outer, budget: capBudget(outer.budget, LIST_COST) };
    const target = await resolveAsset(ctx, input.asset);
    const binding = await cursorBinding(ctx, LIST_NAME, { asset: target.oid });
    const offset = input.cursor === undefined ? 0 : (await decodeCursor(ctx, input.cursor, binding)).offset;
    const fields = await present(ctx, 'Attachment', ATTACHMENT_FIELDS);
    // Newest first when the instance has a creation date; otherwise the stable order by ID (oldest first).
    const dateField = fields.find((f) => f === 'CreateDateUTC' || f === 'CreateDate');
    const compiled = await compileQuery(ctx, {
      assetType: 'Attachment',
      fields,
      filters: [{ field: 'Asset', op: 'eq', value: target.oid }],
      sort: dateField === undefined ? [] : [{ field: dateField, direction: 'desc' }],
      includeClosed: true,
      offset,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
    const page = await runPage(ctx, compiled);
    const items = page.rows.map(attachmentItem);
    const notes: string[] = [];
    const queries = [compiled.masked];
    // External links: text only, never fetched; the first page carries them (a later page would repeat them).
    let links: Array<Record<string, unknown>> | undefined;
    let partial = false;
    if (input.cursor === undefined) {
      const denied =
        ctx.assetTypes.deny.includes('Link') ||
        (ctx.assetTypes.allow !== undefined && !ctx.assetTypes.allow.includes('Link'));
      if (denied) {
        notes.push('External links are not shown: the Link type is not allowed in this workspace.');
      } else {
        const q = await compileQuery(ctx, {
          assetType: 'Link',
          fields: await present(ctx, 'Link', ['Name', 'URL']),
          filters: [{ field: 'Asset', op: 'eq', value: target.oid }],
          includeClosed: true,
          limit: MAX_LINKS,
        });
        const { rows } = await runQuery(ctx, q);
        queries.push(q.masked);
        links = rows.slice(0, MAX_LINKS).map((r) => ({
          oid: rowOid(r),
          ...(text(r['Name']) ? { name: r['Name'] } : {}),
          ...(text(r['URL']) ? { url: r['URL'] } : {}),
        }));
        if (rows.length > MAX_LINKS) {
          partial = true;
          notes.push(`Only the first ${MAX_LINKS} links are shown.`);
        }
      }
    }
    if (items.length === 0 && input.cursor === undefined) notes.push('No attachments on this asset.');
    if (ctx.limits.attachmentDownload)
      notes.push('Text attachments within the size and type limits can be read with get_attachment.');
    return shapeList(ctx, {
      summary: `${items.length} attachment${items.length === 1 ? '' : 's'} on ${target.number ?? target.oid}${links === undefined ? '' : `, ${links.length} link${links.length === 1 ? '' : 's'}`}${dateField === undefined ? '' : ', newest first'}.`,
      notes,
      source: 'attachments',
      rows: items,
      columns: ['oid', 'name', 'filename', 'contentType', 'bytes', 'author', 'createdAt', 'description'],
      hasMore: page.hasMore,
      cursorFor: (shown) => encodeCursor(binding, { offset: page.next(shown) }),
      hiddenOutsideScope: page.hidden > 0,
      partial,
      caps: { maxValueChars: 500 },
      meta: { queries },
      ...(links === undefined
        ? {}
        : { extraBlocks: [{ key: 'links', title: 'Links', source: 'links', rows: links }] }),
      ...(input.format === undefined ? {} : { format: input.format }),
    });
  },
});

function refuse(message: string, hint: string): AbError {
  return new AbError(ErrorCode.InputInvalid, message, { hint });
}

/** Valid UTF-8 text without NUL bytes, or null: binary content never goes into a text result. */
function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return null;
  }
}

export const getAttachment: ToolDefinition = defineTool({
  name: 'get_attachment',
  title: 'Get the text of an attachment',
  description:
    'Get the text of one attachment (an id from list_attachments) when the workspace allows download: allowed text types within the size limit, returned as untrusted data, never rendered or executed. Not paged. Long text is cut. Cold call: up to 12 Agility requests.',
  kind: 'read',
  group: 'attachments',
  // Capped at run time: the asset, Attachment metadata (cold cache), the attachment row, the content (retried reads).
  cost: GET_COST,
  inputSchema: z.object({
    asset: assetArg,
    attachment: z
      .string()
      .regex(ATTACHMENT_ID, 'Use an attachment id from list_attachments (Attachment:1234).')
      .describe('Attachment id (Attachment:1234) from list_attachments.'),
    max_characters: z
      .number()
      .int()
      .min(1)
      .max(100_000)
      .optional()
      .describe('Most characters of text to return; the rest is cut and the note says so.'),
  }),
  outputSchema: z.looseObject({
    attachment: z.looseObject({ oid: z.string(), contentType: z.string(), bytes: z.number() }),
    content: z.string(),
    truncated: z.boolean().optional(),
  }),
  handler: async (input, outer) => {
    const ctx = { ...outer, budget: capBudget(outer.budget, GET_COST) };
    // The switch is checked here as well as at listing time: a tool reached any other way still refuses (A8).
    if (!ctx.limits.attachmentDownload) {
      throw new AbError(ErrorCode.ToolDisabled, 'Attachment download is not enabled for this workspace.', {
        hint: 'An administrator turns it on per workspace and grant (AB_ATTACHMENT_DOWNLOAD in stdio).',
      });
    }
    const id = ATTACHMENT_ID.exec(input.attachment)?.[1];
    if (id === undefined) throw invalid('Not an attachment id.', 'Use an id from list_attachments.');
    const oid = `Attachment:${id}`;
    const allowed = allowedAttachmentTypes(ctx);
    const maxBytes = Math.min(ctx.limits.attachmentMaxBytes, ctx.limits.maxResponseBytes);
    // 1. Scope through the parent asset, before any content request: the asset must be in scope and the attachment
    //    must belong to it; the compiler adds the project predicate and every row is rechecked.
    const target = await resolveAsset(ctx, input.asset);
    const compiled = await compileQuery(ctx, {
      assetType: 'Attachment',
      fields: await present(ctx, 'Attachment', ATTACHMENT_FIELDS),
      filters: [
        { field: 'ID', op: 'eq', value: oid },
        { field: 'Asset', op: 'eq', value: target.oid },
      ],
      includeClosed: true,
      limit: 1,
    });
    const { rows } = await runQuery(ctx, compiled);
    // The row must be the attachment asked for, on the asset in scope: never trust the upstream to have applied the
    // filters before a content request is made for this id.
    const row = rows.find((r) => oidsOf(r['_oid'])[0] === oid && oidsOf(r['Asset'])[0] === target.oid);
    if (row === undefined) {
      throw new AbError(ErrorCode.NotFound, `${oid} was not found on ${target.number ?? target.oid}.`, {
        hint: 'Use an attachment id from list_attachments for this asset; it may also be outside the workspace.',
      });
    }
    // 2. Metadata checks: type allowlist and declared size (a cheap early refusal; the stream is the authority).
    const declaredType = mediaType(text(row['ContentType']) ?? '');
    if (declaredType === '' || !allowed.includes(declaredType)) {
      throw refuse(
        declaredType === ''
          ? 'The attachment has no content type, so it cannot be returned.'
          : `The attachment type ${declaredType.slice(0, 80)} is not one this workspace returns.`,
        `Allowed types: ${allowed.join(', ') || 'none'}. Nothing was fetched.`,
      );
    }
    const declaredBytes = num(row['ContentLength']);
    if (declaredBytes !== undefined && declaredBytes > maxBytes) {
      throw new AbError(
        ErrorCode.LimitResponseTooLarge,
        `The attachment is larger than ${Math.round(maxBytes / 1024)} KiB, the most this workspace returns.`,
        { hint: 'Nothing was fetched. Open it in Agility.', details: { maxBytes }, localDetails: true },
      );
    }
    // 3. The content: one request, type checked on the response, size counted on the stream.
    const res = await agilityClient(ctx).attachmentContent(id, { maxBytes, allowedTypes: allowed });
    const { bytes, contentType } = res.data;
    const content = decodeText(bytes);
    if (content === null) {
      throw refuse(
        'The attachment is not valid UTF-8 text.',
        'Only text is returned; binary content is never shown.',
      );
    }
    const asset = target.number ?? target.oid;
    // Audited: HTTP writes an audit row from this meta; stdio logs it (stderr, structured).
    const download = { asset, attachment: oid, bytes: bytes.byteLength, contentType };
    ctx.logger.info('attachment downloaded', download);
    const limit = input.max_characters ?? DEFAULT_CHARS;
    const name = text(row['Name']) ?? text(row['Filename']);
    const { output, texts } = shapeOutput(ctx, {
      summary: [
        'Attachment ',
        untrusted(name ?? oid),
        ` of ${asset}: ${content.length} characters, ${bytes.byteLength} bytes, ${contentType}.`,
      ],
      notes:
        content.length > limit
          ? [
              `The text was cut at ${limit} of ${content.length} characters; ask for more with max_characters (at most 100000).`,
            ]
          : [],
      texts: [{ source: 'attachment content', text: content, maxChars: limit }],
      structured: {
        asset: { oid: target.oid, ...(target.number === undefined ? {} : { number: target.number }) },
        attachment: {
          oid,
          ...(name === undefined ? {} : { name }),
          contentType,
          bytes: bytes.byteLength,
          characters: content.length,
        },
      },
      meta: { queries: [compiled.masked] },
    });
    const shown = texts[0];
    return {
      ...output,
      structured: {
        ...(output.structured as { attachment: { oid: string; contentType: string; bytes: number } }),
        content: shown?.text ?? '',
        ...(shown?.cut === true ? { truncated: true } : {}),
      },
      meta: { ...output.meta, 'agility-bridge/download': download },
    };
  },
});
