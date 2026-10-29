// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  annotationsFor,
  defineTool,
  RegistryError,
  type ToolDefinition,
  ToolRegistry,
} from '../src/index.ts';

const base = (over: Partial<ToolDefinition> = {}): ToolDefinition =>
  defineTool({
    name: 'list_things',
    title: 'List things',
    description: 'List synthetic things within the workspace. Paged: pass nextCursor back as cursor.',
    kind: 'read',
    group: 'core',
    cost: 2,
    inputSchema: z.object({ contains: z.string().optional() }),
    handler: async () => ({ text: 'ok' }),
    ...over,
  } as ToolDefinition);

const refuses = (def: ToolDefinition, re: RegExp, registry = new ToolRegistry()) => {
  expect(() => registry.register(def)).toThrow(RegistryError);
  expect(() => registry.register(def)).toThrow(re);
};

describe('ToolRegistry.register refuses', () => {
  it.each([
    'ListThings',
    'list-things',
    '_list',
    'list__things',
    'list_things_',
    '1list',
    `l${'x'.repeat(64)}`,
  ])('a bad name: %s', (name) => refuses(base({ name }), /snake_case/));

  it('a duplicate name', () => {
    const r = new ToolRegistry().register(base());
    refuses(base(), /Duplicate/, r);
  });

  it('a missing title or a too-short description', () => {
    refuses(base({ title: ' ' }), /title/);
    refuses(base({ description: 'Short.' }), /description/);
  });

  it.each([undefined, -1, 1.5, Number.NaN])('a missing or invalid cost: %s', (cost) =>
    refuses(base({ cost: cost as number }), /cost/),
  );

  it('an unknown kind and a bad group', () => {
    refuses(base({ kind: 'admin' as never }), /unknown kind/);
    refuses(base({ group: 'Core Tools' }), /group/);
  });

  it.each([
    ['write', 'add_comment'],
    ['destructive', 'close_asset'],
  ] as const)('a %s tool without allowNonRead', (kind, name) => {
    const write = base({ kind, name, group: 'writes', writePipeline: true });
    refuses(write, /allowNonRead/);
    expect(() => new ToolRegistry({ allowNonRead: true }).register(write)).not.toThrow();
  });

  it('a non-read tool that was not built by defineWriteTool, or is outside the writes group (L-105)', () => {
    const open = () => new ToolRegistry({ allowNonRead: true });
    refuses(base({ kind: 'write', name: 'add_comment', group: 'writes' }), /defineWriteTool/, open());
    refuses(
      base({ kind: 'write', name: 'add_comment', group: 'work', writePipeline: true }),
      /writes group/,
      open(),
    );
  });

  it.each([
    z.object({ token: z.string() }),
    z.object({ api_key: z.string() }),
    z.object({ apiKey: z.string() }),
    z.object({ password: z.string() }),
    z.object({ authorization: z.string() }),
    z.object({ session_id: z.string() }),
    z.object({ private_key: z.string() }),
    z.object({ nested: z.object({ deep: z.array(z.object({ client_secret: z.string() })) }) }),
    z.object({ choice: z.union([z.object({ a: z.string() }), z.object({ credential: z.string() })]) }),
  ])('a secret-like input field anywhere in the schema (%#)', (inputSchema) =>
    refuses(base({ inputSchema: inputSchema as never }), /secret-like/),
  );
});

describe('ToolRegistry.select', () => {
  const r = new ToolRegistry({ allowNonRead: true })
    .register(base())
    .register(base({ name: 'get_thing', group: 'work' }))
    .register(base({ name: 'add_comment', kind: 'write', group: 'writes', writePipeline: true }));

  it('returns read tools by default, filtered by names and groups', () => {
    expect(r.select().map((t) => t.name)).toEqual(['list_things', 'get_thing']);
    expect(r.select({ allowed: ['get_thing', 'nope'] }).map((t) => t.name)).toEqual(['get_thing']);
    expect(r.select({ groups: ['core'] }).map((t) => t.name)).toEqual(['list_things']);
    expect(r.select({ kinds: ['read', 'write'] }).map((t) => t.name)).toContain('add_comment');
  });

  it('hides tools whose declared cost exceeds the per-call budget (L-115)', () => {
    const costly = new ToolRegistry().register(base()).register(base({ name: 'walk_tree', cost: 40 }));
    expect(costly.select({ maxCost: 20 }).map((t) => t.name)).toEqual(['list_things']);
  });

  it('names the granted tools the budget hides, and only those (P6-36)', () => {
    const costly = new ToolRegistry().register(base()).register(base({ name: 'walk_tree', cost: 40 }));
    expect(costly.hiddenByBudget({ maxCost: 20 }).map((t) => t.name)).toEqual(['walk_tree']);
    expect(costly.hiddenByBudget({ maxCost: 40 })).toEqual([]);
    // A tool that is not granted is not "hidden by the budget".
    expect(costly.hiddenByBudget({ maxCost: 20, allowed: ['list_things'] })).toEqual([]);
  });
});

describe('annotationsFor', () => {
  it.each([
    ['read', undefined, { readOnlyHint: true, destructiveHint: false, idempotentHint: true }],
    ['write', undefined, { readOnlyHint: false, destructiveHint: false, idempotentHint: false }],
    ['write', true, { readOnlyHint: false, destructiveHint: false, idempotentHint: true }],
    ['destructive', false, { readOnlyHint: false, destructiveHint: true, idempotentHint: false }],
  ] as const)('derives %s (idempotent %s)', (kind, idempotent, expected) => {
    expect(annotationsFor({ kind, title: 'T', idempotent })).toEqual({
      title: 'T',
      openWorldHint: true,
      ...expected,
    });
  });
});
