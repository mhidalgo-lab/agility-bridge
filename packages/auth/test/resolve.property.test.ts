// SPDX-License-Identifier: Apache-2.0
// Properties of the resolver over random policies and record states (P2-04 acceptance, L-063, L-123): the effective
// set never exceeds any of its inputs, and every missing, disabled, revoked, expired, unvalidated or malformed input
// denies.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { propertyParams } from '../../core/test/harness/property.ts';
import { type AccessRecords, type AccessSettings, type Principal, resolveAccess } from '../src/index.ts';
import {
  credential,
  grant,
  instance,
  NOW,
  SETTINGS,
  TOOLS,
  token,
  user,
  workspace,
} from './helpers/access.ts';

const TOOL_NAMES = [...TOOLS.keys(), 'unknown_tool'];
const SCOPES = ['Scope:1', 'Scope:2', 'Scope:3', 'Scope:4'];
const TYPES = ['Story', 'Defect', 'Task', 'Epic', 'Request'];
const NUMBER_LIMITS = [
  'defaultRows',
  'maxRows',
  'maxFields',
  'maxNestingDepth',
  'maxAggregations',
  'maxAnyOfGroups',
  'maxAsOfAgeDays',
  'maxTimeRangeDays',
  'callBudget',
] as const;

const subset = <T>(items: readonly T[]) => fc.subarray([...items]);
const maybe = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: null });
const limits = fc.record(
  {
    defaultRows: fc.integer({ min: 1, max: 1_000 }),
    maxRows: fc.integer({ min: 1, max: 1_000 }),
    maxFields: fc.integer({ min: 1, max: 200 }),
    maxNestingDepth: fc.integer({ min: 0, max: 5 }),
    maxAggregations: fc.integer({ min: 0, max: 50 }),
    maxAnyOfGroups: fc.integer({ min: 0, max: 20 }),
    maxAsOfAgeDays: fc.integer({ min: 0, max: 3_650 }),
    maxTimeRangeDays: fc.integer({ min: 1, max: 3_660 }),
    callBudget: fc.integer({ min: 1, max: 10_000 }),
    memberEmails: fc.boolean(),
    genericQuery: fc.boolean(),
    attachmentDownload: fc.boolean(),
    reports: fc.boolean(),
  },
  { requiredKeys: [] },
);
const assetTypes = maybe(fc.record({ allow: subset(TYPES), deny: subset(TYPES) }, { requiredKeys: [] }));

/** A policy-valid world: random tools, projects, types, limits, credential kind and switches. */
const world = fc.record({
  wsTools: maybe(subset(TOOL_NAMES.filter((t) => t !== 'unknown_tool'))),
  grantTools: maybe(subset(TOOL_NAMES)),
  wsScopes: subset(SCOPES).filter((s) => s.length > 0),
  grantScopes: maybe(subset(SCOPES).filter((s) => s.length > 0)),
  wsTypes: assetTypes,
  grantTypes: assetTypes,
  wsLimits: limits,
  grantLimits: limits,
  shared: fc.boolean(),
  writesEnabled: fc.boolean(),
  wsWrites: fc.boolean(),
  oauthWrite: fc.option(fc.boolean(), { nil: undefined }),
  tokenExpires: maybe(fc.integer({ min: NOW + 1, max: NOW + 1e9 })),
  grantExpires: maybe(fc.integer({ min: NOW + 1, max: NOW + 1e9 })),
});
type World = typeof world extends fc.Arbitrary<infer T> ? T : never;

