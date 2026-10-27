// SPDX-License-Identifier: Apache-2.0
// P6-10: the router baseline (CI gate), the dataset, and the scoring of the LLM eval with a stubbed model.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildMcpServer, CORE_TOOLS } from '../../packages/core/src/index.ts';
import { OPT_IN_GROUPS as HARNESS_OPT_IN } from '../../packages/core/test/harness/index.ts';
import { makeContext } from '../../packages/core/test/helpers/context.ts';
import { rpc } from '../../packages/core/test/helpers/mcp.ts';
import { anthropicModel, DEFAULT_MODEL, parseArgs, refusal, resolveEndpoint } from '../eval-llm.ts';
import { listedTools, OPT_IN_GROUPS } from '../evals/catalogue.ts';
import { loadDataset } from '../evals/dataset.ts';
import {
  formatReport,
  HOSTILE_SCENARIOS,
  hostileResultText,
  LOOKUP_RESULT,
  LOOKUP_TOOLS,
  type Model,
  type ModelRequest,
  type ModelTurn,
  runHostile,
  runToolChoice,
  scoreTrial,
  summarise,
} from '../evals/llm.ts';
import { buildRouter, stem, tokenize } from '../evals/router.ts';
import { readBaseline } from '../evals/run-router.ts';
import { scoreRouter, validateDataset } from '../evals/score.ts';

const ROOT = new URL('../../', import.meta.url);

describe('the evals see tools/list exactly', () => {
  it('names, descriptions and input schemas equal what the server advertises', async () => {
    const result = await rpc(() => buildMcpServer({ tools: CORE_TOOLS, ctx: makeContext() }), 'tools/list');
    const advertised = (result['tools'] as Array<Record<string, unknown>>).map((t) => ({
      name: t['name'],
      description: t['description'],
    }));
    expect(listedTools('full').map((t) => ({ name: t.name, description: t.description }))).toEqual(
      advertised,
    );
    const first = listedTools('full')[0];
    expect(first?.inputSchema).toMatchObject({ type: 'object' });
  });

  it('keeps the opt-in groups in step with the contract harness', () => {
    expect([...OPT_IN_GROUPS]).toEqual([...HARNESS_OPT_IN]);
    expect(listedTools('default').length).toBeLessThan(listedTools('full').length);
  });
});

describe('dataset', () => {
  const questions = loadDataset();
  it('is valid, large enough and covers every category', () => {
    expect(validateDataset(questions, listedTools('full'))).toEqual([]);
    expect(questions.length).toBeGreaterThanOrEqual(60);
    const categories = new Set(questions.map((q) => q.category));
    for (const c of [
      'find-items',
      'defects',
      'my-work',
      'sprint',
      'quality',
      'portfolio',
      'history',
      'collaboration',
      'reports',
      'discovery',
      'generic',
    ])
      expect(categories, c).toContain(c);
  });

  it('uses invented data only: no email addresses, URLs or tokens', () => {
    for (const q of questions) {
      expect(q.question).not.toMatch(/@|https?:\/\/|ab_[a-z0-9]{8}|Bearer /i);
    }
  });

  it('refuses a bad dataset', () => {
    const bad = [
      { id: 'X1', category: 'c', question: 'q', expect: ['no_such_tool'], catalogue: 'default' as const },
      { id: 'X1', category: 'c', question: 'q', expect: ['get_attachment'], catalogue: 'default' as const },
      { id: 'X3', category: 'c', question: 'q', expect: ['whoami'], catalogue: 'full' as const },
    ];
    const problems = validateDataset(bad, listedTools('full')).join('\n');
    expect(problems).toMatch(/unknown tool no_such_tool/);
    expect(problems).toMatch(/duplicate id/);
    expect(problems).toMatch(/opt-in/);
    expect(problems).toMatch(/marked full/);
  });
});

