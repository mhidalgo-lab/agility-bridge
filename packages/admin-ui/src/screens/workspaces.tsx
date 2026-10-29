// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// Workspaces (P4-04, THREAT_MODEL T3): which Agility projects an MCP endpoint serves, with which tools, asset types and
// limits. Write settings, write tools and pass-through belong to owners (and a recent sign-in); admins never see those
// controls, and an admin editing a workspace that already has write tools leaves that list alone.
//
//   GET  /admin/workspaces                 list                      (owner, admin)
//   GET  /admin/workspaces/new             step 1: choose the instance, step 2 (?instance=): the form
//   POST /admin/workspaces                 create
//   GET  /admin/workspaces/:id             detail, grants, forms     POST .../edit    change
//   GET  /admin/workspaces/:id/edit        edit form                 POST .../disable | enable | delete (confirmation first)
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
  QueryForm,
  SelectField,
  TextField,
} from '../components.tsx';
import { adminPath, type UiKit, type UiPrincipal } from '../kit.ts';
import { errorPage, htmlResponse } from '../pages.tsx';
import {
  type Credential,
  type Grant,
  type Instance,
  isId,
  one,
  parseCredential,
  parseGrant,
  parseInstance,
  parseTool,
  parseUser,
  parseWorkspace,
  rows,
  type Tool,
  type User,
  type Workspace,
} from './data.ts';
import {
  AssetTypeFields,
  assetTypesFrom,
  assetTypeValues,
  budgetNotes,
  compositeNotes,
  confirmed,
  confirmPage,
  enabledState,
  FormError,
  field,
  formErrors,
  hasWriteTools,
  isOk,
  isOwner,
  LimitsFields,
  limitFieldOf,
  limitsFrom,
  limitsSummary,
  limitValues,
  load,
  loadFailed,
  Notes,
  paged,
  problemOf,
  RowAction,
  Screen,
  StatusBadge,
  ToolChecklist,
  toolsFrom,
  toolValues,
  typesFieldOf,
  When,
  withQuery,
  words,
} from './shared.tsx';

export const WORKSPACES = '/admin/workspaces';
const ROUTE = '/workspaces';
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SCOPE = /^Scope:\d{1,12}$/;
const MAX_NAME = 200;

/** The values a workspace form posts, for a stored workspace (the same shape a posted form has). */
function workspaceValues(ws: Workspace): URLSearchParams {
  const v = new URLSearchParams();
  v.set('slug', ws.slug);
  v.set('name', ws.name);
  v.set('scopes', ws.allowedScopeIds.join(', '));
  if (ws.includeChildScopes) v.set('children', '1');
  if (ws.defaultCredentialId !== null) v.set('credential', ws.defaultCredentialId);
  v.set('source', ws.credentialSource);
  if (ws.writesEnabled) v.set('writes', '1');
  if (ws.customFields.length > 0) v.set('customfields', ws.customFields.join(', '));
  toolValues(ws.enabledTools, v);
  assetTypeValues(ws.assetTypes, v);
  limitValues(ws.limits, v);
  return v;
}

const sameList = (a: readonly string[] | null, b: readonly string[] | null): boolean =>
  a === null || b === null
    ? a === b
    : a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

const CUSTOM_FIELD = /^Custom_[A-Za-z0-9_]{1,80}$/;

/** `Custom_Name` attributes from a text field (P7-20): at most 20, each a plain identifier. */
function customFieldsFrom(v: string | null): { value: string[] } | { error: string } {
  const out = [...new Set(words(v))];
  if (out.length > 20 || out.some((s) => !CUSTOM_FIELD.test(s)))
    return {
      error:
        'Use at most 20 custom attribute names written as Custom_Name (letters, digits and underscores), separated by commas.',
    };
  return { value: out };
}

