// SPDX-License-Identifier: Apache-2.0
// What the P4-04 screens read from the admin API, parsed field by field: only the fields a page shows, with the types it
// expects (a wrong type becomes a safe default, never a crash or a surprise in the markup). Secret material is never part
// of an admin API answer; these parsers would not pick it up anyway.

type Row = Readonly<Record<string, unknown>>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const int = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) ? v : 0);
const intOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) ? v : null;
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const strsOrNull = (v: unknown): string[] | null => (Array.isArray(v) ? strs(v) : null);
const obj = (v: unknown): Row => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Row) : {});

export type Role = 'owner' | 'admin' | 'member';
export const ROLES: readonly Role[] = ['owner', 'admin', 'member'];
const role = (v: unknown): Role => (v === 'owner' || v === 'admin' ? v : 'member');

export interface User {
  readonly id: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly idp: string | null;
  readonly role: Role;
  readonly createdAt: number;
  readonly disabledAt: number | null;
}

export function parseUser(r: Row): User | null {
  const id = str(r['id']);
  if (id === '') return null;
  return {
    id,
    email: str(r['email']),
    displayName: strOrNull(r['displayName']),
    idp: strOrNull(r['idp']),
    role: role(r['role']),
    createdAt: int(r['createdAt']),
    disabledAt: intOrNull(r['disabledAt']),
  };
}

export interface Instance {
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  /** The CA file the instance's TLS is checked against, when one is set. */
  readonly caFile: string | null;
  readonly numberPrefixes: Readonly<Record<string, string>>;
  readonly metaFingerprint: string | null;
  readonly createdAt: number;
  readonly disabledAt: number | null;
}

export function parseInstance(r: Row): Instance | null {
  const id = str(r['id']);
  if (id === '') return null;
  const prefixes: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(r['numberPrefixes']))) if (typeof v === 'string') prefixes[k] = v;
  return {
    id,
    label: str(r['label']),
    baseUrl: str(r['baseUrl']),
    caFile: strOrNull(obj(r['tls'])['caFile']),
    numberPrefixes: prefixes,
    metaFingerprint: strOrNull(r['metaFingerprint']),
    createdAt: int(r['createdAt']),
    disabledAt: intOrNull(r['disabledAt']),
  };
}

export interface Credential {
  readonly id: string;
  readonly instanceId: string;
  /** null: shared. */
  readonly ownerUserId: string | null;
  readonly label: string;
  /** Last characters of the token: the only part of it the panel ever has. */
  readonly tokenHint: string;
  readonly validationStatus: 'unvalidated' | 'valid' | 'invalid';
  readonly validationErrorCode: string | null;
  readonly validatedAt: number | null;
  readonly memberName: string | null;
  readonly memberUsername: string | null;
  readonly reachableScopeIds: string[] | null;
  readonly createdAt: number;
  readonly revokedAt: number | null;
}

export function parseCredential(r: Row): Credential | null {
  const id = str(r['id']);
  if (id === '') return null;
  const status = r['validationStatus'];
  return {
    id,
    instanceId: str(r['instanceId']),
    ownerUserId: strOrNull(r['ownerUserId']),
    label: str(r['label']),
    tokenHint: str(r['tokenHint']),
    validationStatus: status === 'valid' || status === 'invalid' ? status : 'unvalidated',
    validationErrorCode: strOrNull(r['validationErrorCode']),
    validatedAt: intOrNull(r['validatedAt']),
    memberName: strOrNull(r['memberName']),
    memberUsername: strOrNull(r['memberUsername']),
    reachableScopeIds: strsOrNull(r['reachableScopeIds']),
    createdAt: int(r['createdAt']),
    revokedAt: intOrNull(r['revokedAt']),
  };
}

/** The numbers and switches of a limits policy (`limitsPolicySchema` in `@agility-bridge/auth`). */
export interface Limits {
  readonly [key: string]: number | boolean | undefined;
}

export function parseLimits(v: unknown): Limits {
  const out: Record<string, number | boolean> = {};
  for (const [k, value] of Object.entries(obj(v))) {
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isSafeInteger(value))) {
      out[k] = value;
    }
  }
  return out;
}

export interface AssetTypes {
  readonly allow: string[] | null;
  readonly deny: string[] | null;
}

export function parseAssetTypes(v: unknown): AssetTypes | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const r = obj(v);
  return { allow: strsOrNull(r['allow']), deny: strsOrNull(r['deny']) };
}

export interface Workspace {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly instanceId: string;
  readonly allowedScopeIds: string[];
  readonly includeChildScopes: boolean;
  readonly assetTypes: AssetTypes | null;
  /** null: every read tool. */
  readonly enabledTools: string[] | null;
  readonly limits: Limits;
  readonly defaultCredentialId: string | null;
  readonly writesEnabled: boolean;
  readonly credentialSource: 'stored' | 'passthrough';
  readonly createdAt: number;
  readonly disabledAt: number | null;
}

