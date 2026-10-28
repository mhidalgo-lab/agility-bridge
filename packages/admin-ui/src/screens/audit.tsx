// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// The audit viewer (P4-05, THREAT_MODEL T13, T17) and its CSV export.
//
//   GET /admin/audit        filterable, keyset-paged list; a member sees only their own rows (the admin API enforces it)
//   GET /admin/audit.csv    the same filter as a download (at most EXPORT_MAX rows, one API call)
//
// Rows hold ids; owners and admins get workspace and user names for display only (a deleted record falls back to its
// id). Every audit string can be influenced by a caller (tool names, error codes, masked queries, target ids), so all of
// it goes into the page as auto-escaped text and into the CSV as quoted text, with a leading apostrophe on anything a
// spreadsheet would run as a formula (L-041).
import type { Context, Hono } from 'hono';
import type { JSX } from 'hono/jsx/jsx-runtime';
import {
  Badge,
  type BadgeTone,
  Button,
  DataTable,
  Layout,
  LinkButton,
  Pager,
  QueryForm,
  SelectField,
  TextField,
} from '../components.tsx';
import { UI_PAGE_HEADERS } from '../headers.ts';
import type { UiKit, UiPrincipal } from '../kit.ts';
import { type AuditRow, isId, parseAudit, parseUser, parseWorkspace, rows } from './data.ts';
import { isOk, loadFailed, When, withQuery } from './shared.tsx';

const BASE = '/admin/audit';
const CSV_BASE = '/admin/audit.csv';
/** Rows on one page of the viewer. */
export const AUDIT_PAGE_SIZE = 50;
/** Rows in one export: one admin API call, the API's own ceiling (D1 Free: few queries per request, L-097). */
export const EXPORT_MAX = 1_000;

const RANGES = [
  ['1h', '1 hour', 3_600_000],
  ['24h', '24 hours', 86_400_000],
  ['7d', '7 days', 7 * 86_400_000],
  ['30d', '30 days', 30 * 86_400_000],
  ['90d', '90 days', 90 * 86_400_000],
  ['all', 'All retained', 0],
] as const;
export const DEFAULT_RANGE = '7d';
const KINDS = ['tool_call', 'write', 'auth', 'admin'] as const;
const STATUSES = ['ok', 'error', 'denied'] as const;

/** The filter a request carries: only validated values, so nothing odd reaches the admin API or a link. */
export interface AuditFilter {
  readonly range: string;
  readonly kind: string;
  readonly status: string;
  readonly action: string;
  readonly workspaceId: string;
  readonly userId: string;
}

const oneOf = <T extends string>(v: string | undefined, allowed: readonly T[]): T | '' =>
  allowed.find((a) => a === v) ?? '';
const idOr = (v: string | undefined): string => (isId(v) ? v : '');

export function filterFrom(c: Context): AuditFilter {
  const q = (name: string) => c.req.query(name);
  const action = q('action')?.trim() ?? '';
  const range = q('range');
  return {
    range: RANGES.some(([k]) => k === range) ? (range as string) : DEFAULT_RANGE,
    kind: oneOf(q('kind'), KINDS),
    status: oneOf(q('status'), STATUSES),
    action: /^[A-Za-z0-9_.:-]{1,100}$/.test(action) ? action : '',
    workspaceId: idOr(q('workspace')),
    userId: idOr(q('user')),
  };
}

/** Query parameters of the page for `f` (empty values and the default range left out). */
export function filterParams(f: AuditFilter): Record<string, string> {
  return {
    range: f.range === DEFAULT_RANGE ? '' : f.range,
    kind: f.kind,
    status: f.status,
    action: f.action,
    workspace: f.workspaceId,
    user: f.userId,
  };
}

/** The admin API query for `f`; `from` is taken from the server clock. */
export function apiQuery(f: AuditFilter, now: number): Record<string, string> {
  const span = RANGES.find(([k]) => k === f.range)?.[2] ?? 0;
  const q: Record<string, string> = {};
  if (f.kind !== '') q['kind'] = f.kind;
  if (f.status !== '') q['status'] = f.status;
  if (f.action !== '') q['action'] = f.action;
  if (f.workspaceId !== '') q['workspaceId'] = f.workspaceId;
  if (f.userId !== '') q['userId'] = f.userId;
  return span > 0 ? { ...q, from: String(Math.max(0, now - span)) } : q;
}

