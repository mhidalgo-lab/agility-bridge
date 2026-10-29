// SPDX-License-Identifier: Apache-2.0
// A fake Agility behind an injected fetch (P1-12). It answers the endpoints the client uses from in-memory assets
// shaped like the P0-06 captures, evaluates the small filter subset tools send, and records every request. Anything it
// does not understand fails the test instead of silently matching too much or too little.
import type { FetchLike } from '../../src/index.ts';

export type Row = Readonly<Record<string, unknown>>;

export interface FakeCall {
  readonly method: string;
  /** Path below the instance, e.g. `query.v1`, `meta.v1/Story`. */
  readonly path: string;
  readonly body?: unknown;
}

export interface FakeAgilityOptions {
  /** Rows per asset type, flat: dotted keys (`Status.Name`) hold the values a selection of that path returns. */
  readonly assets?: Readonly<Record<string, readonly Row[]>>;
  /** `meta.v1/<Type>` bodies. */
  readonly meta?: Readonly<Record<string, unknown>>;
  /**
   * Point-in-time state per asset type (`asof` queries): the rows of the latest snapshot at or before the requested
   * instant; before the first snapshot nothing existed. A type without snapshots ignores `asof` and answers its
   * current rows.
   */
  readonly history?: Readonly<
    Record<string, ReadonlyArray<{ readonly at: string; readonly rows: readonly Row[] }>>
  >;
  /** Answer before the fake does (status codes, malformed bodies, delays); return undefined to fall through. */
  readonly override?: (req: Request, call: FakeCall) => Response | undefined | Promise<Response | undefined>;
  /**
   * `evaluate` (default) applies `where`/`filter`; `ignore-filters` returns every row, the hostile case of an upstream
   * that ignores the scope restriction (L-064: tools recheck scope after fetching).
   */
  readonly filters?: 'evaluate' | 'ignore-filters';
  readonly baseUrl?: string;
}

export const FAKE_BASE_URL = 'https://agility.example.com/SyntheticInstance';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export class FakeAgilityError extends Error {
  override name = 'FakeAgilityError';
}

interface Query {
  readonly from: string;
  readonly select?: readonly unknown[];
  readonly where?: Readonly<Record<string, unknown>>;
  readonly filter?: readonly string[];
  readonly with?: Readonly<Record<string, unknown>>;
  readonly sort?: readonly string[];
  readonly page?: { readonly start?: number; readonly size?: number };
  readonly asof?: string;
}

/** Agility splits a scalar bound value at commas into a list (L-162); the fake does the same. */
function boundValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return String(value).split(',');
}

const TERM_RE =
  /^([A-Za-z][A-Za-z0-9_.:]*)(<=|>=|!=|~=|=|<|>)(?:\$([A-Za-z][A-Za-z0-9_]*)|'([^']*)'|"([^"]*)")$/;

function relationValue(actual: unknown): string {
  if (actual === null || actual === undefined) return '';
  if (typeof actual === 'object') return String((actual as { _oid?: unknown })._oid ?? '');
  return String(actual);
}

function compareValues(actual: unknown, op: string, expected: string): boolean {
  const a = relationValue(actual);
  switch (op) {
    case '=':
      return a === expected;
    case '!=':
      return a !== expected;
    case '~=':
      return a.toLowerCase().includes(expected.toLowerCase());
    default: {
      const x = Number(a);
      const y = Number(expected);
      const [l, r] =
        a !== '' && Number.isFinite(x) && Number.isFinite(y) ? [x, y] : [Date.parse(a), Date.parse(expected)];
      if (Number.isNaN(l) || Number.isNaN(r)) return false;
      return op === '<' ? l < r : op === '<=' ? l <= r : op === '>' ? l > r : l >= r;
    }
  }
}

function term(row: Row, q: Query, text: string): boolean {
  const m = TERM_RE.exec(text.trim());
  if (m === null) throw new FakeAgilityError(`The fake does not understand the filter term "${text}".`);
  const [, attr = '', op = '=', variable, single, double] = m;
  let values: string[];
  if (variable !== undefined) {
    const bound = q.with?.[`$${variable}`];
    if (bound === undefined) throw new FakeAgilityError(`Unbound variable $${variable}.`);
    values = boundValues(bound);
  } else values = [single ?? double ?? ''];
  // `ID` is the asset itself.
  const actual = attr === 'ID' ? row['_oid'] : row[attr];
  const actuals: unknown[] = Array.isArray(actual) ? (actual.length === 0 ? [''] : actual) : [actual];
  if (op === '!=') return values.every((v) => actuals.every((x) => compareValues(x, '!=', v)));
  return values.some((v) => actuals.some((x) => compareValues(x, op, v)));
}

