// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadReferences,
  loadTasks,
  main,
  nextTasks,
  parseTask,
  type References,
  renderIndex,
  replaceIndex,
  type Task,
  validate,
} from '../tasks.ts';

const REFS: References = { adrs: new Set(['0001', '0004']), lessons: new Set(['L-001', 'L-006']) };

const task = (id: string, status: Task['status'], over: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  phase: Number(id[1]),
  status,
  priority: 'high',
  dependsOn: [],
  adr: [],
  lessons: [],
  file: `docs/tasks/phase-${id[1]}-x/${id}-x.md`,
  ...over,
});

const fm = (body: string): string => `---\n${body}\n---\n\n# body\n`;

describe('parseTask', () => {
  it('parses valid front matter, including a quoted title with a colon', () => {
    const r = parseTask(
      'docs/tasks/phase-1-core/P1-02-x.md',
      fm(
        'id: P1-02\ntitle: "Tools: a and b"\nphase: 1\nstatus: todo\npriority: high\ndepends_on: [P1-01]\nadr: ["0004"]\nlessons: [L-001]',
      ),
    );
    expect(r.errors).toEqual([]);
    expect(r.task).toMatchObject({
      title: 'Tools: a and b',
      dependsOn: ['P1-01'],
      adr: ['0004'],
      lessons: ['L-001'],
    });
  });

  it('rejects an unquoted title with a colon (invalid YAML)', () => {
    const r = parseTask(
      'docs/tasks/phase-1-core/P1-02-x.md',
      fm('id: P1-02\ntitle: Tools: a\nphase: 1\nstatus: todo\npriority: high'),
    );
    expect(r.errors.join('\n')).toMatch(/invalid YAML front matter/);
  });

  it('rejects bad enums, phase and id mismatches, a wrong folder and malformed ids', () => {
    const r = parseTask(
      'docs/tasks/phase-1-core/P1-03-x.md',
      fm('id: P2-02\ntitle: X\nphase: 1\nstatus: doing\npriority: urgent\nadr: [4]\nlessons: [L1]'),
    );
    const errors = r.errors.join('\n');
    expect(errors).toMatch(/invalid status "doing"/);
    expect(errors).toMatch(/invalid priority "urgent"/);
    expect(errors).toMatch(/phase does not match id/);
    expect(errors).toMatch(/file name must start with "P2-02-"/);
    expect(errors).toMatch(/invalid ADR id "4"/);
    expect(errors).toMatch(/invalid lesson id "L1"/);
  });

  it('rejects a task filed in the wrong phase folder', () => {
    const r = parseTask(
      'docs/tasks/phase-2-access/P1-02-x.md',
      fm('id: P1-02\ntitle: X\nphase: 1\nstatus: todo\npriority: high'),
    );
    expect(r.errors).toEqual([
      'docs/tasks/phase-2-access/P1-02-x.md: folder "phase-2-access" does not match phase 1',
    ]);
  });

  it('rejects missing front matter and non-list fields', () => {
    expect(parseTask('a.md', '# no front matter').errors).toEqual(['a.md: missing front matter']);
    const r = parseTask(
      'docs/tasks/phase-1-x/P1-02-x.md',
      fm('id: P1-02\ntitle: X\nphase: 1\nstatus: todo\npriority: high\ndepends_on: P1-01'),
    );
    expect(r.errors).toEqual(['docs/tasks/phase-1-x/P1-02-x.md: depends_on must be a list']);
  });
});

describe('validate', () => {
  it('catches an unknown lesson id', () => {
    expect(validate([task('P1-01', 'todo', { lessons: ['L-001', 'L-999'] })], REFS)).toEqual([
      'P1-01: unknown lesson L-999 (not in docs/LESSONS-LEARNED.md)',
    ]);
  });

  it('catches an unknown ADR', () => {
    expect(validate([task('P1-01', 'todo', { adr: ['0004', '0042'] })], REFS)).toEqual([
      'P1-01: unknown ADR 0042 (no docs/adr/0042-*.md)',
    ]);
  });

  it('catches a dependency cycle', () => {
    const tasks = [
      task('P1-01', 'todo', { dependsOn: ['P1-03'] }),
      task('P1-02', 'todo', { dependsOn: ['P1-01'] }),
      task('P1-03', 'todo', { dependsOn: ['P1-02'] }),
    ];
    expect(validate(tasks, REFS)).toEqual(['dependency cycle: P1-01 -> P1-03 -> P1-02 -> P1-01']);
  });

  it('catches unknown and self dependencies and duplicate ids', () => {
    const errors = validate(
      [
        task('P1-01', 'todo', { dependsOn: ['P1-01', 'P9-99'] }),
        task('P1-01', 'done', { file: 'docs/tasks/phase-1-x/P1-01-y.md' }),
      ],
      REFS,
    );
    expect(errors).toEqual([
      'duplicate id P1-01 (docs/tasks/phase-1-x/P1-01-y.md)',
      'P1-01: depends on itself',
      'P1-01: unknown dependency P9-99',
    ]);
  });

  it('accepts a valid plan', () => {
    const tasks = [
      task('P1-01', 'done', { adr: ['0001'], lessons: ['L-006'] }),
      task('P1-02', 'todo', { dependsOn: ['P1-01'] }),
    ];
    expect(validate(tasks, REFS)).toEqual([]);
  });
});

