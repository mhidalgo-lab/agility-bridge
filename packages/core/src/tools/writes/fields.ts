// SPDX-License-Identifier: Apache-2.0
// What the two wave-2 tools (create_work_item, update_fields) share (P7-05): the typed field allowlist per work-item type,
// the plain-text rules for names and descriptions, the plain-text-to-HTML step and the priority resolver. A field that is
// not listed here cannot be written by either tool: no custom attribute, no Scope change, no status, no security-relevant
// relation (D-181).
import type { ToolContext } from '../../context.ts';
import { AbError, ErrorCode } from '../../errors.ts';
import { resolveByName } from '../../identity/resolve.ts';
import { metadataFor } from '../../metadata/service.ts';
import { hasHiddenCharacters } from '../../output/text.ts';
import { invalid } from '../../query/limits.ts';
import { assertTypeAllowed } from './common.ts';

export const FIELD_TYPES = ['Story', 'Defect', 'Task', 'Test', 'Epic'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** The attributes `update_fields` may change (`ToDo`, the remaining hours of a task or test, P7-17), and `create_work_item` may set besides the container and the parent. */
export const FIELD_ALLOWLIST: Readonly<Record<FieldType, readonly string[]>> = Object.freeze({
  Story: ['Name', 'Description', 'Estimate', 'Priority'],
  Defect: ['Name', 'Description', 'Estimate', 'Priority'],
  Task: ['Name', 'Description', 'DetailEstimate', 'ToDo'],
  Test: ['Name', 'Description', 'DetailEstimate', 'ToDo'],
  Epic: ['Name', 'Description'],
});

/** The relation a new item of this type uses for its parent (an epic for backlog items, a story or defect for tasks). */
export const PARENT_RELATION: Readonly<Record<FieldType, string>> = Object.freeze({
  Story: 'Super',
  Defect: 'Super',
  Epic: 'Super',
  Task: 'Parent',
  Test: 'Parent',
});

export const PARENT_TYPES: Readonly<Record<FieldType, readonly string[]>> = Object.freeze({
  Story: ['Epic'],
  Defect: ['Epic'],
  Epic: ['Epic'],
  Task: ['Story', 'Defect'],
  Test: ['Story', 'Defect'],
});

export const isFieldType = (t: string): t is FieldType => (FIELD_TYPES as readonly string[]).includes(t);

/** The attribute that holds `estimate` for the type, or undefined when the type has none. */
export const estimateField = (type: FieldType): 'Estimate' | 'DetailEstimate' | undefined =>
  FIELD_ALLOWLIST[type].includes('Estimate')
    ? 'Estimate'
    : FIELD_ALLOWLIST[type].includes('DetailEstimate')
      ? 'DetailEstimate'
      : undefined;

export const MAX_NAME_CHARS = 200;
export const MAX_DESCRIPTION_CHARS = 4_000;
export const MAX_ESTIMATE = 10_000;
const LINE_BREAKS = /\r\n?|[\u2028\u2029]/g;

/** A title: one line, no control or hidden characters, not empty. */
export function itemName(raw: string): string {
  const value = raw.trim();
  if (value === '') throw invalid('The name is empty.', 'Give a short title.');
  if (value.length > MAX_NAME_CHARS) {
    throw invalid(`The name is ${value.length} characters; at most ${MAX_NAME_CHARS}.`, 'Shorten it.');
  }
  if (/[\r\n\t\u2028\u2029]/.test(value) || hasHiddenCharacters(value)) {
    throw invalid(
      'The name contains line breaks, control, invisible or bidirectional characters.',
      'Use a single plain line; hidden characters would not be visible to the person who approves.',
    );
  }
  return value;
}

/** A description as plain text: line breaks normalised, nothing hidden, at most 4,000 characters, shown whole. */
export function descriptionText(raw: string): string {
  const value = raw.replace(LINE_BREAKS, '\n').trim();
  if (value === '') throw invalid('The description is empty.', 'Omit it to leave the description alone.');
  if (value.length > MAX_DESCRIPTION_CHARS) {
    throw invalid(
      `The description is ${value.length} characters; at most ${MAX_DESCRIPTION_CHARS}.`,
      'Shorten it: the person approves the whole text, so it is never cut.',
    );
  }
  if (hasHiddenCharacters(value)) {
    throw invalid(
      'The description contains control, invisible or bidirectional characters.',
      'Remove them; they would be hidden from the person who approves.',
    );
  }
  return value;
}

const htmlEscape = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Agility descriptions are HTML. The plain text the person approved is sent as escaped paragraphs (a blank line starts a
 * paragraph, a line break becomes `<br>`), so caller text can never add markup, a link or a script to the item (D-182).
 */
export function descriptionHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${p.split('\n').map(htmlEscape).join('<br>')}</p>`)
    .join('');
}

/** Tags a description written by this tool can contain (paragraphs and line breaks); everything else is formatting. */
const PLAIN_TAGS: ReadonlySet<string> = new Set(['p', 'br', 'div']);

/**
 * True when an existing HTML description holds formatting that plain text cannot represent: links, images, lists, tables,
 * headings, bold or italic, code, anything but paragraphs and line breaks. Replacing it would silently lose that content,
 * which the approval cannot show (D-196, L6 of the Phase 7 review).
 */
export function hasRichFormatting(html: string): boolean {
  for (const m of html.matchAll(/<\/?([A-Za-z][A-Za-z0-9]*)/g)) {
    if (!PLAIN_TAGS.has((m[1] as string).toLowerCase())) return true;
  }
  return false;
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;

export function estimateValue(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > MAX_ESTIMATE) {
    throw invalid(`${field} must be between 0 and ${MAX_ESTIMATE}.`);
  }
  return round2(value);
}

/** The priority by name or OID token from the list the type's `Priority` relation points at (never a free string). */
export async function resolvePriority(
  ctx: ToolContext,
  type: string,
  text: string,
): Promise<{ readonly oid: string; readonly name: string }> {
  const meta = await metadataFor(ctx).assetType(type);
  const attribute = meta.attributes.get('Priority');
  if (attribute === undefined || attribute.readOnly || attribute.kind !== 'Relation' || attribute.multi) {
    throw invalid(`Priority is not a writable attribute of ${type} on this instance.`);
  }
  const list = attribute.relatedType ?? 'WorkitemPriority';
  assertTypeAllowed(ctx, list);
  const found = await resolveByName(ctx, { what: 'priority', assetType: list, text, allowGlobal: true });
  return { oid: found.oid, name: found.name };
}

/** A refusal for a field the type's allowlist does not have: names what the type can take instead. */
export function notAllowed(type: FieldType, argument: string): AbError {
  return new AbError(ErrorCode.InputInvalid, `${argument} cannot be set on a ${type}.`, {
    hint: `A ${type} takes: ${FIELD_ALLOWLIST[type].join(', ')}.`,
  });
}
