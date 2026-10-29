// SPDX-License-Identifier: Apache-2.0
// Wave-1 extensions on fakes (P7-17, D-236, D-237): taking an item out of its sprint, logging effort for another member
// who owns the item, and the remaining to-do of a task. Each has a dry run, an approved apply with the exact request, a
// conflict on re-read, a no-op, refusals that reach no Agility and negative authorization. The request shapes are the
// documented ones and stay *unverified* until the sandbox (P7-07).
import { describe, expect, it } from 'vitest';
import { AbError, ErrorCode, type ToolContext } from '../../src/index.ts';
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

describe('move_to_sprint with to_backlog (P7-17)', () => {
  const args = { asset: 'B-01002', to_backlog: true };

  it('dry run shows the sprint now and nothing after, and sends nothing', async () => {
    const w = writeRig();
    const out = await w.run('move_to_sprint', { ...args, dry_run: true });
    expect(out.text).toContain('Sprint 42 [Timebox:42]');
    expect(out.text).not.toContain('Empty sprint');
    expect(out.structured).toMatchObject({ fields: ['Timebox'], noop: false });
    expect(w.posts).toHaveLength(0);
    expect(w.channel.asked).toHaveLength(0);
  });

  it('applies once, after approval, with an empty Timebox relation; a repeat is a no-op', async () => {
    const w = writeRig();
    const out = await w.run('move_to_sprint', { ...args, confirm: true });
    expect(out.structured).toMatchObject({ applied: true });
    expect(w.channel.asked).toHaveLength(1);
    expect(w.channel.asked[0]).toContain('old: "Sprint 42 [Timebox:42]"');
    expect(w.channel.asked[0]).toContain('new: null');
    expect(w.posts).toEqual([
      {
        path: 'rest-1.v1/Data/Story/1002',
        xml: '<Asset><Relation name="Timebox" act="set"></Relation></Asset>',
        contentType: 'application/xml',
      },
    ]);
    expect(w.assets['Story']?.find((r) => r['_oid'] === 'Story:1002')?.['Timebox']).toBeNull();
    const again = await w.run('move_to_sprint', { ...args, confirm: true });
    expect(again.structured).toMatchObject({ noop: true, applied: false });
    expect(w.posts).toHaveLength(1);
    expect(w.channel.asked).toHaveLength(1);
  });

  it('is a conflict when the item was moved to another sprint while the person decided', async () => {
    const w = writeRig({
      duringApproval: (assets) => {
        const row = assets['Story']?.find((r) => r['_oid'] === 'Story:1002');
        if (row) Object.assign(row, { Timebox: 'Timebox:45', 'Timebox.Name': 'Empty sprint' });
      },
    });
    const error = await refused(w.run('move_to_sprint', { ...args, confirm: true }));
    expect(error.code).toBe(ErrorCode.WriteConflict);
    expect(w.posts).toHaveLength(0);
  });

  it('refuses sprint and to_backlog together, neither, to_backlog false, and a task, with no request', async () => {
    const w = writeRig();
    for (const bad of [
      { asset: 'B-01002', sprint: 'Empty sprint', to_backlog: true },
      { asset: 'B-01002' },
      { asset: 'B-01002', to_backlog: false },
    ]) {
      expect((await refused(w.run('move_to_sprint', { ...bad, confirm: true }))).code).toBe(
        ErrorCode.InputInvalid,
      );
    }
    expect(
      (await refused(w.run('move_to_sprint', { asset: 'TK-01201', to_backlog: true, confirm: true }))).code,
    ).toBe(ErrorCode.InputInvalid);
    expect(w.posts).toHaveLength(0);
    expect(w.channel.asked).toHaveLength(0);
  });

  it('is refused with no request and no approval when a layer is off (negative authorization)', async () => {
    const w = writeRig();
    const layers: Partial<ToolContext>[] = [
      { writes: undefined } as unknown as Partial<ToolContext>,
      { grantedTools: ['get_work_item'] },
    ];
    for (const layer of layers) {
      const before = w.calls.length;
      const error = await refused(w.run('move_to_sprint', { ...args, confirm: true }, w.context(layer)));
      expect(error.code).toBe(ErrorCode.ToolDisabled);
      expect(w.calls).toHaveLength(before);
    }
    expect(w.posts).toHaveLength(0);
    expect(w.channel.asked).toHaveLength(0);
  });

  it('a declined approval sends nothing', async () => {
    const w = writeRig({ approve: false });
    await refused(w.run('move_to_sprint', { ...args, confirm: true }));
    expect(w.posts).toHaveLength(0);
  });
});

