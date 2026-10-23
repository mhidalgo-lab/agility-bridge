// SPDX-License-Identifier: Apache-2.0
// Two first sign-ins for one unbound email through two providers at once (L-185): exactly one wins. Shared by the
// memory, SQLite and D1 runs, so every adapter proves the compare-and-set.
import type { Storage } from '@agility-bridge/storage';
import { EMPTY_LOGIN_POLICY, resolveLoginUser, type VerifiedIdentity } from '../src/index.ts';

const identity = (idp: string, subject: string): VerifiedIdentity => ({
  idp,
  subject,
  email: 'race@example.test',
  emailVerified: true,
  displayName: null,
});

export async function loginRace(
  storage: Storage,
): Promise<{ ok: number; conflict: number; bound: string | null }> {
  await storage.users.create({ id: 'u-race', email: 'race@example.test', role: 'member' });
  const decisions = await Promise.all(
    [identity('google', 'g-1'), identity('github', 'gh-1'), identity('oidc:corp', 'o-1')].map((i) =>
      resolveLoginUser(storage.users, i, EMPTY_LOGIN_POLICY),
    ),
  );
  const row = await storage.users.get('u-race');
  return {
    ok: decisions.filter((d) => d.ok).length,
    conflict: decisions.filter((d) => !d.ok && d.reason === 'identity_conflict').length,
    bound: row?.idp ?? null,
  };
}
