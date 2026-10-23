// SPDX-License-Identifier: Apache-2.0
// Flash messages for Post/Redirect/Get (P4-03). The cookie carries a message *code* from this fixed catalogue, never
// text: nothing a request supplies is ever shown back through it.

export type FlashKind = 'success' | 'info' | 'error';

export interface FlashMessage {
  readonly kind: FlashKind;
  readonly text: string;
}

/** Every flash code. Screens add theirs here and in the catalogue below. */
export type FlashCode =
  | 'saved'
  | 'created'
  | 'deleted'
  | 'revoked'
  | 'disabled'
  | 'enabled'
  | 'validated'
  | 'last_owner'
  | 'token_form_used'
  | 'sessions_ended'
  | 'identity_cleared'
  | 'origin_changed'
  | 'invalid'
  | 'not_found'
  | 'not_allowed'
  | 'conflict'
  | 'rate_limited'
  | 'unavailable'
  | 'failed';

/** Every flash message the panel can show. */
export const FLASH_MESSAGES: Readonly<Record<FlashCode, FlashMessage>> = Object.freeze({
  saved: { kind: 'success', text: 'Saved.' },
  created: { kind: 'success', text: 'Created.' },
  deleted: { kind: 'success', text: 'Deleted.' },
  revoked: { kind: 'success', text: 'Revoked. It stopped working at once.' },
  disabled: { kind: 'success', text: 'Disabled.' },
  enabled: { kind: 'success', text: 'Enabled.' },
  validated: { kind: 'info', text: 'Checked against Agility. The result is below.' },
  last_owner: {
    kind: 'error',
    text: 'That would leave the server without an active owner. Make another person an owner first. Nothing changed.',
  },
  token_form_used: {
    kind: 'info',
    text: 'That form was already used, so no second device token was created. Check the grant before making another.',
  },
  sessions_ended: { kind: 'success', text: 'Every browser session of that person has ended.' },
  identity_cleared: {
    kind: 'success',
    text: 'The sign-in identity was cleared and the person was signed out everywhere. The next verified sign-in with their email binds the account.',
  },
  origin_changed: {
    kind: 'success',
    text: 'The origin changed. Every credential of the instance and every grant that used them was revoked.',
  },
  invalid: { kind: 'error', text: 'Some of what you entered is not valid. Check it and try again.' },
  not_found: { kind: 'error', text: 'That item no longer exists.' },
  not_allowed: { kind: 'error', text: 'Your role does not allow that.' },
  conflict: { kind: 'error', text: 'That conflicts with the current state. Check it and try again.' },
  rate_limited: { kind: 'error', text: 'Too many requests. Wait a minute and try again.' },
  unavailable: {
    kind: 'error',
    text: 'The service is unavailable right now. Nothing changed. Try again in a moment.',
  },
  failed: { kind: 'error', text: 'That did not work. Try again in a moment.' },
});

const SECURE_NAME = '__Host-ab_flash';
const PLAIN_NAME = 'ab_flash';
/** A flash survives one redirect, not a later visit. */
const FLASH_MAX_AGE = 60;

export const flashCookieName = (secure: boolean): string => (secure ? SECURE_NAME : PLAIN_NAME);

const isFlashCode = (code: string): code is FlashCode => Object.hasOwn(FLASH_MESSAGES, code);

/** `Set-Cookie` value that shows `code` on the next page. */
export function flashCookie(code: FlashCode, secure: boolean): string {
  return `${flashCookieName(secure)}=${code}; Path=/; Max-Age=${FLASH_MAX_AGE}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** `Set-Cookie` value that removes the flash once shown. */
export function clearFlashCookie(secure: boolean): string {
  return `${flashCookieName(secure)}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/**
 * The flash this request carries: `present` when the cookie is there at all (it must then be cleared), `message` only
 * for a known code. A cookie named twice is none (L-189).
 */
export function readFlash(
  cookieHeader: string | undefined,
  secure: boolean,
): { readonly present: boolean; readonly message: FlashMessage | null } {
  if (cookieHeader === undefined) return { present: false, message: null };
  const name = flashCookieName(secure);
  let found: string | undefined;
  for (const part of cookieHeader.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      if (found !== undefined) return { present: true, message: null };
      found = part.slice(i + 1).trim();
    }
  }
  if (found === undefined) return { present: false, message: null };
  return { present: true, message: isFlashCode(found) ? FLASH_MESSAGES[found] : null };
}
