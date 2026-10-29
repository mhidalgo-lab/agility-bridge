// SPDX-License-Identifier: Apache-2.0
// close_asset and reopen_asset on fakes (P7-06): destructive kind, the exact operation request (`?op=`, empty body),
// the approval text, no-ops, the open-children refusal, conflicts, and the refusals that never reach a write. The
// operation names and the request shape are the documented ones and stay *unverified* until the sandbox (P7-07).
import { describe, expect, it } from 'vitest';
import { AbError, annotationsFor, ErrorCode } from '../../src/index.ts';
import { closeAsset, reopenAsset } from '../../src/tools/writes/lifecycle.ts';
import { tool, writeRig } from './writes-world.ts';

async function refused(p: Promise<unknown>): Promise<AbError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AbError);
    return e as AbError;
  }
  throw new Error('expected a refusal');
}

const state = (w: ReturnType<typeof writeRig>, type: string, oid: string): unknown =>
  w.assets[type]?.find((r) => r['_oid'] === oid)?.['AssetState'];

describe('lifecycle tools: kind and annotations', () => {
  it('are destructive, in the writes group, never read-only', () => {
    for (const t of [closeAsset, reopenAsset]) {
      expect(t.kind).toBe('destructive');
      expect(t.group).toBe('writes');
      expect(t.writePipeline).toBe(true);
      expect(annotationsFor(t)).toMatchObject({
        destructiveHint: true,
        readOnlyHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
    }
  });

  it('are two tools, each separately named for enablement', () => {
    expect(tool('close_asset')).toBe(closeAsset);
    expect(tool('reopen_asset')).toBe(reopenAsset);
  });

  it('a grant that names only close_asset cannot reopen', async () => {
    const w = writeRig();
    const error = await refused(
      w.run(
        'reopen_asset',
        { asset: 'B-01001', confirm: true },
        w.context({ grantedTools: ['close_asset'] }),
      ),
    );
    expect(error.code).toBe(ErrorCode.ToolDisabled);
    expect(w.calls).toHaveLength(0);
    expect(w.posts).toHaveLength(0);
  });
});

describe('close_asset', () => {
  it('dry run shows the state change, the operation and the open child count, and sends nothing', async () => {
    const w = writeRig();
    const out = await w.run('close_asset', { asset: 'B-01004', dry_run: true });
    expect(out.text).toContain('Dry run');
    expect(out.structured).toMatchObject({
      applied: false,
      dryRun: true,
      noop: false,
      fields: ['AssetState', 'OpenChildren'],
    });
    expect(w.posts).toHaveLength(0);
    expect(w.channel.asked).toHaveLength(0);
  });

  it('counts the open children of every child type in one request (P7-09)', async () => {
    const w = writeRig();
    await w.run('close_asset', { asset: 'B-01004', dry_run: true });
    // The child counts are one `query.v1` request with one query per child type (a story has tasks and tests).
    const batches = w.calls.filter((c) => Array.isArray(c.body));
    const counts = batches.filter((c) => (c.body as unknown[]).length === 2);
    expect(counts).toHaveLength(1);
  });

  it('applies once, after approval and an intent audit, with exactly this operation request', async () => {
    const w = writeRig();
    w.audit.onIntent = () => expect(w.posts).toHaveLength(0);
    const out = await w.run('close_asset', { asset: 'B-01004', confirm: true });
    expect(out.structured).toMatchObject({ applied: true, approval: 'elicitation' });
    expect(w.posts).toEqual([
      { path: 'rest-1.v1/Data/Story/1004', xml: '', contentType: 'application/xml', op: 'QuickClose' },
    ]);
    expect(w.channel.asked[0]).toContain('Operation: close_asset:QuickClose');
    expect(w.channel.asked[0]).toContain('OpenChildren');
    expect(w.channel.asked[0]).toContain('"Open"');
    expect(w.channel.asked[0]).toContain('"Closed"');
    expect(w.audit.records.map((r) => r.phase)).toEqual(['intent', 'outcome']);
    expect(w.audit.records[0]).toMatchObject({ tool: 'close_asset', fields: ['AssetState', 'OpenChildren'] });
    expect(state(w, 'Story', 'Story:1004')).toBe(128);
  });

  it('closes a task, which has no children to check', async () => {
    const w = writeRig();
    await w.run('close_asset', { asset: 'TK-01201', confirm: true });
    expect(w.posts).toEqual([
      { path: 'rest-1.v1/Data/Task/1201', xml: '', contentType: 'application/xml', op: 'QuickClose' },
    ]);
  });

  it('refuses while the item has open children: no approval, no write, no audit', async () => {
    const w = writeRig();
    const error = await refused(w.run('close_asset', { asset: 'B-01002', confirm: true }));
    expect(error.code).toBe(ErrorCode.InputInvalid);
    expect(error.message).toMatch(/open child/);
    expect(w.posts).toHaveLength(0);
    expect(w.channel.asked).toHaveLength(0);
    expect(w.audit.records).toHaveLength(0);
  });

  it('refuses a dry run with open children the same way', async () => {
    const w = writeRig();
    const error = await refused(w.run('close_asset', { asset: 'B-01002', dry_run: true }));
    expect(error.code).toBe(ErrorCode.InputInvalid);
  });

  it('an already closed item is a no-op: no approval, nothing sent', async () => {
    const w = writeRig();
    const out = await w.run('close_asset', { asset: 'B-01001', confirm: true });
    expect(out.structured).toMatchObject({ applied: false, noop: true });
    expect(w.posts).toHaveLength(0);
    expect(w.channel.asked).toHaveLength(0);
    expect(w.audit.records).toHaveLength(0);
  });

  it('a repeat after a close is a no-op', async () => {
    const w = writeRig();
    await w.run('close_asset', { asset: 'B-01004', confirm: true });
    const out = await w.run('close_asset', { asset: 'B-01004', confirm: true });
    expect(out.structured).toMatchObject({ noop: true });
    expect(w.posts).toHaveLength(1);
  });

  it('a type without a close operation on the instance is refused before approval', async () => {
    const w = writeRig();
    const error = await refused(w.run('close_asset', { asset: 'E-00003', confirm: true }));
    expect(error.code).toBe(ErrorCode.InputInvalid);
    expect(error.message).toMatch(/no QuickClose or Close or Inactivate operation/);
    expect(w.posts).toHaveLength(0);
    expect(w.channel.asked).toHaveLength(0);
  });

  it('a child that appears while the person decides is a conflict: nothing is sent', async () => {
    const w = writeRig({
      duringApproval: (assets) => {
        assets['Task']?.push({
          _oid: 'Task:7000',
          Number: 'TK-07000',
          Name: 'Late task',
          AssetState: 64,
          Scope: 'Scope:1001',
          Parent: 'Story:1004',
        });
      },
    });
    const error = await refused(w.run('close_asset', { asset: 'B-01004', confirm: true }));
    expect(error.code).toBe(ErrorCode.WriteConflict);
    expect(w.posts).toHaveLength(0);
    expect(w.audit.records).toHaveLength(0);
  });

  it('closed by someone else while the person decides: an idempotent no-op', async () => {
    const w = writeRig({
      duringApproval: (assets) => {
        const row = assets['Story']?.find((r) => r['_oid'] === 'Story:1004');
        if (row) row['AssetState'] = 128;
      },
    });
    const out = await w.run('close_asset', { asset: 'B-01004', confirm: true });
    expect(out.structured).toMatchObject({ applied: false, noop: true });
    expect(w.posts).toHaveLength(0);
  });

  it('deleted while the person decides is a conflict', async () => {
    const w = writeRig({
      duringApproval: (assets) => {
        const row = assets['Story']?.find((r) => r['_oid'] === 'Story:1004');
        if (row) row['AssetState'] = 255;
      },
    });
    const error = await refused(w.run('close_asset', { asset: 'B-01004', confirm: true }));
    expect(error.code).toBe(ErrorCode.WriteConflict);
    expect(w.posts).toHaveLength(0);
  });

  it('a declined approval writes nothing', async () => {
    const w = writeRig({ approve: false });
    const error = await refused(w.run('close_asset', { asset: 'B-01004', confirm: true }));
    expect(error.code).toBe(ErrorCode.WriteApprovalDeclined);
    expect(w.posts).toHaveLength(0);
  });

  it('confirm is required and is not approval', async () => {
    const w = writeRig();
    const error = await refused(w.run('close_asset', { asset: 'B-01004' }));
    expect(error.code).toBe(ErrorCode.InputInvalid);
    expect(w.posts).toHaveLength(0);
    expect(w.channel.asked).toHaveLength(0);
  });

  it('refuses a work item type the workspace denies, before any write', async () => {
    const w = writeRig();
    const error = await refused(
      w.run(
        'close_asset',
        { asset: 'B-01004', confirm: true },
        w.context({ assetTypes: { deny: ['Story'] } }),
      ),
    );
    expect([ErrorCode.AuthForbidden, ErrorCode.NotFound]).toContain(error.code);
    expect(w.posts).toHaveLength(0);
    expect(w.channel.asked).toHaveLength(0);
  });

  it('takes only the item: no operation name from the caller', () => {
    expect(Object.keys((closeAsset.inputSchema as unknown as { shape: object }).shape).sort()).toEqual([
      'asset',
      'confirm',
      'dry_run',
    ]);
  });
});

describe('reopen_asset', () => {
  it('applies Reactivate once with exactly this request', async () => {
    const w = writeRig();
    const out = await w.run('reopen_asset', { asset: 'B-01001', confirm: true });
    expect(out.structured).toMatchObject({ applied: true });
    expect(w.posts).toEqual([
      { path: 'rest-1.v1/Data/Story/1001', xml: '', contentType: 'application/xml', op: 'Reactivate' },
    ]);
    expect(w.channel.asked[0]).toContain('Operation: reopen_asset:Reactivate');
    expect(state(w, 'Story', 'Story:1001')).toBe(64);
  });

  it('an open item is a no-op', async () => {
    const w = writeRig();
    const out = await w.run('reopen_asset', { asset: 'B-01004', confirm: true });
    expect(out.structured).toMatchObject({ applied: false, noop: true });
    expect(w.posts).toHaveLength(0);
    expect(w.channel.asked).toHaveLength(0);
  });

  it('a closed task whose type has no Reactivate operation is refused before approval', async () => {
    const w = writeRig();
    const row = w.assets['Task']?.find((r) => r['_oid'] === 'Task:1201');
    if (row) row['AssetState'] = 128;
    const error = await refused(w.run('reopen_asset', { asset: 'TK-01201', confirm: true }));
    expect(error.code).toBe(ErrorCode.InputInvalid);
    expect(error.message).toMatch(/no Reactivate operation/);
    expect(w.posts).toHaveLength(0);
    expect(w.channel.asked).toHaveLength(0);
  });

  it('reopened by someone else while the person decides: a no-op', async () => {
    const w = writeRig({
      duringApproval: (assets) => {
        const row = assets['Story']?.find((r) => r['_oid'] === 'Story:1001');
        if (row) row['AssetState'] = 64;
      },
    });
    const out = await w.run('reopen_asset', { asset: 'B-01001', confirm: true });
    expect(out.structured).toMatchObject({ noop: true });
    expect(w.posts).toHaveLength(0);
  });

  it('a failed operation is not retried and is audited as an error', async () => {
    const w = writeRig();
    let failed = 0;
    const ctx = w.context({
      fetch: async (req) => {
        if (req.method === 'POST' && req.url.includes('rest-1.v1/Data/')) {
          failed++;
          return new Response('nope', { status: 500 });
        }
        return w.context().fetch(req);
      },
    });
    await refused(w.run('reopen_asset', { asset: 'B-01001', confirm: true }, ctx));
    expect(failed).toBe(1);
    expect(w.audit.records.at(-1)).toMatchObject({ phase: 'outcome', status: 'error' });
  });
});