export function parseWorkspace(r: Row): Workspace | null {
  const id = str(r['id']);
  if (id === '') return null;
  return {
    id,
    slug: str(r['slug']),
    name: str(r['name']),
    instanceId: str(r['instanceId']),
    allowedScopeIds: strs(r['allowedScopeIds']),
    includeChildScopes: r['includeChildScopes'] === true,
    assetTypes: parseAssetTypes(r['assetTypes']),
    enabledTools: strsOrNull(r['enabledTools']),
    limits: parseLimits(r['limits']),
    defaultCredentialId: strOrNull(r['defaultCredentialId']),
    writesEnabled: obj(r['writePolicy'])['enabled'] === true,
    credentialSource: r['credentialSource'] === 'passthrough' ? 'passthrough' : 'stored',
    createdAt: int(r['createdAt']),
    disabledAt: intOrNull(r['disabledAt']),
  };
}

export interface Grant {
  readonly id: string;
  readonly workspaceId: string;
  /** null: a service grant (it has a label). */
  readonly userId: string | null;
  readonly label: string | null;
  readonly credentialId: string | null;
  /** null: every tool the workspace enables (reads only). */
  readonly tools: string[] | null;
  /** null: every project of the workspace. */
  readonly scopeIds: string[] | null;
  readonly assetTypes: AssetTypes | null;
  readonly limits: Limits;
  readonly perMinute: number | null;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly revokedAt: number | null;
}

export function parseGrant(r: Row): Grant | null {
  const id = str(r['id']);
  if (id === '') return null;
  const rate = r['rateLimit'] === null || r['rateLimit'] === undefined ? null : obj(r['rateLimit']);
  return {
    id,
    workspaceId: str(r['workspaceId']),
    userId: strOrNull(r['userId']),
    label: strOrNull(r['label']),
    credentialId: strOrNull(r['credentialId']),
    tools: strsOrNull(r['tools']),
    scopeIds: strsOrNull(r['scopeIds']),
    assetTypes: parseAssetTypes(r['assetTypes']),
    limits: parseLimits(r['limits']),
    perMinute: rate === null ? null : intOrNull(rate['perMinute']),
    createdAt: int(r['createdAt']),
    expiresAt: intOrNull(r['expiresAt']),
    revokedAt: intOrNull(r['revokedAt']),
  };
}

export interface Token {
  readonly id: string;
  readonly grantId: string;
  /** First characters, for recognition only. */
  readonly prefix: string;
  readonly label: string;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly lastUsedAt: number | null;
  readonly revokedAt: number | null;
}

export function parseToken(r: Row): Token | null {
  const id = str(r['id']);
  if (id === '') return null;
  return {
    id,
    grantId: str(r['grantId']),
    prefix: str(r['prefix']),
    label: str(r['label']),
    createdAt: int(r['createdAt']),
    expiresAt: intOrNull(r['expiresAt']),
    lastUsedAt: intOrNull(r['lastUsedAt']),
    revokedAt: intOrNull(r['revokedAt']),
  };
}

/** The workspace fields "My access" has for one of my grants (members cannot read workspaces; `GET /me/grants`). */
export interface MyWorkspace {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly instanceId: string;
  readonly credentialSource: 'stored' | 'passthrough';
  readonly hasDefaultCredential: boolean;
  readonly disabledAt: number | null;
}
/** What the token pages need of a workspace. */
export type WorkspaceName = Pick<Workspace, 'slug' | 'name'>;

export interface MyGrant {
  readonly grant: Grant;
  readonly workspace: MyWorkspace | null;
}

export function parseMyGrant(r: Row): MyGrant | null {
  const grant = parseGrant(obj(r['grant']));
  if (grant === null) return null;
  const w = obj(r['workspace']);
  const id = str(w['id']);
  return {
    grant,
    workspace:
      id === ''
        ? null
        : {
            id,
            slug: str(w['slug']),
            name: str(w['name']),
            instanceId: str(w['instanceId']),
            credentialSource: w['credentialSource'] === 'passthrough' ? 'passthrough' : 'stored',
            hasDefaultCredential: w['hasDefaultCredential'] === true,
            disabledAt: intOrNull(w['disabledAt']),
          },
  };
}

/** One line of "my recent changes" (`GET /me/audit`). */
export interface MyAuditRow {
  readonly id: string;
  readonly ts: number;
  readonly action: string;
  readonly status: 'ok' | 'error' | 'denied';
  readonly targetType: string | null;
  readonly targetId: string | null;
}

