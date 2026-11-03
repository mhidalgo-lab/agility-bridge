// SPDX-License-Identifier: Apache-2.0
// A Worker for the Durable Object limiter's tests (P3-12): the real class and client in workerd, a probe handler that
// drives them, and two misbehaving object classes (one that throws, one that never answers) to prove the failure
// policy there. Bundled by the test setup; never deployed.
import { createWriteLimiter, ErrorCode } from '@agility-bridge/core';
import { SharedLimiter, SharedLimiterClient } from '../../src/shared-limiter.ts';

export { SharedLimiter };

export class BrokenLimiter {
  async fetch(): Promise<Response> {
    throw new Error('broken');
  }
}

export class SlowLimiter {
  async fetch(): Promise<Response> {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    return new Response('{"ok":true}');
  }
}

interface Body {
  key: string;
  rate: { limit: number; windowMs: number };
  grant: string;
}

interface Env {
  RL_SHARED: ConstructorParameters<typeof SharedLimiterClient>[0];
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const client = new SharedLimiterClient(env.RL_SHARED, 300);
    const url = new URL(request.url);
    const body = request.method === 'POST' ? ((await request.json()) as Body) : ({} as Body);
    try {
      switch (url.pathname) {
        case '/take':
          return Response.json(await client.take(body.key, body.rate));
        case '/peek':
          return Response.json({ ok: await client.peek(body.key, body.rate) });
        case '/write': {
          // A real write limiter over the object's counters: 2 per grant, 3 per deployment, in the current hour.
          const limiter = createWriteLimiter({
            counters: client,
            clock: { now: () => Date.now() },
            limits: { perGrant: 2, deployment: 3 },
          });
          await limiter.check({
            tool: 'update_status',
            actor: { id: body.grant, grantId: body.grant } as never,
            requestId: 'r',
          });
          return Response.json({ allowed: true });
        }
        default:
          return new Response('not found', { status: 404 });
      }
    } catch (error) {
      const code = (error as { code?: string }).code;
      return Response.json(
        { error: (error as Error).name, code, closed: code === ErrorCode.WriteLimitUnavailable },
        { status: 500 },
      );
    }
  },
};
