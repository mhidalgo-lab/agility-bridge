// SPDX-License-Identifier: Apache-2.0
// The request side of the admin panel (P4-03, THREAT_MODEL T13/T14): page and form guards, the CSRF-checked form reader,
// in-process calls to the admin API, redirects with flash messages, the re-authentication prompt. One kit per app
// instance; nothing about a request outlives it (T21).
import type { Context } from 'hono';
import type { JSX } from 'hono/jsx/jsx-runtime';
import { CSRF_FIELD, localHref, UI_ROLE_RANK, type UiRole, type UiViewer } from './components.tsx';
import { clearFlashCookie, type FlashCode, type FlashMessage, flashCookie, readFlash } from './flash.ts';
import { errorPage, htmlResponse, reauthPage } from './pages.tsx';

/** The signed-in person behind a panel request (from the admin session; the role is re-read on every request). */
export interface UiPrincipal extends UiViewer {
  readonly userId: string;
  /** Absolute end of the session (epoch ms). */
  readonly expiresAt: number;
  /** End of the session if no request comes before then (epoch ms). */
  readonly idleExpiresAt: number;
}

export type UiAuthResult =
  | { readonly ok: true; readonly principal: UiPrincipal }
  /**
   * `presented`: the request carried a session cookie (dead or broken): the page clears it. `response`: send this
   * instead of the sign-in redirect.
   */
  | { readonly ok: false; readonly presented: boolean; readonly response?: Response };

/** One admin API call (`path` relative to `/api/admin/v1`; build it with {@link adminPath}). */
export interface AdminCall {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  /** JSON body for POST/PUT/PATCH. */
  readonly body?: unknown;
}

export interface AdminCallResult {
  readonly status: number;
  /** Parsed JSON body (null when there is none). On errors: `{ error: { code, message, ... } }`. */
  readonly body: unknown;
}

/** What the panel needs from the server (`@agility-bridge/http-app` provides it from the P4-02 sessions). */
export interface AdminUiDeps {
  /** The server clock (epoch ms). Default `Date.now`. */
  readonly now?: () => number;
  /** https public URL: `__Host-` cookie names and `Secure`. */
  readonly secureCookies: boolean;
  /**
   * `AB_PUBLIC_URL`'s origin: the only source of the addresses the Connect page and the token page show (never `Host`,
   * `X-Forwarded-Host` or the request URL, T8).
   */
  readonly publicOrigin: string;
  /** Load and check the admin session of this request. Never looks at `Authorization`. */
  authenticate(c: Context): Promise<UiAuthResult>;
  /** Fetch-metadata and `Origin` checks for a cookie-authenticated request (null when fine). */
  checkFetchOrigin(c: Context, unsafe: boolean): string | null;
  /** Constant-time check of the presented CSRF token against the session's. */
  csrfMatches(principal: UiPrincipal, presented: string | undefined): boolean;
  /** `Set-Cookie` value that removes the session cookie. */
  readonly clearSessionCookie: string;
  /** Run an admin API request in-process as this principal (cookie, CSRF token and our own Origin attached). */
  callAdmin(c: Context, principal: UiPrincipal, call: AdminCall): Promise<AdminCallResult>;
  /** A refused panel request of a signed-in user (CSRF, origin, role): audit it. Must not throw. */
  onForbidden?(c: Context, principal: UiPrincipal, reason: string): void;
  /** Before the session is looked up (per-IP rate limit). A Response stops the request. */
  beforeAuth?(c: Context): Promise<Response | undefined> | Response | undefined;
  /** An unexpected error (logged without its message). */
  onError?(c: Context, error: unknown): void;
  /** Largest form body. Default 16 KiB. */
  readonly maxFormBytes?: number;
  /**
   * Server-side store for single-use form handles (P4-04): a form whose effect must not repeat on a re-send (reload or back
   * button on the one-time device token page) carries a handle stored here, and the post takes it.
   */
  readonly onceStore: OnceStore;
  /**
   * The sign-in providers this deployment configured (`idp` is what a person's identity carries: `google`, `github`,
   * `cf-access`, `oidc:<name>`; `label` is the name shown). The unbind page offers exactly these (P4-39, D-130).
   */
  readonly identityProviders?: readonly { readonly idp: string; readonly label: string }[];
  /** The write approval page (P7-02): present only when write tools are on. Absent: `/admin/approve/*` is a 404. */
  readonly approvals?: ApprovalsPort;
}

