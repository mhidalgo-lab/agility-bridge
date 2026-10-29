// SPDX-License-Identifier: Apache-2.0
// Relations of the wave-2 tools on fakes (P7-21, D-240, D-241): owners, team and sprint on create; a new parent or project
// on update. Dry run, approved apply with the exact request, conflict, no-op, refusals before any request, negative
// authorization. The request shapes are the documented ones and stay *unverified* until the sandbox (P7-07).
import { describe, expect, it } from 'vitest';
import { AbError, ErrorCode, type ToolContext } from '../../src/index.ts';
import snapshot from '../fixtures/agility/meta-snapshot.json' with { type: 'json' };
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

type Rig = ReturnType<typeof writeRig>;
const find = (w: Rig, type: string, oid: string): Record<string, unknown> | undefined =>
  w.assets[type]?.find((r) => r['_oid'] === oid);

/** The second project of the rig gets a story of its own, and a context that may reach both. */
function twoProjects(w: Rig): ToolContext {
  const story = {
    _oid: 'Story:3001',
    AssetType: 'Story',
    Number: 'B-03001',
    Name: 'Story of the web app',
    AssetState: 64,
    Scope: 'Scope:1002',
    'Scope.Name': 'Web App',
    ChangeDateUTC: '2026-10-20T10:00:00.0000000Z',
  };
  for (const type of ['Story', 'PrimaryWorkitem', 'Workitem']) w.assets[type]?.push(story);
  return w.context({ projects: { allowed: ['Scope:1001', 'Scope:1002'], includeChildren: true } });
}

