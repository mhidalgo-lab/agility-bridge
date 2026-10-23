// SPDX-License-Identifier: Apache-2.0
// The sign-in pages (P4-01): server-rendered, fixed sentences only (provider labels are operator configuration and are
// escaped), no inline script or style, so a strict CSP holds. P4-03's admin UI replaces the markup and keeps the
// contract. Web-standard only (ADR-0004).

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (ch) => ESCAPES[ch] as string);

/**
 * The policy of the sign-in pages: no inline anything, scripts only from this origin (the setup page's one file),
 * no framing, no base tag. `form-action` is left open on purpose: Chromium applies it to the redirect after the form
 * posts, and that redirect goes to the identity provider.
 */
export const IDENTITY_PAGE_CSP =
  "default-src 'none'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'";

export function page(title: string, body: string, scripts: readonly string[] = []): string {
  const script = scripts.map((src) => `<script src="${escapeHtml(src)}"></script>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title></head><body><main><h1>${escapeHtml(title)}</h1>${body}</main>${script}</body></html>`;
}

export interface PageLink {
  readonly href: string;
  readonly label: string;
}

export function messageBody(paragraphs: readonly string[], link?: PageLink, requestId?: string): string {
  const text = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('');
  const anchor =
    link === undefined ? '' : `<p><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></p>`;
  const id = requestId === undefined ? '' : `<p><small>Request id: ${escapeHtml(requestId)}</small></p>`;
  return `${text}${anchor}${id}`;
}

export function chooserBody(providers: readonly PageLink[]): string {
  if (providers.length === 0) return '<p>No sign-in provider is configured.</p>';
  const items = providers
    .map((p) => `<li><a href="${escapeHtml(p.href)}">Continue with ${escapeHtml(p.label)}</a></li>`)
    .join('');
  return `<ul>${items}</ul>`;
}

/**
 * The owner setup form. The code arrives in the URL fragment, which no server or log ever sees; `setup.js` moves it into
 * the field, and the browser posts it in the request body. Without scripts the code can be pasted.
 */
export function setupBody(providers: readonly { readonly id: string; readonly label: string }[]): string {
  const buttons = providers
    .map(
      (p) =>
        `<button type="submit" name="provider" value="${escapeHtml(p.id)}">Continue with ${escapeHtml(p.label)}</button>`,
    )
    .join(' ');
  return (
    '<p>Sign in as the first owner with the single-use setup code from <code>agility-bridge setup-link</code>.</p>' +
    '<form method="post" action="/auth/setup" autocomplete="off">' +
    '<p><label>Setup code <input name="code" type="password" autocomplete="off" spellcheck="false" required size="40" maxlength="80"></label></p>' +
    `<p>${buttons}</p></form>`
  );
}

export interface AccountView {
  readonly email: string;
  readonly role: string;
  readonly recentAuth: boolean;
  /** Idle and absolute expiry, ISO 8601. */
  readonly idleExpiresAt: string;
  readonly expiresAt: string;
  readonly csrf: string;
}

/**
 * The account page: who is signed in, how to re-authenticate, and the sign-out forms. The CSRF token sits in a hidden
 * field of a POST form (`POST /auth/logout`). Every value is escaped; the page is `no-store` and sent with
 * `Referrer-Policy: same-origin`, so the browser's form POST carries a real `Origin` and not `null`.
 */
export function accountBody(view: AccountView): string {
  const token = `<input type="hidden" name="_csrf" value="${escapeHtml(view.csrf)}">`;
  return (
    `<p>Signed in as <strong>${escapeHtml(view.email)}</strong> (${escapeHtml(view.role)}).</p>` +
    `<p>Recent sign-in: ${view.recentAuth ? 'yes' : 'no (needed for high-impact changes)'}.</p>` +
    `<p>This session ends after inactivity at ${escapeHtml(view.idleExpiresAt)} and at the latest at ${escapeHtml(view.expiresAt)}.</p>` +
    '<p><a href="/auth/reauth">Sign in again</a></p>' +
    `<form method="post" action="/auth/logout">${token}<button type="submit">Sign out</button></form>` +
    `<form method="post" action="/auth/logout">${token}<input type="hidden" name="everywhere" value="1"><button type="submit">Sign out everywhere</button></form>`
  );
}

/** Moves the setup code from the URL fragment into the form field, then removes it from the address bar. */
export const SETUP_SCRIPT = `(function () {
  var match = /^#(ab_setup_[0-9a-f]{64})$/.exec(location.hash);
  if (!match) return;
  var field = document.querySelector('input[name=code]');
  if (field) field.value = match[1];
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
})();
`;
