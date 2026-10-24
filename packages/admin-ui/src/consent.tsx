// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// The OAuth consent screen (P5-04, THREAT_MODEL T9/T10/T13). A pure view: the HTTP app
// (`packages/http-app/src/oauth/consent.ts`) decides what it shows. Phishing resistance: the client's name is shown as
// untrusted text and always marked unverified (registration is open to anyone), and where the answer goes (the redirect
// host) is as prominent as the name. Everything here is rendered escaped; nothing is inline script or style.
import type { JSX } from 'hono/jsx/jsx-runtime';
import { Badge, Facts, Form, Layout, TextField, Time, type UiViewer } from './components.tsx';

/** One of the signed-in user's grants on the workspace, as the consent form offers it. */
export interface ConsentGrantOption {
  readonly id: string;
  /** The grant's label, or a fixed fallback. */
  readonly label: string;
  /** Tool names the grant allows (effective access, all read-only). */
  readonly tools: readonly string[];
  /** Agility projects the grant is limited to (effective access). */
  readonly projectCount: number;
  /** Epoch ms, or null. */
  readonly expiresAt: number | null;
}

/** Who is asking and where the answer goes (from the validated authorization request). */
export interface ConsentClient {
  /** Untrusted display text; null when the client gave none. */
  readonly name: string | null;
  /** Host (and port) of the redirect URI: where the authorization code is sent. */
  readonly redirectHost: string;
  /** The redirect goes to this computer (`localhost`, `127.0.0.1`, `[::1]`). */
  readonly loopback: boolean;
}

export interface ConsentPageProps {
  readonly viewer: UiViewer;
  /** Same-origin path the form posts to (carries the authorization request's query). */
  readonly action: string;
  /** The single-use handle bound to this exact request, posted back as {@link CONSENT_FIELDS.handle}. */
  readonly handle: string;
  readonly client: ConsentClient;
  readonly workspace: { readonly slug: string; readonly name: string | null };
  readonly grants: readonly ConsentGrantOption[];
  /** The client asked for a refresh token (stays connected until disconnected or expired). */
  readonly offline: boolean;
  /** Pre-selected grant id. */
  readonly selected?: string | undefined;
  /** Device name field value. */
  readonly label?: string | undefined;
  /** A fixed message about the last submission. */
  readonly error?: string | undefined;
  /** Same-origin path of the connected-apps list. */
  readonly devicesHref: string;
}

/** Field names of the consent form. */
export const CONSENT_FIELDS: {
  readonly decision: 'decision';
  readonly grant: 'grant';
  readonly label: 'label';
  readonly handle: 'handle';
} = Object.freeze({ decision: 'decision', grant: 'grant', label: 'label', handle: 'handle' } as const);

/** Longest device name the form accepts. */
export const CONSENT_LABEL_MAX = 60;

function ClientIdentity(props: { readonly client: ConsentClient }): JSX.Element {
  const { client } = props;
  return (
    <section class="card" aria-labelledby="consent-who">
      <h2 id="consent-who">Who is asking</h2>
      <p class="consent-client">{client.name ?? 'An unnamed app'}</p>
      <p>
        <Badge tone="error">not verified</Badge> Anyone can register an app with any name. Continue only if
        you started connecting this app yourself, just now.
      </p>
      <Facts items={[['Sends you back to', <strong class="consent-host">{client.redirectHost}</strong>]]} />
      {client.loopback ? (
        <p class="flash flash-error">
          This address is a program on the computer that opened this page, not a website. Allow only if you
          just started it (for example a command-line tool) on this device.
        </p>
      ) : null}
    </section>
  );
}

function GrantChoice(props: {
  readonly grants: readonly ConsentGrantOption[];
  readonly selected?: string | undefined;
}): JSX.Element {
  const only = props.grants.length === 1;
  return (
    <fieldset class="field">
      <legend>Access to give</legend>
      <p class="hint">
        Read-only tools. The app acts as you, with exactly this access, and loses it when the access is
        revoked, expires or you disconnect the app.
      </p>
      {props.grants.map((g, i) => {
        const id = `grant-${i}`;
        const checked = props.selected === undefined ? only || i === 0 : props.selected === g.id;
        return (
          <div class="check grant-option">
            <input
              type="radio"
              id={id}
              name={CONSENT_FIELDS.grant}
              value={g.id}
              checked={checked}
              required
              aria-describedby={`${id}-hint`}
            />
            <label for={id}>{g.label}</label>
            <span class="hint" id={`${id}-hint`}>
              {`Tools: ${g.tools.join(', ')}. Projects: ${g.projectCount}.`}
              {g.expiresAt === null ? null : (
                <>
                  {' Ends '}
                  <Time at={g.expiresAt} />.
                </>
              )}
            </span>
          </div>
        );
      })}
    </fieldset>
  );
}

/** The consent page: who is asking, where the answer goes, which workspace and which of the user's grants. */
export function ConsentPage(props: ConsentPageProps): JSX.Element {
  const { client, workspace } = props;
  const usable = props.grants.length > 0;
  return (
    <Layout title="Connect an app" viewer={props.viewer}>
      {props.error ? (
        <div class="flash flash-error" role="alert">
          {props.error}
        </div>
      ) : null}
      <ClientIdentity client={client} />
      <section aria-labelledby="consent-what">
        <h2 id="consent-what">What it asks for</h2>
        <Facts
          items={[
            ['Workspace', workspace.name === null ? workspace.slug : `${workspace.name} (${workspace.slug})`],
            [
              'For how long',
              props.offline
                ? 'Until you disconnect it, the access ends or it stops being used'
                : 'About an hour, then the app must ask again',
            ],
          ]}
        />
      </section>
      <Form action={props.action} csrf={props.viewer.csrf} label="Allow or deny the app">
        <input type="hidden" name={CONSENT_FIELDS.handle} value={props.handle} />
        {usable ? (
          <>
            <GrantChoice grants={props.grants} selected={props.selected} />
            <TextField
              name={CONSENT_FIELDS.label}
              label="Device name (optional)"
              hint="Shown in your list of connected apps, for example “Pixel phone – claude.ai”."
              value={props.label}
              maxlength={CONSENT_LABEL_MAX}
              autocomplete="off"
            />
          </>
        ) : (
          <p class="flash flash-info">
            You have no access to this workspace that an app could use. Ask an administrator for access, then
            connect the app again.
          </p>
        )}
        <div class="actions">
          {usable ? (
            <button type="submit" class="button" name={CONSENT_FIELDS.decision} value="approve">
              Allow
            </button>
          ) : null}
          <button type="submit" class="button button-secondary" name={CONSENT_FIELDS.decision} value="deny">
            Deny
          </button>
        </div>
      </Form>
      <p class="hint">
        Apps you allowed are listed, with a way to disconnect each, on{' '}
        <a href={props.devicesHref}>My access</a>.
      </p>
    </Layout>
  );
}