describe('update_fields: re-parent (P7-21)', () => {
  it('dry run shows the old and the new parent and sends nothing', async () => {
    const w = writeRig();
    const out = await w.run('update_fields', { asset: 'B-01002', parent: 'E-00003', dry_run: true });
    expect(out.structured).toMatchObject({ fields: ['Super'], noop: false });
    expect(out.text).toContain('Checkout [Epic:2]');
    expect(w.posts).toHaveLength(0);
  });

  it('applies once, after approval, with exactly this request; a repeat is a no-op', async () => {
    const w = writeRig();
    const out = await w.run('update_fields', { asset: 'B-01002', parent: 'E-00003', confirm: true });
    expect(out.structured).toMatchObject({ applied: true });
    expect(w.channel.asked[0]).toContain('old: "Checkout [Epic:2]"');
    expect(w.channel.asked[0]).toContain('new: "Empty epic [Epic:3]"');
    expect(w.posts).toEqual([
      {
        path: 'rest-1.v1/Data/Story/1002',
        xml: '<Asset><Relation name="Super" act="set"><Asset idref="Epic:3"/></Relation></Asset>',
        contentType: 'application/xml',
      },
    ]);
    const again = await w.run('update_fields', { asset: 'B-01002', parent: 'E-00003', confirm: true });
    expect(again.structured).toMatchObject({ noop: true, applied: false });
    expect(w.posts).toHaveLength(1);
  });

  it('moves a task to another story of its own project (relation Parent)', async () => {
    const w = writeRig();
    await w.run('update_fields', { asset: 'TK-01201', parent: 'B-01004', confirm: true });
    expect(w.posts[0]).toMatchObject({
      path: 'rest-1.v1/Data/Task/1201',
      xml: '<Asset><Relation name="Parent" act="set"><Asset idref="Story:1004"/></Relation></Asset>',
    });
  });

  it('can be combined with other fields in the same request', async () => {
    const w = writeRig();
    await w.run('update_fields', { asset: 'B-01002', name: 'Renamed', parent: 'E-00003', confirm: true });
    expect(w.posts).toHaveLength(1);
    expect(w.posts[0]?.xml).toBe(
      '<Asset><Attribute name="Name" act="set">Renamed</Attribute><Relation name="Super" act="set"><Asset idref="Epic:3"/></Relation></Asset>',
    );
  });

  it('is a conflict when the parent changed meanwhile, or the new parent was closed; nothing is sent', async () => {
    const moved = writeRig({
      duringApproval: (assets) => {
        const row = assets['Story']?.find((r) => r['_oid'] === 'Story:1002');
        if (row) Object.assign(row, { Super: 'Epic:1', 'Super.Name': 'Release 5' });
      },
    });
    expect(
      (await refused(moved.run('update_fields', { asset: 'B-01002', parent: 'E-00003', confirm: true })))
        .code,
    ).toBe(ErrorCode.WriteConflict);
    const closed = writeRig({
      duringApproval: (assets) => {
        const row = assets['Epic']?.find((r) => r['_oid'] === 'Epic:3');
        if (row) row['AssetState'] = 128;
      },
    });
    expect(
      (await refused(closed.run('update_fields', { asset: 'B-01002', parent: 'E-00003', confirm: true })))
        .code,
    ).toBe(ErrorCode.WriteConflict);
    expect(moved.posts).toHaveLength(0);
    expect(closed.posts).toHaveLength(0);
  });

  it('is a conflict when a task’s new parent moved to another project meanwhile', async () => {
    const racing = writeRig({
      duringApproval: (assets) => {
        const row = assets['Story']?.find((r) => r['_oid'] === 'Story:1004');
        if (row) Object.assign(row, { Scope: 'Scope:1002', 'Scope.Name': 'Web App' });
      },
    });
    const ctx = twoProjects(racing);
    const error = await refused(
      racing.run('update_fields', { asset: 'TK-01201', parent: 'B-01004', confirm: true }, ctx),
    );
    expect(error.code).toBe(ErrorCode.WriteConflict);
    expect(racing.posts).toHaveLength(0);
  });

  it('refuses itself, a parent of the wrong type, a closed parent, another project and an unknown one, with no write', async () => {
    const w = writeRig();
    const ctx = twoProjects(w);
    const closedEpic = find(w, 'Epic', 'Epic:3');
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ asset: 'E-00002', parent: 'E-00002' }, /own parent/],
      [{ asset: 'B-01002', parent: 'B-01001' }, /does not change|Epic/],
      [{ asset: 'TK-01201', parent: 'B-03001' }, /another project/],
      [{ asset: 'B-01002', parent: 'E-99999' }, /not found|No /],
      [{ asset: 'B-01002', parent: 'B-02001' }, /not found|No |visible/],
    ];
    for (const [args, message] of cases) {
      const error = await refused(w.run('update_fields', { ...args, confirm: true }, ctx));
      expect(error.code, JSON.stringify(args)).toBe(
        /not found|No /.test(String(message)) ? ErrorCode.NotFound : error.code,
      );
      expect(`${error.message}`, JSON.stringify(args)).toMatch(message);
    }
    if (closedEpic) closedEpic['AssetState'] = 128;
    expect(
      (await refused(w.run('update_fields', { asset: 'B-01002', parent: 'E-00003', confirm: true }, ctx)))
        .message,
    ).toMatch(/closed/);
    expect(w.posts).toHaveLength(0);
    expect(w.channel.asked).toHaveLength(0);
  });

  it('is refused with no request when a layer is off (negative authorization)', async () => {
    const w = writeRig();
    const calls = w.calls.length;
    const error = await refused(
      w.run(
        'update_fields',
        { asset: 'B-01002', parent: 'E-00003', confirm: true },
        w.context({ grantedTools: ['get_work_item'] }),
      ),
    );
    expect(error.code).toBe(ErrorCode.ToolDisabled);
    expect(w.calls).toHaveLength(calls);
    expect(w.posts).toHaveLength(0);
  });
});

