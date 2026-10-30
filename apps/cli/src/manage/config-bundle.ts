// SPDX-License-Identifier: Apache-2.0
// Configuration export and import (P8-05, THREAT_MODEL T29, L-065, L-078). What moves: instances, shared credentials
// (their tokens only when encrypted with a passphrase), workspaces and service grants. What does not: users, grants of
// people, personal credentials, device tokens, sessions, OAuth devices, audit rows and TLS file paths. Import is
// additive and goes through the admin API like every other writer, so validation, guards and audit are the same; it
// never updates a record that exists, never names a user, and never reads a personal credential.
import { canonicalInstanceUrl } from '@agility-bridge/core';
import { z } from 'zod';
import { ConfigError } from '../config.ts';
import type { AdminClient } from './client.ts';

export const BUNDLE_FORMAT = 'agility-bridge-config';
export const BUNDLE_VERSION = 2;
/** PBKDF2-HMAC-SHA-256 iterations (OWASP 2023 minimum for this PRF); a file naming another count is refused. */
export const PBKDF2_ITERATIONS = 600_000;
export const MIN_PASSPHRASE = 12;
export const MAX_BUNDLE_BYTES = 1_048_576;
const KDF = 'PBKDF2-HMAC-SHA256';

const LIMITS = { instances: 100, credentials: 500, workspaces: 500, grants: 2_000 } as const;

// --- encryption of the credentials' tokens -----------------------------------------------------------------------

export interface EncryptedSecrets {
  readonly kdf: string;
  readonly iterations: number;
  readonly salt: string;
  readonly iv: string;
  readonly ciphertext: string;
}

type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
type Bytes = Uint8Array<ArrayBuffer>;
const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string): Bytes => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const enc = new TextEncoder();
/** The header is authenticated with the ciphertext, so the format, version and cost cannot be edited in the file. */
const aad = (iterations: number, binding: string): Bytes =>
  enc.encode(`${BUNDLE_FORMAT}|${BUNDLE_VERSION}|${KDF}|${iterations}|${binding}`);

/**
 * What ties a token to where it may be sent (S-1, D-287): the instances' canonical addresses and which instance each
 * credential belongs to. It is part of the authenticated data, so editing `baseUrl` or re-pointing a credential in the
 * file makes the passphrase check fail instead of sending a decrypted token to another host.
 */
export function bindingOf(bundle: {
  readonly instances: readonly { ref: string; baseUrl: string }[];
  readonly credentials: readonly { ref: string; instance: string }[];
}): string {
  return JSON.stringify({
    i: bundle.instances.map((i) => [i.ref, canonicalOrSelf(i.baseUrl)]).sort(),
    c: bundle.credentials.map((c) => [c.ref, c.instance]).sort(),
  });
}

async function deriveKey(passphrase: string, salt: Bytes): Promise<Key> {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function checkPassphrase(passphrase: string): void {
  if (passphrase.length < MIN_PASSPHRASE || passphrase.length > 1_024) {
    throw new ConfigError(`The passphrase must be ${MIN_PASSPHRASE} to 1,024 characters.`);
  }
}

/** AES-256-GCM under a PBKDF2-HMAC-SHA-256 key (600,000 iterations), fresh salt and IV per export. */
export async function encryptSecrets(
  secrets: Readonly<Record<string, string>>,
  passphrase: string,
  binding = '',
): Promise<EncryptedSecrets> {
  checkPassphrase(passphrase);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv, additionalData: aad(PBKDF2_ITERATIONS, binding) },
    key,
    enc.encode(JSON.stringify(secrets)),
  );
  return {
    kdf: KDF,
    iterations: PBKDF2_ITERATIONS,
    salt: b64(salt),
    iv: b64(iv),
    ciphertext: b64(new Uint8Array(sealed)),
  };
}

