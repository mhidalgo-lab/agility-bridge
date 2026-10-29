// SPDX-License-Identifier: Apache-2.0
// update_fields (P7-05): changes the title, description, estimate or priority of one work item, and nothing else. The
// field allowlist is typed per asset type (fields.ts); custom attributes, the project, the status, owners, parent and every
// other attribute have no argument and no allowlist entry, so they cannot be reached (D-181). The approval shows old ->
// new for each field; the re-read compares them. Only fields that actually differ are sent. The shapes are *unverified*
// until the sandbox (P7-07).
import { z } from 'zod';
import { AbError, ErrorCode } from '../../errors.ts';
import { richText } from '../../output/text.ts';
import { invalid } from '../../query/limits.ts';
import type { ToolDefinition } from '../../tool.ts';
import { defineWriteTool } from '../../writes/index.ts';
import { assetArg, num, text as textOf } from '../common.ts';
import type { XmlOp } from './asset-xml.ts';
import {
  idOf,
  labelFrom,
  labelOf,
  oidOfLabel,
  planTarget,
  postAsset,
  requireWritable,
  rereadTarget,
} from './common.ts';
import {
  descriptionHtml,
  descriptionText,
  estimateField,
  estimateValue,
  FIELD_ALLOWLIST,
  FIELD_TYPES,
  type FieldType,
  isFieldType,
  itemName,
  notAllowed,
  resolvePriority,
  round2,
} from './fields.ts';

const COST = 16;

/** Read for every type; attributes the type lacks are left out by the reader. */
const READ_FIELDS = ['Name', 'Description', 'Estimate', 'DetailEstimate', 'Priority', 'Priority.Name'];

/** The item's current values of the allowlisted fields; a description is read as plain text (it is HTML in Agility). */
function currentValues(
  row: Readonly<Record<string, unknown>>,
  type: FieldType,
): Record<string, string | number | null> {
  const description = textOf(row['Description']);
  const out: Record<string, string | number | null> = {
    Name: textOf(row['Name']) ?? null,
    Description: description === undefined ? null : richText(description) || null,
  };
  const estimate = estimateField(type);
  if (estimate !== undefined) {
    const n = num(row[estimate]);
    out[estimate] = n === undefined ? null : round2(n);
  }
  if (FIELD_ALLOWLIST[type].includes('Priority')) out['Priority'] = labelFrom(row, 'Priority');
  return out;
}

export const updateFields: ToolDefinition = defineWriteTool({
  name: 'update_fields',
  title: 'Update fields',
  description: `Change the title, description, estimate or priority of one open backlog item, defect, task, test or epic. Give only what changes; the person approves old and new for each. Not paged. Cold call: up to ${COST} Agility requests.`,
  kind: 'write',
  // Resolution, the item read, metadata (cold), the priority (1 to 3), the re-read and the one write.
  cost: COST,
  idempotent: true,
  inputSchema: z.object({
    asset: assetArg,
    name: z.string().min(1).max(400).optional().describe('New title: one line, at most 200 characters.'),
    description: z
      .string()
      .min(1)
      .max(8_000)
      .optional()
      .describe('New description, plain text, at most 4,000 characters; it replaces the old one.'),
    estimate: z
      .number()
      .min(0)
      .max(10_000)
      .optional()
      .describe('Story points for a story or defect; hours for a task or test. Not for an epic.'),
    priority: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Priority name or OID token, for a story or defect.'),
  }),
  allowedFields: Object.fromEntries(FIELD_TYPES.map((t) => [t, FIELD_ALLOWLIST[t]])),
  async plan(input, ctx) {
    if (
      input.name === undefined &&
      input.description === undefined &&
      input.estimate === undefined &&
      input.priority === undefined
    ) {
      throw invalid('Give at least one field to change.', 'Fields: name, description, estimate, priority.');
    }
    // Check the cheap arguments before any request.
    const name = input.name === undefined ? undefined : itemName(input.name);
    const description = input.description === undefined ? undefined : descriptionText(input.description);
    const target = await planTarget(ctx, input.asset, { types: FIELD_TYPES, fields: READ_FIELDS });
    if (!isFieldType(target.assetType))
      throw invalid(`${target.assetType} cannot be changed with this tool.`);
    const type = target.assetType;
    const estimateAttribute = estimateField(type);
    if (input.estimate !== undefined && estimateAttribute === undefined) throw notAllowed(type, 'estimate');
    if (input.priority !== undefined && !FIELD_ALLOWLIST[type].includes('Priority')) {
      throw notAllowed(type, 'priority');
    }
    const old = currentValues(target.row, type);
    const changes: Array<{ field: string; old: string | number | null; new: string | number }> = [];
    if (name !== undefined) {
      await requireWritable(ctx, type, 'Name');
      changes.push({ field: 'Name', old: old['Name'] ?? null, new: name });
    }
    if (description !== undefined) {
      await requireWritable(ctx, type, 'Description');
      changes.push({ field: 'Description', old: old['Description'] ?? null, new: description });
    }
    if (input.estimate !== undefined && estimateAttribute !== undefined) {
      await requireWritable(ctx, type, estimateAttribute);
      changes.push({
        field: estimateAttribute,
        old: old[estimateAttribute] ?? null,
        new: estimateValue(input.estimate, 'estimate'),
      });
    }
    if (input.priority !== undefined) {
      const priority = await resolvePriority(ctx, type, input.priority);
      changes.push({
        field: 'Priority',
        old: old['Priority'] ?? null,
        new: labelOf(priority.name, priority.oid),
      });
    }
    return {
      mutation: {
        operation: 'update_fields',
        target: {
          assetType: type,
          oid: target.oid,
          ...(target.number === undefined ? {} : { number: target.number }),
        },
        changes,
      },
      ...(target.version === undefined ? {} : { version: target.version }),
      ...(target.name === undefined ? {} : { label: target.name }),
    };
  },
  async reread(plan, ctx) {
    const t = plan.mutation.target;
    const type = t.assetType as FieldType;
    const now = await rereadTarget(ctx, t.assetType, t.oid, READ_FIELDS);
    const current = currentValues(now.row, type);
    return {
      values: Object.fromEntries(plan.mutation.changes.map((c) => [c.field, current[c.field] ?? null])),
      ...(now.version === undefined ? {} : { version: now.version }),
    };
  },
  async send(plan, ctx) {
    const ops = plan.mutation.changes.flatMap((c): XmlOp[] => {
      if (c.old === c.new) return [];
      switch (c.field) {
        case 'Name':
          return typeof c.new === 'string' ? [{ attribute: 'Name', value: c.new }] : [];
        case 'Description':
          return typeof c.new === 'string'
            ? [{ attribute: 'Description', value: descriptionHtml(c.new) }]
            : [];
        case 'Estimate':
        case 'DetailEstimate':
          return typeof c.new === 'number' ? [{ attribute: c.field, value: c.new }] : [];
        case 'Priority':
          return typeof c.new === 'string'
            ? [{ relation: 'Priority', act: 'set' as const, oids: [oidOfLabel(c.new)] }]
            : [];
        default:
          return [];
      }
    });
    if (ops.length === 0) throw new AbError(ErrorCode.Internal, 'update_fields lost its changes.');
    return postAsset(ctx, plan.mutation.target.assetType, idOf(plan.mutation.target.oid), ops);
  },
});