function build(w: World) {
  const cred = w.shared ? credential({ id: 'c-shared', ownerUserId: null }) : credential();
  const records = {
    workspace: workspace({
      allowedScopeIds: w.wsScopes,
      enabledTools: w.wsTools,
      assetTypes: w.wsTypes,
      limits: w.wsLimits,
      writePolicy: { enabled: w.wsWrites },
    }),
    grant: grant({
      credentialId: cred.id,
      tools: w.grantTools,
      scopeIds: w.grantScopes,
      assetTypes: w.grantTypes,
      limits: w.grantLimits,
      expiresAt: w.grantExpires,
    }),
    instance: instance(),
    credential: cred,
    user: user(),
  };
  const principal: Principal =
    w.oauthWrite === undefined
      ? { kind: 'device_token', token: token({ expiresAt: w.tokenExpires }) }
      : {
          kind: 'oauth',
          tokenId: 'oauth_test',
          clientId: 'client-1',
          grantId: 'g-alice',
          workspaceId: 'w-1',
          writeScope: w.oauthWrite,
          expiresAt: w.tokenExpires,
        };
  const settings: AccessSettings = { ...SETTINGS, writesEnabled: w.writesEnabled };
  return { records, principal, settings };
}

describe('resolveAccess properties', () => {
  it('the effective access never exceeds the workspace, the grant or the deployment', () => {
    fc.assert(
      fc.property(world, (w) => {
        const { records, principal, settings } = build(w);
        const d = resolveAccess(principal, 'team-a', records, settings, NOW);
        if (!d.ok) {
          expect(['no_projects', 'no_tools']).toContain(d.reason);
          return;
        }
        const a = d.access;
        const known = (n: string) => TOOLS.has(n);
        const wsTools = w.wsTools ?? [...TOOLS.keys()].filter((n) => TOOLS.get(n)?.kind === 'read');
        for (const t of a.tools) {
          expect(known(t)).toBe(true);
          expect(wsTools).toContain(t);
          if (w.grantTools !== null) expect(w.grantTools).toContain(t);
        }
        // Write tools: only with every condition, and only when both lists name them explicitly.
        for (const t of a.writeTools) {
          expect(a.tools).toContain(t);
          expect(TOOLS.get(t)?.kind).not.toBe('read');
          expect(w.shared).toBe(false);
          expect(w.writesEnabled && w.wsWrites).toBe(true);
          expect(w.oauthWrite !== false).toBe(true);
          expect(w.wsTools).toContain(t);
          expect(w.grantTools).toContain(t);
        }
        for (const t of a.tools) if (TOOLS.get(t)?.kind !== 'read') expect(a.writeTools).toContain(t);
        // Projects: a subset of both.
        for (const s of a.projects.allowed) {
          expect(w.wsScopes).toContain(s);
          if (w.grantScopes !== null) expect(w.grantScopes).toContain(s);
        }
        // Asset types: allow within both allows, deny covers both denies.
        for (const t of a.assetTypes.allow ?? []) {
          if (w.wsTypes?.allow !== undefined) expect(w.wsTypes.allow).toContain(t);
          if (w.grantTypes?.allow !== undefined) expect(w.grantTypes.allow).toContain(t);
        }
        if (w.wsTypes?.allow !== undefined || w.grantTypes?.allow !== undefined)
          expect(a.assetTypes.allow).toBeDefined();
        for (const t of [...(w.wsTypes?.deny ?? []), ...(w.grantTypes?.deny ?? [])])
          expect(a.assetTypes.deny).toContain(t);
        // Limits: never above the workspace (or default) nor the grant; switches on only when both allow.
        for (const key of NUMBER_LIMITS) {
          const base = w.wsLimits[key] ?? SETTINGS.limits.defaults[key];
          expect(a.limits[key]).toBeLessThanOrEqual(base);
          const g = w.grantLimits[key];
          if (g !== undefined) expect(a.limits[key]).toBeLessThanOrEqual(g);
        }
        expect(a.limits.defaultRows).toBeLessThanOrEqual(a.limits.maxRows);
        for (const key of ['memberEmails', 'genericQuery', 'attachmentDownload', 'reports'] as const) {
          if (a.limits[key]) {
            expect(w.wsLimits[key] ?? SETTINGS.limits.defaults[key]).toBe(true);
            expect(w.grantLimits[key]).not.toBe(false);
          }
        }
        if (!a.limits.genericQuery) for (const t of a.tools) expect(TOOLS.get(t)?.group).not.toBe('query');
        // The attachment download is never offered unless workspace and grant both allow it (D-08).
        if (!a.limits.attachmentDownload)
          for (const t of a.tools) expect(TOOLS.get(t)?.group).not.toBe('attachments');
        // The reports are never offered unless workspace and grant both allow them (D-101).
        if (!a.limits.reports) for (const t of a.tools) expect(TOOLS.get(t)?.group).not.toBe('reports');
        // Expiry: no later than the token or the grant.
        for (const e of [w.tokenExpires, w.grantExpires])
          if (e !== null) expect(a.expiresAt).toBeLessThanOrEqual(e);
      }),
      propertyParams(500),
    );
  });

  type Built = ReturnType<typeof build>;
  type Broken = Omit<Built, 'records'> & { records: AccessRecords };
  /** One way to break an otherwise valid request; every one must deny. */
  const breakages: Record<string, (b: Built) => Broken> = {
    tokenRevoked: (b) => ({
      ...b,
      principal: { kind: 'device_token', token: token({ revokedAt: NOW - 1 }) },
    }),
    tokenExpired: (b) => ({
      ...b,
      principal: { kind: 'device_token', token: token({ expiresAt: NOW - 1 }) },
    }),
    wrongWorkspaceToken: (b) => ({
      ...b,
      records: { ...b.records, workspace: { ...b.records.workspace, slug: 'other' } },
    }),
    grantMissing: (b) => ({ ...b, records: { ...b.records, grant: null } }),
    grantRevoked: (b) => ({ ...b, records: { ...b.records, grant: { ...b.records.grant, revokedAt: NOW } } }),
    grantExpired: (b) => ({ ...b, records: { ...b.records, grant: { ...b.records.grant, expiresAt: NOW } } }),
    workspaceMissing: (b) => ({ ...b, records: { ...b.records, workspace: null } }),
    workspaceDisabled: (b) => ({
      ...b,
      records: { ...b.records, workspace: { ...b.records.workspace, disabledAt: NOW } },
    }),
    instanceMissing: (b) => ({ ...b, records: { ...b.records, instance: null } }),
    instanceDisabled: (b) => ({
      ...b,
      records: { ...b.records, instance: { ...b.records.instance, disabledAt: NOW } },
    }),
    userMissing: (b) => ({ ...b, records: { ...b.records, user: null } }),
    userDisabled: (b) => ({ ...b, records: { ...b.records, user: { ...b.records.user, disabledAt: NOW } } }),
    credentialMissing: (b) => ({ ...b, records: { ...b.records, credential: null } }),
    credentialRevoked: (b) => ({
      ...b,
      records: { ...b.records, credential: { ...b.records.credential, revokedAt: NOW } },
    }),
    credentialUnvalidated: (b) => ({
      ...b,
      records: { ...b.records, credential: { ...b.records.credential, validationStatus: 'unvalidated' } },
    }),
    credentialOtherInstance: (b) => ({
      ...b,
      records: { ...b.records, credential: { ...b.records.credential, instanceId: 'i-9' } },
    }),
    otherUsersCredential: (b) => ({
      ...b,
      records: { ...b.records, credential: { ...b.records.credential, ownerUserId: 'u-mallory' } },
    }),
    malformedWorkspace: (b) => ({
      ...b,
      records: { ...b.records, workspace: { ...b.records.workspace, limits: { maxRows: 1e9 } } },
    }),
    malformedGrant: (b) => ({
      ...b,
      records: { ...b.records, grant: { ...b.records.grant, assetTypes: { allow: 'Story' } as never } },
    }),
  };

  it('every missing, disabled, revoked, expired, unvalidated or malformed input denies', () => {
    fc.assert(
      fc.property(world, fc.constantFrom(...Object.keys(breakages)), (w, name) => {
        const b = (breakages[name] as (x: Built) => Broken)(build(w));
        if (name === 'otherUsersCredential' && b.records.credential?.ownerUserId === null) return; // shared: not personal
        const d = resolveAccess(b.principal, 'team-a', b.records, b.settings, NOW);
        expect(d.ok, name).toBe(false);
      }),
      propertyParams(1_000),
    );
  });
});
