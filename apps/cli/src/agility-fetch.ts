// SPDX-License-Identifier: Apache-2.0
// The Node `fetch` for Agility (ADR-0014): verification always on; an on-premises instance with a private CA adds its
// bundle to the public roots through an undici dispatcher, instead of process-wide NODE_EXTRA_CA_CERTS. Optionally
// (`AB_INSTANCE_PRIVATE_ADDRESSES=refuse`, P2-19) only public addresses are reached, checked at connect time too.
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { readFileSync } from 'node:fs';
import { rootCertificates } from 'node:tls';
import { addressClass } from '@agility-bridge/core';
import { Agent } from 'undici';

export type FetchLike = (request: Request) => Promise<Response>;

export interface NodeFetchOptions {
  /** PEM file with one or more CA certificates (`AB_CA_FILE`). */
  readonly caFile?: string;
  /** Refuse loopback, private, link-local (metadata) and reserved addresses, at every connection (P2-19). */
  readonly publicOnly?: boolean;
}

/** Thrown for an instance host that is not a public address; the message names the host, never a token. */
export class PrivateAddressError extends Error {
  override name = 'PrivateAddressError';
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/** `dns.lookup` that fails when any address of the name is not public (so a rebinding answer is refused too). */
export function publicOnlyLookup(
  hostname: string,
  options: { all?: boolean; family?: number | string },
  callback: LookupCallback,
): void {
  dnsLookup(
    hostname,
    { ...options, all: true } as never,
    ((error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => {
      if (error !== null) return callback(error, []);
      const bad = addresses.find((a) => addressClass(a.address) !== 'public');
      if (bad !== undefined || addresses.length === 0) {
        return callback(
          Object.assign(new PrivateAddressError(`${hostname} resolves to a non-public address.`), {
            code: 'EACCES',
          }),
          [],
        );
      }
      if (options.all === true) return callback(null, addresses);
      const first = addresses[0] as LookupAddress;
      callback(null, first.address, first.family);
    }) as never,
  );
}

/** Refuses a host that is, or resolves to, a non-public address (instance create and retarget, P2-19). */
export async function checkPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, '');
  const literal = addressClass(host);
  if (literal !== 'invalid') {
    if (literal !== 'public') throw new PrivateAddressError(`${hostname} is a ${literal} address.`);
    return;
  }
  await new Promise<void>((resolve, reject) =>
    publicOnlyLookup(host, { all: true }, (error) => (error === null ? resolve() : reject(error))),
  );
}

export function createNodeFetch(options: NodeFetchOptions = {}): FetchLike {
  if (options.caFile === undefined && options.publicOnly !== true) return (request) => fetch(request);
  let ca: string[] | undefined;
  if (options.caFile !== undefined) {
    const pem = readFileSync(options.caFile, 'utf8');
    if (!pem.includes('-----BEGIN CERTIFICATE-----')) {
      throw new Error(`AB_CA_FILE ${options.caFile} holds no PEM certificate.`);
    }
    ca = [...rootCertificates, pem];
  }
  const dispatcher = new Agent({
    connect: {
      ...(ca === undefined ? {} : { ca }),
      ...(options.publicOnly === true ? { lookup: publicOnlyLookup as never } : {}),
    },
  });
  const send = (request: Request) => fetch(request, { dispatcher } as unknown as RequestInit);
  if (options.publicOnly !== true) return send;
  // An address literal never reaches the DNS lookup: check it here (also for instances added before the setting).
  return async (request) => {
    const host = new URL(request.url).hostname.replace(/^\[|\]$/g, '');
    const kind = addressClass(host);
    if (kind !== 'invalid' && kind !== 'public')
      throw new PrivateAddressError(`${host} is a ${kind} address.`);
    return send(request);
  };
}
