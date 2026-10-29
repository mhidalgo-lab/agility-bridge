// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// Users and roles (P4-04, THREAT_MODEL T14): who can sign in and as what. Owners manage everyone; admins manage members
// only; the last active owner can neither be demoted nor disabled, and the panel says so. A control is shown exactly when the
// admin API would allow it: the screens never offer a button that leads to a refusal page.
//
//   GET  /admin/users                list (owner, admin)
//   GET  /admin/users/new            add form        POST /admin/users            add (admins: members only)
//   GET  /admin/users/:id            detail
//   POST /admin/users/:id            name and email  POST .../role (owners)   POST .../disable | enable | sessions (confirmation first)
import type { Context, Hono } from 'hono';
import {
  Button,
  DataTable,
  Facts,
  Form,
  Layout,
  LinkButton,
  Pager,
  SelectField,
  TextField,
} from '../components.tsx';
import { adminPath, type UiKit, type UiPrincipal } from '../kit.ts';
import { errorPage, htmlResponse } from '../pages.tsx';
import { isId, one, parseUser, ROLES, type Role, rows, type User } from './data.ts';
import {
  confirmed,
  confirmPage,
  enabledState,
  FormError,
  field,
  formErrors,
  formMessage,
  isOk,
  isOwner,
  load,
  loadFailed,
  PAGE_SIZE,
  personText,
  problemOf,
  RowAction,
  Screen,
  StatusBadge,
  When,
  withQuery,
} from './shared.tsx';

export const USERS = '/admin/users';
const ROUTE = '/users';
const MAX_NAME = 200;
const MAX_EMAIL = 320;

/**
 * May this viewer change this person (name, email, role, disabling)? Owners: anyone. Admins: members only. These are the
 * guards of the admin API (`guardedServices`); a test compares them with the API's answers for every pair of roles.
 */
export const canManage = (viewer: UiPrincipal, target: User): boolean =>
  viewer.role === 'owner' || (viewer.role === 'admin' && target.role === 'member');

/** May this viewer end this person's browser sessions? Yourself (any role), owners anyone, admins members. */
export const canEndSessions = (viewer: UiPrincipal, target: User): boolean =>
  target.id === viewer.userId || canManage(viewer, target);

/**
 * May this viewer clear this person's sign-in identity (P4-12)? Owners only, never their own account, and only while the
 * person is bound. The admin API (`guardedServices.users.unbind`) decides; this only decides whether to offer the button.
 */
export const canUnbind = (viewer: UiPrincipal, target: User): boolean =>
  viewer.role === 'owner' && target.id !== viewer.userId && target.idp !== null;

/**
 * May this viewer enable this person again (P4-15)? The same people they may disable, and only while the person is disabled
 * (the admin API answers 409 for anyone else). A recent sign-in for owners and admins is asked for on the way (re-authentication
 * page), as for disabling them.
 */
export const canEnable = (viewer: UiPrincipal, target: User): boolean =>
  canManage(viewer, target) && target.disabledAt !== null;

const roleTone = (r: Role) => (r === 'owner' ? 'info' : r === 'admin' ? 'ok' : 'muted');

function NewUser(props: {
  readonly viewer: UiPrincipal;
  readonly values: { email: string; role: string; displayName: string };
  readonly errors: Readonly<Record<string, string>>;
  readonly message?: string | undefined;
}) {
  const { viewer, values } = props;
  const roles = isOwner(viewer) ? ROLES : ROLES.filter((r) => r === 'member');
  return (
    <Layout title="Add a user" viewer={viewer} current={USERS}>
      <p>
        Adds a person who can then sign in with the email address you enter, through one of the configured
        providers.{' '}
        {isOwner(viewer)
          ? 'Owners and admins need a recent sign-in to add an owner or an admin.'
          : 'Admins add members; only an owner adds admins or owners.'}
      </p>
      <FormError message={props.message} />
      <Form action={USERS} csrf={viewer.csrf} label="Add a user">
        <TextField
          name="email"
          label="Email address"
          hint="Lowercase, as the identity provider reports it."
          type="email"
          inputmode="email"
          autocomplete="off"
          value={values.email}
          required
          maxlength={MAX_EMAIL}
          spellcheck={false}
          error={props.errors['email']}
        />
        <TextField
          name="displayName"
          label="Name (optional)"
          value={values.displayName}
          maxlength={MAX_NAME}
          error={props.errors['displayName']}
        />
        <SelectField
          name="role"
          label="Role"
          value={values.role}
          error={props.errors['role']}
          options={roles.map((r) => ({ value: r, label: r }))}
        />
        <div class="actions">
          <Button>Add user</Button>
          <LinkButton href={USERS} variant="secondary">
            Cancel
          </LinkButton>
        </div>
      </Form>
    </Layout>
  );
}

