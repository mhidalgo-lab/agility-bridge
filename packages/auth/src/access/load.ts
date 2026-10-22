// SPDX-License-Identifier: Apache-2.0
import type { Storage } from '@agility-bridge/storage';
import type { AccessRecords } from './resolve.ts';

/**
 * Loads the records `resolveAccess` needs for one grant. Reads only; whatever is missing comes back `null` and the
 * resolver denies. Device tokens use `accessTokens.bundleByHash` instead: the same records in one round trip (P3-02).
 */
export async function loadAccessRecords(storage: Storage, grantId: string): Promise<AccessRecords> {
  const grant = await storage.grants.get(grantId);
  if (grant === null) return { grant: null, workspace: null, instance: null, credential: null, user: null };
  const [workspace, user] = await Promise.all([
    storage.workspaces.get(grant.workspaceId),
    grant.userId === null ? Promise.resolve(null) : storage.users.get(grant.userId),
  ]);
  if (workspace === null) return { grant, workspace: null, instance: null, credential: null, user };
  const credentialId = grant.credentialId ?? workspace.defaultCredentialId;
  const [instance, credential] = await Promise.all([
    storage.instances.get(workspace.instanceId),
    credentialId === null ? Promise.resolve(null) : storage.credentials.get(credentialId),
  ]);
  return { grant, workspace, instance, credential, user };
}
