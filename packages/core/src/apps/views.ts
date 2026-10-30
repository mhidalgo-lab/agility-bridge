// SPDX-License-Identifier: Apache-2.0
// MCP Apps views (P8-03, THREAT_MODEL T27): `ui://agility-bridge/…` pages a client that declared Apps may render for the
// result of a tool. The page is static: it holds no data and makes no request; the host hands it the tool result.
// Offered only to a client that declared the extension and only when the operator did not turn `AB_MCP_APPS` off.
import { CLIENT_CAPABILITIES_META_KEY, type ClientCapabilities } from '@modelcontextprotocol/server';
import { VIEW_SCRIPT, VIEW_STYLE } from './view-script.ts';

/** The extension id and resource type of MCP Apps (SEP-1865, spec 2026-01-26). */
export const APPS_EXTENSION = 'io.modelcontextprotocol/ui';
export const APPS_MIME_TYPE = 'text/html;profile=mcp-app';

export interface AppView {
  readonly id: string;
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  /** The text of the page's `<title>` (our own words). */
  readonly title: string;
}

/** The views, by id. A tool names one in `view`. */
export const APP_VIEWS: readonly AppView[] = Object.freeze([
  Object.freeze({
    id: 'sprint-burndown',
    uri: 'ui://agility-bridge/sprint-burndown',
    name: 'Sprint burndown',
    description:
      'Chart of the remaining estimate of a sprint against the ideal line, from the result of get_sprint.',
    title: 'Sprint burndown',
  }),
  Object.freeze({
    id: 'status-distribution',
    uri: 'ui://agility-bridge/status-distribution',
    name: 'Status distribution',
    description: 'Bar chart of the items of a sprint by status category, from the result of sprint_health.',
    title: 'Status distribution',
  }),
]);

export function appViewById(id: string): AppView | undefined {
  return APP_VIEWS.find((v) => v.id === id);
}

/** Whether a client's declared capabilities include MCP Apps with the HTML profile. */
export function clientSupportsApps(caps: ClientCapabilities | undefined): boolean {
  const ext = (caps as { extensions?: unknown } | undefined)?.extensions;
  if (ext === null || typeof ext !== 'object') return false;
  const ui = (ext as Record<string, unknown>)[APPS_EXTENSION];
  if (ui === null || typeof ui !== 'object') return false;
  const types = (ui as { mimeTypes?: unknown }).mimeTypes;
  return Array.isArray(types) && types.includes(APPS_MIME_TYPE);
}

/** The Apps declaration of one 2026-07-28 request, read from its per-request envelope; false for anything else. */
export function requestDeclaresApps(message: unknown): boolean {
  if (message === null || typeof message !== 'object') return false;
  const params = (message as { params?: unknown }).params;
  if (params === null || typeof params !== 'object') return false;
  const meta = (params as { _meta?: unknown })._meta;
  if (meta === null || typeof meta !== 'object') return false;
  return clientSupportsApps((meta as Record<string, unknown>)[CLIENT_CAPABILITIES_META_KEY] as never);
}

/** The `_meta` a tool carries to link its view (the nested form of the spec, and the flat key older hosts read). */
export function toolViewMeta(view: AppView): Record<string, unknown> {
  return { ui: { resourceUri: view.uri }, 'ui/resourceUri': view.uri };
}

/** The `_meta` of the view resource: no network, no external resources, no frames, no extra permissions. */
export const VIEW_RESOURCE_META: Readonly<Record<string, unknown>> = Object.freeze({
  ui: Object.freeze({
    csp: Object.freeze({ connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }),
    prefersBorder: false,
  }),
});

async function sha256Base64(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  let binary = '';
  for (const b of digest) binary += String.fromCharCode(b);
  return btoa(binary);
}

const pages = new Map<string, Promise<string>>();

/**
 * The HTML of one view. Its policy allows exactly its own script and style by hash and nothing else: no network
 * (`connect-src 'none'`), no images, frames, objects, forms or base URL. Built once per process (it holds no request data).
 */
export function viewHtml(view: AppView): Promise<string> {
  const known = pages.get(view.id);
  if (known !== undefined) return known;
  const built = (async () => {
    const [script, style] = await Promise.all([sha256Base64(VIEW_SCRIPT), sha256Base64(VIEW_STYLE)]);
    const csp = [
      "default-src 'none'",
      `script-src 'sha256-${script}'`,
      `style-src 'sha256-${style}'`,
      "img-src 'none'",
      "connect-src 'none'",
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; ');
    return `<!doctype html>
<html lang="en" data-view="${view.id}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${view.title}</title>
<style>${VIEW_STYLE}</style>
</head>
<body>
<div id="root"></div>
<script>${VIEW_SCRIPT}</script>
</body>
</html>
`;
  })();
  pages.set(view.id, built);
  return built;
}
