// SPDX-License-Identifier: Apache-2.0
// P6-10 (L-124): a lexical router. BM25 over each tool's name and description, with no synonyms and no network: it
// approximates "does the text of the catalogue contain the words a person uses", so a regression in a description
// shows up in CI. It is a floor, not a model of an agent; the LLM eval is the real check.
import type { ListedTool } from './catalogue.ts';

const STOP = new Set(
  `a an and are as at be by do does for from has have how i in is it its me my of on or our that the their them there
these this to up us was we were what when where which who whom why will with would you your can could should show tell
give get please about any all each been being into than then so if not no`.split(/\s+/),
);

/** Light stemmer: enough to match plural and -ing/-ed forms without a dictionary. */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  return w;
}

const ASSET_NUMBER_RE = /\b(?:[A-Z]{1,2}-\d{3,}|[A-Za-z]+:\d+)\b/g;

/** Lower-cased, stemmed words without stop words; asset numbers (B-01234, Story:1234) become the word `number`. */
export function tokenize(text: string): string[] {
  return text
    .replace(ASSET_NUMBER_RE, ' number ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
}

const K1 = 1.2;
const B = 0.75;
/** The tool name counts this many times in its document. */
const NAME_WEIGHT = 3;

export interface Ranked {
  readonly name: string;
  readonly score: number;
}

export interface Router {
  rank(question: string): Ranked[];
}

export function buildRouter(tools: readonly ListedTool[]): Router {
  const docs = tools.map((t) => {
    const nameWords = tokenize(t.name.replaceAll('_', ' '));
    const words = [
      ...Array.from({ length: NAME_WEIGHT }, () => nameWords).flat(),
      ...tokenize(t.description),
    ];
    const tf = new Map<string, number>();
    for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
    return { name: t.name, tf, length: words.length };
  });
  const avg = docs.reduce((n, d) => n + d.length, 0) / Math.max(1, docs.length);
  const df = new Map<string, number>();
  for (const d of docs) for (const w of d.tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  const idf = (w: string): number => {
    const n = df.get(w) ?? 0;
    return Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
  };
  return {
    rank(question) {
      const q = [...new Set(tokenize(question))];
      return docs
        .map((d) => {
          let score = 0;
          for (const w of q) {
            const f = d.tf.get(w) ?? 0;
            if (f === 0) continue;
            score += (idf(w) * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * d.length) / avg));
          }
          return { name: d.name, score };
        })
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    },
  };
}
