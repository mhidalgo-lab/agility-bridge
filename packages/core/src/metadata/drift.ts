// SPDX-License-Identifier: Apache-2.0
// Metadata drift (L-053): how an instance differs from the asset model the tools were built against. Only product
// attributes are compared and reported (custom ones are instance-specific), so a report holds product names only.
import type { AssetTypeMeta } from './model.ts';

/** Differences of `actual` from `expected`, one line each; empty when the product model matches. */
export function metadataDrift(expected: AssetTypeMeta, actual: AssetTypeMeta | undefined): string[] {
  if (actual === undefined) return [`${expected.name}: asset type missing`];
  const out: string[] = [];
  if ((expected.base ?? '') !== (actual.base ?? ''))
    out.push(`${expected.name}: base ${expected.base ?? '-'} → ${actual.base ?? '-'}`);
  if (expected.abstract !== actual.abstract)
    out.push(`${expected.name}: abstract ${expected.abstract} → ${actual.abstract}`);
  for (const a of expected.attributes.values()) {
    if (a.custom) continue;
    const b = actual.attributes.get(a.name);
    const id = `${expected.name}.${a.name}`;
    if (b === undefined) {
      out.push(`${id}: missing`);
      continue;
    }
    if (a.kind !== b.kind) out.push(`${id}: type ${a.kind} → ${b.kind}`);
    if (a.multi !== b.multi) out.push(`${id}: multi-value ${a.multi} → ${b.multi}`);
    if ((a.relatedType ?? '') !== (b.relatedType ?? ''))
      out.push(`${id}: relation ${a.relatedType ?? '-'} → ${b.relatedType ?? '-'}`);
  }
  return out;
}