export async function decryptSecrets(
  sealed: EncryptedSecrets,
  passphrase: string,
  binding = '',
): Promise<Record<string, string>> {
  if (sealed.kdf !== KDF || sealed.iterations !== PBKDF2_ITERATIONS) {
    throw new ConfigError(
      `The file's key derivation is not ${KDF} with ${PBKDF2_ITERATIONS} iterations; refusing it.`,
    );
  }
  try {
    const key = await deriveKey(passphrase, unb64(sealed.salt));
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: unb64(sealed.iv),
        additionalData: aad(PBKDF2_ITERATIONS, binding),
      },
      key,
      unb64(sealed.ciphertext),
    );
    const parsed = z.record(z.string(), z.string()).parse(JSON.parse(new TextDecoder().decode(plain)));
    return parsed;
  } catch {
    // One message for a wrong passphrase and for a changed file: they cannot be told apart, and nothing else leaks.
    throw new ConfigError('The passphrase is wrong, or the file was changed.');
  }
}

// --- the file ----------------------------------------------------------------------------------------------------

const Ref = z.string().regex(/^[a-z][a-z0-9-]{0,30}$/);
const Text = z.string().min(1).max(200);
const Strings = z.array(z.string().min(1).max(200)).max(500);
const Json = z.record(z.string(), z.json());

const BundleSchema = z.strictObject({
  format: z.literal(BUNDLE_FORMAT),
  version: z.literal(BUNDLE_VERSION),
  exportedAt: z.string().max(40),
  instances: z
    .array(
      z.strictObject({
        ref: Ref,
        label: Text,
        baseUrl: z.string().min(1).max(2_048),
        numberPrefixes: Json.nullable(),
      }),
    )
    .max(LIMITS.instances),
  credentials: z
    .array(z.strictObject({ ref: Ref, instance: Ref, label: Text, tokenHint: z.string().max(4) }))
    .max(LIMITS.credentials),
  workspaces: z
    .array(
      z.strictObject({
        slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
        name: Text,
        instance: Ref,
        allowedScopeIds: Strings,
        includeChildScopes: z.boolean(),
        assetTypes: Json.nullable(),
        enabledTools: Strings.nullable(),
        limits: Json,
        defaultCredential: Ref.nullable(),
        writePolicy: Json,
        credentialSource: z.enum(['stored', 'passthrough']),
      }),
    )
    .max(LIMITS.workspaces),
  grants: z
    .array(
      z.strictObject({
        workspace: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
        label: Text,
        credential: Ref.nullable(),
        tools: Strings.nullable(),
        scopeIds: Strings.nullable(),
        assetTypes: Json.nullable(),
        limits: Json,
        rateLimit: Json.nullable(),
        expiresAt: z.number().int().nullable(),
      }),
    )
    .max(LIMITS.grants),
  secrets: z
    .strictObject({
      kdf: z.string().max(40),
      iterations: z.number().int(),
      salt: z.string().max(64),
      iv: z.string().max(32),
      ciphertext: z.string().max(1_000_000),
    })
    .nullable(),
});

export type Bundle = z.infer<typeof BundleSchema>;

/** Parses and validates an exported file: strict (unknown fields refused), bounded, references that resolve. */
export function parseBundle(text: string): Bundle {
  if (text.length > MAX_BUNDLE_BYTES) throw new ConfigError('The file is larger than 1 MiB.');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError('The file is not JSON.');
  }
  const parsed = BundleSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConfigError(
      `Not an agility-bridge configuration file: ${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'invalid'}.`,
    );
  }
  const b = parsed.data;
  const unique = (what: string, values: string[]) => {
    if (new Set(values).size !== values.length) throw new ConfigError(`The file repeats a ${what}.`);
  };
  unique(
    'instance reference',
    b.instances.map((i) => i.ref),
  );
  unique(
    'credential reference',
    b.credentials.map((c) => c.ref),
  );
  unique(
    'workspace slug',
    b.workspaces.map((w) => w.slug),
  );
  unique(
    'grant label in a workspace',
    b.grants.map((g) => `${g.workspace}/${g.label}`),
  );
  const instances = new Set(b.instances.map((i) => i.ref));
  const credentials = new Map(b.credentials.map((c) => [c.ref, c.instance]));
  const slugs = new Map(b.workspaces.map((w) => [w.slug, w]));
  for (const c of b.credentials)
    if (!instances.has(c.instance)) throw new ConfigError(`Credential "${c.ref}" names an unknown instance.`);
  for (const w of b.workspaces) {
    if (!instances.has(w.instance)) throw new ConfigError(`Workspace "${w.slug}" names an unknown instance.`);
    if (w.defaultCredential !== null && credentials.get(w.defaultCredential) !== w.instance)
      throw new ConfigError(`Workspace "${w.slug}": its default credential is not one of its instance.`);
  }
  for (const g of b.grants) {
    const w = slugs.get(g.workspace);
    if (w === undefined) throw new ConfigError(`A grant names an unknown workspace "${g.workspace}".`);
    if (g.credential !== null && credentials.get(g.credential) !== w.instance)
      throw new ConfigError(`Grant "${g.label}": its credential is not one of its workspace's instance.`);
  }
  return b;
}

