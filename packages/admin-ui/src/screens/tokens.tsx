// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// Device tokens (P4-04, THREAT_MODEL T8, A5): list on the grant, issue, revoke. A new token is shown exactly once, on the
// answer to the POST that issued it (`Cache-Control: no-store` like every panel page): never in a redirect, a flash, a URL
// or a log. The issue form carries a single-use handle taken before the API call, so a reload, the back button or a replay
// of the one-time page issues nothing (L-073).
//
//   GET  /admin/grants/:id/tokens/new           device name and lifetime form (writes one handle)
//   POST /admin/grants/:id/tokens               issue -> the one-time page
//   POST /admin/grants/:gid/tokens/:id/revoke   revoke (confirmation page first)
//   GET  /admin/grants/:id/connect              the Connect page of the grant: endpoint and client snippets, no token (P4-06)
// The same three routes exist for members under `/admin/me/grants/...` (P4-07): their own grants only, and the grant's
// workspace comes from `GET /me/grants` (members cannot read workspaces). One implementation, two areas.
import type { Context, Hono } from 'hono';
import type { JSX } from 'hono/jsx/jsx-runtime';
import type { UiRole } from '../components.tsx';
import {
  Button,
  DataTable,
  Facts,
  Form,
  Layout,
  LinkButton,
  SecretOnce,
  SelectField,
  TextField,
} from '../components.tsx';
import { adminPath, ONCE_FIELD, type UiKit, type UiPrincipal } from '../kit.ts';
import { errorPage, htmlResponse } from '../pages.tsx';
import { endpointFor, isWorkspaceSlug } from '../snippets.ts';
import { ConnectPage, SnippetList } from './connect.tsx';
import {
  type Credential,
  type Grant,
  isId,
  one,
  parseCredential,
  parseGrant,
  parseMyGrant,
  parseToken,
  parseWorkspace,
  rows,
  type Token,
  type WorkspaceName,
} from './data.ts';
import {
  confirmed,
  confirmPage,
  FormError,
  field,
  formErrors,
  isOk,
  lifecycle,
  load,
  loadFailed,
  Notes,
  problemOf,
  RowAction,
  StatusBadge,
  When,
} from './shared.tsx';

const GRANTS = '/admin/grants';

/** Where a set of token routes lives: owners and admins on any grant, or members on their own. */
interface Area {
  readonly minRole: UiRole;
  /** Route prefix inside the panel (`/grants`, `/me/grants`). */
  readonly rel: string;
  /** The list page the area falls back to. */
  readonly back: string;
  /** Nav entry to highlight. */
  readonly current: string;
  /** Members find the workspace through their own grant list. */
  readonly member: boolean;
}
const ADMIN_AREA: Area = {
  minRole: 'admin',
  rel: '/grants',
  back: GRANTS,
  current: GRANTS,
  member: false,
};
export const MEMBER_AREA: Area = {
  minRole: 'member',
  rel: '/me/grants',
  back: '/admin/me',
  current: '/admin/me',
  member: true,
};
const grantPage = (area: Area, id: string): string => `/admin${area.rel}${adminPath`/${id}`}`;

/** Lifetimes offered (days; `never` is warned about by the API and here). */
export const LIFETIMES = [
  ['30', '30 days'],
  ['90', '90 days (default)'],
  ['180', '180 days'],
  ['365', '1 year'],
  ['never', 'Never expires (not recommended)'],
] as const;

/**
 * May this person issue device tokens on this grant? The admin API refuses it for a grant that names someone else's
 * personal credential (the token would act as that person in Agility, P2-17 review M2), for a revoked or expired one.
 * The panel offers no button in those cases instead of a button that leads to a refusal.
 */
export function canIssueOn(
  grant: Grant,
  credential: Credential | undefined,
  me: UiPrincipal,
  now: number,
): boolean {
  if (grant.revokedAt !== null || (grant.expiresAt !== null && grant.expiresAt <= now)) return false;
  if (grant.credentialId === null) return true;
  // An unknown credential (it failed to load) hides nothing: the API still decides.
  return credential === undefined || credential.ownerUserId === null || credential.ownerUserId === me.userId;
}

