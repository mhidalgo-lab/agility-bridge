// SPDX-License-Identifier: Apache-2.0
// P9-24 get_embedded_image (ADR-0019, THREAT_MODEL A8): an image pasted into a work item's rich text, by its number in
// the text, from this instance's image endpoints only; off by default, type-checked on header and bytes, size-capped,
// audited. Synthetic world; the image endpoints are served through `override`.
import { describe, expect, it } from 'vitest';
import {
  buildMcpServer,
  createBudget,
  DEFAULT_LIMITS,
  type FetchLike,
  MetadataService,
  type ToolContext,
  type ToolDefinition,
} from '../../src/index.ts';
import {
  classifyImageSource,
  getEmbeddedImage,
  sniffImageType,
} from '../../src/tools/collaboration/images.ts';
import { getWorkItem } from '../../src/tools/work/get-item.ts';
import snapshotJson from '../fixtures/agility/meta-snapshot.json' with { type: 'json' };
import { FAKE_BASE_URL, FakeAgility, makeContext, poison, probeTool } from '../harness/index.ts';
import { rpc } from '../helpers/mcp.ts';

const SNAPSHOT = snapshotJson as unknown as Record<string, unknown>;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

interface Served {
  readonly body: BodyInit | null;
  readonly type?: string;
  readonly status?: number;
}

