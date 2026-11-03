// SPDX-License-Identifier: Apache-2.0
// CPU time per tool on a deployed Worker (P9-03): reads a `wrangler tail <name> --format json` capture taken while
// `scripts/perf/latency.ts remote` ran (its requests carry `?perf=<tool>:<i>`), and prints p50, p95 and max CPU ms and
// wall ms per tool. The warm-up call of each tool (`:warmup`) is reported separately.
//   node scripts/perf/tail-cpu.ts <tail.json> [--out file]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface CpuStats {
  readonly cpuP50: number;
  readonly cpuP95: number;
  readonly cpuMax: number;
  readonly wallP50: number;
  readonly samples: number;
  /** Samples above the Free plan's 10 ms of CPU. */
  readonly over10: number;
  /** Calls that did not end `ok` (1102 exceededCpu and the like). */
  readonly notOk: number;
  readonly warmupCpu: number | null;
}

/** The objects of a stream of pretty-printed JSON values (what `wrangler tail --format json` prints). */
export function splitJson(text: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          /* a truncated tail */
        }
        start = -1;
      }
    }
  }
  return out;
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : (s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] as number);
};

export function tailCpu(text: string): Record<string, CpuStats> {
  const per = new Map<string, { cpu: number[]; wall: number[]; notOk: number; warm: number | null }>();
  for (const e of splitJson(text) as {
    cpuTime?: number;
    wallTime?: number;
    outcome?: string;
    event?: { request?: { url?: string } };
  }[]) {
    const url = e.event?.request?.url;
    if (url === undefined) continue;
    const tag = new URL(url).searchParams.get('perf');
    if (tag === null) continue;
    const [tool, which] = tag.split(':') as [string, string];
    const entry = per.get(tool) ?? { cpu: [], wall: [], notOk: 0, warm: null };
    if (e.outcome !== 'ok') entry.notOk++;
    if (which === 'warmup') entry.warm = e.cpuTime ?? 0;
    else {
      entry.cpu.push(e.cpuTime ?? 0);
      entry.wall.push(e.wallTime ?? 0);
    }
    per.set(tool, entry);
  }
  return Object.fromEntries(
    [...per].map(([tool, v]) => [
      tool,
      {
        cpuP50: pct(v.cpu, 50),
        cpuP95: pct(v.cpu, 95),
        cpuMax: Math.max(0, ...v.cpu),
        wallP50: pct(v.wall, 50),
        samples: v.cpu.length,
        over10: v.cpu.filter((x) => x > 10).length,
        notOk: v.notOk,
        warmupCpu: v.warm,
      },
    ]),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (file === undefined) {
    console.error('usage: tail-cpu.ts <tail.json> [--out file]');
    process.exit(2);
  }
  const text = `${JSON.stringify(tailCpu(readFileSync(file, 'utf8')), null, 2)}\n`;
  const at = process.argv.indexOf('--out');
  if (at > 0) writeFileSync(process.argv[at + 1] as string, text);
  else process.stdout.write(text);
}