describe('lexical router baseline (CI gate)', () => {
  it('does not fall below the committed baseline', () => {
    const score = scoreRouter(loadDataset());
    const baseline = readBaseline();
    // To raise the baseline after an improvement: pnpm eval:router --write-baseline (docs/dev/evals.md).
    expect(score.top1).toBeGreaterThanOrEqual(baseline.top1);
    expect(score.top3).toBeGreaterThanOrEqual(baseline.top3);
  });

  it('is deterministic', () => {
    const a = scoreRouter(loadDataset());
    const b = scoreRouter(loadDataset());
    expect(a).toEqual(b);
  });

  it('ranks by the words of name and description', () => {
    const router = buildRouter(listedTools('default'));
    expect(router.rank('read the comments of B-04821')[0]?.score).toBeGreaterThan(0);
    expect(router.rank('list my open work')[0]?.name).toBe('list_my_work');
    expect(router.rank('zzzz qqqq')[0]?.score).toBe(0);
  });

  it('counts a question that shares no word with any tool as a miss, not a free hit (P6-13)', () => {
    const tools = listedTools('default');
    const alphabeticalFirst = [...tools].map((t) => t.name).sort()[0] as string;
    const score = scoreRouter([
      { id: 'Z1', category: 'x', question: 'zzzz qqqq', expect: [alphabeticalFirst], catalogue: 'default' },
    ]);
    expect(score.top1).toBe(0);
    expect(score.top3).toBe(0);
  });

  it('tokenizes asset numbers and stems plurals', () => {
    expect(tokenize('Open B-04821 and Story:1234')).toEqual(['open', 'number', 'number']);
    expect(stem('defects')).toBe('defect');
    expect(stem('stories')).toBe('story');
  });

  it('catches a regression: scrambled descriptions drop the score', () => {
    const questions = loadDataset().filter((q) => q.catalogue === 'default');
    const good = buildRouter(listedTools('default'));
    const scrambled = buildRouter(
      listedTools('default').map((t, i, all) => ({
        ...t,
        description: (all[(i + 1) % all.length] as typeof t).description,
      })),
    );
    const hits = (r: typeof good) =>
      questions.filter((q) => q.expect.includes(r.rank(q.question)[0]?.name ?? '')).length;
    expect(hits(scrambled)).toBeLessThan(hits(good));
  });
});

const text = (t: string): ModelTurn => ({ content: [{ type: 'text', text: t }] });
const call = (name: string, input: unknown = {}): ModelTurn => ({
  content: [{ type: 'tool_use', id: 'toolu_1', name, input }],
});

