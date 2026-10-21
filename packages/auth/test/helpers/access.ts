// SPDX-License-Identifier: Apache-2.0
// Valid access records and settings for resolver tests; each test breaks one thing at a time.
import { DEFAULT_LIMITS } from '@agility-bridge/core';
import type { AccessToken, Credential, Grant, Instance, User, Workspace } from '@agility-bridge/storage';
import type { AccessRecords, AccessSettings, Principal, ToolInfo } from '../../src/index.ts';

export const NOW = 1_760_000_000_000;

export const TOOLS: ReadonlyMap<string, ToolInfo> = new Map<string, ToolInfo>([
  ['whoami', { kind: 'read', group: 'core' }],
  ['list_projects', { kind: 'read', group: 'core' }],
  ['query_assets', { kind: 'read', group: 'query' }],
  ['get_assets', { kind: 'read', group: 'query' }],
  ['search_work_items', { kind: 'read', group: 'work' }],
  ['list_teams', { kind: 'read', group: 'planning' }],
  ['add_comment', { kind: 'write', group: 'collaboration' }],
  ['close_asset', { kind: 'destructive', group: 'work' }],
]);

export const SETTINGS: AccessSettings = {
  tools: TOOLS,
  writesEnabled: true,
  limits: {
    defaults: { ...DEFAULT_LIMITS, maxResponseBytes: 8 * 1024 * 1024, callBudget: 1_000, genericQuery: true },
    ceilings: {},
  },
};

const stamp = { createdAt: NOW - 1_000, updatedAt: NOW - 1_000 };

export function user(over: Partial<User> = {}): User {
  return {
    id: 'u-alice',
    email: 'alice@example.test',
    displayName: null,
    idp: null,
    idpSubject: null,
    role: 'member',
    disabledAt: null,
    ...stamp,
    ...over,
  };
}

export function instance(over: Partial<Instance> = {}): Instance {
  return {
    id: 'i-1',
    label: 'Main',
    baseUrl: 'https://agility.example.test/Main',
    tls: null,
    numberPrefixes: null,
    metaFingerprint: null,
    disabledAt: null,
    ...stamp,
    ...over,
  };
}

export function credential(over: Partial<Credential> = {}): Credential {
  return {
    id: 'c-alice',
    instanceId: 'i-1',
    ownerUserId: 'u-alice',
    label: 'Alice',
    tokenCiphertext: 'Y2lwaGVy',
    tokenIv: 'aXY',
    keyVersion: 1,
    tokenHint: 'wxyz',
    validationStatus: 'valid',
    validationErrorCode: null,
    validatedAt: NOW - 500,
    memberOid: 'Member:20',
    memberName: 'Alice',
    memberUsername: 'alice',
    reachableScopeIds: null,
    revokedAt: null,
    ...stamp,
    ...over,
  };
}

export function workspace(over: Partial<Workspace> = {}): Workspace {
  return {
    id: 'w-1',
    slug: 'team-a',
    name: 'Team A',
    instanceId: 'i-1',
    allowedScopeIds: ['Scope:1001', 'Scope:1002'],
    includeChildScopes: true,
    assetTypes: null,
    enabledTools: null,
    limits: {},
    defaultCredentialId: 'c-shared',
    writePolicy: {},
    disabledAt: null,
    ...stamp,
    ...over,
  };
}

export function grant(over: Partial<Grant> = {}): Grant {
  return {
    id: 'g-alice',
    workspaceId: 'w-1',
    userId: 'u-alice',
    label: null,
    credentialId: 'c-alice',
    tools: null,
    scopeIds: null,
    assetTypes: null,
    limits: {},
    rateLimit: null,
    expiresAt: null,
    revokedAt: null,
    ...stamp,
    ...over,
  };
}

export function token(over: Partial<AccessToken> = {}): AccessToken {
  return {
    id: 't-1',
    grantId: 'g-alice',
    prefix: 'ab_live',
    tokenHash: 'a'.repeat(64),
    label: 'laptop',
    createdAt: NOW - 1_000,
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    ...over,
  };
}

export function records(over: Partial<AccessRecords> = {}): AccessRecords {
  return {
    grant: grant(),
    workspace: workspace(),
    instance: instance(),
    credential: credential(),
    user: user(),
    ...over,
  };
}

export const device = (over: Partial<AccessToken> = {}): Principal => ({
  kind: 'device_token',
  token: token(over),
});
