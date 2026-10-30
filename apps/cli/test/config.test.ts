// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { ConfigError, type FileAccess, type KeychainReader, loadConfig } from '../src/config.ts';

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

  it('keeps the attachment download off by default, with the text types and a 1 MiB cap (D-08)', () => {
    const c = loadConfig({ AB_AGILITY_URL: URL, AB_AGILITY_TOKEN: 'x' });
    expect(c).toMatchObject({
      attachmentDownload: false,
      attachmentMaxBytes: 1_048_576,
      attachmentTypes: ['text/plain', 'text/markdown', 'text/csv', 'application/json'],
    });
  });

  it('reads the attachment settings and refuses types that run or render in a client', () => {
    const base = { AB_AGILITY_URL: URL, AB_AGILITY_TOKEN: 'x' };
    expect(
      loadConfig({
        ...base,
        AB_ATTACHMENT_DOWNLOAD: 'on',
        AB_ATTACHMENT_MAX_BYTES: '4096',
        AB_ATTACHMENT_TYPES: 'text/plain, Text/Log',
      }),
    ).toMatchObject({
      attachmentDownload: true,
      attachmentMaxBytes: 4_096,
      attachmentTypes: ['text/plain', 'text/log'],
    });
    for (const [env, message] of [
      [{ AB_ATTACHMENT_TYPES: 'text/html' }, /runs or renders/],
      [{ AB_ATTACHMENT_TYPES: 'image/svg+xml' }, /runs or renders/],
      [{ AB_ATTACHMENT_TYPES: '*/*' }, /invalid content type/],
      [{ AB_ATTACHMENT_TYPES: 'text' }, /invalid content type/],
      [{ AB_ATTACHMENT_MAX_BYTES: '100000000' }, /from 1024 to 8388608/],
      [{ AB_ATTACHMENT_DOWNLOAD: 'maybe' }, /on or off/],
    ] as const) {
      expect(() => loadConfig({ ...base, ...env })).toThrow(message);
    }
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
    attachments: { download: true, max_bytes: 2048, types: [text/plain] }
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
      attachmentDownload: true,
      attachmentMaxBytes: 2_048,
      attachmentTypes: ['text/plain'],
      maxRows: 40,
      callBudget: 200,
      logLevel: 'warn',
    });
    expect(c.kind === 'configured' && c.token.reveal()).toBe('FAKE-1');
    const k = loadConfig(
      { AB_CONFIG: '/cfg.yaml', AB_WORKSPACE: 'other' },
      { files: files(YAML), keychain: (s, a) => `FAKE-${s}-${a}`, keychainHost: () => 'agility.example.com' },
    );
    expect(k.kind === 'configured' && k.token.reveal()).toBe('FAKE-agility-ann');
  });

  describe('a keychain token named in the file is sent only to the host it was stored for (P8-42, T8, T23)', () => {
    const env = { AB_CONFIG: '/cfg.yaml', AB_WORKSPACE: 'other' };
    const secrets: string[] = [];
    const keychain: KeychainReader = (s, a) => {
      secrets.push(`${s}/${a}`);
      return 'FAKE-SECRET';
    };

    it('loads when the stored host is the instance host, for the default and for any other service', () => {
      const own = loadConfig(env, {
        files: files(YAML),
        keychain,
        keychainHost: () => 'agility.example.com',
      });
      expect(own.kind).toBe('configured');
      const other = loadConfig(env, {
        files: files(YAML.replace('agility/ann', 'corp/ann')),
        keychain,
        keychainHost: (s, a) => (s === 'corp' && a === 'ann' ? 'agility.example.com' : 'wrong.example.net'),
      });
      expect(other.kind).toBe('configured');
    });

    it('refuses a different host before the secret is read, naming the command that confirms it', () => {
      secrets.length = 0;
      expect(() =>
        loadConfig(env, { files: files(YAML), keychain, keychainHost: () => 'evil.example.net' }),
      ).toThrow(
        /workspaces\.other\.instance\.token: keychain:agility\/ann was stored for evil\.example\.net, but workspaces\.other\.instance\.url points at agility\.example\.com.*keychain bind agility\/ann --for-url/s,
      );
      expect(secrets).toEqual([]);
    });

    it('treats a different port as a different host and compares case-insensitively', () => {
      expect(() =>
        loadConfig(env, { files: files(YAML), keychain, keychainHost: () => 'agility.example.com:8443' }),
      ).toThrow(/stored for agility\.example\.com:8443/);
      const c = loadConfig(env, { files: files(YAML), keychain, keychainHost: () => 'agility.example.com' });
      expect(c.kind).toBe('configured');
    });

    it('checks every reference of the token value, not only the first', () => {
      const body = YAML.replace('${keychain:agility/ann}', '${keychain:ann}-${keychain:corp/other}');
      expect(() =>
        loadConfig(env, {
          files: files(body),
          keychain,
          keychainHost: (s) => (s === 'corp' ? 'evil.example.net' : 'agility.example.com'),
        }),
      ).toThrow(/keychain:corp\/other was stored for evil\.example\.net/);
    });

    it('warns about an entry stored without a host and still loads it (D-308)', () => {
      const warnings: string[] = [];
      const c = loadConfig(env, {
        files: files(YAML),
        keychain,
        keychainHost: () => undefined,
        warn: (m) => warnings.push(m),
      });
      expect(c.kind).toBe('configured');
      expect(
        warnings.some(
          (w) => w.includes('keychain:agility/ann is not bound') && w.includes('keychain bind agility/ann'),
        ),
      ).toBe(true);
    });

    it('does not look at bindings for a token that names no keychain entry', () => {
      let reads = 0;
      const c = loadConfig(
        { AB_CONFIG: '/cfg.yaml', AB_WORKSPACE: 'mobile', MY_AGILITY_TOKEN: 'FAKE-1' },
        {
          files: files(YAML),
          keychainHost: () => {
            reads++;
            return 'evil.example.net';
          },
        },
      );
      expect(c.kind).toBe('configured');
      expect(reads).toBe(0);
    });
  });

  it('warns on stderr when a setting only a remote host reads is set for stdio (Q-7)', () => {
    const warnings: string[] = [];
    loadConfig(
      {
        AB_AGILITY_URL: URL,
        AB_AGILITY_TOKEN: '1.x',
        AB_QUOTA_DAILY: '200',
        AB_OTEL_ENDPOINT: 'https://o.example/v1',
      },
      { warn: (m) => warnings.push(m) },
    );
    expect(warnings).toEqual([
      expect.stringMatching(/AB_QUOTA_DAILY, AB_OTEL_ENDPOINT are read by a remote host only/),
    ]);
    const none: string[] = [];
    loadConfig({ AB_AGILITY_URL: URL, AB_AGILITY_TOKEN: '1.x' }, { warn: (m) => none.push(m) });
    expect(none).toEqual([]);
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
    ['an attachment variable next to AB_CONFIG', { AB_ATTACHMENT_DOWNLOAD: 'on' }, YAML, /must not be/],
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

describe('Phase 1 review (M3 and lows)', () => {
  const ws = (body: string) => `version: 1\nworkspaces:\n  a:\n${body}`;
  it.each([
    [
      'the instance URL',
      `    instance: { url: "https://\${AWS_SECRET_ACCESS_KEY}.evil.example", token: x }\n`,
    ],
    ['the name', `    name: "\${keychain:other/secret}"\n    instance: { url: ${URL}, token: x }\n`],
    ['the CA file', `    instance: { url: ${URL}, token: x, ca_file: "/tmp/\${HOME}" }\n`],
  ])('refuses references outside the token (%s)', (_where, body) => {
    expect(() =>
      loadConfig(
        { AB_CONFIG: '/cfg.yaml', AWS_SECRET_ACCESS_KEY: 'FAKE', HOME: '/h' },
        { files: files(ws(body)), keychain: () => 'FAKE' },
      ),
    ).toThrow(/allowed only in instance.token/);
  });

  it('keeps an escaped $${ literal in the token', () => {
    const c = loadConfig(
      { AB_CONFIG: '/cfg.yaml' },
      { files: files(ws(`    instance: { url: ${URL}, token: "FAKE-$\${NOT_A_REF}" }\n`)) },
    );
    expect(c.kind === 'configured' && c.token.reveal()).toBe(`FAKE-\${NOT_A_REF}`);
  });

  it('refuses an explicitly empty project list instead of reading it as every project', () => {
    expect(() => loadConfig({ AB_AGILITY_URL: URL, AB_AGILITY_TOKEN: 'x', AB_PROJECTS: ' , ' })).toThrow(
      /AB_PROJECTS is set but empty/,
    );
    expect(() =>
      loadConfig(
        { AB_CONFIG: '/cfg.yaml' },
        { files: files(ws(`    instance: { url: ${URL}, token: x }\n    projects: []\n`)) },
      ),
    ).toThrow(/projects is empty/);
  });
});
