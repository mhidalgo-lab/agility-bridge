// SPDX-License-Identifier: Apache-2.0
// What a span may say (P8-07, T30, L-118, L-119): the allowlist, the shape of each value, and the error-rate semantics.
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../../src/errors.ts';
import {
  classify,
  FAULT_OF_CODE,
  isServiceError,
  KNOWN_METHODS,
  RESOURCE_ATTRIBUTES,
  SPAN_ATTRIBUTES,
  sanitizeAttributes,
  sanitizeResource,
  spanAttributes,
} from '../../src/telemetry/index.ts';

const TOOLS = new Set(['get_sprint', 'whoami']);
const facts = {
  method: 'tools/call',
  kind: 'tool_call',
  tool: 'get_sprint',
  status: 200,
  refusal: null,
  errorCode: null,
  requestId: '3f2b8a6e-1c1d-4f2a-9d3e-0a1b2c3d4e5f',
};

describe('the attribute allowlist', () => {
  it('keeps the listed keys with valid values and nothing else', () => {
    const out = sanitizeAttributes({
      'mcp.method.name': 'tools/call',
      'gen_ai.tool.name': 'get_sprint',
      'http.response.status_code': 200,
      'agility_bridge.requests': 7,
      // None of these exist for the exporter, however they are passed:
      'agility_bridge.workspace': 'team-a',
      'enduser.id': 'alice@example.test',
      'http.request.header.authorization': 'Bearer abc',
      'url.full': 'https://agility.example.com/x?where=Name%3D%22secret%22',
      'db.statement': 'from: Story where: Name="x"',
      'exception.message': 'Story B-01234 "Salary review" failed',
      'client.address': '203.0.113.7',
      'jsonrpc.request.id': '42',
      password: 'p',
    });
    expect(out).toEqual({
      'mcp.method.name': 'tools/call',
      'gen_ai.tool.name': 'get_sprint',
      'http.response.status_code': 200,
      'agility_bridge.requests': 7,
    });
  });

  it('lists exactly these span and resource attributes (a new one needs this test and the guide to change)', () => {
    expect(Object.keys(SPAN_ATTRIBUTES).sort()).toEqual(
      [
        'agility_bridge.fault',
        'agility_bridge.method_class',
        'agility_bridge.outcome',
        'agility_bridge.refusal',
        'agility_bridge.request_id',
        'agility_bridge.requests',
        'error.type',
        'gen_ai.tool.name',
        'http.response.status_code',
        'mcp.method.name',
      ].sort(),
    );
    expect(Object.keys(RESOURCE_ATTRIBUTES).sort()).toEqual(
      ['deployment.environment.name', 'service.name', 'service.version'].sort(),
    );
  });

  it.each([
    ['mcp.method.name', 'tools/call; rm -rf'],
    ['mcp.method.name', 'my/custom/method'],
    ['gen_ai.tool.name', 'Get Sprint'],
    ['gen_ai.tool.name', 'a'.repeat(65)],
    ['http.response.status_code', 99999],
    ['http.response.status_code', '200'],
    ['http.response.status_code', 200.5],
    ['agility_bridge.outcome', 'success'],
    ['agility_bridge.fault', 'user'],
    ['error.type', 'Story B-01234 failed'],
    ['error.type', 'AB_MADE_UP'],
    ['agility_bridge.refusal', 'No token: Bearer abc'],
    ['agility_bridge.refusal', 'x'.repeat(40)],
    ['agility_bridge.requests', -1],
    ['agility_bridge.requests', Number.NaN],
    ['agility_bridge.request_id', 'not an id; drop table'],
  ])('drops %s = %j', (key, value) => {
    expect(sanitizeAttributes({ [key]: value })).toEqual({});
  });

  it('shapes the resource the same way', () => {
    expect(
      sanitizeResource({
        'service.name': 'agility-bridge',
        'service.version': '0.8.0',
        'deployment.environment.name': 'production',
        'host.name': 'secret-host',
        'service.instance.id': 'abc',
      }),
    ).toEqual({
      'service.name': 'agility-bridge',
      'service.version': '0.8.0',
      'deployment.environment.name': 'production',
    });
    expect(sanitizeResource({ 'service.name': 'other', 'deployment.environment.name': 'prod; x' })).toEqual(
      {},
    );
  });
});

