// SPDX-License-Identifier: Apache-2.0
// The built-in sign-in and consent step of `/oauth/authorize` (P5-04, THREAT_MODEL T9/T10/T13/T15). Web-standard only.
//
//   GET  /oauth/authorize?…     (validated by `server.ts`) → sign-in redirect, `prompt=none` refusal, or the page
//   POST /oauth/consent?…       the page's form: fetch metadata + Origin + CSRF + a single-use handle bound to the request
//
// The authorization request travels in the URL (the sign-in `next`, the form's `action`) and is validated again by the
// provider on every step. What makes the form safe to post is the **handle**: the page stores
// `oauth-consent:<user>:<handle>` = SHA-256 of the canonical request it showed, and the post takes it atomically
// (`kv.take`, L-073) and compares it with the request it re-validated from the form's own URL. A replayed form finds no
// handle; a form carried to another request, or another person's session, finds a different one. The person can only
// pick one of their own live grants on the workspace the `resource` names; `approve()` re-runs the access resolver anyway.
// Nothing is remembered between requests: every authorization shows the page, so a navigation alone never issues a code
// (L-090). The admin panel's views, kit and CSP are loaded on first use, never by an MCP request (P3-14).
import type { AdminUiDeps, UiPrincipal } from '@agility-bridge/admin-ui';
import type { Clock, Logger } from '@agility-bridge/core';
import type { KvStore } from '@agility-bridge/storage';
import type { Context } from 'hono';
import type { AdminUiModule } from '../admin-ui.ts';
import type { AdminChange } from '../audit.ts';
import {
  deviceLabel,
  MAX_DEVICE_LABEL_CHARS,
  OAUTH_AUTHORIZE_PATH,
  type OAuthApproval,
  type OAuthConsentApi,
  type OAuthConsentHandler,
  type OAuthRuntime,
} from './server.ts';

export const OAUTH_CONSENT_PATH = '/oauth/consent';
const LOGIN_PATH = '/auth/login';
/** The page that lists a person's connected apps. */
const DEVICES_PATH = '/admin/me';
/** Longest `/oauth/authorize?…` a sign-in can return to (the sign-in `next` cap). */
export const MAX_AUTHORIZE_URL_CHARS = 2048;
/** How long a consent page stays valid for its form. */
export const CONSENT_HANDLE_TTL_S = 15 * 60;
/** Open consent forms per person: past this the oldest is dropped (a stale tab then asks to connect again). */
export const MAX_OPEN_CONSENT_HANDLES = 20;
const HANDLE_RE = /^\d{14}-[A-Za-z0-9_-]{22}$/;
const MAX_FORM_BYTES = 16 * 1024;
const FORM_TYPE = /^application\/x-www-form-urlencoded\s*(;|$)/i;
const handlePrefix = (userId: string): string => `oauth-consent:${userId}:`;

export interface ConsentScreenDeps {
  /** The panel module (views, CSP, error pages), loaded on first use. */
  readonly loadUi: () => Promise<AdminUiModule>;
  /** The panel's session wiring (`adminUiDeps`): sessions, fetch metadata, CSRF. */
  readonly ui: Pick<
    AdminUiDeps,
    'authenticate' | 'checkFetchOrigin' | 'csrfMatches' | 'clearSessionCookie' | 'onForbidden'
  >;
  readonly kv: KvStore;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Admin audit rows (`oauth.consent.refused`); its work is kept alive with `runInBackground`. */
  readonly audit?: (change: AdminChange) => Promise<void> | undefined;
  readonly runInBackground: (c: Context, task: Promise<unknown>) => void;
}

export interface ConsentScreen {
  /** The consent seam of `/oauth/authorize` (GET; the request is validated). */
  readonly handler: OAuthConsentHandler;
  /** `POST /oauth/consent?…`. */
  decide(c: Context, runtime: OAuthRuntime): Promise<Response>;
}

function b64u(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The exact authorization request a form is for: client, redirect URI, PKCE challenge and method, resource, scope, state,
 * response type. Any change to any of them is another request.
 */
async function bindingOf(api: OAuthConsentApi): Promise<string> {
  const r = api.authRequest;
  const material = JSON.stringify([
    r.responseType,
    r.clientId,
    r.redirectUri,
    r.codeChallenge ?? null,
    r.codeChallengeMethod ?? null,
    r.resource ?? null,
    [...r.scope],
    r.state ?? null,
  ]);
  return b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material))));
}

