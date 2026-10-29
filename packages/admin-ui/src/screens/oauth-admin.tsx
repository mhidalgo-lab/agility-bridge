// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// Connected apps of everyone and registered OAuth clients (P5-08, THREAT_MODEL T15). "My access" (P5-04) lists a person's
// own apps; here owners and admins see every person's, and owners see the clients themselves.
//
//   GET  /admin/oauth/devices?after=              every person's connected apps (owner, admin)
//   POST /admin/oauth/devices/:id/revoke          disconnect one (owner: anyone's; admin: a member's), CSRF
//   GET  /admin/oauth/clients?after=              registered clients and revoked ones (owner)
//   POST /admin/oauth/clients/revoke              revoke a client and end its devices (confirmation, CSRF)
//   POST /admin/oauth/clients/restore             lift the revocation of a metadata-document client
//
// Every change is a POST through the panel's form checks (session, CSRF, `Origin`, fetch metadata, L-090); the admin API
// decides who may. Everything an app or a person typed (client names, device labels, display names) is untrusted: it is
// escaped by the JSX and shown as plain text, never as a link, and the page says the name is not verified.
import type { Hono } from 'hono';
import { Badge, ConfirmAction, DataTable, Form, Pager } from '../components.tsx';
import { adminPath, requestIdOf, type UiKit } from '../kit.ts';
import { errorPage } from '../pages.tsx';
import { OAUTH_DEVICE_ID_RE, rows } from './data.ts';
import { isOk, load, Screen, When, WriteScope, withQuery } from './shared.tsx';

export const OAUTH_DEVICES = '/admin/oauth/devices';
export const OAUTH_CLIENTS = '/admin/oauth/clients';

type Row = Readonly<Record<string, unknown>>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const int = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) ? v : 0);
const intOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) ? v : null;
const obj = (v: unknown): Row => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Row) : {});

/** A page cursor of the devices list: `<user id>:<device id>`. */
export const OAUTH_DEVICE_CURSOR_RE: RegExp = /^[A-Za-z0-9_-]{1,128}:[A-Za-z0-9_-]{16}$/;
/** A client id (and the cursor of the clients list): printable ASCII, at most 512 characters. */
export const OAUTH_CLIENT_ID_RE: RegExp = /^[\x21-\x7e]{1,512}$/;

/** A device of any person (`GET /oauth/devices`). Names and the app's text are untrusted. */
export interface OAuthAdminDevice {
  readonly id: string;
  readonly userId: string;
  readonly userEmail: string | null;
  readonly userName: string | null;
  readonly userRole: 'owner' | 'admin' | 'member' | null;
  readonly clientName: string | null;
  readonly redirectHost: string;
  /** The app holds `mcp:write`: it can ask for changes (P7-32). */
  readonly canWrite: boolean;
  readonly workspaceName: string | null;
  readonly workspaceSlug: string | null;
  readonly label: string | null;
  readonly createdAt: number;
  readonly expiresAt: number | null;
}

export function parseOAuthAdminDevicePage(
  body: unknown,
): { readonly data: readonly OAuthAdminDevice[]; readonly next: string | null } | null {
  const b = obj(body);
  const list = rows(b['data'], (r): OAuthAdminDevice | null => {
    const id = str(r['id']);
    const userId = str(r['userId']);
    if (!OAUTH_DEVICE_ID_RE.test(id) || userId === '') return null;
    const role = r['userRole'];
    return {
      id,
      userId,
      userEmail: strOrNull(r['userEmail']),
      userName: strOrNull(r['userName']),
      userRole: role === 'owner' || role === 'admin' || role === 'member' ? role : null,
      clientName: strOrNull(r['clientName']),
      redirectHost: str(r['redirectHost']),
      canWrite: r['canWrite'] === true,
      workspaceName: strOrNull(r['workspaceName']),
      workspaceSlug: strOrNull(r['workspaceSlug']),
      label: strOrNull(r['label']),
      createdAt: int(r['createdAt']),
      expiresAt: intOrNull(r['expiresAt']),
    };
  });
  if (list === null) return null;
  const next = strOrNull(b['next']);
  return { data: list, next: next !== null && OAUTH_DEVICE_CURSOR_RE.test(next) ? next : null };
}

