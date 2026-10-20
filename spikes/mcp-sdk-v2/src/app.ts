// SPDX-License-Identifier: Apache-2.0
// Web-standard Hono app shared by Node and Workers: one MCP endpoint per workspace, static bearer auth.
import { createMcpHandler } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { buildServer, resolveGrant, spikeToken } from './server.ts';

const handler = createMcpHandler(
  ({ era, authInfo }) => {
    const grant = resolveGrant(String(authInfo?.extra?.['slug'] ?? ''));
    if (!grant) throw new Error('no grant'); // unreachable: the route checks first
    return buildServer(grant, era);
  },
  { legacy: 'stateless' },
);

export const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

app.all('/w/:slug/mcp', async (c) => {
  const slug = c.req.param('slug');
  const grant = resolveGrant(slug);
  if (!grant || c.req.header('authorization') !== `Bearer ${spikeToken(slug)}`) {
    return c.json({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer' });
  }
  // The grant travels through authInfo (validated pass-through), never module state (L-013).
  return handler.fetch(c.req.raw, {
    authInfo: { token: 'spike', clientId: 'spike', scopes: [], extra: { slug } },
  });
});
