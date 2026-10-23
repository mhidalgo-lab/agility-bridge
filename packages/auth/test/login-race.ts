// SPDX-License-Identifier: Apache-2.0
// Two first sign-ins for one unbound email through two providers at once (L-185): exactly one wins. Shared by the
// memory, SQLite and D1 runs, so every adapter proves the compare-and-set.
import type { Storage } from '@agility-bridge/storage';
import {
  accessServices,
  EMPTY_LOGIN_POLICY,
  guardedServices,
  resolveLoginUser,
  type VerifiedIdentity,
} from '../src/index.ts';

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

/**
 * Four concurrent owner unbinds of one bound user (P4-12, L-220): one wins, the rest conflict and write nothing; a
 * first sign-in then binds another identity, and an unbind confirmed against the old binding is refused.
 */
export async function unbindRace(
  storage: Storage,
  userId: string,
  email: string,
): Promise<{ ok: number; conflict: number; later: 'conflict' | 'applied' }> {
  const tools = new Map();
  const svc = accessServices({ storage, tools });
  const actor = { kind: 'break_glass' } as const;
  const before = await storage.users.get(userId);
  const settled = await Promise.all(
    [1, 2, 3, 4].map(() =>
      guardedServices(svc, { storage, tools }, actor)
        .users.unbind(userId, email)
        .then(
          () => 'ok' as const,
          (e: unknown) =>
            (e as Error).name === 'ConflictError' ? ('conflict' as const) : ('other' as const),
        ),
    ),
  );
  await storage.users.bind(userId, 'github', 'gh-new');
  const later = await svc.users
    .unbind(userId, { idp: before?.idp as string, idpSubject: before?.idpSubject as string })
    .then(
      () => 'applied' as const,
      () => 'conflict' as const,
    );
  return {
    ok: settled.filter((r) => r === 'ok').length,
    conflict: settled.filter((r) => r === 'conflict').length,
    later,
  };
}
