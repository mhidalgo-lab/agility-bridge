// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  changesetPackages,
  changesetReport,
  classifyChangesets,
  decideMode,
  decidePlan,
  extractNotes,
  IMAGE_REPOSITORY,
  imageTags,
  pendingChangesets,
  pluginManifestVersion,
  type ReleaseState,
  readVersionConst,
  releaseRef,
  resolveTagCommit,
  SEMVER_RE,
  versionablePackages,
  writePluginManifestVersion,
  writeVersionConst,
} from '../release.ts';
import { evalGuard } from './gha-expr.ts';

describe('pendingChangesets / decideMode', () => {
  it('ignores the changeset README and config', () => {
    expect(pendingChangesets(['README.md', 'config.json', 'brave-cats.md'])).toEqual(['brave-cats.md']);
    expect(pendingChangesets(['README.md', 'config.json'])).toEqual([]);
  });

  it('versions first, then publishes only unpublished versions', () => {
    expect(decideMode(2, false)).toBe('version');
    expect(decideMode(1, true)).toBe('version');
    expect(decideMode(0, false)).toBe('publish');
    expect(decideMode(0, true)).toBe('none');
  });
});

describe('changesets changesets cannot consume (P8-84)', () => {
  const versionable = new Set(['agility-bridge']);
  const ok = { file: 'ok.md', text: '---\n"agility-bridge": minor\n---\n\nNew tool.\n' };
  const privateOne = { file: 'core.md', text: "---\n'@agility-bridge/core': patch\n---\n\nFix.\n" };
  const ignored = { file: 'worker.md', text: '---\n"@agility-bridge/worker": patch\n---\n' };
  const broken = { file: 'broken.md', text: 'no front matter\n' };

  it('reads the package names of the front matter', () => {
    expect(changesetPackages(ok.text)).toEqual(['agility-bridge']);
    expect(changesetPackages('---\r\nagility-bridge: patch\r\n"a": major\r\n---\r\n')).toEqual([
      'agility-bridge',
      'a',
    ]);
    expect(changesetPackages('---\n---\n\nEmpty changeset.\n')).toEqual([]);
    expect(changesetPackages(broken.text)).toBeUndefined();
    expect(changesetPackages('---\nagility-bridge: huge\n---\n')).toBeUndefined();
    expect(changesetPackages('---\nagility-bridge: patch\n')).toBeUndefined();
  });

  it('refuses a private or ignored package and names the published one', () => {
    const { consumable, problems } = classifyChangesets([ok, privateOne, ignored, broken], versionable);
    expect(consumable).toEqual(['ok.md']);
    expect(problems.map((p) => p.file)).toEqual(['core.md', 'worker.md', 'broken.md']);
    expect(problems[0]?.message).toMatch(/"@agility-bridge\/core".*use "agility-bridge" instead/);
    expect(problems[2]?.message).toMatch(/front matter/);
  });

  it('plan warns about each one, and fails when no pending changeset can be consumed', () => {
    expect(changesetReport([], versionable)).toEqual({ warnings: [] });
    expect(changesetReport([ok], versionable)).toEqual({ warnings: [] });
    const mixed = changesetReport([ok, privateOne], versionable);
    expect(mixed.error).toBeUndefined();
    expect(mixed.warnings).toEqual([
      expect.stringMatching(/^\.changeset\/core\.md names "@agility-bridge\/core"/),
    ]);
    const stuck = changesetReport([privateOne, ignored], versionable);
    expect(stuck.warnings).toHaveLength(2);
    expect(stuck.error).toMatch(/2 pending changeset\(s\) and none can be consumed/);
  });

  it('only agility-bridge is versionable in this workspace (private packages and the ignored worker are not)', () => {
    const root = new URL('../..', import.meta.url).pathname;
    expect([...versionablePackages(root)]).toEqual(['agility-bridge']);
  });

  it('versionablePackages honours private, ignore and a missing package.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'rb-changesets-'));
    const pkg = (dir: string, body: object): void => {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, 'package.json'), JSON.stringify(body));
    };
    mkdirSync(join(root, '.changeset'));
    writeFileSync(join(root, '.changeset/config.json'), JSON.stringify({ ignore: ['ignored-app'] }));
    pkg('apps/cli', { name: 'pub' });
    pkg('apps/worker', { name: 'ignored-app' });
    pkg('packages/core', { name: '@x/core', private: true });
    mkdirSync(join(root, 'packages/empty'));
    pkg('site', { name: 'site', private: true });
    expect([...versionablePackages(root)]).toEqual(['pub']);
  });

  it('the check-changesets command passes on this repository', () => {
    const run = spawnSync(process.execPath, ['scripts/release.ts', 'check-changesets'], {
      cwd: new URL('../..', import.meta.url).pathname,
      encoding: 'utf8',
    });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });
});

