// SPDX-License-Identifier: Apache-2.0
// Workspace-enabled writable custom attributes on fakes (P7-20, D-238): `create_work_item` and `update_fields` take a
// `custom` list, only for attributes the workspace owner enabled, checked against the instance metadata and typed by
// kind. Dry run, approved apply with the exact request, conflict, no-op, refusals before any request, negative
// authorization, and the A12 rule that no tool description names an instance attribute. The request shape is the
// documented attribute set and stays *unverified* until the sandbox (P7-07).
import { describe, expect, it } from 'vitest';
import {
  AbError,
  type CanonicalMutation,
  CORE_TOOLS,
  canonicalize,
  ErrorCode,
  type ToolContext,
} from '../../src/index.ts';
import { writeRig } from './writes-world.ts';

async function refused(p: Promise<unknown>): Promise<AbError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AbError);
    return e as AbError;
  }
  throw new Error('expected a refusal');
}

const ENABLED = ['Custom_SyntheticNote', 'Custom_SyntheticSeverity', 'Custom_SyntheticHours'];

/** A context in which the workspace owner enabled these custom attributes for writing. */
function withCustom(w: ReturnType<typeof writeRig>, fields: readonly string[] = ENABLED): ToolContext {
  return w.context({
    workspace: { ...w.ctx.workspace, writes: { ...w.ctx.workspace.writes, customFields: fields } },
  });
}

