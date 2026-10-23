// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// Grants (P4-04, THREAT_MODEL T3, A5): who may use which workspace, with which credential, tools, projects, asset types,
// limits, rate and expiry. A grant can only narrow its workspace. Write tools need an owner and a recent sign-in (the panel
// hides them from admins); the grant's device tokens are managed on its page (tokens.tsx).
//
//   GET  /admin/grants                    list (filter: workspace)       (owner, admin)
//   GET  /admin/grants/new                step 1: workspace, step 2 (?workspace=): the form    POST /admin/grants   create
//   GET  /admin/grants/:id                detail: notes, tokens, forms
//   GET  /admin/grants/:id/edit           edit form      POST .../edit   change
//   POST /admin/grants/:id/revoke | delete   (confirmation page first)
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
  isId,
  one,
  parseCredential,
  parseGrant,
  parseToken,
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
  confirmed,
  confirmPage,
  FormError,
  field,
  formErrors,
  hasWriteTools,
  isOk,
  isOwner,
  LimitsFields,
  lifecycle,
  limitFieldOf,
  limitsFrom,
  limitsSummary,
  limitValues,
  load,
  loadFailed,
  Notes,
  paged,
  personText,
  problemOf,
  RowAction,
  Screen,
  StatusBadge,
  ToolChecklist,
  toolsFrom,
  toolValues,
  typesFieldOf,
  When,
  wholeNumber,
  withQuery,
} from './shared.tsx';
import { canIssueOn, TokenTable } from './tokens.tsx';

export const GRANTS = '/admin/grants';
const ROUTE = '/grants';
const MAX_LABEL = 200;
const DAY = 86_400_000;

export const EXPIRY = [
  ['keep', 'Keep the current expiry'],
  ['never', 'Never expires'],
  ['30', 'In 30 days'],
  ['90', 'In 90 days'],
  ['180', 'In 180 days'],
  ['365', 'In 1 year'],
] as const;

const sameList = (a: readonly string[] | null, b: readonly string[] | null): boolean =>
  a === null || b === null
    ? a === b
    : a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/** The values a grant form posts, for a stored grant. */
function grantValues(g: Grant): URLSearchParams {
  const v = new URLSearchParams();
  v.set('who', g.userId ?? '');
  if (g.label !== null) v.set('label', g.label);
  if (g.credentialId !== null) v.set('credential', g.credentialId);
  toolValues(g.tools, v);
  if (g.scopeIds === null) v.set('scopes_all', '1');
  else for (const s of g.scopeIds) v.append('scopes', s);
  assetTypeValues(g.assetTypes, v);
  limitValues(g.limits, v);
  if (g.perMinute !== null) v.set('perMinute', String(g.perMinute));
  v.set('expiry', 'keep');
  return v;
}

interface GrantFormProps {
  readonly viewer: UiPrincipal;
  readonly mode: 'create' | 'edit';
  readonly action: string;
  readonly cancel: string;
  readonly workspace: Workspace;
  readonly values: URLSearchParams;
  readonly errors: Readonly<Record<string, string>>;
  readonly message?: string | undefined;
  readonly tools: readonly Tool[];
  readonly credentials: readonly Credential[];
  readonly users: readonly User[];
  readonly current: Grant | null;
}

