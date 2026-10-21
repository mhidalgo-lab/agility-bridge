// SPDX-License-Identifier: Apache-2.0
// Invisible characters for tests, built from code points: the formatter would turn `\u` escapes in string literals
// into raw characters, and raw bidi controls in source are exactly what reviewers cannot see (Trojan Source).
export const NUL: string = String.fromCodePoint(0x0000);
export const RLO: string = String.fromCodePoint(0x202e);
export const LRI: string = String.fromCodePoint(0x2066);
export const ZWSP: string = String.fromCodePoint(0x200b);
export const BOM: string = String.fromCodePoint(0xfeff);
export const LS: string = String.fromCodePoint(0x2028);
