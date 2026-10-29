// SPDX-License-Identifier: Apache-2.0
// The canonical mutation (ADR-0013, ARCHITECTURE 6.6): what a write changes, as data. One target, explicit fields,
// old -> new, from the tool's allowlist. Approval shows it whole and binds to its hash (THREAT_MODEL T31, A2, L-106).
import { AbError, ErrorCode } from '../errors.ts';
import { cleanText, hasHiddenCharacters } from '../output/text.ts';

/** A value a write can set: scalars, null (clear) or a list of strings (OIDs, tags). */
export type WriteValue = string | number | boolean | null | readonly string[];

export interface WriteTarget {
  /** Agility asset type (`Story`, `Defect`, ...), validated by the tool against the instance metadata. */
  readonly assetType: string;
  /** OID token (`Story:1234`). */
  readonly oid: string;
  /** Asset number (`B-01234`), when known; shown to the person, never part of the hash. */
  readonly number?: string;
}

export interface FieldChange {
  /** An attribute name the tool's allowlist names for this asset type. */
  readonly field: string;
  readonly old: WriteValue;
  readonly new: WriteValue;
}

export interface CanonicalMutation {
  /** The tool's operation (`add_comment`, `update_status`, ...). */
  readonly operation: string;
  readonly target: WriteTarget;
  readonly changes: readonly FieldChange[];
}

/** Field allowlist per asset type, declared by the write tool. */
export type FieldAllowlist = Readonly<Record<string, readonly string[]>>;

export const MAX_CHANGES = 20;
export const MAX_VALUE_CHARS = 8_000;
export const MAX_LIST_ITEMS = 50;
/** The whole approval text may not pass this size: a change too large to read is refused, never truncated (L-106). */
export const MAX_APPROVAL_CHARS = 24_000;

const FIELD_RE = /^[A-Za-z][A-Za-z0-9_.]{0,79}$/;
const OID_RE = /^[A-Za-z][A-Za-z0-9]{0,63}:\d{1,18}$/;
const TYPE_RE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const NUMBER_RE = /^[A-Za-z]{1,4}-\d{1,12}$/;

const invalid = (message: string, hint: string): AbError =>
  new AbError(ErrorCode.InputInvalid, message, { hint, localDetails: true });
/** The tool built a mutation its own declaration forbids: our bug, never the caller's. */
const toolBug = (message: string): AbError => new AbError(ErrorCode.Internal, message);

export function valuesEqual(a: WriteValue, b: WriteValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }
  return a === b;
}

/** The longest old value shown to the person; a longer one is cut with a note (the hash still binds the whole value). */
export const MAX_OLD_DISPLAY_CHARS = 2_000;

/**
 * An old value as shown for approval. It came from Agility, so it never blocks a write: hidden characters are removed and
 * a long value is shortened, each with a visible note. The hash is over the full value (D-192, P7-09).
 */
export function displayOld(text: string): string {
  const flat = text.replace(/\r\n?|[\u2028\u2029]/g, '\n');
  const clean = cleanText(text);
  const hidden = clean !== flat;
  let shown = clean;
  let cut = false;
  if (clean.length > MAX_OLD_DISPLAY_CHARS) {
    let end = MAX_OLD_DISPLAY_CHARS;
    const last = clean.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
    shown = clean.slice(0, end);
    cut = true;
  }
  const notes = [
    ...(cut ? [`shortened for display, ${clean.length} characters in total`] : []),
    ...(hidden ? ['hidden characters removed for display'] : []),
  ];
  return notes.length === 0 ? text : `${shown} [${notes.join('; ')}]`;
}

/** The mutation as a person reads it: old values cleaned and shortened (never the new values, which are refused instead). */
export function forDisplay(m: CanonicalMutation): CanonicalMutation {
  const show = (v: WriteValue): WriteValue =>
    typeof v === 'string' ? displayOld(v) : Array.isArray(v) ? v.map(displayOld) : v;
  return { ...m, changes: m.changes.map((c) => ({ ...c, old: show(c.old) })) };
}