/** A page cursor: the timestamp and id of the last row shown (`<ts>.<id>`). */
export interface Cursor {
  readonly ts: number;
  readonly id: string;
}

const CURSOR = /^(\d{1,15})\.([A-Za-z0-9_:-]{1,128})$/;

export function parseCursor(v: string | undefined): Cursor | null {
  const m = v === undefined ? null : CURSOR.exec(v);
  return m === null ? null : { ts: Number(m[1]), id: m[2] as string };
}

export const cursorOf = (r: { readonly ts: number; readonly id: string }): string => `${r.ts}.${r.id}`;

/** Names for ids, from lists an owner or admin may read. Empty for a member. */
export interface Names {
  readonly workspaces: ReadonlyMap<string, string>;
  readonly users: ReadonlyMap<string, string>;
}

const NO_NAMES: Names = { workspaces: new Map(), users: new Map() };

/** `label`, or the bare id when it has no label. */
const named = (id: string, map: ReadonlyMap<string, string>): string => map.get(id) ?? id;

/** Who did it: the user (`you` for the viewer), device, grant and client, as short labelled lines. */
export function Actor(props: {
  readonly row: AuditRow;
  readonly names: Names;
  readonly viewerId: string;
}): JSX.Element {
  const { row, names } = props;
  const parts: [string, string][] = [];
  if (row.userId !== null)
    parts.push(['user', row.userId === props.viewerId ? 'you' : named(row.userId, names.users)]);
  if (row.tokenId !== null) parts.push(['device', row.tokenId]);
  else if (row.grantId !== null) parts.push(['grant', row.grantId]);
  if (row.clientId !== null) parts.push(['client', row.clientId]);
  if (parts.length === 0) return <span>—</span>;
  return (
    <>
      {parts.map(([label, value], i) => (
        <>
          {i === 0 ? null : <br />}
          <span class="muted">{label}: </span>
          {value}
        </>
      ))}
    </>
  );
}

const STATUS_TONE: Readonly<Record<string, BadgeTone>> = { ok: 'ok', error: 'error', denied: 'error' };

export const MAX_DETAILS = 300;
export const MAX_QUERY = 600;

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/** `key=value` pairs of the details object, cut off at MAX_DETAILS characters (display only). */
export function detailsText(details: AuditRow['details']): string {
  if (details === null) return '';
  const text = Object.entries(details)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
  return cut(text, MAX_DETAILS);
}

function Result(props: { readonly row: AuditRow }): JSX.Element {
  const r = props.row;
  const bits: string[] = [];
  if (r.errorCode !== null) bits.push(r.errorCode);
  if (r.durationMs !== null) bits.push(`${r.durationMs} ms`);
  if (r.agilityRequests !== null) bits.push(`${r.agilityRequests} Agility requests`);
  if (r.targetType !== null) bits.push(`${r.targetType}${r.targetId === null ? '' : ` ${r.targetId}`}`);
  if (r.assetNumbers !== null) bits.push(cut(r.assetNumbers.join(' '), 200));
  const details = detailsText(r.details);
  return (
    <>
      {bits.join(' · ') || '—'}
      {details === '' ? null : (
        <>
          <br />
          <span class="muted">{details}</span>
        </>
      )}
    </>
  );
}

/** The user filter lists at most this many users; every other name on the page is fetched by id (P4-28, D-128). */
const USER_FILTER_MAX = 100;

async function loadNames(kit: UiKit, c: Context, principal: UiPrincipal, wanted: readonly (string | null)[]) {
  const [workspaces, users] = await Promise.all([
    kit.callAdmin(c, principal, { method: 'GET', path: '/workspaces' }),
    kit.callAdmin(c, principal, { method: 'GET', path: '/users', query: { limit: String(USER_FILTER_MAX) } }),
  ]);
  const ws = isOk(workspaces) ? rows(workspaces.body, parseWorkspace) : null;
  const us = isOk(users) ? rows(users.body, parseUser) : null;
  // The users on this page (and the one filtered on) that the first USER_FILTER_MAX did not include.
  const known = new Set((us ?? []).map((u) => u.id));
  const missing = [...new Set(wanted.filter((id): id is string => id !== null && !known.has(id)))].slice(
    0,
    50,
  );
  const extra =
    us === null || missing.length === 0
      ? []
      : await kit
          .callAdmin(c, principal, { method: 'GET', path: '/users', query: { ids: missing.join(',') } })
          .then((r) => (isOk(r) ? (rows(r.body, parseUser) ?? []) : []));
  const listed = us ?? [];
  return {
    workspaces: ws,
    // The filtered user stays selectable even past the first USER_FILTER_MAX.
    users: [...listed, ...extra.filter((u) => u.id === wanted[0])],
    names: {
      workspaces: new Map((ws ?? []).map((w) => [w.id, w.slug])),
      users: new Map([...listed, ...extra].map((u) => [u.id, u.email])),
    } satisfies Names,
  };
}

