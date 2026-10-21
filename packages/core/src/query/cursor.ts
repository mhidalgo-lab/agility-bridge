// SPDX-License-Identifier: Apache-2.0
// Paging cursors (tool conventions, Paging): `base64url(JSON)` with the offset, the first call's resolved window and a
// binding hash of tool + workspace + Agility projects + normalised query. A cursor is client input, so it is never
// trusted for scope: one from another tool, workspace or filter set, or a malformed one, is refused before any request.
import type { ToolContext } from '../context.ts';
import { MAX_OFFSET } from './compiler.ts';
import { invalid } from './limits.ts';
import type { TimeWindow } from './time.ts';

export interface CursorState {
  readonly offset: number;
  /** The first call's resolved window, kept for every later page. */
  readonly window?: TimeWindow;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 (hex) of what the cursor is bound to. */
export async function cursorBinding(ctx: ToolContext, tool: string, normalized: unknown): Promise<string> {
  const material = canonical({
    tool,
    instance: ctx.instance.id,
    projects: [...ctx.projects.allowed].sort(),
    includeChildren: ctx.projects.includeChildren,
    query: normalized,
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const toBase64Url = (s: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function encodeCursor(binding: string, state: CursorState): string {
  return toBase64Url(
    JSON.stringify({
      v: 1,
      b: binding,
      o: state.offset,
      ...(state.window === undefined ? {} : { w: state.window }),
    }),
  );
}

const refused = () =>
  invalid(
    'The cursor does not belong to this request.',
    'Pass nextCursor back unchanged, with the same tool and filters.',
  );

/** The cursor's state, or AB_INPUT_INVALID when it is malformed or bound to something else. */
export function decodeCursor(cursor: string, binding: string): CursorState {
  if (typeof cursor !== 'string' || cursor.length > 2_000 || !/^[A-Za-z0-9_-]+$/.test(cursor))
    throw refused();
  let parsed: { v?: unknown; b?: unknown; o?: unknown; w?: { since?: unknown; until?: unknown } };
  try {
    parsed = JSON.parse(fromBase64Url(cursor)) as typeof parsed;
  } catch {
    throw refused();
  }
  if (parsed.v !== 1 || parsed.b !== binding) throw refused();
  const offset = parsed.o;
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET)
    throw refused();
  const w = parsed.w;
  if (w === undefined) return { offset };
  if (
    typeof w.since !== 'string' ||
    typeof w.until !== 'string' ||
    Number.isNaN(Date.parse(w.since)) ||
    Number.isNaN(Date.parse(w.until))
  ) {
    throw refused();
  }
  return { offset, window: { since: w.since, until: w.until } };
}