/** One pending write approval, as the approval page shows it (P7-02). Text from Agility or the agent is untrusted. */
export interface ApprovalView {
  readonly id: string;
  readonly tool: string;
  readonly operation: string;
  readonly workspaceName: string | null;
  readonly target: { readonly assetType: string; readonly oid: string; readonly number: string | null };
  /** The target's title from Agility (untrusted); null when unknown. */
  readonly label: string | null;
  /** Each field with its old and new value, JSON-quoted. */
  readonly changes: readonly { readonly field: string; readonly old: string; readonly new: string }[];
  /** The hash the approval binds (also posted back by the form), and its short form. */
  readonly hash: string;
  readonly changeId: string;
  /** Epoch ms. */
  readonly expiresAt: number;
}

/**
 * One open request in the list (P7-14): where and what, never a value. The title and the old and new values are only on
 * the request's own page. The tool, workspace name and asset number are text from the server and Agility: escaped.
 */
export interface ApprovalSummary {
  readonly id: string;
  readonly tool: string;
  readonly operation: string;
  readonly workspaceName: string | null;
  readonly target: { readonly assetType: string; readonly oid: string; readonly number: string | null };
  /** Names of the fields the change sets. */
  readonly fields: readonly string[];
  readonly changeId: string;
  /** Epoch ms. */
  readonly requestedAt: number;
  readonly expiresAt: number;
}

/** `gone`: unknown, used, expired or another person's (one answer for all, so nothing is learned from it). */
export type ApprovalOutcome = 'approved' | 'declined' | 'gone' | 'mismatch';

/** The pending write approvals of the signed-in person (P7-02). The server looks them up by the principal's own id. */
export interface ApprovalsPort {
  view(c: Context, principal: UiPrincipal, id: string): Promise<ApprovalView | null>;
  /** The signed-in person's own open requests, soonest to expire first (P7-14); never another person's. */
  list(c: Context, principal: UiPrincipal): Promise<readonly ApprovalSummary[]>;
  decide(
    c: Context,
    principal: UiPrincipal,
    id: string,
    input: { readonly decision: 'approve' | 'decline'; readonly hash: string },
  ): Promise<ApprovalOutcome>;
}

/** Single-use keys with a lifetime (`kv` with an atomic `take` on the server, L-073). */
export interface OnceStore {
  put(key: string, ttlSeconds: number): Promise<void>;
  /** Resolves true for exactly one caller per stored key. */
  take(key: string): Promise<boolean>;
  /** Up to `limit` live keys that start with `prefix`. */
  list(prefix: string, limit: number): Promise<readonly string[]>;
}

/** Form field carrying a single-use handle. */
export const ONCE_FIELD = '_once';
/** A handle lives as long as a form page may reasonably stay open. */
export const ONCE_TTL_SECONDS: number = 2 * 60 * 60;
/** Open handles per user: past this a page hands out one of them again instead of writing a row. */
export const ONCE_MAX_OUTSTANDING = 10;
const ONCE_RE = /^[A-Za-z0-9_-]{22}$/;
const oncePrefix = (userId: string) => `ui-once:${userId}:`;
const onceKey = (userId: string, handle: string) => `${oncePrefix(userId)}${handle}`;

