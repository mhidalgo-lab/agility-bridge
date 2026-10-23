// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// "My access" (P4-07, THREAT_MODEL A5, A6, T3): a signed-in person, whatever their role, manages their own personal Agility
// token, sees which of their grants use it and connects devices, without an administrator handling the secret. Every call
// goes to the admin API as the signed-in person: the guards there, not these pages, decide what is theirs (a record of
// someone else answers 404). The token is typed once into a password field and never comes back: not in a page, a
// validation error, a flash, a redirect or a log. Grants are still assigned by administrators; this area only chooses which
// of my own valid tokens a grant of mine uses.
//
//   GET  /admin/me                              my grants, my tokens, my recent changes, how to create a token
//   GET  /admin/me/credentials/new              add form       POST /admin/me/credentials          add (checked at once)
//   GET  /admin/me/credentials/:id              detail         POST .../validate | rename (POST /:id) | revoke | delete
//   GET  /admin/me/credentials/:id/token        replace form   POST .../token                       replace (recent sign-in)
//   GET  /admin/me/grants/:id                   my grant: credential choice, device tokens
//   POST /admin/me/grants/:id/credential        use one of my tokens, or the workspace default
//   .../me/grants/:id/tokens...                 device tokens (tokens.tsx, member area)
import type { Context, Hono } from 'hono';
import {
  Button,
  DataTable,
  Facts,
  Form,
  Layout,
  LinkButton,
  SelectField,
  TextField,
} from '../components.tsx';
import { adminPath, type UiKit, type UiPrincipal } from '../kit.ts';
import { errorPage, htmlResponse } from '../pages.tsx';
import {
  type Credential,
  type Instance,
  isId,
  type MyGrant,
  one,
  parseCredential,
  parseInstance,
  parseMyAudit,
  parseMyGrant,
  parseToken,
  rows,
} from './data.ts';
import {
  confirmed,
  confirmPage,
  FormError,
  field,
  formMessage,
  isOk,
  lifecycle,
  load,
  loadFailed,
  problemOf,
  RowAction,
  StatusBadge,
  When,
} from './shared.tsx';
import { canIssueOn, MEMBER_AREA, TokenTable } from './tokens.tsx';

export const ME = '/admin/me';
const MAX_LABEL = 200;
const MAX_TOKEN = 4_000;
/** Matches `MAX_PERSONAL_CREDENTIALS` in `@agility-bridge/auth` (the API enforces it; the page only says it). */
const MAX_CREDENTIALS = 10;
const hintText = (hint: string): string => (hint === '' ? 'none' : `…${hint}`);

const statusOf = (k: Credential): { tone: 'ok' | 'error' | 'muted'; text: string } => {
  if (k.revokedAt !== null) return { tone: 'error', text: 'revoked' };
  if (k.validationStatus === 'valid') return { tone: 'ok', text: 'valid' };
  if (k.validationStatus === 'invalid') return { tone: 'error', text: 'invalid' };
  return { tone: 'muted', text: 'not checked yet' };
};

const credentialPage = (id: string): string => adminPath`/admin/me/credentials/${id}`;
const grantPage = (id: string): string => adminPath`/admin/me/grants/${id}`;

/** How to get an Agility access token: the same words on the add form and on the overview. */
function TokenGuide() {
  return (
    <section class="card" aria-labelledby="guide-heading">
      <h2 id="guide-heading">Create an Agility access token</h2>
      <ol>
        <li>Open Agility in your browser and sign in as yourself.</li>
        <li>
          Open your profile menu, then <strong>Applications</strong>.
        </li>
        <li>
          Choose <strong>Add Application</strong>, give it a name you will recognise (for example
          agility-bridge) and create the access token.
        </li>
        <li>Copy the token at once: Agility shows it once. Paste it here.</li>
      </ol>
      <p class="hint">
        A personal token acts as you in Agility, with your permissions, and never expires until you revoke it
        in Agility. Paste it only here, never into a chat or a ticket. This server stores it encrypted and
        shows only its last characters.
      </p>
    </section>
  );
}

