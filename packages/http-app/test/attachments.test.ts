// SPDX-License-Identifier: Apache-2.0
// P6-04 over HTTP: `get_attachment` is absent from tools/list and refused by name unless the workspace turns the
// download on and the grant keeps it on (D-08, THREAT_MODEL A8); a download writes an audit row with the asset number,
// attachment id, size and content type, and never the content.
import { describe, expect, it } from 'vitest';
import { ASSETS, connect, world } from './helpers/world.ts';

const SECRET_CONTENT = 'Quarterly-Numbers-Do-Not-Leak';

const story = { _oid: 'Story:1', Number: 'B-00001', Name: 'In A', AssetState: 64, Scope: 'Scope:1001' };
const assets = {
  ...ASSETS,
  Workitem: [story],
  Attachment: [
    {
      _oid: 'Attachment:1',
      Asset: 'Story:1',
      'Asset:Workitem.Scope': 'Scope:1001',
      Name: 'numbers.txt',
      ContentType: 'text/plain',
      AssetState: 64,
    },
  ],
};

function setup() {
  const served: string[] = [];
  return {
    served,
    options: {
      assets,
      agility: (_req: Request, call: { path: string }) => {
        if (!call.path.startsWith('attachments.img/')) return undefined;
        served.push(call.path);
        return new Response(SECRET_CONTENT, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
      },
    },
  };
}

const names = async (c: Awaited<ReturnType<typeof connect>>) =>
  (await c.listTools()).tools.map((t) => t.name);

describe('get_attachment over HTTP', () => {
  it('is neither listed nor callable by default, and nothing is fetched', async () => {
    const { options, served } = setup();
    const w = await world({}, options);
    const client = await connect(w, 'team-a', w.tokens.alice);
    const listed = await names(client);
    expect(listed).toEqual(expect.arrayContaining(['get_conversations', 'list_attachments']));
    expect(listed).not.toContain('get_attachment');
    await expect(
      client.callTool({
        name: 'get_attachment',
        arguments: { asset: 'B-00001', attachment: 'Attachment:1' },
      }),
    ).rejects.toThrow(/not found/);
    expect(served).toEqual([]);
    await client.close();
  });

  it('is offered once the workspace turns it on, and a grant can turn it off again', async () => {
    const { options, served } = setup();
    const w = await world({}, options);
    await w.storage.workspaces.update(w.ids.workspaceA, { limits: { attachmentDownload: true } });
    const client = await connect(w, 'team-a', w.tokens.alice);
    expect(await names(client)).toContain('get_attachment');
    const r = await client.callTool({
      name: 'get_attachment',
      arguments: { asset: 'B-00001', attachment: 'Attachment:1' },
    });
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    expect(JSON.stringify(r.content)).toContain(SECRET_CONTENT);
    expect(served).toEqual(['attachments.img/1']);
    await client.close();

    await w.storage.grants.update(w.ids.aliceGrant, { limits: { attachmentDownload: false } });
    w.now.t += 120_000; // past the access cache (L-068)
    const again = await connect(w, 'team-a', w.tokens.alice);
    expect(await names(again)).not.toContain('get_attachment');
    await again.close();
  });

  it('writes an audit row per download with the asset number, attachment id, size and type, never the content', async () => {
    const { options } = setup();
    const w = await world({}, options);
    await w.storage.workspaces.update(w.ids.workspaceA, { limits: { attachmentDownload: true } });
    const client = await connect(w, 'team-a', w.tokens.alice);
    await client.callTool({
      name: 'get_attachment',
      arguments: { asset: 'B-00001', attachment: 'Attachment:1' },
    });
    await client.close();
    await w.audit.flush();
    const rows = await w.storage.audit.query({ kind: 'tool_call' });
    const row = rows.find((r) => r.action === 'get_attachment');
    expect(row).toMatchObject({
      status: 'ok',
      details: {
        credential: 'personal',
        download: {
          asset: 'B-00001',
          attachment: 'Attachment:1',
          bytes: SECRET_CONTENT.length,
          contentType: 'text/plain',
        },
      },
    });
    expect(JSON.stringify(rows)).not.toContain(SECRET_CONTENT);
  });

  it('refuses an attachment of an asset outside the workspace without a content request', async () => {
    const { options, served } = setup();
    const w = await world({}, options);
    await w.storage.workspaces.update(w.ids.workspaceA, { limits: { attachmentDownload: true } });
    const client = await connect(w, 'team-a', w.tokens.alice);
    const r = await client.callTool({
      name: 'get_attachment',
      arguments: { asset: 'B-00002', attachment: 'Attachment:1' },
    });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('AB_NOT_FOUND');
    expect(served).toEqual([]);
    await client.close();
  });
});