describe('extractNotes', () => {
  const changelog = '# agility-bridge\n\n## 0.2.0\n\n- second\n\n## 0.1.0\n\n### Minor Changes\n\n- first\n';

  it('returns the body of one version section', () => {
    expect(extractNotes(changelog, '0.2.0')).toBe('- second');
    expect(extractNotes(changelog, '0.1.0')).toBe('### Minor Changes\n\n- first');
  });

  it('is undefined for a missing or empty section', () => {
    expect(extractNotes(changelog, '9.9.9')).toBeUndefined();
    expect(extractNotes('## 1.0.0\n\n## 0.9.0\n- x\n', '1.0.0')).toBeUndefined();
  });

  it('does not match a version prefix', () => {
    expect(extractNotes('## 0.1.0-beta.1\n- beta\n', '0.1.0')).toBeUndefined();
  });
});

describe('version constant', () => {
  const source = "// x\nexport const VERSION = '0.0.0';\nexport const OTHER = 1;\n";

  it('reads and rewrites only the VERSION constant', () => {
    expect(readVersionConst(source)).toBe('0.0.0');
    const next = writeVersionConst(source, '0.1.0');
    expect(readVersionConst(next)).toBe('0.1.0');
    expect(next).toContain('export const OTHER = 1;');
  });

  it('refuses non-SemVer input (it ends up in tags and workflow outputs)', () => {
    expect(() => writeVersionConst(source, "0.1.0'; evil()")).toThrow(/SemVer/);
    expect(() => writeVersionConst('no constant here', '0.1.0')).toThrow(/VERSION/);
    expect(SEMVER_RE.test('1.2.3-rc.1')).toBe(true);
    expect(SEMVER_RE.test('1.2.3\nmode=publish')).toBe(false);
  });
});

describe('imageTags (P2-18, L-128: never backwards)', () => {
  it('tags the newest release X.Y.Z, X.Y and latest', () => {
    expect(imageTags('0.2.0', ['0.1.0', '0.1.1'], false)).toEqual(['0.2.0', '0.2', 'latest']);
    expect(imageTags('0.1.0', [], false)).toEqual(['0.1.0', '0.1', 'latest']);
    // the version itself already on npm (the run after the npm approval)
    expect(imageTags('0.2.0', ['0.1.0', '0.2.0'], false)).toEqual(['0.2.0', '0.2', 'latest']);
  });

  it('a patch of an older line moves its X.Y but never latest', () => {
    expect(imageTags('0.1.2', ['0.1.1', '0.2.0'], false)).toEqual(['0.1.2', '0.1']);
    expect(imageTags('0.1.2', ['0.1.1', '0.1.3', '0.2.0'], false)).toEqual(['0.1.2']);
    expect(imageTags('1.9.0', ['1.10.0'], false)).toEqual(['1.9.0', '1.9']);
  });

  it('a backport never takes latest; a prerelease gets only its own tag', () => {
    expect(imageTags('1.2.4', ['1.2.3', '1.1.0'], true)).toEqual(['1.2.4', '1.2']);
    expect(imageTags('2.0.0-rc.1', ['1.2.3'], false)).toEqual(['2.0.0-rc.1']);
    expect(imageTags('1.3.0', ['1.2.3', '2.0.0-rc.1'], false)).toEqual(['1.3.0', '1.3', 'latest']);
  });

  it('refuses non-SemVer input', () => {
    expect(() => imageTags('latest', [], false)).toThrow(/SemVer/);
  });
});

