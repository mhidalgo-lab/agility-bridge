// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// Usage statistics (P4-05, owner and admin): tool calls, errors, denials, Agility requests and durations per tool,
// workspace, grant, user or day. The numbers come from the admin API's bounded aggregate (`GET /audit/stats`: `tool_call`
// rows only, at most the newest 10,000 rows of the window, at most 100 groups); when the cap cut the window short the page
// says so instead of showing a plausible total (L-033). Bars are `<meter>` elements: no inline style, announced by screen
// readers. Group keys come from audit rows (tool names, ids): auto-escaped text, like everything else.
import type { Hono } from 'hono';
import type { JSX } from 'hono/jsx/jsx-runtime';
import { Button, DataTable, Layout, LinkButton, QueryForm, SelectField } from '../components.tsx';
import type { UiKit } from '../kit.ts';
import type { Names } from './audit.tsx';
import {
  parseUsage,
  parseUser,
  parseWorkspace,
  parseWriteStats,
  rows,
  type UsageRow,
  type WriteStatsRow,
} from './data.ts';
import { isOk, loadFailed, When } from './shared.tsx';

const BASE = '/admin/usage';

const WINDOWS = [
  ['24h', 'Last 24 hours', 86_400_000],
  ['7d', 'Last 7 days', 7 * 86_400_000],
  ['30d', 'Last 30 days', 30 * 86_400_000],
] as const;
const DEFAULT_WINDOW = '7d';
const GROUPS = [
  ['tool', 'Tool'],
  ['workspace', 'Workspace'],
  ['grant', 'Grant'],
  ['user', 'User'],
  ['day', 'Day (UTC)'],
] as const;

type Group = (typeof GROUPS)[number][0];

const pick = <T extends string>(
  v: string | undefined,
  allowed: readonly (readonly [T, ...unknown[]])[],
  dflt: T,
): T => allowed.find(([k]) => k === v)?.[0] ?? dflt;

/** `12.3%` of `part` in `whole` (no calls: a dash). */
export const percent = (part: number, whole: number): string =>
  whole === 0 ? '—' : `${((part / whole) * 100).toFixed(part === 0 || part === whole ? 0 : 1)}%`;

export const meanMs = (sum: number, count: number): string =>
  count === 0 ? '—' : `${Math.round(sum / count)} ms`;

function labelOf(group: Group, key: string | null, names: Names): string {
  if (key === null) return group === 'tool' ? '(none)' : `(no ${group})`;
  if (group === 'workspace') return names.workspaces.get(key) ?? key;
  if (group === 'user') return names.users.get(key) ?? key;
  return key;
}

const writeColumns = (label: string) => [
  { header: label, cell: (r: WriteStatsRow) => <code>{r.key}</code> },
  { header: 'Writes', cell: (r: WriteStatsRow) => r.writes.toLocaleString('en-US') },
  { header: 'Applied', cell: (r: WriteStatsRow) => String(r.ok) },
  { header: 'Failed', cell: (r: WriteStatsRow) => `${r.error} (${percent(r.error, r.writes)})` },
  { header: 'No outcome', cell: (r: WriteStatsRow) => String(r.noOutcome) },
  { header: 'In progress', cell: (r: WriteStatsRow) => String(r.inProgress) },
];

function WriteStatsSection(props: {
  readonly stats: ReturnType<typeof parseWriteStats>;
  readonly windowName: string;
}): JSX.Element {
  const { stats } = props;
  if (stats === null)
    return (
      <>
        <h2>Writes</h2>
        <p class="flash flash-error" role="status">
          The write statistics could not be loaded.
        </p>
      </>
    );
  return (
    <>
      <h2>Writes</h2>
      <p>
        Each change counts once: its intent row and its outcome row are paired. <em>No outcome</em> is an
        intent older than ten minutes without an outcome row: the change may or may not have been applied, so
        look at the item in Agility. Values are never stored, only field names.
      </p>
      {stats.truncated ? (
        <p class="flash flash-error" role="status">
          This window holds more write rows than the {stats.scanned.toLocaleString('en-US')} newest ones the
          statistics read, so the numbers cover only those. Choose a shorter window.
        </p>
      ) : null}
      <DataTable
        caption={`Writes by tool, ${props.windowName.toLowerCase()} (${stats.total.writes.toLocaleString('en-US')} writes)`}
        empty="No writes in this window."
        rows={stats.byTool}
        columns={writeColumns('Tool')}
      />
      <DataTable
        caption="Writes by approval channel"
        empty="No writes in this window."
        rows={stats.byChannel}
        columns={writeColumns('Channel')}
      />
      {stats.unpaired.length === 0 ? null : (
        <DataTable
          caption="Intents with no outcome recorded"
          empty=""
          rows={stats.unpaired}
          columns={[
            { header: 'When', cell: (r) => <When at={r.ts} /> },
            { header: 'Tool', cell: (r) => <code>{r.tool}</code> },
            {
              header: 'Target',
              cell: (r) => (r.targetType === null ? '—' : `${r.targetType} ${r.targetId ?? ''}`.trim()),
            },
            { header: 'Intent', cell: (r) => <code>{r.intentId}</code> },
          ]}
        />
      )}
    </>
  );
}