function NewCredentialPage(props: {
  readonly viewer: UiPrincipal;
  readonly instances: readonly Instance[];
  readonly values: { instanceId: string; label: string };
  readonly errors: Readonly<Record<string, string>>;
  readonly message?: string | undefined;
}) {
  const { viewer, values, errors } = props;
  return (
    <Layout title="Add my Agility token" viewer={viewer} current={ME}>
      <TokenGuide />
      <FormError message={props.message} />
      {props.instances.length === 0 ? (
        <p>
          You have no grant on a workspace yet, so there is nothing to add a token for. Ask an administrator
          to give you access.
        </p>
      ) : (
        <Form action={`${ME}/credentials`} csrf={viewer.csrf} label="Add my Agility token">
          <SelectField
            name="instanceId"
            label="Agility instance"
            hint="Only instances you have a grant on."
            value={values.instanceId}
            required
            error={errors['instanceId']}
            options={[
              { value: '', label: 'Choose an instance' },
              ...props.instances.map((i) => ({ value: i.id, label: i.label })),
            ]}
          />
          <TextField
            name="label"
            label="Name"
            hint="For example My Agility token."
            value={values.label}
            required
            maxlength={MAX_LABEL}
            error={errors['label']}
          />
          <TextField
            name="token"
            label="Agility access token"
            hint="Paste it here; it is checked against Agility at once, then not shown again, not even if this form has an error."
            type="password"
            required
            maxlength={MAX_TOKEN}
            error={errors['token']}
          />
          <div class="actions">
            <Button>Add and check</Button>
            <LinkButton href={ME} variant="secondary">
              Cancel
            </LinkButton>
          </div>
        </Form>
      )}
    </Layout>
  );
}