describe('nextTasks', () => {
  it('picks todo tasks whose dependencies are done or dropped: lowest phase, then priority, then id', () => {
    const tasks = [
      task('P0-01', 'done'),
      task('P0-02', 'todo', { dependsOn: ['P0-01'], priority: 'medium' }),
      task('P0-03', 'todo', { dependsOn: ['P0-01'] }),
      task('P0-04', 'todo', { dependsOn: ['P0-03'] }),
      task('P0-05', 'dropped'),
      task('P1-01', 'todo', { dependsOn: ['P0-05'] }),
      task('P0-06', 'in-progress'),
    ];
    expect(nextTasks(tasks).map((t) => t.id)).toEqual(['P0-03', 'P0-02', 'P1-01']);
  });

  it('treats review as not done', () => {
    expect(nextTasks([task('P0-01', 'review'), task('P0-02', 'todo', { dependsOn: ['P0-01'] })])).toEqual([]);
  });
});

describe('index', () => {
  it('renders one table per phase and replaces the text between the markers', () => {
    const index = renderIndex([task('P0-01', 'done'), task('P1-01', 'todo', { dependsOn: ['P0-01'] })]);
    const roadmap = replaceIndex('# R\n\n<!-- tasks:start -->\nold\n<!-- tasks:end -->\n\nafter\n', index);
    expect(roadmap).toBe(
      [
        '# R',
        '',
        '<!-- tasks:start -->',
        '### Phase 0',
        '',
        '| ID | Task | Priority | Depends on | Status |',
        '|---|---|---|---|---|',
        '| P0-01 | [Task P0-01](tasks/phase-0-x/P0-01-x.md) | high | — | done |',
        '',
        '### Phase 1',
        '',
        '| ID | Task | Priority | Depends on | Status |',
        '|---|---|---|---|---|',
        '| P1-01 | [Task P1-01](tasks/phase-1-x/P1-01-x.md) | high | P0-01 | todo |',
        '<!-- tasks:end -->',
        '',
        'after',
        '',
      ].join('\n'),
    );
  });

  it('refuses a roadmap without markers', () => {
    expect(() => replaceIndex('# R\n', '')).toThrow(/markers/);
  });
});

describe('the repository plan', () => {
  it('is valid and its ROADMAP index is current', () => {
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const { tasks, errors } = loadTasks(root);
    expect(errors).toEqual([]);
    expect(validate(tasks, loadReferences(root))).toEqual([]);
    const roadmap = readFileSync(join(root, 'docs', 'ROADMAP.md'), 'utf8');
    expect(replaceIndex(roadmap, renderIndex(tasks))).toBe(roadmap);
  });
});

describe('main', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function plan(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'ab-tasks-'));
    roots.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  }

  const base = {
    'docs/adr/0001-markdown-planning.md': '# ADR-0001\n',
    'docs/LESSONS-LEARNED.md': '**L-001 — Measure before you build.**\n',
    'docs/ROADMAP.md': '# Roadmap\n\n<!-- tasks:start -->\n<!-- tasks:end -->\n',
    'docs/tasks/phase-0-x/P0-01-a.md': fm(
      'id: P0-01\ntitle: A\nphase: 0\nstatus: done\npriority: high\ndepends_on: []\nadr: ["0001"]\nlessons: [L-001]',
    ),
    'docs/tasks/phase-0-x/P0-02-b.md': fm(
      'id: P0-02\ntitle: B\nphase: 0\nstatus: todo\npriority: high\ndepends_on: [P0-01]',
    ),
  };

  it('lint fails on a stale index, index fixes it, then lint passes', () => {
    const root = plan(base);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(main(['lint'], root)).toBe(1);
    expect(err).toHaveBeenCalledWith('✗ docs/ROADMAP.md task index is stale — run `pnpm tasks index`');
    expect(main(['index'], root)).toBe(0);
    expect(main(['lint'], root)).toBe(0);
  });

  it('lint fails on an unknown lesson in a task file', () => {
    const root = plan({
      ...base,
      'docs/tasks/phase-0-x/P0-02-b.md': fm(
        'id: P0-02\ntitle: B\nphase: 0\nstatus: todo\npriority: high\nlessons: [L-404]',
      ),
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(main(['lint'], root)).toBe(1);
    expect(err).toHaveBeenCalledWith('✗ P0-02: unknown lesson L-404 (not in docs/LESSONS-LEARNED.md)');
  });

  it('next prints the first unblocked task', () => {
    const root = plan(base);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(main(['next'], root)).toBe(0);
    expect(log).toHaveBeenCalledWith('P0-02  todo   high    B');
  });
});