export function registerAudit(ui: Hono, kit: UiKit): void {
  const now = () => (kit.deps.now ?? Date.now)();

  ui.get(
    '/audit',
    kit.page('member', async (c, page) => {
      const { principal } = page;
      const member = principal.role === 'member';
      const f = filterFrom(c);
      const cursor = parseCursor(c.req.query('after'));
      // One row more than the page tells whether there is a next page without counting anything.
      const res = await kit.callAdmin(c, principal, {
        method: 'GET',
        path: '/audit',
        query: {
          ...apiQuery(member ? { ...f, userId: '' } : f, now()),
          limit: String(AUDIT_PAGE_SIZE + 1),
          ...(cursor === null ? {} : { afterTs: String(cursor.ts), afterId: cursor.id }),
        },
      });
      const all = isOk(res) ? rows(res.body, parseAudit) : null;
      if (all === null) return loadFailed(c, res, principal);
      const shown = all.slice(0, AUDIT_PAGE_SIZE);
      const last = shown[shown.length - 1];
      const hasNext = all.length > AUDIT_PAGE_SIZE && last !== undefined;
      const loaded = member
        ? null
        : await loadNames(kit, c, principal, [f.userId || null, ...shown.map((r) => r.userId)]);
      const names = loaded?.names ?? NO_NAMES;
      const params = filterParams(member ? { ...f, userId: '' } : f);
      return page.html(
        <Layout title="Audit log" viewer={principal} current={BASE} flash={page.flash}>
          <p>
            {member
              ? 'Your own activity: tool calls made with your devices and changes you made.'
              : 'Every tool call, refused request and administrative change, newest first.'}{' '}
            Queries are shown as stored: every literal value is masked.
          </p>
          <QueryForm action={BASE} label="Filter the audit log">
            <SelectField
              name="range"
              label="Time"
              value={f.range}
              options={RANGES.map(([value, label]) => ({
                value,
                label: value === 'all' ? label : `Last ${label}`,
              }))}
            />
            <SelectField
              name="kind"
              label="Kind"
              value={f.kind}
              options={[{ value: '', label: 'All kinds' }, ...KINDS.map((k) => ({ value: k, label: k }))]}
            />
            <SelectField
              name="status"
              label="Outcome"
              value={f.status}
              options={[
                { value: '', label: 'Any outcome' },
                ...STATUSES.map((s) => ({ value: s, label: s })),
              ]}
            />
            <TextField
              name="action"
              label="Tool or action"
              hint="Exact name, for example search_assets or grant.revoke."
              value={f.action}
              maxlength={100}
            />
            {member || loaded === null ? null : (
              <>
                <SelectField
                  name="workspace"
                  label="Workspace"
                  value={f.workspaceId}
                  options={[
                    { value: '', label: 'All workspaces' },
                    ...(loaded.workspaces ?? []).map((w) => ({ value: w.id, label: w.slug })),
                  ]}
                />
                <SelectField
                  name="user"
                  label="User"
                  value={f.userId}
                  options={[
                    { value: '', label: 'All users' },
                    ...loaded.users.map((u) => ({ value: u.id, label: u.email })),
                  ]}
                />
              </>
            )}
            <Button variant="secondary">Filter</Button>
          </QueryForm>
          <div class="actions page-actions">
            <LinkButton href={withQuery(CSV_BASE, params)} variant="secondary">
              Download CSV
            </LinkButton>
            {member ? null : (
              <LinkButton href="/admin/usage" variant="secondary">
                Usage statistics
              </LinkButton>
            )}
          </div>
          <DataTable
            caption="Audit log"
            empty="No entries match."
            rows={shown}
            columns={[
              { header: 'When', cell: (r) => <When at={r.ts} /> },
              {
                header: 'Action',
                cell: (r) => (
                  <>
                    <code>{r.action}</code>
                    <br />
                    <span class="muted">{r.kind}</span>
                  </>
                ),
              },
              {
                header: 'Outcome',
                cell: (r) => <Badge tone={STATUS_TONE[r.status] ?? 'muted'}>{r.status}</Badge>,
              },
              {
                header: 'Who',
                cell: (r) => <Actor row={r} names={names} viewerId={principal.userId} />,
              },
              {
                header: 'Workspace',
                cell: (r) => (r.workspaceId === null ? '—' : named(r.workspaceId, names.workspaces)),
              },
              { header: 'Result', cell: (r) => <Result row={r} /> },
              {
                header: 'Query',
                cell: (r) => (r.query === null ? '—' : <code>{cut(r.query, MAX_QUERY)}</code>),
              },
              { header: 'Request', cell: (r) => (r.requestId === null ? '—' : <code>{r.requestId}</code>) },
            ]}
          />
          <Pager
            label="Audit pages"
            first={cursor === null ? null : withQuery(BASE, params)}
            next={hasNext ? withQuery(BASE, { ...params, after: cursorOf(last) }) : null}
          />
        </Layout>,
      );
    }),
  );

  ui.get(
    '/audit.csv',
    kit.page('member', async (c, page) => {
      const { principal } = page;
      // Pages accept cross-site navigations (a link from mail or chat); a download does not: another site's link must
      // not save the audit log to the visitor's disk. It lands on the audit page instead.
      const site = c.req.header('sec-fetch-site');
      if (site !== undefined && site !== 'same-origin' && site !== 'none')
        return kit.redirect(`${BASE}${new URL(c.req.url).search}`);
      const f = filterFrom(c);
      const res = await kit.callAdmin(c, principal, {
        method: 'GET',
        path: '/audit',
        query: {
          ...apiQuery(principal.role === 'member' ? { ...f, userId: '' } : f, now()),
          limit: String(EXPORT_MAX),
        },
      });
      const all = isOk(res) ? rows(res.body, parseAudit) : null;
      if (all === null) return loadFailed(c, res, principal);
      const day = new Date(now()).toISOString().slice(0, 10);
      return new Response(auditCsv(all), {
        status: 200,
        headers: {
          ...UI_PAGE_HEADERS,
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="audit-${day}.csv"`,
          'X-Content-Type-Options': 'nosniff',
          ...(all.length >= EXPORT_MAX ? { 'X-Export-Truncated': String(EXPORT_MAX) } : {}),
        },
      });
    }),
  );
}

export const CSV_COLUMNS = [
  'time',
  'id',
  'kind',
  'action',
  'status',
  'request_id',
  'user_id',
  'grant_id',
  'token_id',
  'client_id',
  'workspace_id',
  'error_code',
  'duration_ms',
  'agility_requests',
  'target_type',
  'target_id',
  'asset_numbers',
  'query',
  'details',
] as const;

/**
 * One CSV cell. Text is always quoted (`"` doubled), and anything a spreadsheet could take for a formula (a leading
 * `=`, `+`, `-`, `@`, tab, carriage return or line feed, or one of those signs after leading white space, which a
 * tool name or error message can contain) gets a leading `'` (L-041).
 */
export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  if (typeof value === 'number') return String(value);
  const safe = /^(?:[=+\-@\t\r\n]|\s+[=+\-@])/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

const isoTime = (ts: number): string => {
  try {
    return new Date(ts).toISOString();
  } catch {
    return String(ts);
  }
};

export function auditCsv(all: readonly AuditRow[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of all) {
    lines.push(
      [
        isoTime(r.ts),
        r.id,
        r.kind,
        r.action,
        r.status,
        r.requestId,
        r.userId,
        r.grantId,
        r.tokenId,
        r.clientId,
        r.workspaceId,
        r.errorCode,
        r.durationMs,
        r.agilityRequests,
        r.targetType,
        r.targetId,
        r.assetNumbers === null ? null : r.assetNumbers.join(' '),
        r.query,
        r.details === null ? null : JSON.stringify(r.details),
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}
