// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// Agility credentials (P4-04, THREAT_MODEL A5): the access tokens the server uses for Agility, shared or personal. A token
// is typed once into a password field and never comes back: not in a page, a validation error, a flash, a redirect or a
// log. Replacing a token needs a recent sign-in (the API asks; the panel offers it).
//
//   GET  /admin/credentials                 list (filter: instance)         (owner, admin)
//   GET  /admin/credentials/new             add form      POST /admin/credentials      add (shared, or my personal one)
//   GET  /admin/credentials/:id             detail: status, hint, reachable projects, forms
//   POST /admin/credentials/:id             rename        POST .../validate | revoke | delete (confirmation first)
//   GET  /admin/credentials/:id/token       replace-the-token form        POST .../token     replace (recent sign-in)
// Members add and rotate their own personal token in "My access" (P4-07).
import type { Context, Hono } from 'hono';
import {
  Button,
  DataTable,
  Facts,
  Form,
  Layout,
  LinkButton,
  Pager,
  QueryForm,
  SelectField,
  TextField,
} from '../components.tsx';
import { adminPath, type UiKit, type UiPrincipal } from '../kit.ts';
import { errorPage, htmlResponse } from '../pages.tsx';
import {
  type Credential,
  type Instance,
  isId,
  one,
  parseCredential,
  parseInstance,
  parseUser,
  rows,
  type User,
} from './data.ts';
import {
  confirmed,
  confirmPage,
  FormError,
  field,
  formMessage,
  isOk,
  load,
  loadFailed,
  paged,
  personText,
  problemOf,
  RowAction,
  Screen,
  StatusBadge,
  When,
  withQuery,
} from './shared.tsx';

export const CREDENTIALS = '/admin/credentials';
const ROUTE = '/credentials';
const MAX_LABEL = 200;
const MAX_TOKEN = 4_000;
/** The hint is the last characters of the token; shown as a tail, never as a prefix. */
const hintText = (hint: string): string => (hint === '' ? 'none' : `…${hint}`);

interface Lookups {
  readonly instances: ReadonlyMap<string, Instance>;
  readonly users: ReadonlyMap<string, User>;
}

const ownerText = (k: Credential, l: Lookups): string => {
  if (k.ownerUserId === null) return 'shared';
  const u = l.users.get(k.ownerUserId);
  return `personal: ${u === undefined ? 'unknown person' : personText(u)}`;
};

const statusOf = (k: Credential): { tone: 'ok' | 'error' | 'muted' | 'info'; text: string } => {
  if (k.revokedAt !== null) return { tone: 'error', text: 'revoked' };
  if (k.validationStatus === 'valid') return { tone: 'ok', text: 'valid' };
  if (k.validationStatus === 'invalid') return { tone: 'error', text: 'invalid' };
  return { tone: 'muted', text: 'not checked yet' };
};

/** May this person replace this credential's token? Shared: a manager. Personal: only its own person (the API says 404). */
const canReplace = (k: Credential, me: UiPrincipal): boolean =>
  k.revokedAt === null && (k.ownerUserId === null || k.ownerUserId === me.userId);