/** `Scope:123` tokens from a text field; a bare number is taken as a project id. */
function scopesFrom(v: string | null): { value: string[] } | { error: string } {
  const out = words(v).map((w) => (/^\d{1,12}$/.test(w) ? `Scope:${w}` : w));
  if (out.length === 0) return { error: 'Name at least one Agility project, for example Scope:1001.' };
  if (out.length > 1_000 || out.some((s) => !SCOPE.test(s)))
    return {
      error: 'Use Agility project ids written as Scope:1234 (or just the number), separated by commas.',
    };
  return { value: out };
}

interface WorkspaceFormProps {
  readonly viewer: UiPrincipal;
  readonly mode: 'create' | 'edit';
  readonly action: string;
  readonly cancel: string;
  readonly instance: Instance | null;
  readonly values: URLSearchParams;
  readonly errors: Readonly<Record<string, string>>;
  readonly message?: string | undefined;
  readonly tools: readonly Tool[];
  readonly credentials: readonly Credential[];
  readonly knownScopes: readonly string[];
  /** The stored workspace being edited: an admin cannot keep or change a write-tool list that is already there. */
  readonly current: Workspace | null;
}

function WorkspaceForm(props: WorkspaceFormProps) {
  const { viewer, values: v, errors } = props;
  const owner = isOwner(viewer);
  const lockedTools =
    !owner && props.current !== null && hasWriteTools(props.current.enabledTools, props.tools);
  const shared = props.credentials.filter((k) => k.ownerUserId === null && k.revokedAt === null);
  return (
    <Layout
      title={props.mode === 'create' ? 'New workspace' : 'Edit workspace'}
      viewer={viewer}
      current={WORKSPACES}
    >
      {props.instance === null ? null : (
        <p>
          On <strong>{props.instance.label}</strong>
          {props.mode === 'create' ? '. The instance cannot be changed later.' : '.'}
        </p>
      )}
      <FormError message={props.message} />
      <Form action={props.action} csrf={viewer.csrf} label="Workspace">
        {props.mode === 'create' ? (
          <>
            <input type="hidden" name="instanceId" value={props.instance?.id ?? ''} />
            <TextField
              name="slug"
              label="Address name"
              hint="Lowercase letters, digits and hyphens. Clients connect to /w/<this>/mcp; it cannot be changed later."
              value={v.get('slug') ?? ''}
              required
              maxlength={63}
              spellcheck={false}
              error={errors['slug']}
            />
          </>
        ) : null}
        <TextField
          name="name"
          label="Name"
          value={v.get('name') ?? ''}
          required
          maxlength={MAX_NAME}
          error={errors['name']}
        />
        <TextField
          name="scopes"
          label="Agility projects"
          hint={
            props.knownScopes.length === 0
              ? 'Project ids written as Scope:1001, separated by commas. Nothing outside these is ever readable through this workspace.'
              : `Project ids written as Scope:1001, separated by commas. Projects the instance's credentials can reach: ${props.knownScopes.join(', ')}.`
          }
          value={v.get('scopes') ?? ''}
          required
          maxlength={20_000}
          spellcheck={false}
          error={errors['scopes']}
        />
        <Checkbox
          name="children"
          label="Include the child projects of these projects"
          checked={v.has('children')}
        />
        <SelectField
          name="credential"
          label="Default shared credential"
          hint="Used by grants that name no credential. Shared credentials are read-only."
          value={v.get('credential') ?? ''}
          error={errors['credential']}
          options={[
            { value: '', label: 'None: every grant names its own' },
            ...shared.map((k) => ({ value: k.id, label: k.label })),
          ]}
        />
        {lockedTools ? (
          <p class="muted">
            This workspace enables write tools; only an owner can change its tool list. It stays as it is.
          </p>
        ) : (
          <ToolChecklist
            tools={props.tools}
            values={v}
            legend="Tools"
            allLabel="Every read tool"
            allHint="Includes read tools added later. Write tools are never included."
            writesAllowed={owner}
            error={errors['tools']}
          />
        )}
        <AssetTypeFields values={v} errors={errors} />
        <LimitsFields
          values={v}
          errors={errors}
          hint="Leave a field blank for the server's default. Grants can only narrow these."
        />
        {owner ? (
          <fieldset class="field">
            <legend>Owner settings</legend>
            <p class="hint">Changing these needs a recent sign-in.</p>
            <Checkbox
              name="writes"
              label="Allow writes through this workspace"
              hint="Write tools also need the server's write switch, listing in the tools above, and a grant."
              checked={v.has('writes')}
            />
            <TextField
              name="customfields"
              label="Custom attributes agents may write"
              hint="Optional. Names written as Custom_Name, separated by commas, at most 20. Only create and update tools use them; each is still checked against the instance's own attribute (it must be writable text or a number) and every value needs the person's approval."
              value={v.get('customfields') ?? ''}
              maxlength={2_000}
              spellcheck={false}
              error={errors['customfields']}
            />
            <SelectField
              name="source"
              label="Credential source"
              hint="Pass-through serves anyone who sends their own Agility token to this workspace (needs the server's pass-through switch)."
              value={v.get('source') ?? 'stored'}
              options={[
                { value: 'stored', label: 'Stored credentials, chosen by grants' },
                { value: 'passthrough', label: 'Pass-through: callers send their own token' },
              ]}
            />
          </fieldset>
        ) : null}
        <div class="actions">
          <Button>{props.mode === 'create' ? 'Create workspace' : 'Save'}</Button>
          <LinkButton href={props.cancel} variant="secondary">
            Cancel
          </LinkButton>
        </div>
      </Form>
    </Layout>
  );
}