describe('decidePlan (idempotent reruns, tag safety)', () => {
  const head = 'a'.repeat(40);
  const other = 'b'.repeat(40);
  const base: ReleaseState = {
    pending: 0,
    published: false,
    released: false,
    tagCommit: undefined,
    headSha: head,
  };

  it('versions first, whatever else is true', () => {
    expect(decidePlan({ ...base, pending: 1, tagCommit: other, released: true })).toBe('version');
  });

  it('publishes an unpublished version', () => {
    expect(decidePlan(base)).toBe('publish');
    expect(decidePlan({ ...base, tagCommit: head })).toBe('publish');
  });

  it('creates only the GitHub Release when npm has the version but GitHub does not', () => {
    expect(decidePlan({ ...base, published: true })).toBe('release');
    expect(decidePlan({ ...base, published: true, tagCommit: head })).toBe('release');
  });

  it('does nothing once both exist, even though the tag is on an older commit', () => {
    expect(decidePlan({ ...base, published: true, released: true, tagCommit: other })).toBe('none');
  });

  it('refuses a tag on another commit', () => {
    expect(() => decidePlan({ ...base, tagCommit: other })).toThrow(/another commit/);
    expect(() => decidePlan({ ...base, published: true, tagCommit: other })).toThrow(/another commit/);
  });

  it('refuses a GitHub Release without the npm version', () => {
    expect(() => decidePlan({ ...base, released: true })).toThrow(/not on npm/);
  });
});

describe('resolveTagCommit', () => {
  const commit = 'c'.repeat(40);
  const tagObj = 'd'.repeat(40);

  it('is undefined for a missing tag', () => {
    expect(resolveTagCommit('o/r', 'v1.0.0', () => undefined)).toBeUndefined();
  });

  it('returns the commit of a lightweight tag', () => {
    const calls: string[] = [];
    const fetchJson = (path: string) => {
      calls.push(path);
      return { object: { sha: commit, type: 'commit' } };
    };
    expect(resolveTagCommit('o/r', 'v1.0.0', fetchJson)).toBe(commit);
    expect(calls).toEqual(['repos/o/r/git/ref/tags/v1.0.0']);
  });

  it('follows annotated tags', () => {
    const fetchJson = (path: string) =>
      path.endsWith('/git/ref/tags/v1.0.0')
        ? { object: { sha: tagObj, type: 'tag' } }
        : path.endsWith(`/git/tags/${tagObj}`)
          ? { object: { sha: commit, type: 'commit' } }
          : undefined;
    expect(resolveTagCommit('o/r', 'v1.0.0', fetchJson)).toBe(commit);
  });

  it('rejects malformed or non-commit targets', () => {
    expect(() =>
      resolveTagCommit('o/r', 'v1', () => ({ object: { sha: 'nope', type: 'commit' } })),
    ).toThrow();
    expect(() => resolveTagCommit('o/r', 'v1', () => ({ object: { sha: commit, type: 'tree' } }))).toThrow(
      /tree/,
    );
    expect(() => resolveTagCommit('o/r', 'v1', () => ({ object: { sha: tagObj, type: 'tag' } }))).toThrow(
      /deep/,
    );
  });
});

interface Step {
  id?: string;
  name?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  uses?: string;
  run?: string;
  if?: string;
}
interface Job {
  permissions?: Record<string, string>;
  steps?: Step[];
  needs?: string | string[];
  environment?: { name?: string } | string;
  if?: string;
  outputs?: Record<string, string>;
}