export function parseMyAudit(r: Row): MyAuditRow | null {
  const id = str(r['id']);
  if (id === '') return null;
  const status = r['status'];
  return {
    id,
    ts: int(r['ts']),
    action: str(r['action']),
    status: status === 'error' || status === 'denied' ? status : 'ok',
    targetType: strOrNull(r['targetType']),
    targetId: strOrNull(r['targetId']),
  };
}

export interface Tool {
  readonly name: string;
  readonly kind: 'read' | 'write' | 'destructive';
  readonly group: string;
}

const TOOL_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export function parseTool(r: Row): Tool | null {
  const name = str(r['name']);
  if (!TOOL_NAME.test(name) || name.length > 64) return null;
  const kind = r['kind'];
  return { name, kind: kind === 'write' || kind === 'destructive' ? kind : 'read', group: str(r['group']) };
}

/** A JSON array answer parsed row by row; null when the body is not an array. */
export function rows<T>(body: unknown, parse: (r: Row) => T | null): T[] | null {
  if (!Array.isArray(body)) return null;
  return body.flatMap((r) => {
    const parsed = typeof r === 'object' && r !== null && !Array.isArray(r) ? parse(r as Row) : null;
    return parsed === null ? [] : [parsed];
  });
}

/** A single-resource answer (the row itself). */
export function one<T>(body: unknown, parse: (r: Row) => T | null): T | null {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? parse(body as Row) : null;
}

/** An id the admin API could know (anything else is a 404 without asking). */
export const isId = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(v) && v !== '.' && v !== '..';

export type AuditKind = 'tool_call' | 'write' | 'auth' | 'admin';
export type AuditStatus = 'ok' | 'error' | 'denied';

export interface AuditRow {
  readonly id: string;
  readonly ts: number;
  readonly kind: string;
  readonly action: string;
  readonly status: string;
  readonly requestId: string | null;
  readonly userId: string | null;
  readonly grantId: string | null;
  readonly tokenId: string | null;
  readonly clientId: string | null;
  readonly workspaceId: string | null;
  readonly assetNumbers: string[] | null;
  /** The compiled query with every bound value masked. Still untrusted text: always escaped. */
  readonly query: string | null;
  readonly durationMs: number | null;
  readonly agilityRequests: number | null;
  readonly errorCode: string | null;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly details: Readonly<Record<string, unknown>> | null;
}

export function parseAudit(r: Row): AuditRow | null {
  const id = str(r['id']);
  if (id === '') return null;
  const details = r['details'];
  return {
    id,
    // A timestamp a `Date` cannot show would throw while rendering: show it as the epoch instead.
    ts: int(r['ts']) > 8_640_000_000_000_000 ? 0 : int(r['ts']),
    kind: str(r['kind']),
    action: str(r['action']),
    status: str(r['status']),
    requestId: strOrNull(r['requestId']),
    userId: strOrNull(r['userId']),
    grantId: strOrNull(r['grantId']),
    tokenId: strOrNull(r['tokenId']),
    clientId: strOrNull(r['clientId']),
    workspaceId: strOrNull(r['workspaceId']),
    assetNumbers: strsOrNull(r['assetNumbers']),
    query: strOrNull(r['query']),
    durationMs: intOrNull(r['durationMs']),
    agilityRequests: intOrNull(r['agilityRequests']),
    errorCode: strOrNull(r['errorCode']),
    targetType: strOrNull(r['targetType']),
    targetId: strOrNull(r['targetId']),
    details:
      typeof details === 'object' && details !== null && !Array.isArray(details) ? (details as Row) : null,
  };
}

/** One group of `GET /audit/stats`. */
export interface UsageRow {
  readonly key: string | null;
  readonly calls: number;
  readonly errors: number;
  readonly denied: number;
  readonly agilityRequests: number;
  readonly durationSumMs: number;
  readonly durationCount: number;
  readonly maxDurationMs: number | null;
}

export interface Usage {
  readonly rows: UsageRow[];
  readonly scanned: number;
  readonly truncated: boolean;
}

export function parseUsage(body: unknown): Usage | null {
  const o = obj(body);
  const data = o['data'];
  if (!Array.isArray(data)) return null;
  return {
    rows: data.map((d) => {
      const r = obj(d);
      return {
        key: strOrNull(r['key']),
        calls: int(r['calls']),
        errors: int(r['errors']),
        denied: int(r['denied']),
        agilityRequests: int(r['agilityRequests']),
        durationSumMs: int(r['durationSumMs']),
        durationCount: int(r['durationCount']),
        maxDurationMs: intOrNull(r['maxDurationMs']),
      };
    }),
    scanned: int(o['scanned']),
    truncated: o['truncated'] === true,
  };
}
