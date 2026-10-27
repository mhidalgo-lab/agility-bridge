// SPDX-License-Identifier: Apache-2.0
// P6-10 (L-124): the LLM tool evaluation, run by the owner before a release (docs/dev/evals.md, docs/dev/releasing.md).
//
//   ANTHROPIC_API_KEY=... pnpm eval:llm --yes [--model claude-sonnet-5-5] [--out eval-report.md] [--limit N]
//
// It spends money, so it never runs in CI or `pnpm test`: it refuses without ANTHROPIC_API_KEY and without `--yes`.
// Invented fixtures only; the key is read from the environment, never from an argument, and never printed.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { listedTools } from './evals/catalogue.ts';
import { loadDataset } from './evals/dataset.ts';
import {
  type Block,
  type EvalReport,
  formatReport,
  HOSTILE_SCENARIOS,
  type Model,
  type ModelRequest,
  runHostile,
  runToolChoice,
  summarise,
} from './evals/llm.ts';
import { readBaseline } from './evals/run-router.ts';
import { validateDataset } from './evals/score.ts';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const MAX_TOKENS = 4096;
const RETRIES = 3;

export interface Options {
  readonly model: string;
  readonly out: string;
  readonly limit: number | undefined;
  readonly yes: boolean;
}

export function parseArgs(argv: readonly string[]): Options {
  let model = DEFAULT_MODEL;
  let out = 'eval-report.md';
  let limit: number | undefined;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--yes') yes = true;
    else if (a === '--model') model = argv[++i] ?? '';
    else if (a === '--out') out = argv[++i] ?? '';
    else if (a === '--limit') limit = Number(argv[++i]);
    else throw new Error(`Unknown argument ${a}. Secrets are never arguments: set ANTHROPIC_API_KEY.`);
  }
  if (!model) throw new Error('--model needs a value');
  if (!out) throw new Error('--out needs a value');
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
    throw new Error('--limit needs a positive integer');
  return { model, out, limit, yes };
}

/** Why the run must not start, or undefined. Pure, so a test covers the refusals. */
export function refusal(
  env: Readonly<Record<string, string | undefined>>,
  options: Options,
): string | undefined {
  if (!env['ANTHROPIC_API_KEY'])
    return 'ANTHROPIC_API_KEY is not set. The LLM eval calls a paid API and needs an explicit key.';
  if (!options.yes) return 'Refusing to spend money without --yes (see docs/dev/evals.md).';
  return undefined;
}

/** The Messages API over fetch (D-108: no SDK dependency for a script that runs a few times a release). */
export function anthropicModel(apiKey: string, modelId: string, fetchImpl: typeof fetch = fetch): Model {
  return async (request: ModelRequest) => {
    const tools = request.tools.map((t, i) =>
      i === request.tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t,
    );
    const body = JSON.stringify({
      model: modelId,
      max_tokens: MAX_TOKENS,
      system: request.system,
      tools,
      messages: request.messages,
    });
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': API_VERSION,
        },
        body,
      });
      if (res.ok) {
        const json = (await res.json()) as { content: Block[]; stop_reason?: string };
        return {
          content: json.content.filter((b) => b.type === 'text' || b.type === 'tool_use'),
          stopReason: json.stop_reason,
        };
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= RETRIES)
        throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const refused = refusal(process.env, options);
  if (refused !== undefined) {
    console.error(refused);
    process.exit(2);
  }
  const full = listedTools('full');
  const catalogues = { default: listedTools('default'), full };
  let questions = loadDataset();
  const problems = validateDataset(questions, full);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  if (options.limit !== undefined) questions = questions.slice(0, options.limit);
  const toolsJson = JSON.stringify(
    full.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  );
  console.error(
    `Model ${options.model}: ${questions.length} tool-choice calls and ${HOSTILE_SCENARIOS.length} hostile-result calls, ` +
      `each sending ~${Math.round(toolsJson.length / 4)} tokens of tools/list.`,
  );
  const model = anthropicModel(process.env['ANTHROPIC_API_KEY'] as string, options.model);
  const choice = await runToolChoice(model, questions, catalogues);
  const hostile = await runHostile(model, HOSTILE_SCENARIOS, full);
  const report: EvalReport = {
    model: options.model,
    date: new Date().toISOString().slice(0, 10),
    toolsListSha256: createHash('sha256').update(toolsJson).digest('hex'),
    toolCount: full.length,
    choice,
    hostile,
    routerBaseline: readBaseline(),
  };
  writeFileSync(options.out, formatReport(report));
  const s = summarise(report);
  console.error(
    `tool choice ${s.choicePass}/${choice.length}, hostile ${s.hostilePass}/${hostile.length}; report: ${options.out}`,
  );
  if (s.hostilePass < hostile.length) process.exit(1);
}

if (process.argv[1] === new URL(import.meta.url).pathname) await main();