describe('spanAttributes', () => {
  it('names a method only if it is a known MCP method and a tool only if it is registered', () => {
    expect(spanAttributes(facts, TOOLS)['gen_ai.tool.name']).toBe('get_sprint');
    expect(spanAttributes({ ...facts, tool: 'drop_everything' }, TOOLS)['gen_ai.tool.name']).toBe('unknown');
    expect(spanAttributes({ ...facts, method: 'x/steal' }, TOOLS)['mcp.method.name']).toBe('other');
    expect(spanAttributes({ ...facts, method: null }, TOOLS)['mcp.method.name']).toBe('other');
    // A tool name only appears on a tool call.
    expect(spanAttributes({ ...facts, method: 'tools/list', kind: 'list' }, TOOLS)).not.toHaveProperty(
      'gen_ai.tool.name',
    );
    for (const m of KNOWN_METHODS)
      expect(spanAttributes({ ...facts, method: m }, TOOLS)['mcp.method.name']).toBe(m);
  });

  it('never carries a refusal that is not one of our short codes', () => {
    expect(
      spanAttributes({ ...facts, status: 401, refusal: 'no_token' }, TOOLS)['agility_bridge.refusal'],
    ).toBe('no_token');
    expect(
      spanAttributes({ ...facts, status: 401, refusal: 'Bearer abc.def' }, TOOLS)['agility_bridge.refusal'],
    ).toBe('other');
  });

  it('carries the Agility request count and our own request id', () => {
    const a = spanAttributes({ ...facts, requestsUsed: 12 }, TOOLS);
    expect(a['agility_bridge.requests']).toBe(12);
    expect(a['agility_bridge.request_id']).toBe(facts.requestId);
  });
});

describe('error-rate semantics (L-118)', () => {
  it('classifies every error code explicitly', () => {
    for (const code of Object.values(ErrorCode)) expect(FAULT_OF_CODE[code], code).toBeDefined();
    expect(Object.keys(FAULT_OF_CODE).sort()).toEqual(Object.values(ErrorCode).sort());
  });

  it.each([
    [ErrorCode.InputInvalid, 'caller', false],
    [ErrorCode.NotFound, 'caller', false],
    [ErrorCode.AuthForbidden, 'caller', false],
    [ErrorCode.LimitRate, 'caller', false],
    [ErrorCode.BudgetExhausted, 'caller', false],
    [ErrorCode.WriteApprovalDeclined, 'caller', false],
    [ErrorCode.WriteConflict, 'caller', false],
    [ErrorCode.AgilityAuth, 'caller', false],
    [ErrorCode.AgilityRateLimited, 'upstream', true],
    [ErrorCode.AgilityTimeout, 'upstream', true],
    [ErrorCode.AgilityUnavailable, 'upstream', true],
    [ErrorCode.Internal, 'server', true],
    [ErrorCode.WriteAuditUnavailable, 'server', true],
    ['AB_FROM_THE_FUTURE', 'server', true],
  ])('%s is a %s fault; service error: %s', (code, fault, isError) => {
    const c = classify({ status: 200, refusal: null, errorCode: code });
    expect(c.fault).toBe(fault);
    expect(isServiceError(c.fault)).toBe(isError);
    expect(c.outcome).toBe('failed');
  });

  it('a request that succeeded, was refused or was limited is never a service error', () => {
    expect(classify({ status: 200, refusal: null, errorCode: null })).toEqual({
      outcome: 'ok',
      fault: 'none',
    });
    expect(classify({ status: 401, refusal: 'no_token', errorCode: null })).toMatchObject({
      outcome: 'refused',
      fault: 'caller',
      errorType: ErrorCode.AuthUnauthorized,
    });
    expect(classify({ status: 429, refusal: 'rate_limited', errorCode: null })).toMatchObject({
      outcome: 'rate_limited',
      fault: 'caller',
      errorType: ErrorCode.LimitRate,
    });
    expect(classify({ status: 413, refusal: 'body', errorCode: null }).fault).toBe('caller');
    expect(classify({ status: 405, refusal: 'method', errorCode: null }).fault).toBe('caller');
  });

  it('a 5xx is a server fault, refused or not', () => {
    expect(classify({ status: 503, refusal: 'unavailable', errorCode: null })).toMatchObject({
      outcome: 'failed',
      fault: 'server',
      errorType: 'http_5xx',
    });
    expect(classify({ status: 504, refusal: 'deadline', errorCode: null }).fault).toBe('server');
    expect(classify({ status: 500, refusal: null, errorCode: null }).fault).toBe('server');
  });
});
