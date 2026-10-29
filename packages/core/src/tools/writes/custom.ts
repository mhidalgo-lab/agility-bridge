// SPDX-License-Identifier: Apache-2.0
// Workspace-enabled writable custom attributes (P7-20, D-238): what `create_work_item` and `update_fields` share. An owner
// names the `Custom_X` attributes an agent may write in a workspace (`ctx.workspace.writes.customFields`); the tool takes
// them as `{ attribute, value }` pairs. Nothing here names an instance attribute in a tool description (THREAT_MODEL A12):
// the caller learns names from `describe_asset_type`, whose output is enveloped. Each attribute is checked against the
// instance metadata (it exists on the type, is custom, writable, single-valued, of a kind this file can write) and each
// value against its kind: one line of text, plain text for a long-text attribute (sent as escaped paragraphs, like a
// description) or a number. The request shape is *unverified* until the sandbox (P7-07).
import { z } from 'zod';
import type { ToolContext } from '../../context.ts';
import { metadataFor } from '../../metadata/service.ts';
import { hasHiddenCharacters, richText } from '../../output/text.ts';
import { invalid } from '../../query/limits.ts';
import { CUSTOM_FIELD_RE, MAX_CUSTOM_PER_CALL, type WriteValue } from '../../writes/index.ts';
import { num, text as textOf } from '../common.ts';
import type { XmlOp } from './asset-xml.ts';
import { descriptionHtml, descriptionText, hasRichFormatting } from './fields.ts';

/** The attribute kinds a custom value may be written to. Lists, dates, booleans and relations are refused. */
export type CustomKind = 'Text' | 'LongText' | 'Numeric';
const KINDS: ReadonlySet<string> = new Set<CustomKind>(['Text', 'LongText', 'Numeric']);

export const MAX_CUSTOM_TEXT_CHARS: number = 400;
const MAX_CUSTOM_NUMBER = 1_000_000_000;

/** The `custom` argument. Static text: it never names an attribute of any instance (A12). */
export const customArg: z.ZodOptional<
  z.ZodArray<z.ZodObject<{ attribute: z.ZodString; value: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]> }>>
> = z
  .array(
    z.object({
      attribute: z.string().min(1).max(100),
      value: z.union([z.string().max(4_000), z.number()]),
    }),
  )
  .max(MAX_CUSTOM_PER_CALL)
  .optional()
  .describe(
    `Custom attributes the workspace owner enabled for writing: { attribute, value } pairs, text or a number; at most ${MAX_CUSTOM_PER_CALL}. Attribute names: describe_asset_type.`,
  );

export interface CustomInput {
  readonly attribute: string;
  readonly value: string | number;
}

export interface CustomChange {
  readonly field: string;
  readonly kind: CustomKind;
  readonly value: string | number;
}

/** The custom attributes the workspace enabled for this request (empty when it has none). */
export const enabledCustomFields = (ctx: ToolContext): readonly string[] =>
  ctx.workspace.writes.customFields ?? [];

/**
 * The caller's attribute names, checked before any request: a custom name, listed by the workspace, each once. A refusal
 * names only what the caller sent (clipped), never the owner's list.
 */
export function checkCustomNames(ctx: ToolContext, items: readonly CustomInput[] | undefined): string[] {
  if (items === undefined || items.length === 0) return [];
  const enabled = enabledCustomFields(ctx);
  const seen = new Set<string>();
  for (const item of items) {
    const name = item.attribute;
    if (!CUSTOM_FIELD_RE.test(name)) {
      throw invalid(
        `"${name.slice(0, 40).replace(/[^\w.-]/g, '?')}" is not a custom attribute name.`,
        'Custom attributes start with Custom_. Read the names with describe_asset_type.',
      );
    }
    if (!enabled.includes(name)) {
      throw invalid(
        `${name} is not enabled for writing in this workspace.`,
        'The workspace owner enables custom attributes for writing; ask them to enable it.',
      );
    }
    if (seen.has(name)) throw invalid(`${name} is given twice.`, 'Name each attribute once.');
    seen.add(name);
  }
  return [...seen];
}

