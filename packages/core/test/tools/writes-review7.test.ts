// SPDX-License-Identifier: Apache-2.0
// The Phase 7 review fixes for the write path (P7-09): each test was written to fail before its fix (L-330). The failures
// go through the real Agility client (its own error shapes and hints), not a hand-made error.
import { describe, expect, it } from 'vitest';
import { AbError, annotationsFor, ErrorCode } from '../../src/index.ts';
import { hasHiddenCharacters } from '../../src/output/text.ts';
import { COMMENT_REPEAT_WINDOW_MS } from '../../src/tools/writes/add-comment.ts';
import { hasRichFormatting, MAX_DESCRIPTION_CHARS } from '../../src/tools/writes/fields.ts';
import { openChildren } from '../../src/tools/writes/lifecycle.ts';
import { EFFORT_REPEAT_WINDOW_MS, effortDate } from '../../src/tools/writes/log-effort.ts';
import { tool, WRITE_NAMES, writeRig } from './writes-world.ts';

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

/** A context whose POSTs to the write endpoint are answered by `answer`; everything else goes to the world. */
function answering(w: Rig, answer: () => Response | Promise<Response>) {
  return w.context({
    fetch: async (req) => {
      if (req.method === 'POST' && req.url.includes('rest-1.v1/Data/')) {
        w.posts.push({ path: 'sent', xml: '', contentType: null });
        return answer();
      }
      return w.context().fetch(req);
    },
  });
}

const STATUS = { asset: 'B-01002', new_status: 'Done', confirm: true };

describe('the "may or may not have been applied" hint reaches the agent (M1)', () => {
  it.each([
    ['HTTP 503', () => new Response('down', { status: 503 })],
    ['HTTP 500', () => new Response('boom', { status: 500 })],
    [
      'a timeout',
      () => {
        throw new DOMException('timed out', 'TimeoutError');
      },
    ],
  ])('%s: the client hint is replaced and the send is not retried', async (_name, answer) => {
    const w = writeRig();
    const error = await refused(w.run('update_status', STATUS, answering(w, answer)));
    expect([ErrorCode.AgilityUnavailable, ErrorCode.AgilityTimeout]).toContain(error.code);
    expect(error.hint).toMatch(/may or may not have been applied/);
    expect(error.hint).not.toMatch(/try again in a moment|narrow the request/i);
    expect(w.posts.filter((p) => p.path === 'sent')).toHaveLength(1);
    expect(w.audit.records.at(-1)).toMatchObject({ phase: 'outcome', status: 'error' });
    expect(w.audit.records.at(-1)?.note).toMatch(/may have been applied/);
  });

  it('a refusal that proves nothing was applied keeps its own hint', async () => {
    const w = writeRig();
    const error = await refused(
      w.run(
        'update_status',
        STATUS,
        answering(w, () => new Response('no', { status: 403 })),
      ),
    );
    expect(error.code).toBe(ErrorCode.AgilityAuth);
    expect(error.hint).not.toMatch(/may or may not/);
  });

  it.each([
    ['an empty body', ''],
    ['a body that is not XML', 'OK'],
  ])('a 2xx with %s is an applied write, audited as such, never an error', async (_name, body) => {
    const w = writeRig();
    const out = await w.run(
      'close_asset',
      { asset: 'B-01004', confirm: true },
      answering(w, () => new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } })),
    );
    expect(out.structured).toMatchObject({ applied: true, responseReadable: false });
    expect(out.text).toMatch(/could not be read/);
    expect(out.text).toMatch(/Do not repeat the write/);
    expect(w.audit.records.at(-1)).toMatchObject({ phase: 'outcome', status: 'ok' });
    expect(w.audit.records.at(-1)?.note).toMatch(/could not be read/);
  });

  it('an attribute write answered with an empty 200 is applied too', async () => {
    const w = writeRig();
    const out = await w.run(
      'update_status',
      STATUS,
      answering(w, () => new Response('', { status: 200 })),
    );
    expect(out.structured).toMatchObject({ applied: true });
  });
});

