// SPDX-License-Identifier: Apache-2.0
// P0-09 on Node (same V8 as workerd): CPU of the capped read and parse + shape for 10 KB – 5 MB Agility-shaped JSON.
// One event-loop turn per iteration (L-159). Usage: tsx src/node-bench.ts
import { parseAndShape, readCapped, syntheticQueryResult } from './hotpath.ts';

const SIZES: Array<[string, number]> = [
  ['10 KB', 10_000],
  ['100 KB', 100_000],
  ['512 KiB', 524_288],
  ['1 MB', 1_000_000],
  ['5 MB', 5_000_000],
];
const ITER = 40;
const pct = (xs: number[], p: number): string =>
  (xs.sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)] ?? 0).toFixed(2);

console.log(
  `Node ${process.version}; ${ITER} iterations after 5 warm-up; CPU from process.cpuUsage (ms, p50 / p95)`,
);
console.log('| Payload | Bytes | Capped read | Parse + shape | Read + parse + shape | ms per MB (p50) |');
console.log('|---|---|---|---|---|---|');
for (const [label, size] of SIZES) {
  const body = syntheticQueryResult(size);
  const bytes = new TextEncoder().encode(body);
  const read: number[] = [];
  const shape: number[] = [];
  const both: number[] = [];
  for (let i = 0; i < ITER + 5; i++) {
    await new Promise((r) => setImmediate(r));
    const stream = new Response(bytes).body as ReadableStream<Uint8Array>;
    const c0 = process.cpuUsage();
    const text = await readCapped(stream, 8 * 1024 * 1024);
    const c1 = process.cpuUsage(c0);
    const c2 = process.cpuUsage();
    parseAndShape(text);
    const c3 = process.cpuUsage(c2);
    if (i >= 5) {
      const r = (c1.user + c1.system) / 1000;
      const s = (c3.user + c3.system) / 1000;
      read.push(r);
      shape.push(s);
      both.push(r + s);
    }
  }
  const p50 = Number(pct([...both], 0.5));
  console.log(
    `| ${label} | ${bytes.byteLength.toLocaleString('en')} | ${pct(read, 0.5)} / ${pct(read, 0.95)} | ${pct(shape, 0.5)} / ${pct(shape, 0.95)} | ${pct(both, 0.5)} / ${pct(both, 0.95)} | ${(p50 / (bytes.byteLength / 1e6)).toFixed(1)} |`,
  );
}
