// SPDX-License-Identifier: Apache-2.0
// P9-04: the documentation site is built from docs/ (the source of truth) and nothing is duplicated by hand.
//   node scripts/docs-site.ts check   docs/ relative links and anchors resolve (part of `pnpm lint`)
//   node scripts/docs-site.ts sync    copy the included pages into site/src/content/docs for Starlight
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_URL = 'https://github.com/mhidalgo-lab/agility-bridge';

/** Folders of docs/ that are planning records, not documentation: they stay out of the site (D-361). */
export const EXCLUDED_DIRS = ['tasks', 'pending-decisions'];
/** Files that are templates, never pages. */
const EXCLUDED_FILES = new Set(['tasks/_template.md']);

/** GitHub-style heading slug (what GitHub and Starlight both generate), without the duplicate suffix. */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Lines of a markdown document outside fenced code blocks, with their 1-based line numbers. */
function proseLines(md: string): { n: number; text: string }[] {
  const out: { n: number; text: string }[] = [];
  let fence: string | undefined;
  md.split('\n').forEach((text, i) => {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(text);
    if (m) {
      const marker = m[1] ?? '';
      if (!fence) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
      return;
    }
    if (!fence) out.push({ n: i + 1, text });
  });
  return out;
}

/** Plain text of a heading: inline markup and links reduced to their text. */
function headingText(raw: string): string {
  return raw
    .replace(/\s+#+\s*$/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[<>]/g, '')
    .replace(/[`*]/g, '')
    .replace(/\\(.)/g, '$1');
}

/** Anchors a document offers: every heading slug (duplicates get -1, -2, ...) and explicit ids. */
export function anchorsOf(md: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const { text } of proseLines(md)) {
    const h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(text);
    if (h) {
      const base = slugify(headingText(h[1] ?? ''));
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      out.add(count === 0 ? base : `${base}-${count}`);
    }
    for (const id of text.matchAll(/\bid="([^"]+)"/g)) out.add(id[1] ?? '');
  }
  return out;
}

export interface Link {
  line: number;
  href: string;
}

/** The document with fenced code blocks and inline code blanked out (same length, newlines kept). */
function maskCode(md: string): string {
  const blank = (t: string) => t.replace(/[^\n]/g, ' ');
  const kept = new Set(proseLines(md).map((l) => l.n));
  const lines = md.split('\n').map((t, i) => (kept.has(i + 1) ? t : blank(t)));
  return lines.join('\n').replace(/`[^`\n]*`/g, blank);
}

export interface LinkSpan extends Link {
  /** Offsets of the href inside the document. */
  start: number;
  end: number;
}

const INLINE_LINK = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const LINK_DEFINITION = /^[ ]{0,3}\[[^\]]+\]:[ ]*(\S+)/gm;

/** Inline links, images and link definitions (also when the link text spans lines), outside code. */
export function linkSpans(md: string): LinkSpan[] {
  const masked = maskCode(md);
  const out: LinkSpan[] = [];
  for (const m of [...masked.matchAll(INLINE_LINK), ...masked.matchAll(LINK_DEFINITION)]) {
    const href = m[1] ?? '';
    const start = (m.index ?? 0) + m[0].lastIndexOf(href);
    out.push({ href, start, end: start + href.length, line: md.slice(0, start).split('\n').length });
  }
  return out.sort((x, y) => x.start - y.start);
}

export function linksOf(md: string): Link[] {
  return linkSpans(md).map(({ line, href }) => ({ line, href }));
}

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

export interface Resolved {
  /** Repo-relative path of the target (posix), when the link is relative. */
  target: string;
  hash: string;
}

/** Resolves a relative link found in `fromFile` (repo-relative); undefined for external, absolute or empty links. */
export function resolveLink(fromFile: string, href: string): Resolved | undefined {
  if (EXTERNAL.test(href) || href.startsWith('/')) return undefined;
  const [pathPart = '', ...rest] = href.split('#');
  const hash = rest.join('#');
  const noQuery = (pathPart.split('?')[0] ?? '').replace(/%20/g, ' ');
  const target = noQuery === '' ? fromFile : posix.normalize(posix.join(posix.dirname(fromFile), noQuery));
  return { target, hash };
}

export interface Problem {
  file: string;
  line: number;
  message: string;
}

/** Markdown files of a folder, recursively, as paths relative to `root` (posix). */
function walk(root: string, dir = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, dir)).sort()) {
    const rel = dir ? `${dir}/${name}` : name;
    if (statSync(join(root, rel)).isDirectory()) out.push(...walk(root, rel));
    else if (name.endsWith('.md')) out.push(rel);
  }
  return out;
}