function UnbindPage(props: {
  readonly viewer: UiPrincipal;
  readonly user: User;
  readonly message?: string | undefined;
  readonly providers: readonly { readonly idp: string; readonly label: string }[];
}) {
  const { viewer, user } = props;
  const self = adminPath`/admin/users/${user.id}`;
  return (
    <Layout title={`Move ${personText(user)} to another provider?`} viewer={viewer} current={USERS}>
      <p>
        This clears the sign-in identity of {user.email} (now {user.idp ?? 'none'}) and ends their browser
        sessions everywhere. Nothing else changes: their role, grants and device tokens stay.
      </p>
      <p>
        <strong>Account takeover risk:</strong> the next verified sign-in whose email matches binds the
        account, at any configured provider. Anyone who controls that email address at a provider you
        configured gets the account. Do this only after checking with the person. It needs a recent sign-in.
      </p>
      <FormError message={props.message} />
      <Form action={`${self}/unbind`} csrf={viewer.csrf} label="Move to another provider">
        <input type="hidden" name="confirm" value="yes" />
        <TextField
          name="email"
          label="Type the person's email address to confirm"
          type="email"
          autocomplete="off"
          required
          maxlength={MAX_EMAIL}
          spellcheck={false}
        />
        <SelectField
          name="provider"
          label="Only this provider may bind next (optional)"
          hint="Leave it on 'Any configured provider' to allow all of them. A sign-in at another provider is refused for 24 hours."
          value=""
          options={[
            { value: '', label: 'Any configured provider' },
            ...props.providers.map((p) => ({ value: p.idp, label: `${p.label} (${p.idp})` })),
          ]}
        />
        <div class="actions">
          <Button variant="danger">Clear the identity</Button>
          <LinkButton href={self} variant="secondary">
            Cancel
          </LinkButton>
        </div>
      </Form>
    </Layout>
  );
}

const formFieldOf = (apiField: string | undefined): string | undefined =>
  ({ email: 'email', displayName: 'displayName', role: 'role' })[apiField ?? ''];