/** Read at most `max` bytes of the body (declared length or not); null when it is larger. */
async function readCapped(request: Request, max: number): Promise<string | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d{1,15}$/.test(declared) || Number(declared) > max)) return null;
  if (request.body === null) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

const requestIdOf = (c: Context): string | undefined => {
  const id = c.get('requestId' as never) as unknown;
  return typeof id === 'string' && id !== '' ? id : undefined;
};

/** The single value of a form field, or null when absent or repeated. */
function single(fields: URLSearchParams, name: string): string | null {
  const all = fields.getAll(name);
  return all.length === 1 ? (all[0] as string) : null;
}

const isLoopback = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname);

export function createConsentScreen(deps: ConsentScreenDeps): ConsentScreen {
  const { ui, kv, clock } = deps;

  const refusedRow = (
    c: Context,
    principal: UiPrincipal,
    api: OAuthConsentApi | null,
    reason: string,
  ): void => {
    const work = deps.audit?.({
      action: 'oauth.consent.refused',
      status: 'denied',
      userId: principal.userId,
      targetType: 'oauth_client',
      targetId: (api?.request.clientId ?? '-').slice(0, 200),
      errorCode: reason,
      requestId: requestIdOf(c) ?? null,
    });
    if (work !== undefined) deps.runInBackground(c, work);
  };

  /** A new handle bound to `binding` for `userId`; the oldest is dropped at the cap. HEAD writes nothing. */
  const issueHandle = async (c: Context, userId: string, binding: string): Promise<string> => {
    const expires = clock.now() + CONSENT_HANDLE_TTL_S * 1000;
    const handle = `${String(expires).padStart(14, '0')}-${b64u(crypto.getRandomValues(new Uint8Array(16)))}`;
    if (c.req.method === 'HEAD') return handle;
    const prefix = handlePrefix(userId);
    const open = await kv.list(prefix, { limit: MAX_OPEN_CONSENT_HANDLES + 1 });
    if (open.length >= MAX_OPEN_CONSENT_HANDLES) {
      for (const key of open.slice(0, open.length - MAX_OPEN_CONSENT_HANDLES + 1)) await kv.delete(key);
    }
    await kv.set(`${prefix}${handle}`, binding, { expiresAt: expires });
    return handle;
  };

  /** No usable session: back to sign-in, returning to the authorize request (a same-origin path). */
  const toLogin = (
    c: Context,
    mod: AdminUiModule,
    auth: { readonly presented: boolean; readonly response?: Response },
    next: string,
  ): Response => {
    if (auth.response) return auth.response;
    if (next.length > MAX_AUTHORIZE_URL_CHARS) {
      return mod.messagePageResponse(400, {
        title: 'Request too long',
        paragraphs: [
          'This connection request is too long to continue after signing in. Ask the app to connect again.',
        ],
        requestId: requestIdOf(c),
      });
    }
    const headers = new Headers({
      Location: `${LOGIN_PATH}?${new URLSearchParams({ next })}`,
      'Cache-Control': 'no-store',
    });
    if (auth.presented) headers.append('Set-Cookie', ui.clearSessionCookie);
    return new Response(null, { status: 303, headers });
  };

  const redirectTo = (location: string): Response =>
    new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store' } });

  /**
   * The answer to a consent post. A redirect after a form post is subject to `form-action`, and no CSP source can name
   * `http://[::1]`; widening to `http:` would let any injected form post to any http site. So that one target gets a
   * same-origin page that navigates (`Refresh` plus a link: neither is governed by `form-action`).
   */
  const leaveTo = (c: Context, mod: AdminUiModule, location: string): Response => {
    const target = new URL(location);
    if (target.protocol !== 'http:' || !target.hostname.startsWith('[')) return redirectTo(location);
    const response = mod.messagePageResponse(200, {
      title: 'Return to the app',
      paragraphs: ['You are done here. Continue to the app on this computer.'],
      continueHref: target.href,
      requestId: requestIdOf(c),
    });
    response.headers.set('Refresh', `0; url=${target.href}`);
    return response;
  };

  /** The page itself, `form-action` widened to the client's redirect origin (the post answers with a redirect). */
  const renderPage = async (
    c: Context,
    mod: AdminUiModule,
    principal: UiPrincipal,
    api: OAuthConsentApi,
    binding: string,
    state: {
      readonly status?: number;
      readonly error?: string;
      readonly selected?: string;
      readonly label?: string;
    } = {},
  ): Promise<Response> => {
    const r = api.request;
    const { workspaceName, options } = await api.grants(principal.userId);
    const handle = await issueHandle(c, principal.userId, binding);
    const response = mod.htmlResponse(
      mod.ConsentPage({
        viewer: principal,
        action: `${OAUTH_CONSENT_PATH}${new URL(c.req.url).search}`,
        handle,
        client: {
          name: r.clientName,
          redirectHost: r.redirectHost,
          loopback: isLoopback(new URL(r.redirectUri).hostname),
        },
        workspace: { slug: r.workspaceSlug, name: workspaceName },
        grants: options.map((g) => ({
          id: g.id,
          label: g.label ?? 'Your access',
          tools: g.tools,
          writeTools: g.writeTools,
          projectCount: g.projectCount,
          expiresAt: g.expiresAt,
        })),
        offline: r.scope.includes('offline_access'),
        // The app asked for `mcp:write`: the page then carries a separate, unticked box (P7-24). The tick is never
        // carried over to a second render.
        writeRequested: r.scope.includes('mcp:write'),
        selected: state.selected,
        label: state.label,
        error: state.error,
        devicesHref: DEVICES_PATH,
      }),
      state.status ?? 200,
    );
    const source = mod.formActionSource(r.redirectUri);
    if (source !== null) response.headers.set('Content-Security-Policy', mod.consentCsp(source));
    return response;
  };

  const message = (
    c: Context,
    mod: AdminUiModule,
    principal: UiPrincipal | undefined,
    status: number,
    title: string,
    paragraphs: readonly string[],
  ): Response =>
    mod.messagePageResponse(status, { title, paragraphs, viewer: principal, requestId: requestIdOf(c) });

  return {
    async handler(c, api) {
      const mod = await deps.loadUi();
      // Only top-level navigations from other sites (the client opening this page): no frames, fetches or subresources.
      if (mod.pageFetchProblem(c) !== null) return mod.errorPage(403, requestIdOf(c));
      const auth = await ui.authenticate(c);
      const url = new URL(c.req.url);
      // `prompt=none` (OIDC Core §3.1.2.6): never a page. Alone it is answered at once with the error that says why;
      // mixed with another value it is invalid. A silent navigation never issues a code (L-090).
      const prompt = (url.searchParams.get('prompt') ?? '').split(' ');
      if (prompt.includes('none')) {
        if (prompt.length > 1) return redirectTo(api.refuse('invalid_request', 'prompt=none is exclusive.'));
        return redirectTo(
          api.refuse(
            auth.ok ? 'consent_required' : 'login_required',
            auth.ok ? 'The user must approve this request.' : 'The user must sign in.',
          ),
        );
      }
      if (!auth.ok) return toLogin(c, mod, auth, `${OAUTH_AUTHORIZE_PATH}${url.search}`);
      return renderPage(c, mod, auth.principal, api, await bindingOf(api));
    },

    async decide(c, runtime) {
      const mod = await deps.loadUi();
      const url = new URL(c.req.url);
      const auth = await ui.authenticate(c);
      if (!auth.ok) return toLogin(c, mod, auth, `${OAUTH_AUTHORIZE_PATH}${url.search}`);
      const principal = auth.principal;
      // Fetch metadata and `Origin` first: a cross-site post is refused before its body is read or the client resolved.
      const problem = ui.checkFetchOrigin(c, true);
      const forbidden = (reason: string): Response => {
        try {
          ui.onForbidden?.(c, principal, reason);
        } catch {
          // auditing never changes the answer
        }
        return mod.errorPage(403, requestIdOf(c), principal);
      };
      if (problem !== null) return forbidden(problem);
      if (!FORM_TYPE.test(c.req.header('content-type') ?? ''))
        return mod.errorPage(415, requestIdOf(c), principal);
      const text = await readCapped(c.req.raw, MAX_FORM_BYTES);
      if (text === null) return mod.errorPage(413, requestIdOf(c), principal);
      const fields = new URLSearchParams(text);
      const tokens = fields.getAll(mod.CSRF_FIELD);
      if (tokens.length !== 1 || !ui.csrfMatches(principal, tokens[0])) return forbidden('csrf');
      // The request is validated again from the URL the form posted to: client, redirect URI, PKCE, resource.
      const prepared = await runtime.prepare(c, url.searchParams);
      if (prepared instanceof Response) return prepared;
      const api = prepared;
      const binding = await bindingOf(api);
      // The handle: single use, this person's, for exactly this request. It is spent whatever happens next, so a form
      // that was sent twice, or carried to another request or session, approves nothing.
      const handle = single(fields, mod.CONSENT_FIELDS.handle);
      const stored =
        handle !== null && HANDLE_RE.test(handle)
          ? await kv.take(`${handlePrefix(principal.userId)}${handle}`)
          : null;
      if (stored === null) {
        refusedRow(c, principal, api, 'handle_used_or_expired');
        return message(c, mod, principal, 409, 'This form was already used', [
          'This form was already used or has expired, so nothing was approved. If you still want to connect the app, start the connection again from the app.',
        ]);
      }
      if (stored !== binding) {
        refusedRow(c, principal, api, 'handle_mismatch');
        return message(c, mod, principal, 409, 'This form is for another request', [
          'This form does not belong to this connection request, so nothing was approved. Start the connection again from the app.',
        ]);
      }
      const decision = single(fields, mod.CONSENT_FIELDS.decision);
      if (decision === 'deny') return leaveTo(c, mod, api.deny(undefined, principal.userId));
      const again = (status: number, error: string, selected?: string, label?: string) =>
        renderPage(c, mod, principal, api, binding, {
          status,
          error,
          ...(selected === undefined ? {} : { selected }),
          ...(label === undefined ? {} : { label }),
        });
      if (decision !== 'approve') return again(422, 'Choose Allow or Deny.');
      const grantId = single(fields, mod.CONSENT_FIELDS.grant);
      const labelText = (single(fields, mod.CONSENT_FIELDS.label) ?? '').trim();
      const label = labelText === '' ? null : deviceLabel(labelText);
      if (labelText !== '' && label === null) {
        return again(
          422,
          `The device name must be at most ${MAX_DEVICE_LABEL_CHARS} characters of plain text.`,
          grantId ?? undefined,
        );
      }
      // Only one of the person's own usable grants on this workspace: a forged or stale id never reaches `approve()`.
      const { options } = await api.grants(principal.userId);
      const chosen = options.find((g) => g.id === grantId);
      if (chosen === undefined) {
        refusedRow(c, principal, api, 'grant_not_offered');
        return again(422, 'Choose one of your accesses on this workspace.', undefined, label ?? undefined);
      }
      // The separate write box: exactly `1` and nothing else counts as ticked, and only when the app asked for it.
      const write =
        api.request.scope.includes('mcp:write') && single(fields, mod.CONSENT_FIELDS.write) === '1';
      if (write && chosen.writeTools.length === 0) {
        refusedRow(c, principal, api, 'write_unavailable');
        return again(
          422,
          'This access does not allow changes. Leave “allow changes” unticked or choose another access.',
          chosen.id,
          label ?? undefined,
        );
      }
      const result: OAuthApproval = await api.approve({
        userId: principal.userId,
        grantId: chosen.id,
        label,
        write,
      });
      if (!result.ok) {
        if (result.reason === 'busy') {
          return again(
            409,
            'Another approval for your account was in progress. Check your choices and allow again.',
            chosen.id,
            label ?? undefined,
          );
        }
        if (result.reason === 'write_unavailable') {
          return again(
            422,
            'Changes can no longer be allowed for this access. Leave “allow changes” unticked or choose another access.',
            chosen.id,
            label ?? undefined,
          );
        }
        if (result.reason === 'device_limit') {
          return message(c, mod, principal, 409, 'Too many connected apps', [
            'You have reached the most apps one person can connect. Disconnect one you no longer use on My access, then connect this app again.',
          ]);
        }
        return message(c, mod, principal, 409, 'Access can’t be used', [
          'This access can no longer be used (it may have been revoked or expired). Nothing was approved. Ask an administrator, then connect the app again.',
        ]);
      }
      return leaveTo(c, mod, result.redirectTo);
    },
  };
}
