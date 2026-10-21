// SPDX-License-Identifier: Apache-2.0
// Name matching (L-036): an exact match wins; otherwise a unique match after normalisation (NFKC, case folding,
// punctuation and spacing); otherwise candidates ranked by trigram similarity. A fuzzy match is never picked
// automatically: the caller gets AB_AMBIGUOUS with the candidates (enveloped: names are Agility text).
import { AbError, ErrorCode } from '../errors.ts';

export interface Named {
  readonly oid: string;
  readonly name: string;
}

export interface Candidate {
  readonly oid: string;
  readonly name: string;
  /** 0–1; 1 is an exact normalised match. */
  readonly score: number;
}

export function normalizeName(text: string): string {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function trigrams(text: string): Set<string> {
  const s = `  ${normalizeName(text)} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
  return out;
}

export function similarity(a: string, b: string): number {
  const x = trigrams(a);
  const y = trigrams(b);
  if (x.size === 0 || y.size === 0) return 0;
  let common = 0;
  for (const t of x) if (y.has(t)) common++;
  return common / (x.size + y.size - common);
}

export type MatchResult<T extends Named> =
  | { readonly kind: 'match'; readonly item: T }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly Candidate[] }
  | { readonly kind: 'none'; readonly candidates: readonly Candidate[] };

/** Short names score low on trigrams ('Bleu' vs 'Blue' is 0.25), so the bar for showing a candidate is low. */
const MIN_SCORE = 0.2;
const MAX_CANDIDATES = 5;

export function matchName<T extends Named>(text: string, items: readonly T[]): MatchResult<T> {
  const exact = items.filter((i) => i.name === text);
  if (exact.length === 1) return { kind: 'match', item: exact[0] as T };
  const wanted = normalizeName(text);
  const normalized = items.filter((i) => normalizeName(i.name) === wanted);
  if (exact.length === 0 && normalized.length === 1) return { kind: 'match', item: normalized[0] as T };
  if (exact.length > 1 || normalized.length > 1) {
    return {
      kind: 'ambiguous',
      candidates: (exact.length > 1 ? exact : normalized)
        .slice(0, MAX_CANDIDATES)
        .map((i) => ({ oid: i.oid, name: i.name, score: 1 })),
    };
  }
  const ranked = items
    .map((i) => ({ oid: i.oid, name: i.name, score: Math.round(similarity(text, i.name) * 100) / 100 }))
    .filter((c) => c.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.oid.localeCompare(b.oid))
    .slice(0, MAX_CANDIDATES);
  return { kind: 'none', candidates: ranked };
}

/** What a resolver throws when there is no single match. */
export function noSingleMatch(what: string, text: string, result: MatchResult<Named>): AbError {
  const candidates = result.kind === 'match' ? [] : result.candidates;
  if (result.kind === 'ambiguous' || candidates.length > 0) {
    return new AbError(
      ErrorCode.Ambiguous,
      `Several ${what}s match "${text.slice(0, 80)}"; none was chosen.`,
      {
        hint: `Pass one of the candidates' OID tokens as the ${what}.`,
        details: { candidates },
      },
    );
  }
  return new AbError(
    ErrorCode.NotFound,
    `No ${what} named "${text.slice(0, 80)}" was found or is visible with this token.`,
    {
      hint: `Check the spelling, or list the ${what}s first.`,
    },
  );
}
