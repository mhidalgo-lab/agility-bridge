// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// `GET /admin`: who is signed in, the session, sign-out, and (admins) the first users through the admin API. The
// reference page for P4-04 and later: a `kit.page` handler, data through `kit.callAdmin`, shared components only.
import type { Hono } from 'hono';
import { DataTable, Facts, Layout, LinkButton, SignOut, Time } from '../components.tsx';
import type { UiKit } from '../kit.ts';
import { budgetText, parseWriteBudget } from './data.ts';

interface UserRow {
  readonly email: string;
  readonly role: string;
  readonly disabled: boolean;
}

const SHOWN_USERS = 5;

/** The user list endpoint answers a JSON array; keep only the fields this page shows, as plain values. */
function userRows(body: unknown): { readonly total: number; readonly rows: UserRow[] } | null {
  if (!Array.isArray(body)) return null;
  const rows = body.slice(0, SHOWN_USERS).map((u: Record<string, unknown>) => ({
    email: String(u['email'] ?? ''),
    role: String(u['role'] ?? ''),
    disabled: u['disabledAt'] !== null && u['disabledAt'] !== undefined,
  }));
  return { total: body.length, rows };
}

export function registerOverview(ui: Hono, kit: UiKit): void {
  ui.get(
    '/',
    kit.page('member', async (c, page) => {
      const { principal } = page;
      let users: ReturnType<typeof userRows> | undefined;
      let writes: ReturnType<typeof parseWriteBudget> | undefined;
      if (principal.role !== 'member') {
        const res = await kit.callAdmin(c, principal, { method: 'GET', path: '/users' });
        users = res.status === 200 ? userRows(res.body) : null;
        // The deployment's writes this hour (P7-16): shown only where write tools exist; a failed read says unknown.
        const budget = await kit.callAdmin(c, principal, { method: 'GET', path: '/writes/budget' });
        writes = budget.status === 200 ? parseWriteBudget(budget.body, 'deployment') : null;
      }
      return page.html(
        <Layout title="Overview" viewer={principal} current="/admin" flash={page.flash}>
          <section class="card" aria-labelledby="session-heading">
            <h2 id="session-heading">Your session</h2>
            <Facts
              items={[
                ['Email', principal.email],
                ['Role', principal.role],
                ['Ends', <Time at={principal.expiresAt} />],
                ['Idle until', <Time at={principal.idleExpiresAt} />],
              ]}
            />
            <div class="actions">
              <LinkButton href="/admin/me">My access</LinkButton>
              <LinkButton href="/admin/account" variant="secondary">
                Account
              </LinkButton>
              <SignOut viewer={principal} />
              <SignOut viewer={principal} everywhere />
            </div>
          </section>
          {writes === undefined || (writes !== null && writes.state === 'off') ? null : (
            <section class="card" aria-labelledby="writes-heading">
              <h2 id="writes-heading">Writes this hour</h2>
              <Facts
                items={[
                  ['Whole server', budgetText(writes)],
                  ...(writes !== null && writes.state === 'ok'
                    ? ([['Resets', <Time at={writes.windowEndsAt} />]] as const)
                    : []),
                ]}
              />
            </section>
          )}
          {users === undefined ? null : users === null ? (
            <p class="flash flash-error" role="alert">
              The user list could not be loaded.
            </p>
          ) : (
            <DataTable
              caption={`Users (${users.total}, first ${SHOWN_USERS} shown)`}
              empty="No users yet."
              rows={users.rows}
              columns={[
                { header: 'Email', cell: (u) => u.email },
                { header: 'Role', cell: (u) => u.role },
                { header: 'Status', cell: (u) => (u.disabled ? 'disabled' : 'active') },
              ]}
            />
          )}
        </Layout>,
      );
    }),
  );
}