export interface OAuthClient {
  readonly clientId: string;
  readonly kind: 'dynamic' | 'metadata_document';
  readonly name: string | null;
  readonly redirectHosts: readonly string[];
  readonly createdAt: number | null;
  readonly lastApprovedAt: number | null;
  readonly devices: number | null;
}

export interface OAuthBlockedClient {
  readonly clientId: string;
  readonly kind: 'dynamic' | 'metadata_document';
  readonly name: string | null;
  readonly at: number;
}

export interface OAuthClientPage {
  readonly data: readonly OAuthClient[];
  readonly blocked: readonly OAuthBlockedClient[];
  readonly next: string | null;
  readonly devicesTruncated: boolean;
}

const clientKind = (v: unknown): 'dynamic' | 'metadata_document' =>
  v === 'metadata_document' ? 'metadata_document' : 'dynamic';

export function parseOAuthClientPage(body: unknown): OAuthClientPage | null {
  const b = obj(body);
  const data = rows(b['data'], (r): OAuthClient | null => {
    const clientId = str(r['clientId']);
    if (!OAUTH_CLIENT_ID_RE.test(clientId)) return null;
    return {
      clientId,
      kind: clientKind(r['kind']),
      name: strOrNull(r['name']),
      redirectHosts: Array.isArray(r['redirectHosts'])
        ? r['redirectHosts'].filter((h): h is string => typeof h === 'string')
        : [],
      createdAt: intOrNull(r['createdAt']),
      lastApprovedAt: intOrNull(r['lastApprovedAt']),
      devices: intOrNull(r['devices']),
    };
  });
  const blocked = rows(b['blocked'], (r): OAuthBlockedClient | null => {
    const clientId = str(r['clientId']);
    if (!OAUTH_CLIENT_ID_RE.test(clientId)) return null;
    return { clientId, kind: clientKind(r['kind']), name: strOrNull(r['name']), at: int(r['at']) };
  });
  if (data === null || blocked === null) return null;
  const next = strOrNull(b['next']);
  return {
    data,
    blocked,
    next: next !== null && OAUTH_CLIENT_ID_RE.test(next) ? next : null,
    devicesTruncated: b['devicesTruncated'] === true,
  };
}

/** One kind of limit refusal in the last day (`GET /oauth/abuse`): reasons and counts only, never an address or a client. */
export interface OAuthRefusalCount {
  readonly action: string;
  readonly reason: string;
  readonly surface: string | null;
  readonly scope: string | null;
  readonly kind: string | null;
  readonly count: number;
  readonly lastAt: number;
}

export interface OAuthAbuse {
  readonly dynamic: { readonly enabled: boolean; readonly live: number; readonly cap: number };
  readonly documents: { readonly enabled: boolean; readonly stored: number; readonly cap: number };
  readonly limits: readonly (readonly [string, number])[];
  readonly windowHours: number;
  readonly refusals: readonly OAuthRefusalCount[];
  readonly truncated: boolean;
}

export function parseOAuthAbuse(body: unknown): OAuthAbuse | null {
  const b = obj(body);
  const reg = obj(b['registrations']);
  const dyn = obj(reg['dynamic']);
  const doc = obj(reg['documents']);
  const refusals = rows(b['refusals'], (r): OAuthRefusalCount | null => ({
    action: str(r['action']),
    reason: str(r['reason']),
    surface: strOrNull(r['surface']),
    scope: strOrNull(r['scope']),
    kind: strOrNull(r['kind']),
    count: int(r['count']),
    lastAt: int(r['lastAt']),
  }));
  if (refusals === null || Object.keys(dyn).length === 0 || Object.keys(doc).length === 0) return null;
  return {
    dynamic: { enabled: dyn['enabled'] === true, live: int(dyn['live']), cap: int(dyn['cap']) },
    documents: { enabled: doc['enabled'] === true, stored: int(doc['stored']), cap: int(doc['cap']) },
    limits: Object.entries(obj(b['limits'])).flatMap(([k, v]) =>
      typeof v === 'number' && Number.isSafeInteger(v) ? [[k, v] as const] : [],
    ),
    windowHours: int(b['windowHours']) || 24,
    refusals,
    truncated: b['refusalsTruncated'] === true,
  };
}

