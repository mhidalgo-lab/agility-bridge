// SPDX-License-Identifier: Apache-2.0
// Task tooling for docs/tasks (ADR-0001, P0-05). Run: `pnpm tasks <list|next|lint|graph|index>`.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const STATUSES = ['todo', 'in-progress', 'blocked', 'review', 'done', 'dropped'] as const;
export const PRIORITIES = ['high', 'medium', 'low'] as const;
export type Status = (typeof STATUSES)[number];
export type Priority = (typeof PRIORITIES)[number];

export interface Task {
  id: string;
  title: string;
  phase: number;
  status: Status;
  priority: Priority;
  dependsOn: string[];
  adr: string[];
  lessons: string[];
  /** Path relative to the repository root, with forward slashes. */
  file: string;
}

/** What the referenced ids are checked against. */
export interface References {
  adrs: Set<string>;
  lessons: Set<string>;
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// Two digits per phase, three once a phase passes 99 tasks.
const ID_RE = /^P(\d)-(\d{2,3})$/;
const ADR_RE = /^\d{4}$/;
const LESSON_RE = /^L-\d{3}$/;
const toPosix = (p: string): string => p.split('\\').join('/');

export function parseTask(file: string, content: string): { task?: Task; errors: string[] } {
  const errors: string[] = [];
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!m?.[1]) return { errors: [`${file}: missing front matter`] };
  let fm: Record<string, unknown>;
  try {
    fm = parse(m[1]) as Record<string, unknown>;
  } catch (e) {
    return { errors: [`${file}: invalid YAML front matter (${(e as Error).message})`] };
  }
  const id = String(fm['id'] ?? '');
  const idMatch = ID_RE.exec(id);
  if (!idMatch) errors.push(`${file}: invalid id "${id}"`);
  if (typeof fm['title'] !== 'string' || fm['title'].length === 0) errors.push(`${file}: missing title`);
  if (!STATUSES.includes(fm['status'] as Status))
    errors.push(`${file}: invalid status "${String(fm['status'])}"`);
  if (!PRIORITIES.includes(fm['priority'] as Priority)) {
    errors.push(`${file}: invalid priority "${String(fm['priority'])}"`);
  }
  if (idMatch && Number(fm['phase']) !== Number(idMatch[1])) errors.push(`${file}: phase does not match id`);
  const folder = basename(dirname(file));
  const folderPhase = /^phase-(\d)-/.exec(folder)?.[1];
  if (folderPhase === undefined || Number(folderPhase) !== Number(fm['phase'])) {
    errors.push(`${file}: folder "${folder}" does not match phase ${String(fm['phase'])}`);
  }
  if (!basename(file).startsWith(`${id}-`)) errors.push(`${file}: file name must start with "${id}-"`);
  const lists: Record<string, string[]> = {};
  for (const key of ['depends_on', 'adr', 'lessons']) {
    const value = fm[key] ?? [];
    if (!Array.isArray(value)) errors.push(`${file}: ${key} must be a list`);
    else lists[key] = value.map(String);
  }
  for (const a of lists['adr'] ?? []) if (!ADR_RE.test(a)) errors.push(`${file}: invalid ADR id "${a}"`);
  for (const l of lists['lessons'] ?? [])
    if (!LESSON_RE.test(l)) errors.push(`${file}: invalid lesson id "${l}"`);
  if (errors.length > 0) return { errors };
  return {
    errors,
    task: {
      id,
      title: String(fm['title']),
      phase: Number(fm['phase']),
      status: fm['status'] as Status,
      priority: fm['priority'] as Priority,
      dependsOn: lists['depends_on'] ?? [],
      adr: lists['adr'] ?? [],
      lessons: lists['lessons'] ?? [],
      file,
    },
  };
}

export function loadTasks(root: string = ROOT): { tasks: Task[]; errors: string[] } {
  const dir = join(root, 'docs', 'tasks');
  const tasks: Task[] = [];
  const errors: string[] = [];
  for (const phaseDir of readdirSync(dir, { withFileTypes: true })) {
    if (!phaseDir.isDirectory() || !phaseDir.name.startsWith('phase-')) continue;
    for (const f of readdirSync(join(dir, phaseDir.name))) {
      if (!f.endsWith('.md')) continue;
      const path = join(dir, phaseDir.name, f);
      const r = parseTask(toPosix(relative(root, path)), readFileSync(path, 'utf8'));
      errors.push(...r.errors);
      if (r.task) tasks.push(r.task);
    }
  }
  tasks.sort(compareTasks);
  return { tasks, errors };
}

/** ADR numbers from `docs/adr/NNNN-*.md` and lesson ids from `**L-NNN — …**` headings in LESSONS-LEARNED.md. */
export function loadReferences(root: string = ROOT): References {
  const adrs = new Set<string>();
  const adrDir = join(root, 'docs', 'adr');
  if (existsSync(adrDir)) {
    for (const f of readdirSync(adrDir)) {
      const m = /^(\d{4})-.+\.md$/.exec(f);
      if (m?.[1]) adrs.add(m[1]);
    }
  }
  const lessons = new Set<string>();
  const lessonsFile = join(root, 'docs', 'LESSONS-LEARNED.md');
  if (existsSync(lessonsFile)) {
    for (const m of readFileSync(lessonsFile, 'utf8').matchAll(/^\*\*(L-\d{3}) — /gm))
      if (m[1]) lessons.add(m[1]);
  }
  return { adrs, lessons };
}

const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

export function compareTasks(a: Task, b: Task): number {
  return a.id.localeCompare(b.id, 'en', { numeric: true });
}

