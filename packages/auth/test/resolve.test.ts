// SPDX-License-Identifier: Apache-2.0
// The effective-permission resolver (P2-04, ADR-0008, THREAT_MODEL T3, A5).
import { describe, expect, it } from 'vitest';
import { type AccessSettings, type DenyReason, type Principal, resolveAccess } from '../src/index.ts';
import {
  credential,
  device,
  grant,
  instance,
  NOW,
  records,
  SETTINGS,
  TOOLS,
  token,
  user,
  workspace,
} from './helpers/access.ts';

function decide(
  r = records(),
  principal: Principal = device(),
  slug = 'team-a',
  settings: AccessSettings = SETTINGS,
) {
  return resolveAccess(principal, slug, r, settings, NOW);
}

function denied(reason: DenyReason, r = records(), principal: Principal = device(), slug = 'team-a') {
  expect(decide(r, principal, slug)).toEqual({ ok: false, reason });
}

function allowed(r = records(), principal: Principal = device(), settings: AccessSettings = SETTINGS) {
  const d = decide(r, principal, 'team-a', settings);
  if (!d.ok) throw new Error(`denied: ${d.reason}`);
  return d.access;
}

describe('resolveAccess: what a valid grant gets', () => {
  it('every read tool of the workspace, its projects, its limits and the personal credential', () => {
    const a = allowed();
    expect(a.tools).toEqual([
      'whoami',
      'list_projects',
      'query_assets',
      'get_assets',
      'search_work_items',
      'list_teams',
    ]);
    expect(a.writeTools).toEqual([]);
    expect(a.projects).toEqual({ allowed: ['Scope:1001', 'Scope:1002'], includeChildren: true });
    expect(a.credential).toEqual({
      id: 'c-alice',
      kind: 'personal',
      sealed: { tokenCiphertext: 'Y2lwaGVy', tokenIv: 'aXY', keyVersion: 1 },
    });
    expect(a.workspace).toEqual({ id: 'w-1', slug: 'team-a', name: 'Team A' });
    expect(a.instance.baseUrl).toBe('https://agility.example.test/Main');
    expect(a.grant).toEqual({ id: 'g-alice', userId: 'u-alice', label: null });
    expect(a.tokenId).toBe('t-1');
    expect(a.limits.maxRows).toBe(100);
    expect(a.expiresAt).toBeNull();
    expect(a.warnings).toEqual([]);
    expect(Object.isFrozen(a)).toBe(true);
  });

  it('a service grant uses the workspace default (shared) credential', () => {
    const a = allowed(
      records({
        grant: grant({ userId: null, label: 'CI bot', credentialId: null }),
        user: null,
        credential: credential({ id: 'c-shared', ownerUserId: null }),
      }),
    );
    expect(a.credential.kind).toBe('shared');
    expect(a.credential.id).toBe('c-shared');
  });

  it('intersects tools, projects and asset types, and tightens limits', () => {
    const a = allowed(
      records({
        workspace: workspace({
          enabledTools: ['whoami', 'query_assets', 'get_assets', 'list_teams'],
          assetTypes: { allow: ['Story', 'Defect', 'Task'], deny: ['Request'] },
          limits: { maxRows: 200, memberEmails: true, maxFields: 20 },
        }),
        grant: grant({
          tools: ['whoami', 'get_assets', 'search_work_items'],
          scopeIds: ['Scope:1002', 'Scope:9999'],
          assetTypes: { allow: ['Defect', 'Epic'], deny: ['Issue'] },
          limits: { maxRows: 500, maxFields: 10, memberEmails: false },
        }),
      }),
    );
    expect(a.tools).toEqual(['whoami', 'get_assets']);
    expect(a.projects.allowed).toEqual(['Scope:1002']);
    expect(a.assetTypes).toEqual({ allow: ['Defect'], deny: ['Request', 'Issue'] });
    expect(a.limits).toMatchObject({ maxRows: 200, maxFields: 10, memberEmails: false });
    expect(a.warnings).toEqual([
      'The grant names projects outside the workspace: Scope:9999.',
      "The grant's maxRows (500) is above the workspace's (200); 200 applies.",
      'The grant names tools the workspace does not enable: search_work_items.',
    ]);
  });

  it('drops the generic query tools when the workspace or the grant turns them off', () => {
    expect(
      allowed(records({ workspace: workspace({ limits: { genericQuery: false } }) })).tools,
    ).not.toContain('query_assets');
    expect(allowed(records({ grant: grant({ limits: { genericQuery: false } }) })).tools).not.toContain(
      'get_assets',
    );
  });

  it('applies the deployment ceilings to what a workspace asks for', () => {
    const settings: AccessSettings = {
      ...SETTINGS,
      limits: { ...SETTINGS.limits, ceilings: { maxResponseBytes: 524_288 } },
    };
    const a = allowed(
      records({ workspace: workspace({ limits: { maxResponseBytes: 8_388_608 } }) }),
      device(),
      settings,
    );
    expect(a.limits.maxResponseBytes).toBe(524_288);
  });

  it('expires with the earlier of the token and the grant', () => {
    expect(
      allowed(records({ grant: grant({ expiresAt: NOW + 50 }) }), device({ expiresAt: NOW + 100 })).expiresAt,
    ).toBe(NOW + 50);
    expect(allowed(records(), device({ expiresAt: NOW + 100 })).expiresAt).toBe(NOW + 100);
  });

  it('warns about projects the credential could not see at its last validation, without hiding them', () => {
    const a = allowed(records({ credential: credential({ reachableScopeIds: ['Scope:1001'] }) }));
    expect(a.projects.allowed).toEqual(['Scope:1001', 'Scope:1002']);
    expect(a.warnings).toEqual([
      "The credential's member could not see Scope:1002 when it was last validated.",
    ]);
  });
});