describe('update_fields with custom attributes', () => {
  const sev = { asset: 'D-01101', custom: [{ attribute: 'Custom_SyntheticSeverity', value: 'Major' }] };

  it('dry run shows old and new and sends nothing', async () => {
    const w = writeRig();
    const out = await w.run('update_fields', { ...sev, dry_run: true }, withCustom(w));
    expect(out.structured).toMatchObject({ fields: ['Custom_SyntheticSeverity'], noop: false });
    expect(out.text).toContain('Major');
    expect(w.posts).toHaveLength(0);
    expect(w.channel.asked).toHaveLength(0);
  });

  it('applies a text attribute once, after approval, with exactly this request; a repeat is a no-op', async () => {
    const w = writeRig();
    const out = await w.run('update_fields', { ...sev, confirm: true }, withCustom(w));
    expect(out.structured).toMatchObject({ applied: true });
    expect(w.channel.asked).toHaveLength(1);
    expect(w.channel.asked[0]).toContain('Custom_SyntheticSeverity');
    expect(w.channel.asked[0]).toContain('new: "Major"');
    expect(w.posts).toEqual([
      {
        path: 'rest-1.v1/Data/Defect/1101',
        xml: '<Asset><Attribute name="Custom_SyntheticSeverity" act="set">Major</Attribute></Asset>',
        contentType: 'application/xml',
      },
    ]);
    const again = await w.run('update_fields', { ...sev, confirm: true }, withCustom(w));
    expect(again.structured).toMatchObject({ noop: true, applied: false });
    expect(w.posts).toHaveLength(1);
  });

  it('applies a number to a numeric attribute, with the other fields in the same request', async () => {
    const w = writeRig();
    const out = await w.run(
      'update_fields',
      {
        asset: 'TK-01201',
        todo: 2,
        custom: [{ attribute: 'Custom_SyntheticHours', value: 3.5 }],
        confirm: true,
      },
      withCustom(w),
    );
    expect(out.structured).toMatchObject({ applied: true });
    expect(w.posts[0]?.xml).toBe(
      '<Asset><Attribute name="Custom_SyntheticHours" act="set">3.5</Attribute><Attribute name="ToDo" act="set">2</Attribute></Asset>',
    );
  });

  it('sends a long text as escaped paragraphs and shows the plain text in the approval', async () => {
    const w = writeRig();
    await w.run(
      'update_fields',
      {
        asset: 'B-01002',
        custom: [{ attribute: 'Custom_SyntheticNote', value: 'Line one\n\nA <b>&</b> B' }],
        confirm: true,
      },
      withCustom(w),
    );
    expect(w.posts[0]?.xml).toBe(
      '<Asset><Attribute name="Custom_SyntheticNote" act="set">&lt;p&gt;Line one&lt;/p&gt;&lt;p&gt;A &amp;lt;b&amp;gt;&amp;amp;&amp;lt;/b&amp;gt; B&lt;/p&gt;</Attribute></Asset>',
    );
    expect(w.channel.asked[0]).toContain('A <b>& </b> B'.replace('& ', '&'));
  });

  it('is a conflict when the attribute changed while the person decided; nothing is sent', async () => {
    const w = writeRig({
      duringApproval: (assets) => {
        const row = assets['Defect']?.find((r) => r['_oid'] === 'Defect:1101');
        if (row) row['Custom_SyntheticSeverity'] = 'Blocker';
      },
    });
    const error = await refused(w.run('update_fields', { ...sev, confirm: true }, withCustom(w)));
    expect(error.code).toBe(ErrorCode.WriteConflict);
    expect(w.posts).toHaveLength(0);
  });

  it('refuses an attribute the workspace did not enable, before any request and any approval', async () => {
    const w = writeRig();
    for (const ctx of [w.ctx, withCustom(w, []), withCustom(w, ['Custom_SyntheticNote'])]) {
      const calls = w.calls.length;
      const error = await refused(w.run('update_fields', { ...sev, confirm: true }, ctx));
      expect(error.code).toBe(ErrorCode.InputInvalid);
      expect(error.message).toMatch(/not enabled for writing in this workspace/);
      // The refusal does not list what the owner did enable.
      expect(`${error.message} ${error.hint ?? ''}`).not.toContain('Custom_SyntheticNote');
      expect(w.calls).toHaveLength(calls);
    }
    expect(w.posts).toHaveLength(0);
    expect(w.channel.asked).toHaveLength(0);
    expect(w.audit.records).toHaveLength(0);
  });

  it('refuses what is not a custom name, a name given twice, and too many, before any request', async () => {
    const w = writeRig();
    const ctx = withCustom(w);
    const many = Array.from({ length: 6 }, (_, i) => ({ attribute: `Custom_X${i}`, value: 'a' }));
    for (const custom of [
      [{ attribute: 'Name', value: 'x' }],
      [{ attribute: 'Custom_Bad name<script>', value: 'x' }],
      [
        { attribute: 'Custom_SyntheticSeverity', value: 'a' },
        { attribute: 'Custom_SyntheticSeverity', value: 'b' },
      ],
    ]) {
      const calls = w.calls.length;
      expect(
        (await refused(w.run('update_fields', { asset: 'D-01101', custom, confirm: true }, ctx))).code,
      ).toBe(ErrorCode.InputInvalid);
      expect(w.calls).toHaveLength(calls);
    }
    expect(() => w.run('update_fields', { asset: 'D-01101', custom: many, confirm: true }, ctx)).toThrow();
    expect(w.posts).toHaveLength(0);
  });

  it('refuses an attribute the type lacks, a read-only one, a list and a wrong value type', async () => {
    const w = writeRig();
    const ctx = withCustom(w, [
      ...ENABLED,
      'Custom_SyntheticLocked',
      'Custom_SyntheticRisk',
      'Custom_Nothing',
    ]);
    const cases: Array<[string, string, unknown]> = [
      ['TK-01201', 'Custom_SyntheticSeverity', 'x'], // a defect attribute on a task
      ['TK-01201', 'Custom_SyntheticLocked', 'x'], // read-only
      ['B-01002', 'Custom_SyntheticRisk', 'x'], // a relation
      ['D-01101', 'Custom_Nothing', 'x'], // not on this instance
      ['TK-01201', 'Custom_SyntheticHours', 'three'], // text for a number
      ['D-01101', 'Custom_SyntheticSeverity', 3], // a number for text
      ['TK-01201', 'Custom_SyntheticHours', 1e12], // too large
      ['D-01101', 'Custom_SyntheticSeverity', 'a‮b'], // hidden characters
      ['D-01101', 'Custom_SyntheticSeverity', 'a\nb'], // a line break in a one-line attribute
      ['D-01101', 'Custom_SyntheticSeverity', 'x'.repeat(401)], // too long
      ['D-01101', 'Custom_SyntheticSeverity', '   '], // empty
    ];
    for (const [asset, attribute, value] of cases) {
      const error = await refused(
        w.run('update_fields', { asset, custom: [{ attribute, value }], confirm: true }, ctx),
      );
      expect(error.code, `${asset} ${attribute}`).toBe(ErrorCode.InputInvalid);
    }
    expect(w.posts).toHaveLength(0);
    expect(w.channel.asked).toHaveLength(0);
  });

  it('does not replace a long text whose current value has formatting', async () => {
    const w = writeRig();
    const row = w.assets['Story']?.find((r) => r['_oid'] === 'Story:1002');
    if (row) row['Custom_SyntheticNote'] = '<ul><li>one</li></ul>';
    const error = await refused(
      w.run(
        'update_fields',
        { asset: 'B-01002', custom: [{ attribute: 'Custom_SyntheticNote', value: 'new' }], confirm: true },
        withCustom(w),
      ),
    );
    expect(error.message).toMatch(/formatting/);
    expect(w.posts).toHaveLength(0);
  });

  it('is refused with no request when a layer is off (negative authorization)', async () => {
    const w = writeRig();
    const base = withCustom(w);
    for (const layer of [
      { writes: undefined } as unknown as Partial<ToolContext>,
      { grantedTools: ['get_work_item'] },
    ]) {
      const calls = w.calls.length;
      const error = await refused(w.run('update_fields', { ...sev, confirm: true }, { ...base, ...layer }));
      expect(error.code).toBe(ErrorCode.ToolDisabled);
      expect(w.calls).toHaveLength(calls);
    }
    expect(w.posts).toHaveLength(0);
  });

  it('a declined approval sends nothing', async () => {
    const w = writeRig({ approve: false });
    await refused(w.run('update_fields', { ...sev, confirm: true }, withCustom(w)));
    expect(w.posts).toHaveLength(0);
  });
});

