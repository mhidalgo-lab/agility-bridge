// SPDX-License-Identifier: Apache-2.0
// P6-10: the dataset shape, its validation and the router score (top-1 and top-3 accuracy).
import { type CatalogueKind, type ListedTool, listedTools } from './catalogue.ts';
import { buildRouter } from './router.ts';

export interface Question {
  readonly id: string;
  readonly category: string;
  readonly question: string;
  /** Tools that are an acceptable first choice. */
  readonly expect: readonly string[];
  /** `full` when an expected tool is in an opt-in group (the question is scored against the full catalogue). */
  readonly catalogue: CatalogueKind;
}

export interface Miss {
  readonly id: string;
  readonly question: string;
  readonly expect: readonly string[];
  readonly top3: readonly string[];
}

export interface RouterScore {
  readonly total: number;
  readonly top1: number;
  readonly top3: number;
  /** Questions whose expected tool is not even in the top three. */
  readonly misses: readonly Miss[];
  /** Questions whose first choice was not an expected tool. */
  readonly wrongFirst: readonly Miss[];
  readonly byCategory: Readonly<Record<string, { total: number; top1: number }>>;
}

/** Problems with the dataset itself (unknown tool, duplicate id, wrong catalogue). */
export function validateDataset(questions: readonly Question[], full: readonly ListedTool[]): string[] {
  const problems: string[] = [];
  const names = new Set(full.map((t) => t.name));
  const defaults = new Set(listedTools('default').map((t) => t.name));
  const ids = new Set<string>();
  for (const q of questions) {
    if (ids.has(q.id)) problems.push(`${q.id}: duplicate id`);
    ids.add(q.id);
    if (q.expect.length === 0) problems.push(`${q.id}: no expected tool`);
    for (const t of q.expect) {
      if (!names.has(t)) problems.push(`${q.id}: unknown tool ${t}`);
      else if (q.catalogue === 'default' && !defaults.has(t))
        problems.push(`${q.id}: ${t} is opt-in, use "full"`);
    }
    if (q.catalogue === 'full' && q.expect.every((t) => defaults.has(t)))
      problems.push(`${q.id}: marked full but every expected tool is in the default catalogue`);
  }
  return problems;
}

export function scoreRouter(questions: readonly Question[]): RouterScore {
  const routers = {
    default: buildRouter(listedTools('default')),
    full: buildRouter(listedTools('full')),
  };
  let top1 = 0;
  let top3 = 0;
  const misses: Miss[] = [];
  const wrongFirst: Miss[] = [];
  const byCategory: Record<string, { total: number; top1: number }> = {};
  for (const q of questions) {
    const ranked = routers[q.catalogue].rank(q.question).map((r) => r.name);
    const first = ranked[0] as string;
    const top = ranked.slice(0, 3);
    const hit1 = q.expect.includes(first);
    const hit3 = top.some((n) => q.expect.includes(n));
    if (hit1) top1++;
    else wrongFirst.push({ id: q.id, question: q.question, expect: q.expect, top3: top });
    if (hit3) top3++;
    else misses.push({ id: q.id, question: q.question, expect: q.expect, top3: top });
    const c = byCategory[q.category] ?? { total: 0, top1: 0 };
    byCategory[q.category] = c;
    c.total++;
    if (hit1) c.top1++;
  }
  const n = Math.max(1, questions.length);
  return { total: questions.length, top1: top1 / n, top3: top3 / n, misses, wrongFirst, byCategory };
}
