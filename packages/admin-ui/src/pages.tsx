// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// Whole pages (P4-03): rendering to a complete HTML response with the panel's headers, and the pages every screen and
// the sign-in routes share (sign-in chooser, owner setup, message, error, re-authentication prompt).
import type { Child } from 'hono/jsx';
import type { JSX } from 'hono/jsx/jsx-runtime';
import { Layout, type LayoutProps, localHref } from './components.tsx';
import { UI_CSP_SETUP, UI_PAGE_HEADERS } from './headers.ts';

type HeaderInit = Readonly<Record<string, string>> | readonly (readonly [string, string])[];

/** Render a document synchronously (no async components in the panel) with the doctype. */
export function renderDocument(node: JSX.Element): string {
  const out = (node as unknown as { toString(): string | Promise<string> }).toString();
  if (typeof out !== 'string') throw new TypeError('admin UI components must render synchronously');
  return `<!doctype html>${out}`;
}

/** An HTML response with the panel's CSP and headers (plus `extra`, e.g. `Set-Cookie`). */
export function htmlResponse(node: JSX.Element, status = 200, extra: HeaderInit = {}): Response {
  const headers = new Headers(UI_PAGE_HEADERS);
  for (const [k, v] of Array.isArray(extra) ? extra : Object.entries(extra)) {
    // Only cookies repeat; any other header a page passes replaces the default (a second CSP would be a second policy).
    if (k.toLowerCase() === 'set-cookie') headers.append(k, v);
    else headers.set(k, v);
  }
  return new Response(renderDocument(node), { status, headers });
}

export interface LoginProvider {
  /** Same-origin path that starts this provider's sign-in. */
  readonly href: string;
  readonly label: string;
}

export function LoginPage(props: { readonly providers: readonly LoginProvider[] }): JSX.Element {
  return (
    <Layout title="Sign in">
      {props.providers.length === 0 ? (
        <p>No sign-in provider is configured. Use the admin token with the admin API or the CLI.</p>
      ) : (
        <ul class="providers" aria-label="Sign-in providers">
          {props.providers.map((p) => (
            <li>
              <a class="button" href={localHref(p.href)}>
                {`Continue with ${p.label}`}
              </a>
            </li>
          ))}
        </ul>
      )}
    </Layout>
  );
}

/**
 * The first-owner form. The setup code arrives in the URL fragment, which no server or log ever sees; the panel's
 * script moves it into the field and the browser posts it in the request body. Without the script it can be pasted.
 * No CSRF field: nobody is signed in, and the route checks fetch metadata and `Origin` itself.
 */
export function SetupPage(props: {
  readonly providers: readonly { readonly id: string; readonly label: string }[];
}): JSX.Element {
  return (
    <Layout title="Set up the first owner">
      <p>
        Sign in as the first owner with the single-use setup code from <code>agility-bridge setup-link</code>.
      </p>
      <form method="post" action="/auth/setup" autocomplete="off" aria-label="Owner setup">
        <div class="field">
          <label for="code">Setup code</label>
          <input
            id="code"
            name="code"
            type="password"
            autocomplete="off"
            spellcheck={false}
            required
            size={40}
            maxlength={80}
            data-setup-code
          />
        </div>
        <div class="actions">
          {props.providers.map((p) => (
            <button type="submit" name="provider" value={p.id} class="button">
              {`Continue with ${p.label}`}
            </button>
          ))}
        </div>
      </form>
    </Layout>
  );
}

export interface MessagePageProps extends Pick<LayoutProps, 'viewer'> {
  readonly title: string;
  readonly paragraphs: readonly string[];
  readonly link?: { readonly href: string; readonly label: string } | undefined;
  /** Shown so a person can quote it to whoever reads the logs. Nothing else about a failure is shown. */
  readonly requestId?: string | undefined;
  readonly children?: Child;
}

/** A plain page with a title, a few sentences, an optional link and the request id. */
export function MessagePage(props: MessagePageProps): JSX.Element {
  return (
    <Layout title={props.title} viewer={props.viewer}>
      {props.paragraphs.map((p) => (
        <p>{p}</p>
      ))}
      {props.children}
      {props.link ? (
        <p>
          <a href={localHref(props.link.href)}>{props.link.label}</a>
        </p>
      ) : null}
      {props.requestId ? (
        <p class="muted">
          <small>
            Request id: <code>{props.requestId}</code>
          </small>
        </p>
      ) : null}
    </Layout>
  );
}

const ERROR_TEXT: Readonly<Record<number, { title: string; text: string }>> = {
  403: {
    title: 'Not allowed',
    text: 'You do not have access to this page, or the request did not come from this site.',
  },
  404: { title: 'Page not found', text: 'There is no admin page at this address.' },
  413: { title: 'Request too large', text: 'The form you sent is too large.' },
  415: { title: 'Unsupported request', text: 'Send the form from the admin pages.' },
  429: {
    title: 'Too many requests',
    text: 'Too many requests from this address. Wait a minute, then try again.',
  },
  500: { title: 'Something went wrong', text: 'The page could not be shown. Try again in a moment.' },
  503: { title: 'Unavailable', text: 'The service is unavailable right now. Try again in a moment.' },
};

/** The error page for `status`: fixed text only (no exception message, no stack), plus the request id. */
export function errorPage(
  status: number,
  requestId: string | undefined,
  viewer?: LayoutProps['viewer'],
): Response {
  const known = ERROR_TEXT[status] ?? (ERROR_TEXT[500] as { title: string; text: string });
  return htmlResponse(
    <MessagePage
      title={known.title}
      paragraphs={[known.text]}
      viewer={viewer}
      requestId={requestId}
      link={viewer ? { href: '/admin', label: 'Back to the overview' } : undefined}
    />,
    status,
  );
}

/**
 * The answer to a change that needs a recent sign-in (`403 reauth_required` from the admin API): nothing was changed. The
 * link signs the same person in again and returns to `back` (L-093, L-193); the change is made again from there.
 */
export function reauthPage(
  viewer: NonNullable<LayoutProps['viewer']>,
  back: string,
  requestId: string | undefined,
): Response {
  return htmlResponse(
    <MessagePage
      title="Sign in again to continue"
      viewer={viewer}
      requestId={requestId}
      paragraphs={[
        'This change needs a recent sign-in. Nothing was changed.',
        'Sign in again with the same account, then make the change again.',
      ]}
    >
      <p>
        <a class="button" href={`/auth/reauth?next=${encodeURIComponent(localHref(back))}`}>
          Sign in again
        </a>
      </p>
    </MessagePage>,
    403,
  );
}

/** Convenience for the sign-in routes (no JSX needed in the HTTP app). */
export const loginPageResponse = (providers: readonly LoginProvider[], extra: HeaderInit = {}): Response =>
  htmlResponse(<LoginPage providers={providers} />, 200, extra);

export const setupPageResponse = (
  providers: readonly { readonly id: string; readonly label: string }[],
): Response =>
  htmlResponse(<SetupPage providers={providers} />, 200, { 'Content-Security-Policy': UI_CSP_SETUP });

export const messagePageResponse = (
  status: number,
  props: Omit<MessagePageProps, 'children'>,
  extra: HeaderInit = {},
): Response => htmlResponse(<MessagePage {...props} />, status, extra);
