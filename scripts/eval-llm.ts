// SPDX-License-Identifier: Apache-2.0
// P6-10 (L-124): the LLM tool evaluation, run by the owner before a release (docs/dev/evals.md, docs/dev/releasing.md).
//
//   ANTHROPIC_API_KEY=... pnpm eval:llm --yes [--model claude-sonnet-5-5] [--out eval-report.md] [--limit N] [--samples N]
//
// It spends money, so it never runs in CI or `pnpm test`: it refuses without a key and without `--yes`. The key
// (`ANTHROPIC_API_KEY`, or `ANTHROPIC_AUTH_TOKEN` for a bearer token) and an optional `ANTHROPIC_BASE_URL` (a local
// router or gateway) are read from the environment, never from an argument, and never printed.
// Invented fixtures only.
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
/** Trials per hostile scenario: a model's answer varies between runs, and one follow in any trial blocks (P6-33). */
export const DEFAULT_SAMPLES = 5;
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const API_VERSION = '2023-06-01';
const MAX_TOKENS = 4096;
const RETRIES = 3;

export interface Options {
  readonly model: string;
  readonly out: string;
  readonly limit: number | undefined;
  readonly samples: number;
  readonly yes: boolean;
}

export function parseArgs(argv: readonly string[]): Options {
  let model = DEFAULT_MODEL;
  let out = 'eval-report.md';
  let limit: number | undefined;
  let samples = DEFAULT_SAMPLES;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--yes') yes = true;
    else if (a === '--model') model = argv[++i] ?? '';
    else if (a === '--out') out = argv[++i] ?? '';
    else if (a === '--limit') limit = Number(argv[++i]);
    else if (a === '--samples') samples = Number(argv[++i]);
    else throw new Error(`Unknown argument ${a}. Secrets are never arguments: set ANTHROPIC_API_KEY.`);
  }
  if (!model) throw new Error('--model needs a value');
  if (!out) throw new Error('--out needs a value');
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
    throw new Error('--limit needs a positive integer');
  if (!Number.isInteger(samples) || samples < 1 || samples > 20)
    throw new Error('--samples needs an integer from 1 to 20');
  return { model, out, limit, samples, yes };
}

type Env = Readonly<Record<string, string | undefined>>;

/** How the Messages API is reached: `x-api-key`, a bearer token, or both, as the official SDK sends them. */
export interface Credentials {
  readonly apiKey?: string | undefined;
  readonly authToken?: string | undefined;
}

export interface Endpoint {
  /** The Messages API URL. */
  readonly url: string;
  /** The host of a custom base URL, for the report; undefined for the Anthropic API. Never the path or query. */
  readonly customHost: string | undefined;
}

/**
 * The endpoint from `ANTHROPIC_BASE_URL` (the name the official SDK and Claude Code use), with `/v1/messages` appended.
 * HTTPS only, except plain HTTP to a loopback router; no credentials in the URL. Throws with a reason otherwise.
 */
export function resolveEndpoint(env: Env): Endpoint {
  const raw = env['ANTHROPIC_BASE_URL']?.trim();
  if (!raw) return { url: `${DEFAULT_BASE_URL}/v1/messages`, customHost: undefined };
  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    throw new Error('ANTHROPIC_BASE_URL is not a valid URL.');
  }
  if (base.username || base.password)
    throw new Error(
      'ANTHROPIC_BASE_URL must not carry credentials: set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN.',
    );
  if (base.search || base.hash) throw new Error('ANTHROPIC_BASE_URL must not have a query or fragment.');
  const loopback = LOOPBACK_HOSTS.has(base.hostname);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback))
    throw new Error('ANTHROPIC_BASE_URL must use https (plain http only to localhost, 127.0.0.1 or [::1]).');
  const custom = `${base.origin}${base.pathname.replace(/\/+$/, '')}`;
  if (custom === DEFAULT_BASE_URL) return { url: `${DEFAULT_BASE_URL}/v1/messages`, customHost: undefined };
  return { url: `${custom}/v1/messages`, customHost: base.host };
}

/** The key or token from the environment; empty values count as unset. */
export function credentialsFrom(env: Env): Credentials {
  return {
    apiKey: env['ANTHROPIC_API_KEY'] || undefined,
    authToken: env['ANTHROPIC_AUTH_TOKEN'] || undefined,
  };
}

/** Why the run must not start, or undefined. Pure, so a test covers the refusals. */
export function refusal(env: Env, options: Options): string | undefined {
  const { apiKey, authToken } = credentialsFrom(env);
  if (!apiKey && !authToken)
    return 'Neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is set. The LLM eval calls a paid API and needs an explicit key.';
  try {
    resolveEndpoint(env);
  } catch (e) {
    return (e as Error).message;
  }
  if (!options.yes) return 'Refusing to spend money without --yes (see docs/dev/evals.md).';
  return undefined;
}

/** The Messages API over fetch (D-108: no SDK dependency for a script that runs a few times a release). */
export function anthropicModel(
  credentials: Credentials,
  modelId: string,
  fetchImpl: typeof fetch = fetch,
  url: string = `${DEFAULT_BASE_URL}/v1/messages`,
): Model {
  const auth: Record<string, string> = {};
  if (credentials.apiKey) auth['x-api-key'] = credentials.apiKey;
  if (credentials.authToken) auth['authorization'] = `Bearer ${credentials.authToken}`;
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
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...auth,
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
        throw new Error(`Messages API ${res.status}: ${(await res.text()).slice(0, 300)}`);
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
  const endpoint = resolveEndpoint(process.env);
  console.error(
    `Model ${options.model}${endpoint.customHost === undefined ? '' : ` via ${endpoint.customHost}`}: ${questions.length} tool-choice calls (plus one per lookup) and ${HOSTILE_SCENARIOS.length * options.samples} hostile-result calls, ` +
      `each sending ~${Math.round(toolsJson.length / 4)} tokens of tools/list.`,
  );
  const model = anthropicModel(credentialsFrom(process.env), options.model, fetch, endpoint.url);
  const choice = await runToolChoice(model, questions, catalogues);
  const hostile = await runHostile(model, HOSTILE_SCENARIOS, full, options.samples);
  const report: EvalReport = {
    model: options.model,
    endpointHost: endpoint.customHost,
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
    `tool choice ${s.choicePass}/${choice.length} first call, ${s.choicePassAfterLookup}/${choice.length} after a lookup; ` +
      `hostile ${s.hostilePass}/${hostile.length} scenarios clean, ${s.follows}/${s.trials} trials followed; report: ${options.out}`,
  );
  if (s.follows > 0) process.exit(1);
}

if (process.argv[1] === new URL(import.meta.url).pathname) await main();