const KIND_TEXT = { dynamic: 'Registered by the app', metadata_document: 'Metadata document' } as const;

/** Untrusted text: plain, monospace so it reads as data and long words wrap (L-218). */
const Untrusted = (props: { readonly text: string | null; readonly none: string }) =>
  props.text === null || props.text === '' ? (
    <span class="muted">{props.none}</span>
  ) : (
    <span class="mono">{props.text}</span>
  );

export function registerOAuthAdmin(ui: Hono, kit: UiKit): void {
  // ---- every person's apps ---------------------------------------------------------------------------------------------

  ui.get(
    '/oauth/devices',
    kit.page('admin', async (c, page) => {
      const { principal } = page;
      const wanted = c.req.query('after');
      const after = wanted !== undefined && OAUTH_DEVICE_CURSOR_RE.test(wanted) ? wanted : undefined;
      const got = await load(kit, c, principal, '/oauth/devices', parseOAuthAdminDevicePage, {
        ...(after === undefined ? {} : { after }),
      });
      if (!got.ok) {
        if (got.result.status === 404) return page.html(<OAuthOff page={page} current={OAUTH_DEVICES} />);
        return errorPage(
          [403, 429, 503].includes(got.result.status) ? got.result.status : 500,
          requestIdOf(c),
          principal,
        );
      }
      const result = got.value;
      // An admin may end a member's app; an owner anyone's. The API refuses the rest, the button only keeps the page honest.
      const mayEnd = (d: OAuthAdminDevice): boolean =>
        principal.role === 'owner' ||
        d.userId === principal.userId ||
        (d.userRole === 'member' && principal.role === 'admin');
      return page.html(
        <Screen page={page} title="Connected apps" current={OAUTH_DEVICES}>
          <p>
            Apps people connected with OAuth, on any workspace. Disconnecting one stops its access and refresh
            tokens at once; the person can connect it again. App names are chosen by the apps and are not
            verified.
          </p>
          <DataTable
            caption="Connected apps"
            empty="No app is connected with OAuth."
            rows={result.data}
            columns={[
              {
                header: 'Person',
                cell: (d) => (
                  <>
                    <Untrusted text={d.userName ?? d.userEmail} none="a removed person" />
                    {d.userRole === null ? null : <Badge tone="muted">{d.userRole}</Badge>}
                  </>
                ),
              },
              { header: 'App', cell: (d) => <Untrusted text={d.clientName} none="An unnamed app" /> },
              { header: 'Device', cell: (d) => <Untrusted text={d.label} none="no name" /> },
              {
                header: 'Workspace',
                cell: (d) => <Untrusted text={d.workspaceName ?? d.workspaceSlug} none="unknown" />,
              },
              { header: 'Sends to', cell: (d) => <span class="mono">{d.redirectHost}</span> },
              { header: 'Changes', cell: (d) => <WriteScope canWrite={d.canWrite} /> },
              { header: 'Connected', cell: (d) => <When at={d.createdAt} /> },
              { header: 'Ends', cell: (d) => <When at={d.expiresAt} none="never" /> },
              {
                header: 'Action',
                cell: (d) =>
                  mayEnd(d) ? (
                    <Form
                      action={`/admin/oauth/devices/${encodeURIComponent(d.id)}/revoke`}
                      csrf={principal.csrf}
                    >
                      <input type="hidden" name="userId" value={d.userId} />
                      <button
                        type="submit"
                        class="button button-secondary button-small"
                        aria-label={`Disconnect ${d.clientName ?? 'an unnamed app'} of ${d.userEmail ?? 'a removed person'}`}
                      >
                        Disconnect
                      </button>
                    </Form>
                  ) : (
                    '—'
                  ),
              },
            ]}
          />
          <Pager
            label="Connected app pages"
            next={result.next === null ? null : withQuery(OAUTH_DEVICES, { after: result.next })}
          />
        </Screen>,
      );
    }),
  );

  ui.post(
    '/oauth/devices/:id/revoke',
    kit.form('admin', async (c, principal, form) => {
      const id = c.req.param('id');
      const userId = form.fields.get('userId') ?? '';
      if (id === undefined || !OAUTH_DEVICE_ID_RE.test(id) || userId === '' || userId.length > 128) {
        return kit.redirect(OAUTH_DEVICES, 'not_found');
      }
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'POST', path: adminPath`/oauth/devices/${id}/revoke`, body: { userId } },
        form,
      );
      return isOk(res) ? kit.redirect(OAUTH_DEVICES, 'revoked') : kit.fail(c, principal, res, OAUTH_DEVICES);
    }),
  );

  // ---- registered clients ----------------------------------------------------------------------------------------------

  ui.get(
    '/oauth/clients',
    kit.page('owner', async (c, page) => {
      const { principal } = page;
      const wanted = c.req.query('after');
      const after = wanted !== undefined && OAUTH_CLIENT_ID_RE.test(wanted) ? wanted : undefined;
      const got = await load(kit, c, principal, '/oauth/clients', parseOAuthClientPage, {
        ...(after === undefined ? {} : { after }),
      });
      if (!got.ok) {
        if (got.result.status === 404) return page.html(<OAuthOff page={page} current={OAUTH_CLIENTS} />);
        return errorPage(
          [403, 429, 503].includes(got.result.status) ? got.result.status : 500,
          requestIdOf(c),
          principal,
        );
      }
      const result = got.value;
      // The limits panel is extra: when it cannot be loaded the apps are still shown.
      const abuse = await load(kit, c, principal, '/oauth/abuse', parseOAuthAbuse);
      return page.html(
        <Screen page={page} title="OAuth apps" current={OAUTH_CLIENTS}>
          <p>
            Apps that registered themselves to connect with OAuth: by registering with this server, or by
            publishing a metadata document. Anyone can register, so a name is only what the app calls itself
            and is not verified: judge an app by where it sends people (its redirect addresses). Revoking an
            app ends every device of it at once and refuses it from then on.
          </p>
          <DataTable
            caption="Registered OAuth apps"
            empty="No app is registered."
            rows={result.data}
            columns={[
              {
                header: 'Name (not verified)',
                cell: (k) => <Untrusted text={k.name} none="An unnamed app" />,
              },
              { header: 'Kind', cell: (k) => KIND_TEXT[k.kind] },
              {
                header: 'Sends to',
                cell: (k) =>
                  k.redirectHosts.length === 0 ? (
                    <span class="muted">unknown</span>
                  ) : (
                    <span class="mono">{k.redirectHosts.join(', ')}</span>
                  ),
              },
              { header: 'Registered', cell: (k) => <When at={k.createdAt} none="unknown" /> },
              { header: 'Last approved', cell: (k) => <When at={k.lastApprovedAt} none="never" /> },
              {
                header: 'Devices',
                cell: (k) =>
                  k.devices === null
                    ? 'unknown'
                    : result.devicesTruncated
                      ? `at least ${k.devices}`
                      : String(k.devices),
              },
              {
                header: 'Action',
                cell: (k) => (
                  <ConfirmAction
                    action="/admin/oauth/clients/revoke"
                    csrf={principal.csrf}
                    summary={`Revoke ${k.name ?? 'an unnamed app'}…`}
                    confirm="Revoke this app"
                  >
                    <input type="hidden" name="clientId" value={k.clientId} />
                    <p class="hint">
                      Ends every device of this app now. A dynamic registration is deleted, and a new
                      registration is a new app.
                    </p>
                  </ConfirmAction>
                ),
              },
            ]}
          />
          {result.devicesTruncated ? (
            <p class="hint">
              Devices are counted among the first one hundred on the server; the counts are lower bounds.
            </p>
          ) : null}
          <Pager
            label="Registered app pages"
            next={result.next === null ? null : withQuery(OAUTH_CLIENTS, { after: result.next })}
          />
          {abuse.ok ? (
            <section aria-labelledby="abuse-heading">
              <h2 id="abuse-heading">Limits and caps</h2>
              <DataTable
                caption="Registration caps"
                empty="None."
                rows={[
                  {
                    name: 'Apps that registered themselves',
                    on: abuse.value.dynamic.enabled,
                    used: abuse.value.dynamic.live,
                    cap: abuse.value.dynamic.cap,
                  },
                  {
                    name: 'Apps known by a metadata document',
                    on: abuse.value.documents.enabled,
                    used: abuse.value.documents.stored,
                    cap: abuse.value.documents.cap,
                  },
                ]}
                columns={[
                  { header: 'Kind', cell: (r) => r.name },
                  { header: 'Switched on', cell: (r) => (r.on ? 'yes' : 'no') },
                  { header: 'In use', cell: (r) => `${r.used} of ${r.cap}` },
                ]}
              />
              <DataTable
                caption={`Refusals in the last ${abuse.value.windowHours} hours`}
                empty="No limit was reached."
                rows={abuse.value.refusals}
                columns={[
                  { header: 'Limit', cell: (r) => <span class="mono">{r.reason}</span> },
                  {
                    header: 'Where',
                    cell: (r) =>
                      [r.surface, r.scope, r.kind].filter((x) => x !== null).join(' / ') || (
                        <span class="muted">n/a</span>
                      ),
                  },
                  { header: 'Windows', cell: (r) => String(r.count) },
                  { header: 'Last', cell: (r) => <When at={r.lastAt} /> },
                ]}
              />
              <p class="hint">
                A limit is recorded once for each period it is reached in, so a count is the number of
                periods, not of requests.
                {abuse.value.truncated ? ' More rows exist than were read: the counts are lower bounds.' : ''}{' '}
                A limit that real people reach is raised in the server settings; one a flood reaches is turned
                off or blocked in front of the server. The limits in force:{' '}
                <span class="mono">{abuse.value.limits.map(([k, v]) => `${k}=${v}`).join(', ')}</span>.
              </p>
            </section>
          ) : null}
          {result.blocked.length === 0 ? null : (
            <section aria-labelledby="blocked-heading">
              <h2 id="blocked-heading">Revoked apps</h2>
              <DataTable
                caption="Revoked OAuth apps"
                empty="None."
                rows={result.blocked}
                columns={[
                  {
                    header: 'Name (not verified)',
                    cell: (k) => <Untrusted text={k.name} none="An unnamed app" />,
                  },
                  { header: 'Kind', cell: (k) => KIND_TEXT[k.kind] },
                  { header: 'Revoked', cell: (k) => <When at={k.at} /> },
                  {
                    header: 'Action',
                    cell: (k) =>
                      k.kind === 'metadata_document' ? (
                        <Form action="/admin/oauth/clients/restore" csrf={principal.csrf}>
                          <input type="hidden" name="clientId" value={k.clientId} />
                          <button
                            type="submit"
                            class="button button-secondary button-small"
                            aria-label={`Allow ${k.name ?? 'an unnamed app'} again`}
                          >
                            Allow again
                          </button>
                        </Form>
                      ) : (
                        <span class="muted">Deleted</span>
                      ),
                  },
                ]}
              />
            </section>
          )}
        </Screen>,
      );
    }),
  );

  ui.post(
    '/oauth/clients/revoke',
    kit.form('owner', async (c, principal, form) => {
      const clientId = form.fields.get('clientId') ?? '';
      if (!OAUTH_CLIENT_ID_RE.test(clientId)) return kit.redirect(OAUTH_CLIENTS, 'not_found');
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'POST', path: '/oauth/clients/revoke', body: { clientId } },
        form,
      );
      return isOk(res) ? kit.redirect(OAUTH_CLIENTS, 'revoked') : kit.fail(c, principal, res, OAUTH_CLIENTS);
    }),
  );

  ui.post(
    '/oauth/clients/restore',
    kit.form('owner', async (c, principal, form) => {
      const clientId = form.fields.get('clientId') ?? '';
      if (!OAUTH_CLIENT_ID_RE.test(clientId)) return kit.redirect(OAUTH_CLIENTS, 'not_found');
      const res = await kit.callAdmin(
        c,
        principal,
        { method: 'POST', path: '/oauth/clients/restore', body: { clientId } },
        form,
      );
      return isOk(res) ? kit.redirect(OAUTH_CLIENTS, 'saved') : kit.fail(c, principal, res, OAUTH_CLIENTS);
    }),
  );
}

function OAuthOff(props: { readonly page: Parameters<typeof Screen>[0]['page']; readonly current: string }) {
  return (
    <Screen page={props.page} title="OAuth is off" current={props.current}>
      <p>
        OAuth is not turned on for this server, so no app can connect with it. Turn it on with{' '}
        <code>AB_OAUTH=on</code> (see the admin guide).
      </p>
    </Screen>
  );
}
