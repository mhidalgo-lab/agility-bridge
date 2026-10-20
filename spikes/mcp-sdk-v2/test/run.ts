// SPDX-License-Identifier: Apache-2.0
// Automated P0-07 checks: protocol eras × workspaces × transports × client elicitation capability. Usage:
//   tsx test/run.ts http http://127.0.0.1:8787     (Node or wrangler dev base URL)
//   tsx test/run.ts stdio
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

type Mode = 'legacy' | { pin: string };
const ERAS: { label: string; mode: Mode }[] = [
  { label: '2025-era', mode: 'legacy' },
  { label: '2026-07-28', mode: { pin: '2026-07-28' } },
];
const READS = ['get_work_item', 'query_assets', 'whoami'];

let failures = 0;
const approvals: string[] = [];
function check(cond: boolean, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures++;
    console.log(`  ✗ ${msg}`);
  }
}

function newClient(mode: Mode, elicitation: boolean): Client {
  const client = new Client(
    { name: 'spike-test', version: '0.0.0' },
    { versionNegotiation: { mode }, capabilities: elicitation ? { elicitation: { form: {} } } : {} },
  );
  if (elicitation) {
    client.setRequestHandler('elicitation/create', async () => ({
      action: 'accept',
      content: { approve: true },
    }));
  }
  return client;
}

const text = (r: { content?: unknown }): string =>
  ((r.content as Array<{ text?: string }> | undefined) ?? []).map((c) => c.text ?? '').join('');

async function exercise(
  client: Client,
  label: string,
  expected: string[],
  elicitation: boolean,
): Promise<void> {
  check(client.getProtocolEra() !== undefined, `negotiated era = ${client.getProtocolEra()}`);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  check(JSON.stringify(names) === JSON.stringify([...expected].sort()), `tools = ${names.join(',')}`);
  check(
    tools.filter((t) => READS.includes(t.name)).every((t) => t.annotations?.readOnlyHint === true),
    'read tools carry readOnlyHint',
  );
  const q = tools.find((t) => t.name === 'query_assets');
  check(JSON.stringify(q?.inputSchema).includes('$defs'), 'query_assets inputSchema keeps $defs/oneOf');
  check(q?.outputSchema !== undefined, 'query_assets has outputSchema');
  const r = await client.callTool({
    name: 'query_assets',
    arguments: { asset_type: 'Story', filters: [{ attribute: 'Status.Name', op: 'eq', value: "x' or 1=1" }] },
  });
  check(
    (r.structuredContent as { total?: number } | undefined)?.total === 2,
    'query_assets structuredContent total=2',
  );
  const bad = await client
    .callTool({
      name: 'query_assets',
      arguments: { asset_type: 'Story', filters: [{ attribute: 'a', op: 'gt', value: '1' }] },
    })
    .then((x) => x.isError === true)
    .catch(() => true);
  check(bad, 'unknown operator rejected by the input schema');
  const missing = await client.callTool({ name: 'get_work_item', arguments: { asset: 'B-99999' } });
  check(
    missing.isError === true && text(missing).startsWith('AB_NOT_FOUND'),
    'tool error returned as isError',
  );

  if (expected.includes('add_comment')) {
    const w = await client
      .callTool({ name: 'add_comment', arguments: { asset: 'B-01001', text: 'hello' } })
      .catch((e: Error) => ({ isError: true, content: [{ type: 'text', text: `thrown: ${e.message}` }] }));
    const outcome = w.isError ? `refused (${text(w).slice(0, 120)})` : text(w);
    approvals.push(`${label} | client elicitation=${elicitation ? 'yes' : 'no'} | ${outcome}`);
    console.log(`  • add_comment → ${outcome}`);
  } else {
    const hidden = await client
      .callTool({ name: 'add_comment', arguments: { asset: 'B-01001', text: 'x' } })
      .then((x) => x.isError === true)
      .catch(() => true);
    check(hidden, 'call to hidden add_comment rejected');
  }
}

const auth = (slug: string): RequestInit => ({ headers: { authorization: `Bearer ab_spike_${slug}` } });

async function http(base: string): Promise<void> {
  for (const era of ERAS) {
    for (const [slug, expected] of [
      ['team', [...READS, 'add_comment']],
      ['viewer', READS],
    ] as const) {
      for (const elicitation of slug === 'team' ? [true, false] : [true]) {
        const label = `http ${era.label} ${slug}`;
        console.log(`\n[${label}] elicitation=${elicitation}`);
        const transport = new StreamableHTTPClientTransport(new URL(`${base}/w/${slug}/mcp`), {
          requestInit: auth(slug),
        });
        const client = newClient(era.mode, elicitation);
        await client.connect(transport);
        await exercise(client, label, [...expected], elicitation);
        await client.close();
      }
    }
  }

  console.log('\n[http] raw requests');
  const url = `${base}/w/team/mcp`;
  const headers = {
    authorization: 'Bearer ab_spike_team',
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-11-25',
  };
  check(
    (await fetch(`${base}/w/zzz/mcp`, { method: 'POST', body: '{}' })).status === 401,
    'unknown workspace → 401',
  );
  check((await fetch(url, { method: 'POST', body: '{}' })).status === 401, 'missing bearer → 401');
  check(
    (
      await fetch(url, {
        method: 'POST',
        headers: { ...headers, authorization: 'Bearer ab_spike_viewer' },
        body: '{}',
      })
    ).status === 401,
    "another workspace's token → 401",
  );
  const get = await fetch(url, { method: 'GET', headers });
  check(get.status === 405, `2025-era standalone SSE GET → ${get.status}`);
  const batch = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]),
  });
  const batchBody = await batch.text();
  console.log(`  • JSON-RPC batch → HTTP ${batch.status}: ${batchBody.slice(0, 160).replace(/\s+/g, ' ')}`);
  check(batch.status >= 400 || batchBody.includes('"error"'), 'JSON-RPC batch is refused (L-014)');
}

async function stdio(): Promise<void> {
  for (const era of ERAS) {
    for (const elicitation of [true, false]) {
      const label = `stdio ${era.label} team`;
      console.log(`\n[${label}] elicitation=${elicitation}`);
      const transport = new StdioClientTransport({
        command: 'node_modules/.bin/tsx',
        args: ['src/stdio.ts'],
        env: { PATH: process.env['PATH'] ?? '', AB_SPIKE_WORKSPACE: 'team' },
      });
      const client = newClient(era.mode, elicitation);
      await client.connect(transport);
      await exercise(client, label, [...READS, 'add_comment'], elicitation);
      await client.close();
    }
  }
}

const [kind, base] = process.argv.slice(2);
if (kind === 'http' && base) await http(base);
else if (kind === 'stdio') await stdio();
else {
  console.error('usage: tsx test/run.ts http <baseUrl> | stdio');
  process.exit(2);
}
console.log('\nWrite approval outcomes:');
for (const a of approvals) console.log(`  ${a}`);
console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
