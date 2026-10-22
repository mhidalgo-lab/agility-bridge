// SPDX-License-Identifier: Apache-2.0
// Credential tokens at rest (ADR-0007, THREAT_MODEL T7): sealing, opening, key-check values at boot, rotation with
// per-row compare-and-swap in resumable batches, and retirement of the previous version. Audit rows carry ids,
// versions and reasons, never key material or tokens.
import type { Credential, SealedToken, Storage } from '@agility-bridge/storage';
import { KeyPurpose, type Keyring, type Sealed, SecretsError, timingSafeEqual } from './keyring.ts';

const KCV_KEY = (version: number) => `crypto:kcv:v${version}`;
const RETIRED_KEY = (version: number) => `crypto:retired:v${version}`;

/** At most the last 4 characters, and nothing for short values. */
export function tokenHint(token: string): string {
  return token.length >= 16 ? token.slice(-4) : '';
}

/** Seals an Agility access token for the credential `credentialId` (additional data: `id | key version`). */
export async function sealCredentialToken(
  keyring: Keyring,
  credentialId: string,
  token: string,
): Promise<SealedToken & { tokenHint: string }> {
  if (typeof token !== 'string' || token.length === 0) throw new TypeError('An access token is required.');
  const sealed = await keyring.seal(KeyPurpose.Credentials, credentialId, token);
  return {
    tokenCiphertext: sealed.ciphertext,
    tokenIv: sealed.iv,
    keyVersion: sealed.keyVersion,
    tokenHint: tokenHint(token),
  };
}

const toSealed = (c: SealedToken): Sealed => ({
  ciphertext: c.tokenCiphertext,
  iv: c.tokenIv,
  keyVersion: c.keyVersion,
});

/** Decrypts a credential's token. Swapping ciphertexts between credentials or versions fails (`decrypt_failed`). */
export function openCredentialToken(
  keyring: Keyring,
  credential: Pick<Credential, 'id'> & SealedToken,
): Promise<string> {
  return keyring.open(KeyPurpose.Credentials, credential.id, toSealed(credential));
}

export interface KeyringCheck {
  /** Non-fatal findings for the operator log (no key material). */
  warnings: string[];
}

/**
 * Boot check: every loaded version's key-check value must match the one recorded the first time that version was
 * used, so a wrong key is refused before it decrypts (or seals) anything, and a version number is never reused for
 * other key material. The current version must not be retired.
 */
export async function verifyKeyring(storage: Storage, keyring: Keyring): Promise<KeyringCheck> {
  const warnings: string[] = [];
  for (const version of keyring.versions) {
    const kcv = await keyring.keyCheckValue(version);
    if (!(await storage.kv.setIfAbsent(KCV_KEY(version), kcv))) {
      const recorded = await storage.kv.get(KCV_KEY(version));
      if (recorded === null || !timingSafeEqual(recorded, kcv)) {
        throw new SecretsError(
          'wrong_key',
          `Master key version ${version} is not the key this database was encrypted with. Use the original key; a ` +
            'version number can never be reused for a different key.',
        );
      }
    }
  }
  if ((await storage.kv.get(RETIRED_KEY(keyring.currentVersion))) !== null) {
    throw new SecretsError(
      'retired',
      `Master key version ${keyring.currentVersion} was retired; use a newer key.`,
    );
  }
  for (const version of keyring.versions) {
    if (version !== keyring.currentVersion && (await storage.kv.get(RETIRED_KEY(version))) !== null) {
      warnings.push(`Master key version ${version} is retired; remove AB_MASTER_KEY_PREVIOUS.`);
    }
  }
  const stranded = (await keyStatus(storage, keyring)).filter((v) => !v.loaded && v.credentials > 0);
  for (const v of stranded) {
    warnings.push(
      `${v.credentials} credential(s) use master key version ${v.version}, which is not loaded; they cannot be used ` +
        'until that key is provided (as AB_MASTER_KEY_PREVIOUS for a rotation) or their tokens are entered again.',
    );
  }
  return { warnings };
}

export interface KeyVersionStatus {
  version: number;
  credentials: number;
  loaded: boolean;
  current: boolean;
  retired: boolean;
}

/** Credentials per key version, and which versions are loaded, current or retired. */
export async function keyStatus(storage: Storage, keyring: Keyring): Promise<KeyVersionStatus[]> {
  const counts = new Map<number, number>();
  for (const c of await storage.credentials.list())
    counts.set(c.keyVersion, (counts.get(c.keyVersion) ?? 0) + 1);
  for (const v of keyring.versions) if (!counts.has(v)) counts.set(v, 0);
  const out: KeyVersionStatus[] = [];
  for (const [version, credentials] of [...counts].sort((a, b) => a[0] - b[0])) {
    out.push({
      version,
      credentials,
      loaded: keyring.has(version),
      current: version === keyring.currentVersion,
      retired: (await storage.kv.get(RETIRED_KEY(version))) !== null,
    });
  }
  return out;
}

export interface RotationOptions {
  /** Why (recorded in the audit log), e.g. "scheduled" or "suspected leak". At most 200 characters. */
  reason: string;
  /** Rows per batch (default 100). */
  batchSize?: number;
  /** Stop after this many batches (default: until done); the next run resumes. */
  maxBatches?: number;
  now?: () => number;
  /** Audit attribution, e.g. the admin user or `cli`. */
  actor?: { userId?: string; via?: string };
}

