// SPDX-License-Identifier: Apache-2.0
// What a span may say (P8-07, THREAT_MODEL T30, L-118, L-119). Every attribute of every exported span passes through
// `sanitizeAttributes`, which keeps only the keys below and only values of the shape each key allows. A key that is not on the
// list does not exist for the exporter, whatever a caller of `Telemetry.record` passes: there is no "extra attributes" path.
import { ErrorCode } from '../errors.ts';

export type AttributeValue = string | number | boolean;
export type Attributes = Readonly<Record<string, AttributeValue>>;

/** Whose fault a failed request is (L-118). Only `server` and `upstream` count as service errors. */
export type Fault = 'none' | 'caller' | 'upstream' | 'server';
export type Outcome = 'ok' | 'refused' | 'rate_limited' | 'failed';

/**
 * Every `ErrorCode`, classified (a test pins that none is missing): `caller` is a request that is wrong or not allowed or
 * over a limit we set, `upstream` is Agility not delivering, `server` is ours. An unknown code is `server`, so a new failure is
 * never silently called the caller's.
 */
export const FAULT_OF_CODE: Readonly<Record<string, Fault>> = Object.freeze({
  [ErrorCode.AuthUnauthorized]: 'caller',
  [ErrorCode.AuthForbidden]: 'caller',
  [ErrorCode.ToolDisabled]: 'caller',
  [ErrorCode.InputInvalid]: 'caller',
  [ErrorCode.NotFound]: 'caller',
  [ErrorCode.Ambiguous]: 'caller',
  [ErrorCode.LimitQuery]: 'caller',
  [ErrorCode.LimitResponseTooLarge]: 'caller',
  [ErrorCode.LimitRate]: 'caller',
  [ErrorCode.LimitQuota]: 'caller',
  [ErrorCode.BudgetExhausted]: 'caller',
  // The caller's own Agility token was refused: theirs to fix.
  [ErrorCode.AgilityAuth]: 'caller',
  [ErrorCode.AgilityRateLimited]: 'upstream',
  [ErrorCode.AgilityTimeout]: 'upstream',
  [ErrorCode.AgilityUnavailable]: 'upstream',
  [ErrorCode.AgilityTls]: 'upstream',
  [ErrorCode.AgilityError]: 'upstream',
  // The workspace points at the wrong instance: a configuration fault of the deployment.
  [ErrorCode.AgilityWrongInstance]: 'server',
  [ErrorCode.WriteApprovalPending]: 'caller',
  [ErrorCode.WriteApprovalUnavailable]: 'caller',
  [ErrorCode.WriteApprovalDeclined]: 'caller',
  [ErrorCode.WriteConflict]: 'caller',
  [ErrorCode.WriteAuditUnavailable]: 'server',
  [ErrorCode.WriteLimitUnavailable]: 'server',
  [ErrorCode.Internal]: 'server',
});

const KNOWN_CODES: ReadonlySet<string> = new Set(Object.values(ErrorCode));

/** The MCP methods a span may name; anything else is `other` (the method string is caller input). */
export const KNOWN_METHODS: ReadonlySet<string> = new Set([
  'initialize',
  'server/discover',
  'ping',
  'logging/setLevel',
  'tools/list',
  'tools/call',
  'prompts/list',
  'prompts/get',
  'resources/list',
  'resources/templates/list',
  'resources/read',
  'resources/subscribe',
  'resources/unsubscribe',
  'completion/complete',
  'subscriptions/listen',
  'tasks/get',
  'tasks/update',
  'tasks/cancel',
  'tasks/list',
  'tasks/result',
  'notifications/initialized',
  'notifications/cancelled',
  'notifications/progress',
  'notifications/roots/list_changed',
]);

const METHOD_CLASSES: ReadonlySet<string> = new Set([
  'tool_call',
  'list',
  'read',
  'lifecycle',
  'notification',
  'listen',
  'task',
  'response',
  'other',
]);

const REFUSAL_RE = /^[a-z][a-z_]{0,31}$/;
const REQUEST_ID_RE = /^[0-9a-fA-F-]{8,64}$/;
const VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;
const ENVIRONMENTS: ReadonlySet<string> = new Set(['production', 'test']);

type Validator = (value: unknown) => AttributeValue | undefined;

const text =
  (re: RegExp): Validator =>
  (v) =>
    typeof v === 'string' && re.test(v) ? v : undefined;
const oneOf =
  (set: ReadonlySet<string>): Validator =>
  (v) =>
    typeof v === 'string' && set.has(v) ? v : undefined;
const count =
  (max: number): Validator =>
  (v) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : undefined;

/** The only attributes that exist, with what each may hold. */
export const SPAN_ATTRIBUTES: Readonly<Record<string, Validator>> = Object.freeze({
  'mcp.method.name': oneOf(new Set([...KNOWN_METHODS, 'other'])),
  'agility_bridge.method_class': oneOf(METHOD_CLASSES),
  // The tool name is checked against the registry by `spanAttributes`, which is what puts it here.
  'gen_ai.tool.name': text(/^[a-z][a-z0-9_]{0,63}$/),
  'http.response.status_code': count(599),
  'agility_bridge.outcome': oneOf(new Set(['ok', 'refused', 'rate_limited', 'failed'])),
  'agility_bridge.fault': oneOf(new Set(['none', 'caller', 'upstream', 'server'])),
  'error.type': (v) =>
    typeof v === 'string' && (KNOWN_CODES.has(v) || v === 'http_4xx' || v === 'http_5xx') ? v : undefined,
  'agility_bridge.refusal': text(REFUSAL_RE),
  'agility_bridge.requests': count(100_000),
  'agility_bridge.request_id': text(REQUEST_ID_RE),
});

