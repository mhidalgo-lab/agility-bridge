// SPDX-License-Identifier: Apache-2.0
// Integration test (P1-02): a local HTTPS server signed by a throwaway private CA. Without the bundle the core client
// reports AB_AGILITY_TLS; with AB_CA_FILE it gets the answer.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AbError,
  agilityClient,
  closedBreaker,
  createBudget,
  DEFAULT_LIMITS,
  Secret,
  silentLogger,
  systemClock,
  unboundedLimiter,
  webCryptoRandom,
} from '@agility-bridge/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeFetch } from '../src/agility-fetch.ts';

const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasOpenssl)('createNodeFetch with a private CA', () => {
  let dir = '';
  let server: Server;
  let baseUrl = '';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ab-ca-'));
    const ssl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
    const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
    ssl(
      'req',
      '-x509',
      ...ec,
      '-keyout',
      'ca.key',
      '-out',
      'ca.pem',
      '-days',
      '1',
      '-subj',
      '/CN=agility-bridge test CA',
    );
    ssl('req', ...ec, '-keyout', 'srv.key', '-out', 'srv.csr', '-subj', '/CN=localhost');
    writeFileSync(join(dir, 'ext'), 'subjectAltName=IP:127.0.0.1,DNS:localhost\n');
    ssl(
      'x509',
      '-req',
      '-in',
      'srv.csr',
      '-CA',
      'ca.pem',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-out',
      'srv.pem',
      '-days',
      '1',
      '-extfile',
      'ext',
    );
    server = createServer(
      { key: readFileSync(join(dir, 'srv.key')), cert: readFileSync(join(dir, 'srv.pem')) },
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('[[{"_oid":"Story:1001"}]]');
      },
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}/SyntheticInstance`;
  });

  afterAll(() => {
    server?.close();
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  const query = (fetch: ReturnType<typeof createNodeFetch>) =>
    agilityClient({
      requestId: 'r',
      instance: { id: 'onprem', baseUrl },
      credential: { id: 'c', kind: 'personal', token: new Secret('FAKE-token') },
      projects: { allowed: [], includeChildren: true },
      assetTypes: { deny: [] },
      limits: DEFAULT_LIMITS,
      budget: createBudget(5),
      limiter: unboundedLimiter,
      breaker: closedBreaker,
      fetch,
      logger: silentLogger,
      clock: systemClock,
      random: webCryptoRandom,
    }).query({ from: 'Story', select: ['ID'] });

  it('maps an untrusted private CA to AB_AGILITY_TLS without the bundle', async () => {
    const error = await query(createNodeFetch()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AbError);
    expect((error as AbError).code).toBe('AB_AGILITY_TLS');
  });

  it('trusts the instance with AB_CA_FILE', async () => {
    const r = await query(createNodeFetch({ caFile: join(dir, 'ca.pem') }));
    expect(r.data).toEqual([[{ _oid: 'Story:1001' }]]);
  });

  it('refuses a CA file without a certificate', () => {
    writeFileSync(join(dir, 'empty.pem'), 'nothing here\n');
    expect(() => createNodeFetch({ caFile: join(dir, 'empty.pem') })).toThrow(/no PEM certificate/);
  });
});
