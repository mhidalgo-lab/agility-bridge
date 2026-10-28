// SPDX-License-Identifier: Apache-2.0
// Paging cursors (tool conventions, Paging): `base64url(JSON)` with the offset, the first call's resolved window and a
// binding hash of tool + workspace + Agility projects + normalised query (+ the window and "now" it carries). A cursor
// is client input, so it is never trusted for scope: one from another tool, workspace or filter set, an edited one, or a
// malformed one, is refused before any request. The hash has no secret, so what a cursor carries is also re-validated:
// a cursor never reaches more than a fresh call could (P1-18).
import type { ToolContext } from '../context.ts';
import { MAX_OFFSET } from './compiler.ts';
import { invalid } from './limits.ts';
import type { TimeWindow } from './time.ts';

export interface CursorState {
  readonly offset: number;
  /** Offsets per asset type, for lists that page several types at once. */
  readonly offsets?: Readonly<Record<string, number>>;
  /** The first call's resolved window, kept for every later page. */
  readonly window?: TimeWindow;
  /** The first call's "now" (ISO 8601 UTC), for lists whose filters depend on it (`list_sprints` timing). */
  readonly now?: string;
}

/** What a cursor carries unchanged from the first call. */
export interface CursorFixed {
  readonly window?: TimeWindow;
  readonly now?: string;
}

/** How old a cursor's "now" may be before the list must start again. */
export const CURSOR_MAX_AGE_MS = 86_400_000;

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
  return sha256(
    canonical({
      tool,
      instance: ctx.instance.id,
      projects: [...ctx.projects.allowed].sort(),
      includeChildren: ctx.projects.includeChildren,
      query: normalized,
    }),
  );
}

async function sha256(material: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The binding extended with what the first call fixed, so an edited window or "now" no longer matches. Pass the result
 * to `encodeCursor` with the same `fixed` values.
 */
export async function bindFixed(binding: string, fixed: CursorFixed): Promise<string> {
  if (fixed.window === undefined && fixed.now === undefined) return binding;
  return sha256(canonical({ binding, window: fixed.window, now: fixed.now }));
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
      ...(state.offsets === undefined ? {} : { t: state.offsets }),
      ...(state.window === undefined ? {} : { w: state.window }),
      ...(state.now === undefined ? {} : { n: state.now }),
    }),
  );
}

const refused = () =>
  invalid(
    'The cursor does not belong to this request.',
    'Pass nextCursor back unchanged, with the same tool and filters.',
  );

interface ParsedCursor {
  readonly state: CursorState;
  readonly bound: unknown;
}

/** Everything about a cursor that needs no request state: shape, offsets, window and "now" (no binding comparison). */
function parseCursor(ctx: ToolContext, cursor: string): ParsedCursor {
  if (typeof cursor !== 'string' || cursor.length > 2_000 || !/^[A-Za-z0-9_-]+$/.test(cursor))
    throw refused();
  let parsed: { v?: unknown; b?: unknown; o?: unknown; t?: unknown; w?: unknown; n?: unknown };
  try {
    parsed = JSON.parse(fromBase64Url(cursor)) as typeof parsed;
  } catch {
    throw refused();
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.v !== 1) throw refused();
  const offset = parsed.o;
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET)
    throw refused();
  let offsets: Record<string, number> | undefined;
  if (parsed.t !== undefined) {
    if (parsed.t === null || typeof parsed.t !== 'object' || Array.isArray(parsed.t)) throw refused();
    offsets = {};
    for (const [k, v] of Object.entries(parsed.t)) {
      if (
        !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k) ||
        typeof v !== 'number' ||
        !Number.isInteger(v) ||
        v < 0 ||
        v > MAX_OFFSET
      )
        throw refused();
      offsets[k] = v;
    }
  }
  const window = parsed.w === undefined ? undefined : checkWindow(parsed.w, ctx.limits.maxTimeRangeDays);
  const now = parsed.n === undefined ? undefined : checkNow(parsed.n, ctx.clock.now());
  return {
    bound: parsed.b,
    state: {
      offset,
      ...(offsets === undefined ? {} : { offsets }),
      ...(window === undefined ? {} : { window }),
      ...(now === undefined ? {} : { now }),
    },
  };
}

/**
 * Refuses a cursor that is malformed or carries a window or "now" a fresh call could not have, without the binding.
 * A tool whose binding needs upstream lookups (names resolved to ids) calls this first, so a bad cursor costs no
 * request (L-318); `decodeCursor` still checks the binding.
 */
export function checkCursorShape(ctx: ToolContext, cursor: string | undefined): void {
  if (cursor !== undefined) parseCursor(ctx, cursor);
}

/**
 * The cursor's state, or AB_INPUT_INVALID when it is malformed, bound to something else, or carries a window or "now" a
 * fresh call could not have (a window longer than `maxTimeRangeDays`, a "now" in the future or older than a day).
 */
export async function decodeCursor(ctx: ToolContext, cursor: string, binding: string): Promise<CursorState> {
  const { state, bound } = parseCursor(ctx, cursor);
  // Compare only after the fields were checked: the expected binding is hashed from the cursor's own window and "now".
  const expected = await bindFixed(binding, {
    ...(state.window === undefined ? {} : { window: state.window }),
    ...(state.now === undefined ? {} : { now: state.now }),
  });
  if (bound !== expected) throw refused();
  return state;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function instant(v: unknown): number {
  if (typeof v !== 'string' || !ISO_UTC.test(v)) throw refused();
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw refused();
  return t;
}

function checkWindow(w: unknown, maxDays: number): TimeWindow {
  if (w === null || typeof w !== 'object' || Array.isArray(w)) throw refused();
  const { since, until } = w as { since?: unknown; until?: unknown };
  const from = instant(since);
  const to = instant(until);
  if (to <= from || (to - from) / 86_400_000 > maxDays) throw refused();
  return { since: since as string, until: until as string };
}

function checkNow(n: unknown, clock: number): string {
  const t = instant(n);
  if (t > clock + 60_000 || t < clock - CURSOR_MAX_AGE_MS) throw refused();
  return n as string;
}