describe('log_effort for another member (P7-17, D-236)', () => {
  const bob = { asset: 'B-01002', hours: 2.5, member: 'bob' };

  async function bobOwns(w: ReturnType<typeof writeRig>): Promise<void> {
    await w.run('assign_owners', { asset: 'B-01002', add: ['bob'], confirm: true });
    w.posts.length = 0;
  }

  it('refuses a member who is not an owner of the item, before any approval or request', async () => {
    const w = writeRig();
    const error = await refused(w.run('log_effort', { ...bob, confirm: true }));
    expect(error.code).toBe(ErrorCode.InputInvalid);
    expect(error.message).toMatch(/not an owner/);
    expect(w.posts).toHaveLength(0);
    expect(w.channel.asked).toHaveLength(0);
    expect(w.audit.records).toHaveLength(0);
  });

  it('dry run for an owner shows that member; the approval names them; the request carries them', async () => {
    const w = writeRig();
    await bobOwns(w);
    const dry = await w.run('log_effort', { ...bob, dry_run: true });
    expect(dry.text).toContain('Bob Example [Member:21]');
    expect(w.posts).toHaveLength(0);
    const asked = w.channel.asked.length;
    const out = await w.run('log_effort', { ...bob, date: '2026-10-20', confirm: true });
    expect(out.structured).toMatchObject({ applied: true });
    expect(w.channel.asked).toHaveLength(asked + 1);
    expect(w.channel.asked.at(-1)).toContain('Bob Example [Member:21]');
    expect(w.posts).toEqual([
      {
        path: 'rest-1.v1/Data/Actual',
        xml: '<Asset><Attribute name="Value" act="set">2.5</Attribute><Attribute name="Date" act="set">2026-10-20</Attribute><Relation name="Member" act="set"><Asset idref="Member:21"/></Relation><Relation name="Workitem" act="set"><Asset idref="Story:1002"/></Relation></Asset>',
        contentType: 'application/xml',
      },
    ]);
  });

  it('an identical entry for that member is a no-op, and one for yourself is a different entry', async () => {
    const w = writeRig();
    await bobOwns(w);
    await w.run('log_effort', { ...bob, confirm: true });
    const again = await w.run('log_effort', { ...bob, confirm: true });
    expect(again.structured).toMatchObject({ noop: true, applied: false });
    expect(w.posts).toHaveLength(1);
    const mine = await w.run('log_effort', { asset: 'B-01002', hours: 2.5, confirm: true });
    expect(mine.structured).toMatchObject({ applied: true });
    expect(w.posts).toHaveLength(2);
  });

  it('naming yourself is the usual self log', async () => {
    const w = writeRig();
    const out = await w.run('log_effort', { asset: 'B-01002', hours: 1, member: 'me', confirm: true });
    expect(out.structured).toMatchObject({ applied: true });
    expect(w.posts[0]?.xml).toContain('<Asset idref="Member:20"/>');
  });

  it('is a conflict when the member stopped being an owner while the person decided', async () => {
    const again = writeRig({
      duringApproval: (assets) => {
        const row = assets['Story']?.find((r) => r['_oid'] === 'Story:1002');
        if (row) Object.assign(row, { Owners: ['Member:20'], 'Owners.Name': ['Ann Example'] });
      },
    });
    await again.run('assign_owners', { asset: 'B-01002', add: ['bob'], confirm: true });
    again.posts.length = 0;
    const error = await refused(again.run('log_effort', { ...bob, confirm: true }));
    expect(error.code).toBe(ErrorCode.WriteConflict);
    expect(again.posts).toHaveLength(0);
  });

  it('an unknown member is refused with no request', async () => {
    const w = writeRig();
    await refused(w.run('log_effort', { ...bob, member: 'Zzzz Nobody', confirm: true }));
    expect(w.posts).toHaveLength(0);
  });

  it('is refused with no request and no approval when a layer is off (negative authorization)', async () => {
    const w = writeRig();
    await bobOwns(w);
    const asked = w.channel.asked.length;
    const calls = w.calls.length;
    const error = await refused(
      w.run('log_effort', { ...bob, confirm: true }, w.context({ grantedTools: ['get_work_item'] })),
    );
    expect(error.code).toBe(ErrorCode.ToolDisabled);
    expect(w.calls).toHaveLength(calls);
    expect(w.channel.asked).toHaveLength(asked);
    expect(w.posts).toHaveLength(0);
  });
});

