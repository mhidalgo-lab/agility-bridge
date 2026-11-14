// SPDX-License-Identifier: Apache-2.0
// P9-24 over HTTP: `get_embedded_image` is absent from tools/list and refused by name unless the workspace turns image
// download on and the grant keeps it on (THREAT_MODEL A8); a download writes an audit row with the asset number, the
// image endpoint and id, size and type, and never the bytes. Nothing is fetched on a denial.
import { describe, expect, it } from 'vitest';
import { FAKE_BASE_URL } from '../../core/test/harness/index.ts';
import { ASSETS, connect, world } from './helpers/world.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7, 7]);
const image = (id: number) => `<p>Actual</p><img src="${FAKE_BASE_URL}/embedded.img/${id}" alt="">`;
const story = {
  _oid: 'Story:1',
  Number: 'B-00001',
  Name: 'In A',
  AssetState: 64,
  Scope: 'Scope:1001',
  Description: image(11),
};
const other = {
  _oid: 'Story:2',
  Number: 'B-00002',
  Name: 'In B',
  AssetState: 64,
  Scope: 'Scope:2001',
  Description: image(22),
};
const assets = { ...ASSETS, Workitem: [story, other], Story: [story, other] };

function setup() {
  const served: string[] = [];
  return {
    served,
    options: {
      assets,
      agility: (_req: Request, call: { path: string }) => {
        if (!call.path.startsWith('embedded.img/')) return undefined;
        served.push(call.path);
        return new Response(PNG, { headers: { 'content-type': 'image/png' } });
      },
    },
  };
}

const names = async (c: Awaited<ReturnType<typeof connect>>) =>
  (await c.listTools()).tools.map((t) => t.name);

describe('get_embedded_image over HTTP', () => {
  it('is neither listed nor callable by default, also with attachments on, and nothing is fetched', async () => {
    const { options, served } = setup();
    const w = await world({}, options);
    await w.storage.workspaces.update(w.ids.workspaceA, { limits: { attachmentDownload: true } });
    const client = await connect(w, 'team-a', w.tokens.alice);
    expect(await names(client)).not.toContain('get_embedded_image');
    await expect(
      client.callTool({ name: 'get_embedded_image', arguments: { asset: 'B-00001', image: 1 } }),
    ).rejects.toThrow(/not found/);
    expect(served).toEqual([]);
    await client.close();
  });

  it('returns an image block once the workspace turns it on, and a grant can turn it off again', async () => {
    const { options, served } = setup();
    const w = await world({}, options);
    await w.storage.workspaces.update(w.ids.workspaceA, { limits: { imageDownload: true } });
    const client = await connect(w, 'team-a', w.tokens.alice);
    expect(await names(client)).toContain('get_embedded_image');
    const r = await client.callTool({
      name: 'get_embedded_image',
      arguments: { asset: 'B-00001', image: 1 },
    });
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    const blocks = r.content as Array<{ type: string; mimeType?: string; data?: string }>;
    expect(blocks.map((b) => b.type)).toEqual(['text', 'image']);
    expect(blocks[1]).toMatchObject({ mimeType: 'image/png', data: btoa(String.fromCharCode(...PNG)) });
    expect(served).toEqual(['embedded.img/11']);
    await client.close();

    await w.storage.grants.update(w.ids.aliceGrant, { limits: { imageDownload: false } });
    w.now.t += 120_000; // past the access cache (L-068)
    const again = await connect(w, 'team-a', w.tokens.alice);
    expect(await names(again)).not.toContain('get_embedded_image');
    await again.close();
  });

  it('writes an audit row per download without the bytes', async () => {
    const { options } = setup();
    const w = await world({}, options);
    await w.storage.workspaces.update(w.ids.workspaceA, { limits: { imageDownload: true } });
    const client = await connect(w, 'team-a', w.tokens.alice);
    await client.callTool({ name: 'get_embedded_image', arguments: { asset: 'B-00001', image: 1 } });
    await client.close();
    await w.audit.flush();
    const rows = await w.storage.audit.query({ kind: 'tool_call' });
    const row = rows.find((r) => r.action === 'get_embedded_image');
    expect(row).toMatchObject({
      status: 'ok',
      details: {
        download: {
          asset: 'B-00001',
          attachment: 'embedded.img/11',
          bytes: PNG.length,
          contentType: 'image/png',
        },
      },
    });
    expect(JSON.stringify(rows)).not.toContain(btoa(String.fromCharCode(...PNG)));
  });

  it('refuses an image of an asset outside the workspace without reading its text or image', async () => {
    const { options, served } = setup();
    const w = await world({}, options);
    await w.storage.workspaces.update(w.ids.workspaceA, { limits: { imageDownload: true } });
    const client = await connect(w, 'team-a', w.tokens.alice);
    const r = await client.callTool({
      name: 'get_embedded_image',
      arguments: { asset: 'B-00002', image: 1 },
    });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('AB_NOT_FOUND');
    expect(served).toEqual([]);
    await client.close();
  });
});