function NewCredential(props: {
  readonly viewer: UiPrincipal;
  readonly instances: readonly Instance[];
  readonly values: { instanceId: string; scope: string; label: string };
  readonly errors: Readonly<Record<string, string>>;
  readonly message?: string | undefined;
}) {
  const { viewer, values, errors } = props;
  return (
    <Layout title="Add a credential" viewer={viewer} current={CREDENTIALS}>
      <p>
        An Agility access token the server uses to read Agility. Create it on Agility's Applications page. The
        token is encrypted at once and can never be shown again; only its last characters are kept as a hint.
      </p>
      <FormError message={props.message} />
      <Form action={CREDENTIALS} csrf={viewer.csrf} label="Add a credential">
        <SelectField
          name="instanceId"
          label="Instance"
          value={values.instanceId}
          required
          error={errors['instanceId']}
          options={[
            { value: '', label: 'Choose an instance' },
            ...props.instances
              .filter((i) => i.disabledAt === null)
              .map((i) => ({ value: i.id, label: i.label })),
          ]}
        />
        <SelectField
          name="scope"
          label="Whose token is it?"
          hint="Shared tokens are read-only for everyone who uses them; a personal one acts as you in Agility."
          value={values.scope}
          error={errors['scope']}
          options={[
            { value: 'shared', label: 'Shared by the team (read-only grants)' },
            { value: 'mine', label: 'Mine (personal)' },
          ]}
        />
        <TextField
          name="label"
          label="Name"
          hint="For example Team read-only token."
          value={values.label}
          required
          maxlength={MAX_LABEL}
          error={errors['label']}
        />
        <TextField
          name="token"
          label="Agility access token"
          hint="Paste it here; it is not shown again, not even if this form has an error."
          type="password"
          required
          maxlength={MAX_TOKEN}
          error={errors['token']}
        />
        <div class="actions">
          <Button>Add credential</Button>
          <LinkButton href={CREDENTIALS} variant="secondary">
            Cancel
          </LinkButton>
        </div>
      </Form>
    </Layout>
  );
}

function ReplaceToken(props: {
  readonly viewer: UiPrincipal;
  readonly credential: Credential;
  readonly errors: Readonly<Record<string, string>>;
  readonly message?: string | undefined;
}) {
  const { viewer, credential: k } = props;
  const self = adminPath`/admin/credentials/${k.id}`;
  return (
    <Layout title="Replace the token" viewer={viewer} current={CREDENTIALS}>
      <p>
        For <strong>{k.label}</strong> (now {hintText(k.tokenHint)}). The new token is checked against Agility
        before anything uses it; until then the credential counts as not checked. This needs a recent sign-in.
      </p>
      <FormError message={props.message} />
      <Form action={`${self}/token`} csrf={viewer.csrf} label="Replace the token">
        <TextField
          name="token"
          label="New Agility access token"
          hint="Not shown again, not even if this form has an error."
          type="password"
          required
          maxlength={MAX_TOKEN}
          error={props.errors['token']}
        />
        <div class="actions">
          <Button>Replace the token</Button>
          <LinkButton href={self} variant="secondary">
            Cancel
          </LinkButton>
        </div>
      </Form>
    </Layout>
  );
}