/** One line of plain text, not empty, nothing hidden. */
function customText(name: string, raw: string): string {
  const value = raw.trim();
  if (value === '')
    throw invalid(`The value of ${name} is empty.`, 'Give a value, or leave the attribute alone.');
  if (value.length > MAX_CUSTOM_TEXT_CHARS) {
    throw invalid(
      `The value of ${name} is ${value.length} characters; at most ${MAX_CUSTOM_TEXT_CHARS} for a text attribute.`,
      'Shorten it: the person approves the whole value.',
    );
  }
  if (/[\r\n\t\u2028\u2029]/.test(value) || hasHiddenCharacters(value)) {
    throw invalid(
      `The value of ${name} contains line breaks, control, invisible or bidirectional characters.`,
      'Use one plain line; hidden characters would not be visible to the person who approves.',
    );
  }
  return value;
}

/** Validates each attribute against the type's metadata and each value against its kind; returns the typed changes. */
export async function planCustom(
  ctx: ToolContext,
  type: string,
  items: readonly CustomInput[] | undefined,
): Promise<CustomChange[]> {
  const names = checkCustomNames(ctx, items);
  if (names.length === 0 || items === undefined) return [];
  const meta = await metadataFor(ctx).assetType(type);
  const out: CustomChange[] = [];
  for (const item of items) {
    const name = item.attribute;
    const a = meta.attributes.get(name);
    if (a === undefined || !a.custom) {
      throw invalid(
        `${name} is not a custom attribute of ${type} on this instance.`,
        'Read the attributes with describe_asset_type.',
      );
    }
    if (a.readOnly || a.multi || !KINDS.has(a.kind)) {
      throw invalid(
        `${name} cannot be written with this tool: it is read-only, has several values, or is not plain text or a number.`,
      );
    }
    const kind = a.kind as CustomKind;
    if (kind === 'Numeric') {
      if (
        typeof item.value !== 'number' ||
        !Number.isFinite(item.value) ||
        Math.abs(item.value) > MAX_CUSTOM_NUMBER
      ) {
        throw invalid(
          `${name} takes a number (at most ${MAX_CUSTOM_NUMBER} in size).`,
          'Give a number, not text.',
        );
      }
      out.push({ field: name, kind, value: Math.round(item.value * 10_000) / 10_000 });
      continue;
    }
    if (typeof item.value !== 'string') throw invalid(`${name} takes text.`, 'Give text, not a number.');
    out.push({
      field: name,
      kind,
      value: kind === 'LongText' ? descriptionText(item.value) : customText(name, item.value),
    });
  }
  return out;
}

/** The current value of a custom attribute of a row as shown in the approval (a long text is plain text). */
export function customCurrent(
  row: Readonly<Record<string, unknown>>,
  field: string,
  kind: CustomKind,
): WriteValue {
  if (kind === 'Numeric') {
    const n = num(row[field]);
    return n === undefined ? null : Math.round(n * 10_000) / 10_000;
  }
  const raw = textOf(row[field]);
  if (raw === undefined) return null;
  return kind === 'LongText' ? richText(raw) || null : raw;
}

/** A long text whose old value has formatting plain text cannot keep is not replaced (it would silently lose content). */
export function assertReplaceable(
  row: Readonly<Record<string, unknown>>,
  change: CustomChange,
  old: WriteValue,
  which: string,
): void {
  if (change.kind !== 'LongText') return;
  const raw = textOf(row[change.field]);
  if (raw !== undefined && hasRichFormatting(raw) && old !== change.value) {
    throw invalid(
      `The current value of ${change.field} on ${which} has formatting that plain text cannot keep (links, images, lists, tables or styles), so replacing it would lose that content.`,
      'Edit it in Agility instead.',
    );
  }
}

/** The kinds of the named attributes on the type, from the metadata the plan already read. */
export async function customKinds(
  ctx: ToolContext,
  type: string,
  fields: readonly string[],
): Promise<Map<string, CustomKind>> {
  const meta = await metadataFor(ctx).assetType(type);
  const out = new Map<string, CustomKind>();
  for (const f of fields) {
    const kind = meta.attributes.get(f)?.kind;
    if (kind !== undefined && KINDS.has(kind)) out.set(f, kind as CustomKind);
  }
  return out;
}

/** The request operation of one custom change. */
export const customOp = (field: string, kind: CustomKind, value: string | number): XmlOp => ({
  attribute: field,
  value: kind === 'LongText' && typeof value === 'string' ? descriptionHtml(value) : value,
});