/** A tiny evaluator for the filter grammar tools emit: terms joined by `;` (AND) and `|` (OR), with parentheses. */
function evaluate(row: Row, q: Query, text: string): boolean {
  let i = 0;
  const atom = (): boolean => {
    if (text[i] === '(') {
      i++;
      const value = expr();
      if (text[i] !== ')') throw new FakeAgilityError(`Unbalanced parentheses in "${text}".`);
      i++;
      return value;
    }
    const start = i;
    let quote: string | undefined;
    while (i < text.length) {
      const c = text[i] as string;
      if (quote !== undefined) {
        if (c === quote) quote = undefined;
      } else if (c === "'" || c === '"') quote = c;
      else if (c === ';' || c === '|' || c === ')') break;
      i++;
    }
    return term(row, q, text.slice(start, i));
  };
  const and = (): boolean => {
    let value = atom();
    while (text[i] === ';') {
      i++;
      const right = atom();
      value = value && right;
    }
    return value;
  };
  const expr = (): boolean => {
    let value = and();
    while (text[i] === '|') {
      i++;
      const right = and();
      value = value || right;
    }
    return value;
  };
  const value = expr();
  if (i !== text.length) throw new FakeAgilityError(`Unexpected "${text.slice(i)}" in "${text}".`);
  return value;
}

function matches(row: Row, q: Query): boolean {
  for (const [k, v] of Object.entries(q.where ?? {})) {
    if (!boundValues(v).includes(String(row[k]))) return false;
  }
  return (q.filter ?? []).every((entry) => evaluate(row, q, entry));
}

function project(row: Row, select: readonly unknown[] | undefined): Row {
  const out: Record<string, unknown> = { _oid: row['_oid'] };
  for (const s of select ?? []) {
    if (typeof s === 'string') {
      // Server-built bracket filters (`Children[AssetState!='Dead'].@Count`) read the plain path's value.
      const plain = s.replace(/\[[^\]]*\]/g, '');
      out[s] = Object.hasOwn(row, s) ? row[s] : Object.hasOwn(row, plain) ? row[plain] : null;
    } else if (s !== null && typeof s === 'object') {
      const nested = s as { from?: string; select?: unknown[] };
      const from = nested.from ?? '';
      const value = row[from];
      out[from] = Array.isArray(value) ? value.map((v) => project(v as Row, nested.select)) : [];
    }
  }
  return out;
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a ?? '').localeCompare(String(b ?? ''));
}

function oidNumber(row: Row): number {
  return Number(String(row['_oid'] ?? '').split(':')[1] ?? 0);
}

export class FakeAgility {
  readonly calls: FakeCall[] = [];
  readonly baseUrl: string;
  readonly #options: FakeAgilityOptions;

  constructor(options: FakeAgilityOptions = {}) {
    this.#options = options;
    this.baseUrl = options.baseUrl ?? FAKE_BASE_URL;
  }

  /** The `fetch` to put into a `ToolContext`. */
  readonly fetch: FetchLike = async (req) => {
    const url = new URL(req.url);
    const base = new URL(`${this.baseUrl}/`);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
      throw new FakeAgilityError(`Request outside the instance: ${url.origin}${url.pathname}`);
    }
    const path = url.pathname.slice(base.pathname.length);
    const text = req.method === 'POST' ? await req.text() : '';
    const call: FakeCall = {
      method: req.method,
      path,
      // A JSON body is parsed; an XML write (rest-1.v1) stays the text that was sent, so tests can assert it exactly.
      ...(text === ''
        ? {}
        : {
            body:
              req.headers.get('content-type')?.includes('json') === false
                ? text
                : (JSON.parse(text) as unknown),
          }),
    };
    this.calls.push(call);
    const overridden = await this.#options.override?.(req, call);
    if (overridden !== undefined) return overridden;
    if (req.method === 'POST' && (path === 'query.v1' || path === 'query.legacy.v1')) {
      const queries = Array.isArray(call.body) ? (call.body as Query[]) : [call.body as Query];
      return json(queries.map((q) => this.#run(q)));
    }
    if (req.method === 'GET' && path.startsWith('meta.v1/')) {
      const meta = this.#options.meta?.[path.slice('meta.v1/'.length)];
      return meta === undefined
        ? new Response('', { status: 404 })
        : json(meta, 200, { etag: '"26.0.3.2.1"' });
    }
    throw new FakeAgilityError(`The fake does not serve ${req.method} ${path}.`);
  };

  /** Requests sent so far. */
  get requests(): number {
    return this.calls.length;
  }

  #run(q: Query): Row[] {
    if (typeof q?.from !== 'string') throw new FakeAgilityError('query.v1 needs `from`.');
    const type = q.from.split(':')[0] ?? '';
    let all = this.#options.assets?.[type] ?? [];
    const snapshots = this.#options.history?.[type];
    if (q.asof !== undefined && snapshots !== undefined) {
      const at = Date.parse(q.asof);
      const hit = snapshots
        .filter((x) => Date.parse(x.at) <= at)
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
      all = hit?.rows ?? [];
    }
    let rows = this.#options.filters === 'ignore-filters' ? [...all] : all.filter((r) => matches(r, q));
    for (const key of [...(q.sort ?? [])].reverse()) {
      const desc = key.startsWith('-');
      const attr = desc ? key.slice(1) : key;
      rows = [...rows].sort((a, b) => {
        const c = attr === 'ID' ? oidNumber(a) - oidNumber(b) : compare(a[attr], b[attr]);
        return desc ? -c : c;
      });
    }
    const start = q.page?.start ?? 0;
    const size = q.page?.size ?? rows.length;
    return rows.slice(start, start + size).map((r) => project(r, q.select));
  }
}
