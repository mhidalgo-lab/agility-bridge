// SPDX-License-Identifier: Apache-2.0
// A complete server for HTTP tests: memory storage, two workspaces on one fake Agility instance, personal credentials
// for two users, device tokens, and a recorder of which Agility token reached the fake.
import {
  type Actor,
  accessServices,
  type CredentialValidator,
  credentialValidator,
  generateMasterKey,
  Keyring,
  type ToolInfo,
} from '@agility-bridge/auth';
import {
  CircuitBreakers,
  CORE_TOOLS,
  CredentialLimiters,
  createLogger,
  DEFAULT_LIMITS,
  MetadataService,
  webCryptoRandom,
} from '@agility-bridge/core';
import { createMemoryStorage, type Storage } from '@agility-bridge/storage';
import type { Client } from '@modelcontextprotocol/client';
import snapshotJson from '../../../core/test/fixtures/agility/meta-snapshot.json' with { type: 'json' };
import { FAKE_BASE_URL, FakeAgility, type FakeAgilityOptions } from '../../../core/test/harness/index.ts';
import {
  AuditWriter,
  createHttpApp,
  type HostServices,
  type HttpAppOptions,
  type RequestEvent,
  type ToolCallRecord,
} from '../../src/index.ts';

export const ALICE_AGILITY = '1.AliceAgilityTokenNotRealAbCdEfGh0001';
export const BOB_AGILITY = '1.BobAgilityTokenNotRealAbCdEfGhIj0002';
export const ORIGIN = 'http://127.0.0.1:8787';

export const TOOL_INFO: ReadonlyMap<string, ToolInfo> = new Map(
  CORE_TOOLS.map((t) => [t.name, { kind: t.kind, group: t.group }]),
);

export const ASSETS: Record<string, Record<string, unknown>[]> = {
  Scope: [
    { _oid: 'Scope:1001', Name: 'Mobile App', AssetState: 64, ChildrenMeAndDown: ['Scope:1001'] },
    { _oid: 'Scope:2001', Name: 'Platform', AssetState: 64, ChildrenMeAndDown: ['Scope:2001'] },
  ],
  Member: [{ _oid: 'Member:20', Name: 'Ann Example', Username: 'ann', IsSelf: true, AssetState: 64 }],
  Story: [
    { _oid: 'Story:1', Number: 'B-00001', Name: 'In A', AssetState: 64, Scope: 'Scope:1001' },
    { _oid: 'Story:2', Number: 'B-00002', Name: 'In B', AssetState: 64, Scope: 'Scope:2001' },
  ],
};

export interface World {
  storage: Storage;
  fake: FakeAgility;
  /** Agility tokens that reached the fake, in order. */
  agilityTokens: string[];
  tokens: { alice: string; aliceB: string; bob: string };
  ids: {
    aliceGrant: string;
    aliceToken: string;
    bobCredential: string;
    workspaceA: string;
    alice: string;
    aliceCredential: string;
    instance: string;
    owner: string;
    admin: string;
    workspaceB: string;
    aliceGrantB: string;
    bob: string;
    bobGrant: string;
  };
  /** The domain services over the same storage (fixtures: no validator). */
  services: ReturnType<typeof accessServices>;
  requests: RequestEvent[];
  toolCalls: ToolCallRecord[];
  app: ReturnType<typeof createHttpApp>;
  now: { t: number };
  audit: AuditWriter;
  logs: string[];
}