/** An API field path to the form field that shows it. */
function formFieldOf(apiField: string | undefined): string | undefined {
  if (apiField === undefined) return undefined;
  const limit = limitFieldOf(apiField);
  if (limit !== undefined) return limit;
  const types = typesFieldOf(apiField);
  if (types !== undefined) return types;
  const known: Record<string, string> = {
    slug: 'slug',
    name: 'name',
    allowedScopeIds: 'scopes',
    enabledTools: 'tools',
    defaultCredentialId: 'credential',
  };
  return known[apiField.split('.')[0] ?? ''];
}

export function registerWorkspaces(ui: Hono, kit: UiKit): void {
  const now = () => (kit.deps.now ?? Date.now)();

  const catalogue = async (c: Context, principal: UiPrincipal) => {
    const got = await load(kit, c, principal, '/tools', (b) => rows(b, parseTool));
    return got.ok ? got.value : [];
  };
  const loadWorkspace = async (c: Context, principal: UiPrincipal, id: string) => {
    const got = await load(kit, c, principal, adminPath`/workspaces/${id}`, (b) => one(b, parseWorkspace));
    return got.ok ? got.value : got.result;
  };
  const credentialsOf = async (c: Context, principal: UiPrincipal, instanceId: string) => {
    const got = await load(kit, c, principal, '/credentials', (b) => rows(b, parseCredential), {
      instanceId,
    });
    return got.ok ? got.value : [];
  };
  const knownScopes = (creds: readonly Credential[]): string[] =>
    [...new Set(creds.filter((k) => k.revokedAt === null).flatMap((k) => k.reachableScopeIds ?? []))].slice(
      0,
      50,
    );

  /** The body a form describes. The viewer's role decides which owner-only fields are even read. */
  const bodyFrom = (
    form: { fields: URLSearchParams },
    principal: UiPrincipal,
    tools: readonly Tool[],
    current: Workspace | null,
  ): { body: Record<string, unknown> } | { errors: Record<string, string> } => {
    const errors: Record<string, string> = {};
    const body: Record<string, unknown> = {};
    const name = field(form, 'name');
    if (name === null || name.length > MAX_NAME) errors['name'] = 'Enter a name of up to 200 characters.';
    else body['name'] = name;
    const scopes = scopesFrom(field(form, 'scopes'));
    if ('error' in scopes) errors['scopes'] = scopes.error;
    else body['allowedScopeIds'] = scopes.value;
    body['includeChildScopes'] = form.fields.has('children');
    const credential = field(form, 'credential');
    if (credential !== null && !isId(credential)) errors['credential'] = 'Choose one of the credentials.';
    else if (current !== null || credential !== null) body['defaultCredentialId'] = credential;
    const types = assetTypesFrom(form);
    if ('errors' in types) Object.assign(errors, types.errors);
    else body['assetTypes'] = types.value;
    const limits = limitsFrom(form);
    if ('errors' in limits) Object.assign(errors, limits.errors);
    else body['limits'] = limits.limits;

    const owner = isOwner(principal);
    const locked = !owner && current !== null && hasWriteTools(current.enabledTools, tools);
    if (!locked) {
      const picked = toolsFrom(form, tools);
      if ('error' in picked) errors['tools'] = picked.error;
      // Only a changed list is sent: a list with write tools needs a recent sign-in even when it did not change.
      else if (current === null || !sameList(picked.value, current.enabledTools))
        body['enabledTools'] = picked.value;
    }
    if (owner) {
      const writes = form.fields.has('writes');
      const custom = customFieldsFrom(field(form, 'customfields'));
      if ('error' in custom) errors['customfields'] = custom.error;
      // The policy is replaced as a whole, so both settings travel together; nothing is sent when neither changed.
      else if (
        current === null
          ? writes || custom.value.length > 0
          : writes !== current.writesEnabled || !sameList(custom.value, current.customFields)
      )
        body['writePolicy'] = {
          enabled: writes,
          ...(custom.value.length > 0 ? { customFields: custom.value } : {}),
        };
      const source = form.fields.get('source') === 'passthrough' ? 'passthrough' : 'stored';
      if (current === null ? source === 'passthrough' : source !== current.credentialSource)
        body['credentialSource'] = source;
    }
    return Object.keys(errors).length > 0 ? { errors } : { body };
  };

  ui.get(
    ROUTE,
    kit.page('admin', async (c, page) => {
      const { principal } = page;
      const got = await load(kit, c, principal, '/workspaces', (b) => rows(b, parseWorkspace));
      if (!got.ok) return loadFailed(c, got.result, principal);
      const instances = await load(kit, c, principal, '/instances', (b) => rows(b, parseInstance));
      const labels = new Map((instances.ok ? instances.value : []).map((i) => [i.id, i.label]));
      const list = paged(got.value, c.req.query('page'), WORKSPACES);
      return page.html(
        <Screen page={page} title="Workspaces" current={WORKSPACES}>
          <p>
            A workspace is one MCP endpoint: a set of Agility projects with the tools, asset types and limits
            that apply to everyone who connects to it. Grants say who may use it.
          </p>
          <div class="actions page-actions">
            <LinkButton href={`${WORKSPACES}/new`}>New workspace</LinkButton>
          </div>
          <DataTable
            caption="Workspaces"
            empty="No workspaces yet."
            rows={list.rows}
            columns={[
              { header: 'Name', cell: (w) => <a href={adminPath`/admin/workspaces/${w.id}`}>{w.name}</a> },
              { header: 'Endpoint', cell: (w) => <code>{`/w/${w.slug}/mcp`}</code> },
              { header: 'Instance', cell: (w) => labels.get(w.instanceId) ?? 'unknown' },
              { header: 'Projects', cell: (w) => String(w.allowedScopeIds.length) },
              { header: 'Status', cell: (w) => <StatusBadge {...enabledState(w.disabledAt)} /> },
            ]}
          />
          <Pager label="Workspace pages" prev={list.prev} next={list.next} />
        </Screen>,
      );
    }),
  );

  ui.get(
    `${ROUTE}/new`,
    kit.page('admin', async (c, page) => {
      const { principal } = page;
      const instances = await load(kit, c, principal, '/instances', (b) => rows(b, parseInstance));
      if (!instances.ok) return loadFailed(c, instances.result, principal);
      const live = instances.value.filter((i) => i.disabledAt === null);
      const picked = c.req.query('instance');
      const instance = isId(picked) ? live.find((i) => i.id === picked) : undefined;
      if (instance === undefined) {
        return page.html(
          <Screen page={page} title="New workspace" current={WORKSPACES}>
            <p>Step 1 of 2: the Agility instance the workspace reads.</p>
            {live.length === 0 ? (
              <p class="card">
                There is no instance yet. <a href="/admin/instances/new">Add one</a> first.
              </p>
            ) : (
              <QueryForm action={`${WORKSPACES}/new`} label="Choose the instance">
                <SelectField
                  name="instance"
                  label="Instance"
                  options={live.map((i) => ({ value: i.id, label: i.label }))}
                />
                <div class="actions">
                  <Button>Next</Button>
                  <LinkButton href={WORKSPACES} variant="secondary">
                    Cancel
                  </LinkButton>
                </div>
              </QueryForm>
            )}
          </Screen>,
        );
      }
      const [tools, creds] = await Promise.all([
        catalogue(c, principal),
        credentialsOf(c, principal, instance.id),
      ]);
      return page.html(
        <WorkspaceForm
          viewer={principal}
          mode="create"
          action={WORKSPACES}
          cancel={WORKSPACES}
          instance={instance}
          values={new URLSearchParams({ tools_all: '1' })}
          errors={{}}
          tools={tools}
          credentials={creds}
          knownScopes={knownScopes(creds)}
          current={null}
        />,
      );
    }),
  );

  ui.post(
    ROUTE,
    kit.form('admin', async (c, principal, form) => {
      const instanceId = field(form, 'instanceId');
      if (!isId(instanceId)) return kit.redirect(`${WORKSPACES}/new`, 'not_found');
      const gotInstance = await load(kit, c, principal, adminPath`/instances/${instanceId}`, (b) =>
        one(b, parseInstance),
      );
      if (!gotInstance.ok) return kit.fail(c, principal, gotInstance.result, `${WORKSPACES}/new`);
      const [tools, creds] = await Promise.all([
        catalogue(c, principal),
        credentialsOf(c, principal, instanceId),
      ]);
      const again = (errors: Record<string, string>, message?: string, status = 422) =>
        htmlResponse(
          <WorkspaceForm
            viewer={principal}
            mode="create"
            action={WORKSPACES}
            cancel={WORKSPACES}
            instance={gotInstance.value}
            values={form.fields}
            errors={errors}
            message={message}
            tools={tools}
            credentials={creds}
            knownScopes={knownScopes(creds)}
            current={null}
          />,
          status,
        );
      // The no-script "check" step: re-render with the notes for the list as ticked, change nothing (P6-35).
      if (form.fields.has('check')) return again({}, undefined, 200);
      const slug = field(form, 'slug');
      const built = bodyFrom(form, principal, tools, null);
      const errors = 'errors' in built ? { ...built.errors } : {};
      if (slug === null || !SLUG.test(slug))
        errors['slug'] = 'Use lowercase letters, digits and hyphens (up to 63 characters).';
      if (Object.keys(errors).length > 0 || 'errors' in built) return again(errors);
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'POST', path: '/workspaces', body: { ...built.body, slug, instanceId } },
        form,
      );
      if (isOk(res)) {
        const created = one(res.body, parseWorkspace);
        return kit.redirect(
          created === null ? WORKSPACES : adminPath`/admin/workspaces/${created.id}`,
          'created',
        );
      }
      const problem = problemOf(res);
      if (problem.status === 422 || problem.status === 409) {
        const shown = formErrors(problem, formFieldOf);
        return again(shown.errors, shown.message);
      }
      return kit.fail(c, principal, res, `${WORKSPACES}/new`);
    }),
  );

  ui.get(
    `${ROUTE}/:id`,
    kit.page('admin', async (c, page) => {
      const { principal } = page;
      const id = c.req.param('id');
      if (!isId(id)) return errorPage(404, undefined, principal);
      const ws = await loadWorkspace(c, principal, id);
      if ('status' in ws) return loadFailed(c, ws, principal);
      const [instance, grants, users, creds, tools] = await Promise.all([
        load(kit, c, principal, adminPath`/instances/${ws.instanceId}`, (b) => one(b, parseInstance)),
        load(kit, c, principal, '/grants', (b) => rows(b, parseGrant), { workspaceId: id }),
        load(kit, c, principal, '/users', (b) => rows(b, parseUser)),
        credentialsOf(c, principal, ws.instanceId),
        load(kit, c, principal, '/tools', (b) => rows(b, parseTool)),
      ]);
      const emails = new Map<string, User>((users.ok ? users.value : []).map((u) => [u.id, u]));
      const t = now();
      const self = adminPath`/admin/workspaces/${id}`;
      const defaultCredential = creds.find((k) => k.id === ws.defaultCredentialId);
      const grantRows: Grant[] = grants.ok ? grants.value : [];
      return page.html(
        <Screen page={page} title={ws.name} current={WORKSPACES}>
          <section class="card" aria-labelledby="facts-heading">
            <h2 id="facts-heading">Workspace</h2>
            <Facts
              items={[
                ['Endpoint', <code>{`/w/${ws.slug}/mcp`}</code>],
                [
                  'Instance',
                  instance.ok ? (
                    <a href={adminPath`/admin/instances/${ws.instanceId}`}>{instance.value.label}</a>
                  ) : (
                    'unknown'
                  ),
                ],
                ['Status', <StatusBadge {...enabledState(ws.disabledAt)} />],
                ['Projects', ws.allowedScopeIds.join(', ')],
                ['Child projects', ws.includeChildScopes ? 'included' : 'not included'],
                [
                  'Default credential',
                  defaultCredential === undefined ? (
                    'none'
                  ) : (
                    <a href={adminPath`/admin/credentials/${defaultCredential.id}`}>
                      {defaultCredential.label}
                    </a>
                  ),
                ],
                [
                  'Credential source',
                  ws.credentialSource === 'passthrough' ? 'pass-through' : 'stored credentials',
                ],
                [
                  'Tools',
                  ws.enabledTools === null ? 'every read tool' : ws.enabledTools.join(', ') || 'none',
                ],
                [
                  'Asset types',
                  ws.assetTypes === null || (ws.assetTypes.allow === null && ws.assetTypes.deny === null)
                    ? 'every type'
                    : [
                        ws.assetTypes.allow === null ? '' : `only ${ws.assetTypes.allow.join(', ')}`,
                        ws.assetTypes.deny === null ? '' : `never ${ws.assetTypes.deny.join(', ')}`,
                      ]
                        .filter((s) => s !== '')
                        .join('; '),
                ],
                ['Limits', limitsSummary(ws.limits).join('; ') || "the server's defaults"],
                ['Writes', ws.writesEnabled ? 'allowed (with the right tools and grants)' : 'off'],
                [
                  'Writable custom attributes',
                  ws.customFields.length === 0 ? 'none' : ws.customFields.join(', '),
                ],
                ['Created', <When at={ws.createdAt} />],
              ]}
            />
            <Notes
              title="Notes"
              items={[
                ...compositeNotes(ws.enabledTools, tools.ok ? tools.value : []),
                ...budgetNotes(
                  ws.enabledTools,
                  typeof ws.limits['callBudget'] === 'number' ? ws.limits['callBudget'] : undefined,
                  tools.ok ? tools.value : [],
                ),
              ]}
            />
            <div class="actions">
              <LinkButton href={`${self}/edit`}>Edit</LinkButton>
            </div>
          </section>
          <section aria-labelledby="grants-heading">
            <h2 id="grants-heading">Grants</h2>
            <div class="actions page-actions">
              <LinkButton href={withQuery('/admin/grants/new', { workspace: id })}>New grant</LinkButton>
            </div>
            <DataTable
              caption="Grants on this workspace"
              empty="No one has access yet."
              rows={grantRows}
              columns={[
                {
                  header: 'Who',
                  cell: (g) => (
                    <a href={adminPath`/admin/grants/${g.id}`}>
                      {g.userId === null
                        ? `service: ${g.label ?? 'unnamed'}`
                        : (emails.get(g.userId)?.email ?? 'unknown person')}
                    </a>
                  ),
                },
                {
                  header: 'Status',
                  cell: (g) =>
                    g.revokedAt !== null
                      ? 'revoked'
                      : g.expiresAt !== null && g.expiresAt <= t
                        ? 'expired'
                        : 'active',
                },
              ]}
            />
          </section>
          <section class="card" aria-labelledby="end-heading">
            <h2 id="end-heading">Disable or delete</h2>
            <div class="actions">
              {ws.disabledAt === null ? (
                <RowAction
                  action={`${self}/disable`}
                  csrf={principal.csrf}
                  label="Disable…"
                  name={`Disable ${ws.name}`}
                />
              ) : (
                <RowAction
                  action={`${self}/enable`}
                  csrf={principal.csrf}
                  label="Enable"
                  name={`Enable ${ws.name}`}
                />
              )}
              <RowAction
                action={`${self}/delete`}
                csrf={principal.csrf}
                label="Delete…"
                name={`Delete ${ws.name}`}
              />
            </div>
            <p class="hint">
              A disabled workspace answers no one. Deleting removes its grants and their device tokens.
            </p>
          </section>
        </Screen>,
      );
    }),
  );

  ui.get(
    `${ROUTE}/:id/edit`,
    kit.page('admin', async (c, page) => {
      const { principal } = page;
      const id = c.req.param('id');
      if (!isId(id)) return errorPage(404, undefined, principal);
      const ws = await loadWorkspace(c, principal, id);
      if ('status' in ws) return loadFailed(c, ws, principal);
      const [tools, creds, instance] = await Promise.all([
        catalogue(c, principal),
        credentialsOf(c, principal, ws.instanceId),
        load(kit, c, principal, adminPath`/instances/${ws.instanceId}`, (b) => one(b, parseInstance)),
      ]);
      return page.html(
        <WorkspaceForm
          viewer={principal}
          mode="edit"
          action={`${adminPath`/admin/workspaces/${id}`}/edit`}
          cancel={adminPath`/admin/workspaces/${id}`}
          instance={instance.ok ? instance.value : null}
          values={workspaceValues(ws)}
          errors={{}}
          tools={tools}
          credentials={creds}
          knownScopes={knownScopes(creds)}
          current={ws}
        />,
      );
    }),
  );

  ui.post(
    `${ROUTE}/:id/edit`,
    kit.form('admin', async (c, principal, form) => {
      const id = c.req.param('id');
      if (!isId(id)) return kit.redirect(WORKSPACES, 'not_found');
      const self = adminPath`/admin/workspaces/${id}`;
      const ws = await loadWorkspace(c, principal, id);
      if ('status' in ws) return kit.fail(c, principal, ws, WORKSPACES);
      const [tools, creds, instance] = await Promise.all([
        catalogue(c, principal),
        credentialsOf(c, principal, ws.instanceId),
        load(kit, c, principal, adminPath`/instances/${ws.instanceId}`, (b) => one(b, parseInstance)),
      ]);
      const again = (errors: Record<string, string>, message?: string, status = 422) =>
        htmlResponse(
          <WorkspaceForm
            viewer={principal}
            mode="edit"
            action={`${self}/edit`}
            cancel={self}
            instance={instance.ok ? instance.value : null}
            values={form.fields}
            errors={errors}
            message={message}
            tools={tools}
            credentials={creds}
            knownScopes={knownScopes(creds)}
            current={ws}
          />,
          status,
        );
      // The no-script "check" step: re-render with the notes for the list as ticked, change nothing (P6-35).
      if (form.fields.has('check')) return again({}, undefined, 200);
      const built = bodyFrom(form, principal, tools, ws);
      if ('errors' in built) return again(built.errors);
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'PATCH', path: adminPath`/workspaces/${id}`, body: built.body },
        form,
      );
      if (isOk(res)) return kit.redirect(self, 'saved');
      const problem = problemOf(res);
      if (problem.status === 422 || problem.status === 409) {
        const shown = formErrors(problem, formFieldOf);
        return again(shown.errors, shown.message);
      }
      return kit.fail(c, principal, res, `${self}/edit`);
    }),
  );

  ui.post(
    `${ROUTE}/:id/disable`,
    kit.form('admin', async (c, principal, form) => {
      const id = c.req.param('id');
      if (!isId(id)) return kit.redirect(WORKSPACES, 'not_found');
      const self = adminPath`/admin/workspaces/${id}`;
      if (!confirmed(form)) {
        const ws = await loadWorkspace(c, principal, id);
        if ('status' in ws) return kit.fail(c, principal, ws, WORKSPACES);
        return confirmPage({
          viewer: principal,
          current: WORKSPACES,
          title: `Disable ${ws.name}?`,
          paragraphs: [
            `Every device token that reaches /w/${ws.slug}/mcp stops working until the workspace is enabled again.`,
          ],
          action: `${self}/disable`,
          confirm: 'Disable the workspace',
          cancel: self,
        });
      }
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'POST', path: adminPath`/workspaces/${id}/disable` },
        form,
      );
      return isOk(res) ? kit.redirect(self, 'disabled') : kit.fail(c, principal, res, self);
    }),
  );

  ui.post(
    `${ROUTE}/:id/enable`,
    kit.form('admin', async (c, principal, form) => {
      const id = c.req.param('id');
      if (!isId(id)) return kit.redirect(WORKSPACES, 'not_found');
      const self = adminPath`/admin/workspaces/${id}`;
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'PATCH', path: adminPath`/workspaces/${id}`, body: { disabledAt: null } },
        form,
      );
      return isOk(res) ? kit.redirect(self, 'enabled') : kit.fail(c, principal, res, self);
    }),
  );

  ui.post(
    `${ROUTE}/:id/delete`,
    kit.form('admin', async (c, principal, form) => {
      const id = c.req.param('id');
      if (!isId(id)) return kit.redirect(WORKSPACES, 'not_found');
      const self = adminPath`/admin/workspaces/${id}`;
      if (!confirmed(form)) {
        const ws = await loadWorkspace(c, principal, id);
        if ('status' in ws) return kit.fail(c, principal, ws, WORKSPACES);
        const grants = await load(kit, c, principal, '/grants', (b) => rows(b, parseGrant), {
          workspaceId: id,
        });
        const n = grants.ok ? grants.value.length : 0;
        return confirmPage({
          viewer: principal,
          current: WORKSPACES,
          title: `Delete ${ws.name}?`,
          paragraphs: [
            `This deletes the workspace, its ${n} grant${n === 1 ? '' : 's'} and every device token on them. Devices using them stop working at once.`,
            'Deleting cannot be undone. To stop access but keep the settings, disable the workspace instead.',
          ],
          action: `${self}/delete`,
          confirm: 'Delete the workspace',
          cancel: self,
        });
      }
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'DELETE', path: adminPath`/workspaces/${id}` },
        form,
      );
      return isOk(res) ? kit.redirect(WORKSPACES, 'deleted') : kit.fail(c, principal, res, self);
    }),
  );
}