function GrantForm(props: GrantFormProps) {
  const { viewer, values: v, errors, workspace } = props;
  const owner = isOwner(viewer);
  const lockedTools = !owner && props.current !== null && hasWriteTools(props.current.tools, props.tools);
  const people = new Map(props.users.map((u) => [u.id, u]));
  const credentialLabel = (k: Credential) =>
    k.ownerUserId === null
      ? `${k.label} (shared)`
      : `${k.label} (personal: ${people.get(k.ownerUserId) === undefined ? 'unknown' : personText(people.get(k.ownerUserId) as User)})`;
  const usable = props.credentials.filter(
    (k) => k.revokedAt === null || k.id === props.current?.credentialId,
  );
  return (
    <Layout title={props.mode === 'create' ? 'New grant' : 'Edit grant'} viewer={viewer} current={GRANTS}>
      <p>
        On the workspace <strong>{workspace.name}</strong> (<code>{`/w/${workspace.slug}/mcp`}</code>). A
        grant can narrow what the workspace allows; it can never widen it.
      </p>
      <FormError message={props.message} />
      <Form action={props.action} csrf={viewer.csrf} label="Grant">
        {props.mode === 'create' ? (
          <>
            <input type="hidden" name="workspaceId" value={workspace.id} />
            <SelectField
              name="who"
              label="Who"
              hint="A person, or a service (a shared automation with no person behind it: read-only, needs a name)."
              value={v.get('who') ?? ''}
              error={errors['who']}
              options={[
                { value: '', label: 'A service (no person)' },
                ...props.users
                  .filter((u) => u.disabledAt === null)
                  .map((u) => ({ value: u.id, label: personText(u) })),
              ]}
            />
          </>
        ) : null}
        <TextField
          name="label"
          label="Name"
          hint="Required for a service. For a person it is an optional note."
          value={v.get('label') ?? ''}
          maxlength={MAX_LABEL}
          error={errors['label']}
        />
        <SelectField
          name="credential"
          label="Agility credential"
          hint="The token the server uses for Agility on behalf of this grant."
          value={v.get('credential') ?? ''}
          error={errors['credential']}
          options={[
            {
              value: '',
              label:
                workspace.defaultCredentialId === null
                  ? 'None: choose one'
                  : "The workspace's default credential",
            },
            ...usable.map((k) => ({ value: k.id, label: credentialLabel(k) })),
          ]}
        />
        {lockedTools ? (
          <p class="muted">
            This grant includes write tools; only an owner can change its tool list. It stays as it is.
          </p>
        ) : (
          <ToolChecklist
            tools={props.tools}
            values={v}
            legend="Tools"
            allLabel="Every tool the workspace enables"
            allHint="Write tools are never included."
            writesAllowed={owner}
            error={errors['tools']}
          />
        )}
        <fieldset class="field" aria-describedby={errors['scopes'] ? 'scopes-error' : undefined}>
          <legend>Projects</legend>
          {errors['scopes'] ? (
            <p class="error" id="scopes-error">
              {errors['scopes']}
            </p>
          ) : null}
          <Checkbox
            name="scopes_all"
            id="scopes-all"
            label="Every project of the workspace"
            checked={v.has('scopes_all')}
          />
          {workspace.allowedScopeIds.map((s) => (
            <Checkbox
              name="scopes"
              id={`scope-${s}`}
              value={s}
              label={<code>{s}</code>}
              checked={v.getAll('scopes').includes(s)}
            />
          ))}
        </fieldset>
        <AssetTypeFields values={v} errors={errors} />
        <LimitsFields
          values={v}
          errors={errors}
          hint="Leave a field blank to inherit the workspace's. A value above the workspace's has no effect."
        />
        <TextField
          name="perMinute"
          label="Requests per minute (optional)"
          hint="1 to 100000. Blank: the server's default."
          type="number"
          inputmode="numeric"
          min={1}
          max={100_000}
          value={v.get('perMinute') ?? ''}
          error={errors['perMinute']}
        />
        <SelectField
          name="expiry"
          label="Expiry"
          value={v.get('expiry') ?? (props.mode === 'create' ? 'never' : 'keep')}
          error={errors['expiry']}
          options={EXPIRY.filter(([k]) => props.mode === 'edit' || k !== 'keep').map(([value, label]) => ({
            value,
            label,
          }))}
        />
        <div class="actions">
          <Button>{props.mode === 'create' ? 'Create grant' : 'Save'}</Button>
          <LinkButton href={props.cancel} variant="secondary">
            Cancel
          </LinkButton>
        </div>
      </Form>
    </Layout>
  );
}

