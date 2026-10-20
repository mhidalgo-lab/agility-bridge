// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkWorkflow, findViolations } from '../check-workflows.ts';

const HARDEN = 'step-security/harden-runner@ccd8616d44fd3846e67624a50d5aad6d37bf2d25 # v2.22.1';
const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1';

function workflow(parts: { on?: string; permissions?: string; job?: string; steps?: string[] }): string {
  const steps = parts.steps ?? [`uses: ${HARDEN}`, `uses: ${CHECKOUT}`];
  return [
    `on: ${parts.on ?? '[pull_request]'}`,
    parts.permissions ?? 'permissions:\n  contents: read',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    ...(parts.job ? [parts.job] : []),
    '    steps:',
    ...steps.map((s) => `      - ${s.replace(/\n/g, '\n        ')}`),
    '',
  ].join('\n');
}

describe('checkWorkflow', () => {
  it('accepts a hardened workflow', () => {
    expect(checkWorkflow('ok.yml', workflow({}))).toEqual([]);
  });

  it('fails when an action is pinned by tag instead of SHA', () => {
    const src = workflow({ steps: [`uses: ${HARDEN}`, 'uses: actions/checkout@v7'] });
    expect(checkWorkflow('x.yml', src)).toEqual([
      'x.yml: "actions/checkout@v7" is not pinned by a full commit SHA',
    ]);
  });

  it('fails when a SHA pin has no version comment', () => {
    const src = workflow({
      steps: [`uses: ${HARDEN}`, 'uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'],
    });
    expect(checkWorkflow('x.yml', src)).toEqual([
      'x.yml: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" has no "# vX.Y.Z" comment',
    ]);
  });

  it.each([['permissions: write-all'], ['permissions: read-all'], ['permissions:\n  contents: write'], ['']])(
    'fails on broad or missing top-level permissions: %j',
    (permissions) => {
      expect(checkWorkflow('x.yml', workflow({ permissions }))).toContain(
        'x.yml: top-level permissions must be `contents: read` or `{}`',
      );
    },
  );

  it('accepts empty top-level permissions', () => {
    expect(checkWorkflow('x.yml', workflow({ permissions: 'permissions: {}' }))).toEqual([]);
  });

  it('fails on a job write scope outside the allowlist, and on string job permissions', () => {
    expect(checkWorkflow('x.yml', workflow({ job: '    permissions:\n      actions: write' }))).toEqual([
      'x.yml build: "actions: write" is not on the allowlist',
    ]);
    expect(checkWorkflow('x.yml', workflow({ job: '    permissions: write-all' }))).toEqual([
      'x.yml build: job permissions must list scopes, not "write-all"',
    ]);
  });

  it('fails on pull_request_target and self-hosted runners', () => {
    expect(checkWorkflow('x.yml', workflow({ on: '[pull_request_target]' }))).toEqual([
      'x.yml: pull_request_target is not allowed',
    ]);
    const selfHosted = workflow({}).replace('runs-on: ubuntu-latest', 'runs-on: [self-hosted, linux]');
    expect(checkWorkflow('x.yml', selfHosted)).toEqual(['x.yml build: self-hosted runners are not allowed']);
  });

  it('fails when a Linux job does not start with harden-runner', () => {
    expect(checkWorkflow('x.yml', workflow({ steps: [`uses: ${CHECKOUT}`] }))).toEqual([
      'x.yml build: the first step on a Linux runner must be step-security/harden-runner',
    ]);
  });

  it('fails on a download without a pinned checksum', () => {
    const src = workflow({ steps: [`uses: ${HARDEN}`, 'run: curl -fsSLO https://example.com/tool.tar.gz'] });
    expect(checkWorkflow('x.yml', src)).toEqual([
      'x.yml build: a downloaded file must be verified with `sha256sum -c --strict`',
    ]);
  });
});

describe('repository workflows', () => {
  it('pass every rule', () => {
    expect(findViolations(fileURLToPath(new URL('../../.github/workflows/', import.meta.url)))).toEqual([]);
  });
});
