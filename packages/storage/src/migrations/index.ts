// SPDX-License-Identifier: Apache-2.0
// The embedded migration history (L-071): append only, versions consecutive from 1.
import { migration0001 } from './0001-init.ts';
import type { Migration } from './types.ts';

export type { Migration } from './types.ts';

export const MIGRATIONS: readonly Migration[] = Object.freeze([migration0001]);
