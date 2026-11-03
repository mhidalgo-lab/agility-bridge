// SPDX-License-Identifier: Apache-2.0
// Property and fuzz tests for what an unauthenticated or semi-trusted caller can send to the HTTP app (P9-01,
// THREAT_MODEL T9, T10, T11, T20): MCP bodies, OAuth client ids, redirect URIs and registrations. Seeded and
// replayable (L-123).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { propertyParams } from '../../core/test/harness/property.ts';
import { classifyMcpMessage, readMcpBody } from '../src/index.ts';
import {
  checkRegistration,
  clientIdUrlProblem,
  MAX_CLIENT_ID_URL_CHARS,
  MAX_REDIRECT_URI_CHARS,
  redirectUriVerdict,
} from '../src/oauth/clients.ts';

const params = propertyParams(300);

const urlish = fc.oneof(
  fc.string({ maxLength: 200 }),
  fc.webUrl({ withFragments: true, withQueryParameters: true }),
  fc
    .array(
      fc.constantFrom(
        'https://',
        'http://',
        'javascript:',
        'data:text/html,',
        '//',
        '@',
        ':443',
        '/..',
        '/./',
        '\\',
        '#',
        '*',
        ' ',
        '\t',
        '%2e',
        'localhost',
        '127.0.0.1',
        '[::1]',
        '10.0.0.1',
        'example.com',
        'app.example.com',
        '/cb',
      ),
      { maxLength: 10 },
    )
    .map((p) => p.join('')),
);

describe('fuzz: CIMD client ids (T11)', () => {
  it('a client id that may be fetched is a canonical https URL on a named, dotted host with a path', () => {
    fc.assert(
      fc.property(urlish, (clientId) => {
        const problem = clientIdUrlProblem(clientId, 'bridge.example.com');
        if (problem !== null) {
          expect(problem).toMatch(/^client_/);
          return;
        }
        const url = new URL(clientId);
        expect(url.href).toBe(clientId);
        expect(url.protocol).toBe('https:');
        expect([url.username, url.password, url.port, url.hash]).toEqual(['', '', '', '']);
        expect(url.pathname).not.toBe('/');
        expect(url.hostname).toContain('.');
        expect(url.hostname).not.toBe('bridge.example.com');
        expect(clientId.length).toBeLessThanOrEqual(MAX_CLIENT_ID_URL_CHARS);
        // Never an address literal: no fetch may be aimed at an IP (SSRF).
        expect(url.hostname).not.toMatch(/^[\d.]+$|^\[/);
      }),
      params,
    );
  });

  it('the allowed host list is exact: another host never passes', () => {
    fc.assert(
      fc.property(urlish, (clientId) => {
        const problem = clientIdUrlProblem(clientId, 'bridge.example.com', ['claude.ai']);
        if (problem === null) expect(new URL(clientId).hostname).toBe('claude.ai');
      }),
      params,
    );
  });
});

describe('fuzz: redirect URIs (T9)', () => {
  it('a usable redirect is https on a named host or loopback, never a code-running scheme, fragment or wildcard', () => {
    fc.assert(
      fc.property(urlish, (uri) => {
        const verdict = redirectUriVerdict(uri, { allowedHosts: ['claude.ai'] });
        if (verdict !== 'usable') return;
        const url = new URL(uri);
        expect(['https:', 'http:']).toContain(url.protocol);
        expect(uri).not.toMatch(/[#*\s\p{Cc}]/u);
        expect([url.username, url.password]).toEqual(['', '']);
        expect(uri.length).toBeLessThanOrEqual(MAX_REDIRECT_URI_CHARS);
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        if (!loopback) {
          expect(url.protocol).toBe('https:');
          expect(url.hostname).toBe('claude.ai');
        }
      }),
      params,
    );
  });

  it('code-running schemes are refused outright, whatever follows', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('javascript:', 'data:', 'vbscript:', 'file:', 'blob:'),
        fc.string({ maxLength: 60 }),
        (scheme, rest) => {
          expect(redirectUriVerdict(`${scheme}${rest}`, {})).not.toBe('usable');
        },
      ),
      params,
    );
  });
});

describe('fuzz: dynamic client registration (T10)', () => {
  it('never throws on any body, and an accepted one forwards only usable redirects', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 300 }),
          fc.json(),
          fc
            .array(urlish, { maxLength: 12 })
            .map((uris) => JSON.stringify({ redirect_uris: uris, client_name: 'x' })),
        ),
        (body) => {
          const verdict = checkRegistration(body, ['claude.ai']);
          if (!verdict.ok) return;
          expect(verdict.redirectUris.length).toBeGreaterThan(0);
          for (const uri of verdict.redirectUris)
            expect(redirectUriVerdict(uri, { allowedHosts: ['claude.ai'] })).toBe('usable');
          const forwarded = JSON.parse(verdict.body) as Record<string, unknown>;
          expect(
            Object.keys(forwarded).every((k) =>
              /^(redirect_uris|client_name|grant_types|response_types|token_endpoint_auth_method|scope)$/.test(
                k,
              ),
            ),
          ).toBe(true);
        },
      ),
      params,
    );
  });
});

describe('fuzz: MCP messages (T5, T20)', () => {
  it('classifies any JSON value without throwing, with a bounded method and tool name', () => {
    fc.assert(
      fc.property(fc.anything({ maxDepth: 3 }), (message) => {
        const c = classifyMcpMessage(message);
        expect(c.method === null || c.method.length <= 100).toBe(true);
        expect(c.tool === null || c.tool.length <= 64).toBe(true);
        if (c.tool !== null) expect(c.kind).toBe('tool_call');
      }),
      params,
    );
  });

  it('reads a body up to the cap and refuses anything bigger, a batch or a wrong type, whatever the bytes', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.string({ maxLength: 400 }),
          fc.json(),
          fc.json().map((j) => `[${j}]`),
        ),
        fc.integer({ min: 16, max: 256 }),
        async (text, cap) => {
          const request = new Request('https://x.test/mcp', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: text,
          });
          const result = await readMcpBody(request, cap);
          if (result.ok) {
            expect(result.bytes.byteLength).toBeLessThanOrEqual(cap);
            expect(Array.isArray(result.message)).toBe(false);
          } else {
            expect([400, 413, 415]).toContain(result.status);
          }
        },
      ),
      { ...params, numRuns: 150 },
    );
  });
});
