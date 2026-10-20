// SPDX-License-Identifier: Apache-2.0
// P0-09: compares node:sqlite with local D1, and AES-256-GCM + HKDF envelopes across Node and workerd.
// Needs the local Worker: `pnpm worker` (port 8790). Usage: tsx src/portability.ts
import { DatabaseSync } from 'node:sqlite';
import { deriveKey, open, seal, TEST_MASTER_KEY } from './hotpath.ts';
import { errorKind, SCHEMA, STEPS } from './storage.ts';

const BASE = process.env['WORKER_URL'] ?? 'http://127.0.0.1:8790';

function sqlite(): Record<string, unknown> {
  const db = new DatabaseSync(':memory:');
  // D1 enforces foreign keys; SQLite needs the pragma per connection (ADR-0006).
  db.exec('PRAGMA foreign_keys = ON');
  for (const s of SCHEMA) db.exec(s);
  const out: Record<string, unknown> = {};
  for (const step of STEPS) {
    try {
      const stmt = db.prepare(step.sql);
      out[step.name] =
        step.mode === 'all'
          ? stmt.all(...step.params).map((r) => ({ ...r }))
          : { changes: Number(stmt.run(...step.params).changes) };
    } catch (e) {
      out[step.name] = { error: errorKind((e as Error).message) };
    }
  }
  db.close();
  return out;
}

const d1 = (await (await fetch(`${BASE}/d1`)).json()) as Record<string, unknown>;
const node = sqlite();
let same = 0;
console.log('| Step | node:sqlite | D1 (local) | Same |');
console.log('|---|---|---|---|');
for (const step of STEPS) {
  const a = JSON.stringify(node[step.name]);
  const b = JSON.stringify(d1[step.name]);
  if (a === b) same++;
  console.log(`| ${step.name} | \`${a}\` | \`${b}\` | ${a === b ? '✅' : '❌'} |`);
}
console.log(`\nStorage: ${same}/${STEPS.length} steps identical`);

const key = await deriveKey(TEST_MASTER_KEY, 'credentials');
const fromNode = await seal(key, 'synthetic-agility-token', 'credential:c1|v1');
const opened = (await (
  await fetch(`${BASE}/crypto/open?${new URLSearchParams({ sealed: fromNode, aad: 'credential:c1|v1' })}`)
).json()) as { text?: string };
const tampered = (await (
  await fetch(`${BASE}/crypto/open?${new URLSearchParams({ sealed: fromNode, aad: 'credential:c2|v1' })}`)
).json()) as { error?: string };
const { sealed: fromWorker } = (await (
  await fetch(
    `${BASE}/crypto/seal?${new URLSearchParams({ text: 'synthetic-agility-token', aad: 'credential:c1|v1' })}`,
  )
).json()) as { sealed: string };
const back = await open(key, fromWorker, 'credential:c1|v1');
console.log(
  `Crypto: Node → workerd ${opened.text === 'synthetic-agility-token' ? '✅' : '❌'}; workerd → Node ${back === 'synthetic-agility-token' ? '✅' : '❌'}; wrong AAD refused on workerd: ${tampered.error ?? 'NOT REFUSED'}`,
);
