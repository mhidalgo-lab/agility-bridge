// SPDX-License-Identifier: Apache-2.0
// The XML asset document of a `rest-1.v1/Data` write (ADR-0011, RESEARCH 1.5): attributes are set, relations are set,
// added or removed. Attribute names and OIDs are validated against strict patterns and every value is escaped, so no
// caller text can add an element or an attribute to the document (ADR-0012 applies to writes too).
import { AbError, ErrorCode } from '../../errors.ts';

export type XmlOp =
  | { readonly attribute: string; readonly value: string | number | null }
  | { readonly relation: string; readonly act: 'set' | 'add' | 'remove'; readonly oids: readonly string[] };

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;
const OID_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}:\d{1,18}$/;
// Characters XML 1.0 cannot carry, and lone surrogates.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const NONCHARACTERS = ['\uFFFE', '\uFFFF'];
const unsafe = (text: string): boolean =>
  CONTROL.test(text) || LONE_SURROGATE.test(text) || NONCHARACTERS.some((c) => text.includes(c));

const bug = (what: string): AbError =>
  new AbError(ErrorCode.Internal, `A write built an invalid document (${what}).`);

export function xmlEscape(text: string): string {
  if (unsafe(text)) throw bug('a character XML cannot carry');
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** `<Asset>…</Asset>` with the operations in order. */
export function assetXml(ops: readonly XmlOp[]): string {
  if (ops.length === 0) throw bug('no operation');
  const parts = ops.map((op) => {
    if ('attribute' in op) {
      if (!NAME_RE.test(op.attribute)) throw bug('attribute name');
      if (typeof op.value === 'number' && !Number.isFinite(op.value)) throw bug('number');
      const value = op.value === null ? '' : xmlEscape(String(op.value));
      return `<Attribute name="${op.attribute}" act="set">${value}</Attribute>`;
    }
    if (!NAME_RE.test(op.relation)) throw bug('relation name');
    for (const oid of op.oids) if (!OID_RE.test(oid)) throw bug('OID');
    const assets = op.oids.map((oid) => `<Asset idref="${oid}"/>`).join('');
    return `<Relation name="${op.relation}" act="${op.act}">${assets}</Relation>`;
  });
  return `<Asset>${parts.join('')}</Asset>`;
}
