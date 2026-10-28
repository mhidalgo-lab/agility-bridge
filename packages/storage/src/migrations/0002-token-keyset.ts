// SPDX-License-Identifier: Apache-2.0
// RELEASED MIGRATIONS NEVER CHANGE (see 0001-init.ts).
import type { Migration } from './types.ts';

export const migration0002: Migration = {
  version: 2,
  name: 'token-keyset',
  statements: [
    // Keyset paging of device tokens, newest first (P4-31): one page reads only the rows it shows.
    'CREATE INDEX access_tokens_created ON access_tokens (created_at, id)',
  ],
};
