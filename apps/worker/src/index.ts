// SPDX-License-Identifier: Apache-2.0
// agility-bridge on Cloudflare Workers (P3-01, deployment mode D): the same HTTP app as `agility-bridge serve`, on D1.
import { VERSION } from '@agility-bridge/core';
import { createEdge } from '@agility-bridge/http-app';
import { type Booted, boot, type WorkerEnv } from './boot.ts';
import { runScheduled } from './scheduled.ts';

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

/** HTTPS public URL from the raw variable, for HSTS on boot failures even when other settings are broken (L-083). */
function publicUrlOf(env: WorkerEnv): string | undefined {
  const raw = env['AB_PUBLIC_URL'];
  if (typeof raw !== 'string') return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

/** 503 with the security headers and no detail: the cause goes to the Workers log only. */
function bootFailure(env: WorkerEnv, error: unknown): Response {
  const publicUrl = publicUrlOf(env);
  const { securityHeaders } = createEdge(publicUrl === undefined ? {} : { publicUrl });
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'boot failed',
      mode: 'worker',
      error: (error as Error)?.name ?? 'Error',
      // Messages of the settings, secrets and storage errors name the setting, never its value.
      reason: String((error as Error)?.message ?? '').slice(0, 300),
    }),
  );
  return new Response(JSON.stringify({ error: 'temporarily unavailable' }), {
    status: 503,
    headers: { ...securityHeaders, 'content-type': 'application/json', 'retry-after': '30' },
  });
}

/**
 * The Worker's `fetch`. Only a completed boot is kept (L-096): a request without one boots on its own, never awaiting
 * a boot another request started, and a failed boot is not kept, so the next request tries again.
 */
export function createWorker(bootWorker: (env: WorkerEnv) => Promise<Booted>) {
  let booted: Booted | undefined;
  return {
    /** The cron trigger (P3-08): housekeeping in bounded slices, kept alive with waitUntil. */
    async scheduled(
      controller: { scheduledTime: number },
      env: WorkerEnv,
      ctx: ExecutionContext,
    ): Promise<void> {
      let current = booted;
      if (current === undefined) {
        current = await bootWorker(env);
        booted = current;
      }
      ctx.waitUntil(runScheduled(current.jobs, controller.scheduledTime, crypto.randomUUID()));
    },
    async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
      let current = booted;
      if (current === undefined) {
        try {
          current = await bootWorker(env);
        } catch (error) {
          return bootFailure(env, error);
        }
        booted = current;
      }
      return current.app.fetch(request, env, ctx);
    },
  };
}

export default createWorker((env) => boot(env, VERSION));