export async function world(
  over: Partial<HttpAppOptions> = {},
  options: {
    auditStorage?: (s: Storage) => Storage;
    admin?: boolean;
    /** The deployment's writes per grant per hour, for the admin API's cap on a grant's own limit (P7-15). */
    writeRateCap?: number;
    /** Agility rows by asset type (default: a small world in Scope:1001 and Scope:2001). */
    assets?: Record<string, Record<string, unknown>[]>;
    /** `ignore-filters`: a hostile upstream that returns rows outside the scope (L-064). */
    filters?: 'evaluate' | 'ignore-filters';
    /** Workspace B's projects (default Scope:2001). */
    projectsB?: string[];
    /** A detached audit writer (Workers, L-096). */
    detachedAudit?: boolean;
    /** Host services replacing the defaults (limiters, metadata, …). */
    services?: Partial<HostServices>;
    /** The tool catalogue the access model and the admin API know (default: the core tools). */
    tools?: ReadonlyMap<string, ToolInfo>;
    /**
     * Validate stored Agility tokens against the fake right after they are stored (P4-07), like a deployment does.
     * `reject` names tokens the fake answers 401 for (the validation then ends `invalid`).
     */
    validate?: { reject?: (token: string) => boolean };
    /**
     * Time is the real one (read at each use): for code that also reads `Date.now()` itself, like the OAuth provider.
     * Tests move it with `vi.setSystemTime`; `now.t` cannot be assigned.
     */
    liveClock?: boolean;
    /** Answers before the fake does (an attachment content endpoint, say); return undefined to fall through. */
    agility?: FakeAgilityOptions['override'];
  } = {},
): Promise<World> {
  const now: { t: number } =
    options.liveClock === true
      ? {
          get t() {
            return Date.now();
          },
          set t(_v: number) {
            throw new Error('the live clock moves with vi.setSystemTime');
          },
        }
      : { t: Date.UTC(2026, 9, 21, 12) };
  const storage = createMemoryStorage({ now: () => now.t });
  const keyring = await Keyring.create(generateMasterKey(1));
  const toolInfo = options.tools ?? TOOL_INFO;
  // Fixtures are stored without a validator; the services the admin API uses get one when the test asks for it.
  const fixtureSvc = accessServices({ storage, keyring, tools: toolInfo, now: () => now.t });
  let validator: CredentialValidator | undefined;
  const late: CredentialValidator = {
    validate: (...a) => (validator as CredentialValidator).validate(...a),
    probe: (...a) => (validator as CredentialValidator).probe(...a),
  };
  const svc =
    options.validate === undefined
      ? fixtureSvc
      : accessServices({ storage, keyring, tools: toolInfo, now: () => now.t, validator: late });
  const alice = await fixtureSvc.users.create({ email: 'alice@example.test', role: 'member' });
  const bob = await fixtureSvc.users.create({ email: 'bob@example.test', role: 'member' });
  const instance = await fixtureSvc.instances.create({ label: 'Fake', baseUrl: FAKE_BASE_URL });
  const aliceCred = await fixtureSvc.credentials.create({
    instanceId: instance.id,
    ownerUserId: alice.id,
    label: 'a',
    token: ALICE_AGILITY,
  });
  const bobCred = await fixtureSvc.credentials.create({
    instanceId: instance.id,
    ownerUserId: bob.id,
    label: 'b',
    token: BOB_AGILITY,
  });
  for (const c of [aliceCred, bobCred]) await storage.credentials.update(c.id, { validationStatus: 'valid' });
  const wsA = await fixtureSvc.workspaces.create({
    slug: 'team-a',
    name: 'Team A',
    instanceId: instance.id,
    allowedScopeIds: ['Scope:1001'],
  });
  const wsB = await fixtureSvc.workspaces.create({
    slug: 'team-b',
    name: 'Team B',
    instanceId: instance.id,
    allowedScopeIds: options.projectsB ?? ['Scope:2001'],
  });
  const aliceGrant = (
    await fixtureSvc.grants.create({ workspaceId: wsA.id, userId: alice.id, credentialId: aliceCred.id })
  ).record;
  const aliceGrantB = (
    await fixtureSvc.grants.create({ workspaceId: wsB.id, userId: alice.id, credentialId: aliceCred.id })
  ).record;
  const bobGrant = (
    await fixtureSvc.grants.create({
      workspaceId: wsB.id,
      userId: bob.id,
      credentialId: bobCred.id,
      tools: ['whoami', 'get_assets'],
    })
  ).record;
  const ownerUser = await fixtureSvc.users.create({ email: 'owner@example.test', role: 'owner' });
  const adminUser = await fixtureSvc.users.create({ email: 'admin@example.test', role: 'admin' });
  const a = await fixtureSvc.tokens.issue({ grantId: aliceGrant.id, label: 'laptop' });
  const aB = await fixtureSvc.tokens.issue({ grantId: aliceGrantB.id, label: 'laptop' });
  const b = await fixtureSvc.tokens.issue({ grantId: bobGrant.id, label: 'phone' });

  const agilityTokens: string[] = [];
  const fake = new FakeAgility({
    meta: snapshotJson as unknown as Record<string, unknown>,
    assets: (options.assets ?? ASSETS) as never,
    filters: options.filters ?? 'evaluate',
    override: (req, call) => {
      const token = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      agilityTokens.push(token);
      if (options.validate?.reject?.(token) === true) return new Response('{}', { status: 401 });
      return options.agility?.(req, call);
    },
  });
  const requests: RequestEvent[] = [];
  const toolCalls: ToolCallRecord[] = [];
  const logs: string[] = [];
  const logger = createLogger({ level: 'debug', sink: (l) => logs.push(l) });
  validator = credentialValidator({
    fetchFor: () => fake.fetch,
    limiters: new CredentialLimiters(),
    breakers: new CircuitBreakers(),
    metadata: new MetadataService(),
    logger,
    clock: { now: () => now.t },
    random: webCryptoRandom,
  });
  const audit = new AuditWriter({
    storage: options.auditStorage?.(storage) ?? storage,
    logger,
    clock: { now: () => now.t },
    random: webCryptoRandom,
    ...(options.detachedAudit === true ? { detached: true } : {}),
  });
  const app = createHttpApp({
    storage,
    keyring,
    access: {
      tools: toolInfo,
      writesEnabled: false,
      environment: 'live',
      limits: {
        defaults: {
          ...DEFAULT_LIMITS,
          maxResponseBytes: 8 * 1024 * 1024,
          callBudget: 1_000,
          genericQuery: true,
        },
        ceilings: {},
      },
    },
    tools: CORE_TOOLS,
    services: {
      fetchFor: () => fake.fetch,
      limiters: new CredentialLimiters(),
      breakers: new CircuitBreakers(),
      metadata: new MetadataService(),
      logger,
      clock: { now: () => now.t },
      random: webCryptoRandom,
      ...options.services,
    },
    ...(options.admin
      ? {
          admin: {
            services: svc,
            audit,
            ...(options.writeRateCap === undefined ? {} : { writeRateCap: options.writeRateCap }),
            // Tests pick the actor with a header; production uses the admin token (and sessions from P4-02).
            authenticate: async (c) => {
              const who = c.req.header('x-test-actor');
              const users: Record<string, Actor> = {
                break_glass: { kind: 'break_glass' },
                owner: { kind: 'user', userId: ownerUser.id, role: 'owner', recentAuth: true },
                owner_stale: { kind: 'user', userId: ownerUser.id, role: 'owner', recentAuth: false },
                admin: { kind: 'user', userId: adminUser.id, role: 'admin', recentAuth: true },
                member: { kind: 'user', userId: alice.id, role: 'member', recentAuth: true },
              };
              return who === undefined ? null : (users[who] ?? null);
            },
          },
        }
      : {}),
    observer: audit.observer({
      request: (e) => {
        requests.push(e);
      },
      toolCall: (e) => {
        toolCalls.push(e);
      },
    }),
    version: '0.0.0-test',
    ...over,
    // OAuth steps are audited like the real hosts do (`assembleServer`).
    ...(over.oauth === undefined ? {} : { oauth: { audit: (e) => audit.oauth(e), ...over.oauth } }),
  });
  return {
    storage,
    fake,
    agilityTokens,
    tokens: { alice: a.token, aliceB: aB.token, bob: b.token },
    ids: {
      aliceGrant: aliceGrant.id,
      aliceToken: a.record.id,
      bobCredential: bobCred.id,
      workspaceA: wsA.id,
      alice: alice.id,
      aliceCredential: aliceCred.id,
      instance: instance.id,
      owner: ownerUser.id,
      admin: adminUser.id,
      workspaceB: wsB.id,
      aliceGrantB: aliceGrantB.id,
      bob: bob.id,
      bobGrant: bobGrant.id,
    },
    services: fixtureSvc,
    requests,
    toolCalls,
    app,
    now,
    audit,
    logs,
  };
}

export type Era = 'legacy' | { pin: '2026-07-28' };

/** An SDK client connected in-process to the app (both protocol eras, ADR-0005). */
export async function connect(w: World, slug: string, token: string, mode: Era = 'legacy'): Promise<Client> {
  // Loaded here, so scripts that only need the world (scripts/worker-bench.ts) do not load the MCP client.
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/w/${slug}/mcp`), {
    fetch: (url, init) => Promise.resolve(w.app.fetch(new Request(url, init))),
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'http-test', version: '0.0.0' }, { versionNegotiation: { mode } });
  await client.connect(transport);
  return client;
}

/** A raw JSON-RPC POST. */
export function post(
  w: World,
  slug: string,
  token: string | null,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return w.app.fetch(
    new Request(`${ORIGIN}/w/${slug}/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:8787',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}