function ReplaceTokenPage(props: {
  readonly viewer: UiPrincipal;
  readonly credential: Credential;
  readonly errors: Readonly<Record<string, string>>;
  readonly message?: string | undefined;
}) {
  const { viewer, credential: k } = props;
  const self = credentialPage(k.id);
  return (
    <Layout title="Replace my token" viewer={viewer} current={ME}>
      <p>
        For <strong>{k.label}</strong> (now {hintText(k.tokenHint)}). The new token is checked against Agility
        before anything uses it; until then grants that use it stop working. This needs a recent sign-in.
      </p>
      <FormError message={props.message} />
      <Form action={`${self}/token`} csrf={viewer.csrf} label="Replace my token">
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

export function registerMe(ui: Hono, kit: UiKit): void {
  const now = () => (kit.deps.now ?? Date.now)();

  const myGrants = async (c: Context, principal: UiPrincipal) => {
    const got = await load(kit, c, principal, '/me/grants', (b) => rows(b, parseMyGrant));
    return got.ok ? got.value : got.result;
  };
  const myCredentials = async (c: Context, principal: UiPrincipal) => {
    const got = await load(kit, c, principal, '/credentials', (b) => rows(b, parseCredential));
    return got.ok ? got.value : got.result;
  };
  const instanceMap = async (c: Context, principal: UiPrincipal): Promise<ReadonlyMap<string, Instance>> => {
    const got = await load(kit, c, principal, '/instances', (b) => rows(b, parseInstance));
    return new Map((got.ok ? got.value : []).map((i) => [i.id, i]));
  };
  /**
   * One of my credentials. This area is "mine only", also for owners and admins who could read any credential through the
   * API: a credential of someone else, or a shared one, is a 404 here (the admin screens are for those).
   */
  const loadCredential = async (c: Context, principal: UiPrincipal, id: string) => {
    const got = await load(kit, c, principal, adminPath`/credentials/${id}`, (b) => one(b, parseCredential));
    if (!got.ok) return got.result;
    if (got.value.ownerUserId !== principal.userId)
      return { status: 404, body: { error: { code: 'not_found', message: 'Not found.' } } };
    return got.value;
  };
  /** Instances I could add a token for: those of my grants in workspaces that use stored tokens. */
  const addable = (grants: readonly MyGrant[], instances: ReadonlyMap<string, Instance>): Instance[] => {
    const ids = new Set(
      grants
        .filter(
          (g) =>
            g.grant.revokedAt === null &&
            g.workspace !== null &&
            g.workspace.credentialSource === 'stored' &&
            g.workspace.disabledAt === null,
        )
        .map((g) => g.workspace?.instanceId ?? ''),
    );
    return [...ids].flatMap((id) => {
      const i = instances.get(id);
      return i !== undefined && i.disabledAt === null ? [i] : [];
    });
  };

  // ---- the overview --------------------------------------------------------------------------------------------------

  ui.get(
    '/me',
    kit.page('member', async (c, page) => {
      const { principal } = page;
      const [grants, credentials, instances, audit] = await Promise.all([
        myGrants(c, principal),
        myCredentials(c, principal),
        instanceMap(c, principal),
        load(kit, c, principal, '/me/audit', (b) => rows(b, parseMyAudit), { limit: '10' }),
      ]);
      if ('status' in grants) return loadFailed(c, grants, principal);
      if ('status' in credentials) return loadFailed(c, credentials, principal);
      const byId = new Map(credentials.map((k) => [k.id, k]));
      const t = now();
      return page.html(
        <Layout title="My access" viewer={principal} current={ME} flash={page.flash}>
          <p>
            Your own access to Agility through this server: the workspaces you were given, the personal
            Agility token you keep here, and the devices you connect. Administrators decide which workspaces
            you can use; you choose which of your tokens a grant uses.
          </p>
          <section aria-labelledby="grants-heading">
            <h2 id="grants-heading">My grants</h2>
            <DataTable
              caption="My grants"
              empty="You have no grants yet. Ask an administrator for access."
              rows={grants.slice(0, 100)}
              columns={[
                {
                  header: 'Workspace',
                  cell: (g) => <a href={grantPage(g.grant.id)}>{g.workspace?.name ?? 'unknown workspace'}</a>,
                },
                {
                  header: 'Agility token',
                  cell: (g) => {
                    if (g.workspace?.credentialSource === 'passthrough') return 'the token you send';
                    const k = g.grant.credentialId === null ? undefined : byId.get(g.grant.credentialId);
                    if (k !== undefined) return k.label;
                    return g.grant.credentialId === null
                      ? 'workspace default (shared)'
                      : 'set by an administrator';
                  },
                },
                { header: 'Status', cell: (g) => <StatusBadge {...lifecycle(g.grant, t)} /> },
                { header: 'Expires', cell: (g) => <When at={g.grant.expiresAt} none="never" /> },
              ]}
            />
          </section>
          <section aria-labelledby="tokens-heading">
            <h2 id="tokens-heading">My Agility tokens</h2>
            <div class="actions page-actions">
              {credentials.length >= MAX_CREDENTIALS ? (
                <p class="hint">
                  You keep the most tokens allowed ({MAX_CREDENTIALS}). Delete one you no longer use to add
                  another.
                </p>
              ) : (
                <LinkButton href={`${ME}/credentials/new`}>Add my Agility token</LinkButton>
              )}
            </div>
            <DataTable
              caption="My Agility tokens"
              empty="You have not added a personal Agility token."
              rows={credentials}
              columns={[
                { header: 'Name', cell: (k) => <a href={credentialPage(k.id)}>{k.label}</a> },
                { header: 'Instance', cell: (k) => instances.get(k.instanceId)?.label ?? 'unknown' },
                { header: 'Token', cell: (k) => <code>{hintText(k.tokenHint)}</code> },
                { header: 'Status', cell: (k) => <StatusBadge {...statusOf(k)} /> },
                { header: 'Checked', cell: (k) => <When at={k.validatedAt} none="never" /> },
              ]}
            />
          </section>
          {audit.ok && audit.value.length > 0 ? (
            <section aria-labelledby="audit-heading">
              <h2 id="audit-heading">My recent changes</h2>
              <DataTable
                caption="My recent changes"
                empty="Nothing yet."
                rows={audit.value}
                columns={[
                  { header: 'When', cell: (r) => <When at={r.ts} /> },
                  { header: 'What', cell: (r) => <code>{r.action}</code> },
                  { header: 'Result', cell: (r) => r.status },
                ]}
              />
            </section>
          ) : null}
          <TokenGuide />
        </Layout>,
      );
    }),
  );

  // ---- my tokens ---------------------------------------------------------------------------------------------------

  ui.get(
    '/me/credentials/new',
    kit.page('member', async (c, page) => {
      const { principal } = page;
      const [grants, instances] = await Promise.all([myGrants(c, principal), instanceMap(c, principal)]);
      if ('status' in grants) return loadFailed(c, grants, principal);
      const picked = c.req.query('instance');
      return page.html(
        <NewCredentialPage
          viewer={principal}
          instances={addable(grants, instances)}
          values={{ instanceId: isId(picked) ? picked : '', label: '' }}
          errors={{}}
        />,
      );
    }),
  );

  ui.post(
    '/me/credentials',
    kit.form('member', async (c, principal, form) => {
      const instanceId = field(form, 'instanceId');
      const label = field(form, 'label');
      const token = field(form, 'token');
      const values = { instanceId: instanceId ?? '', label: form.fields.get('label') ?? '' };
      const errors: Record<string, string> = {};
      if (!isId(instanceId)) errors['instanceId'] = 'Choose an instance.';
      if (label === null || label.length > MAX_LABEL)
        errors['label'] = 'Enter a name of up to 200 characters.';
      if (token === null || token.length > MAX_TOKEN) errors['token'] = 'Paste the Agility access token.';
      // Whatever happens next, the token is not in anything we send back.
      const again = async (errs: Record<string, string>, message?: string, status = 422) => {
        const [grants, instances] = await Promise.all([myGrants(c, principal), instanceMap(c, principal)]);
        return htmlResponse(
          <NewCredentialPage
            viewer={principal}
            instances={'status' in grants ? [] : addable(grants, instances)}
            values={values}
            errors={errs}
            message={message}
          />,
          status,
        );
      };
      if (Object.keys(errors).length > 0) return again(errors);
      // The owner is always the signed-in person: the form has no such field, and the API refuses any other.
      const res = await kit.callAdmin(
        c,
        principal,
        {
          method: 'POST',
          path: '/credentials',
          body: { instanceId, ownerUserId: principal.userId, label, token },
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
        if (problem.status === 409)
          return again(
            {},
            `You keep the most personal tokens allowed (${MAX_CREDENTIALS}). Delete one you no longer use first. Nothing was added.`,
            409,
          );
        if (problem.status === 403)
          return again(
            { instanceId: 'You can add a token only for an instance you have a grant on.' },
            undefined,
            403,
          );
        return again({}, formMessage(problem), problem.status >= 500 ? 503 : 422);
      }
      const created = one(res.body, parseCredential);
      return kit.redirect(created === null ? ME : credentialPage(created.id), 'created');
    }),
  );

  ui.get(
    '/me/credentials/:id',
    kit.page('member', async (c, page) => {
      const { principal } = page;
      const id = c.req.param('id');
      if (!isId(id)) return errorPage(404, undefined, principal);
      const k = await loadCredential(c, principal, id);
      if ('status' in k) return loadFailed(c, k, principal);
      const [grants, instances] = await Promise.all([myGrants(c, principal), instanceMap(c, principal)]);
      const using = 'status' in grants ? [] : grants.filter((g) => g.grant.credentialId === k.id);
      const self = credentialPage(id);
      const status = statusOf(k);
      return page.html(
        <Layout title={k.label} viewer={principal} current={ME} flash={page.flash}>
          <section class="card" aria-labelledby="facts-heading">
            <h2 id="facts-heading">My Agility token</h2>
            <Facts
              items={[
                ['Instance', instances.get(k.instanceId)?.label ?? 'unknown'],
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
                  'Agility account',
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
                [
                  'Used by my grants',
                  using.length === 0 ? (
                    'none'
                  ) : (
                    <>
                      {using.map((g, i) => (
                        <>
                          {i === 0 ? '' : ', '}
                          <a href={grantPage(g.grant.id)}>{g.workspace?.name ?? 'unknown workspace'}</a>
                        </>
                      ))}
                    </>
                  ),
                ],
                ['Added', <When at={k.createdAt} />],
                ['Revoked', <When at={k.revokedAt} none="no" />],
              ]}
            />
            {k.validationStatus === 'invalid' && k.revokedAt === null ? (
              <p class="flash flash-error" role="alert">
                Agility did not accept this token, so nothing uses it. Replace it with a new one.
              </p>
            ) : null}
          </section>
          {k.revokedAt === null ? (
            <>
              <section class="card" aria-labelledby="check-heading">
                <h2 id="check-heading">Check against Agility</h2>
                <p>Asks Agility whose token this is and which projects it can read.</p>
                <Form action={`${self}/validate`} csrf={principal.csrf} label="Check my token">
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
                <p>
                  Replacing the token needs a recent sign-in. The old token is gone at once and the new one is
                  checked before anything uses it.
                </p>
                <LinkButton href={`${self}/token`} variant="secondary">
                  Replace the token…
                </LinkButton>
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
              {using.length === 0 ? (
                <RowAction
                  action={`${self}/delete`}
                  csrf={principal.csrf}
                  label="Delete…"
                  name={`Delete ${k.label}`}
                />
              ) : null}
            </div>
            <p class="hint">
              {using.length === 0
                ? 'Revoking is final. Deleting removes the encrypted token from this server for good.'
                : 'A grant still uses this token: move it to another token or the workspace default (open the grant) before deleting. Revoking is final.'}
            </p>
          </section>
          <p>
            <a href={ME}>Back to my access</a>
          </p>
        </Layout>,
      );
    }),
  );

  ui.post(
    '/me/credentials/:id',
    kit.form('member', async (c, principal, form) => {
      const id = c.req.param('id');
      if (!isId(id)) return kit.redirect(ME, 'not_found');
      const self = credentialPage(id);
      const label = field(form, 'label');
      if (label === null || label.length > MAX_LABEL) return kit.redirect(self, 'invalid');
      const k = await loadCredential(c, principal, id);
      if ('status' in k) return kit.fail(c, principal, k, ME);
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
    '/me/credentials/:id/validate',
    kit.form('member', async (c, principal, form) => {
      const id = c.req.param('id');
      if (!isId(id)) return kit.redirect(ME, 'not_found');
      const self = credentialPage(id);
      const k = await loadCredential(c, principal, id);
      if ('status' in k) return kit.fail(c, principal, k, ME);
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
      `/me/credentials/:id/${action}`,
      kit.form('member', async (c, principal, form) => {
        const id = c.req.param('id');
        if (!isId(id)) return kit.redirect(ME, 'not_found');
        const self = credentialPage(id);
        const k = await loadCredential(c, principal, id);
        if ('status' in k) return kit.fail(c, principal, k, ME);
        if (!confirmed(form)) {
          return confirmPage({
            viewer: principal,
            current: ME,
            title: `${action === 'revoke' ? 'Revoke' : 'Delete'} ${k.label}?`,
            paragraphs:
              action === 'revoke'
                ? [
                    'Grants of yours that use this token stop working at once. A revoked token cannot be restored.',
                    'Revoke it in Agility as well (Applications page) if it may have leaked.',
                  ]
                : [
                    'The encrypted token is removed from this server. This only works when none of your grants uses it.',
                    'Deleting cannot be undone.',
                  ],
            action: `${self}/${action}`,
            confirm: action === 'revoke' ? 'Revoke the token' : 'Delete the token',
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
        return kit.redirect(action === 'revoke' ? self : ME, action === 'revoke' ? 'revoked' : 'deleted');
      }),
    );
  }

  ui.get(
    '/me/credentials/:id/token',
    kit.page('member', async (c, page) => {
      const id = c.req.param('id');
      if (!isId(id)) return errorPage(404, undefined, page.principal);
      const k = await loadCredential(c, page.principal, id);
      if ('status' in k) return loadFailed(c, k, page.principal);
      if (k.revokedAt !== null) return errorPage(404, undefined, page.principal);
      return page.html(<ReplaceTokenPage viewer={page.principal} credential={k} errors={{}} />);
    }),
  );

  ui.post(
    '/me/credentials/:id/token',
    kit.form('member', async (c, principal, form) => {
      const id = c.req.param('id');
      if (!isId(id)) return kit.redirect(ME, 'not_found');
      const self = credentialPage(id);
      const k = await loadCredential(c, principal, id);
      if ('status' in k) return kit.fail(c, principal, k, ME);
      const token = field(form, 'token');
      const again = (errors: Record<string, string>, message?: string) =>
        htmlResponse(
          <ReplaceTokenPage viewer={principal} credential={k} errors={errors} message={message} />,
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

  // ---- my grants -----------------------------------------------------------------------------------------------------

  const loadMine = async (c: Context, principal: UiPrincipal, id: string): Promise<MyGrant | Response> => {
    const grants = await myGrants(c, principal);
    if ('status' in grants) return loadFailed(c, grants, principal);
    // Only my own grants are in the list: another person's id is the same 404 as a missing one.
    return grants.find((g) => g.grant.id === id) ?? errorPage(404, undefined, principal);
  };

  ui.get(
    '/me/grants/:id',
    kit.page('member', async (c, page) => {
      const { principal } = page;
      const id = c.req.param('id');
      if (!isId(id)) return errorPage(404, undefined, principal);
      const mine = await loadMine(c, principal, id);
      if (mine instanceof Response) return mine;
      const { grant, workspace } = mine;
      const credentials = await myCredentials(c, principal);
      if ('status' in credentials) return loadFailed(c, credentials, principal);
      const t = now();
      const current =
        grant.credentialId === null ? undefined : credentials.find((k) => k.id === grant.credentialId);
      const usable = credentials.filter(
        (k) =>
          k.revokedAt === null && k.validationStatus === 'valid' && k.instanceId === workspace?.instanceId,
      );
      const live = grant.revokedAt === null && (grant.expiresAt === null || grant.expiresAt > t);
      const canChoose =
        live &&
        workspace !== null &&
        workspace.credentialSource === 'stored' &&
        workspace.disabledAt === null;
      const tokens = await load(kit, c, principal, adminPath`/grants/${id}/tokens`, (b) =>
        rows(b, parseToken),
      );
      return page.html(
        <Layout title={workspace?.name ?? 'My grant'} viewer={principal} current={ME} flash={page.flash}>
          <section class="card" aria-labelledby="facts-heading">
            <h2 id="facts-heading">My grant</h2>
            <Facts
              items={[
                ['Workspace', workspace?.name ?? 'unknown workspace'],
                ['Status', <StatusBadge {...lifecycle(grant, t)} />],
                ['Expires', <When at={grant.expiresAt} none="never" />],
                [
                  'Agility token',
                  workspace?.credentialSource === 'passthrough'
                    ? 'the token you send with each request'
                    : current !== undefined
                      ? `${current.label} (${hintText(current.tokenHint)})`
                      : grant.credentialId === null
                        ? 'the workspace default (shared, read-only)'
                        : 'set by an administrator',
                ],
              ]}
            />
          </section>
          {canChoose ? (
            <section class="card" aria-labelledby="choose-heading">
              <h2 id="choose-heading">Which Agility token to use</h2>
              <p>
                With your own token, Agility answers as you, with your permissions. The workspace still limits
                the projects and tools, and your device tokens on this grant are revoked when you switch to a
                personal token, so none keeps acting through a different token.
              </p>
              <Form
                action={`${grantPage(id)}/credential`}
                csrf={principal.csrf}
                label="Choose the Agility token"
              >
                <SelectField
                  name="credentialId"
                  label="Agility token"
                  value={grant.credentialId ?? ''}
                  options={[
                    ...(current !== undefined || grant.credentialId === null
                      ? [{ value: '', label: 'The workspace default (shared)' }]
                      : []),
                    ...usable.map((k) => ({ value: k.id, label: `${k.label} (${hintText(k.tokenHint)})` })),
                  ]}
                />
                <Button>Use this token</Button>
              </Form>
              {usable.length === 0 ? (
                <p class="hint">
                  You have no valid token for this instance yet. <a href={`${ME}/credentials/new`}>Add one</a>
                  ; it shows here once Agility accepts it.
                </p>
              ) : null}
            </section>
          ) : null}
          <section aria-labelledby="devices-heading">
            <h2 id="devices-heading">My devices</h2>
            {tokens.ok ? (
              <TokenTable viewer={principal} grantId={id} tokens={tokens.value} now={t} area={MEMBER_AREA} />
            ) : (
              <p class="flash flash-error" role="alert">
                The device tokens could not be loaded.
              </p>
            )}
            {canIssueOn(grant, current, principal, t) ? (
              <div class="actions">
                <LinkButton href={`${grantPage(id)}/tokens/new`}>New device token</LinkButton>
              </div>
            ) : (
              <p class="hint">This grant cannot get new device tokens: it is revoked or expired.</p>
            )}
          </section>
          <p>
            <a href={ME}>Back to my access</a>
          </p>
        </Layout>,
      );
    }),
  );

  ui.post(
    '/me/grants/:id/credential',
    kit.form('member', async (c, principal, form) => {
      const id = c.req.param('id');
      if (!isId(id)) return kit.redirect(ME, 'not_found');
      const self = grantPage(id);
      const chosen = form.fields.get('credentialId') ?? '';
      if (chosen !== '' && !isId(chosen)) return kit.redirect(self, 'invalid');
      const res = await kit.callAdmin(
        c,
        principal,
        {
          method: 'POST',
          path: adminPath`/me/grants/${id}/credential`,
          body: { credentialId: chosen === '' ? null : chosen },
        },
        form,
      );
      return isOk(res) ? kit.redirect(self, 'saved') : kit.fail(c, principal, res, self);
    }),
  );
}