export interface RotationResult {
  rotated: number;
  /** Changed by someone else during the run (compare-and-swap lost); a later run picks them up. */
  skipped: number;
  /** Could not be decrypted, or use a version that is not loaded. */
  failed: { id: string; keyVersion: number; reason: 'key_unavailable' | 'decrypt_failed' }[];
  /** Rows still not on the current version. */
  remaining: number;
}

/**
 * Re-encrypts every credential still on an older loaded version with the current key. Each row is replaced only if it
 * still holds the ciphertext that was decrypted (compare-and-swap), so concurrent edits and interrupted runs are safe:
 * run it again to resume.
 */
export async function rotateCredentialKeys(
  storage: Storage,
  keyring: Keyring,
  options: RotationOptions,
): Promise<RotationResult> {
  const reason = String(options.reason ?? '').slice(0, 200);
  if (reason.length === 0) throw new TypeError('A rotation reason is required for the audit log.');
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 100, 1_000));
  const now = options.now ?? Date.now;
  const result: RotationResult = { rotated: 0, skipped: 0, failed: [], remaining: 0 };
  // Rows that failed or lost a compare-and-swap are not retried in this run, so contention cannot loop forever.
  const doneWith = new Set<string>();
  const details = (from: number) => ({
    fromVersion: from,
    toVersion: keyring.currentVersion,
    reason,
    ...(options.actor?.via !== undefined ? { via: options.actor.via } : {}),
  });

  for (let batch = 0; options.maxBatches === undefined || batch < options.maxBatches; batch++) {
    const pending = (await storage.credentials.list())
      .filter((c) => c.keyVersion !== keyring.currentVersion && !doneWith.has(c.id))
      .slice(0, batchSize);
    if (pending.length === 0) break;
    for (const c of pending) {
      const expected: SealedToken = {
        tokenCiphertext: c.tokenCiphertext,
        tokenIv: c.tokenIv,
        keyVersion: c.keyVersion,
      };
      let token: string;
      try {
        token = await openCredentialToken(keyring, c);
      } catch (error) {
        const reasonCode =
          error instanceof SecretsError && error.code === 'key_unavailable' ? error.code : 'decrypt_failed';
        doneWith.add(c.id);
        result.failed.push({ id: c.id, keyVersion: c.keyVersion, reason: reasonCode });
        await storage.audit.append({
          id: crypto.randomUUID(),
          ts: now(),
          kind: 'admin',
          action: 'credential.rekey',
          status: 'error',
          errorCode: reasonCode,
          userId: options.actor?.userId ?? null,
          instanceId: c.instanceId,
          targetType: 'credential',
          targetId: c.id,
          details: details(c.keyVersion),
        });
        continue;
      }
      const sealed = await sealCredentialToken(keyring, c.id, token);
      const next: SealedToken = {
        tokenCiphertext: sealed.tokenCiphertext,
        tokenIv: sealed.tokenIv,
        keyVersion: sealed.keyVersion,
      };
      if (await storage.credentials.replaceSecret(c.id, expected, next)) {
        result.rotated++;
        await storage.audit.append({
          id: crypto.randomUUID(),
          ts: now(),
          kind: 'admin',
          action: 'credential.rekey',
          status: 'ok',
          userId: options.actor?.userId ?? null,
          instanceId: c.instanceId,
          targetType: 'credential',
          targetId: c.id,
          details: details(c.keyVersion),
        });
      } else {
        doneWith.add(c.id);
        result.skipped++;
      }
    }
  }
  result.remaining = (await storage.credentials.list()).filter(
    (c) => c.keyVersion !== keyring.currentVersion,
  ).length;
  return result;
}

/**
 * Marks a key version as retired once no credential uses it; a retired version is refused as the current key at
 * boot. The previous key can then be removed from the configuration.
 */
export async function retireKeyVersion(
  storage: Storage,
  keyring: Keyring,
  version: number,
  options: {
    reason: string;
    now?: () => number;
    actor?: { userId?: string; via?: string };
    /** Write the audit row here (default); the admin API records the change itself (P3-13). */
    record?: boolean;
  },
): Promise<void> {
  if (version === keyring.currentVersion) {
    throw new SecretsError('in_use', `Master key version ${version} is the current key.`);
  }
  const users = await storage.credentials.list({ keyVersion: version });
  if (users.length > 0) {
    throw new SecretsError(
      'in_use',
      `${users.length} credential(s) still use master key version ${version}; rotate them first.`,
    );
  }
  const now = options.now ?? Date.now;
  await storage.kv.set(RETIRED_KEY(version), String(now()));
  if (options.record === false) return;
  await storage.audit.append({
    id: crypto.randomUUID(),
    ts: now(),
    kind: 'admin',
    action: 'crypto.retire_key',
    status: 'ok',
    userId: options.actor?.userId ?? null,
    targetType: 'key_version',
    targetId: String(version),
    details: {
      reason: String(options.reason ?? '').slice(0, 200),
      ...(options.actor?.via !== undefined ? { via: options.actor.via } : {}),
    },
  });
}
