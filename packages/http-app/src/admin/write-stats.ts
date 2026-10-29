// SPDX-License-Identifier: Apache-2.0
// Statistics over `write` audit rows (P7-11, THREAT_MODEL T17). A write is two rows: an intent (stored before the change
// is sent) and an outcome whose `details.intentId` is the intent row's id. Counting pairs, not rows, tells a write that
// was applied from one that was refused after its intent, and shows an intent that never got an outcome: a crash between
// the two, or an outcome that could not be stored. Only names, ids and fixed codes are read; a row holds no value.
import type { AuditEntry } from '@agility-bridge/storage';

/** An intent younger than this has no outcome yet because the write is still running; older ones are flagged. */
export const UNPAIRED_GRACE_MS: number = 10 * 60_000;
/** Unpaired intents listed in the answer. */
export const UNPAIRED_LISTED: number = 20;

export type WriteState = 'ok' | 'error' | 'no_outcome' | 'in_progress';

export interface WriteStatsRow {
  readonly key: string;
  readonly writes: number;
  readonly ok: number;
  readonly error: number;
  /** Intents older than the grace period with no outcome. */
  readonly noOutcome: number;
  readonly inProgress: number;
}

export interface UnpairedIntent {
  readonly intentId: string;
  readonly ts: number;
  readonly tool: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly workspaceId: string | null;
  readonly userId: string | null;
}

export interface WriteStats {
  readonly byTool: WriteStatsRow[];
  readonly byChannel: WriteStatsRow[];
  readonly total: WriteStatsRow;
  readonly unpaired: UnpairedIntent[];
}

const detail = (row: AuditEntry, key: string): unknown => row.details?.[key];
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Pairs the rows (any order) and counts the writes. An outcome whose intent is not in `rows` counts as one write. */
export function writeStats(rows: readonly AuditEntry[], now: number): WriteStats {
  const intents = new Map<string, AuditEntry>();
  const outcomes = new Map<string, AuditEntry>();
  const orphans: AuditEntry[] = [];
  for (const r of rows) {
    if (r.kind !== 'write') continue;
    const phase = detail(r, 'phase');
    if (phase === 'intent') intents.set(r.id, r);
    else if (phase === 'outcome') {
      const intentId = text(detail(r, 'intentId'));
      if (intentId === null) orphans.push(r);
      else outcomes.set(intentId, r);
    }
  }
  // An outcome whose intent is outside the window still happened.
  for (const [intentId, r] of outcomes) if (!intents.has(intentId)) orphans.push(r);

  const writes: { row: AuditEntry; state: WriteState }[] = [];
  const unpaired: UnpairedIntent[] = [];
  for (const [id, intent] of intents) {
    const out = outcomes.get(id);
    const state: WriteState =
      out !== undefined
        ? out.status === 'ok'
          ? 'ok'
          : 'error'
        : now - intent.ts < UNPAIRED_GRACE_MS
          ? 'in_progress'
          : 'no_outcome';
    writes.push({ row: intent, state });
    if (state === 'no_outcome') {
      unpaired.push({
        intentId: id,
        ts: intent.ts,
        tool: intent.action,
        targetType: intent.targetType,
        targetId: intent.targetId,
        workspaceId: intent.workspaceId,
        userId: intent.userId,
      });
    }
  }
  for (const r of orphans) writes.push({ row: r, state: r.status === 'ok' ? 'ok' : 'error' });

  const group = (key: (r: AuditEntry) => string): WriteStatsRow[] => {
    const map = new Map<
      string,
      { writes: number; ok: number; error: number; noOutcome: number; inProgress: number }
    >();
    for (const w of writes) {
      const k = key(w.row);
      const g = map.get(k) ?? { writes: 0, ok: 0, error: 0, noOutcome: 0, inProgress: 0 };
      g.writes++;
      if (w.state === 'ok') g.ok++;
      else if (w.state === 'error') g.error++;
      else if (w.state === 'no_outcome') g.noOutcome++;
      else g.inProgress++;
      map.set(k, g);
    }
    return [...map.entries()]
      .map(([k, g]) => ({ key: k, ...g }))
      .sort((a, b) => b.writes - a.writes || (a.key < b.key ? -1 : 1));
  };
  const all = group(() => 'all')[0] ?? {
    key: 'all',
    writes: 0,
    ok: 0,
    error: 0,
    noOutcome: 0,
    inProgress: 0,
  };
  return {
    byTool: group((r) => r.action),
    byChannel: group((r) => text(detail(r, 'approval')) ?? 'unknown'),
    total: all,
    unpaired: unpaired.sort((a, b) => b.ts - a.ts).slice(0, UNPAIRED_LISTED),
  };
}
