// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { utcIso } from '../../src/index.ts';
import { type FieldInfo, localTimeNote, toItem } from '../../src/tools/query/rows.ts';
import { workItem } from '../../src/tools/work/items.ts';

describe('work item timestamps (P1-19)', () => {
  it('emits createdAt and changedAt in UTC', () => {
    const w = workItem('Story', {
      _oid: 'Story:1',
      CreateDateUTC: '2026-09-01T10:00:00.0000000Z',
      ChangeDateUTC: '2026-10-01T16:00:00.0000000Z',
    });
    expect(w['createdAt']).toBe('2026-09-01T10:00:00.000Z');
    expect(w['changedAt']).toBe('2026-10-01T16:00:00.000Z');
  });
});

const info: FieldInfo = { kinds: new Map([['ClosedDate', 'Date' as const]]), richText: [] };

describe('zone-less dates (P1-19)', () => {
  it('keeps a zone-less value raw and notes that it is local time', () => {
    const raw = '2026-10-01T05:00:00.0000000';
    const item = toItem({ _oid: 'Story:1', ClosedDate: raw }, 'Story', ['ClosedDate'], info);
    expect(item['ClosedDate']).toBe(raw);
    expect(utcIso(raw)).toBeUndefined();
    expect(localTimeNote([item], info)).toMatch(/ClosedDate: local time with an unknown zone/);
  });

  it('adds no note for a zoned value', () => {
    const item = toItem(
      { _oid: 'Story:1', ClosedDate: '2026-10-01T16:00:00.0000000Z' },
      'Story',
      ['ClosedDate'],
      info,
    );
    expect(item['ClosedDate']).toBe('2026-10-01T16:00:00.000Z');
    expect(localTimeNote([item], info)).toBeUndefined();
  });
});
