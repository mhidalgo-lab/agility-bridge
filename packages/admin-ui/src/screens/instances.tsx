// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// Agility instances (P4-04, THREAT_MODEL A14): list, add, rename, disable, delete and, for owners with a recent sign-in,
// change the origin or TLS trust. Everything goes through the admin API as the signed-in person.
//
//   GET  /admin/instances                list (owner, admin)
//   GET  /admin/instances/new            add form          POST /admin/instances             add
//   GET  /admin/instances/:id            detail: facts, credentials, workspaces, the forms below
//   POST /admin/instances/:id            rename            POST .../disable | enable | delete (confirmation page first)
//   GET  /admin/instances/:id/origin     origin and TLS form (owners)     POST .../origin     retarget (owner, recent sign-in)
//   GET  /admin/instances/:id/prefixes   number prefixes, one `Type=PREFIX` per line       POST .../prefixes   change (P4-15)
import type { Context, Hono } from 'hono';
import {
  Button,
  Checkbox,
  DataTable,
  Facts,
  Form,
  Layout,
  LinkButton,
  Pager,
  TextAreaField,
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
  parseWorkspace,
  rows,
  type Workspace,
} from './data.ts';
import {
  confirmed,
  confirmPage,
  enabledState,
  FormError,
  field,
  formMessage,
  isOk,
  isOwner,
  load,
  loadFailed,
  Notes,
  paged,
  problemOf,
  RowAction,
  Screen,
  StatusBadge,
  When,
} from './shared.tsx';

export const INSTANCES = '/admin/instances';
const ROUTE = '/instances';

const MAX_LABEL = 200;
const MAX_URL = 2_048;
const MAX_PATH = 1_024;
const MAX_PREFIX_LINES = 64;
const MAX_PREFIX_TEXT = 4_000;

/** The prefixes as the form shows them: one `Type=PREFIX` per line, in type order. */
export const prefixText = (prefixes: Readonly<Record<string, string>>): string =>
  Object.entries(prefixes)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([type, prefix]) => `${type}=${prefix}`)
    .join('\n');

/**
 * Reads the form's text: `Type=PREFIX` per line, blank lines skipped. Only the shape is checked here (one `=`, both sides
 * present, no type twice, at most 64 lines); which names and prefixes are allowed is the admin API's rule (it answers 422).
 */
export function parsePrefixText(
  text: string,
):
  | { readonly ok: true; readonly prefixes: Record<string, string> }
  | { readonly ok: false; readonly error: string } {
  const prefixes: Record<string, string> = {};
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  let count = 0;
  for (const line of lines) {
    if (line === '') continue;
    if (++count > MAX_PREFIX_LINES) return { ok: false, error: 'At most 64 lines.' };
    const at = line.indexOf('=');
    const type = at < 0 ? '' : line.slice(0, at).trim();
    const prefix = at < 0 ? '' : line.slice(at + 1).trim();
    if (type === '' || prefix === '' || prefix.includes('='))
      return { ok: false, error: 'Write each line as Type=PREFIX, for example Story=S.' };
    if (Object.hasOwn(prefixes, type) || type === '__proto__')
      return { ok: false, error: 'Each asset type can appear once.' };
    prefixes[type] = prefix;
  }
  return { ok: true, prefixes };
}

const samePrefixes = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean =>
  prefixText(a) === prefixText(b);

function PrefixesPage(props: {
  readonly viewer: UiPrincipal;
  readonly instance: Instance;
  readonly text: string;
  readonly error?: string | undefined;
}) {
  const { viewer, instance } = props;
  const self = adminPath`/admin/instances/${instance.id}`;
  return (
    <Layout title={`Number prefixes of ${instance.label}`} viewer={viewer} current={INSTANCES}>
      <p>
        The letters before the dash in an Agility number (the S of S-01054), per asset type. One line per
        type, written Type=PREFIX, for example Story=S. Leave the box empty to have them learned from Agility.
      </p>
      <p class="hint">
        Stored with the instance. They are not applied to number lookups yet: until then every lookup still
        learns the prefixes from Agility.
      </p>
      <Form action={`${self}/prefixes`} csrf={viewer.csrf} label="Number prefixes">
        <TextAreaField
          name="prefixes"
          label="Prefixes"
          hint="Asset type names are letters, digits and underscores; a prefix is one to four capital letters."
          value={props.text}
          rows={8}
          maxlength={MAX_PREFIX_TEXT}
          spellcheck={false}
          autocomplete="off"
          error={props.error}
        />
        <div class="actions">
          <Button>Save</Button>
          <LinkButton href={self} variant="secondary">
            Cancel
          </LinkButton>
        </div>
      </Form>
    </Layout>
  );
}