describe('update_fields with todo (P7-17, D-237)', () => {
  const args = { asset: 'TK-01201', todo: 1.5 };

  it('dry run shows ToDo old and new and sends nothing', async () => {
    const w = writeRig();
    const out = await w.run('update_fields', { ...args, dry_run: true });
    expect(out.structured).toMatchObject({ fields: ['ToDo'], noop: false });
    expect(w.posts).toHaveLength(0);
  });

  it('applies once, after approval, with exactly this request; a repeat is a no-op', async () => {
    const w = writeRig();
    const out = await w.run('update_fields', { ...args, confirm: true });
    expect(out.structured).toMatchObject({ applied: true });
    expect(w.channel.asked).toHaveLength(1);
    expect(w.posts).toEqual([
      {
        path: 'rest-1.v1/Data/Task/1201',
        xml: '<Asset><Attribute name="ToDo" act="set">1.5</Attribute></Asset>',
        contentType: 'application/xml',
      },
    ]);
    const again = await w.run('update_fields', { ...args, confirm: true });
    expect(again.structured).toMatchObject({ noop: true, applied: false });
    expect(w.posts).toHaveLength(1);
  });

  it('can change the hours and the to-do in one request', async () => {
    const w = writeRig();
    await w.run('update_fields', { asset: 'TK-01201', estimate: 4, todo: 0, confirm: true });
    expect(w.posts[0]?.xml).toBe(
      '<Asset><Attribute name="DetailEstimate" act="set">4</Attribute><Attribute name="ToDo" act="set">0</Attribute></Asset>',
    );
  });

  it('is a conflict when the to-do changed while the person decided', async () => {
    const w = writeRig({
      duringApproval: (assets) => {
        const row = assets['Task']?.find((r) => r['_oid'] === 'Task:1201');
        if (row) row['ToDo'] = 9;
      },
    });
    const error = await refused(w.run('update_fields', { ...args, confirm: true }));
    expect(error.code).toBe(ErrorCode.WriteConflict);
    expect(w.posts).toHaveLength(0);
  });

  it('is refused for a backlog item, a defect and an epic, with no request', async () => {
    const w = writeRig();
    for (const asset of ['B-01002', 'D-01101', 'E-00003']) {
      expect((await refused(w.run('update_fields', { asset, todo: 1, confirm: true }))).code).toBe(
        ErrorCode.InputInvalid,
      );
    }
    for (const todo of [-1, 10_001]) {
      expect(() => w.run('update_fields', { asset: 'TK-01201', todo, confirm: true })).toThrow();
    }
    expect(w.posts).toHaveLength(0);
    expect(w.channel.asked).toHaveLength(0);
  });

  it('is refused with no request when a layer is off (negative authorization)', async () => {
    const w = writeRig();
    const error = await refused(
      w.run('update_fields', { ...args, confirm: true }, w.context({ grantedTools: ['get_work_item'] })),
    );
    expect(error.code).toBe(ErrorCode.ToolDisabled);
    expect(w.posts).toHaveLength(0);
    expect(w.channel.asked).toHaveLength(0);
  });
});
