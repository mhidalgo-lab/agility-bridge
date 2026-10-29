// SPDX-License-Identifier: Apache-2.0
// P7-25 (L-133): docs/guide/write-tools.md equals the tool registry and the approval renderer. Adding or renaming a
// write tool, or changing the approval layout, fails here until the guide changes too.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CORE_TOOLS, renderApproval } from '../../packages/core/src/index.ts';

const guide = readFileSync(new URL('../../docs/guide/write-tools.md', import.meta.url), 'utf8');
const writeTools = CORE_TOOLS.filter((t) => t.kind !== 'read');

/** The lines of the first table that follows `heading`'s section start, as cell arrays. */
function tableAfter(marker: string): string[][] {
  const start = guide.indexOf(marker);
  expect(start, `the guide has no "${marker}"`).toBeGreaterThanOrEqual(0);
  const rows: string[][] = [];
  let inTable = false;
  for (const line of guide.slice(start).split('\n')) {
    if (line.startsWith('|')) {
      inTable = true;
      rows.push(
        line
          .split('|')
          .slice(1, -1)
          .map((c) => c.trim()),
      );
    } else if (inTable) break;
  }
  return rows.slice(2); // header and separator
}

const names = (rows: string[][]): string[] => rows.map((r) => (r[0] ?? '').replace(/`/g, ''));

describe('docs/guide/write-tools.md', () => {
  it('lists every write tool of the registry, with its kind, and nothing else', () => {
    const rows = tableAfter('## The nine tools');
    expect(names(rows).sort()).toEqual(writeTools.map((t) => t.name).sort());
    for (const t of writeTools) {
      expect(rows.find((r) => r[0] === `\`${t.name}\``)?.[1], t.name).toBe(t.kind);
    }
  });

  it('says the right number of tools in its heading', () => {
    const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
    expect(guide).toContain(`## The ${words[writeTools.length] ?? '?'} tools`);
  });

  it('has an approval row for every write tool except update_status (shown in full)', () => {
    const rows = tableAfter('| Tool | Operation line | Changes shown');
    expect(names(rows).sort()).toEqual(
      writeTools
        .map((t) => t.name)
        .filter((n) => n !== 'update_status')
        .sort(),
    );
  });

  it('shows the approval text the shipped renderer produces', () => {
    const block = /### What the person is asked[\s\S]*?```text\n([\s\S]*?)\n```/.exec(guide)?.[1];
    expect(block, 'the guide has no approval example').toBeDefined();
    const rendered = renderApproval({
      tool: 'update_status',
      mutation: {
        operation: 'update_status',
        target: { assetType: 'Story', oid: 'Story:1042', number: 'S-01042' },
        changes: [{ field: 'Status', old: 'In Progress [StoryStatus:134]', new: 'Done [StoryStatus:135]' }],
      },
      hash: '8344652b5d5d0000',
      label: 'Checkout fails for guests',
      random: { uuid: () => '', bytes: (n: number) => new Uint8Array(n).fill(0xab) },
    });
    expect(block).toBe(rendered);
  });
});
