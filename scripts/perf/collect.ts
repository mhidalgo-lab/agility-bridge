// SPDX-License-Identifier: Apache-2.0
// P9-03: gathers one measurement session into scripts/bench/perf-results.json (the input of `pnpm docs:perf`).
//   node --conditions=source scripts/perf/collect.ts --plan free --stdio s.json --http h.json --workers w.json \
//     --cpu w.cpu.json [--extra e.json --extra-cpu e.cpu.json]
// `--extra` is a second Workers pass (the report tools above the Free budget, measured with AB_PLAN=paid on the same
// account): its tools are added to the first pass where the first has none.
import { readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_LATENCY } from './mock-agility.ts';

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => args[args.indexOf(name) + 1];
const read = (name: string) => JSON.parse(readFileSync(arg(name) as string, 'utf8')) as Record<string, any>;

const workers = read('--workers');
let cpu = read('--cpu');
if (arg('--extra') !== undefined) {
  const extra = read('--extra');
  const extraCpu = read('--extra-cpu');
  for (const [tool, stats] of Object.entries(extra['warm'])) {
    if (workers['warm'][tool] !== undefined) continue;
    workers['warm'][tool] = stats;
    cpu = { ...cpu, [tool]: extraCpu[tool] };
  }
}
const stripped = (run: Record<string, any>) => {
  const { tags: _tags, ...rest } = run;
  return rest;
};
const out = {
  date: new Date().toISOString().slice(0, 10),
  plan: arg('--plan') ?? 'free',
  latencyModel: DEFAULT_LATENCY,
  stdio: read('--stdio'),
  http: read('--http'),
  workers: stripped(workers),
  workersCpu: cpu,
};
writeFileSync(new URL('../bench/perf-results.json', import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