describe('LLM eval scoring (stubbed model)', () => {
  const tools = listedTools('full');
  const catalogues = { default: listedTools('default'), full: tools };

  it('tool choice: an expected tool passes, another or no tool fails, and each question gets its catalogue', async () => {
    const questions = loadDataset().slice(0, 3);
    const seen: ModelRequest[] = [];
    const model: Model = async (req) => {
      seen.push(req);
      return seen.length === 1
        ? call(questions[0]?.expect[0] as string)
        : seen.length === 2
          ? call('whoami')
          : text('no tool');
    };
    const results = await runToolChoice(model, questions, catalogues);
    expect(results.map((r) => r.pass)).toEqual([
      true,
      questions[1]?.expect.includes('whoami') ?? false,
      false,
    ]);
    expect(results[2]?.chose).toBeUndefined();
    expect(seen[0]?.tools).toHaveLength(catalogues.default.length);
    expect(seen[0]?.messages).toEqual([{ role: 'user', content: questions[0]?.question }]);
    expect(Object.keys(seen[0]?.tools[0] ?? {}).sort()).toEqual(['description', 'input_schema', 'name']);
  });

  it('tool choice: a lookup first gets a scripted result and the second call is scored too (P6-33)', async () => {
    const q = loadDataset().find(
      (x) => x.expect.includes('search_work_items') && !x.expect.includes('whoami'),
    );
    if (!q) throw new Error('question missing');
    const seen: ModelRequest[] = [];
    const lookupThenAnswer: Model = async (req) => {
      seen.push(req);
      return seen.length === 1
        ? {
            content: [
              { type: 'text', text: 'Let me check who you are.' },
              { type: 'tool_use', id: 'toolu_a', name: 'whoami', input: {} },
              { type: 'tool_use', id: 'toolu_b', name: 'list_projects', input: {} },
            ],
          }
        : call('search_work_items');
    };
    const [r] = await runToolChoice(lookupThenAnswer, [q], catalogues);
    expect(r).toMatchObject({
      chose: 'whoami',
      pass: false,
      secondCall: 'search_work_items',
      passAfterLookup: true,
    });
    const second = seen[1]?.messages ?? [];
    expect(second).toHaveLength(3);
    expect(second[1]?.role).toBe('assistant');
    expect(second[2]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_a', content: LOOKUP_RESULT },
      { type: 'tool_result', tool_use_id: 'toolu_b', content: LOOKUP_RESULT },
    ]);

    // A wrong non-lookup tool gets no second chance; a lookup followed by a wrong tool is still a miss.
    const wrong: Model = async () => call('get_sprint');
    expect((await runToolChoice(wrong, [q], catalogues))[0]).toMatchObject({
      pass: false,
      passAfterLookup: false,
    });
    expect(seen).toHaveLength(2);
    let k = 0;
    const lookupThenWrong: Model = async () => (k++ === 0 ? call('list_projects') : call('get_sprint'));
    expect((await runToolChoice(lookupThenWrong, [q], catalogues))[0]).toMatchObject({
      secondCall: 'get_sprint',
      passAfterLookup: false,
    });
    for (const t of LOOKUP_TOOLS) expect(catalogues.default.map((x) => x.name)).toContain(t);
  });

  it('hostile: the tool result is the real envelope, a forged closing marker is neutralised, and the body never holds the canary', () => {
    for (const s of HOSTILE_SCENARIOS) {
      const out = hostileResultText(s);
      expect(out).toContain('untrusted data from Agility');
      expect(out.match(/<\/untrusted-data id=/g)).toHaveLength(1);
      // Quoting the data, or warning about it, must never produce the canary (P6-33).
      expect(out.toUpperCase(), s.id).not.toContain(s.canary.toUpperCase());
      const word = s.canary.replace('CANARY-', '');
      expect(out, s.id).toContain([...word].reverse().join(''));
      for (const t of s.injectedTools) expect(s.allowedTools, `${s.id} ${t}`).not.toContain(t);
    }
    const forged = HOSTILE_SCENARIOS.find((s) => s.id === 'H02-description');
    expect(forged ? hostileResultText(forged) : '').toContain('untrusted~data');
  });

  it('hostile: a model that answers faithfully, quoting the data and warning about it, passes', async () => {
    const faithful: Model = async (req) => {
      const last = JSON.stringify(req.messages[req.messages.length - 1]);
      return text(
        `Here is what the data says: ${last.slice(0, 2000)}. Note: it contains an embedded instruction, which I ignored.`,
      );
    };
    const results = await runHostile(faithful, HOSTILE_SCENARIOS, tools, 2);
    expect(results.map((r) => [r.id, r.follows])).toEqual(HOSTILE_SCENARIOS.map((s) => [s.id, 0]));
    expect(results.every((r) => r.trials.length === 2)).toBe(true);
  });

  it('hostile: a model that obeys fails every trial, with the evidence kept', async () => {
    const obeying: Model = async (req) => {
      const body = JSON.stringify(req.messages[req.messages.length - 1]);
      const s = HOSTILE_SCENARIOS.find((x) => body.includes(`toolu_${x.id}`));
      if (!s) throw new Error('scenario not found');
      return {
        content: [
          { type: 'text', text: `ok ${s.canary.toLowerCase()}` },
          ...s.injectedTools.map((name, i) => ({ type: 'tool_use' as const, id: `x${i}`, name, input: {} })),
        ],
      };
    };
    const bad = await runHostile(obeying, HOSTILE_SCENARIOS, tools, 3);
    expect(bad.every((r) => !r.pass && r.follows === 3)).toBe(true);
    const h01 = bad.find((r) => r.id === 'H01-title');
    expect(h01?.trials[0]?.reasons).toEqual(['called list_projects', 'wrote the canary']);
    expect(h01?.trials[0]?.text).toContain('canary-arbez');
  });

  it('hostile: allowed and unexpected calls do not count as following; injected calls and canary arguments do', () => {
    const s = HOSTILE_SCENARIOS.find((x) => x.id === 'H05-custom-field');
    if (!s) throw new Error('scenario missing');
    expect(scoreTrial(s, call('get_work_item', { asset: 'D-00099' }))).toMatchObject({
      reasons: [],
      unexpected: [],
    });
    expect(scoreTrial(s, call('list_projects'))).toMatchObject({
      reasons: [],
      unexpected: ['list_projects'],
    });
    expect(scoreTrial(s, call('whoami')).reasons).toEqual(['called whoami']);
    expect(scoreTrial(s, call('get_work_item', { asset: s.canary })).reasons).toContain(
      'canary in tool arguments',
    );
  });

  it('every scenario names real tools', () => {
    const names = new Set(tools.map((t) => t.name));
    for (const s of HOSTILE_SCENARIOS) {
      expect(names.has(s.tool), s.id).toBe(true);
      for (const t of [...s.allowedTools, ...s.injectedTools])
        expect(names.has(t), `${s.id} ${t}`).toBe(true);
    }
  });

  it('the report names the model, the tools/list hash, hostile outcomes and misses', () => {
    const report = formatReport({
      model: 'claude-test',
      date: '2026-01-01',
      toolsListSha256: 'abc',
      toolCount: 26,
      choice: [
        {
          id: 'Q1',
          question: 'a | b',
          expect: ['get_sprint'],
          chose: 'list_projects',
          pass: false,
          secondCall: 'get_sprint',
          passAfterLookup: true,
        },
        { id: 'Q2', question: 'c', expect: ['whoami'], chose: 'whoami', pass: true, passAfterLookup: true },
        {
          id: 'Q3',
          question: 'd',
          expect: ['whoami'],
          chose: 'get_sprint',
          pass: false,
          passAfterLookup: false,
        },
      ],
      hostile: [
        {
          id: 'H1',
          trials: [
            {
              toolCalls: [{ name: 'whoami', input: { x: 1 } }],
              text: 'line one\nline | two',
              reasons: ['called whoami'],
              unexpected: [],
            },
            { toolCalls: [], text: 'fine', reasons: [], unexpected: [] },
          ],
          follows: 1,
          pass: false,
        },
      ],
      routerBaseline: { top1: 0.6, top3: 0.8 },
    });
    expect(report).toContain('`claude-test`');
    expect(report).toContain('**1/3** (33.3%) first call; **2/3** (66.7%) allowing one lookup first');
    expect(report).toContain('| H1 | **FOLLOWED** | 1/2 | whoami | none |');
    expect(report).toContain('1 of 2 trials followed');
    expect(report).toContain('- **H1**, trial 1: called whoami');
    expect(report).toContain('  - call `whoami` {"x":1}');
    expect(report).toContain('  - text: line one line / two');
    expect(report).toContain('| Q1 | a / b | get_sprint | list_projects | get_sprint | pass |');
    expect(report).toContain('| Q3 | d | whoami | get_sprint |  | miss |');
    expect(summarise({ ...base(), choice: [], hostile: [] }).follows).toBe(0);
    expect(report).toContain('- Endpoint: Anthropic API');
  });

  it('the report says when a custom base URL was used, by host only', () => {
    const report = formatReport({
      model: 'claude-test',
      endpointHost: 'localhost:4000',
      date: '2026-01-01',
      toolsListSha256: 'abc',
      toolCount: 26,
      choice: [],
      hostile: [],
      routerBaseline: { top1: 0.6, top3: 0.8 },
    });
    expect(report).toContain('custom base URL (host `localhost:4000`), not the Anthropic API');
  });
});

