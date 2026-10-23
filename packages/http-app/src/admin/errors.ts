// SPDX-License-Identifier: Apache-2.0
// The admin API error envelope `{ error: { code, message, field?, detail? } }` and the status mapping of P2-09.
import { ForbiddenError, ReauthRequiredError, SecretsError, UpstreamCheckError } from '@agility-bridge/auth';
import { StorageError } from '@agility-bridge/storage';

export type AdminErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'reauth_required'
  | 'not_found'
  | 'conflict'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'invalid_input'
  | 'rate_limited'
  | 'upstream'
  | 'unavailable'
  | 'internal';

export const STATUS: Readonly<Record<AdminErrorCode, number>> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  reauth_required: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  invalid_input: 422,
  rate_limited: 429,
  upstream: 502,
  unavailable: 503,
  internal: 500,
};

export interface AdminErrorBody {
  error: { code: AdminErrorCode; message: string; field?: string; detail?: string };
}

export class AdminError extends Error {
  readonly code: AdminErrorCode;
  readonly field: string | undefined;

  constructor(code: AdminErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'AdminError';
    this.code = code;
    this.field = field;
  }
}

export function errorBody(code: AdminErrorCode, message: string, field?: string): AdminErrorBody {
  return { error: { code, message, ...(field === undefined ? {} : { field }) } };
}

/** Maps a thrown error to the envelope; unexpected errors become `internal` with no detail (logged by the caller). */
export function toAdminError(error: unknown): { status: number; body: AdminErrorBody; expected: boolean } {
  let code: AdminErrorCode = 'internal';
  let message = 'Internal error.';
  let field: string | undefined;
  if (error instanceof AdminError) {
    code = error.code;
    message = error.message;
    field = error.field;
  } else if (error instanceof ReauthRequiredError) {
    // The panel and API clients send the user through `/auth/reauth` (L-093).
    code = 'reauth_required';
    message = error.message;
  } else if (error instanceof ForbiddenError) {
    code = 'forbidden';
    message = error.message;
  } else if (error instanceof StorageError) {
    message = error.message;
    code =
      error.code === 'not_found'
        ? 'not_found'
        : error.code === 'conflict'
          ? 'conflict'
          : error.code === 'invalid_input'
            ? 'invalid_input'
            : 'unavailable';
    if (code === 'invalid_input') {
      const m = /^([a-zA-Z_.]+?)(?::| (?:must|is|cannot|and))/.exec(error.message);
      if (m?.[1] !== undefined) field = m[1];
    }
    if (code === 'unavailable') message = 'Storage is unavailable.';
  } else if (error instanceof UpstreamCheckError) {
    code = 'upstream';
    message = error.message;
  } else if (error instanceof SecretsError && error.code === 'in_use') {
    // "N credential(s) still use version V" / "V is the current key": counts and versions only.
    code = 'conflict';
    message = error.message;
  } else if (error instanceof SecretsError) {
    code = 'unavailable';
    message = 'The server cannot use its master key for this.';
  }
  return { status: STATUS[code], body: errorBody(code, message, field), expected: code !== 'internal' };
}