/** The tokens of a grant, as a table with a revoke button per live token. */
export function TokenTable(props: {
  readonly viewer: UiPrincipal;
  readonly grantId: string;
  readonly tokens: readonly Token[];
  readonly now: number;
  readonly area?: Area;
}): JSX.Element {
  const area = props.area ?? ADMIN_AREA;
  return (
    <DataTable
      caption="Device tokens"
      empty="No device tokens on this grant."
      rows={props.tokens}
      columns={[
        { header: 'Device', cell: (k) => k.label },
        { header: 'Token', cell: (k) => <code>{`${k.prefix}…`}</code> },
        { header: 'Status', cell: (k) => <StatusBadge {...lifecycle(k, props.now)} /> },
        { header: 'Last used', cell: (k) => <When at={k.lastUsedAt} none="never" /> },
        { header: 'Expires', cell: (k) => <When at={k.expiresAt} none="never" /> },
        {
          header: 'Action',
          cell: (k) =>
            k.revokedAt === null ? (
              <RowAction
                action={`${grantPage(area, props.grantId)}${adminPath`/tokens/${k.id}/revoke`}`}
                csrf={props.viewer.csrf}
                label="Revoke…"
                name={`Revoke ${k.label}`}
              />
            ) : (
              '—'
            ),
        },
      ]}
    />
  );
}

function NewTokenPage(props: {
  readonly viewer: UiPrincipal;
  readonly area: Area;
  readonly grant: Grant;
  readonly workspace: WorkspaceName | null;
  readonly values: { label: string; lifetime: string };
  readonly errors: Readonly<Record<string, string>>;
  readonly once: string;
  readonly message?: string | undefined;
}) {
  const { viewer, grant, values } = props;
  const self = grantPage(props.area, grant.id);
  return (
    <Layout title="New device token" viewer={viewer} current={props.area.current}>
      <p>
        On the grant{' '}
        <a href={self}>{grant.userId === null ? `service: ${grant.label ?? 'unnamed'}` : 'for a person'}</a>
        {props.workspace === null ? '' : ` in ${props.workspace.name}`}. Make one token per device, so a lost
        laptop or phone can be revoked alone.
      </p>
      <FormError message={props.message} />
      <Form action={`${self}/tokens`} csrf={viewer.csrf} label="New device token">
        <input type="hidden" name={ONCE_FIELD} value={props.once} />
        <TextField
          name="label"
          label="Device name"
          hint="For example laptop, work-pc, phone."
          value={values.label}
          required
          maxlength={200}
          error={props.errors['label']}
        />
        <SelectField
          name="lifetime"
          label="Lifetime"
          value={values.lifetime}
          error={props.errors['lifetime']}
          options={LIFETIMES.map(([value, label]) => ({ value, label }))}
        />
        <div class="actions">
          <Button>Create token</Button>
          <LinkButton href={self} variant="secondary">
            Cancel
          </LinkButton>
        </div>
      </Form>
    </Layout>
  );
}