/** The resource attributes: who is sending, never what or for whom. */
export const RESOURCE_ATTRIBUTES: Readonly<Record<string, Validator>> = Object.freeze({
  'service.name': oneOf(new Set(['agility-bridge'])),
  'service.version': text(VERSION_RE),
  'deployment.environment.name': oneOf(ENVIRONMENTS),
});

function keep(
  allowed: Readonly<Record<string, Validator>>,
  raw: Readonly<Record<string, unknown>>,
): Attributes {
  const out: Record<string, AttributeValue> = {};
  for (const key of Object.keys(allowed)) {
    if (!Object.hasOwn(raw, key)) continue;
    const value = (allowed[key] as Validator)(raw[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Keeps the span attributes on the list with a valid value, and nothing else. */
export function sanitizeAttributes(raw: Readonly<Record<string, unknown>>): Attributes {
  return keep(SPAN_ATTRIBUTES, raw);
}

/** The same for the resource attributes. */
export function sanitizeResource(raw: Readonly<Record<string, unknown>>): Attributes {
  return keep(RESOURCE_ATTRIBUTES, raw);
}

/** What the host knows about one finished MCP request. Everything here is classified, not copied (see `spanAttributes`). */
export interface SpanFacts {
  /** The JSON-RPC method as classified from the body (bounded), or null. */
  readonly method: string | null;
  readonly kind: string;
  /** `tools/call`: the tool name the caller asked for. */
  readonly tool: string | null;
  /** The HTTP status of the answer. */
  readonly status: number;
  /** Why the request was refused before reaching a tool (our own vocabulary), or null. */
  readonly refusal: string | null;
  /** The stable `AB_*` code of a failed tool call, or null. */
  readonly errorCode: string | null;
  /** Agility requests the call used. */
  readonly requestsUsed?: number | undefined;
  readonly requestId: string;
}

export interface Classified {
  readonly outcome: Outcome;
  readonly fault: Fault;
  readonly errorType?: string;
}

/** Outcome, fault and `error.type` of one request: the error-rate semantics (L-118). */
export function classify(facts: Pick<SpanFacts, 'status' | 'refusal' | 'errorCode'>): Classified {
  const { status, refusal, errorCode } = facts;
  if (refusal !== null) {
    if (status === 429) return { outcome: 'rate_limited', fault: 'caller', errorType: ErrorCode.LimitRate };
    if (status >= 500) return { outcome: 'failed', fault: 'server', errorType: 'http_5xx' };
    return {
      outcome: 'refused',
      fault: 'caller',
      errorType: status === 401 ? ErrorCode.AuthUnauthorized : 'http_4xx',
    };
  }
  if (errorCode !== null) {
    const fault = FAULT_OF_CODE[errorCode] ?? 'server';
    return {
      outcome: 'failed',
      fault,
      ...(KNOWN_CODES.has(errorCode) ? { errorType: errorCode } : {}),
    };
  }
  if (status >= 500) return { outcome: 'failed', fault: 'server', errorType: 'http_5xx' };
  if (status >= 400) return { outcome: 'refused', fault: 'caller', errorType: 'http_4xx' };
  return { outcome: 'ok', fault: 'none' };
}

/** Whether a fault counts as a service error: the span status is ERROR for these and only these. */
export const isServiceError = (fault: Fault): boolean => fault === 'server' || fault === 'upstream';

/**
 * The attributes of one request's span, from classified facts: a method only if it is a known MCP method, a tool only if it is
 * registered (`knownTools`), the fault and outcome from `classify`, our own refusal code, a count of Agility requests. The
 * result is sanitised again, so even a mistake here cannot widen what leaves the process.
 */
export function spanAttributes(facts: SpanFacts, knownTools: ReadonlySet<string>): Attributes {
  const c = classify(facts);
  const method = facts.method !== null && KNOWN_METHODS.has(facts.method) ? facts.method : 'other';
  return sanitizeAttributes({
    'mcp.method.name': method,
    'agility_bridge.method_class': METHOD_CLASSES.has(facts.kind) ? facts.kind : 'other',
    ...(facts.kind === 'tool_call' && facts.tool !== null
      ? { 'gen_ai.tool.name': knownTools.has(facts.tool) ? facts.tool : 'unknown' }
      : {}),
    'http.response.status_code': facts.status,
    'agility_bridge.outcome': c.outcome,
    'agility_bridge.fault': c.fault,
    ...(c.errorType === undefined ? {} : { 'error.type': c.errorType }),
    ...(facts.refusal === null
      ? {}
      : { 'agility_bridge.refusal': REFUSAL_RE.test(facts.refusal) ? facts.refusal : 'other' }),
    ...(facts.requestsUsed === undefined ? {} : { 'agility_bridge.requests': facts.requestsUsed }),
    'agility_bridge.request_id': facts.requestId,
  });
}