export function registerUsers(ui: Hono, kit: UiKit): void {
  const loadUser = async (c: Context, principal: UiPrincipal, id: string) => {
    const got = await load(kit, c, principal, adminPath`/users/${id}`, (b) => one(b, parseUser));
    return got.ok ? got.value : got.result;
  };

  ui.get(
    ROUTE,
    kit.page('admin', async (c, page) => {
      // One page from the server (one row more tells whether another follows): the cost does not grow with the number of
      // users (P4-28). A page past the end is empty with a link back.
      const raw = c.req.query('page');
      const n = raw !== undefined && /^\d{1,6}$/.test(raw) ? Math.max(1, Number(raw)) : 1;
      const got = await load(kit, c, page.principal, '/users', (b) => rows(b, parseUser), {
        limit: String(PAGE_SIZE + 1),
        offset: String((n - 1) * PAGE_SIZE),
      });
      if (!got.ok) return loadFailed(c, got.result, page.principal);
      const at = (p: number) => withQuery(USERS, { page: p === 1 ? undefined : String(p) });
      const list = {
        rows: got.value.slice(0, PAGE_SIZE),
        prev: n > 1 ? at(n - 1) : null,
        next: got.value.length > PAGE_SIZE ? at(n + 1) : null,
      };
      return page.html(
        <Screen page={page} title="Users" current={USERS}>
          <p>
            People who can sign in. A person's role decides what they can do here: owners manage everything,
            admins manage members and the access model, members use their own access.
          </p>
          <div class="actions page-actions">
            <LinkButton href={`${USERS}/new`}>Add a user</LinkButton>
          </div>
          <DataTable
            caption="Users"
            empty="No users."
            rows={list.rows}
            columns={[
              {
                header: 'Person',
                cell: (u) => <a href={adminPath`/admin/users/${u.id}`}>{personText(u)}</a>,
              },
              { header: 'Role', cell: (u) => <StatusBadge tone={roleTone(u.role)} text={u.role} /> },
              { header: 'Sign-in', cell: (u) => u.idp ?? 'not signed in yet' },
              { header: 'Status', cell: (u) => <StatusBadge {...enabledState(u.disabledAt)} /> },
            ]}
          />
          <Pager label="User pages" prev={list.prev} next={list.next} />
        </Screen>,
      );
    }),
  );

  ui.get(
    `${ROUTE}/new`,
    kit.page('admin', (_c, page) =>
      page.html(
        <NewUser
          viewer={page.principal}
          values={{ email: '', role: 'member', displayName: '' }}
          errors={{}}
        />,
      ),
    ),
  );

  ui.post(
    ROUTE,
    kit.form('admin', async (c, principal, form) => {
      const email = field(form, 'email');
      const name = field(form, 'displayName');
      const role = form.fields.get('role') ?? 'member';
      const values = {
        email: form.fields.get('email') ?? '',
        role: ROLES.includes(role as Role) ? role : 'member',
        displayName: form.fields.get('displayName') ?? '',
      };
      const errors: Record<string, string> = {};
      if (email === null || email.length < 3 || email.length > MAX_EMAIL || !email.includes('@'))
        errors['email'] = 'Enter an email address.';
      if (name !== null && name.length > MAX_NAME) errors['displayName'] = 'At most 200 characters.';
      if (!ROLES.includes(role as Role)) errors['role'] = 'Choose one of the roles.';
      const again = (errs: Record<string, string>, message?: string) =>
        htmlResponse(<NewUser viewer={principal} values={values} errors={errs} message={message} />, 422);
      if (Object.keys(errors).length > 0) return again(errors);
      const res = await kit.callAdmin(
        c,
        principal,
        {
          method: 'POST',
          path: '/users',
          body: { email, role, ...(name === null ? {} : { displayName: name }) },
        },
        form,
      );
      if (isOk(res)) {
        const created = one(res.body, parseUser);
        return kit.redirect(created === null ? USERS : adminPath`/admin/users/${created.id}`, 'created');
      }
      const problem = problemOf(res);
      if (problem.status === 422 || problem.status === 409) {
        const shown = formErrors(problem, formFieldOf);
        return again(shown.errors, shown.message);
      }
      return kit.fail(c, principal, res, `${USERS}/new`);
    }),
  );

  ui.get(
    `${ROUTE}/:id`,
    kit.page('admin', async (c, page) => {
      const { principal } = page;
      const id = c.req.param('id');
      if (!isId(id)) return errorPage(404, undefined, principal);
      const u = await loadUser(c, principal, id);
      if ('status' in u) return loadFailed(c, u, principal);
      const self = adminPath`/admin/users/${id}`;
      const manage = canManage(principal, u);
      return page.html(
        <Screen page={page} title={personText(u)} current={USERS}>
          <section class="card" aria-labelledby="facts-heading">
            <h2 id="facts-heading">Person</h2>
            <Facts
              items={[
                ['Email', u.email],
                ['Name', u.displayName ?? 'not set'],
                ['Role', <StatusBadge tone={roleTone(u.role)} text={u.role} />],
                ['Sign-in provider', u.idp ?? 'not signed in yet'],
                ['Status', <StatusBadge {...enabledState(u.disabledAt)} />],
                ['Added', <When at={u.createdAt} />],
                ['Disabled', <When at={u.disabledAt} none="no" />],
              ]}
            />
          </section>
          {manage ? (
            <section class="card" aria-labelledby="edit-heading">
              <h2 id="edit-heading">Name and email</h2>
              <Form action={self} csrf={principal.csrf} label="Edit the person">
                <TextField name="displayName" label="Name" value={u.displayName ?? ''} maxlength={MAX_NAME} />
                <TextField
                  name="email"
                  label="Email address"
                  hint="Changing the email of someone who is signed in ends nothing; they sign in with their provider account as before."
                  type="email"
                  autocomplete="off"
                  value={u.email}
                  required
                  maxlength={MAX_EMAIL}
                  spellcheck={false}
                />
                <Button>Save</Button>
              </Form>
            </section>
          ) : (
            <p class="muted">Only an owner can change an owner or an admin.</p>
          )}
          {isOwner(principal) ? (
            <section class="card" aria-labelledby="role-heading">
              <h2 id="role-heading">Role</h2>
              <p>Changing the role ends the person's browser sessions. It needs a recent sign-in.</p>
              <Form action={`${self}/role`} csrf={principal.csrf} label="Change the role">
                <SelectField
                  name="role"
                  label="Role"
                  value={u.role}
                  options={ROLES.map((r) => ({ value: r, label: r }))}
                />
                <Button>Change the role</Button>
              </Form>
            </section>
          ) : null}
          {canEndSessions(principal, u) || manage || canUnbind(principal, u) ? (
            <section class="card" aria-labelledby="end-heading">
              <h2 id="end-heading">Access</h2>
              <div class="actions">
                {canEndSessions(principal, u) ? (
                  <RowAction
                    action={`${self}/sessions`}
                    csrf={principal.csrf}
                    label="End their sessions…"
                    name={`End the sessions of ${u.email}`}
                  />
                ) : null}
                {canUnbind(principal, u) ? (
                  <LinkButton href={`${self}/unbind`} variant="secondary">
                    Move to another provider…
                  </LinkButton>
                ) : null}
                {manage && u.disabledAt === null ? (
                  <RowAction
                    action={`${self}/disable`}
                    csrf={principal.csrf}
                    label="Disable…"
                    name={`Disable ${u.email}`}
                  />
                ) : null}
                {canEnable(principal, u) ? (
                  <RowAction
                    action={`${self}/enable`}
                    csrf={principal.csrf}
                    label="Enable…"
                    name={`Enable ${u.email}`}
                  />
                ) : null}
              </div>
              <p class="hint">
                A disabled person cannot sign in and keeps no session. Their grants and device tokens are not
                removed: revoke them on the grants page, or enable the person again here.
              </p>
            </section>
          ) : null}
        </Screen>,
      );
    }),
  );

  ui.post(
    `${ROUTE}/:id`,
    kit.form('admin', async (c, principal, form) => {
      const id = c.req.param('id');
      if (!isId(id)) return kit.redirect(USERS, 'not_found');
      const self = adminPath`/admin/users/${id}`;
      const email = field(form, 'email');
      const name = field(form, 'displayName');
      if (
        email === null ||
        email.length > MAX_EMAIL ||
        !email.includes('@') ||
        (name !== null && name.length > MAX_NAME)
      )
        return kit.redirect(self, 'invalid');
      // Only what changed is sent: changing an owner or an admin needs a recent sign-in even for an unchanged field.
      const current = await loadUser(c, principal, id);
      if ('status' in current) return kit.fail(c, principal, current, USERS);
      const body: Record<string, unknown> = {};
      if (email.toLowerCase() !== current.email) body['email'] = email;
      if (name !== current.displayName) body['displayName'] = name;
      if (Object.keys(body).length === 0) return kit.redirect(self, 'saved');
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'PATCH', path: adminPath`/users/${id}`, body },
        form,
      );
      return isOk(res) ? kit.redirect(self, 'saved') : kit.fail(c, principal, res, self);
    }),
  );

  ui.post(
    `${ROUTE}/:id/role`,
    kit.form('owner', async (c, principal, form) => {
      const id = c.req.param('id');
      if (!isId(id)) return kit.redirect(USERS, 'not_found');
      const self = adminPath`/admin/users/${id}`;
      const role = form.fields.get('role');
      if (!ROLES.includes(role as Role)) return kit.redirect(self, 'invalid');
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'PATCH', path: adminPath`/users/${id}`, body: { role } },
        form,
      );
      return isOk(res) ? kit.redirect(self, 'saved') : kit.fail(c, principal, res, self);
    }),
  );

  ui.post(
    `${ROUTE}/:id/disable`,
    kit.form('admin', async (c, principal, form) => {
      const id = c.req.param('id');
      if (!isId(id)) return kit.redirect(USERS, 'not_found');
      const self = adminPath`/admin/users/${id}`;
      if (!confirmed(form)) {
        const u = await loadUser(c, principal, id);
        if ('status' in u) return kit.fail(c, principal, u, USERS);
        return confirmPage({
          viewer: principal,
          current: USERS,
          title: `Disable ${personText(u)}?`,
          paragraphs: [
            'They cannot sign in any more and their browser sessions end now. You can enable them again from their page.',
            'Their grants and device tokens stay until you revoke them on the grants page.',
          ],
          action: `${self}/disable`,
          confirm: 'Disable this person',
          cancel: self,
        });
      }
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'POST', path: adminPath`/users/${id}/disable` },
        form,
      );
      return isOk(res) ? kit.redirect(self, 'disabled') : kit.fail(c, principal, res, self);
    }),
  );

  ui.post(
    `${ROUTE}/:id/enable`,
    kit.form('admin', async (c, principal, form) => {
      const id = c.req.param('id');
      if (!isId(id)) return kit.redirect(USERS, 'not_found');
      const self = adminPath`/admin/users/${id}`;
      if (!confirmed(form)) {
        const u = await loadUser(c, principal, id);
        if ('status' in u) return kit.fail(c, principal, u, USERS);
        // Not offered where the API refuses; a forged POST still reaches the API, which decides (and writes nothing).
        if (!canEnable(principal, u))
          return kit.redirect(self, u.disabledAt === null ? 'conflict' : 'not_allowed');
        return confirmPage({
          viewer: principal,
          current: USERS,
          title: `Enable ${personText(u)}?`,
          paragraphs: [
            'They can sign in again, with the same role as before. Nothing is created: they start a new session by signing in.',
            'Every grant and device token of theirs that was not revoked works again. Check them on the grants page first if you are not sure.',
          ],
          action: `${self}/enable`,
          confirm: 'Enable this person',
          cancel: self,
        });
      }
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'POST', path: adminPath`/users/${id}/enable` },
        form,
      );
      return isOk(res) ? kit.redirect(self, 'enabled') : kit.fail(c, principal, res, self);
    }),
  );

  ui.post(
    `${ROUTE}/:id/sessions`,
    kit.form('admin', async (c, principal, form) => {
      const id = c.req.param('id');
      if (!isId(id)) return kit.redirect(USERS, 'not_found');
      const self = adminPath`/admin/users/${id}`;
      if (!confirmed(form)) {
        const u = await loadUser(c, principal, id);
        if ('status' in u) return kit.fail(c, principal, u, USERS);
        return confirmPage({
          viewer: principal,
          current: USERS,
          title: `End the sessions of ${personText(u)}?`,
          paragraphs: [
            id === principal.userId
              ? 'Every browser session of yours ends, this one included. You sign in again afterwards.'
              : 'Every browser session of this person ends. They sign in again; nothing else changes.',
          ],
          action: `${self}/sessions`,
          confirm: 'End the sessions',
          cancel: self,
        });
      }
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'POST', path: adminPath`/users/${id}/sessions/revoke` },
        form,
      );
      if (!isOk(res)) return kit.fail(c, principal, res, self);
      if (id === principal.userId) {
        const headers = new Headers({ Location: '/auth/login' });
        headers.append('Set-Cookie', kit.deps.clearSessionCookie);
        return new Response(null, { status: 303, headers });
      }
      return kit.redirect(self, 'sessions_ended');
    }),
  );

  ui.get(
    `${ROUTE}/:id/unbind`,
    kit.page('owner', async (c, page) => {
      const { principal } = page;
      const id = c.req.param('id');
      if (!isId(id)) return errorPage(404, undefined, principal);
      const u = await loadUser(c, principal, id);
      if ('status' in u) return loadFailed(c, u, principal);
      // The API refuses these as well; the page is not offered for them.
      if (!canUnbind(principal, u)) return errorPage(404, undefined, principal);
      return page.html(
        <UnbindPage viewer={principal} user={u} providers={kit.deps.identityProviders ?? []} />,
      );
    }),
  );

  ui.post(
    `${ROUTE}/:id/unbind`,
    kit.form('owner', async (c, principal, form) => {
      const id = c.req.param('id');
      if (!isId(id)) return kit.redirect(USERS, 'not_found');
      const self = adminPath`/admin/users/${id}`;
      const u = await loadUser(c, principal, id);
      if ('status' in u) return kit.fail(c, principal, u, USERS);
      const email = field(form, 'email');
      // Nothing changes without the confirmation and the retyped email; the typed value is never shown back.
      if (!confirmed(form) || email === null || email.length > MAX_EMAIL) {
        return htmlResponse(
          <UnbindPage
            viewer={principal}
            user={u}
            providers={kit.deps.identityProviders ?? []}
            message="Type the person's email address to confirm."
          />,
          422,
        );
      }
      const provider = field(form, 'provider');
      const res = await kit.callAdmin(
        c,
        principal,
        {
          method: 'POST',
          path: adminPath`/users/${id}/unbind`,
          body: { confirm: email, ...(provider === null ? {} : { provider }) },
        },
        form,
      );
      if (isOk(res)) return kit.redirect(self, 'identity_cleared');
      const problem = problemOf(res);
      if (problem.status === 422) {
        // A provider this deployment does not have (a stale form): the API's own sentence, which lists the configured ones.
        const message =
          problem.field === 'provider' ? formMessage(problem) : "That is not this person's email address.";
        return htmlResponse(
          <UnbindPage
            viewer={principal}
            user={u}
            providers={kit.deps.identityProviders ?? []}
            message={message}
          />,
          422,
        );
      }
      return kit.fail(c, principal, res, self);
    }),
  );
}