export function validate(tasks: Task[], refs: References): string[] {
  const errors: string[] = [];
  const byId = new Map<string, Task>();
  for (const t of tasks) {
    if (byId.has(t.id)) errors.push(`duplicate id ${t.id} (${t.file})`);
    byId.set(t.id, t);
  }
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (d === t.id) errors.push(`${t.id}: depends on itself`);
      else if (!byId.has(d)) errors.push(`${t.id}: unknown dependency ${d}`);
    }
    for (const a of t.adr)
      if (!refs.adrs.has(a)) errors.push(`${t.id}: unknown ADR ${a} (no docs/adr/${a}-*.md)`);
    for (const l of t.lessons) {
      if (!refs.lessons.has(l)) errors.push(`${t.id}: unknown lesson ${l} (not in docs/LESSONS-LEARNED.md)`);
    }
  }
  // Cycle detection (depth-first search with three colours); each cycle is reported once.
  const color = new Map<string, 0 | 1 | 2>();
  const visit = (id: string, stack: string[]): void => {
    const c = color.get(id) ?? 0;
    if (c === 2) return;
    if (c === 1) {
      errors.push(`dependency cycle: ${[...stack.slice(stack.indexOf(id)), id].join(' -> ')}`);
      return;
    }
    color.set(id, 1);
    for (const d of byId.get(id)?.dependsOn ?? []) if (byId.has(d) && d !== id) visit(d, [...stack, id]);
    color.set(id, 2);
  };
  for (const t of tasks) visit(t.id, []);
  return errors;
}

/** Tasks that are `todo` and whose dependencies are all `done` (or `dropped`), lowest phase and highest priority first. */
export function nextTasks(tasks: Task[]): Task[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const isSatisfied = (id: string): boolean => {
    const s = byId.get(id)?.status;
    return s === 'done' || s === 'dropped';
  };
  return tasks
    .filter((t) => t.status === 'todo' && t.dependsOn.every(isSatisfied))
    .sort(
      (a, b) =>
        a.phase - b.phase || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || compareTasks(a, b),
    );
}

export function renderIndex(tasks: Task[]): string {
  const rows: string[] = [];
  let phase = -1;
  for (const t of tasks) {
    if (t.phase !== phase) {
      phase = t.phase;
      rows.push(
        `\n### Phase ${phase}\n\n| ID | Task | Priority | Depends on | Status |\n|---|---|---|---|---|`,
      );
    }
    const link = t.file.replace(/^docs\//, '');
    rows.push(
      `| ${t.id} | [${t.title}](${link}) | ${t.priority} | ${t.dependsOn.join(', ') || '—'} | ${t.status} |`,
    );
  }
  return rows.join('\n');
}

export function replaceIndex(roadmap: string, index: string): string {
  const re = /<!-- tasks:start -->[\s\S]*<!-- tasks:end -->/;
  if (!re.test(roadmap))
    throw new Error('ROADMAP.md is missing <!-- tasks:start --> / <!-- tasks:end --> markers');
  return roadmap.replace(re, `<!-- tasks:start -->${index}\n<!-- tasks:end -->`);
}

export function renderGraph(tasks: Task[]): string {
  const node = (id: string): string => id.replace('-', '_');
  const lines = ['flowchart TD'];
  for (const t of tasks) {
    lines.push(`  ${node(t.id)}["${t.id} ${t.title.replaceAll('"', "'")}"]`);
    for (const d of t.dependsOn) lines.push(`  ${node(d)} --> ${node(t.id)}`);
  }
  return lines.join('\n');
}

function table(tasks: Task[]): string {
  const w = Math.max(5, ...tasks.map((t) => t.status.length));
  return tasks.map((t) => `${t.id}  ${t.status.padEnd(w)}  ${t.priority.padEnd(6)}  ${t.title}`).join('\n');
}

export function main(argv: string[], root: string = ROOT): number {
  const [cmd = 'list', ...rest] = argv;
  const { tasks, errors: parseErrors } = loadTasks(root);
  const roadmapPath = join(root, 'docs', 'ROADMAP.md');
  const opt = (name: string): string | undefined => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  switch (cmd) {
    case 'list': {
      const phase = opt('phase');
      const status = opt('status');
      const filtered = tasks.filter(
        (t) =>
          (phase === undefined || t.phase === Number(phase)) && (status === undefined || t.status === status),
      );
      console.log(table(filtered));
      return 0;
    }
    case 'next': {
      const next = nextTasks(tasks);
      if (next.length === 0) {
        console.log('No unblocked todo tasks.');
        return 0;
      }
      console.log(table(rest.includes('--all') ? next : next.slice(0, 1)));
      return 0;
    }
    case 'lint': {
      const errors = [...parseErrors, ...validate(tasks, loadReferences(root))];
      const roadmap = readFileSync(roadmapPath, 'utf8');
      if (replaceIndex(roadmap, renderIndex(tasks)) !== roadmap) {
        errors.push('docs/ROADMAP.md task index is stale — run `pnpm tasks index`');
      }
      for (const e of errors) console.error(`✗ ${e}`);
      if (errors.length === 0) console.log(`✓ ${tasks.length} tasks valid`);
      return errors.length === 0 ? 0 : 1;
    }
    case 'graph':
      console.log(renderGraph(tasks));
      return 0;
    case 'index': {
      writeFileSync(roadmapPath, replaceIndex(readFileSync(roadmapPath, 'utf8'), renderIndex(tasks)));
      console.log(`Updated docs/ROADMAP.md (${tasks.length} tasks)`);
      return 0;
    }
    default:
      console.error(
        'Usage: pnpm tasks <list [--phase N] [--status S] | next [--all] | lint | graph | index>',
      );
      return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