describe('update_fields: move to another project (P7-21, D-240)', () => {
  const outOfSprint = (w: Rig, oid = 'Story:1002'): void => {
    const row = find(w, 'Story', oid);
    if (row) Object.assign(row, { Timebox: null, 'Timebox.Name': null });
  };

  it('dry run shows the old and the new project and sends nothing', async () => {
    const w = writeRig();
    const ctx = twoProjects(w);
    outOfSprint(w);
    const out = await w.run('update_fields', { asset: 'B-01002', project: 'Web App', dry_run: true }, ctx);
    expect(out.structured).toMatchObject({ fields: ['Scope'], noop: false });
    expect(out.text).toContain('Mobile App [Scope:1001]');
    expect(w.posts).toHaveLength(0);
  });

  it('applies once, after approval, with exactly this request; a repeat is a no-op', async () => {
    const w = writeRig();
    const ctx = twoProjects(w);
    outOfSprint(w);
    const out = await w.run('update_fields', { asset: 'B-01002', project: 'Scope:1002', confirm: true }, ctx);
    expect(out.structured).toMatchObject({ applied: true });
    expect(w.channel.asked[0]).toContain('new: "Web App [Scope:1002]"');
    expect(w.posts).toEqual([
      {
        path: 'rest-1.v1/Data/Story/1002',
        xml: '<Asset><Relation name="Scope" act="set"><Asset idref="Scope:1002"/></Relation></Asset>',
        contentType: 'application/xml',
      },
    ]);
    const again = await w.run(
      'update_fields',
      { asset: 'B-01002', project: 'Scope:1002', confirm: true },
      ctx,
    );
    expect(again.structured).toMatchObject({ noop: true, applied: false });
    expect(w.posts).toHaveLength(1);
  });

  it('refuses an item that is in a sprint, and says how to take it out', async () => {
    const w = writeRig();
    const ctx = twoProjects(w);
    const error = await refused(
      w.run('update_fields', { asset: 'B-01002', project: 'Web App', confirm: true }, ctx),
    );
    expect(error.code).toBe(ErrorCode.InputInvalid);
    expect(error.hint).toMatch(/to_backlog/);
    expect(w.posts).toHaveLength(0);
  });

  it('is a conflict when the item entered a sprint while the person decided', async () => {
    const w = writeRig({
      duringApproval: (assets) => {
        const row = assets['Story']?.find((r) => r['_oid'] === 'Story:1002');
        if (row) Object.assign(row, { Timebox: 'Timebox:42', 'Timebox.Name': 'Sprint 42' });
      },
    });
    const ctx = twoProjects(w);
    outOfSprint(w);
    const error = await refused(
      w.run('update_fields', { asset: 'B-01002', project: 'Web App', confirm: true }, ctx),
    );
    expect(error.code).toBe(ErrorCode.WriteConflict);
    expect(w.posts).toHaveLength(0);
  });

  it('refuses a task or test, a project outside the workspace, a closed project and an unknown one', async () => {
    const w = writeRig();
    const ctx = twoProjects(w);
    outOfSprint(w);
    expect(
      (await refused(w.run('update_fields', { asset: 'TK-01201', project: 'Web App', confirm: true }, ctx)))
        .message,
    ).toMatch(/moves with it/);
    // Scope:2000 exists in Agility but not in the workspace: it answers like an unknown project.
    for (const project of ['Outside', 'Scope:2000', 'Scope:9999', 'Nothing at all']) {
      expect(
        (await refused(w.run('update_fields', { asset: 'B-01002', project, confirm: true }, ctx))).code,
      ).toBe(ErrorCode.NotFound);
    }
    const web = find(w, 'Scope', 'Scope:1002');
    if (web) web['AssetState'] = 200;
    await refused(w.run('update_fields', { asset: 'B-01002', project: 'Web App', confirm: true }, ctx));
    expect(w.posts).toHaveLength(0);
    expect(w.channel.asked).toHaveLength(0);
  });

  it('is refused with no request when a layer is off (negative authorization)', async () => {
    const w = writeRig();
    outOfSprint(w);
    const calls = w.calls.length;
    const error = await refused(
      w.run(
        'update_fields',
        { asset: 'B-01002', project: 'Scope:1001', confirm: true },
        w.context({ writes: undefined } as unknown as Partial<ToolContext>),
      ),
    );
    expect(error.code).toBe(ErrorCode.ToolDisabled);
    expect(w.calls).toHaveLength(calls);
    expect(w.posts).toHaveLength(0);
  });
});

