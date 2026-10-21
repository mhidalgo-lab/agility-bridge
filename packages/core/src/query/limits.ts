// SPDX-License-Identifier: Apache-2.0
import { AbError, ErrorCode } from '../errors.ts';

/** AB_LIMIT_QUERY naming the limit and its unit (L-042), with numbers we computed (local details). */
export function limitError(limit: string, max: number, unit: string, requested?: number): AbError {
  return new AbError(
    ErrorCode.LimitQuery,
    `The request exceeds ${limit}: at most ${max} ${unit}${requested === undefined ? '' : ` (asked for ${requested})`}.`,
    {
      hint: 'Narrow the request: fewer fields, filters or groups, a shorter window or a smaller page.',
      details: { limit, max, unit, ...(requested === undefined ? {} : { requested }) },
      localDetails: true,
    },
  );
}

export function invalid(message: string, hint?: string): AbError {
  return new AbError(ErrorCode.InputInvalid, message, hint === undefined ? {} : { hint });
}