/** The one-time page of a new device token: the token in a box, notes, how to use it. Rendered only as the POST's answer. */
function IssuedTokenPage(props: {
  readonly viewer: UiPrincipal;
  readonly current: string;
  readonly record: Token;
  readonly token: string;
  readonly warnings: readonly string[];
  readonly slug: string | null;
  /** The workspace's MCP endpoint from the configured public origin, or null when it cannot be built. */
  readonly endpoint: string | null;
  readonly done: string;
}) {
  const { record, token } = props;
  return (
    <Layout title="Your new device token" viewer={props.viewer} current={props.current}>
      <div class="flash flash-info" role="status">
        Copy the token now. It is not stored and cannot be shown again: if you lose it, revoke it and create a
        new one.
      </div>
      <section class="card secret" aria-labelledby="token-label">
        <SecretOnce id="token" label={`Token for ${record.label}`} value={token} />
      </section>
      <Notes title="Notes" items={props.warnings} />
      <section aria-labelledby="use-heading">
        <h2 id="use-heading">Use it</h2>
        <Facts
          items={[
            ['MCP endpoint', <code>{props.endpoint ?? '/w/<workspace>/mcp'}</code>],
            ['Header', <code>{'Authorization: Bearer <the token above>'}</code>],
            ['Expires', <When at={record.expiresAt} none="never" />],
          ]}
        />
        <ul>
          <li>Paste the token only into that device's MCP client configuration or its secret store.</li>
          <li>Never paste it into a chat, a ticket, a shared document or a repository.</li>
          <li>This page is shown once: reloading it does not show the token again or create another one.</li>
        </ul>
      </section>
      {props.endpoint === null || props.slug === null ? null : (
        <section aria-labelledby="snippets-heading">
          <h2 id="snippets-heading">Client configuration</h2>
          <p>
            Most snippets read the token from a prompt or an environment variable, so it is not written next
            to the address. A client that has neither (JetBrains) holds it in its file, filled in below.
          </p>
          <SnippetList
            endpoint={props.endpoint}
            slug={props.slug}
            auth={{ kind: 'device-token', token: props.token }}
          />
        </section>
      )}
      <div class="actions">
        <LinkButton href={props.done}>Done</LinkButton>
      </div>
    </Layout>
  );
}

export function registerTokens(ui: Hono, kit: UiKit): void {
  registerTokenRoutes(ui, kit, ADMIN_AREA);
  registerTokenRoutes(ui, kit, MEMBER_AREA);
}

