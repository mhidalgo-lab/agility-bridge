// SPDX-License-Identifier: Apache-2.0
// Cost accounting over the whole catalogue (P6-11, L-037, L-114, L-115): every tool has a worst-case fixture, its cold
// measurement stays within the declared cost, and a tool that cannot fit the per-call budget is not offered.
import { describe, expect, it } from 'vitest';
import { COMPOSITE_SIBLINGS, compositeWarnings, DEFAULT_LIMITS, ToolRegistry } from '../../src/index.ts';
import { CORE_TOOLS } from '../../src/tools/index.ts';
import { measureCost } from '../harness/index.ts';
import { costRig } from './cost-world.ts';
import { NOW, rig, toolByName } from './reports-world.ts';
import { WORST_CASES } from './worst-case.ts';

describe('worst-case cost of every tool (L-114)', () => {
  it('has a worst-case fixture for every tool and none for a tool that is gone', () => {
    const names = CORE_TOOLS.map((t) => t.name).sort();
    expect(Object.keys(WORST_CASES).sort()).toEqual(names);
  });

  it.each(CORE_TOOLS.map((t) => [t.name]))(
    '%s stays within its declared cost on a cold cache and actually reads',
    async (name) => {
      const tool = toolByName(name as string);
      const fixture = WORST_CASES[tool.name];
      expect(fixture, `add a worst-case fixture for ${tool.name} to test/tools/worst-case.ts`).toBeDefined();
      const fake = costRig();
      const { ctx } = rig();
      const out = await measureCost(
        tool,
        fake,
        (o) =>
          ctx({
            clock: { now: () => NOW },
            limits: { ...DEFAULT_LIMITS, attachmentDownload: true, reports: true },
            ...o,
          }),
        fixture?.args,
        (COMPOSITE_SIBLINGS[tool.name] ?? []).map(toolByName),
      );
      expect(out.isError, `${tool.name}: the worst-case call failed (${out.text}); fix its fixture`).toBe(
        false,
      );
      expect(
        out.requests,
        `${tool.name} (${fixture?.why}) made no Agility request: the fixture is not a worst case`,
      ).toBeGreaterThan(0);
      expect(out.withinCost, `${tool.name}: ${out.requests} requests > declared ${out.declared}`).toBe(true);
    },
  );
});

describe('hide what cannot fit (L-115)', () => {
  const registry = new ToolRegistry();
  for (const t of CORE_TOOLS) registry.register(t);
  const costs = [...new Set(CORE_TOOLS.map((t) => t.cost))].sort((a, b) => a - b);

  it.each(costs)('a budget of %i lists no tool that costs more, composites included', (budget) => {
    const listed = registry.select({ maxCost: budget });
    expect(listed.every((t) => t.cost <= budget)).toBe(true);
    expect(listed.length).toBe(CORE_TOOLS.filter((t) => t.cost <= budget).length);
  });

  it('a budget just below a composite hides it, and just at its cost lists it', () => {
    for (const name of Object.keys(COMPOSITE_SIBLINGS)) {
      const cost = toolByName(name).cost;
      expect(registry.select({ maxCost: cost - 1 }).map((t) => t.name)).not.toContain(name);
      expect(registry.select({ maxCost: cost }).map((t) => t.name)).toContain(name);
    }
  });

  it('a composite costs at least each sibling it reads, so a budget never leaves one without its siblings', () => {
    for (const [name, siblings] of Object.entries(COMPOSITE_SIBLINGS))
      for (const s of siblings) expect(toolByName(name).cost).toBeGreaterThanOrEqual(toolByName(s).cost);
    // A sibling is never dearer than its composite, so a budget never hides a sibling and keeps the composite.
    for (const budget of costs)
      expect(compositeWarnings(registry.select({ maxCost: budget }).map((t) => t.name))).toEqual([]);
  });
});

describe('composite siblings (L-037)', () => {
  it('the sibling table names exactly the reports of the catalogue', () => {
    expect(Object.keys(COMPOSITE_SIBLINGS).sort()).toEqual(
      CORE_TOOLS.filter((t) => t.group === 'reports')
        .map((t) => t.name)
        .sort(),
    );
  });

  it.each(Object.keys(COMPOSITE_SIBLINGS))(
    '%s runs exactly the sections its siblings list says',
    async (name) => {
      const { call } = rig();
      const r = await call(name, WORST_CASES[name]?.args ?? {});
      const sections = (r['structuredContent'] as { sections: Array<{ tool: string; status: string }> })
        .sections;
      expect([...new Set(sections.map((x) => x.tool))].sort()).toEqual(
        [...(COMPOSITE_SIBLINGS[name] ?? [])].sort(),
      );
      expect(sections.every((x) => x.status === 'ok')).toBe(true);
    },
  );

  it('warns for each granted composite that lacks a sibling, and only then', () => {
    expect(compositeWarnings(['sprint_health', 'get_sprint', 'search_work_items'])).toEqual([]);
    expect(compositeWarnings(['get_sprint'])).toEqual([]);
    expect(compositeWarnings(['whoami', 'list_teams'])).toEqual([]);
    const w = compositeWarnings(['sprint_health', 'get_sprint', 'standup_summary']);
    expect(w.map((x) => [x.tool, x.missing])).toEqual([
      ['sprint_health', ['search_work_items']],
      ['standup_summary', ['search_work_items']],
    ]);
    expect(w[0]?.message).toContain('sprint_health is granted without search_work_items');
  });
});
