// SPDX-License-Identifier: Apache-2.0
// P0-12: the only way tenant responses are printed or recorded. Strings and numbers become type markers, so a shape
// shows structure (keys, nesting, array lengths) and never content, names, ids or the instance URL. Counts are read
// explicitly by the caller, never through this function.

const MAX_ITEMS = 3;

export function shape(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map(shape);
    return value.length > MAX_ITEMS ? [...items, `…(${value.length} items)`] : items;
  }
  switch (typeof value) {
    case 'string':
      return '<string>';
    case 'number':
      return '<number>';
    case 'boolean':
      return '<boolean>';
    case 'object': {
      const out: Record<string, unknown> = {};
      // Keys of tenant objects are attribute names, which can be custom (instance-specific): custom ones are masked.
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[/^Custom_/i.test(k) ? '<Custom_…>' : k] = shape(v);
      }
      return out;
    }
    default:
      return `<${typeof value}>`;
  }
}
