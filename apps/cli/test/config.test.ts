// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { ConfigError, type FileAccess, loadConfig } from '../src/config.ts';

const URL = 'https://agility.example.com/SyntheticInstance';

const files = (text: string, options: { readable?: boolean; bytes?: number } = {}): FileAccess => ({
  read: (path) =>
    path === '/cfg.yaml'
      ? { text, bytes: options.bytes ?? text.length, groupOrWorldReadable: options.readable ?? false }
      : undefined,
});

describe('environment mode', () => {
  it('reads every stdio setting with defaults', () => {
    const c = loadConfig({
      AB_AGILITY_URL: `${URL}/`,
      AB_AGILITY_TOKEN: 'FAKE-token',
      AB_PROJECTS: 'Scope:1001, Scope:1002',
      AB_TOOLS: 'whoami,list_projects',
      AB_ASSET_TYPES_DENY: 'Defect',
      AB_GENERIC_QUERY: 'off',
      AB_MEMBER_EMAILS: 'on',
      AB_LIMITS_MAX_LIMIT: '50',
      AB_CALL_BUDGET: '45',
    });
    expect(c).toMatchObject({
      kind: 'configured',
      source: 'environment',
      instanceUrl: URL,
      projects: ['Scope:1001', 'Scope:1002'],
      includeChildProjects: true,
      tools: ['whoami', 'list_projects'],
      assetTypes: { deny: ['Defect'] },
      genericQuery: false,
      memberEmails: true,
      maxRows: 50,
      maxResponseBytes: 8 * 1024 * 1024,
      callBudget: 45,
      logLevel: 'info',
    });
    expect(String(c.kind === 'configured' ? c.token : '')).toBe('[REDACTED]');
  });

  it('starts unconfigured (setup mode) with nothing set', () => {
    expect(loadConfig({})).toEqual({ kind: 'setup', logLevel: 'info' });
  });

  it.each([
    [{ AB_AGILITY_URL: URL }, /AB_AGILITY_TOKEN is missing/],
    [{ AB_PROJECTS: 'Scope:1' }, /AB_AGILITY_URL and AB_AGILITY_TOKEN are missing/],
    [{ AB_AGILITY_URL: URL, AB_AGILITY_TOKEN: 'x', AB_PROJECTS: '1234' }, /invalid Agility project/],
    [{ AB_AGILITY_URL: URL, AB_AGILITY_TOKEN: 'x', AB_GENERIC_QUERY: 'maybe' }, /on or off/],
    [{ AB_AGILITY_URL: URL, AB_AGILITY_TOKEN: 'x', AB_LIMITS_MAX_LIMIT: '5000' }, /from 1 to 1000/],
    [{ AB_AGILITY_URL: URL, AB_AGILITY_TOKEN: 'x', AB_LOG_LEVEL: 'loud' }, /AB_LOG_LEVEL/],
    [{ AB_AGILITY_URL: URL, AB_AGILITY_TOKEN: 'x', AB_PROJECT: 'Scope:1' }, /Unknown setting AB_PROJECT\./],
  ])('refuses %o', (env, message) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(message);
  });
});

describe('YAML mode', () => {
  const YAML = `
version: 1
log_level: warn
workspaces:
  mobile:
    name: Mobile team
    instance:
      url: ${URL}
      token: \${MY_AGILITY_TOKEN}
    projects: [Scope:1001]
    include_child_projects: false
    asset_types: { allow: [Story, Defect, Task] }
    generic_query: false
    limits: { max_limit: 40, call_budget: 200 }
  other:
    instance: { url: ${URL}, token: "\${keychain:agility/ann}" }
`;

  it('reads the chosen workspace with environment and keychain references', () => {
    const c = loadConfig(
      { AB_CONFIG: '/cfg.yaml', AB_WORKSPACE: 'mobile', MY_AGILITY_TOKEN: 'FAKE-1' },
      { files: files(YAML) },
    );
    expect(c).toMatchObject({
      kind: 'configured',
      source: 'yaml',
      workspace: { id: 'mobile', name: 'Mobile team' },
      projects: ['Scope:1001'],
      includeChildProjects: false,
      assetTypes: { allow: ['Story', 'Defect', 'Task'], deny: [] },
      genericQuery: false,
      maxRows: 40,
      callBudget: 200,
      logLevel: 'warn',
    });
    expect(c.kind === 'configured' && c.token.reveal()).toBe('FAKE-1');
    const k = loadConfig(
      { AB_CONFIG: '/cfg.yaml', AB_WORKSPACE: 'other' },
      { files: files(YAML), keychain: (s, a) => `FAKE-${s}-${a}` },
    );
    expect(k.kind === 'configured' && k.token.reveal()).toBe('FAKE-agility-ann');
  });

  it('warns when the file is readable by others', () => {
    const warnings: string[] = [];
    loadConfig(
      { AB_CONFIG: '/cfg.yaml', AB_WORKSPACE: 'mobile', MY_AGILITY_TOKEN: 'x' },
      { files: files(YAML, { readable: true }), warn: (m) => warnings.push(m) },
    );
    expect(warnings).toEqual([expect.stringContaining('chmod 600')]);
  });

  it.each([
    ['several workspaces without AB_WORKSPACE', {}, YAML, /set AB_WORKSPACE/],
    ['an unknown workspace', { AB_WORKSPACE: 'nope' }, YAML, /"nope" is not in AB_CONFIG/],
    ['a missing environment reference', { AB_WORKSPACE: 'mobile' }, YAML, /MY_AGILITY_TOKEN is not set/],
    [
      'an unknown key',
      {},
      'version: 1\nworkspaces:\n  a:\n    instance: { url: x, token: y }\n    projcts: []\n',
      /Unrecognized key|projcts/,
    ],
    ['a wrong version', {}, 'version: 2\nworkspaces: {}\n', /version/],
    ['invalid YAML', {}, 'version: 1\nworkspaces: [', /not valid YAML/],
    [
      'an alias bomb',
      {},
      `version: 1\na: &a [x,x,x,x,x,x,x,x,x]\nb: &b [${'*a,'.repeat(60)}*a]\n`,
      /not valid YAML|alias/i,
    ],
    ['an env-mode variable next to AB_CONFIG', { AB_AGILITY_TOKEN: 'x' }, YAML, /must not be/],
  ])('refuses %s', (_name, env, text, message) => {
    expect(() => loadConfig({ AB_CONFIG: '/cfg.yaml', ...env }, { files: files(text) })).toThrow(message);
  });

  it('refuses files over 1 MiB and missing files', () => {
    expect(() => loadConfig({ AB_CONFIG: '/cfg.yaml' }, { files: files('', { bytes: 2_000_000 }) })).toThrow(
      /larger than 1 MiB/,
    );
    expect(() => loadConfig({ AB_CONFIG: '/missing.yaml' }, { files: files('') })).toThrow(/does not exist/);
  });
});
