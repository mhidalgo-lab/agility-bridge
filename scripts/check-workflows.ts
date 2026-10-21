// SPDX-License-Identifier: Apache-2.0
// THREAT_MODEL T18, L-129, L-130: hardening rules for every GitHub Actions workflow.
// - every third-party action and reusable workflow is pinned by a full commit SHA with a version comment;
// - top-level `permissions` is read-only (`contents: read` or `{}`), never `write-all`/`read-all`; jobs may only widen
//   to an allowlist of scopes;
// - no `pull_request_target` and no self-hosted runners;
// - every job on a Linux runner starts with step-security/harden-runner;
// - a downloaded tool is verified against a sha256 pinned in the workflow.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

interface Step {
  uses?: string;
  run?: string;
}
interface Job {
  'runs-on'?: unknown;
  uses?: string;
  permissions?: unknown;
  steps?: Step[];
}
interface Workflow {
  on?: unknown;
  permissions?: unknown;
  jobs?: Record<string, Job>;
}

/** Scopes a job may request with `write` (each needs a reason in the workflow). */
// `attestations` and `artifact-metadata`: the release publish job attests provenance and the SBOM (P1-15).
const JOB_WRITE_ALLOWLIST = new Set([
  'id-token',
  'contents',
  'pull-requests',
  'security-events',
  'packages',
  'attestations',
  'artifact-metadata',
]);
const PINNED_USES = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/;

export function checkWorkflow(file: string, source: string): string[] {
  const out: string[] = [];
  const wf = (parse(source) ?? {}) as Workflow;

  const triggers =
    typeof wf.on === 'string' ? [wf.on] : Array.isArray(wf.on) ? wf.on : Object.keys(wf.on ?? {});
  if (triggers.includes('pull_request_target')) out.push(`${file}: pull_request_target is not allowed`);

  const top = wf.permissions;
  const topOk =
    top !== undefined &&
    typeof top === 'object' &&
    top !== null &&
    Object.entries(top).every(([scope, level]) => scope === 'contents' && level === 'read');
  if (!topOk) out.push(`${file}: top-level permissions must be \`contents: read\` or \`{}\``);

  // Version comments live in the raw text: `uses: owner/repo@<sha> # vX.Y.Z`.
  for (const line of source.split('\n')) {
    const m = /^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/.exec(line);
    if (!m) continue;
    const ref = m[1] ?? '';
    if (ref.startsWith('./')) continue;
    if (!PINNED_USES.test(ref)) out.push(`${file}: "${ref}" is not pinned by a full commit SHA`);
    else if (!/^\s*#\s*v\d+(\.\d+)*/.test(m[2] ?? ''))
      out.push(`${file}: "${ref}" has no "# vX.Y.Z" comment`);
  }

  for (const [id, job] of Object.entries(wf.jobs ?? {})) {
    const runsOn = JSON.stringify(job['runs-on'] ?? '');
    if (runsOn.includes('self-hosted')) out.push(`${file} ${id}: self-hosted runners are not allowed`);

    if (job.permissions !== undefined) {
      if (typeof job.permissions === 'string') {
        out.push(`${file} ${id}: job permissions must list scopes, not "${job.permissions}"`);
      } else {
        for (const [scope, level] of Object.entries(job.permissions as Record<string, string>)) {
          if (level === 'write' && !JOB_WRITE_ALLOWLIST.has(scope)) {
            out.push(`${file} ${id}: "${scope}: write" is not on the allowlist`);
          }
        }
      }
    }

    const linux = runsOn.includes('ubuntu');
    if (linux && job.steps !== undefined && !job.steps[0]?.uses?.startsWith('step-security/harden-runner@')) {
      out.push(`${file} ${id}: the first step on a Linux runner must be step-security/harden-runner`);
    }

    for (const step of job.steps ?? []) {
      const run = step.run ?? '';
      if (/\b(curl|wget)\b/.test(run) && !/sha256sum -c --strict/.test(run)) {
        out.push(`${file} ${id}: a downloaded file must be verified with \`sha256sum -c --strict\``);
      }
    }
  }
  return out;
}

export function findViolations(dir: string): string[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  } catch {
    return [];
  }
  return files.flatMap((f) => checkWorkflow(f, readFileSync(join(dir, f), 'utf8')));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = findViolations(fileURLToPath(new URL('../.github/workflows/', import.meta.url)));
  for (const v of violations) console.error(`✗ ${v}`);
  process.exit(violations.length === 0 ? 0 : 1);
}
