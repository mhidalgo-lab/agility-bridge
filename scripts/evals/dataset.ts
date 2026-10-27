// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import type { Question } from './score.ts';

/** The committed router/LLM dataset (scripts/evals/dataset.json): invented names and numbers only. */
export function loadDataset(): Question[] {
  return JSON.parse(readFileSync(new URL('./dataset.json', import.meta.url), 'utf8')) as Question[];
}