/** Every relative link of every file under docs/ must reach an existing file or folder, and its anchor must exist. */
export function checkDocLinks(root: string): Problem[] {
  const problems: Problem[] = [];
  const anchorCache = new Map<string, Set<string>>();
  const anchors = (repoPath: string): Set<string> => {
    let set = anchorCache.get(repoPath);
    if (!set) {
      set = anchorsOf(readFileSync(join(root, repoPath), 'utf8'));
      anchorCache.set(repoPath, set);
    }
    return set;
  };
  for (const file of walk(join(root, 'docs')).map((f) => `docs/${f}`)) {
    if (EXCLUDED_FILES.has(file.slice('docs/'.length))) continue;
    for (const { line, href } of linksOf(readFileSync(join(root, file), 'utf8'))) {
      const r = resolveLink(file, href);
      if (!r) continue;
      if (r.target.startsWith('..') || !existsSync(join(root, r.target))) {
        problems.push({ file, line, message: `broken link "${href}" (no file ${r.target})` });
        continue;
      }
      if (r.hash && r.target.endsWith('.md') && !anchors(r.target).has(decodeURIComponent(r.hash))) {
        problems.push({
          file,
          line,
          message: `broken anchor "${href}" (no heading #${r.hash} in ${r.target})`,
        });
      }
    }
  }
  return problems;
}

/** Is this docs-relative markdown path a page of the site? */
export function isPage(docPath: string): boolean {
  if (!docPath.endsWith('.md') || EXCLUDED_FILES.has(docPath)) return false;
  return !EXCLUDED_DIRS.some((d) => docPath.startsWith(`${d}/`));
}

/** The page slug (URL path without slashes at the ends) of a docs-relative markdown path. */
export function slugOf(docPath: string): string {
  const noExt = docPath.replace(/\.md$/, '');
  const parts = noExt.split('/').map((p) => p.toLowerCase());
  if (parts[parts.length - 1] === 'readme') parts.pop();
  return parts.join('/');
}

/** Site URL of a page slug, with the base path of the deployment (the link validator needs absolute links). */
export function pageUrl(base: string, slug: string): string {
  return slug === '' ? `${base}/` : `${base}/${slug}/`;
}

/** The href to use in the site for a link found in docs page `docPath`. */
export function rewriteHref(docPath: string, href: string, root: string, base: string): string {
  const from = `docs/${docPath}`;
  const r = resolveLink(from, href);
  if (!r) return href;
  const hash = r.hash ? `#${r.hash}` : '';
  if (r.target.startsWith('docs/') && isPage(r.target.slice('docs/'.length))) {
    return `${pageUrl(base, slugOf(r.target.slice('docs/'.length)))}${hash}`;
  }
  const isDir = existsSync(join(root, r.target)) && statSync(join(root, r.target)).isDirectory();
  return `${REPO_URL}/${isDir ? 'tree' : 'blob'}/main/${r.target}${hash}`;
}

/** Rewrites every link of a page (outside code) and returns the markdown. */
export function rewriteLinks(docPath: string, md: string, root: string, base: string): string {
  let out = '';
  let at = 0;
  for (const span of linkSpans(md)) {
    out += md.slice(at, span.start) + rewriteHref(docPath, span.href, root, base);
    at = span.end;
  }
  return out + md.slice(at);
}

/** Starlight needs a title in the front matter: take the first H1, drop it from the body, add the edit link. */
export function toPage(docPath: string, md: string, root: string, base: string): string {
  const lines = md.split('\n');
  const h1 = proseLines(md).find((l) => /^#\s+\S/.test(l.text));
  if (!h1) throw new Error(`docs/${docPath}: no top-level heading to use as the page title`);
  const title = headingText(h1.text.replace(/^#\s+/, ''));
  lines.splice(h1.n - 1, 1);
  const front = [
    '---',
    `title: ${JSON.stringify(title)}`,
    `editUrl: ${REPO_URL}/edit/main/docs/${docPath}`,
    '---',
    '',
  ].join('\n');
  return front + rewriteLinks(docPath, lines.join('\n'), root, base);
}

/** Copies the included pages of docs/ and the landing page into `outDir` (replacing its content); links carry `base`, the deployment base path without a trailing slash. */
export function sync(root: string, outDir: string, base: string): string[] {
  rmSync(outDir, { recursive: true, force: true });
  const written: string[] = [];
  for (const docPath of walk(join(root, 'docs')).filter(isPage)) {
    const slug = slugOf(docPath);
    const dest = join(outDir, docPath.toLowerCase().replace(/readme\.md$/, 'index.md'));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, toPage(docPath, readFileSync(join(root, 'docs', docPath), 'utf8'), root, base));
    written.push(dest);
    if (slug === '') throw new Error('docs/README.md would replace the landing page');
  }
  const landing = join(outDir, 'index.md');
  mkdirSync(outDir, { recursive: true });
  // The landing page is written with site-absolute links (`/guide/...`); they get the base path here.
  writeFileSync(
    landing,
    readFileSync(join(root, 'site/landing.md'), 'utf8').replace(/\]\(\//g, `](${base}/`),
  );
  written.push(landing);
  return written;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const command = process.argv[2];
  if (command === 'check') {
    const problems = checkDocLinks(root);
    for (const p of problems) console.error(`✗ ${p.file}:${p.line}: ${p.message}`);
    if (problems.length === 0) console.log('docs links: ok');
    process.exit(problems.length === 0 ? 0 : 1);
  } else if (command === 'sync') {
    const written = sync(
      root,
      join(root, 'site/src/content/docs'),
      process.env['DOCS_BASE'] || '/agility-bridge',
    );
    console.log(`site content: ${written.length} pages from docs/`);
  } else {
    console.error('usage: node scripts/docs-site.ts check|sync');
    process.exit(2);
  }
}