describe('.github/workflows/release.yml (THREAT_MODEL T18, P1-16)', () => {
  const workflow = parse(
    readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
  ) as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    jobs: { [name: string]: Job; build?: Job; publish?: Job };
  };
  const jobs = Object.entries(workflow.jobs);
  const oidcJobs = jobs.filter(([, job]) => job.permissions?.['id-token'] === 'write');
  // Anything that installs dependencies or runs repository code.
  const RUNS_PROJECT_CODE =
    /\b(pnpm|yarn|npx|corepack|bun|deno)\b|\bnode\s|\bnpm\s+(install|i|ci|run|run-script|exec|test|rebuild|pack|start|x)\b|\.\/|\bscripts\//;

  it('never runs on pull requests and grants nothing by default', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(workflow.permissions).toEqual({});
  });

  it('only the publish and image jobs can mint an OIDC token', () => {
    expect(oidcJobs.map(([name]) => name)).toEqual(['publish', 'image']);
  });

  it('the OIDC job checks nothing out and runs no project or dependency code', () => {
    for (const [, job] of oidcJobs) {
      for (const step of job.steps ?? []) {
        expect(step.uses ?? '').not.toMatch(/^actions\/checkout@|^pnpm\/action-setup@/);
        expect(step.run ?? '').not.toMatch(RUNS_PROJECT_CODE);
        if (/npm\s+stage\s+publish/.test(step.run ?? '')) expect(step.run).toContain('--ignore-scripts');
      }
    }
  });

  it('jobs that install dependencies have no id-token and a read-only token', () => {
    const installing = jobs.filter(([, job]) =>
      (job.steps ?? []).some((s) => /pnpm install/.test(s.run ?? '')),
    );
    expect(installing.length).toBeGreaterThan(0);
    for (const [, job] of installing) expect(job.permissions?.['id-token']).toBeUndefined();
    expect(workflow.jobs.build?.permissions).toEqual({ contents: 'read' });
  });

  it('versions through changesets plus the version sync, and lints both', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['version-packages']).toBe('changeset version && node scripts/release.ts sync-version');
    expect(pkg.scripts['lint']).toContain('release.ts sync-version --check');
    expect(pkg.scripts['lint']).toContain('release.ts check-changesets');
  });

  it('publish waits for build, the release environment, main and the opt-in variable', () => {
    const publish = workflow.jobs.publish;
    expect(publish?.needs).toEqual(['plan', 'build']);
    expect(publish?.environment).toMatchObject({ name: 'release' });
    for (const job of [publish, workflow.jobs.build]) {
      expect(job?.if).toContain("vars.AB_RELEASE_ENABLED == 'true'");
    }
  });

  describe('runs from main or release/x.y only (P8-68)', () => {
    const ctx = (ref: string, enabled = 'true') => ({
      'github.ref': ref,
      'vars.AB_RELEASE_ENABLED': enabled,
      'needs.plan.outputs.mode': 'publish',
    });
    const guarded = (['plan', 'build', 'publish', 'image-build', 'image'] as const).map((name) => {
      const guard = workflow.jobs[name]?.if;
      expect(guard, name).toBeTypeOf('string');
      return [name, guard as string] as const;
    });

    it('triggers on pushes to main and release/*', () => {
      expect((workflow.on['push'] as { branches: string[] }).branches).toEqual(['main', 'release/*']);
    });

    it.each(['refs/heads/main', 'refs/heads/release/1.2'])('%s passes every release job guard', (ref) => {
      for (const [name, guard] of guarded) expect(evalGuard(guard, ctx(ref)), name).toBe(true);
    });

    it.each([
      'refs/heads/feature/x',
      'refs/heads/mainline',
      'refs/heads/releases/1.2',
      'refs/heads/backport/release/1.2',
      'refs/tags/v1.2.3',
      'refs/tags/release/1.2',
      'refs/pull/7/merge',
    ])('%s is skipped by every release job', (ref) => {
      for (const [name, guard] of guarded) expect(evalGuard(guard, ctx(ref)), name).toBe(false);
    });

    it('build, publish and the image jobs still need the opt-in variable on a release branch', () => {
      for (const name of ['build', 'publish', 'image-build', 'image'] as const) {
        expect(evalGuard(workflow.jobs[name]?.if as string, ctx('refs/heads/release/1.2', 'false'))).toBe(
          false,
        );
      }
    });

    it('plan refuses refs the job guard lets through but the ruleset does not cover, and other minors', () => {
      expect(releaseRef('refs/heads/main', '1.3.0')).toEqual({ backport: false, npmTag: 'latest' });
      expect(releaseRef('refs/heads/release/1.2', '1.2.4')).toEqual({
        backport: true,
        npmTag: 'release-1.2',
      });
      expect(() => releaseRef('refs/heads/release/1.2/x', '1.2.4')).toThrow(/main or release/);
      expect(() => releaseRef('refs/heads/release/next', '1.2.4')).toThrow(/main or release/);
      expect(() => releaseRef('refs/tags/v1.2.4', '1.2.4')).toThrow(/main or release/);
      expect(() => releaseRef('refs/heads/release/1.2', '1.3.0')).toThrow(/only release 1\.2\.x/);
      expect(() => releaseRef('refs/heads/release/1.2', '11.2.0')).toThrow(/only release 1\.2\.x/);
      expect(() => releaseRef('', '1.2.4')).toThrow(/main or release/);
    });

    it('a backport is staged with its own dist-tag, never latest, and is not the latest GitHub Release', () => {
      const runs = (workflow.jobs.publish?.steps ?? []).map((s) => s.run ?? '').join('\n');
      expect(workflow.jobs['plan']?.outputs).toMatchObject({
        'npm-tag': '${{ steps.plan.outputs.npm-tag }}',
      });
      expect(runs).toMatch(/npm stage publish [^\n]*\\\n\s*--tag "\$NPM_TAG"/);
      expect(runs).toContain('main publishes with the latest tag only');
      expect(runs).toContain('publishes ${line}.x as release-${line} only');
      expect(runs).toMatch(/latest=true; \[\[ "\$NPM_TAG" == latest \]\] \|\| latest=false/);
      expect(runs).toContain('--latest="$latest"');
    });
  });

  it('publish verifies the checksums before attesting or publishing', () => {
    const steps = (workflow.jobs.publish?.steps ?? []).map((s) => `${s.uses ?? ''} ${s.run ?? ''}`);
    const verify = steps.findIndex((s) => s.includes('sha256sum -c --strict SHA256SUMS'));
    const attest = steps.findIndex((s) => s.includes('actions/attest@'));
    const publish = steps.findIndex((s) => /npm stage publish/.test(s));
    expect(verify).toBeGreaterThan(-1);
    expect(verify).toBeLessThan(attest);
    expect(attest).toBeLessThan(publish);
  });

  it('attests the release assets and uploads the bundle as <asset>.intoto.jsonl (Scorecard Signed-Releases, P8-54)', () => {
    const publish = workflow.jobs.publish;
    const steps = publish?.steps ?? [];
    const provenance = steps.find((s) => s.id === 'provenance');
    expect(provenance?.uses).toMatch(/^actions\/attest(-build-provenance)?@[0-9a-f]{40}$/);
    expect(publish?.permissions).toMatchObject({ 'id-token': 'write', attestations: 'write' });
    const release = steps.find((s) => /gh release create/.test(s.run ?? ''));
    expect(release?.env?.['BUNDLE_PATH']).toBe('${{ steps.provenance.outputs.bundle-path }}');
    expect(release?.run).toContain('agility-bridge-${VERSION}.intoto.jsonl');
    // the bundle is created after the checksums are verified and is not part of SHA256SUMS
    expect(release?.run).not.toContain('dist-release/release/agility-bridge-${VERSION}.intoto.jsonl');
    // nothing else got more permissions for it
    for (const [name, job] of jobs) {
      if (name !== 'publish' && name !== 'image') expect(job.permissions?.['attestations']).toBeUndefined();
    }
  });

  it('stages on npm and never publishes directly (second approval with 2FA on npmjs.com)', () => {
    const steps = workflow.jobs.publish?.steps ?? [];
    for (const step of steps)
      expect(step.run ?? '').not.toMatch(/\bnpm\s+publish\b|\bnpm\s+stage\s+approve\b/);
    const stage = steps.find((s) => /npm\s+stage\s+publish/.test(s.run ?? ''));
    expect(stage?.if).toBe("steps.npm.outputs.published == 'false'");
    for (const flag of ['--provenance', '--access public', '--ignore-scripts']) {
      expect(stage?.run).toContain(flag);
    }
    // an absolute path (npm reads a relative a/b.tgz as a git shorthand)
    expect(stage?.run).toContain('"${PWD}/dist-release/release/');
  });

  it('creates the GitHub Release only once the version is live on npm', () => {
    const steps = workflow.jobs.publish?.steps ?? [];
    const release = steps.find((s) => /gh release create/.test(s.run ?? ''));
    expect(release?.if).toBe("steps.npm.outputs.published == 'true'");
  });

  describe('the image (P2-18, D-25)', () => {
    const image = workflow.jobs['image'];
    const build = workflow.jobs['image-build'];
    const runs = (job: Job | undefined) => (job?.steps ?? []).map((s) => s.run ?? '').join('\n');

    it('is built without credentials and pushed only by the image job, behind the release environment', () => {
      expect(build?.permissions).toEqual({ contents: 'read' });
      expect(image?.needs).toEqual(['plan', 'build', 'image-build']);
      expect(image?.environment).toMatchObject({ name: 'release' });
      expect(image?.permissions).toEqual({
        packages: 'write',
        'id-token': 'write',
        attestations: 'write',
        'artifact-metadata': 'write',
      });
      for (const [name, job] of jobs) {
        if (name !== 'image') expect(job.permissions?.['packages'], name).toBeUndefined();
      }
    });

    it('smoke-tests and scans the archived image that is pushed, not a rebuild', () => {
      const r = runs(build);
      expect(r).toContain('--output "type=oci,dest=dist-image/agility-bridge-${VERSION}.oci.tar"');
      expect(r).toContain('docker-daemon:agility-bridge:release');
      expect(r).toContain('scripts/docker-smoke.ts agility-bridge:release');
      expect(r).toMatch(/trivy image [^\n]*--exit-code 1 agility-bridge:release/);
    });

    it('verifies the checksums, waits for npm, never overwrites a version tag, and attests the pushed digest', () => {
      const steps = image?.steps ?? [];
      const at = (re: RegExp) => steps.findIndex((s) => re.test(`${s.uses ?? ''} ${s.run ?? ''}`));
      const npm = at(/npm view "agility-bridge@\$\{VERSION\}"/);
      const verify = at(/sha256sum -c --strict IMAGE_SHA256SUMS/);
      const push = at(/skopeo copy --all --digestfile/);
      const attest = at(/actions\/attest@/);
      expect(npm).toBeGreaterThan(-1);
      expect(npm).toBeLessThan(verify);
      expect(verify).toBeLessThan(push);
      expect(push).toBeLessThan(attest);
      for (const step of steps.slice(npm + 1))
        expect(step.if, step.name).toBe("steps.npm.outputs.live == 'true'");
      const pushRun = steps[push]?.run ?? '';
      expect(pushRun.indexOf('skopeo inspect --raw "docker://${IMAGE}:${VERSION}"')).toBeLessThan(
        pushRun.indexOf('skopeo copy --all --digestfile'),
      );
      expect(pushRun).not.toMatch(/docker push|--force/);
      const attests = steps.filter((s) => /^actions\/attest@[0-9a-f]{40}$/.test(s.uses ?? ''));
      expect(attests).toHaveLength(2);
      for (const a of attests) {
        expect(a.with).toMatchObject({
          'subject-name': IMAGE_REPOSITORY,
          'subject-digest': '${{ steps.push.outputs.digest }}',
          'push-to-registry': true,
        });
      }
      expect(runs(image)).toContain('latest only from main');
    });
  });

  describe('stage step reruns (stub npm)', () => {
    const stage = (workflow.jobs.publish?.steps ?? []).find((s) => /npm\s+stage\s+publish/.test(s.run ?? ''));

    function run(npmScript: string) {
      const dir = mkdtempSync(join(tmpdir(), 'stage-'));
      mkdirSync(join(dir, 'dist-release/release'), { recursive: true });
      writeFileSync(join(dir, 'dist-release/release/agility-bridge-1.2.3.tgz'), 'x');
      const mk = (name: string, body: string) => {
        writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`);
        chmodSync(join(dir, name), 0o755);
      };
      mk('npm', npmScript);
      const result = spawnSync('bash', ['-c', `set -eo pipefail\n${stage?.run}`], {
        env: {
          PATH: `${dir}:${process.env['PATH']}`,
          VERSION: '1.2.3',
          RUNNER_TEMP: dir,
          GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
        },
        encoding: 'utf8',
        cwd: dir,
      });
      let summary = '';
      try {
        summary = readFileSync(join(dir, 'summary.md'), 'utf8');
      } catch {
        // no summary written
      }
      return { ...result, summary };
    }
    // `--version` answers a current npm; any other call is the stage command.
    const stub = (stageBody: string, version = '11.16.0') =>
      `if [[ "$1" == --version ]]; then echo ${version}; exit 0; fi\necho "$@" >> "$RUNNER_TEMP/calls"\n${stageBody}`;

    it('stages once and reports that approval is pending', () => {
      const r = run(stub('echo staged; exit 0'));
      expect(r.status).toBe(0);
      expect(r.summary).toMatch(/staged, not published/);
      expect(r.summary).toMatch(/sha512-/);
    });

    it('treats "already staged, not approved" as awaiting approval, not a failure', () => {
      const r = run(
        stub('echo "npm error code E409" >&2; echo "npm error cannot publish over staged 1.2.3" >&2; exit 1'),
      );
      expect(r.status).toBe(0);
      expect(r.summary).toMatch(/already staged/);
      expect(r.stdout).toMatch(/nothing staged again/);
    });

    it('fails on any other error', () => {
      const r = run(stub('echo "npm error code E403" >&2; echo "npm error forbidden" >&2; exit 1'));
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/npm stage publish failed/);
    });

    it('refuses an npm too old for staged publishing', () => {
      const r = run(stub('exit 0', '11.14.9'));
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/too old/);
    });
  });
});

describe('the Claude Code plugin version (P8-06)', () => {
  const manifest = '{\n  "name": "agility-bridge",\n  "version": "0.7.0",\n  "description": "x"\n}\n';
  it('rewrites only the version', () => {
    const out = writePluginManifestVersion(manifest, '0.8.1');
    expect(pluginManifestVersion(out)).toBe('0.8.1');
    expect(out).toBe(manifest.replace('0.7.0', '0.8.1'));
  });
  it('refuses a manifest without a version and a version that is not SemVer', () => {
    expect(() => writePluginManifestVersion('{"name":"x"}', '0.8.0')).toThrow(/no version/);
    expect(() => writePluginManifestVersion(manifest, 'latest')).toThrow(/SemVer/);
  });
});