export function registerCredentials(ui: Hono, kit: UiKit): void {
  const lookups = async (c: Context, principal: UiPrincipal) => {
    const [instances, users] = await Promise.all([
      load(kit, c, principal, '/instances', (b) => rows(b, parseInstance)),
      load(kit, c, principal, '/users', (b) => rows(b, parseUser)),
    ]);
    return {
      instanceList: instances.ok ? instances.value : [],
      instances: new Map((instances.ok ? instances.value : []).map((i) => [i.id, i])),
      users: new Map((users.ok ? users.value : []).map((u) => [u.id, u])),
    };
  };

  const loadCredential = async (c: Context, principal: UiPrincipal, id: string) => {
    const got = await load(kit, c, principal, adminPath`/credentials/${id}`, (b) => one(b, parseCredential));
    return got.ok ? got.value : got.result;
  };

  ui.get(
    ROUTE,
    kit.page('admin', async (c, page) => {
      const { principal } = page;
      const wanted = c.req.query('instance');
      const instanceId = isId(wanted) ? wanted : undefined;
      const got = await load(
        kit,
        c,
        principal,
        '/credentials',
        (b) => rows(b, parseCredential),
        instanceId === undefined ? undefined : { instanceId },
      );
      if (!got.ok) return loadFailed(c, got.result, principal);
      const l = await lookups(c, principal);
      const list = paged(got.value, c.req.query('page'), CREDENTIALS, { instance: instanceId });
      return page.html(
        <Screen page={page} title="Credentials" current={CREDENTIALS}>
          <p>
            Agility access tokens, encrypted at rest. Only the last characters are shown: nobody, including
            owners, can read a token back.
          </p>
          <div class="actions page-actions">
            <LinkButton href={withQuery(`${CREDENTIALS}/new`, {})}>Add a credential</LinkButton>
          </div>
          <QueryForm action={CREDENTIALS} label="Filter credentials">
            <SelectField
              name="instance"
              label="Instance"
              value={instanceId ?? ''}
              options={[
                { value: '', label: 'All instances' },
                ...l.instanceList.map((i) => ({ value: i.id, label: i.label })),
              ]}
            />
            <Button variant="secondary">Filter</Button>
          </QueryForm>
          <DataTable
            caption="Credentials"
            empty="No credentials yet."
            rows={list.rows}
            columns={[
              { header: 'Name', cell: (k) => <a href={adminPath`/admin/credentials/${k.id}`}>{k.label}</a> },
              { header: 'Instance', cell: (k) => l.instances.get(k.instanceId)?.label ?? 'unknown' },
              { header: 'Whose', cell: (k) => ownerText(k, l) },
              { header: 'Token', cell: (k) => <code>{hintText(k.tokenHint)}</code> },
              { header: 'Status', cell: (k) => <StatusBadge {...statusOf(k)} /> },
              { header: 'Checked', cell: (k) => <When at={k.validatedAt} none="never" /> },
            ]}
          />
          <Pager label="Credential pages" prev={list.prev} next={list.next} />
        </Screen>,
      );
    }),
  );

  ui.get(
    `${ROUTE}/new`,
    kit.page('admin', async (c, page) => {
      const l = await lookups(c, page.principal);
      const picked = c.req.query('instance');
      return page.html(
        <NewCredential
          viewer={page.principal}
          instances={l.instanceList}
          values={{ instanceId: isId(picked) ? picked : '', scope: 'shared', label: '' }}
          errors={{}}
        />,
      );
    }),
  );

  ui.post(
    ROUTE,
    kit.form('admin', async (c, principal, form) => {
      const instanceId = field(form, 'instanceId');
      const scope = form.fields.get('scope') ?? 'shared';
      const label = field(form, 'label');
      const token = field(form, 'token');
      const values = {
        instanceId: instanceId ?? '',
        scope: scope === 'mine' ? 'mine' : 'shared',
        label: form.fields.get('label') ?? '',
      };
      const errors: Record<string, string> = {};
      if (!isId(instanceId)) errors['instanceId'] = 'Choose an instance.';
      if (scope !== 'shared' && scope !== 'mine') errors['scope'] = 'Choose one of the options.';
      if (label === null || label.length > MAX_LABEL)
        errors['label'] = 'Enter a name of up to 200 characters.';
      if (token === null || token.length > MAX_TOKEN) errors['token'] = 'Paste the Agility access token.';
      // Whatever happens next, the token is not in anything we send back.
      const again = async (errs: Record<string, string>, message?: string) => {
        const l = await lookups(c, principal);
        return htmlResponse(
          <NewCredential
            viewer={principal}
            instances={l.instanceList}
            values={values}
            errors={errs}
            message={message}
          />,
          422,
        );
      };
      if (Object.keys(errors).length > 0) return again(errors);
      const res = await kit.callAdmin(
        c,
        principal,
        {
          method: 'POST',
          path: '/credentials',
          body: { instanceId, ownerUserId: scope === 'mine' ? principal.userId : null, label, token },
        },
        form,
      );
      if (!isOk(res)) {
        const problem = problemOf(res);
        if (problem.status === 422) {
          const key = ['label', 'token', 'instanceId'].includes(problem.field ?? '')
            ? problem.field
            : undefined;
          return again(
            key === undefined ? {} : { [key]: formMessage(problem) },
            key === undefined ? formMessage(problem) : undefined,
          );
        }
        return again({}, formMessage(problem));
      }
      const created = one(res.body, parseCredential);
      return kit.redirect(
        created === null ? CREDENTIALS : adminPath`/admin/credentials/${created.id}`,
        'created',
      );
    }),
  );

  ui.get(
    `${ROUTE}/:id`,
    kit.page('admin', async (c, page) => {
      const { principal } = page;
      const id = c.req.param('id');
      if (!isId(id)) return errorPage(404, undefined, principal);
      const k = await loadCredential(c, principal, id);
      if ('status' in k) return loadFailed(c, k, principal);
      const l = await lookups(c, principal);
      const self = adminPath`/admin/credentials/${id}`;
      const status = statusOf(k);
      return page.html(
        <Screen page={page} title={k.label} current={CREDENTIALS}>
          <section class="card" aria-labelledby="facts-heading">
            <h2 id="facts-heading">Credential</h2>
            <Facts
              items={[
                [
                  'Instance',
                  <a href={adminPath`/admin/instances/${k.instanceId}`}>
                    {l.instances.get(k.instanceId)?.label ?? 'unknown'}
                  </a>,
                ],
                ['Whose', ownerText(k, l)],
                ['Token', <code>{hintText(k.tokenHint)}</code>],
                ['Status', <StatusBadge {...status} />],
                ['Last check', <When at={k.validatedAt} none="never" />],
                [
                  'Check result',
                  k.validationErrorCode === null ? (
                    'no problem recorded'
                  ) : (
                    <code>{k.validationErrorCode}</code>
                  ),
                ],
                [
                  'Agility member',
                  k.memberName === null
                    ? 'not known yet'
                    : `${k.memberName}${k.memberUsername === null ? '' : ` (${k.memberUsername})`}`,
                ],
                [
                  'Reachable projects',
                  k.reachableScopeIds === null
                    ? 'not known yet'
                    : k.reachableScopeIds.length === 0
                      ? 'none'
                      : k.reachableScopeIds.join(', '),
                ],
                ['Added', <When at={k.createdAt} />],
                ['Revoked', <When at={k.revokedAt} none="no" />],
              ]}
            />
          </section>
          {k.revokedAt === null ? (
            <>
              <section class="card" aria-labelledby="check-heading">
                <h2 id="check-heading">Check against Agility</h2>
                <p>Asks Agility who the token belongs to and which projects it can read.</p>
                <Form action={`${self}/validate`} csrf={principal.csrf} label="Check the credential">
                  <Button variant="secondary">Check now</Button>
                </Form>
              </section>
              <section class="card" aria-labelledby="name-heading">
                <h2 id="name-heading">Name</h2>
                <Form action={self} csrf={principal.csrf} label="Rename">
                  <TextField name="label" label="Name" value={k.label} required maxlength={MAX_LABEL} />
                  <Button>Save</Button>
                </Form>
              </section>
              <section class="card" aria-labelledby="token-heading">
                <h2 id="token-heading">Token</h2>
                {canReplace(k, principal) ? (
                  <>
                    <p>Replacing the token needs a recent sign-in. The old token is gone at once.</p>
                    <LinkButton href={`${self}/token`} variant="secondary">
                      Replace the token…
                    </LinkButton>
                  </>
                ) : (
                  <p class="muted">
                    Only the person this personal credential belongs to can replace its token.
                  </p>
                )}
              </section>
            </>
          ) : null}
          <section class="card" aria-labelledby="end-heading">
            <h2 id="end-heading">Revoke or delete</h2>
            <div class="actions">
              {k.revokedAt === null ? (
                <RowAction
                  action={`${self}/revoke`}
                  csrf={principal.csrf}
                  label="Revoke…"
                  name={`Revoke ${k.label}`}
                />
              ) : null}
              <RowAction
                action={`${self}/delete`}
                csrf={principal.csrf}
                label="Delete…"
                name={`Delete ${k.label}`}
              />
            </div>
            <p class="hint">Revoking is final. Deleting only works for a credential no grant uses.</p>
          </section>
        </Screen>,
      );
    }),
  );

  ui.post(
    `${ROUTE}/:id`,
    kit.form('admin', async (c, principal, form) => {
      const id = c.req.param('id');
      if (!isId(id)) return kit.redirect(CREDENTIALS, 'not_found');
      const self = adminPath`/admin/credentials/${id}`;
      const label = field(form, 'label');
      if (label === null || label.length > MAX_LABEL) return kit.redirect(self, 'invalid');
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'PATCH', path: adminPath`/credentials/${id}`, body: { label } },
        form,
      );
      return isOk(res) ? kit.redirect(self, 'saved') : kit.fail(c, principal, res, self);
    }),
  );

  ui.post(
    `${ROUTE}/:id/validate`,
    kit.form('admin', async (c, principal, form) => {
      const id = c.req.param('id');
      if (!isId(id)) return kit.redirect(CREDENTIALS, 'not_found');
      const self = adminPath`/admin/credentials/${id}`;
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'POST', path: adminPath`/credentials/${id}/validate` },
        form,
      );
      return isOk(res) ? kit.redirect(self, 'validated') : kit.fail(c, principal, res, self);
    }),
  );

  for (const action of ['revoke', 'delete'] as const) {
    ui.post(
      `${ROUTE}/:id/${action}`,
      kit.form('admin', async (c, principal, form) => {
        const id = c.req.param('id');
        if (!isId(id)) return kit.redirect(CREDENTIALS, 'not_found');
        const self = adminPath`/admin/credentials/${id}`;
        if (!confirmed(form)) {
          const k = await loadCredential(c, principal, id);
          if ('status' in k) return kit.fail(c, principal, k, CREDENTIALS);
          return confirmPage({
            viewer: principal,
            current: CREDENTIALS,
            title: `${action === 'revoke' ? 'Revoke' : 'Delete'} ${k.label}?`,
            paragraphs:
              action === 'revoke'
                ? [
                    'Grants that use this credential stop working at once. A revoked credential cannot be restored.',
                    'The stored token stays encrypted until the credential is deleted.',
                  ]
                : [
                    'The encrypted token is removed. This only works when no grant uses the credential.',
                    'Deleting cannot be undone.',
                  ],
            action: `${self}/${action}`,
            confirm: action === 'revoke' ? 'Revoke the credential' : 'Delete the credential',
            cancel: self,
          });
        }
        const res =
          action === 'revoke'
            ? await kit.callAdmin(
                c,
                principal,
                { method: 'POST', path: adminPath`/credentials/${id}/revoke` },
                form,
              )
            : await kit.callAdmin(
                c,
                principal,
                { method: 'DELETE', path: adminPath`/credentials/${id}` },
                form,
              );
        if (!isOk(res)) return kit.fail(c, principal, res, self);
        return kit.redirect(
          action === 'revoke' ? self : CREDENTIALS,
          action === 'revoke' ? 'revoked' : 'deleted',
        );
      }),
    );
  }

  ui.get(
    `${ROUTE}/:id/token`,
    kit.page('admin', async (c, page) => {
      const id = c.req.param('id');
      if (!isId(id)) return errorPage(404, undefined, page.principal);
      const k = await loadCredential(c, page.principal, id);
      if ('status' in k) return loadFailed(c, k, page.principal);
      if (!canReplace(k, page.principal)) return errorPage(404, undefined, page.principal);
      return page.html(<ReplaceToken viewer={page.principal} credential={k} errors={{}} />);
    }),
  );

  ui.post(
    `${ROUTE}/:id/token`,
    kit.form('admin', async (c, principal, form) => {
      const id = c.req.param('id');
      if (!isId(id)) return kit.redirect(CREDENTIALS, 'not_found');
      const self = adminPath`/admin/credentials/${id}`;
      const k = await loadCredential(c, principal, id);
      if ('status' in k) return kit.fail(c, principal, k, CREDENTIALS);
      const token = field(form, 'token');
      const again = (errors: Record<string, string>, message?: string) =>
        htmlResponse(
          <ReplaceToken viewer={principal} credential={k} errors={errors} message={message} />,
          422,
        );
      if (token === null || token.length > MAX_TOKEN)
        return again({ token: 'Paste the new Agility access token.' });
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'POST', path: adminPath`/credentials/${id}/token`, body: { token } },
        form,
      );
      if (isOk(res)) return kit.redirect(self, 'saved');
      const problem = problemOf(res);
      if (problem.status === 422) return again({ token: formMessage(problem) });
      return kit.fail(c, principal, res, `${self}/token`);
    }),
  );
}
