// SPDX-License-Identifier: Apache-2.0
// P6-32: prompt argument completion for team, project and sprint through the list tools (L-305, THREAT_MODEL T3).
import { describe, expect, it } from 'vitest';
import { buildMcpServer, CORE_TOOLS, PROMPT_MANIFEST, type ToolDefinition } from '../src/index.ts';
import { rpc } from './helpers/mcp.ts';
import { rig, toolByName } from './tools/reports-world.ts';

const tools = (names: readonly string[]): ToolDefinition[] => names.map(toolByName);
const ALL = CORE_TOOLS.map((t) => t.name);

type Completion = { completion: { values: string[]; total?: number; hasMore?: boolean } };

async function complete(
  granted: readonly string[],
  prompt: string,
  argument: string,
  value: string,
  over: Parameters<ReturnType<typeof rig>['ctx']>[0] = {},
) {
  const r = rig();
  const before = r.fake.calls.length;
  try {
    const res = (await rpc(
      () => buildMcpServer({ tools: tools(granted), ctx: r.ctx(over) }),
      'completion/complete',
      { ref: { type: 'ref/prompt', name: prompt }, argument: { name: argument, value } },
    )) as Completion;
    return { values: res.completion.values, calls: r.fake.calls.length - before, error: undefined };
  } catch (error) {
    return { values: [] as string[], calls: r.fake.calls.length - before, error: String(error) };
  }
}

const SPRINT_PROMPT = PROMPT_MANIFEST.find((p) => 'sprint' in p.arguments.shape)?.id ?? '';
const withArg = (arg: string) => PROMPT_MANIFEST.filter((p) => arg in p.arguments.shape).map((p) => p.id);

describe('prompt argument completion', () => {
  it('offers names of teams, projects and sprints the workspace sees, for every prompt that takes them', async () => {
    for (const arg of ['team', 'project', 'sprint']) {
      expect(withArg(arg).length, arg).toBeGreaterThan(0);
      for (const prompt of withArg(arg)) {
        const { values, error } = await complete(ALL, prompt, arg, '');
        expect(error, `${prompt}.${arg}`).toBeUndefined();
        expect(values.length, `${prompt}.${arg}`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the fixed words of a sprint and filters by what was typed', async () => {
    const all = await complete(ALL, SPRINT_PROMPT, 'sprint', '');
    expect(all.values.slice(0, 3)).toEqual(['current', 'previous', 'next']);
    const cur = await complete(ALL, SPRINT_PROMPT, 'sprint', 'cur');
    expect(cur.values[0]).toBe('current');
    const none = await complete(ALL, SPRINT_PROMPT, 'sprint', 'zzzz-nothing');
    expect(none.values).toEqual([]);
  });

  it('every completed value is accepted by the prompt argument schema, and at most 20 come back', async () => {
    for (const arg of ['team', 'project', 'sprint']) {
      for (const prompt of withArg(arg)) {
        const { values } = await complete(ALL, prompt, arg, '');
        const def = PROMPT_MANIFEST.find((p) => p.id === prompt);
        expect(values.length).toBeLessThanOrEqual(20);
        for (const v of values)
          expect(def?.arguments.shape[arg]?.safeParse(v).success, `${prompt}.${arg}: ${v}`).toBe(true);
      }
    }
  });

  it('offers nothing outside the workspace: a workspace with other projects sees none of the world', async () => {
    const { values, error } = await complete(ALL, 'standup', 'project', '', {
      projects: { allowed: ['Scope:9999'], includeChildren: false },
    });
    expect(error).toBeUndefined();
    expect(values).toEqual([]);
  });

  it('without the list tool there is no completion for that argument, and no upstream request', async () => {
    const granted = ALL.filter((n) => n !== 'list_teams');
    const { values, calls } = await complete(granted, 'standup', 'team', '');
    expect(values).toEqual([]);
    expect(calls).toBe(0);
  });

  it('a prompt that is not offered completes nothing and makes no upstream request', async () => {
    const prompt = PROMPT_MANIFEST.find((p) => 'team' in p.arguments.shape && p.uses.length > 0);
    const granted = ALL.filter((n) => n !== prompt?.uses[0]);
    const { values, calls } = await complete(granted, prompt?.id ?? '', 'team', '');
    expect(values).toEqual([]);
    expect(calls).toBe(0);
  });

  it('an unknown argument or prompt completes nothing', async () => {
    expect((await complete(ALL, 'standup', 'asset', '')).values).toEqual([]);
    expect((await complete(ALL, 'no_such_prompt', 'team', '')).values).toEqual([]);
  });

  it('a hostile typed value is bounded and never becomes a suggestion', async () => {
    const { values } = await complete(ALL, 'standup', 'team', '<img src=x onerror=alert(1)>'.repeat(50));
    expect(values.every((v) => !/[<>`]/.test(v))).toBe(true);
  });
});
