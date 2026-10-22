// SPDX-License-Identifier: Apache-2.0
/** The token with its last character replaced by a different one: never equal to the input (a fixed `x` was, 1 in 62). */
export function tamperLast(token: string): string {
  return `${token.slice(0, -1)}${token.endsWith('x') ? 'y' : 'x'}`;
}