function checkValue(field: string, value: unknown, side: 'old' | 'new'): WriteValue {
  const text = (v: string): string => {
    // An old value is Agility's own: it is shown cleaned and shortened, never refused (D-192).
    if (side === 'old') return v;
    if (v.length > MAX_VALUE_CHARS) {
      throw invalid(
        `The ${side} value of ${field} is longer than ${MAX_VALUE_CHARS} characters, too long to show in full for approval.`,
        'Use a shorter value; an approval is never truncated.',
      );
    }
    // What the person reads must be exactly what is sent: no hidden characters (Trojan Source, zero-width).
    if (hasHiddenCharacters(v)) {
      throw invalid(
        `The ${side} value of ${field} contains control, invisible or bidirectional characters.`,
        'Remove them; they would be hidden from the person who approves.',
      );
    }
    return v;
  };
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw invalid(`The ${side} value of ${field} is not a finite number.`, 'Use a number.');
    }
    return value;
  }
  if (typeof value === 'string') return text(value);
  if (Array.isArray(value) && value.length <= MAX_LIST_ITEMS && value.every((v) => typeof v === 'string')) {
    return Object.freeze(value.map(text));
  }
  throw invalid(
    `The ${side} value of ${field} must be a string, number, boolean, null or a list of at most ${MAX_LIST_ITEMS} strings.`,
    'Use one of those types.',
  );
}

/**
 * Validates a tool's mutation against its allowlist and returns a normalised, frozen copy (changes sorted by field).
 * A shape the tool itself must never build (unknown asset type or field, duplicates, no change) is `AB_INTERNAL`; a
 * value the caller supplied that cannot be shown whole is `AB_INPUT_INVALID`.
 */
export function canonicalize(m: CanonicalMutation, allowed: FieldAllowlist): CanonicalMutation {
  if (!TYPE_RE.test(m.target.assetType) || !OID_RE.test(m.target.oid)) {
    throw toolBug('A write tool built a mutation without a valid single target.');
  }
  if (!m.target.oid.startsWith(`${m.target.assetType}:`)) {
    throw toolBug('A write tool built a mutation whose OID does not belong to its asset type.');
  }
  if (m.target.number !== undefined && !NUMBER_RE.test(m.target.number)) {
    throw toolBug('A write tool built a mutation with a malformed asset number.');
  }
  const fields = Object.hasOwn(allowed, m.target.assetType) ? allowed[m.target.assetType] : undefined;
  if (fields === undefined) {
    throw toolBug(`A write tool built a mutation for ${m.target.assetType}, which it does not declare.`);
  }
  if (m.changes.length === 0 || m.changes.length > MAX_CHANGES) {
    throw toolBug(
      `A write tool built a mutation with ${m.changes.length} changes (1 to ${MAX_CHANGES} allowed).`,
    );
  }
  const seen = new Set<string>();
  const changes: FieldChange[] = [];
  for (const c of m.changes) {
    if (!FIELD_RE.test(c.field) || !fields.includes(c.field)) {
      throw toolBug(
        `A write tool built a change to ${String(c.field).slice(0, 80)}, which is not in its allowlist.`,
      );
    }
    if (seen.has(c.field)) throw toolBug(`A write tool changed ${c.field} twice in one mutation.`);
    seen.add(c.field);
    changes.push(
      Object.freeze({
        field: c.field,
        old: checkValue(c.field, c.old, 'old'),
        new: checkValue(c.field, c.new, 'new'),
      }),
    );
  }
  changes.sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
  return Object.freeze({
    operation: m.operation,
    target: Object.freeze({
      assetType: m.target.assetType,
      oid: m.target.oid,
      ...(m.target.number === undefined ? {} : { number: m.target.number }),
    }),
    changes: Object.freeze(changes),
  });
}

/** True when every change already holds its new value (an idempotent no-op). */
export function isNoop(m: CanonicalMutation): boolean {
  return m.changes.every((c) => valuesEqual(c.old, c.new));
}

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * SHA-256 over the tool, the actor, the operation, the target and every change (field, old, new). Display-only data
 * (the asset number) is not part of it. The approval is valid for exactly this and nothing else (T31).
 */
export async function mutationHash(tool: string, actor: string, m: CanonicalMutation): Promise<string> {
  const body = JSON.stringify([
    1,
    tool,
    actor,
    m.operation,
    m.target.assetType,
    m.target.oid,
    m.changes.map((c) => [c.field, c.old, c.new]),
  ]);
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
}
