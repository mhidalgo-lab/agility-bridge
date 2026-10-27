// SPDX-License-Identifier: Apache-2.0
// P6-10: `pnpm eval:router` prints the router score and its misses; `--write-baseline` commits the measured floor
// (rounded down to a whole percent) to scripts/evals/baseline.json. The same check runs in `pnpm test`.
import { readFileSync, writeFileSync } from 'node:fs';
import { listedTools } from './catalogue.ts';
import { loadDataset } from './dataset.ts';
import { type RouterScore, scoreRouter, validateDataset } from './score.ts';

const BASELINE = new URL('./baseline.json', import.meta.url);

export interface Baseline {
  readonly top1: number;
  readonly top3: number;
}

export function readBaseline(): Baseline {
  return JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const floorPct = (n: number) => Math.floor(n * 100) / 100;

export function formatScore(score: RouterScore): string {
  const lines = [
    `questions: ${score.total}   top-1: ${pct(score.top1)}   top-3: ${pct(score.top3)}`,
    ...Object.entries(score.byCategory).map(([c, v]) => `  ${c.padEnd(15)} ${v.top1}/${v.total}`),
  ];
  for (const m of score.wrongFirst)
    lines.push(
      `  first choice wrong ${m.id} [${m.top3.join(', ')}] expected ${m.expect.join('|')}: ${m.question}`,
    );
  return lines.join('\n');
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const questions = loadDataset();
  const problems = validateDataset(questions, listedTools('full'));
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  const score = scoreRouter(questions);
  console.log(formatScore(score));
  if (process.argv.includes('--write-baseline')) {
    writeFileSync(
      BASELINE,
      `${JSON.stringify({ top1: floorPct(score.top1), top3: floorPct(score.top3) }, null, 2)}\n`,
    );
    console.log('baseline written');
  }
}