describe('create_work_item with custom attributes', () => {
  const defect = {
    item_type: 'Defect',
    name: 'Crash on save',
    project: 'Scope:1001',
    custom: [{ attribute: 'Custom_SyntheticSeverity', value: 'Major' }],
  };

  it('dry run shows the attribute as a new value and sends nothing', async () => {
    const w = writeRig();
    const out = await w.run('create_work_item', { ...defect, dry_run: true }, withCustom(w));
    expect(out.text).toContain('Major');
    expect(w.posts).toHaveLength(0);
  });

  it('creates once, after approval, with the attribute in the request', async () => {
    const w = writeRig();
    const out = await w.run('create_work_item', { ...defect, confirm: true }, withCustom(w));
    expect(out.structured).toMatchObject({ applied: true });
    expect(w.channel.asked[0]).toContain('Custom_SyntheticSeverity');
    expect(w.posts).toEqual([
      {
        path: 'rest-1.v1/Data/Defect',
        xml: '<Asset><Attribute name="Name" act="set">Crash on save</Attribute><Relation name="Scope" act="set"><Asset idref="Scope:1001"/></Relation><Attribute name="Custom_SyntheticSeverity" act="set">Major</Attribute></Asset>',
        contentType: 'application/xml',
      },
    ]);
  });

  it('refuses an attribute the workspace did not enable, and one the type lacks, with no request', async () => {
    const w = writeRig();
    expect((await refused(w.run('create_work_item', { ...defect, confirm: true }, w.ctx))).code).toBe(
      ErrorCode.InputInvalid,
    );
    const story = { ...defect, item_type: 'Story' };
    expect((await refused(w.run('create_work_item', { ...story, confirm: true }, withCustom(w)))).code).toBe(
      ErrorCode.InputInvalid,
    );
    expect(w.posts).toHaveLength(0);
    expect(w.channel.asked).toHaveLength(0);
  });

  it('is refused with no request when a layer is off (negative authorization)', async () => {
    const w = writeRig();
    const error = await refused(
      w.run(
        'create_work_item',
        { ...defect, confirm: true },
        {
          ...withCustom(w),
          grantedTools: ['get_work_item'],
        },
      ),
    );
    expect(error.code).toBe(ErrorCode.ToolDisabled);
    expect(w.posts).toHaveLength(0);
  });
});

describe('the write framework checks custom fields itself', () => {
  const mutation = (field: string): CanonicalMutation => ({
    operation: 'update_fields',
    target: { assetType: 'Defect', oid: 'Defect:1101' },
    changes: [{ field, old: null, new: 'x' }],
  });
  const allowed = { Defect: ['Name'] };

  it('accepts a custom field only when the workspace list names it', () => {
    expect(() => canonicalize(mutation('Custom_A'), allowed)).toThrow(/allowlist/);
    expect(() => canonicalize(mutation('Custom_A'), allowed, ['Custom_B'])).toThrow(/allowlist/);
    expect(canonicalize(mutation('Custom_A'), allowed, ['Custom_A']).changes[0]?.field).toBe('Custom_A');
  });

  it('never accepts a field that is not a custom name just because it is listed', () => {
    expect(() => canonicalize(mutation('Status'), allowed, ['Status'])).toThrow(/allowlist/);
    expect(() => canonicalize(mutation('Custom_'), allowed, ['Custom_'])).toThrow(/allowlist/);
  });

  it('a tool that did not opt in cannot reach a custom field even when the workspace lists it', async () => {
    const w = writeRig();
    // update_status builds no custom change; the framework only passes the list to tools that declare `customFields`.
    const status = CORE_TOOLS.find((t) => t.name === 'update_status');
    expect(status).toBeDefined();
    const ctx = withCustom(w);
    const out = await w.run('update_status', { asset: 'B-01002', new_status: 'Done', confirm: true }, ctx);
    expect(out.structured).toMatchObject({ applied: true });
  });
});

describe('tool descriptions never name an instance attribute (THREAT_MODEL A12)', () => {
  it('no tool description or schema contains a custom attribute name', () => {
    for (const t of CORE_TOOLS) {
      const text = JSON.stringify({ d: t.description, t: t.title });
      expect(text, t.name).not.toMatch(/Custom_[A-Za-z]/);
    }
    const create = CORE_TOOLS.find((t) => t.name === 'create_work_item');
    const update = CORE_TOOLS.find((t) => t.name === 'update_fields');
    for (const t of [create, update]) {
      if (t === undefined) throw new Error('missing tool');
      const shape = (t.inputSchema as unknown as { shape: Record<string, { description?: string }> }).shape;
      expect(shape['custom']?.description).toBeDefined();
      expect(shape['custom']?.description).not.toMatch(/Custom_[A-Za-z]/);
    }
  });
});
