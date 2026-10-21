// SPDX-License-Identifier: Apache-2.0
// The Node `fetch` for Agility (ADR-0014): verification always on; an on-premises instance with a private CA adds its
// bundle to the public roots through an undici dispatcher, instead of process-wide NODE_EXTRA_CA_CERTS.
import { readFileSync } from 'node:fs';
import { rootCertificates } from 'node:tls';
import { Agent } from 'undici';

export type FetchLike = (request: Request) => Promise<Response>;

export interface NodeFetchOptions {
  /** PEM file with one or more CA certificates (`AB_CA_FILE`). */
  readonly caFile?: string;
}

export function createNodeFetch(options: NodeFetchOptions = {}): FetchLike {
  if (options.caFile === undefined) return (request) => fetch(request);
  const pem = readFileSync(options.caFile, 'utf8');
  if (!pem.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error(`AB_CA_FILE ${options.caFile} holds no PEM certificate.`);
  }
  const dispatcher = new Agent({ connect: { ca: [...rootCertificates, pem] } });
  // Node's fetch is undici and accepts a dispatcher of the same major version (Node 24 bundles undici 7).
  return (request) => fetch(request, { dispatcher } as unknown as RequestInit);
}
