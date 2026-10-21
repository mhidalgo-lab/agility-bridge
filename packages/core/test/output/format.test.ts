// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { formatRows } from '../../src/index.ts';

const ROWS = [
  {
    number: 'B-01001',
    assetType: 'Story',
    oid: 'Story:1001',
    state: 'active',
    name: 'Sign-in page',
    estimate: 3,
  },
  {
    number: 'B-01002',
    assetType: 'Story',
    oid: 'Story:1002',
    state: 'closed',
    name: 'Reset | password',
    owners: [{ name: 'Ann' }, { name: 'Bo' }],
  },
];

describe('formatRows', () => {
  it('renders a table', () => {
    expect(formatRows(ROWS, { format: 'table' }).body).toMatchInlineSnapshot(`
      "| number | assetType | oid | state | name | estimate | owners |
      | --- | --- | --- | --- | --- | --- | --- |
      | B-01001 | Story | Story:1001 | active | Sign-in page | 3 |  |
      | B-01002 | Story | Story:1002 | closed | Reset \\| password |  | Ann; Bo |"
    `);
  });

  it('renders CSV', () => {
    expect(formatRows(ROWS, { format: 'csv' }).body).toMatchInlineSnapshot(`
      "number,assetType,oid,state,name,estimate,owners
      B-01001,Story,Story:1001,active,Sign-in page,3,
      B-01002,Story,Story:1002,closed,Reset | password,,Ann; Bo"
    `);
  });

  it('renders JSON', () => {
    expect(formatRows(ROWS, { format: 'json' }).body).toMatchInlineSnapshot(`
      "[
      {"number":"B-01001","assetType":"Story","oid":"Story:1001","state":"active","name":"Sign-in page","estimate":3},
      {"number":"B-01002","assetType":"Story","oid":"Story:1002","state":"closed","name":"Reset | password","owners":[{"name":"Ann"},{"name":"Bo"}]}
      ]"
    `);
  });

  it('picks a table up to 8 columns and CSV above', () => {
    expect(formatRows(ROWS).format).toBe('table');
    const wide = [Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`c${i}`, i]))];
    expect(formatRows(wide).format).toBe('csv');
  });

  it('neutralises spreadsheet formulas in CSV and keeps negative numbers', () => {
    const out = formatRows(
      [{ a: '=HYPERLINK("x")', b: '+1+1', c: '@SUM(A1)', d: '-2+3', e: -5, f: '-4.5' }],
      { format: 'csv' },
    );
    expect(out.body.split('\n')[1]).toBe(`"'=HYPERLINK(""x"")",'+1+1,'@SUM(A1),'-2+3,-5,-4.5`);
  });

  it('omits absent values instead of null', () => {
    const out = formatRows([{ number: 'B-1', name: null, estimate: undefined, status: 'Open' }], {
      format: 'json',
    });
    expect(out.rows).toEqual([{ number: 'B-1', status: 'Open' }]);
    expect(out.body).not.toContain('null');
  });

  it('cuts long values, caps rows and keeps identity columns through the column cap', () => {
    const long = 'x'.repeat(1000);
    const rows = Array.from({ length: 5 }, (_, i) => ({
      c1: long,
      c2: 1,
      number: `B-${i}`,
      oid: `Story:${i}`,
    }));
    const out = formatRows(rows, { maxRows: 3, maxValueChars: 10, maxColumns: 1 });
    expect(out.columns).toEqual(['number', 'oid']);
    expect(out.rows).toHaveLength(3);
    expect(out.droppedRows).toBe(2);
    expect(out.omittedColumns).toBe(2);
    const cut = formatRows([{ c1: long }], { maxValueChars: 10 });
    expect(cut.rows[0]?.['c1']).toBe(`${'x'.repeat(9)}…`);
    expect(cut.cutValues).toBe(1);
  });

  it('stops at the block cap with exactly the rows shown', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ number: `B-${i}`, name: 'y'.repeat(100) }));
    const out = formatRows(rows, { maxBlockChars: 1000 });
    expect(out.blockCapped).toBe(true);
    expect(out.body.length).toBeLessThanOrEqual(1000);
    expect(out.body.split('\n')).toHaveLength(out.rows.length + 2);
  });

  it('converts rich-text columns and redacts secrets in data', () => {
    const out = formatRows([{ description: '<p>Use <b>Bearer 1.ZmFrZS10b2tlbi1mb3ItdGVzdHM=</b></p>' }], {
      richText: ['description'],
      format: 'json',
    });
    expect(out.rows[0]?.['description']).toBe('Use **Bearer [REDACTED]**');
  });

  it('keeps a __proto__ key as plain data', () => {
    const row = JSON.parse('{"__proto__": {"polluted": true}, "number": "B-1"}') as Record<string, unknown>;
    const out = formatRows([row], { format: 'json' });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.hasOwn(out.rows[0] ?? {}, '__proto__')).toBe(true);
  });
});