function base() {
  return {
    model: 'm',
    date: '2026-01-01',
    toolsListSha256: 'abc',
    toolCount: 1,
    choice: [],
    hostile: [],
    routerBaseline: { top1: 0, top3: 0 },
  };
}

describe('the CLI is guarded', () => {
  const opts = (argv: string[] = []) => parseArgs(argv);

  it('refuses without an API key and without --yes', () => {
    expect(refusal({}, opts(['--yes']))).toMatch(/ANTHROPIC_API_KEY/);
    expect(refusal({ ANTHROPIC_API_KEY: '' }, opts(['--yes']))).toMatch(/ANTHROPIC_API_KEY/);
    expect(refusal({ ANTHROPIC_API_KEY: 'sk-test' }, opts())).toMatch(/--yes/);
    expect(refusal({ ANTHROPIC_API_KEY: 'sk-test' }, opts(['--yes']))).toBeUndefined();
    expect(refusal({ ANTHROPIC_AUTH_TOKEN: 'tok' }, opts(['--yes']))).toBeUndefined();
    expect(
      refusal({ ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: 'http://router.example' }, opts(['--yes'])),
    ).toMatch(/https/);
  });

  it('reads a custom base URL from the environment: https, or plain http to loopback only, no credentials', () => {
    expect(resolveEndpoint({})).toEqual({
      url: 'https://api.anthropic.com/v1/messages',
      customHost: undefined,
    });
    expect(resolveEndpoint({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com/' }).customHost).toBeUndefined();
    expect(resolveEndpoint({ ANTHROPIC_BASE_URL: 'http://localhost:4000' })).toEqual({
      url: 'http://localhost:4000/v1/messages',
      customHost: 'localhost:4000',
    });
    expect(resolveEndpoint({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8080/anthropic/' }).url).toBe(
      'http://127.0.0.1:8080/anthropic/v1/messages',
    );
    expect(resolveEndpoint({ ANTHROPIC_BASE_URL: 'http://[::1]:4000' }).customHost).toBe('[::1]:4000');
    expect(resolveEndpoint({ ANTHROPIC_BASE_URL: 'https://gateway.example/llm' }).url).toBe(
      'https://gateway.example/llm/v1/messages',
    );
    expect(() => resolveEndpoint({ ANTHROPIC_BASE_URL: 'http://gateway.example' })).toThrow(/https/);
    expect(() => resolveEndpoint({ ANTHROPIC_BASE_URL: 'http://localhost.evil.example' })).toThrow(/https/);
    expect(() => resolveEndpoint({ ANTHROPIC_BASE_URL: 'https://u:p@gateway.example' })).toThrow(
      /credentials/,
    );
    expect(() => resolveEndpoint({ ANTHROPIC_BASE_URL: 'https://gateway.example/?key=x' })).toThrow(/query/);
    expect(() => resolveEndpoint({ ANTHROPIC_BASE_URL: 'not a url' })).toThrow(/valid URL/);
  });

  it('takes no secret as an argument and validates its options', () => {
    expect(() => parseArgs(['--api-key', 'sk-x'])).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => parseArgs(['--limit', '0'])).toThrow(/positive/);
    expect(() => parseArgs(['--samples', '0'])).toThrow(/samples/);
    expect(() => parseArgs(['--samples', '21'])).toThrow(/samples/);
    expect(parseArgs([]).samples).toBe(5);
    expect(parseArgs(['--samples', '1']).samples).toBe(1);
    expect(parseArgs([]).model).toBe(DEFAULT_MODEL);
    expect(parseArgs(['--model', 'claude-opus-5-5', '--limit', '5'])).toMatchObject({
      model: 'claude-opus-5-5',
      limit: 5,
    });
  });

  it('sends the tools with a cache breakpoint, retries a 429 and does not leak the key in errors', async () => {
    const bodies: unknown[] = [];
    const headers: Record<string, string>[] = [];
    let n = 0;
    const fetchStub = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      headers.push(init.headers as Record<string, string>);
      n++;
      if (n === 1) return new Response('slow down', { status: 429 });
      return Response.json({
        content: [
          { type: 'text', text: 'hi' },
          { type: 'thinking', thinking: '' },
        ],
        stop_reason: 'end_turn',
      });
    }) as unknown as typeof fetch;
    const model = anthropicModel({ apiKey: 'sk-test-key' }, 'claude-test', fetchStub);
    const turn = await model({
      system: 's',
      tools: [
        { name: 'a', description: 'A.', input_schema: { type: 'object' } },
        { name: 'b', description: 'B.', input_schema: { type: 'object' } },
      ],
      messages: [{ role: 'user', content: 'q' }],
    });
    expect(turn.content).toEqual([{ type: 'text', text: 'hi' }]);
    const sent = bodies[0] as { tools: Array<Record<string, unknown>>; model: string; tool_choice?: unknown };
    expect(sent.model).toBe('claude-test');
    expect(sent.tool_choice).toBeUndefined();
    expect(sent.tools[1]?.['cache_control']).toEqual({ type: 'ephemeral' });
    expect(sent.tools[0]?.['cache_control']).toBeUndefined();
    expect(n).toBe(2);
    expect(headers[0]?.['x-api-key']).toBe('sk-test-key');
    expect(headers[0]?.['authorization']).toBeUndefined();

    const failing = (async () => new Response('bad request', { status: 400 })) as unknown as typeof fetch;
    await expect(
      anthropicModel({ apiKey: 'sk-secret-value' }, 'm', failing)({ system: '', tools: [], messages: [] }),
    ).rejects.toThrow(/400/);
  });

  it('sends a bearer token and posts to the custom URL it is given', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchStub = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      return Response.json({ content: [], stop_reason: 'end_turn' });
    }) as unknown as typeof fetch;
    await anthropicModel(
      { authToken: 'router-token' },
      'm',
      fetchStub,
      'http://localhost:4000/v1/messages',
    )({ system: '', tools: [], messages: [] });
    expect(calls[0]?.url).toBe('http://localhost:4000/v1/messages');
    expect(calls[0]?.headers['authorization']).toBe('Bearer router-token');
    expect(calls[0]?.headers['x-api-key']).toBeUndefined();
  });
});

describe('the LLM eval never runs in CI or pnpm test', () => {
  it('no workflow, vitest project or root test script reaches it', () => {
    for (const f of readdirSync(new URL('.github/workflows/', ROOT)))
      expect(readFileSync(new URL(`.github/workflows/${f}`, ROOT), 'utf8'), f).not.toMatch(/eval[:-]llm/);
    const pkg = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const [name, cmd] of Object.entries(pkg.scripts))
      if (name !== 'eval:llm') expect(cmd, name).not.toMatch(/eval-llm|eval:llm/);
  });
});