export function registerUsage(ui: Hono, kit: UiKit): void {
  const now = () => (kit.deps.now ?? Date.now)();

  ui.get(
    '/usage',
    kit.page('admin', async (c, page) => {
      const { principal } = page;
      const windowKey = pick(c.req.query('window'), WINDOWS, DEFAULT_WINDOW);
      const group = pick<Group>(c.req.query('by'), GROUPS, 'tool');
      const span = WINDOWS.find(([k]) => k === windowKey)?.[2] ?? 7 * 86_400_000;
      const stats = await kit.callAdmin(c, principal, {
        method: 'GET',
        path: '/audit/stats',
        query: { groupBy: group, from: String(Math.max(0, now() - span)), limit: '50' },
      });
      const usage = isOk(stats) ? parseUsage(stats.body) : null;
      if (usage === null) return loadFailed(c, stats, principal);
      // Names for display only; a failed lookup shows ids.
      const [workspaces, users] =
        group === 'workspace' || group === 'user'
          ? await Promise.all([
              kit.callAdmin(c, principal, { method: 'GET', path: '/workspaces' }),
              kit.callAdmin(c, principal, { method: 'GET', path: '/users' }),
            ])
          : [null, null];
      const names: Names = {
        workspaces: new Map(
          (
            (workspaces !== null && isOk(workspaces) ? rows(workspaces.body, parseWorkspace) : null) ?? []
          ).map((w) => [w.id, w.slug]),
        ),
        users: new Map(
          ((users !== null && isOk(users) ? rows(users.body, parseUser) : null) ?? []).map((u) => [
            u.id,
            u.email,
          ]),
        ),
      };
      // Writes (P7-11): a failed read leaves the tool-call statistics as they are and says so.
      const writeRes = await kit.callAdmin(c, principal, {
        method: 'GET',
        path: '/audit/write-stats',
        query: { from: String(Math.max(0, now() - span)) },
      });
      const writeStats = isOk(writeRes) ? parseWriteStats(writeRes.body) : null;
      const total = usage.rows.reduce((n, r) => n + r.calls, 0);
      const top = usage.rows.reduce((n, r) => Math.max(n, r.calls), 0);
      const groupName = GROUPS.find(([k]) => k === group)?.[1] ?? 'Group';
      const windowName = WINDOWS.find(([k]) => k === windowKey)?.[1] ?? '';
      return page.html(
        <Layout title="Usage" viewer={principal} current={BASE} flash={page.flash}>
          <p>
            Tool calls recorded in the audit log. Refused requests and administrative changes are not tool
            calls and are not counted here. A call that returned an error counts under Errors, a call refused
            by the access rules under Denied.
          </p>
          {usage.truncated ? (
            <p class="flash flash-error" role="status">
              This window holds more tool calls than the {usage.scanned.toLocaleString('en-US')} newest rows
              the statistics read, so the numbers cover only the newest ones. Choose a shorter window for
              exact figures.
            </p>
          ) : null}
          <QueryForm action={BASE} label="Choose the window and grouping">
            <SelectField
              name="window"
              label="Window"
              value={windowKey}
              options={WINDOWS.map(([value, label]) => ({ value, label }))}
            />
            <SelectField
              name="by"
              label="Group by"
              value={group}
              options={GROUPS.map(([value, label]) => ({ value, label }))}
            />
            <Button variant="secondary">Show</Button>
          </QueryForm>
          <DataTable
            caption={`Tool calls by ${groupName.toLowerCase()}, ${windowName.toLowerCase()} (${usage.rows.length} groups shown, ${total.toLocaleString('en-US')} calls)`}
            empty="No tool calls in this window."
            rows={usage.rows}
            columns={[
              { header: groupName, cell: (r: UsageRow) => labelOf(group, r.key, names) },
              {
                header: 'Calls',
                cell: (r) => (
                  <>
                    {r.calls.toLocaleString('en-US')}{' '}
                    <meter
                      min={0}
                      max={Math.max(top, 1)}
                      value={r.calls}
                      aria-label={`${r.calls} of ${total} calls`}
                    >
                      {r.calls}
                    </meter>
                  </>
                ),
              },
              { header: 'Errors', cell: (r) => `${r.errors} (${percent(r.errors, r.calls)})` },
              { header: 'Denied', cell: (r) => `${r.denied} (${percent(r.denied, r.calls)})` },
              { header: 'Agility requests', cell: (r) => r.agilityRequests.toLocaleString('en-US') },
              { header: 'Mean time', cell: (r) => meanMs(r.durationSumMs, r.durationCount) },
              { header: 'Slowest', cell: (r) => (r.maxDurationMs === null ? '—' : `${r.maxDurationMs} ms`) },
            ]}
          />
          <WriteStatsSection stats={writeStats} windowName={windowName} />
          <div class="actions page-actions">
            <LinkButton href="/admin/audit?kind=write" variant="secondary">
              Write rows in the audit log
            </LinkButton>
            <LinkButton href="/admin/audit" variant="secondary">
              Audit log
            </LinkButton>
          </div>
        </Layout>,
      );
    }),
  );
}
