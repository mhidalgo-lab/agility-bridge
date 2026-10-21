// SPDX-License-Identifier: Apache-2.0
import {
  type AgilityClient,
  agilityClient,
  createBudget,
  type FetchLike,
  Secret,
  type ToolContext,
} from '../../src/index.ts';
import { makeContext } from '../helpers/context.ts';

/** Synthetic token; never a real one. */
export const TOKEN = '1.FAKEtokenFORtestsONLYabcdefghij=';

export type Responder = (req: Request, n: number) => Response | Promise<Response>;

/** A fetch that answers from `responder` and records every request. */
export function fakeFetch(responder: Responder): FetchLike & { calls: Request[] } {
  const calls: Request[] = [];
  const f = (async (req: Request) => {
    calls.push(req);
    return responder(req, calls.length);
  }) as FetchLike & { calls: Request[] };
  f.calls = calls;
  return f;
}

export const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

export interface Setup {
  readonly client: AgilityClient;
  readonly ctx: ToolContext;
  readonly fetch: FetchLike & { calls: Request[] };
  readonly sleeps: number[];
}

export function setup(responder: Responder, over: Partial<ToolContext> = {}): Setup {
  const fetch = fakeFetch(responder);
  const sleeps: number[] = [];
  const ctx = makeContext({
    fetch,
    budget: createBudget(10),
    credential: { id: 'cred-a', kind: 'personal', token: new Secret(TOKEN) },
    ...over,
  });
  const client = agilityClient(ctx, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { client, ctx, fetch, sleeps };
}