function registerTokenRoutes(ui: Hono, kit: UiKit, area: Area): void {
  const now = () => (kit.deps.now ?? Date.now)();
  const ROUTE = `${area.rel}/:id/tokens`;
  /** The endpoint for a workspace slug: only from the configured public origin, and only for a slug the storage allows. */
  const endpointOf = (slug: string | undefined): string | null =>
    slug === undefined || !isWorkspaceSlug(slug) ? null : endpointFor(kit.deps.publicOrigin, slug);

  /**
   * The grant, or the failed answer. The member area is "mine only", also for owners and admins who could read any grant
   * through the API: a grant of someone else is a 404 here (their own pages are the admin screens).
   */
  const loadGrant = async (c: Context, principal: UiPrincipal, id: string) => {
    const got = await load(kit, c, principal, adminPath`/grants/${id}`, (b) => one(b, parseGrant));
    if (!got.ok) return got.result;
    if (area.member && got.value.userId !== principal.userId)
      return { status: 404, body: { error: { code: 'not_found', message: 'Not found.' } } };
    return got.value;
  };
  const loadWorkspace = async (
    c: Context,
    principal: UiPrincipal,
    id: string,
  ): Promise<WorkspaceName | null> => {
    if (area.member) {
      // Members cannot read workspaces; their own grant list carries the few fields shown here.
      const mine = await load(kit, c, principal, '/me/grants', (b) => rows(b, parseMyGrant));
      return mine.ok ? (mine.value.find((m) => m.workspace?.id === id)?.workspace ?? null) : null;
    }
    const got = await load(kit, c, principal, adminPath`/workspaces/${id}`, (b) => one(b, parseWorkspace));
    return got.ok ? got.value : null;
  };
  const loadCredential = async (c: Context, principal: UiPrincipal, id: string | null) => {
    if (id === null) return undefined;
    const got = await load(kit, c, principal, adminPath`/credentials/${id}`, (b) => one(b, parseCredential));
    return got.ok ? got.value : undefined;
  };

  ui.get(
    `${ROUTE}/new`,
    kit.page(area.minRole, async (c, page) => {
      const { principal } = page;
      const id = c.req.param('id');
      if (!isId(id)) return errorPage(404, undefined, principal);
      const grant = await loadGrant(c, principal, id);
      if ('status' in grant) return loadFailed(c, grant, principal);
      const credential = await loadCredential(c, principal, grant.credentialId);
      if (!canIssueOn(grant, credential, principal, now()))
        return page.html(<NoToken viewer={principal} area={area} grantId={id} />, 409);
      // The handle is written here, for the page that shows the form, and nowhere else (relic-bridge review L6).
      return page.html(
        <NewTokenPage
          viewer={principal}
          area={area}
          grant={grant}
          workspace={await loadWorkspace(c, principal, grant.workspaceId)}
          values={{ label: '', lifetime: '90' }}
          errors={{}}
          once={await kit.issueOnce(principal)}
        />,
      );
    }),
  );

  ui.get(
    `${area.rel}/:id/connect`,
    kit.page(area.minRole, async (c, page) => {
      const { principal } = page;
      const id = c.req.param('id');
      if (!isId(id)) return errorPage(404, undefined, principal);
      const grant = await loadGrant(c, principal, id);
      if ('status' in grant) return loadFailed(c, grant, principal);
      const workspace = await loadWorkspace(c, principal, grant.workspaceId);
      const endpoint = endpointOf(workspace?.slug);
      if (workspace === null || endpoint === null)
        return page.html(
          <Layout title="Connect a client" viewer={principal} current={area.current}>
            <p class="flash flash-error" role="alert">
              The workspace of this grant could not be loaded, so there is no address to show.
            </p>
            <LinkButton href={grantPage(area, id)} variant="secondary">
              Back to the grant
            </LinkButton>
          </Layout>,
          502,
        );
      const credential = await loadCredential(c, principal, grant.credentialId);
      const t = now();
      const usable = grant.revokedAt === null && (grant.expiresAt === null || grant.expiresAt > t);
      return page.html(
        <ConnectPage
          viewer={principal}
          current={area.current}
          endpoint={endpoint}
          slug={workspace.slug}
          workspaceName={workspace.name}
          workspaceDisabled={workspace.disabledAt !== null}
          grantUsable={usable}
          issueHref={canIssueOn(grant, credential, principal, t) ? `${grantPage(area, id)}/tokens/new` : null}
          grantHref={grantPage(area, id)}
        />,
      );
    }),
  );

  ui.post(
    ROUTE,
    kit.form(area.minRole, async (c, principal, form) => {
      const id = c.req.param('id');
      if (!isId(id)) return kit.redirect(area.back, 'not_found');
      const self = grantPage(area, id);
      const grant = await loadGrant(c, principal, id);
      if ('status' in grant) return kit.fail(c, principal, grant, area.back);
      const workspace = await loadWorkspace(c, principal, grant.workspaceId);
      const label = field(form, 'label');
      const lifetime = form.fields.get('lifetime') ?? '90';
      const values = { label: form.fields.get('label') ?? '', lifetime };
      const errors: Record<string, string> = {};
      if (label === null || label.length > 200)
        errors['label'] = 'Enter a device name of up to 200 characters.';
      if (!LIFETIMES.some(([v]) => v === lifetime)) errors['lifetime'] = 'Choose a lifetime from the list.';
      // A form that did not issue anything is shown again with a fresh handle.
      const again = async (errs: Record<string, string>, message?: string, status = 422) =>
        htmlResponse(
          <NewTokenPage
            viewer={principal}
            area={area}
            grant={grant}
            workspace={workspace}
            values={values}
            errors={errs}
            once={await kit.issueOnce(principal)}
            message={message}
          />,
          status,
        );
      if (Object.keys(errors).length > 0) return again(errors);
      // A re-sent form (reload or back button on the one-time page) must not issue another token: the form's single-use
      // handle is taken before the API call. A used, expired, foreign or missing handle issues nothing.
      if (!(await kit.claimOnce(form))) return kit.redirect(self, 'token_form_used');
      const res = await kit.callAdmin(
        c,
        principal,
        {
          method: 'POST',
          path: adminPath`/grants/${id}/tokens`,
          body: { label, expiresInDays: lifetime === 'never' ? 'never' : Number(lifetime) },
        },
        form,
      );
      if (!isOk(res)) {
        const problem = problemOf(res);
        if (problem.status === 422) {
          const shown = formErrors(problem, (f) => (f === 'label' ? 'label' : undefined));
          return again(shown.errors, shown.message);
        }
        if (problem.status === 409 || problem.status === 403 || problem.status === 404)
          return kit.fail(c, principal, res, self);
        return again({}, 'The token could not be created. Nothing was changed; try again.', 503);
      }
      const body = res.body as { token?: unknown; warnings?: unknown } | null;
      const token = typeof body?.token === 'string' ? body.token : null;
      const record = one((body as { record?: unknown } | null)?.record, parseToken);
      if (token === null || record === null) {
        // The API answered without a usable token: say so; the unusable token (if any) is revoked from the grant page.
        return again(
          {},
          'The token could not be shown. Revoke the newest token of this grant and create it again.',
          500,
        );
      }
      const warnings = Array.isArray(body?.warnings)
        ? body.warnings.filter((w): w is string => typeof w === 'string')
        : [];
      // The one place a token is ever rendered. The page is `no-store`; the token is kept nowhere.
      return htmlResponse(
        <IssuedTokenPage
          viewer={principal}
          current={area.current}
          record={record}
          token={token}
          warnings={warnings}
          slug={workspace?.slug ?? null}
          endpoint={endpointOf(workspace?.slug)}
          done={self}
        />,
      );
    }),
  );

  ui.post(
    `${area.rel}/:gid/tokens/:id/revoke`,
    kit.form(area.minRole, async (c, principal, form) => {
      const gid = c.req.param('gid');
      const id = c.req.param('id');
      if (!isId(gid) || !isId(id)) return kit.redirect(area.back, 'not_found');
      const self = grantPage(area, gid);
      if (area.member) {
        // The token must be on a grant of mine, whatever the API would let this role do.
        const grant = await loadGrant(c, principal, gid);
        if ('status' in grant) return kit.fail(c, principal, grant, area.back);
        const list = await load(kit, c, principal, adminPath`/grants/${gid}/tokens`, (b) =>
          rows(b, parseToken),
        );
        if (!list.ok) return kit.fail(c, principal, list.result, area.back);
        if (!list.value.some((k) => k.id === id)) return kit.redirect(self, 'not_found');
      }
      if (!confirmed(form)) {
        const list = await load(kit, c, principal, adminPath`/grants/${gid}/tokens`, (b) =>
          rows(b, parseToken),
        );
        if (!list.ok) return kit.fail(c, principal, list.result, area.back);
        const token = list.value.find((k) => k.id === id);
        if (token === undefined) return kit.redirect(self, 'not_found');
        return confirmPage({
          viewer: principal,
          current: area.current,
          title: `Revoke the token of ${token.label}?`,
          paragraphs: [
            `The device using ${token.prefix}… loses access at once. Other devices keep working.`,
            'A revoked token cannot be restored: the device needs a new token.',
          ],
          action: `${self}${adminPath`/tokens/${id}/revoke`}`,
          confirm: 'Revoke the token',
          cancel: self,
        });
      }
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'POST', path: adminPath`/tokens/${id}/revoke` },
        form,
      );
      return isOk(res) ? kit.redirect(self, 'revoked') : kit.fail(c, principal, res, self);
    }),
  );
}

function NoToken(props: { readonly viewer: UiPrincipal; readonly area: Area; readonly grantId: string }) {
  return (
    <Layout title="No device token here" viewer={props.viewer} current={props.area.current}>
      <p>
        This grant cannot get a new device token: it is revoked or expired, or it uses another person's
        personal Agility token, which only that person can issue device tokens for.
      </p>
      <LinkButton href={grantPage(props.area, props.grantId)} variant="secondary">
        Back to the grant
      </LinkButton>
    </Layout>
  );
}
