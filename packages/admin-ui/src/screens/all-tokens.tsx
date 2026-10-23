// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// Every device token in one list (P4-15, THREAT_MODEL T8, A5): find a lost device without opening each grant. Owners and
// admins only (a member's tokens are on their own grants, "My access"). Newest first, keyset-paged by the admin API
// (`GET /tokens`: the page carries the cursor of the next one), filtered by grant and by person. Only what the API returns is
// shown: a label, the first characters of the token, dates and the grant: never a hash or a token. Revoking uses the grant
// page's revoke route (confirmation first), which answers on that grant's page.
//
//   GET /admin/tokens?grant=&user=&after=     the list (owner, admin)
import type { Hono } from 'hono';
import { Button, DataTable, Pager, QueryForm, SelectField } from '../components.tsx';
import { adminPath, type UiKit } from '../kit.ts';
import {
  isId,
  parseGrant,
  parseTokenPage,
  parseUser,
  parseWorkspace,
  rows,
  TOKEN_CURSOR_RE,
  type User,
} from './data.ts';
import {
  lifecycle,
  load,
  loadFailed,
  personText,
  RowAction,
  Screen,
  StatusBadge,
  When,
  withQuery,
} from './shared.tsx';

export const TOKENS = '/admin/tokens';

export function registerAllTokens(ui: Hono, kit: UiKit): void {
  const now = () => (kit.deps.now ?? Date.now)();

  ui.get(
    '/tokens',
    kit.page('admin', async (c, page) => {
      const { principal } = page;
      const wantedGrant = c.req.query('grant');
      const wantedUser = c.req.query('user');
      const wantedAfter = c.req.query('after');
      const grantId = isId(wantedGrant) ? wantedGrant : undefined;
      const userId = isId(wantedUser) ? wantedUser : undefined;
      const after = wantedAfter !== undefined && TOKEN_CURSOR_RE.test(wantedAfter) ? wantedAfter : undefined;
      const got = await load(kit, c, principal, '/tokens', parseTokenPage, {
        ...(grantId === undefined ? {} : { grantId }),
        ...(userId === undefined ? {} : { userId }),
        ...(after === undefined ? {} : { after }),
      });
      if (!got.ok) return loadFailed(c, got.result, principal);
      const [grants, users, workspaces] = await Promise.all([
        load(kit, c, principal, '/grants', (b) => rows(b, parseGrant)),
        load(kit, c, principal, '/users', (b) => rows(b, parseUser)),
        load(kit, c, principal, '/workspaces', (b) => rows(b, parseWorkspace)),
      ]);
      const people = new Map<string, User>((users.ok ? users.value : []).map((u) => [u.id, u]));
      const spaces = new Map((workspaces.ok ? workspaces.value : []).map((w) => [w.id, w.name]));
      const t = now();
      const params = { grant: grantId, user: userId };
      const result = got.value;
      const whose = (userOf: string | null, label: string | null): string =>
        userOf === null
          ? `service: ${label ?? 'unnamed'}`
          : people.has(userOf)
            ? personText(people.get(userOf) as User)
            : 'unknown person';
      return page.html(
        <Screen page={page} title="Device tokens" current={TOKENS}>
          <p>
            Every device token of every grant, newest first. To make one, open the grant. A lost device is
            revoked here: the token stops working at once.
          </p>
          <QueryForm action={TOKENS} label="Filter device tokens">
            <SelectField
              name="user"
              label="Person"
              value={userId ?? ''}
              options={[
                { value: '', label: 'Everyone' },
                ...(users.ok ? users.value : []).map((u) => ({ value: u.id, label: personText(u) })),
              ]}
            />
            <SelectField
              name="grant"
              label="Grant"
              value={grantId ?? ''}
              options={[
                { value: '', label: 'All grants' },
                ...(grants.ok ? grants.value : []).map((g) => ({
                  value: g.id,
                  label: `${whose(g.userId, g.label)} in ${spaces.get(g.workspaceId) ?? 'a workspace'}`,
                })),
              ]}
            />
            <Button variant="secondary">Filter</Button>
          </QueryForm>
          {grants.ok && users.ok && workspaces.ok ? null : (
            <p class="muted">Some names could not be loaded; the list itself is complete.</p>
          )}
          <DataTable
            caption="Device tokens"
            empty="No device tokens."
            rows={result.data}
            columns={[
              { header: 'Device', cell: (k) => k.label },
              { header: 'Token', cell: (k) => <code>{`${k.prefix}…`}</code> },
              {
                header: 'Grant',
                cell: (k) => (
                  <a href={adminPath`/admin/grants/${k.grantId}`}>
                    {`${whose(k.userId, k.grantLabel)} in ${spaces.get(k.workspaceId) ?? 'a workspace'}`}
                  </a>
                ),
              },
              { header: 'Status', cell: (k) => <StatusBadge {...lifecycle(k, t)} /> },
              { header: 'Last used', cell: (k) => <When at={k.lastUsedAt} none="never" /> },
              { header: 'Expires', cell: (k) => <When at={k.expiresAt} none="never" /> },
              {
                header: 'Action',
                cell: (k) =>
                  k.revokedAt === null ? (
                    <RowAction
                      action={`/admin/grants${adminPath`/${k.grantId}/tokens/${k.id}/revoke`}`}
                      csrf={principal.csrf}
                      label="Revoke…"
                      name={`Revoke ${k.label}`}
                    />
                  ) : (
                    '—'
                  ),
              },
            ]}
          />
          <Pager
            label="Device token pages"
            next={result.next === null ? null : withQuery(TOKENS, { ...params, after: result.next })}
            first={after === undefined ? null : withQuery(TOKENS, params)}
          />
        </Screen>,
      );
    }),
  );
}