interface InstanceDraft {
  readonly label: string;
  readonly baseUrl: string;
  readonly caFile: string;
}

const draftOf = (i: Instance | null): InstanceDraft => ({
  label: i?.label ?? '',
  baseUrl: i?.baseUrl ?? '',
  caFile: i?.caFile ?? '',
});
const draftFrom = (form: { fields: URLSearchParams }): InstanceDraft => ({
  label: form.fields.get('label') ?? '',
  baseUrl: form.fields.get('baseUrl') ?? '',
  caFile: form.fields.get('caFile') ?? '',
});

function NewInstance(props: {
  readonly viewer: UiPrincipal;
  readonly draft: InstanceDraft;
  readonly errors: Readonly<Record<string, string>>;
  readonly message?: string | undefined;
}) {
  const { viewer, draft, errors } = props;
  return (
    <Layout title="Add an instance" viewer={viewer} current={INSTANCES}>
      <FormError message={props.message} />
      <Form action={INSTANCES} csrf={viewer.csrf} label="Add an instance">
        <TextField
          name="label"
          label="Name"
          hint="Shown in lists, for example Production."
          value={draft.label}
          required
          maxlength={MAX_LABEL}
          error={errors['label']}
        />
        <TextField
          name="baseUrl"
          label="Agility address"
          hint="The origin of your Agility site, for example https://www15.v1host.com/YourCompany. Checked with a request that carries no token."
          type="url"
          inputmode="url"
          value={draft.baseUrl}
          required
          maxlength={MAX_URL}
          spellcheck={false}
          error={errors['baseUrl']}
        />
        {isOwner(viewer) ? (
          <TextField
            name="caFile"
            label="CA certificate file (optional)"
            hint="Only for a server whose certificate is signed by a private authority: a path on the server."
            value={draft.caFile}
            maxlength={MAX_PATH}
            spellcheck={false}
            error={errors['caFile']}
          />
        ) : null}
        <div class="actions">
          <Button>Add instance</Button>
          <LinkButton href={INSTANCES} variant="secondary">
            Cancel
          </LinkButton>
        </div>
      </Form>
    </Layout>
  );
}

function OriginPage(props: {
  readonly viewer: UiPrincipal;
  readonly instance: Instance;
  readonly live: number;
  readonly draft: InstanceDraft;
  readonly errors: Readonly<Record<string, string>>;
  readonly message?: string | undefined;
}) {
  const { viewer, instance, draft, errors } = props;
  const self = adminPath`/admin/instances/${instance.id}`;
  return (
    <Layout title="Change the origin" viewer={viewer} current={INSTANCES}>
      <p>
        For <strong>{instance.label}</strong>, now <code>{instance.baseUrl}</code>.
      </p>
      <div class="flash flash-info" role="note">
        Stored Agility tokens are sent to this address. Changing it, or the certificate authority it is
        checked against,{' '}
        <strong>
          revokes every credential of this instance ({props.live} in use now) and every grant that used them
        </strong>
        . People then add their tokens again. Only an owner can do this, and it needs a recent sign-in.
      </div>
      <FormError message={props.message} />
      <Form action={`${self}/origin`} csrf={viewer.csrf} label="Change the origin">
        <TextField
          name="baseUrl"
          label="New Agility address"
          type="url"
          inputmode="url"
          value={draft.baseUrl}
          required
          maxlength={MAX_URL}
          spellcheck={false}
          error={errors['baseUrl']}
        />
        <TextField
          name="caFile"
          label="CA certificate file (optional)"
          hint="A path on the server. Leave empty to trust the public authorities only."
          value={draft.caFile}
          maxlength={MAX_PATH}
          spellcheck={false}
          error={errors['caFile']}
        />
        <Checkbox
          name="understood"
          label="I understand that every credential of this instance and every grant that used them will be revoked."
        />
        <div class="actions">
          <Button variant="danger">Change the origin</Button>
          <LinkButton href={self} variant="secondary">
            Cancel
          </LinkButton>
        </div>
      </Form>
    </Layout>
  );
}

