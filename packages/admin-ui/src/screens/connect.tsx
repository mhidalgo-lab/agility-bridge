// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// The Connect page and the snippet list (P4-06). The page is a GET on a grant (`/admin/me/grants/:id/connect` for the person
// who holds it, `/admin/grants/:id/connect` for owners and admins): it holds placeholders only, no token. The one-time token
// page (tokens.tsx) renders the same list with the just-issued token where a client has no other way to take it.
// Snippets are text rendered through the JSX auto-escaping, in focusable `<pre>` blocks that are selectable without
// JavaScript; the copy buttons are revealed by the panel's one same-origin script when the clipboard API exists.
import type { JSX } from 'hono/jsx/jsx-runtime';
import { Facts, Layout, LinkButton } from '../components.tsx';
import type { UiPrincipal } from '../kit.ts';
import { clientSnippets, OAUTH_ONLY_CLIENTS, type SnippetAuth } from '../snippets.ts';

export function SnippetList(props: {
  readonly endpoint: string;
  readonly slug: string;
  readonly auth: SnippetAuth;
  readonly idPrefix?: string;
}): JSX.Element {
  const prefix = props.idPrefix ?? 'snippet';
  return (
    <div class="snippets">
      {clientSnippets(props).map((s) => (
        <section class="card snippet" aria-labelledby={`${prefix}-${s.id}-title`}>
          <h3 id={`${prefix}-${s.id}-title`}>{s.client}</h3>
          <p class="muted">{s.where}</p>
          <pre tabindex={0}>
            <code id={`${prefix}-${s.id}`}>{s.body}</code>
          </pre>
          <button
            type="button"
            class="button button-secondary"
            data-copy={`${prefix}-${s.id}`}
            aria-label={`Copy the ${s.client} snippet`}
            hidden
          >
            Copy
          </button>
          {s.notes.length === 0 ? null : (
            <ul class="notes-list">
              {s.notes.map((n) => (
                <li>{n}</li>
              ))}
            </ul>
          )}
        </section>
      ))}
      <section class="card" aria-label="Clients that need OAuth">
        <h3>Needs OAuth</h3>
        <p class="muted">
          {OAUTH_ONLY_CLIENTS.join(', ')}: they cannot take a device token, so they have no snippet. When your
          administrator has turned OAuth on, add the endpoint above as a connector in the app and approve it
          in the browser; if the app cannot connect, ask them whether OAuth is on.
        </p>
      </section>
    </div>
  );
}

export interface ConnectPageProps {
  readonly viewer: UiPrincipal;
  readonly current: string;
  readonly endpoint: string;
  readonly slug: string;
  readonly workspaceName: string;
  readonly workspaceDisabled: boolean;
  readonly grantUsable: boolean;
  /** Link to issue a device token, or null when this grant cannot (or this person may not) issue one. */
  readonly issueHref: string | null;
  readonly grantHref: string;
  readonly title?: string;
}

export function ConnectPage(props: ConnectPageProps): JSX.Element {
  return (
    <Layout title={props.title ?? 'Connect a client'} viewer={props.viewer} current={props.current}>
      <p>
        Configuration for connecting an MCP client on one device to {props.workspaceName}. Each device gets
        its own token, so a lost laptop or phone can be revoked alone.
      </p>
      {props.workspaceDisabled ? (
        <p class="flash flash-error" role="alert">
          This workspace is disabled: clients cannot connect until an administrator enables it again.
        </p>
      ) : null}
      {props.grantUsable ? null : (
        <p class="flash flash-error" role="alert">
          This grant is revoked or expired: a client cannot connect through it.
        </p>
      )}
      <Facts
        items={[
          ['MCP endpoint', <code>{props.endpoint}</code>],
          ['Header', <code>Authorization: Bearer &lt;device token&gt;</code>],
        ]}
      />
      <div class="actions">
        {props.issueHref === null ? null : (
          <LinkButton href={props.issueHref}>Create a device token</LinkButton>
        )}
        <LinkButton href={props.grantHref} variant="secondary">
          Back to the grant
        </LinkButton>
      </div>
      <section aria-labelledby="snippets-heading">
        <h2 id="snippets-heading">Client configuration</h2>
        <ul>
          <li>
            These snippets never contain a token: tokens are stored as hashes and cannot be shown again.
          </li>
          <li>
            Create the token first, paste it only into the device's own client or secret store, never into a
            chat, ticket or repository.
          </li>
          <li>The address must be https: a token sent over plain HTTP can be read on the way.</li>
        </ul>
        <SnippetList endpoint={props.endpoint} slug={props.slug} auth={{ kind: 'device-token' }} />
      </section>
    </Layout>
  );
}
