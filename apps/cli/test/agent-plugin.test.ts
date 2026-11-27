// SPDX-License-Identifier: Apache-2.0
// The Agent Plugins 1.0.0 manifest at the repository root (P9-29, https://agent-plugins.org/specification): plugin.json
// and mcp.json validate against the spec's published schemas (vendored, since the identifiers are never reassigned and
// CI must not fetch them), carry the Claude Code plugin's metadata and settings, pin the CLI's version, and the skills
// the spec discovers in `skills/` are the Claude Code plugin's own files, not copies.
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { checkEnvNames } from '../src/config.ts';
import {
  AGENT_PLUGIN_MANIFEST,
  AGENT_PLUGIN_MCP,
  AGENT_PLUGINS_SPEC_VERSION,
  agentPluginMcpJson,
  PLUGIN_PATH,
} from '../src/plugin-mcp.ts';

const ROOT = new URL('../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');
const readJson = (path: string) => JSON.parse(read(path)) as Record<string, unknown>;
const SCHEMA_DIR = `docs/schemas/agent-plugins/${AGENT_PLUGINS_SPEC_VERSION}`;
const SCHEMA_BASE = `https://agent-plugins.org/schemas/${AGENT_PLUGINS_SPEC_VERSION}`;
const EXTENSION = 'io.github.mhidalgo-lab.agility-bridge';

type Setting = Record<string, unknown> & { env?: string };
const manifest = () => readJson(AGENT_PLUGIN_MANIFEST);
const claudeManifest = () => readJson(`${PLUGIN_PATH}/.claude-plugin/plugin.json`);
const settings = () =>
  (manifest()['extensions'] as Record<string, { userConfig: Record<string, Setting> }>)[EXTENSION]
    ?.userConfig ?? {};

function validator(file: 'plugin' | 'mcp') {
  const schema = readJson(`${SCHEMA_DIR}/${file}.schema.json`);
  expect(schema['$id']).toBe(`${SCHEMA_BASE}/${file}.schema.json`);
  return new Ajv2020({ allErrors: true, strict: true }).compile(schema);
}

describe('the Agent Plugins manifest (P9-29)', () => {
  it('plugin.json validates against the published 1.0.0 schema', () => {
    const validate = validator('plugin');
    expect(validate(manifest()), JSON.stringify(validate.errors)).toBe(true);
    expect(manifest()['$schema']).toBe(`${SCHEMA_BASE}/plugin.schema.json`);
    expect(manifest()['name']).toBe('agility-bridge');
  });

  it('mcp.json validates, uses the same spec version and is the generated file', () => {
    const validate = validator('mcp');
    const mcp = readJson(AGENT_PLUGIN_MCP);
    expect(validate(mcp), JSON.stringify(validate.errors)).toBe(true);
    expect(mcp['$schema']).toBe(`${SCHEMA_BASE}/mcp.schema.json`);
    expect(read(AGENT_PLUGIN_MCP)).toBe(agentPluginMcpJson(pkg.version));
  });

  it('a manifest the schema would reject is rejected (the check is live)', () => {
    const validate = validator('plugin');
    expect(validate({ ...manifest(), userConfig: {} })).toBe(false);
    expect(validate({ ...manifest(), name: 'Agility Bridge' })).toBe(false);
  });

  it('versions match the CLI package, server.json and the Claude Code plugin', () => {
    const server = readJson('server.json');
    expect(manifest()['version']).toBe(pkg.version);
    expect(manifest()['version']).toBe(server['version']);
    expect(manifest()['version']).toBe(claudeManifest()['version']);
    expect(read(AGENT_PLUGIN_MCP)).toContain(`"agility-bridge@${pkg.version}"`);
  });

  it('carries the Claude Code manifest metadata unchanged', () => {
    for (const key of ['description', 'author', 'homepage', 'repository', 'license', 'keywords']) {
      expect(manifest()[key], key).toEqual(claudeManifest()[key]);
    }
  });

  it('describes the Claude Code settings, the token sensitive and non-expiring, each with the variable it feeds', () => {
    const ours = settings();
    const claude = claudeManifest()['userConfig'] as Record<string, Setting>;
    expect(Object.keys(ours).sort()).toEqual(Object.keys(claude).sort());
    for (const [key, { env, ...rest }] of Object.entries(ours)) expect(rest, key).toEqual(claude[key]);
    expect(ours['agility_token']).toMatchObject({ required: true, sensitive: true, env: 'AB_AGILITY_TOKEN' });
    expect(String(ours['agility_token']?.['description'])).toMatch(/does not expire/);
    expect(ours['agility_url']).toMatchObject({ required: true, env: 'AB_AGILITY_URL' });
    const names = Object.values(ours).map((s) => s.env as string);
    expect(() => checkEnvNames(Object.fromEntries(names.map((n) => [n, 'x'])))).not.toThrow();
  });

  it('mcp.json holds no secret and no user value: the spec forbids secrets in env', () => {
    const server = (readJson(AGENT_PLUGIN_MCP)['mcpServers'] as Record<string, Record<string, unknown>>)[
      'agility'
    ];
    expect(server).toEqual({ type: 'stdio', command: 'npx', args: ['-y', `agility-bridge@${pkg.version}`] });
  });

  it('skills/ is a link to the Claude Code plugin skills, inside the root, one SKILL.md per skill', () => {
    expect(lstatSync(join(ROOT, 'skills')).isSymbolicLink()).toBe(true);
    const target = realpathSync(join(ROOT, 'skills'));
    expect(target).toBe(realpathSync(join(ROOT, PLUGIN_PATH, 'skills')));
    expect(relative(realpathSync(ROOT), target).startsWith('..')).toBe(false);
    const skills = readdirSync(target).filter((d) => statSync(join(target, d)).isDirectory());
    expect(skills.sort()).toEqual(['agility-conduct', 'agility-workflows']);
    for (const s of skills) {
      expect(statSync(join(target, s, 'SKILL.md')).isFile()).toBe(true);
      expect(read(`skills/${s}/SKILL.md`)).toMatch(new RegExp(`^---\\nname: ${s}\\n`));
    }
  });
});