describe('create_work_item: owners, team and sprint (P7-21, D-241)', () => {
  const story = {
    item_type: 'Story',
    name: 'Reset password by email',
    project: 'Mobile App',
    owners: ['bob', 'me'],
    team: 'Blue',
    sprint: 'Empty sprint',
  };

  it('dry run shows every new relation and sends nothing', async () => {
    const w = writeRig();
    const out = await w.run('create_work_item', { ...story, dry_run: true });
    expect(out.structured).toMatchObject({ fields: ['AssetType', 'Name', 'Owners', 'Team', 'Timebox'] });
    for (const shown of [
      'Bob Example [Member:21]',
      'Ann Example [Member:20]',
      'Blue [Team:5]',
      'Empty sprint [Timebox:45]',
    ]) {
      expect(out.text).toContain(shown);
    }
    expect(w.posts).toHaveLength(0);
  });

  it('creates once, after approval, with the relations in the one request', async () => {
    const w = writeRig();
    const out = await w.run('create_work_item', { ...story, confirm: true });
    expect(out.structured).toMatchObject({ applied: true });
    expect(w.channel.asked[0]).toContain('Bob Example [Member:21]');
    expect(w.posts).toEqual([
      {
        path: 'rest-1.v1/Data/Story',
        xml:
          '<Asset><Attribute name="Name" act="set">Reset password by email</Attribute>' +
          '<Relation name="Scope" act="set"><Asset idref="Scope:1001"/></Relation>' +
          '<Relation name="Owners" act="add"><Asset idref="Member:20"/><Asset idref="Member:21"/></Relation>' +
          '<Relation name="Team" act="set"><Asset idref="Team:5"/></Relation>' +
          '<Relation name="Timebox" act="set"><Asset idref="Timebox:45"/></Relation></Asset>',
        contentType: 'application/xml',
      },
    ]);
    const oid = (out.structured as { resultOid?: string }).resultOid as string;
    expect(find(w, 'Story', oid)).toMatchObject({ Owners: ['Member:20', 'Member:21'], Team: 'Team:5' });
  });

  it('names a member once however it is spelled, and sends nothing for an empty list', async () => {
    const w = writeRig();
    await w.run('create_work_item', {
      item_type: 'Story',
      name: 'A',
      project: 'Mobile App',
      owners: ['bob', 'Bob Example', 'Member:21'],
      confirm: true,
    });
    expect(w.posts[0]?.xml).toContain(
      '<Relation name="Owners" act="add"><Asset idref="Member:21"/></Relation>',
    );
    const none = writeRig();
    await none.run('create_work_item', {
      item_type: 'Story',
      name: 'B',
      project: 'Mobile App',
      owners: [],
      confirm: true,
    });
    expect(none.posts[0]?.xml).not.toContain('Owners');
  });

  it('is a conflict when the sprint was closed while the person decided; nothing is created', async () => {
    const w = writeRig({
      duringApproval: (assets) => {
        const sprint = assets['Timebox']?.find((r) => r['_oid'] === 'Timebox:45');
        if (sprint) sprint['AssetState'] = 128;
      },
    });
    const error = await refused(w.run('create_work_item', { ...story, confirm: true }));
    expect(error.code).toBe(ErrorCode.WriteConflict);
    expect(w.posts).toHaveLength(0);
  });

  it('refuses an unknown member, team or sprint, a closed sprint, a sprint of another project and more than three owners', async () => {
    const w = writeRig();
    const sprints = w.assets['Timebox'] ?? [];
    sprints.push(
      {
        _oid: 'Timebox:46',
        Name: 'Old sprint',
        AssetState: 128,
        Schedule: 'Schedule:1',
        'Schedule.ScheduledScopes': ['Scope:1001'],
      },
      {
        _oid: 'Timebox:47',
        Name: 'Other schedule',
        AssetState: 64,
        Schedule: 'Schedule:2',
        'Schedule.ScheduledScopes': ['Scope:2000'],
      },
    );
    for (const bad of [
      { owners: ['Zzzz Nobody'] },
      { team: 'No such team' },
      { sprint: 'Zzzz' },
      { sprint: 'Old sprint' },
      { sprint: 'Other schedule' },
    ]) {
      const error = await refused(
        w.run('create_work_item', {
          item_type: 'Story',
          name: 'X',
          project: 'Mobile App',
          ...bad,
          confirm: true,
        }),
      );
      expect(
        [ErrorCode.NotFound, ErrorCode.InputInvalid, ErrorCode.Ambiguous],
        JSON.stringify(bad),
      ).toContain(error.code as never);
    }
    expect(() =>
      w.run('create_work_item', {
        item_type: 'Story',
        name: 'X',
        project: 'Mobile App',
        owners: ['a', 'b', 'c', 'd'],
        confirm: true,
      }),
    ).toThrow();
    expect(w.posts).toHaveLength(0);
    expect(w.channel.asked).toHaveLength(0);
  });

  it('refuses a relation this instance does not let the type write (a read-only sprint), with no request', async () => {
    const attribute = (
      snapshot as unknown as Record<string, { Attributes: Record<string, { IsReadOnly: boolean }> }>
    )['Epic']?.Attributes['Epic.Timebox'];
    if (attribute === undefined) throw new Error('the fixture has no Epic.Timebox');
    attribute.IsReadOnly = true;
    try {
      const w = writeRig();
      const error = await refused(
        w.run('create_work_item', {
          item_type: 'Epic',
          name: 'E',
          project: 'Mobile App',
          sprint: 'Empty sprint',
          confirm: true,
        }),
      );
      expect(error.code).toBe(ErrorCode.InputInvalid);
      expect(error.message).toMatch(/not a writable attribute/);
      expect(w.posts).toHaveLength(0);
      expect(w.channel.asked).toHaveLength(0);
    } finally {
      attribute.IsReadOnly = false;
    }
  });

  it('is refused with no request and no approval when a layer is off (negative authorization)', async () => {
    const w = writeRig();
    for (const layer of [
      { writes: undefined } as unknown as Partial<ToolContext>,
      { grantedTools: ['get_work_item'] },
    ]) {
      const calls = w.calls.length;
      const error = await refused(w.run('create_work_item', { ...story, confirm: true }, w.context(layer)));
      expect(error.code).toBe(ErrorCode.ToolDisabled);
      expect(w.calls).toHaveLength(calls);
    }
    expect(w.posts).toHaveLength(0);
    expect(w.channel.asked).toHaveLength(0);
  });

  it('respects the workspace asset-type deny list for members, teams and sprints', async () => {
    const w = writeRig();
    for (const [type, bad] of [
      ['Member', { owners: ['bob'] }],
      ['Team', { team: 'Blue' }],
      ['Timebox', { sprint: 'Empty sprint' }],
    ] as const) {
      const ctx = w.context({ assetTypes: { deny: [type] } });
      const calls = w.calls.length;
      const error = await refused(
        w.run(
          'create_work_item',
          { item_type: 'Story', name: 'X', project: 'Mobile App', ...bad, confirm: true },
          ctx,
        ),
      );
      expect(error.code, type).toBe(ErrorCode.AuthForbidden);
      void calls;
    }
    expect(w.posts).toHaveLength(0);
    expect(w.channel.asked).toHaveLength(0);
  });
});
