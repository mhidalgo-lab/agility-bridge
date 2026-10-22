// SPDX-License-Identifier: Apache-2.0
// Per-request isolation for Workers (P3-01, L-096): no request awaits I/O another request started. Audit writes are
// detached and handed to the request's `background`, each request gets its own concurrency limiter, and pass-through
// validations are not shared in flight. `process` (Node) keeps the shared behaviour.
import type { CredentialValidator, ValidationResult } from '@agility-bridge/auth';
import { CredentialLimiters, silentLogger, webCryptoRandom } from '@agility-bridge/core';
import { createMemoryStorage, type Storage } from '@agility-bridge/storage';
import { describe, expect, it } from 'vitest';
import { AuditWriter } from '../src/index.ts';
import { post, world } from './helpers/world.ts';

const WHOAMI = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } };

/** Storage whose audit appends wait until released, counting how many have started. */
function blockingAudit(): { storage: Storage; started: () => number; release: () => void } {
  const storage = createMemoryStorage();
  let started = 0;
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const append = storage.audit.append.bind(storage.audit);
  return {
    storage: {
      ...storage,
      audit: {
        ...storage.audit,
        append: async (entry) => {
          started++;
          await gate;
          return append(entry);
        },
      },
    } as Storage,
    started: () => started,
    release: () => release(),
  };
}

const row = { kind: 'admin', action: 'test.row', status: 'ok' } as const;

describe('AuditWriter detached (Workers)', () => {
  it('starts every write at once and returns it; queued mode chains them and returns nothing', async () => {
    for (const detached of [true, false]) {
      const s = blockingAudit();
      const audit = new AuditWriter({
        storage: s.storage,
        logger: silentLogger,
        clock: { now: () => 0 },
        random: webCryptoRandom,
        detached,
      });
      const a = audit.enqueue(row);
      const b = audit.enqueue(row);
      await Promise.resolve();
      expect(s.started(), `detached=${detached}`).toBe(detached ? 2 : 1);
      expect(a instanceof Promise && b instanceof Promise).toBe(detached);
      s.release();
      await audit.flush();
      expect((await s.storage.audit.query({ limit: 10 })).length).toBe(2);
    }
  });
});

describe("isolation: 'request' over HTTP", () => {
  it('hands audit writes to background and never uses the shared limiter', async () => {
    let shared = 0;
    const limiters = new CredentialLimiters();
    const background: Promise<unknown>[] = [];
    const w = await world(
      { isolation: 'request', background: (_c, work) => background.push(work) },
      {
        detachedAudit: true,
        services: {
          limiters: {
            for: (...args: Parameters<CredentialLimiters['for']>) => {
              shared++;
              return limiters.for(...args);
            },
          } as CredentialLimiters,
        },
      },
    );
    const res = await post(w, 'team-a', w.tokens.alice, WHOAMI);
    await res.text();
    expect(res.status).toBe(200);
    expect(shared).toBe(0);
    expect(background.length).toBeGreaterThan(0);
    await Promise.all(background);
    expect((await w.storage.audit.query({ kind: 'tool_call', limit: 10 })).length).toBe(1);

    // The same world in process mode uses the shared limiter.
    shared = 0;
    const node = await world(
      {},
      {
        services: {
          limiters: {
            for: () => {
              shared++;
              return limiters.for('i', 'c');
            },
          } as never,
        },
      },
    );
    await (await post(node, 'team-a', node.tokens.alice, WHOAMI)).text();
    expect(shared).toBe(1);
  });

  it('does not share a pass-through validation in flight between requests', async () => {
    let calls = 0;
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const validator: CredentialValidator = {
      async validate(): Promise<ValidationResult> {
        calls++;
        await gate;
        return {
          status: 'valid',
          memberOid: 'Member:20',
          memberName: 'Ann',
          memberUsername: null,
          reachableScopeIds: [],
        };
      },
      probe: async () => ({ ok: true as const, fingerprint: null }),
    };
    const w = await world({
      isolation: 'request',
      passthrough: { validator, secure: () => true, identityTtlSeconds: 60 },
    });
    await w.storage.workspaces.update(w.ids.workspaceA, { credentialSource: 'passthrough' });
    const headers = { 'x-agility-token': '1.CallerOwnAgilityTokenNotReal0001' };
    const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
    const pending = [1, 2, 3].map(() => post(w, 'team-a', null, LIST, headers));
    await new Promise((r) => setTimeout(r, 20));
    release();
    expect((await Promise.all(pending)).map((r) => r.status)).toEqual([200, 200, 200]);
    expect(calls).toBe(3);
  });
});

describe("isolation: 'request' admin API (P3-14)", () => {
  it('is built on the first admin request, carries the server request id into audit rows, and ignores a client copy', async () => {
    const w = await world(
      { isolation: 'request', background: () => {} },
      { admin: true, detachedAudit: true },
    );
    const res = await w.app.fetch(
      new Request('http://127.0.0.1:8787/api/admin/v1/users', {
        method: 'POST',
        headers: {
          'x-test-actor': 'owner',
          'content-type': 'application/json',
          'x-agility-bridge-internal-request-id': 'chosen-by-client',
        },
        body: JSON.stringify({ email: 'new@example.test', role: 'member' }),
      }),
    );
    expect(res.status).toBe(201);
    const requestId = res.headers.get('x-request-id');
    await w.audit.flush();
    const [row] = await w.storage.audit.query({ kind: 'admin', limit: 5 });
    expect(row?.action).toBe('user.create');
    expect(row?.requestId).toBe(requestId);
    expect(row?.requestId).not.toBe('chosen-by-client');
  });
});