function randomHandle(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A form body that passed the origin and CSRF checks, for this principal only. */
export interface VerifiedForm {
  readonly fields: URLSearchParams;
  readonly principal: UiPrincipal;
}

export interface PageContext {
  readonly principal: UiPrincipal;
  /** The flash message to show (cleared from the browser by `html`). */
  readonly flash: FlashMessage | null;
  /** Render a page (and clear a shown flash). */
  html(node: JSX.Element, status?: number): Response;
}

export type PageHandler = (c: Context, page: PageContext) => Response | Promise<Response>;
export type FormHandler = (
  c: Context,
  principal: UiPrincipal,
  form: VerifiedForm,
) => Response | Promise<Response>;

export interface UiKit {
  readonly deps: AdminUiDeps;
  /** A GET page for `minRole` and above. */
  page(minRole: UiRole, handler: PageHandler): (c: Context) => Promise<Response>;
  /** A POST form target for `minRole` and above: origin, CSRF token and size are checked before `handler` runs. */
  form(minRole: UiRole, handler: FormHandler): (c: Context) => Promise<Response>;
  /** Call the admin API as `principal`. Unsafe methods need the verified form of this request. */
  callAdmin(
    c: Context,
    principal: UiPrincipal,
    call: AdminCall,
    form?: VerifiedForm,
  ): Promise<AdminCallResult>;
  /** `303` to a same-origin path, optionally with a flash message on the next page. */
  redirect(path: string, flash?: FlashCode): Response;
  /**
   * The answer to an admin API result that is not a success: `reauth_required` becomes the re-authentication prompt
   * (returning to `back`), a lost session the sign-in redirect, anything else a redirect to `back` with a fixed message
   * chosen from the error code. Nothing from the response body is shown.
   */
  fail(c: Context, principal: UiPrincipal, result: AdminCallResult, back: string): Response;
  /** A new single-use form handle for `principal` (put in the form as {@link ONCE_FIELD}). Writes nothing for HEAD. */
  issueOnce(principal: UiPrincipal): Promise<string>;
  /** Use up the form's handle: true once per issued handle of this principal, false for a re-sent or forged form. */
  claimOnce(form: VerifiedForm): Promise<boolean>;
}

export const DEFAULT_MAX_FORM_BYTES: number = 16 * 1024;
const FORM_TYPE = /^application\/x-www-form-urlencoded\s*(;|$)/i;
const LOGIN_PATH = '/auth/login';

/**
 * An admin API path with every interpolated value percent-encoded as one path segment (ids from a form can't add
 * segments, a query or a fragment): adminPath`/users/${id}/sessions/revoke`. Empty, `.` and `..` values throw: URL
 * parsing would turn them into another route.
 */
export function adminPath(strings: TemplateStringsArray, ...values: readonly (string | number)[]): string {
  let out = strings[0] ?? '';
  values.forEach((v, i) => {
    const segment = String(v);
    if (segment === '' || segment === '.' || segment === '..')
      throw new TypeError('invalid admin API path segment');
    out += encodeURIComponent(segment) + (strings[i + 1] ?? '');
  });
  return out;
}

/**
 * Cross-site requests a page may serve: only top-level navigations (a link from mail or chat, or the redirect that ends
 * a sign-in). Subresource loads, `fetch`, frames and anything else from another site are refused before the session is
 * looked at (L-192).
 */
export function pageFetchProblem(c: Context): string | null {
  const site = c.req.header('sec-fetch-site');
  if (site === undefined || site === 'same-origin' || site === 'none') return null;
  const method = c.req.method;
  if (
    (method === 'GET' || method === 'HEAD') &&
    c.req.header('sec-fetch-mode') === 'navigate' &&
    c.req.header('sec-fetch-dest') === 'document'
  ) {
    return null;
  }
  return 'cross_site';
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

export const requestIdOf = (c: Context): string | undefined => {
  const id = c.get('requestId') as unknown;
  return typeof id === 'string' && id !== '' ? id : undefined;
};

/** The error code of an admin API error body (`{ error: { code } }`), or null. */
function errorCodeOf(body: unknown): string | null {
  const error = (body as { error?: { code?: unknown } } | null)?.error;
  return typeof error?.code === 'string' ? error.code : null;
}

/** The `detail` marker of an admin API error (`last_owner`), or null. */
function errorDetailOf(body: unknown): string | null {
  const error = (body as { error?: { detail?: unknown } } | null)?.error;
  return typeof error?.detail === 'string' ? error.detail : null;
}

const FLASH_BY_CODE: Readonly<Record<string, FlashCode>> = Object.freeze({
  forbidden: 'not_allowed',
  not_found: 'not_found',
  conflict: 'conflict',
  invalid_input: 'invalid',
  bad_request: 'invalid',
  payload_too_large: 'invalid',
  rate_limited: 'rate_limited',
  unavailable: 'unavailable',
  upstream: 'unavailable',
});

export function createUiKit(deps: AdminUiDeps): UiKit {
  const maxFormBytes = deps.maxFormBytes ?? DEFAULT_MAX_FORM_BYTES;
  if (!Number.isSafeInteger(maxFormBytes) || maxFormBytes < 1024 || maxFormBytes > 1024 * 1024) {
    throw new RangeError('maxFormBytes must be between 1024 and 1048576');
  }
  // Forms verified by this kit. A WeakSet, not module state: entries die with their request.
  const verified = new WeakSet<VerifiedForm>();
  // Principals of requests answered as HEAD: their pages are rendered and discarded, so no handle is stored.
  const headRequests = new WeakSet<UiPrincipal>();

  const toLogin = (c: Context, presented: boolean): Response => {
    const target =
      c.req.method === 'GET' || c.req.method === 'HEAD' ? `${c.req.path}${queryOf(c)}` : '/admin';
    const headers = new Headers({ Location: `${LOGIN_PATH}?${new URLSearchParams({ next: target })}` });
    if (presented) headers.append('Set-Cookie', deps.clearSessionCookie);
    return new Response(null, { status: 303, headers });
  };

  const forbidden = (c: Context, principal: UiPrincipal, reason: string): Response => {
    try {
      deps.onForbidden?.(c, principal, reason);
    } catch {
      // auditing never changes the answer
    }
    return errorPage(403, requestIdOf(c), principal);
  };

  /** Fetch metadata, pre-auth hook, session. A Response means stop. */
  const enter = async (c: Context, unsafe: boolean): Promise<UiPrincipal | Response> => {
    if (!unsafe && pageFetchProblem(c) !== null) return errorPage(403, requestIdOf(c));
    const stop = await deps.beforeAuth?.(c);
    if (stop) return stop;
    const auth = await deps.authenticate(c);
    if (!auth.ok) return auth.response ?? toLogin(c, auth.presented);
    return auth.principal;
  };

  const allowed = (principal: UiPrincipal, minRole: UiRole) =>
    UI_ROLE_RANK[principal.role] >= UI_ROLE_RANK[minRole];

  const kit: UiKit = {
    deps,

    page: (minRole, handler) => async (c) => {
      const entered = await enter(c, false);
      if (entered instanceof Response) return entered;
      const principal = entered;
      if (!allowed(principal, minRole)) return forbidden(c, principal, 'role');
      const flash = readFlash(c.req.header('cookie'), deps.secureCookies);
      const isHead = c.req.method === 'HEAD';
      if (isHead) headRequests.add(principal);
      try {
        return await handler(c, {
          principal,
          flash: flash.message,
          html: (node, status = 200) =>
            htmlResponse(
              node,
              status,
              flash.present ? [['Set-Cookie', clearFlashCookie(deps.secureCookies)]] : [],
            ),
        });
      } finally {
        if (isHead) headRequests.delete(principal);
      }
    },

    form: (minRole, handler) => async (c) => {
      const entered = await enter(c, true);
      if (entered instanceof Response) return entered;
      const principal = entered;
      // Origin and fetch metadata first: a cross-site post is refused before its body is read.
      const problem = deps.checkFetchOrigin(c, true);
      if (problem !== null) return forbidden(c, principal, problem);
      if (!FORM_TYPE.test(c.req.header('content-type') ?? ''))
        return errorPage(415, requestIdOf(c), principal);
      const text = await readCapped(c.req.raw, maxFormBytes);
      if (text === null) return errorPage(413, requestIdOf(c), principal);
      const fields = new URLSearchParams(text);
      const tokens = fields.getAll(CSRF_FIELD);
      if (tokens.length !== 1 || !deps.csrfMatches(principal, tokens[0]))
        return forbidden(c, principal, 'csrf');
      fields.delete(CSRF_FIELD);
      if (!allowed(principal, minRole)) return forbidden(c, principal, 'role');
      const form: VerifiedForm = Object.freeze({ fields, principal });
      verified.add(form);
      return handler(c, principal, form);
    },

    async callAdmin(c, principal, call, form) {
      if (
        call.method !== 'GET' &&
        (form === undefined || !verified.has(form) || form.principal !== principal)
      ) {
        throw new TypeError('admin API changes from the panel need the verified form of the same request');
      }
      if (!call.path.startsWith('/') || call.path.startsWith('//')) {
        throw new TypeError('admin API paths start with one /');
      }
      return deps.callAdmin(c, principal, call);
    },

    async issueOnce(principal) {
      const handle = randomHandle();
      if (headRequests.has(principal)) return handle;
      // Bounded writes: at the cap, hand out one of the user's open handles (a second tab then loses the race at submit
      // time and sees the normal "already used" answer) instead of spending another row.
      const prefix = oncePrefix(principal.userId);
      const open = await deps.onceStore.list(prefix, ONCE_MAX_OUTSTANDING);
      if (open.length >= ONCE_MAX_OUTSTANDING) {
        const reuse = open[Math.floor(Math.random() * open.length)]?.slice(prefix.length) ?? '';
        if (ONCE_RE.test(reuse)) return reuse;
      }
      await deps.onceStore.put(onceKey(principal.userId, handle), ONCE_TTL_SECONDS);
      return handle;
    },

    async claimOnce(form) {
      if (!verified.has(form)) return false;
      const handles = form.fields.getAll(ONCE_FIELD);
      const handle = handles[0];
      if (handles.length !== 1 || handle === undefined || !ONCE_RE.test(handle)) return false;
      return deps.onceStore.take(onceKey(form.principal.userId, handle));
    },

    redirect(path, flash) {
      const headers = new Headers({ Location: localHref(path) });
      if (flash !== undefined) headers.append('Set-Cookie', flashCookie(flash, deps.secureCookies));
      return new Response(null, { status: 303, headers });
    },

    fail(c, principal, result, back) {
      const code = errorCodeOf(result.body);
      if (result.status === 403 && code === 'reauth_required')
        return reauthPage(principal, back, requestIdOf(c));
      // The session ended between the page and the call (logout elsewhere, expiry).
      if (result.status === 401) return toLogin(c, true);
      if (errorDetailOf(result.body) === 'last_owner') return kit.redirect(back, 'last_owner');
      return kit.redirect(back, (code === null ? undefined : FLASH_BY_CODE[code]) ?? 'failed');
    },
  };
  return kit;
}

function queryOf(c: Context): string {
  return new URL(c.req.url).search;
}