function formFieldOf(apiField: string | undefined): string | undefined {
  if (apiField === undefined) return undefined;
  return (
    limitFieldOf(apiField) ??
    typesFieldOf(apiField) ??
    {
      label: 'label',
      credentialId: 'credential',
      tools: 'tools',
      scopeIds: 'scopes',
      rateLimit: 'perMinute',
      userId: 'who',
      expiresAt: 'expiry',
    }[apiField.split('.')[0] ?? '']
  );
}

/** What a saved grant does not do the way it reads (the API's warnings, recomputed from what is stored). */
export function grantNotes(g: Grant, ws: Workspace): string[] {
  const notes: string[] = [];
  const outside = (g.tools ?? []).filter((t) =>
    ws.enabledTools === null ? false : !ws.enabledTools.includes(t),
  );
  if (outside.length > 0)
    notes.push(`The workspace does not enable ${outside.join(', ')}, so they have no effect here.`);
  for (const [key, value] of Object.entries(g.limits)) {
    const base = ws.limits[key];
    if (typeof value === 'number' && typeof base === 'number' && value > base)
      notes.push(`${key} (${value}) is above the workspace's (${base}); the workspace's applies.`);
    if (value === true && base === false) notes.push(`${key} is off in the workspace.`);
  }
  return notes;
}