describe('resolveAccess: denies by default', () => {
  it('checks the audience first: a token for another workspace is rejected before anything else', () => {
    denied('wrong_workspace', records(), device({ revokedAt: NOW }), 'team-b');
    denied('wrong_workspace', records({ grant: null, credential: null }), device(), 'team-b');
    denied('wrong_workspace', records(), {
      kind: 'oauth',
      grantId: 'g-alice',
      workspaceId: 'w-2',
      writeScope: false,
      expiresAt: null,
    });
  });

  const cases: [DenyReason, () => ReturnType<typeof records>, Principal?][] = [
    ['workspace_missing', () => records({ workspace: null })],
    ['token_revoked', () => records(), device({ revokedAt: NOW - 1 })],
    ['token_expired', () => records(), device({ expiresAt: NOW })],
    ['grant_missing', () => records({ grant: null })],
    ['grant_missing', () => records(), device({ grantId: 'g-other' })],
    ['grant_missing', () => records({ grant: grant({ workspaceId: 'w-2' }) })],
    ['grant_revoked', () => records({ grant: grant({ revokedAt: NOW - 1 }) })],
    ['grant_expired', () => records({ grant: grant({ expiresAt: NOW - 1 }) })],
    ['workspace_disabled', () => records({ workspace: workspace({ disabledAt: NOW - 1 }) })],
    ['instance_missing', () => records({ instance: null })],
    ['instance_missing', () => records({ instance: instance({ id: 'i-2' }) })],
    ['instance_disabled', () => records({ instance: instance({ disabledAt: NOW - 1 }) })],
    ['user_missing', () => records({ user: null })],
    ['user_missing', () => records({ user: user({ id: 'u-bob' }) })],
    ['user_disabled', () => records({ user: user({ disabledAt: NOW - 1 }) })],
    ['credential_missing', () => records({ credential: null })],
    ['credential_missing', () => records({ credential: credential({ id: 'c-other' }) })],
    [
      'credential_missing',
      () =>
        records({
          grant: grant({ credentialId: null }),
          workspace: workspace({ defaultCredentialId: null }),
        }),
    ],
    ['credential_revoked', () => records({ credential: credential({ revokedAt: NOW - 1 }) })],
    [
      'credential_unvalidated',
      () => records({ credential: credential({ validationStatus: 'unvalidated' }) }),
    ],
    ['credential_unvalidated', () => records({ credential: credential({ validationStatus: 'invalid' }) })],
    ['credential_mismatch', () => records({ credential: credential({ instanceId: 'i-2' }) })],
    // Another user's personal token (L-065), or a personal one presented as the shared default.
    ['credential_mismatch', () => records({ credential: credential({ ownerUserId: 'u-bob' }) })],
    [
      'credential_mismatch',
      () =>
        records({
          grant: grant({ credentialId: null }),
          workspace: workspace({ defaultCredentialId: 'c-alice' }),
        }),
    ],
    ['credential_mismatch', () => records({ grant: grant({ userId: null, label: 'bot' }), user: null })],
    ['malformed_policy', () => records({ workspace: workspace({ limits: { maxRows: 'all' } }) })],
    ['malformed_policy', () => records({ workspace: workspace({ allowedScopeIds: ['Scope:1', 'Epic:2'] }) })],
    ['malformed_policy', () => records({ workspace: workspace({ allowedScopeIds: [] }) })],
    ['malformed_policy', () => records({ grant: grant({ tools: ['Bad Name'] }) })],
    ['malformed_policy', () => records({ grant: grant({ scopeIds: [] }) })],
    ['malformed_policy', () => records({ grant: grant({ limits: { maxRows: -1 } }) })],
    ['malformed_policy', () => records({ grant: grant({ limits: { unknown: 1 } }) })],
    ['malformed_policy', () => records({ workspace: workspace({ writePolicy: { enabled: 'yes' } }) })],
    ['no_projects', () => records({ grant: grant({ scopeIds: ['Scope:9999'] }) })],
    ['no_tools', () => records({ grant: grant({ tools: ['add_comment'] }) })],
    ['no_tools', () => records({ workspace: workspace({ enabledTools: ['nonexistent_tool'] }) })],
  ];

  it.each(cases.map(([reason, r, p], i) => [`${i}: ${reason}`, reason, r, p] as const))(
    '%s',
    (_n, reason, r, p) => {
      denied(reason, r(), p ?? device());
    },
  );

  it('an expired OAuth session denies', () => {
    denied('token_expired', records(), {
      kind: 'oauth',
      grantId: 'g-alice',
      workspaceId: 'w-1',
      writeScope: true,
      expiresAt: NOW,
    });
  });
});