describe('close_asset counts every child or refuses (M2)', () => {
  it('refuses when a child type is denied, instead of showing OpenChildren 0', async () => {
    const w = writeRig();
    const ctx = w.context({ assetTypes: { deny: ['Task'] } });
    for (const args of [{ dry_run: true }, { confirm: true }]) {
      const error = await refused(w.run('close_asset', { asset: 'B-01004', ...args }, ctx));
      expect(error.code).toBe(ErrorCode.InputInvalid);
      expect(error.message).toMatch(/Task children cannot be counted/);
    }
    expect(w.posts).toHaveLength(0);
    expect(w.channel.asked).toHaveLength(0);
  });

  it('refuses an epic in a project-restricted workspace: its children may sit in other projects', async () => {
    const w = writeRig();
    const ctx = w.context({ projects: { allowed: ['Scope:1000'], includeChildren: true } });
    const error = await refused(openChildren(ctx, 'Epic', 'Epic:2'));
    expect(error.code).toBe(ErrorCode.InputInvalid);
    expect(error.message).toMatch(/outside this workspace/);
  });
});

describe('Agility-sourced text never blocks a write (D-192)', () => {
  it('renames an item whose current title has a zero-width character', async () => {
    const w = writeRig();
    const row = w.assets['Story']?.find((r) => r['_oid'] === 'Story:1002');
    if (row) row['Name'] = 'Sign​in page';
    const out = await w.run('update_fields', { asset: 'B-01002', name: 'Sign in', confirm: true });
    expect(out.structured).toMatchObject({ applied: true });
    expect(w.channel.asked[0]).toContain('"Signin page [hidden characters removed for display]"');
    expect(w.posts[0]?.xml).toContain('>Sign in<');
  });

  it('replaces a description whose current text is over 8,000 characters, shown shortened with a note', async () => {
    const w = writeRig();
    const row = w.assets['Story']?.find((r) => r['_oid'] === 'Story:1002');
    if (row) row['Description'] = 'x'.repeat(9_000);
    const out = await w.run('update_fields', { asset: 'B-01002', description: 'Short', confirm: true });
    expect(out.structured).toMatchObject({ applied: true });
    expect(w.channel.asked[0]).toContain('shortened for display, 9000 characters in total');
    expect(w.channel.asked[0]?.length).toBeLessThan(6_000);
  });

  it('a label name with hidden characters is cleaned for display (a parent, a status, an owner)', async () => {
    const w = writeRig();
    const epic = w.assets['Epic']?.find((r) => r['_oid'] === 'Epic:2');
    if (epic) epic['Name'] = 'Check​out‮';
    const out = await w.run('create_work_item', {
      item_type: 'Story',
      name: 'A new story',
      project: 'Mobile App',
      parent: 'E-00002',
      confirm: true,
    });
    expect(out.structured).toMatchObject({ applied: true });
    expect(w.channel.asked[0]).toContain('Checkout [Epic:2]');
  });

  it('a value the caller supplies keeps the strict refusal', async () => {
    const w = writeRig();
    for (const name of ['a​b', 'a‮b']) {
      const error = await refused(w.run('update_fields', { asset: 'B-01002', name, confirm: true }));
      expect(error.code).toBe(ErrorCode.InputInvalid);
    }
    expect(w.posts).toHaveLength(0);
  });
});

describe('joiners inside caller text (D-193)', () => {
  it.each([
    ['a family emoji', 'Ship it \u{1F468}‍\u{1F469}‍\u{1F467}'],
    ['a profession emoji with a skin tone', '\u{1F469}\u{1F3FD}‍⚕️ ok'],
    ['Persian with ZWNJ', 'می‌خواهم'],
    ['Devanagari with ZWJ', 'क्‍ष'],
  ])('allows %s', (_name, text) => {
    expect(hasHiddenCharacters(text)).toBe(false);
  });

  it.each([
    ['a lone joiner', '‍'],
    ['a joiner next to a space', 'a ‍ b'],
    ['two joiners in a row', 'a‌‌b'],
    ['a zero-width space', 'a​b'],
    ['a bidi override', 'a‮b'],
    ['a BOM', 'a﻿b'],
    ['a control character', 'a\u0001b'],
  ])('refuses %s', (_name, text) => {
    expect(hasHiddenCharacters(text)).toBe(true);
  });

  it('a comment with an emoji sequence is accepted and sent whole', async () => {
    const w = writeRig();
    const text = 'Done \u{1F468}‍\u{1F469}‍\u{1F467}';
    await w.run('add_comment', { asset: 'B-01002', text, confirm: true });
    expect(w.posts[0]?.xml).toContain(text);
  });
});

