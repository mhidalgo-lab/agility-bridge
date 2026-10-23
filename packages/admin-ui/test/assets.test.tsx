// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// The panel's static assets (P4-03): hashed names, SRI that matches the bytes served, long caching, nothing else served.
import { describe, expect, it } from 'vitest';
import { createAdminUi } from '../src/app.ts';
import { ASSET_BASE, ASSET_CACHE_CONTROL, ASSETS, assetHref, findAsset } from '../src/assets.ts';
import { Layout } from '../src/components.tsx';
import { renderDocument } from '../src/pages.tsx';
import { fakeDeps } from './helpers/fake-deps.ts';

const digest = async (algorithm: 'SHA-256' | 'SHA-384', text: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest(algorithm, new TextEncoder().encode(text)));
const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

describe('embedded assets', () => {
  it('carry a content hash in the name and a SHA-384 SRI value of their own bytes', async () => {
    for (const asset of Object.values(ASSETS)) {
      const hash = hex(await digest('SHA-256', asset.body)).slice(0, 16);
      expect(asset.file).toMatch(new RegExp(`^admin\\.${hash}\\.(css|js)$`));
      expect(asset.integrity).toBe(`sha384-${base64(await digest('SHA-384', asset.body))}`);
    }
  });

  it('are served with the hash, a year of caching, and a type that matches', async () => {
    const ui = createAdminUi(fakeDeps().deps);
    for (const asset of Object.values(ASSETS)) {
      const res = await ui.request(`/assets/${asset.file}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(ASSET_CACHE_CONTROL).toBe('public, max-age=31536000, immutable');
      expect(res.headers.get('content-type')).toBe(asset.type);
      const body = await res.text();
      // The bytes served are the bytes the page's integrity attribute was computed from.
      expect(`sha384-${base64(await digest('SHA-384', body))}`).toBe(asset.integrity);
    }
    expect(ASSETS.css.type).toBe('text/css; charset=utf-8');
    expect(ASSETS.js.type).toBe('text/javascript; charset=utf-8');
  });

  it('are public (no session needed) and the only files served', async () => {
    const ui = createAdminUi(fakeDeps().deps);
    for (const name of [
      'admin.css',
      'admin.0000000000000000.css',
      '../admin.css',
      '..%2Fassets.generated.ts',
      'admin.js.map',
      '',
      `${ASSETS.css.file}/x`,
      ASSETS.css.file.toUpperCase(),
    ]) {
      const res = await ui.request(`/assets/${name}`);
      // Never the file: a 404, or (for paths the router normalises away from /assets) the sign-in redirect.
      expect([303, 404], name).toContain(res.status);
      expect(res.headers.get('content-type') ?? '', name).not.toMatch(/css|javascript/);
    }
    expect((await ui.request('/assets/admin.css')).status).toBe(404);
    expect((await ui.request('/assets/admin.0000000000000000.css')).status).toBe(404);
    expect(findAsset('assets.generated.ts')).toBeUndefined();
  });

  it('are referenced by the pages with exactly the integrity of the served bytes', () => {
    const html = renderDocument(<Layout title="x" />);
    expect(html).toContain(`href="${assetHref(ASSETS.css)}" integrity="${ASSETS.css.integrity}"`);
    expect(html).toContain(`src="${assetHref(ASSETS.js)}" integrity="${ASSETS.js.integrity}"`);
    expect(assetHref(ASSETS.css)).toBe(`${ASSET_BASE}/${ASSETS.css.file}`);
  });
});

describe('the script', () => {
  const js = ASSETS.js.body;

  it('has no HTML sink, no dynamic code and no network API', () => {
    expect(js).not.toMatch(
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\s*\(|new Function|fetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket/,
    );
  });

  it('moves the setup code out of the address bar and never sends it anywhere', () => {
    expect(js).toContain('location.hash');
    expect(js).toContain('history.replaceState');
  });
});