describe('resolveAccess: write tools (ADR-0008, ADR-0013)', () => {
  const writeRecords = (
    over: {
      ws?: Parameters<typeof workspace>[0];
      g?: Parameters<typeof grant>[0];
      c?: Parameters<typeof credential>[0];
    } = {},
  ) =>
    records({
      workspace: workspace({
        enabledTools: ['whoami', 'add_comment', 'close_asset'],
        writePolicy: { enabled: true },
        ...over.ws,
      }),
      grant: grant({ tools: ['whoami', 'add_comment'], ...over.g }),
      credential: credential(over.c),
    });

  it('are granted only when the server, the workspace and both tool lists allow them, with the own credential', () => {
    const a = allowed(writeRecords());
    expect(a.tools).toEqual(['whoami', 'add_comment']);
    expect(a.writeTools).toEqual(['add_comment']);
  });

  it('"all tools" never includes a write tool', () => {
    expect(allowed(writeRecords({ ws: { enabledTools: null } })).writeTools).toEqual([]);
    expect(allowed(writeRecords({ g: { tools: null } })).writeTools).toEqual([]);
  });

  it('never with a shared credential (A5), without the server switch, the workspace switch or OAuth mcp:write', () => {
    const shared = allowed(
      records({
        workspace: workspace({ enabledTools: ['whoami', 'add_comment'], writePolicy: { enabled: true } }),
        grant: grant({ credentialId: 'c-shared', tools: ['whoami', 'add_comment'] }),
        credential: credential({ id: 'c-shared', ownerUserId: null }),
      }),
    );
    expect(shared.writeTools).toEqual([]);
    expect(shared.tools).toEqual(['whoami']);
    expect(shared.warnings).toEqual([
      "add_comment needs the user's own credential: shared credentials are read-only.",
    ]);
    expect(allowed(writeRecords(), device(), { ...SETTINGS, writesEnabled: false }).writeTools).toEqual([]);
    expect(allowed(writeRecords({ ws: { writePolicy: {} } })).writeTools).toEqual([]);
    const oauth = (writeScope: boolean): Principal => ({
      kind: 'oauth',
      grantId: 'g-alice',
      workspaceId: 'w-1',
      writeScope,
      expiresAt: null,
    });
    expect(allowed(writeRecords(), oauth(false)).writeTools).toEqual([]);
    expect(allowed(writeRecords(), oauth(true)).writeTools).toEqual(['add_comment']);
  });

  it('a tool the deployment does not know is ignored with a warning', () => {
    const a = allowed(records({ grant: grant({ tools: ['whoami', 'drop_everything'] }) }));
    expect(a.tools).toEqual(['whoami']);
    expect(a.warnings).toContain('Unknown tools ignored: drop_everything.');
  });

  it('the tool catalogue the tests use covers every kind', () => {
    expect(new Set([...TOOLS.values()].map((t) => t.kind))).toEqual(
      new Set(['read', 'write', 'destructive']),
    );
    expect(token().grantId).toBe('g-alice');
  });
});