describe('no-op windows (D-194)', () => {
  it('the comment window is 10 minutes: an identical comment inside it is a no-op, after it is posted again', async () => {
    const w = writeRig();
    const call = { asset: 'B-01002', text: 'Blocked on infra', confirm: true };
    await w.run('add_comment', call);
    expect((await w.run('add_comment', call)).structured).toMatchObject({ noop: true });
    expect(w.posts).toHaveLength(1);
    expect(COMMENT_REPEAT_WINDOW_MS).toBe(600_000);
    for (const row of w.assets['Expression'] ?? []) row['AuthoredAt'] = '2026-10-21T11:40:00Z';
    const again = await w.run('add_comment', call);
    expect(again.structured).toMatchObject({ applied: true });
    expect(w.posts).toHaveLength(2);
  });

  it('a comment whose time cannot be read does not count as a repeat', async () => {
    const w = writeRig();
    const call = { asset: 'B-01002', text: 'Blocked on infra', confirm: true };
    await w.run('add_comment', call);
    for (const row of w.assets['Expression'] ?? []) row['AuthoredAt'] = 'yesterday';
    expect((await w.run('add_comment', call)).structured).toMatchObject({ applied: true });
  });

  it('the effort window is 10 minutes: the same hours later the same day are logged', async () => {
    const w = writeRig();
    const call = { asset: 'B-01002', hours: 2, date: '2026-10-21', confirm: true };
    await w.run('log_effort', call);
    expect((await w.run('log_effort', call)).structured).toMatchObject({ noop: true });
    expect(w.posts).toHaveLength(1);
    expect(EFFORT_REPEAT_WINDOW_MS).toBe(600_000);
    for (const row of w.assets['Actual'] ?? []) row['CreateDateUTC'] = '2026-10-21T09:00:00.0000000Z';
    const again = await w.run('log_effort', call);
    expect(again.structured).toMatchObject({ applied: true });
    expect(w.posts).toHaveLength(2);
  });

  it('the default date is the UTC day, whatever the caller zone is', () => {
    const late = Date.parse('2026-10-21T23:30:00Z');
    expect(effortDate(undefined, late, 366)).toBe('2026-10-21');
    expect(effortDate(undefined, Date.parse('2026-10-22T00:10:00Z'), 366)).toBe('2026-10-22');
    expect(tool('log_effort').description).toMatch(/UTC/);
  });
});

describe('create duplicate check: creation time (D-195)', () => {
  const CREATE = { item_type: 'Task', name: 'Rotate keys', parent: 'B-01002', confirm: true };

  it('an item whose creation time cannot be read is not recent forever', async () => {
    const w = writeRig();
    await w.run('create_work_item', CREATE);
    for (const row of w.assets['Task'] ?? []) row['CreateDateUTC'] = 'not a date';
    await w.run('create_work_item', CREATE);
    expect(w.posts).toHaveLength(2);
  });

  it('a creation time without a zone gets the widest zone skew instead of being read as UTC', async () => {
    const w = writeRig();
    await w.run('create_work_item', CREATE);
    // Ten hours ago in an unknown zone could still be minutes ago in UTC-10: still a repeat.
    for (const row of w.assets['Task'] ?? []) row['CreateDateUTC'] = '2026-10-21T02:00:00';
    await refused(w.run('create_work_item', CREATE));
    // Two days ago is not.
    for (const row of w.assets['Task'] ?? []) row['CreateDateUTC'] = '2026-10-19T02:00:00';
    await w.run('create_work_item', CREATE);
    expect(w.posts).toHaveLength(2);
  });
});

