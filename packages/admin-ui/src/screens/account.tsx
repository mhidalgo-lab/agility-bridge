// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// `/admin/account`: the signed-in person's own session, and two small forms that prove the form kit end to end. Both
// change things only through the admin API, as the signed-in user (same guards, same audit rows):
//
//   POST /admin/account/sessions   end every session of mine (`POST /users/{id}/sessions/revoke`), any role
//   POST /admin/account/name       change my display name (`PATCH /users/{id}`), owners; needs a recent sign-in, so it is
//                                  the panel's example of the re-authentication round trip
import type { Hono } from 'hono';
import {
  Button,
  CONFIRM_FIELD,
  ConfirmAction,
  Facts,
  Form,
  Layout,
  TextField,
  Time,
} from '../components.tsx';
import { adminPath, type UiKit } from '../kit.ts';

const ACCOUNT = '/admin/account';
const MAX_NAME = 200;

export function registerAccount(ui: Hono, kit: UiKit): void {
  ui.get(
    '/account',
    kit.page('member', (_c, page) => {
      const { principal } = page;
      return page.html(
        <Layout title="Account" viewer={principal} current={ACCOUNT} flash={page.flash}>
          <section class="card" aria-labelledby="who-heading">
            <h2 id="who-heading">Who you are</h2>
            <Facts
              items={[
                ['Email', principal.email],
                ['Name', principal.displayName ?? 'not set'],
                ['Role', principal.role],
                ['Recent sign-in', principal.recentAuth ? 'yes' : 'no (needed for high-impact changes)'],
                ['Session ends', <Time at={principal.expiresAt} />],
                ['Idle until', <Time at={principal.idleExpiresAt} />],
              ]}
            />
            <p>
              <a href={`/auth/reauth?next=${encodeURIComponent(ACCOUNT)}`}>Sign in again</a>
            </p>
          </section>
          {principal.role === 'owner' ? (
            <section class="card" aria-labelledby="name-heading">
              <h2 id="name-heading">Display name</h2>
              <Form action="/admin/account/name" csrf={principal.csrf} label="Display name">
                <TextField
                  name="displayName"
                  label="Name shown in the panel"
                  hint="Leave empty to remove it. Changing an owner needs a recent sign-in."
                  value={principal.displayName ?? ''}
                  maxlength={MAX_NAME}
                  autocomplete="name"
                />
                <Button>Save</Button>
              </Form>
            </section>
          ) : null}
          <section class="card" aria-labelledby="sessions-heading">
            <h2 id="sessions-heading">Sessions</h2>
            <p>Ends every browser session of yours, this one included. You sign in again afterwards.</p>
            <ConfirmAction
              action="/admin/account/sessions"
              csrf={principal.csrf}
              summary="End all my sessions"
              confirm="End all my sessions"
            />
          </section>
        </Layout>,
      );
    }),
  );

  ui.post(
    '/account/sessions',
    kit.form('member', async (c, principal, form) => {
      if (form.fields.get(CONFIRM_FIELD) !== 'yes') return kit.redirect(ACCOUNT, 'invalid');
      const result = await kit.callAdmin(
        c,
        principal,
        { method: 'POST', path: adminPath`/users/${principal.userId}/sessions/revoke` },
        form,
      );
      if (result.status !== 200) return kit.fail(c, principal, result, ACCOUNT);
      // The session this request used is gone: drop the cookie and go to sign-in.
      const headers = new Headers({ Location: '/auth/login' });
      headers.append('Set-Cookie', kit.deps.clearSessionCookie);
      return new Response(null, { status: 303, headers });
    }),
  );

  ui.post(
    '/account/name',
    kit.form('owner', async (c, principal, form) => {
      const name = (form.fields.get('displayName') ?? '').trim();
      if (name.length > MAX_NAME) return kit.redirect(ACCOUNT, 'invalid');
      const result = await kit.callAdmin(
        c,
        principal,
        {
          method: 'PATCH',
          path: adminPath`/users/${principal.userId}`,
          body: { displayName: name === '' ? null : name },
        },
        form,
      );
      if (result.status !== 200) return kit.fail(c, principal, result, ACCOUNT);
      return kit.redirect(ACCOUNT, 'saved');
    }),
  );
}