function setup(
  options: { description?: string; serve?: (path: string) => Served | undefined; poisoned?: boolean } = {},
) {
  const description =
    options.description ??
    `<p>${options.poisoned ? poison(1) : 'Actual'}</p><img src="${FAKE_BASE_URL}/embedded.img/101" alt="">` +
      `<p>Expected</p><img src="${FAKE_BASE_URL}/downloadblob.img/ABC123DEF" alt="shot">` +
      '<img src="https://evil.example/x.png" alt="">' +
      `<img src="data:image/jpeg;base64,${b64(JPEG)}" alt="">` +
      `<img src="${FAKE_BASE_URL}/embedded.img/102?x=1" alt="">` +
      `<img src="${FAKE_BASE_URL}/attachments.img/5" alt="">`;
  const story = (id: number, number: string, scope: string, text: string) => ({
    _oid: `Story:${id}`,
    AssetType: 'Story',
    Number: number,
    Name: `Story ${id}`,
    AssetState: 64,
    Scope: scope,
    'Scope.Name': scope === 'Scope:1001' ? 'Mobile App' : 'Elsewhere',
    Description: text,
  });
  const rows = [
    story(1001, 'B-01001', 'Scope:1001', description),
    story(1002, 'B-01002', 'Scope:2000', `<img src="${FAKE_BASE_URL}/embedded.img/999" alt="">`),
  ];
  const images: string[] = [];
  const fake = new FakeAgility({
    meta: SNAPSHOT,
    assets: {
      Story: rows,
      Workitem: rows,
      Scope: [
        { _oid: 'Scope:1001', Name: 'Mobile App', AssetState: 64, ChildrenMeAndDown: ['Scope:1001'] },
        { _oid: 'Scope:2000', Name: 'Elsewhere', AssetState: 64, ChildrenMeAndDown: ['Scope:2000'] },
      ],
      Member: [{ _oid: 'Member:20', Name: 'Ann Example', Username: 'ann', IsSelf: true, AssetState: 64 }],
    },
    override: (_req, call) => {
      if (!/^(embedded|downloadblob|attachments)\.img\//.test(call.path)) return undefined;
      images.push(call.path);
      const r = options.serve?.(call.path) ?? { body: PNG, type: 'image/png' };
      return new Response(r.body, {
        status: r.status ?? 200,
        headers: { 'content-type': r.type ?? 'image/png' },
      });
    },
  });
  const ctx = (
    limits: Partial<ToolContext['limits']> = { imageDownload: true },
    o: Partial<ToolContext> = {},
  ) =>
    makeContext({
      fetch: fake.fetch as FetchLike,
      metadata: new MetadataService(),
      budget: createBudget(100),
      projects: { allowed: ['Scope:1001'], includeChildren: true },
      limits: { ...DEFAULT_LIMITS, ...limits },
      ...o,
    });
  return { fake, ctx, images };
}

const call = (tool: ToolDefinition, ctx: ToolContext, args: Record<string, unknown>) =>
  rpc(() => buildMcpServer({ tools: [tool], ctx }), 'tools/call', { name: tool.name, arguments: args });
type Content = Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
const content = (r: Record<string, unknown>) => r['content'] as Content;
const text = (r: Record<string, unknown>) => content(r)[0]?.text ?? '';
const code = (r: Record<string, unknown>) =>
  (r['_meta'] as Record<string, { code?: string }> | undefined)?.['agility-bridge/error']?.code;

describe('get_embedded_image: off by default', () => {
  it('is refused before anything is requested when image download is off', async () => {
    for (const limits of [{}, { imageDownload: false }]) {
      const { ctx, fake, images } = setup();
      const r = await call(getEmbeddedImage, ctx(limits), { asset: 'B-01001', image: 1 });
      expect(code(r)).toBe('AB_TOOL_DISABLED');
      expect(fake.calls).toHaveLength(0);
      expect(images).toEqual([]);
    }
  });
});

describe('get_embedded_image', () => {
  it('returns image N of the description as an image block, audited, with an untrusted-data note', async () => {
    const { ctx, images } = setup();
    const r = await call(getEmbeddedImage, ctx(), { asset: 'B-01001', image: 1 });
    expect(r['isError'], text(r)).toBeUndefined();
    const blocks = content(r);
    expect(blocks.map((b) => b.type)).toEqual(['text', 'image']);
    expect(blocks[1]).toMatchObject({ mimeType: 'image/png', data: b64(PNG) });
    expect(text(r)).toContain('untrusted data');
    expect(r['structuredContent']).toMatchObject({
      image: {
        index: 1,
        field: 'description',
        source: 'embedded',
        contentType: 'image/png',
        bytes: PNG.length,
      },
    });
    expect((r['_meta'] as Record<string, unknown>)['agility-bridge/download']).toEqual({
      asset: 'B-01001',
      attachment: 'embedded.img/101',
      bytes: PNG.length,
      contentType: 'image/png',
    });
    expect(images).toEqual(['embedded.img/101']);
    // No address of the instance's image endpoints is handed to the caller (the audit keeps only the endpoint and id).
    expect(JSON.stringify(r)).not.toContain(`${FAKE_BASE_URL}/embedded.img`);
  });

  it('numbers images as get_work_item shows them: [image 2] is image 2', async () => {
    const { ctx } = setup();
    const item = await call(getWorkItem, ctx(), { asset: 'B-01001', skip_related: true });
    expect(text(item)).toContain('[image 1]');
    expect(text(item)).toContain('[image 2: shot]');
    const r = await call(getEmbeddedImage, ctx(), { asset: 'B-01001', image: 2 });
    expect(r['isError'], text(r)).toBeUndefined();
    expect(r['structuredContent']).toMatchObject({ image: { index: 2, source: 'blob' } });
  });

  it('decodes an inline data: image locally, without any request for it', async () => {
    const { ctx, images } = setup();
    const r = await call(getEmbeddedImage, ctx(), { asset: 'B-01001', image: 4 });
    expect(r['isError'], text(r)).toBeUndefined();
    expect(content(r)[1]).toMatchObject({ mimeType: 'image/jpeg', data: b64(JPEG) });
    expect(images).toEqual([]);
  });

  it('never fetches an address outside the instance image endpoints', async () => {
    for (const image of [3, 5, 6]) {
      const { ctx, images } = setup();
      const r = await call(getEmbeddedImage, ctx(), { asset: 'B-01001', image });
      expect(code(r), `image ${image}`).toBe('AB_INPUT_INVALID');
      expect(text(r)).not.toContain('evil.example');
      expect(images, `image ${image}`).toEqual([]);
    }
  });

  it('answers an asset outside the workspace like a missing one, without reading its text or image', async () => {
    const { ctx, fake, images } = setup();
    const r = await call(getEmbeddedImage, ctx(), { asset: 'B-01002', image: 1 });
    expect(code(r)).toBe('AB_NOT_FOUND');
    expect(images).toEqual([]);
    expect(JSON.stringify(fake.calls.map((c) => c.body))).not.toContain('"Description"');
  });

  it('says how many images there are when the number is past the last one', async () => {
    const { ctx, images } = setup();
    const r = await call(getEmbeddedImage, ctx(), { asset: 'B-01001', image: 9 });
    expect(code(r)).toBe('AB_NOT_FOUND');
    expect(text(r)).toContain('has 6 images');
    expect(images).toEqual([]);
  });

  it('refuses a type outside the allowlist on the response, and SVG always', async () => {
    for (const type of ['image/svg+xml', 'text/html', 'application/octet-stream']) {
      const { ctx } = setup({ serve: () => ({ body: PNG, type }) });
      const r = await call(getEmbeddedImage, ctx(), { asset: 'B-01001', image: 1 });
      expect(r['isError'], type).toBe(true);
      expect(
        content(r).some((b) => b.type === 'image'),
        type,
      ).toBe(false);
    }
  });

  it('refuses bytes that are not the declared image type', async () => {
    const { ctx } = setup({ serve: () => ({ body: JPEG, type: 'image/png' }) });
    const r = await call(getEmbeddedImage, ctx(), { asset: 'B-01001', image: 1 });
    expect(code(r)).toBe('AB_INPUT_INVALID');
    expect(content(r).some((b) => b.type === 'image')).toBe(false);
    expect((r['_meta'] as Record<string, unknown>)['agility-bridge/download']).toBeUndefined();
  });

  it('cuts an oversize image on the stream and returns nothing of it', async () => {
    const big = new Uint8Array(4096);
    big.set(PNG);
    const { ctx } = setup({ serve: () => ({ body: big, type: 'image/png' }) });
    const r = await call(getEmbeddedImage, ctx({ imageDownload: true, imageMaxBytes: 1024 }), {
      asset: 'B-01001',
      image: 1,
    });
    expect(code(r)).toBe('AB_LIMIT_RESPONSE_TOO_LARGE');
    expect(content(r).some((b) => b.type === 'image')).toBe(false);
  });

  it('refuses an oversize inline image without decoding it', async () => {
    const big = new Uint8Array(8192);
    big.set(JPEG);
    const { ctx } = setup({ description: `<img src="data:image/jpeg;base64,${b64(big)}" alt="">` });
    const r = await call(getEmbeddedImage, ctx({ imageDownload: true, imageMaxBytes: 1024 }), {
      asset: 'B-01001',
      image: 1,
    });
    expect(code(r)).toBe('AB_LIMIT_RESPONSE_TOO_LARGE');
  });

  it('keeps poisoned text inside the envelope', async () => {
    const { ctx } = setup({ poisoned: true });
    const { leaks, result } = await probeTool(getEmbeddedImage, ctx(), { asset: 'B-01001', image: 1 });
    expect(result['isError'], text(result)).toBeUndefined();
    expect(leaks).toEqual([]);
  });
});

describe('image source rules', () => {
  const base = 'https://agility.example.com/I';
  it.each([
    [`${base}/embedded.img/12`, 'embedded'],
    [`${base}/downloadblob.img/AbC9`, 'blob'],
    ['embedded.img/12', 'embedded'],
    [`http://agility.example.com/I/embedded.img/12`, 'refused'],
    [`https://agility.example.com.evil/I/embedded.img/12`, 'refused'],
    [`https://agility.example.com/Other/embedded.img/12`, 'refused'],
    [`${base}/embedded.img/12/../../x`, 'refused'],
    [`${base}/embedded.img/12#x`, 'refused'],
    [`https://user:pw@agility.example.com/I/embedded.img/12`, 'refused'],
    [`${base}/embedded.img/0`, 'refused'],
    [`${base}/attachments.img/12`, 'refused'],
    [`${base}/downloadblob.img/a-b`, 'refused'],
    ['data:image/svg+xml;base64,PHN2Zz4=', 'refused'],
    ['data:text/html;base64,PGI+', 'refused'],
    ['data:image/png,raw', 'refused'],
    ['javascript:alert(1)', 'refused'],
    ['', 'refused'],
  ])('%s → %s', (src, kind) => {
    expect(classifyImageSource(src, base).kind).toBe(kind);
  });

  it('sniffs the four image types and nothing else', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(new TextEncoder().encode('GIF89a..'))).toBe('image/gif');
    expect(sniffImageType(new TextEncoder().encode('RIFF....WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageType(new TextEncoder().encode('<svg xmlns='))).toBeUndefined();
  });
});
