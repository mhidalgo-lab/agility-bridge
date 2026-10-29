// SPDX-License-Identifier: Apache-2.0
import { type CallToolResult, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { redact } from './redact.ts';

/**
 * Stable error codes (tool conventions, "Error codes (final)"). They are part of the public contract: agents and docs
 * refer to them, so they are only ever added, never renamed or removed (see the conventions' Deprecations).
 */
export const ErrorCode = {
  AuthUnauthorized: 'AB_AUTH_UNAUTHORIZED',
  AuthForbidden: 'AB_AUTH_FORBIDDEN',
  ToolDisabled: 'AB_TOOL_DISABLED',
  InputInvalid: 'AB_INPUT_INVALID',
  NotFound: 'AB_NOT_FOUND',
  Ambiguous: 'AB_AMBIGUOUS',
  LimitQuery: 'AB_LIMIT_QUERY',
  LimitResponseTooLarge: 'AB_LIMIT_RESPONSE_TOO_LARGE',
  LimitRate: 'AB_LIMIT_RATE',
  LimitQuota: 'AB_LIMIT_QUOTA',
  BudgetExhausted: 'AB_BUDGET_EXHAUSTED',
  AgilityAuth: 'AB_AGILITY_AUTH',
  AgilityRateLimited: 'AB_AGILITY_RATE_LIMITED',
  AgilityTimeout: 'AB_AGILITY_TIMEOUT',
  AgilityUnavailable: 'AB_AGILITY_UNAVAILABLE',
  AgilityTls: 'AB_AGILITY_TLS',
  AgilityWrongInstance: 'AB_AGILITY_WRONG_INSTANCE',
  AgilityError: 'AB_AGILITY_ERROR',
  WriteApprovalPending: 'AB_WRITE_APPROVAL_PENDING',
  WriteApprovalUnavailable: 'AB_WRITE_APPROVAL_UNAVAILABLE',
  WriteApprovalDeclined: 'AB_WRITE_APPROVAL_DECLINED',
  WriteConflict: 'AB_WRITE_CONFLICT',
  WriteAuditUnavailable: 'AB_WRITE_AUDIT_UNAVAILABLE',
  WriteLimitUnavailable: 'AB_WRITE_LIMIT_UNAVAILABLE',
  Internal: 'AB_INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface AbErrorOptions {
  /** What the agent (or user) can do about it, e.g. "Narrow the time range". Written by us, never Agility text. */
  hint?: string;
  /** Structured details for the agent (never secrets; redacted on output). */
  details?: Record<string, unknown>;
  /**
   * The details were produced here (limits, counts, names of our own settings) and contain no Agility text: they are
   * shown as they are. Default false: details may carry Agility text (candidate names, messages) and are shown only
   * through the untrusted-data envelope (ADR-0015).
   */
  localDetails?: boolean;
  /**
   * Audit facts for a failed call (identifiers and sizes, never content or Agility text), recorded by the observer
   * next to the error code. Not shown to the agent.
   */
  audit?: AuditDownload;
  cause?: unknown;
}

/** A downloaded (or refused) attachment as the audit records it: ids, size and type, never content (THREAT_MODEL A8). */
export interface AuditDownload {
  readonly asset: string;
  readonly attachment: string;
  readonly bytes: number;
  readonly contentType: string;
}

/** An expected, agent-actionable failure. `message` and `hint` must be safe to show to the client. */
export class AbError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly details: Record<string, unknown> | undefined;
  readonly localDetails: boolean;
  /** Set by the code that knew the ids when the failure came after the request (see `AbErrorOptions.audit`). */
  audit: AuditDownload | undefined;

  constructor(code: ErrorCode, message: string, options: AbErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AbError';
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
    this.localDetails = options.localDetails === true;
    this.audit = options.audit;
  }
}

export const isAbError = (e: unknown): e is AbError => e instanceof AbError;

/** `_meta` key carrying the error code on tool results, so clients can branch without parsing text. */
export const ERROR_META_KEY = 'agility-bridge/error';

/** Renders details that may contain Agility text. The output shaper (P1-05) supplies the untrusted-data envelope. */
export type UntrustedRenderer = (text: string, source: string) => string;

export interface ToolErrorOptions {
  /** Without a renderer, non-local details are withheld rather than shown unwrapped (fail closed). */
  renderUntrusted?: UntrustedRenderer;
}

/**
 * Map any thrown value to an MCP tool error result (`isError: true`, text `CODE: message`, optional `Hint:`).
 * An unexpected error never leaks its text: it becomes AB_INTERNAL with the request id as reference.
 */
export function toToolErrorResult(
  error: unknown,
  requestId: string,
  options: ToolErrorOptions = {},
): CallToolResult {
  const ab = isAbError(error)
    ? error
    : new AbError(ErrorCode.Internal, `Internal error. Reference: ${requestId}.`);
  const lines = [`${ab.code}: ${ab.message}`];
  if (ab.hint) lines.push(`Hint: ${ab.hint}`);
  if (ab.details && Object.keys(ab.details).length > 0) {
    const body = `Details: ${JSON.stringify(ab.details)}`;
    if (ab.localDetails) lines.push(body);
    else if (options.renderUntrusted) lines.push(options.renderUntrusted(body, 'error details'));
  }
  return {
    isError: true,
    content: [{ type: 'text', text: redact(lines.join('\n')) }],
    _meta: { [ERROR_META_KEY]: { code: ab.code, requestId } },
  };
}

/** Codes that mean "the request is wrong or not allowed", not "the server failed": JSON-RPC invalid params (L-019). */
const CLIENT_FAULT_CODES: ReadonlySet<string> = new Set([
  ErrorCode.InputInvalid,
  ErrorCode.AuthUnauthorized,
  ErrorCode.AuthForbidden,
  ErrorCode.ToolDisabled,
  ErrorCode.NotFound,
  ErrorCode.Ambiguous,
]);

/**
 * A failed resource read or prompt as clients see it: input and authorization errors are `-32602`, every other
 * `AB_*` failure `-32603`, with the code in `error.data.code`. Messages are redacted; unknown errors never leak text.
 */
export function toProtocolError(error: unknown): ProtocolError {
  if (isAbError(error)) {
    const data: Record<string, unknown> = { code: error.code };
    if (error.hint) data['hint'] = redact(error.hint);
    return new ProtocolError(
      CLIENT_FAULT_CODES.has(error.code) ? ProtocolErrorCode.InvalidParams : ProtocolErrorCode.InternalError,
      redact(`${error.code}: ${error.message}${error.hint ? ` Hint: ${error.hint}` : ''}`),
      data,
    );
  }
  return new ProtocolError(ProtocolErrorCode.InternalError, 'Internal error while handling the request.', {
    code: ErrorCode.Internal,
  });
}