describe('text limits agree with the schema (performance review)', () => {
  it('the advertised maximum of a description and a comment is the validator maximum', () => {
    const max = (name: string, arg: string): number | undefined => {
      const field = tool(name).inputSchema.shape[arg] as unknown as {
        unwrap?: () => { maxLength: number | null };
        maxLength?: number | null;
      };
      const inner = field.unwrap === undefined ? field : field.unwrap();
      return inner.maxLength ?? undefined;
    };
    expect(max('create_work_item', 'description')).toBe(MAX_DESCRIPTION_CHARS);
    expect(max('update_fields', 'description')).toBe(MAX_DESCRIPTION_CHARS);
    expect(max('add_comment', 'text')).toBe(4_000);
  });
});

describe('overwriting writes advertise destructiveHint (D-197)', () => {
  it('the overwriting tools do, the additive ones do not; the kind stays write', () => {
    const destructive = new Set(['update_fields', 'update_status', 'move_to_sprint', 'assign_owners']);
    const lifecycle = new Set(['close_asset', 'reopen_asset']);
    for (const name of WRITE_NAMES) {
      const t = tool(name);
      const hint = annotationsFor(t).destructiveHint;
      if (lifecycle.has(name)) {
        expect(t.kind).toBe('destructive');
        expect(hint).toBe(true);
      } else {
        expect(t.kind).toBe('write');
        expect(hint).toBe(destructive.has(name));
      }
    }
    expect(WRITE_NAMES).toEqual(expect.arrayContaining(['add_comment', 'log_effort', 'create_work_item']));
  });
});

describe('update_fields will not erase formatting it cannot show (D-196)', () => {
  it('detects what plain text cannot hold', () => {
    expect(hasRichFormatting('<p>Plain</p><p>text<br>here</p>')).toBe(false);
    expect(hasRichFormatting('<div>just a div</div>')).toBe(false);
    expect(hasRichFormatting('no markup at all')).toBe(false);
    for (const html of [
      '<p>See <a href="https://example.invalid">this</a></p>',
      '<ul><li>one</li></ul>',
      '<p><strong>bold</strong></p>',
      '<img src="x.png">',
      '<table><tr><td>x</td></tr></table>',
    ]) {
      expect(hasRichFormatting(html)).toBe(true);
    }
  });

  it('refuses to replace a rich description, and says why; no approval, no write', async () => {
    const w = writeRig();
    const row = w.assets['Story']?.find((r) => r['_oid'] === 'Story:1002');
    if (row)
      row['Description'] =
        '<p>Steps:</p><ul><li>one</li></ul><p>See <a href="https://x.invalid/a">spec</a></p>';
    for (const args of [{ dry_run: true }, { confirm: true }]) {
      const error = await refused(
        w.run('update_fields', { asset: 'B-01002', description: 'A new plain text', ...args }),
      );
      expect(error.code).toBe(ErrorCode.InputInvalid);
      expect(error.message).toMatch(/formatting that plain text cannot keep/);
    }
    expect(w.posts).toHaveLength(0);
    expect(w.channel.asked).toHaveLength(0);
  });

  it('still changes other fields of an item with a rich description, and a plain description', async () => {
    const w = writeRig();
    const row = w.assets['Story']?.find((r) => r['_oid'] === 'Story:1002');
    if (row) row['Description'] = '<p>See <a href="https://x.invalid/a">spec</a></p>';
    const out = await w.run('update_fields', { asset: 'B-01002', estimate: 8, confirm: true });
    expect(out.structured).toMatchObject({ applied: true });
    if (row) row['Description'] = '<p>Plain old text</p>';
    const out2 = await w.run('update_fields', { asset: 'B-01002', description: 'Newer text', confirm: true });
    expect(out2.structured).toMatchObject({ applied: true });
  });
});
