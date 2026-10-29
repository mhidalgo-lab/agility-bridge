// SPDX-License-Identifier: Apache-2.0
// What a caller may be told about its write budget (P7-16, THREAT_MODEL T31): its own grant's count for this hour and
// when it resets, read without taking a unit. The deployment's number is never shown to a caller, only that it is spent
// (`deploymentFull`): another grant's use must not be readable from this one (T3). A read that fails is `unknown`.
import type { ToolContext } from '../context.ts';
import type { WriteBudget } from './runtime.ts';

export type CallerWriteBudget =
  | { readonly status: 'unknown' }
  | {
      readonly status: 'ok';
      readonly limit: number;
      readonly used: number;
      readonly remaining: number;
      /** ISO time when the hour ends and the count starts again. */
      readonly resetsAt: string;
      /** The deployment's limit for this hour is used up: a write is refused whatever this grant has left. */
      readonly deploymentFull?: true;
    };

/** The caller's view of a budget. */
export function callerView(budget: WriteBudget): CallerWriteBudget {
  if (budget.status !== 'ok') return { status: 'unknown' };
  return {
    status: 'ok',
    limit: budget.grant.limit,
    used: budget.grant.used,
    remaining: budget.grant.remaining,
    resetsAt: new Date(budget.windowEndsAt).toISOString(),
    ...(budget.deployment !== null && budget.deployment.remaining === 0
      ? { deploymentFull: true as const }
      : {}),
  };
}

/** The caller's own budget, or `undefined` where there is no write runtime or limiter that can say. Never throws. */
export async function callerWriteBudget(ctx: ToolContext): Promise<CallerWriteBudget | undefined> {
  const rt = ctx.writes;
  if (rt === undefined || rt.limiter.budget === undefined) return undefined;
  try {
    return callerView(await rt.limiter.budget({ actor: rt.actor }));
  } catch {
    return { status: 'unknown' };
  }
}