export function registerInstances(ui: Hono, kit: UiKit): void {
  const now = () => (kit.deps.now ?? Date.now)();

  const loadInstance = async (c: Context, principal: UiPrincipal, id: string) => {
    const got = await load(kit, c, principal, adminPath`/instances/${id}`, (b) => one(b, parseInstance));
    return got.ok ? got.value : got.result;
  };

  ui.get(
    ROUTE,
    kit.page('admin', async (c, page) => {
      const got = await load(kit, c, page.principal, '/instances', (b) => rows(b, parseInstance));
      if (!got.ok) return loadFailed(c, got.result, page.principal);
      const list = paged(got.value, c.req.query('page'), INSTANCES);
      return page.html(
        <Screen page={page} title="Instances" current={INSTANCES}>
          <p>
            An instance is one Agility site. Workspaces and credentials belong to an instance, and a device
            token can only reach the instance its workspace is on.
          </p>
          <div class="actions page-actions">
            <LinkButton href={`${INSTANCES}/new`}>Add an instance</LinkButton>
          </div>
          <DataTable
            caption="Agility instances"
            empty="No instances yet. Add the Agility site first."
            rows={list.rows}
            columns={[
              {
                header: 'Name',
                cell: (i) => <a href={adminPath`/admin/instances/${i.id}`}>{i.label}</a>,
              },
              { header: 'Address', cell: (i) => <code>{i.baseUrl}</code> },
              { header: 'Status', cell: (i) => <StatusBadge {...enabledState(i.disabledAt)} /> },
              { header: 'Added', cell: (i) => <When at={i.createdAt} /> },
            ]}
          />
          <Pager label="Instance pages" prev={list.prev} next={list.next} />
        </Screen>,
      );
    }),
  );

  ui.get(
    `${ROUTE}/new`,
    kit.page('admin', (_c, page) =>
      page.html(<NewInstance viewer={page.principal} draft={draftOf(null)} errors={{}} />),
    ),
  );

  ui.post(
    ROUTE,
    kit.form('admin', async (c, principal, form) => {
      const draft = draftFrom(form);
      const label = field(form, 'label');
      const baseUrl = field(form, 'baseUrl');
      const caFile = field(form, 'caFile');
      const errors: Record<string, string> = {};
      if (label === null || label.length > MAX_LABEL)
        errors['label'] = 'Enter a name of up to 200 characters.';
      if (baseUrl === null || baseUrl.length > MAX_URL)
        errors['baseUrl'] = 'Enter the address of your Agility site.';
      if (caFile !== null && (!isOwner(principal) || caFile.length > MAX_PATH))
        errors['caFile'] = isOwner(principal) ? 'At most 1024 characters.' : 'Only an owner can set this.';
      const again = (errs: Record<string, string>, message?: string) =>
        htmlResponse(<NewInstance viewer={principal} draft={draft} errors={errs} message={message} />, 422);
      if (Object.keys(errors).length > 0) return again(errors);
      const res = await kit.callAdmin(
        c,
        principal,
        {
          method: 'POST',
          path: '/instances',
          body: { label, baseUrl, ...(caFile === null ? {} : { tls: { caFile } }) },
        },
        form,
      );
      if (!isOk(res)) {
        const problem = problemOf(res);
        if (problem.status === 422) {
          const key = problem.field === 'baseUrl' || problem.field === 'label' ? problem.field : undefined;
          return again(
            key === undefined ? {} : { [key]: formMessage(problem) },
            key === undefined ? formMessage(problem) : undefined,
          );
        }
        if (problem.status === 502)
          return again(
            {},
            'The address did not answer like an Agility site, so nothing was saved. Check it and try again.',
          );
        return kit.fail(c, principal, res, `${INSTANCES}/new`);
      }
      const created = one(res.body, parseInstance);
      return kit.redirect(
        created === null ? INSTANCES : adminPath`/admin/instances/${created.id}`,
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
      const instance = await loadInstance(c, principal, id);
      if ('status' in instance) return loadFailed(c, instance, principal);
      const [creds, workspaces] = await Promise.all([
        load(kit, c, principal, '/credentials', (b) => rows(b, parseCredential), { instanceId: id }),
        load(kit, c, principal, '/workspaces', (b) => rows(b, parseWorkspace)),
      ]);
      const credentials: Credential[] = creds.ok ? creds.value : [];
      const mine: Workspace[] = workspaces.ok ? workspaces.value.filter((w) => w.instanceId === id) : [];
      const live = credentials.filter((k) => k.revokedAt === null);
      const self = adminPath`/admin/instances/${id}`;
      const disabled = instance.disabledAt !== null;
      return page.html(
        <Screen page={page} title={instance.label} current={INSTANCES}>
          <section class="card" aria-labelledby="facts-heading">
            <h2 id="facts-heading">Instance</h2>
            <Facts
              items={[
                ['Address', <code>{instance.baseUrl}</code>],
                [
                  'Certificate authority',
                  instance.caFile === null ? 'public authorities' : <code>{instance.caFile}</code>,
                ],
                ['Status', <StatusBadge {...enabledState(instance.disabledAt)} />],
                [
                  'Number prefixes',
                  Object.keys(instance.numberPrefixes).length === 0
                    ? 'learned from Agility'
                    : Object.entries(instance.numberPrefixes)
                        .map(([type, prefix]) => `${type}: ${prefix}`)
                        .join(', '),
                ],
                ['Added', <When at={instance.createdAt} />],
              ]}
            />
            {creds.ok && workspaces.ok ? null : (
              <Notes
                title="Not everything loaded"
                items={['Credentials or workspaces could not be listed.']}
              />
            )}
          </section>
          <section aria-labelledby="creds-heading">
            <h2 id="creds-heading">Credentials</h2>
            <DataTable
              caption="Credentials of this instance"
              empty="No credentials."
              rows={credentials}
              columns={[
                {
                  header: 'Name',
                  cell: (k) => <a href={adminPath`/admin/credentials/${k.id}`}>{k.label}</a>,
                },
                { header: 'Kind', cell: (k) => (k.ownerUserId === null ? 'shared' : 'personal') },
                {
                  header: 'Status',
                  cell: (k) => (k.revokedAt === null ? k.validationStatus : 'revoked'),
                },
              ]}
            />
          </section>
          <section aria-labelledby="ws-heading">
            <h2 id="ws-heading">Workspaces</h2>
            <DataTable
              caption="Workspaces on this instance"
              empty="No workspaces."
              rows={mine}
              columns={[
                { header: 'Name', cell: (w) => <a href={adminPath`/admin/workspaces/${w.id}`}>{w.name}</a> },
                { header: 'Slug', cell: (w) => <code>{w.slug}</code> },
              ]}
            />
          </section>
          <section class="card" aria-labelledby="edit-heading">
            <h2 id="edit-heading">Name</h2>
            <Form action={self} csrf={principal.csrf} label="Rename">
              <TextField name="label" label="Name" value={instance.label} required maxlength={MAX_LABEL} />
              <Button>Save</Button>
            </Form>
          </section>
          <section class="card" aria-labelledby="prefix-heading">
            <h2 id="prefix-heading">Number prefixes</h2>
            <p>The letters before the dash in a number, per asset type (shown above).</p>
            <LinkButton href={`${self}/prefixes`} variant="secondary">
              Edit the prefixes
            </LinkButton>
          </section>
          <section class="card" aria-labelledby="origin-heading">
            <h2 id="origin-heading">Origin and certificate authority</h2>
            {isOwner(principal) ? (
              <>
                <p>
                  Changing either revokes the {live.length} credential{live.length === 1 ? '' : 's'} in use
                  and every grant that used them. It needs a recent sign-in.
                </p>
                <LinkButton href={`${self}/origin`} variant="secondary">
                  Change the origin…
                </LinkButton>
              </>
            ) : (
              <p class="muted">Only an owner can change an instance's origin or certificate authority.</p>
            )}
          </section>
          <section class="card" aria-labelledby="state-heading">
            <h2 id="state-heading">Disable or delete</h2>
            <div class="actions">
              {disabled ? (
                <RowAction
                  action={`${self}/enable`}
                  csrf={principal.csrf}
                  label="Enable"
                  name={`Enable ${instance.label}`}
                />
              ) : (
                <RowAction
                  action={`${self}/disable`}
                  csrf={principal.csrf}
                  label="Disable…"
                  name={`Disable ${instance.label}`}
                />
              )}
              <RowAction
                action={`${self}/delete`}
                csrf={principal.csrf}
                label="Delete…"
                name={`Delete ${instance.label}`}
              />
            </div>
            <p class="hint">
              Disabling stops new credentials; deleting only works for an instance nothing uses any more.
            </p>
          </section>
        </Screen>,
      );
    }),
  );

  ui.post(
    `${ROUTE}/:id`,
    kit.form('admin', async (c, principal, form) => {
      const id = c.req.param('id');
      if (!isId(id)) return kit.redirect(INSTANCES, 'not_found');
      const self = adminPath`/admin/instances/${id}`;
      const label = field(form, 'label');
      if (label === null || label.length > MAX_LABEL) return kit.redirect(self, 'invalid');
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'PATCH', path: adminPath`/instances/${id}`, body: { label } },
        form,
      );
      return isOk(res) ? kit.redirect(self, 'saved') : kit.fail(c, principal, res, self);
    }),
  );

  const toggle = (action: 'disable' | 'enable') =>
    kit.form('admin', async (c, principal, form) => {
      const id = c.req.param('id');
      if (!isId(id)) return kit.redirect(INSTANCES, 'not_found');
      const self = adminPath`/admin/instances/${id}`;
      if (action === 'disable' && !confirmed(form)) {
        const instance = await loadInstance(c, principal, id);
        if ('status' in instance) return kit.fail(c, principal, instance, INSTANCES);
        return confirmPage({
          viewer: principal,
          current: INSTANCES,
          title: `Disable ${instance.label}?`,
          paragraphs: [
            'New credentials can no longer be added to a disabled instance. Existing ones are not revoked.',
          ],
          action: `${self}/disable`,
          confirm: 'Disable',
          cancel: self,
        });
      }
      const res = await kit.callAdmin(
        c,
        principal,
        {
          method: 'PATCH',
          path: adminPath`/instances/${id}`,
          body: { disabledAt: action === 'disable' ? now() : null },
        },
        form,
      );
      return isOk(res)
        ? kit.redirect(self, action === 'disable' ? 'disabled' : 'enabled')
        : kit.fail(c, principal, res, self);
    });
  ui.post(`${ROUTE}/:id/disable`, toggle('disable'));
  ui.post(`${ROUTE}/:id/enable`, toggle('enable'));

  ui.post(
    `${ROUTE}/:id/delete`,
    kit.form('admin', async (c, principal, form) => {
      const id = c.req.param('id');
      if (!isId(id)) return kit.redirect(INSTANCES, 'not_found');
      const self = adminPath`/admin/instances/${id}`;
      if (!confirmed(form)) {
        const instance = await loadInstance(c, principal, id);
        if ('status' in instance) return kit.fail(c, principal, instance, INSTANCES);
        return confirmPage({
          viewer: principal,
          current: INSTANCES,
          title: `Delete ${instance.label}?`,
          paragraphs: [
            'This removes the instance. It only works when no workspace and no credential uses it any more.',
            'Deleting cannot be undone.',
          ],
          action: `${self}/delete`,
          confirm: 'Delete the instance',
          cancel: self,
        });
      }
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'DELETE', path: adminPath`/instances/${id}` },
        form,
      );
      return isOk(res) ? kit.redirect(INSTANCES, 'deleted') : kit.fail(c, principal, res, self);
    }),
  );

  ui.get(
    `${ROUTE}/:id/prefixes`,
    kit.page('admin', async (c, page) => {
      const id = c.req.param('id');
      if (!isId(id)) return errorPage(404, undefined, page.principal);
      const instance = await loadInstance(c, page.principal, id);
      if ('status' in instance) return loadFailed(c, instance, page.principal);
      return page.html(
        <PrefixesPage
          viewer={page.principal}
          instance={instance}
          text={prefixText(instance.numberPrefixes)}
        />,
      );
    }),
  );

  ui.post(
    `${ROUTE}/:id/prefixes`,
    kit.form('admin', async (c, principal, form) => {
      const id = c.req.param('id');
      if (!isId(id)) return kit.redirect(INSTANCES, 'not_found');
      const self = adminPath`/admin/instances/${id}`;
      const instance = await loadInstance(c, principal, id);
      if ('status' in instance) return kit.fail(c, principal, instance, INSTANCES);
      const text = form.fields.get('prefixes') ?? '';
      const again = (error: string, status = 422) =>
        htmlResponse(
          <PrefixesPage viewer={principal} instance={instance} text={text} error={error} />,
          status,
        );
      if (text.length > MAX_PREFIX_TEXT) return again('At most 4000 characters.');
      const parsed = parsePrefixText(text);
      if (!parsed.ok) return again(parsed.error);
      // Only what changed is sent (L-198): an unchanged form writes nothing and audits nothing.
      if (samePrefixes(parsed.prefixes, instance.numberPrefixes)) return kit.redirect(self, 'saved');
      const res = await kit.callAdmin(
        c,
        principal,
        {
          method: 'PATCH',
          path: adminPath`/instances/${id}`,
          body: { numberPrefixes: Object.keys(parsed.prefixes).length === 0 ? null : parsed.prefixes },
        },
        form,
      );
      if (isOk(res)) return kit.redirect(self, 'saved');
      const problem = problemOf(res);
      if (problem.status === 422) return again(formMessage(problem));
      return kit.fail(c, principal, res, `${self}/prefixes`);
    }),
  );

  ui.get(
    `${ROUTE}/:id/origin`,
    kit.page('owner', async (c, page) => {
      const id = c.req.param('id');
      if (!isId(id)) return errorPage(404, undefined, page.principal);
      const instance = await loadInstance(c, page.principal, id);
      if ('status' in instance) return loadFailed(c, instance, page.principal);
      const creds = await load(kit, c, page.principal, '/credentials', (b) => rows(b, parseCredential), {
        instanceId: id,
      });
      const live = creds.ok ? creds.value.filter((k) => k.revokedAt === null).length : 0;
      return page.html(
        <OriginPage
          viewer={page.principal}
          instance={instance}
          live={live}
          draft={draftOf(instance)}
          errors={{}}
        />,
      );
    }),
  );

  ui.post(
    `${ROUTE}/:id/origin`,
    kit.form('owner', async (c, principal, form) => {
      const id = c.req.param('id');
      if (!isId(id)) return kit.redirect(INSTANCES, 'not_found');
      const self = adminPath`/admin/instances/${id}`;
      const instance = await loadInstance(c, principal, id);
      if ('status' in instance) return kit.fail(c, principal, instance, INSTANCES);
      const draft = draftFrom(form);
      const baseUrl = field(form, 'baseUrl');
      const caFile = field(form, 'caFile');
      const errors: Record<string, string> = {};
      if (baseUrl === null || baseUrl.length > MAX_URL)
        errors['baseUrl'] = 'Enter the new address of your Agility site.';
      if (caFile !== null && caFile.length > MAX_PATH) errors['caFile'] = 'At most 1024 characters.';
      const again = async (errs: Record<string, string>, message?: string) => {
        const creds = await load(kit, c, principal, '/credentials', (b) => rows(b, parseCredential), {
          instanceId: id,
        });
        const live = creds.ok ? creds.value.filter((k) => k.revokedAt === null).length : 0;
        return htmlResponse(
          <OriginPage
            viewer={principal}
            instance={instance}
            live={live}
            draft={draft}
            errors={errs}
            message={message}
          />,
          422,
        );
      };
      if (form.fields.get('understood') === null && Object.keys(errors).length === 0)
        return again(
          {},
          'Tick the box to confirm that the credentials and grants will be revoked. Nothing was changed.',
        );
      if (Object.keys(errors).length > 0) return again(errors);
      const res = await kit.callAdmin(
        c,
        principal,
        {
          method: 'POST',
          path: adminPath`/instances/${id}/retarget`,
          body: { baseUrl, tls: caFile === null ? null : { caFile } },
        },
        form,
      );
      if (isOk(res)) return kit.redirect(self, 'origin_changed');
      const problem = problemOf(res);
      if (problem.status === 422) {
        return problem.field === 'baseUrl'
          ? again({ baseUrl: formMessage(problem) })
          : again({}, formMessage(problem));
      }
      if (problem.status === 502)
        return again({}, 'The new address did not answer like an Agility site, so nothing was changed.');
      return kit.fail(c, principal, res, `${self}/origin`);
    }),
  );
}