export function registerGrants(ui: Hono, kit: UiKit): void {
  const now = () => (kit.deps.now ?? Date.now)();

  const catalogue = async (c: Context, principal: UiPrincipal) => {
    const got = await load(kit, c, principal, '/tools', (b) => rows(b, parseTool));
    return got.ok ? got.value : [];
  };
  const loadGrant = async (c: Context, principal: UiPrincipal, id: string) => {
    const got = await load(kit, c, principal, adminPath`/grants/${id}`, (b) => one(b, parseGrant));
    return got.ok ? got.value : got.result;
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
  const usersOf = async (c: Context, principal: UiPrincipal) => {
    const got = await load(kit, c, principal, '/users', (b) => rows(b, parseUser));
    return got.ok ? got.value : [];
  };

  /** The body a form describes. `current` is the stored grant when editing. */
  const bodyFrom = (
    form: { fields: URLSearchParams },
    principal: UiPrincipal,
    workspace: Workspace,
    tools: readonly Tool[],
    current: Grant | null,
  ): { body: Record<string, unknown> } | { errors: Record<string, string> } => {
    const errors: Record<string, string> = {};
    const body: Record<string, unknown> = {};
    const label = field(form, 'label');
    if (label !== null && label.length > MAX_LABEL) errors['label'] = 'At most 200 characters.';
    else if (current === null ? label !== null : label !== current.label) body['label'] = label;
    const credential = field(form, 'credential');
    if (credential !== null && !isId(credential)) errors['credential'] = 'Choose one of the credentials.';
    else if (current === null ? credential !== null : credential !== current.credentialId)
      body['credentialId'] = credential;

    const locked = !isOwner(principal) && current !== null && hasWriteTools(current.tools, tools);
    if (!locked) {
      const picked = toolsFrom(form, tools);
      if ('error' in picked) errors['tools'] = picked.error;
      // Only a changed list is sent: a list with write tools needs a recent sign-in even when it did not change.
      else if (current === null ? picked.value !== null : !sameList(picked.value, current.tools))
        body['tools'] = picked.value;
    }
    if (form.fields.has('scopes_all')) {
      if (current === null || current.scopeIds !== null) body['scopeIds'] = null;
    } else {
      const ticked = [...new Set(form.fields.getAll('scopes'))].filter((s) =>
        workspace.allowedScopeIds.includes(s),
      );
      if (ticked.length === 0)
        errors['scopes'] = 'Choose at least one project, or every project of the workspace.';
      else if (current === null || !sameList(ticked, current.scopeIds)) body['scopeIds'] = ticked;
    }
    const types = assetTypesFrom(form);
    if ('errors' in types) Object.assign(errors, types.errors);
    else body['assetTypes'] = types.value;
    const limits = limitsFrom(form);
    if ('errors' in limits) Object.assign(errors, limits.errors);
    else body['limits'] = limits.limits;
    const rate = wholeNumber(form, 'perMinute', 1, 100_000);
    if (rate === null) errors['perMinute'] = 'Enter a whole number from 1 to 100000, or leave it blank.';
    else body['rateLimit'] = rate === undefined ? null : { perMinute: rate };
    const expiry = form.fields.get('expiry') ?? (current === null ? 'never' : 'keep');
    if (expiry === 'never') body['expiresAt'] = null;
    else if (/^(30|90|180|365)$/.test(expiry)) body['expiresAt'] = now() + Number(expiry) * DAY;
    else if (expiry !== 'keep' || current === null) errors['expiry'] = 'Choose one of the options.';
    return Object.keys(errors).length > 0 ? { errors } : { body };
  };

  ui.get(
    ROUTE,
    kit.page('admin', async (c, page) => {
      const { principal } = page;
      const wanted = c.req.query('workspace');
      const workspaceId = isId(wanted) ? wanted : undefined;
      const got = await load(
        kit,
        c,
        principal,
        '/grants',
        (b) => rows(b, parseGrant),
        workspaceId === undefined ? undefined : { workspaceId },
      );
      if (!got.ok) return loadFailed(c, got.result, principal);
      const [workspaces, users] = await Promise.all([
        load(kit, c, principal, '/workspaces', (b) => rows(b, parseWorkspace)),
        usersOf(c, principal),
      ]);
      const wsList = workspaces.ok ? workspaces.value : [];
      const names = new Map(wsList.map((w) => [w.id, w.name]));
      const emails = new Map(users.map((u) => [u.id, u]));
      const list = paged(got.value, c.req.query('page'), GRANTS, { workspace: workspaceId });
      const t = now();
      return page.html(
        <Screen page={page} title="Grants" current={GRANTS}>
          <p>
            A grant lets one person, or one service, use one workspace with a given Agility credential and
            limits. Device tokens belong to grants.
          </p>
          <div class="actions page-actions">
            <LinkButton href={withQuery(`${GRANTS}/new`, { workspace: workspaceId })}>New grant</LinkButton>
          </div>
          <QueryForm action={GRANTS} label="Filter grants">
            <SelectField
              name="workspace"
              label="Workspace"
              value={workspaceId ?? ''}
              options={[
                { value: '', label: 'All workspaces' },
                ...wsList.map((w) => ({ value: w.id, label: w.name })),
              ]}
            />
            <Button variant="secondary">Filter</Button>
          </QueryForm>
          <DataTable
            caption="Grants"
            empty="No grants yet."
            rows={list.rows}
            columns={[
              {
                header: 'Who',
                cell: (g) => (
                  <a href={adminPath`/admin/grants/${g.id}`}>
                    {g.userId === null
                      ? `service: ${g.label ?? 'unnamed'}`
                      : emails.get(g.userId) === undefined
                        ? 'unknown person'
                        : personText(emails.get(g.userId) as User)}
                  </a>
                ),
              },
              { header: 'Workspace', cell: (g) => names.get(g.workspaceId) ?? 'unknown' },
              { header: 'Status', cell: (g) => <StatusBadge {...lifecycle(g, t)} /> },
              { header: 'Expires', cell: (g) => <When at={g.expiresAt} none="never" /> },
            ]}
          />
          <Pager label="Grant pages" prev={list.prev} next={list.next} />
        </Screen>,
      );
    }),
  );

  ui.get(
    `${ROUTE}/new`,
    kit.page('admin', async (c, page) => {
      const { principal } = page;
      const workspaces = await load(kit, c, principal, '/workspaces', (b) => rows(b, parseWorkspace));
      if (!workspaces.ok) return loadFailed(c, workspaces.result, principal);
      const live = workspaces.value.filter((w) => w.disabledAt === null);
      const picked = c.req.query('workspace');
      const workspace = isId(picked) ? live.find((w) => w.id === picked) : undefined;
      if (workspace === undefined) {
        return page.html(
          <Screen page={page} title="New grant" current={GRANTS}>
            <p>Step 1 of 2: the workspace the grant is for.</p>
            {live.length === 0 ? (
              <p class="card">
                There is no workspace yet. <a href="/admin/workspaces/new">Create one</a> first.
              </p>
            ) : (
              <QueryForm action={`${GRANTS}/new`} label="Choose the workspace">
                <SelectField
                  name="workspace"
                  label="Workspace"
                  options={live.map((w) => ({ value: w.id, label: w.name }))}
                />
                <div class="actions">
                  <Button>Next</Button>
                  <LinkButton href={GRANTS} variant="secondary">
                    Cancel
                  </LinkButton>
                </div>
              </QueryForm>
            )}
          </Screen>,
        );
      }
      const [tools, creds, users] = await Promise.all([
        catalogue(c, principal),
        credentialsOf(c, principal, workspace.instanceId),
        usersOf(c, principal),
      ]);
      return page.html(
        <GrantForm
          viewer={principal}
          mode="create"
          action={GRANTS}
          cancel={withQuery(GRANTS, { workspace: workspace.id })}
          workspace={workspace}
          values={new URLSearchParams({ tools_all: '1', scopes_all: '1', expiry: 'never' })}
          errors={{}}
          tools={tools}
          credentials={creds}
          users={users}
          current={null}
        />,
      );
    }),
  );

  ui.post(
    ROUTE,
    kit.form('admin', async (c, principal, form) => {
      const workspaceId = field(form, 'workspaceId');
      if (!isId(workspaceId)) return kit.redirect(`${GRANTS}/new`, 'not_found');
      const workspace = await loadWorkspace(c, principal, workspaceId);
      if ('status' in workspace) return kit.fail(c, principal, workspace, `${GRANTS}/new`);
      const [tools, creds, users] = await Promise.all([
        catalogue(c, principal),
        credentialsOf(c, principal, workspace.instanceId),
        usersOf(c, principal),
      ]);
      const again = (errors: Record<string, string>, message?: string) =>
        htmlResponse(
          <GrantForm
            viewer={principal}
            mode="create"
            action={GRANTS}
            cancel={withQuery(GRANTS, { workspace: workspaceId })}
            workspace={workspace}
            values={form.fields}
            errors={errors}
            message={message}
            tools={tools}
            credentials={creds}
            users={users}
            current={null}
          />,
          422,
        );
      const who = field(form, 'who');
      const errors: Record<string, string> = {};
      if (who !== null && !isId(who)) errors['who'] = 'Choose a person from the list.';
      const label = field(form, 'label');
      if (who === null && label === null) errors['label'] = 'A service grant needs a name.';
      const built = bodyFrom(form, principal, workspace, tools, null);
      if ('errors' in built) Object.assign(errors, built.errors);
      if (Object.keys(errors).length > 0 || 'errors' in built) return again(errors);
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'POST', path: '/grants', body: { ...built.body, workspaceId, userId: who } },
        form,
      );
      if (isOk(res)) {
        const created = one((res.body as { record?: unknown } | null)?.record, parseGrant);
        return kit.redirect(created === null ? GRANTS : adminPath`/admin/grants/${created.id}`, 'created');
      }
      const problem = problemOf(res);
      if (problem.status === 422 || problem.status === 409) {
        const shown = formErrors(problem, formFieldOf);
        return again(shown.errors, shown.message);
      }
      return kit.fail(c, principal, res, `${GRANTS}/new?workspace=${encodeURIComponent(workspaceId)}`);
    }),
  );

  ui.get(
    `${ROUTE}/:id`,
    kit.page('admin', async (c, page) => {
      const { principal } = page;
      const id = c.req.param('id');
      if (!isId(id)) return errorPage(404, undefined, principal);
      const g = await loadGrant(c, principal, id);
      if ('status' in g) return loadFailed(c, g, principal);
      const ws = await loadWorkspace(c, principal, g.workspaceId);
      const [tokens, users, creds] = await Promise.all([
        load(kit, c, principal, adminPath`/grants/${id}/tokens`, (b) => rows(b, parseToken)),
        usersOf(c, principal),
        'status' in ws ? Promise.resolve([] as Credential[]) : credentialsOf(c, principal, ws.instanceId),
      ]);
      const person = users.find((u) => u.id === g.userId);
      const credential = creds.find((k) => k.id === g.credentialId);
      const t = now();
      const self = adminPath`/admin/grants/${id}`;
      const status = lifecycle(g, t);
      const issuable = canIssueOn(g, credential, principal, t);
      return page.html(
        <Screen
          page={page}
          title={g.userId === null ? `Service: ${g.label ?? 'unnamed'}` : 'Grant'}
          current={GRANTS}
        >
          <section class="card" aria-labelledby="facts-heading">
            <h2 id="facts-heading">Grant</h2>
            <Facts
              items={[
                [
                  'Who',
                  g.userId === null
                    ? `a service (${g.label ?? 'unnamed'})`
                    : person === undefined
                      ? 'unknown person'
                      : personText(person),
                ],
                ['Name', g.label ?? '—'],
                [
                  'Workspace',
                  'status' in ws ? 'unknown' : <a href={adminPath`/admin/workspaces/${ws.id}`}>{ws.name}</a>,
                ],
                [
                  'Credential',
                  g.credentialId === null ? (
                    "the workspace's default"
                  ) : credential === undefined ? (
                    'unknown'
                  ) : (
                    <a href={adminPath`/admin/credentials/${credential.id}`}>
                      {credential.label}
                      {credential.ownerUserId === null ? ' (shared)' : ' (personal)'}
                    </a>
                  ),
                ],
                ['Status', <StatusBadge {...status} />],
                [
                  'Tools',
                  g.tools === null ? 'every tool the workspace enables' : g.tools.join(', ') || 'none',
                ],
                ['Projects', g.scopeIds === null ? 'every project of the workspace' : g.scopeIds.join(', ')],
                [
                  'Asset types',
                  g.assetTypes === null || (g.assetTypes.allow === null && g.assetTypes.deny === null)
                    ? 'as the workspace'
                    : [
                        g.assetTypes.allow === null ? '' : `only ${g.assetTypes.allow.join(', ')}`,
                        g.assetTypes.deny === null ? '' : `never ${g.assetTypes.deny.join(', ')}`,
                      ]
                        .filter((s) => s !== '')
                        .join('; '),
                ],
                ['Limits', limitsSummary(g.limits).join('; ') || 'inherited from the workspace'],
                ['Rate', g.perMinute === null ? "the server's default" : `${g.perMinute} requests a minute`],
                ['Expires', <When at={g.expiresAt} none="never" />],
                ['Created', <When at={g.createdAt} />],
              ]}
            />
            {'status' in ws ? null : <Notes title="Notes" items={grantNotes(g, ws)} />}
            <div class="actions">
              <LinkButton href={`${self}/edit`}>Edit</LinkButton>
            </div>
          </section>
          <section aria-labelledby="tokens-heading">
            <h2 id="tokens-heading">Device tokens</h2>
            <div class="actions page-actions">
              {issuable ? (
                <LinkButton href={`${self}/tokens/new`}>New device token</LinkButton>
              ) : (
                <p class="muted">
                  {g.revokedAt !== null || (g.expiresAt !== null && g.expiresAt <= t)
                    ? 'A revoked or expired grant cannot get new device tokens.'
                    : "Only the person this grant's personal Agility token belongs to can issue device tokens on it."}
                </p>
              )}
            </div>
            {tokens.ok ? (
              <TokenTable viewer={principal} grantId={id} tokens={tokens.value} now={t} />
            ) : (
              <p class="flash flash-error" role="alert">
                The device tokens could not be loaded.
              </p>
            )}
          </section>
          <section class="card" aria-labelledby="end-heading">
            <h2 id="end-heading">Revoke or delete</h2>
            <div class="actions">
              {g.revokedAt === null ? (
                <RowAction
                  action={`${self}/revoke`}
                  csrf={principal.csrf}
                  label="Revoke…"
                  name="Revoke this grant"
                />
              ) : null}
              <RowAction
                action={`${self}/delete`}
                csrf={principal.csrf}
                label="Delete…"
                name="Delete this grant"
              />
            </div>
            <p class="hint">
              Revoking stops the grant and every token on it at once. Deleting also removes the tokens'
              records.
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
      const g = await loadGrant(c, principal, id);
      if ('status' in g) return loadFailed(c, g, principal);
      const ws = await loadWorkspace(c, principal, g.workspaceId);
      if ('status' in ws) return loadFailed(c, ws, principal);
      const [tools, creds, users] = await Promise.all([
        catalogue(c, principal),
        credentialsOf(c, principal, ws.instanceId),
        usersOf(c, principal),
      ]);
      return page.html(
        <GrantForm
          viewer={principal}
          mode="edit"
          action={`${adminPath`/admin/grants/${id}`}/edit`}
          cancel={adminPath`/admin/grants/${id}`}
          workspace={ws}
          values={grantValues(g)}
          errors={{}}
          tools={tools}
          credentials={creds}
          users={users}
          current={g}
        />,
      );
    }),
  );

  ui.post(
    `${ROUTE}/:id/edit`,
    kit.form('admin', async (c, principal, form) => {
      const id = c.req.param('id');
      if (!isId(id)) return kit.redirect(GRANTS, 'not_found');
      const self = adminPath`/admin/grants/${id}`;
      const g = await loadGrant(c, principal, id);
      if ('status' in g) return kit.fail(c, principal, g, GRANTS);
      const ws = await loadWorkspace(c, principal, g.workspaceId);
      if ('status' in ws) return kit.fail(c, principal, ws, GRANTS);
      const [tools, creds, users] = await Promise.all([
        catalogue(c, principal),
        credentialsOf(c, principal, ws.instanceId),
        usersOf(c, principal),
      ]);
      const again = (errors: Record<string, string>, message?: string) =>
        htmlResponse(
          <GrantForm
            viewer={principal}
            mode="edit"
            action={`${self}/edit`}
            cancel={self}
            workspace={ws}
            values={form.fields}
            errors={errors}
            message={message}
            tools={tools}
            credentials={creds}
            users={users}
            current={g}
          />,
          422,
        );
      const built = bodyFrom(form, principal, ws, tools, g);
      if ('errors' in built) return again(built.errors);
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'PATCH', path: adminPath`/grants/${id}`, body: built.body },
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

  for (const action of ['revoke', 'delete'] as const) {
    ui.post(
      `${ROUTE}/:id/${action}`,
      kit.form('admin', async (c, principal, form) => {
        const id = c.req.param('id');
        if (!isId(id)) return kit.redirect(GRANTS, 'not_found');
        const self = adminPath`/admin/grants/${id}`;
        if (!confirmed(form)) {
          const g = await loadGrant(c, principal, id);
          if ('status' in g) return kit.fail(c, principal, g, GRANTS);
          return confirmPage({
            viewer: principal,
            current: GRANTS,
            title: action === 'revoke' ? 'Revoke this grant?' : 'Delete this grant?',
            paragraphs:
              action === 'revoke'
                ? [
                    'The grant and every device token on it stop working at once. A revoked grant cannot be restored.',
                    'Make a new grant if the person needs access again.',
                  ]
                : [
                    'The grant and the records of its device tokens are removed. Devices using them stop working at once.',
                    'Deleting cannot be undone.',
                  ],
            action: `${self}/${action}`,
            confirm: action === 'revoke' ? 'Revoke the grant' : 'Delete the grant',
            cancel: self,
          });
        }
        const res =
          action === 'revoke'
            ? await kit.callAdmin(
                c,
                principal,
                { method: 'POST', path: adminPath`/grants/${id}/revoke` },
                form,
              )
            : await kit.callAdmin(c, principal, { method: 'DELETE', path: adminPath`/grants/${id}` }, form);
        if (!isOk(res)) return kit.fail(c, principal, res, self);
        return kit.redirect(action === 'revoke' ? self : GRANTS, action === 'revoke' ? 'revoked' : 'deleted');
      }),
    );
  }
}
