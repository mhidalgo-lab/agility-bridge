// SPDX-License-Identifier: Apache-2.0
// P0-09: XML parser candidates for meta.v1, Hist and rest-1.v1 on Workers (no DOMParser there).
// CPU on the public example instance's meta.v1 (downloaded to results/, not committed) and on synthetic rest-1.v1 XML;
// bundle size (esbuild, minified, gzip); entity handling (internal entity expansion, external entities).
// Usage: tsx src/xml-bench.ts   (expects results/meta.v1.xml and results/Story.xml; see RESULTS.md)
import { existsSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { DOMParser } from '@xmldom/xmldom';
import { build } from 'esbuild';
import { XMLParser } from 'fast-xml-parser';
import { SaxesParser } from 'saxes';
import { parse as txmlParse } from 'txml/txml';
import { syntheticRestXml } from './hotpath.ts';

type Candidate = { name: string; parse: (xml: string) => unknown; entry: string };

const CANDIDATES: Candidate[] = [
  {
    name: 'fast-xml-parser 5.11.2',
    parse: (xml) => new XMLParser({ ignoreAttributes: false, processEntities: true }).parse(xml),
    entry:
      "import { XMLParser } from 'fast-xml-parser'; export default (x) => new XMLParser({ ignoreAttributes: false }).parse(x);",
  },
  {
    name: 'txml 6.0.3',
    parse: (xml) => txmlParse(xml),
    // The package root re-exports a Node transform stream; the `txml/txml` subpath is the stream-free parser.
    entry: "import { parse } from 'txml/txml'; export default (x) => parse(x);",
  },
  {
    name: 'saxes 6.0.0 (SAX, counting)',
    parse: (xml) => {
      const p = new SaxesParser();
      let n = 0;
      p.on('opentag', () => {
        n++;
      });
      p.write(xml).close();
      return n;
    },
    entry:
      "import { SaxesParser } from 'saxes'; export default (x) => { const p = new SaxesParser(); p.write(x).close(); };",
  },
  {
    name: '@xmldom/xmldom 0.9.12 (DOM)',
    parse: (xml) => new DOMParser().parseFromString(xml, 'text/xml'),
    entry:
      "import { DOMParser } from '@xmldom/xmldom'; export default (x) => new DOMParser().parseFromString(x, 'text/xml');",
  },
];

const pct = (xs: number[], p: number): string =>
  (xs.sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)] ?? 0).toFixed(1);

async function cpu(parse: (x: string) => unknown, xml: string, iterations: number): Promise<string> {
  const times: number[] = [];
  for (let i = 0; i < iterations + 2; i++) {
    await new Promise((r) => setImmediate(r));
    const c0 = process.cpuUsage();
    parse(xml);
    const c = process.cpuUsage(c0);
    if (i >= 2) times.push((c.user + c.system) / 1000);
  }
  return pct(times, 0.5);
}

async function bundleSize(entry: string): Promise<string> {
  try {
    return await bundle(entry);
  } catch (e) {
    const m = /Could not resolve "([^"]+)"/.exec((e as Error).message);
    return m ? `fails: imports ${m[1]}` : 'fails';
  }
}

async function bundle(entry: string): Promise<string> {
  const r = await build({
    stdin: { contents: entry, resolveDir: process.cwd(), loader: 'js' },
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    write: false,
    logLevel: 'silent',
  });
  const code = r.outputFiles[0]?.contents ?? new Uint8Array();
  return `${(code.byteLength / 1024).toFixed(0)} / ${(gzipSync(code).byteLength / 1024).toFixed(1)}`;
}

const LAUGHS =
  '<?xml version="1.0"?><!DOCTYPE l [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">' +
  '<!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;"><!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;">' +
  '<!ENTITY e "&d;&d;&d;&d;&d;&d;&d;&d;&d;&d;">]><l>&e;</l>';
const XXE = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY ext SYSTEM "file:///etc/hostname">]><x>&ext;</x>';

function entityBehaviour(parse: (x: string) => unknown, xml: string): string {
  try {
    const out =
      JSON.stringify(parse(xml), (_k, v) =>
        typeof v === 'object' && v?.constructor?.name === 'Document' ? String(v) : v,
      ) ?? '';
    const asText =
      typeof parse(xml) === 'object' && parse(xml) !== null && 'documentElement' in (parse(xml) as object)
        ? String(parse(xml))
        : out;
    if (asText.includes('aaaaaaaaaaaaaaaaaaaa')) return `expanded (${asText.length} chars)`;
    if (
      /[A-Za-z0-9-]{3,}\n?/.test(asText) &&
      xml === XXE &&
      !asText.includes('&ext;') &&
      !asText.includes('ext')
    )
      return 'resolved?';
    return 'not expanded';
  } catch (e) {
    return `rejected (${(e as Error).message.slice(0, 60)})`;
  }
}

const inputs: Array<[string, string]> = [];
if (existsSync('results/meta.v1.xml'))
  inputs.push(['meta.v1 full (4.1 MB, 175 types)', readFileSync('results/meta.v1.xml', 'utf8')]);
if (existsSync('results/Story.xml'))
  inputs.push(['meta.v1/Story (83 KB)', readFileSync('results/Story.xml', 'utf8')]);
inputs.push(
  ['rest-1.v1 synthetic 100 KB', syntheticRestXml(100_000)],
  ['rest-1.v1 synthetic 1 MB', syntheticRestXml(1_000_000)],
);

console.log(
  `Node ${process.version}; CPU p50 in ms (process.cpuUsage), 10 iterations (3 for the 4.1 MB document)`,
);
console.log(
  `| Parser | ${inputs.map(([l]) => l).join(' | ')} | Bundle KiB min / gzip | Billion laughs | External entity |`,
);
console.log(`|---|${inputs.map(() => '---|').join('')}---|---|---|`);
for (const c of CANDIDATES) {
  const cells: string[] = [];
  for (const [label, xml] of inputs)
    cells.push(await cpu(c.parse, xml, label.startsWith('meta.v1 full') ? 3 : 10));
  console.log(
    `| ${c.name} | ${cells.join(' | ')} | ${await bundleSize(c.entry)} | ${entityBehaviour(c.parse, LAUGHS)} | ${entityBehaviour(c.parse, XXE)} |`,
  );
}