// --- export ------------------------------------------------------------------------------------------------------

type Api = Pick<AdminClient, 'request'>;

async function list(api: Api, path: string): Promise<Record<string, unknown>[]> {
  const res = await api.request('GET', path);
  if (res.status !== 200 || !Array.isArray(res.body)) {
    throw new ConfigError(`GET ${path} failed (HTTP ${res.status}).`);
  }
  return res.body as Record<string, unknown>[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export interface ExportInput {
  /** Decrypted tokens by credential id (local export with a passphrase only). */
  readonly tokens?: ReadonlyMap<string, string>;
  readonly passphrase?: string;
  readonly now?: () => Date;
}

/** What `config export` needs the caller to prepare: which credentials will be exported (shared, not revoked). */
export async function exportableCredentials(api: Api): Promise<Record<string, unknown>[]> {
  const instances = new Set(
    (await list(api, '/instances')).filter((i) => i['disabledAt'] === null).map((i) => str(i['id'])),
  );
  return (await list(api, '/credentials')).filter(
    (c) => c['ownerUserId'] === null && c['revokedAt'] === null && instances.has(str(c['instanceId'])),
  );
}

/** Builds the file from the admin API's lists. Personal credentials, users and people's grants are never read in. */
export async function buildBundle(api: Api, input: ExportInput = {}): Promise<Bundle> {
  const instances = (await list(api, '/instances')).filter((i) => i['disabledAt'] === null);
  const instanceRef = new Map(instances.map((i, n) => [str(i['id']), `i${n + 1}`]));
  const credentials = (await exportableCredentials(api)).slice(0, LIMITS.credentials);
  const credentialRef = new Map(credentials.map((c, n) => [str(c['id']), `c${n + 1}`]));
  const workspaces = (await list(api, '/workspaces')).filter(
    (w) => w['disabledAt'] === null && instanceRef.has(str(w['instanceId'])),
  );
  const slugOf = new Map(workspaces.map((w) => [str(w['id']), str(w['slug'])]));
  const now = Date.now();
  const grants = (await list(api, '/grants')).filter(
    (g) =>
      g['userId'] === null &&
      g['revokedAt'] === null &&
      (g['expiresAt'] === null || (g['expiresAt'] as number) > now) &&
      slugOf.has(str(g['workspaceId'])) &&
      (g['credentialId'] === null || credentialRef.has(str(g['credentialId']))),
  );
  let secrets: EncryptedSecrets | null = null;
  if (input.tokens !== undefined) {
    if (input.passphrase === undefined) throw new ConfigError('A passphrase is needed to export tokens.');
    const plain: Record<string, string> = {};
    for (const c of credentials) {
      const token = input.tokens.get(str(c['id']));
      if (token !== undefined) plain[credentialRef.get(str(c['id'])) as string] = token;
    }
    secrets = await encryptSecrets(
      plain,
      input.passphrase,
      bindingOf({
        instances: instances.map((i) => ({
          ref: instanceRef.get(str(i['id'])) as string,
          baseUrl: str(i['baseUrl']),
        })),
        credentials: credentials.map((c) => ({
          ref: credentialRef.get(str(c['id'])) as string,
          instance: instanceRef.get(str(c['instanceId'])) as string,
        })),
      }),
    );
  }
  const bundle = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: (input.now?.() ?? new Date()).toISOString(),
    instances: instances.map((i) => ({
      ref: instanceRef.get(str(i['id'])) as string,
      label: str(i['label']),
      baseUrl: str(i['baseUrl']),
      numberPrefixes: (i['numberPrefixes'] as Record<string, never> | null) ?? null,
    })),
    credentials: credentials.map((c) => ({
      ref: credentialRef.get(str(c['id'])) as string,
      instance: instanceRef.get(str(c['instanceId'])) as string,
      label: str(c['label']),
      tokenHint: str(c['tokenHint']).slice(0, 4),
    })),
    workspaces: workspaces.map((w) => ({
      slug: str(w['slug']),
      name: str(w['name']),
      instance: instanceRef.get(str(w['instanceId'])) as string,
      allowedScopeIds: w['allowedScopeIds'] as string[],
      includeChildScopes: w['includeChildScopes'] as boolean,
      assetTypes: (w['assetTypes'] as Record<string, never> | null) ?? null,
      enabledTools: (w['enabledTools'] as string[] | null) ?? null,
      limits: (w['limits'] as Record<string, never>) ?? {},
      defaultCredential:
        w['defaultCredentialId'] === null ? null : (credentialRef.get(str(w['defaultCredentialId'])) ?? null),
      writePolicy: (w['writePolicy'] as Record<string, never>) ?? {},
      credentialSource: w['credentialSource'] as 'stored' | 'passthrough',
    })),
    grants: grants.map((g) => ({
      workspace: slugOf.get(str(g['workspaceId'])) as string,
      label: str(g['label']) || 'service',
      credential: g['credentialId'] === null ? null : (credentialRef.get(str(g['credentialId'])) as string),
      tools: (g['tools'] as string[] | null) ?? null,
      scopeIds: (g['scopeIds'] as string[] | null) ?? null,
      assetTypes: (g['assetTypes'] as Record<string, never> | null) ?? null,
      limits: (g['limits'] as Record<string, never>) ?? {},
      rateLimit: (g['rateLimit'] as Record<string, never> | null) ?? null,
      expiresAt: (g['expiresAt'] as number | null) ?? null,
    })),
    secrets,
  };
  // The result must satisfy our own reader: an export that cannot be imported is a bug found here, not at 3 a.m.
  return parseBundle(JSON.stringify(bundle));
}

// --- import ------------------------------------------------------------------------------------------------------

export type ItemKind = 'instance' | 'credential' | 'workspace' | 'grant';
export type ItemAction = 'create' | 'exists' | 'skip' | 'failed';

export interface PlanItem {
  readonly kind: ItemKind;
  readonly name: string;
  action: ItemAction;
  readonly reason?: string;
}

export interface ImportOptions {
  /** Without it nothing is written: the plan is the result. */
  readonly apply: boolean;
  /** Workspaces that enable writes or pass-through are created only with this. */
  readonly allowSensitive: boolean;
  /**
   * Finish a partly failed run (Q-3, D-288): service grants of the file whose workspace already exists are created when
   * that workspace has no grant of the same label. Off by default: a file never opens a new way into what exists unasked.
   */
  readonly addGrants?: boolean;
  /** Decrypted tokens by credential reference; absent = no credential is created. */
  readonly secrets?: Readonly<Record<string, string>>;
}

export interface ImportResult {
  readonly applied: boolean;
  readonly items: readonly PlanItem[];
  readonly counts: Readonly<Record<ItemAction, number>>;
}

const sensitive = (w: Bundle['workspaces'][number]): boolean =>
  w.credentialSource === 'passthrough' || Object.keys(w.writePolicy).length > 0;

function errorText(res: { status: number; body: unknown }): string {
  const e = (res.body as { error?: { code?: string; message?: string } } | null)?.error;
  // The admin API's own refusal text (it never carries a secret); bounded.
  return `${e?.code ?? `HTTP ${res.status}`}${e?.message ? `: ${e.message.slice(0, 200)}` : ''}`;
}

/**
 * Plans, and with `apply` performs, an additive import. Existing records are never changed (matched by instance address,
 * credential label, workspace slug and service-grant label); nothing is deleted; credentials are created only from the
 * decrypted tokens of the file, as shared credentials; grants are created for services only. Every write is an admin
 * API call, so the same checks and the same audit rows apply as for any command.
 */
export async function importBundle(api: Api, bundle: Bundle, options: ImportOptions): Promise<ImportResult> {
  const items: PlanItem[] = [];
  const add = (kind: ItemKind, name: string, action: ItemAction, reason?: string): PlanItem => {
    const item: PlanItem = { kind, name, action, ...(reason === undefined ? {} : { reason }) };
    items.push(item);
    return item;
  };
  const existingInstances = new Map<string, string>();
  for (const i of await list(api, '/instances'))
    existingInstances.set(canonicalOrSelf(str(i['baseUrl'])), str(i['id']));
  const existingCredentials = await list(api, '/credentials');
  const existingWorkspaceRows = await list(api, '/workspaces');
  const existingWorkspaces = new Set(existingWorkspaceRows.map((w) => str(w['slug'])));

  const instanceUrl = new Map(bundle.instances.map((i) => [i.ref, canonicalOrSelf(i.baseUrl)]));
  const instanceId = new Map<string, string>(); // bundle ref -> id (a planned one is `planned:<ref>`)
  const credentialId = new Map<string, string>();
  const workspaceId = new Map<string, string>();
  /** Workspaces that existed and take grants only because of --add-grants. */
  const adopted = new Set<string>();
  const existingGrants =
    options.addGrants === true
      ? new Set(
          (await list(api, '/grants'))
            .filter((g) => g['revokedAt'] === null && g['userId'] === null)
            .map((g) => `${str(g['workspaceId'])}/${str(g['label'])}`),
        )
      : new Set<string>();
  /** Whether a workspace of the target has a shared default credential (a grant without its own needs one). */
  const hasDefault = new Map<string, boolean>();
  const fail = (item: PlanItem, res: { status: number; body: unknown }) => {
    item.action = 'failed';
    return Object.assign(item, { reason: errorText(res) });
  };

  for (const i of bundle.instances) {
    const url = canonicalOrSelf(i.baseUrl);
    const known = existingInstances.get(url);
    if (known !== undefined) {
      instanceId.set(i.ref, known);
      add('instance', `${i.label} (${url})`, 'exists');
      continue;
    }
    if (!options.apply) {
      instanceId.set(i.ref, `planned:${i.ref}`);
      add('instance', `${i.label} (${url})`, 'create');
      continue;
    }
    const item = add('instance', `${i.label} (${url})`, 'create');
    const res = await api.request('POST', '/instances', {
      label: i.label,
      baseUrl: i.baseUrl,
      ...(i.numberPrefixes === null ? {} : { numberPrefixes: i.numberPrefixes }),
    });
    if (res.status === 201 || res.status === 200)
      instanceId.set(i.ref, str((res.body as { id?: unknown }).id));
    else fail(item, res);
  }

  for (const c of bundle.credentials) {
    const instance = instanceId.get(c.instance);
    const label = `${c.label} (${instanceUrl.get(c.instance) ?? ''})`;
    if (instance === undefined) {
      add('credential', label, 'skip', 'its instance could not be created');
      continue;
    }
    // A credential already on the instance with this label, shared and not revoked, is the one meant: never replaced.
    const same = existingCredentials.find(
      (x) => str(x['instanceId']) === instance && str(x['label']) === c.label && x['revokedAt'] === null,
    );
    if (same !== undefined) {
      if (same['ownerUserId'] === null) {
        credentialId.set(c.ref, str(same['id']));
        add('credential', label, 'exists');
      } else {
        // The label belongs to a person's personal credential: it is never used as a shared one.
        add(
          'credential',
          label,
          'skip',
          'a personal credential has this label; it is never used or replaced',
        );
      }
      continue;
    }
    const token = options.secrets?.[c.ref];
    if (token === undefined) {
      add(
        'credential',
        label,
        'skip',
        'the file has no token for it: add it with `agility-bridge credential add`',
      );
      continue;
    }
    if (!options.apply || instance.startsWith('planned:')) {
      credentialId.set(c.ref, `planned:${c.ref}`);
      add('credential', label, 'create');
      continue;
    }
    const item = add('credential', label, 'create');
    const res = await api.request('POST', '/credentials', {
      instanceId: instance,
      ownerUserId: null,
      label: c.label,
      token,
    });
    if (res.status === 201 || res.status === 200)
      credentialId.set(c.ref, str((res.body as { id?: unknown }).id));
    else fail(item, res);
  }

  for (const w of bundle.workspaces) {
    const instance = instanceId.get(w.instance);
    if (existingWorkspaces.has(w.slug)) {
      // Left as it is. Grants are added to it only with --add-grants (finishing a partly failed run).
      const row = existingWorkspaceRows.find((x) => str(x['slug']) === w.slug);
      if (options.addGrants === true && row !== undefined) {
        workspaceId.set(w.slug, str(row['id']));
        hasDefault.set(
          w.slug,
          row['defaultCredentialId'] !== null && row['defaultCredentialId'] !== undefined,
        );
        adopted.add(w.slug);
      }
      add(
        'workspace',
        w.slug,
        'exists',
        options.addGrants === true
          ? 'left as it is: only the grants it lacks are added'
          : 'left as it is: import never changes a workspace or adds grants to it (--add-grants finishes a partly failed import)',
      );
      continue;
    }
    if (instance === undefined) {
      add('workspace', w.slug, 'skip', 'its instance could not be created');
      continue;
    }
    if (sensitive(w) && !options.allowSensitive) {
      add(
        'workspace',
        w.slug,
        'skip',
        'it enables writes or pass-through: review it, then import with --allow-sensitive',
      );
      continue;
    }
    const defaultCredential =
      w.defaultCredential === null ? null : (credentialId.get(w.defaultCredential) ?? null);
    const note =
      w.defaultCredential !== null && defaultCredential === null
        ? 'created without its default credential: set it after adding the credential'
        : undefined;
    if (!options.apply || instance.startsWith('planned:')) {
      workspaceId.set(w.slug, `planned:${w.slug}`);
      hasDefault.set(w.slug, defaultCredential !== null);
      add('workspace', w.slug, 'create', note);
      continue;
    }
    const item = add('workspace', w.slug, 'create', note);
    const res = await api.request('POST', '/workspaces', {
      slug: w.slug,
      name: w.name,
      instanceId: instance,
      allowedScopeIds: w.allowedScopeIds,
      includeChildScopes: w.includeChildScopes,
      assetTypes: w.assetTypes,
      enabledTools: w.enabledTools,
      limits: w.limits,
      defaultCredentialId: defaultCredential?.startsWith('planned:') ? null : defaultCredential,
      writePolicy: w.writePolicy,
      credentialSource: w.credentialSource,
    });
    if (res.status === 201 || res.status === 200) {
      workspaceId.set(w.slug, str((res.body as { id?: unknown }).id));
      hasDefault.set(w.slug, defaultCredential !== null && !defaultCredential.startsWith('planned:'));
    } else fail(item, res);
  }

  for (const g of bundle.grants) {
    const name = `${g.workspace}/${g.label}`;
    const workspace = workspaceId.get(g.workspace);
    if (workspace === undefined) {
      add(
        'grant',
        name,
        'skip',
        existingWorkspaces.has(g.workspace)
          ? 'the workspace exists: import adds no grants to it'
          : 'its workspace is not available',
      );
      continue;
    }
    if (adopted.has(g.workspace) && existingGrants.has(`${workspace}/${g.label}`)) {
      add('grant', name, 'exists');
      continue;
    }
    const credential = g.credential === null ? null : (credentialId.get(g.credential) ?? undefined);
    if (credential === undefined) {
      add('grant', name, 'skip', 'its credential is not available');
      continue;
    }
    if (credential === null && hasDefault.get(g.workspace) !== true) {
      add('grant', name, 'skip', 'the workspace has no default credential for it to use yet');
      continue;
    }
    if (!options.apply || workspace.startsWith('planned:') || credential?.startsWith('planned:')) {
      add('grant', name, 'create');
      continue;
    }
    const item = add('grant', name, 'create');
    const res = await api.request('POST', '/grants', {
      workspaceId: workspace,
      userId: null,
      label: g.label,
      credentialId: credential,
      tools: g.tools,
      scopeIds: g.scopeIds,
      assetTypes: g.assetTypes,
      limits: g.limits,
      rateLimit: g.rateLimit,
      expiresAt: g.expiresAt,
    });
    if (res.status !== 201 && res.status !== 200) fail(item, res);
  }

  const counts: Record<ItemAction, number> = { create: 0, exists: 0, skip: 0, failed: 0 };
  for (const i of items) counts[i.action]++;
  return { applied: options.apply, items, counts };
}

function canonicalOrSelf(url: string): string {
  try {
    return canonicalInstanceUrl(url);
  } catch {
    return url;
  }
}
