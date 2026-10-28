// SPDX-License-Identifier: Apache-2.0
// P6-04: the stdio server offers `get_attachment` only when AB_ATTACHMENT_DOWNLOAD is on (D-08, THREAT_MODEL A8), and
// the context it builds carries the same switch, so a handler reached any other way refuses too.

import { CORE_TOOLS } from '@agility-bridge/core';
import { describe, expect, it } from 'vitest';
import { loadConfig, type StdioConfig } from '../src/config.ts';
import { contextFactory, hiddenTools, STDIO_GROUPS, selectTools } from '../src/stdio.ts';

const URL = 'https://agility.example.com/SyntheticInstance';
const base = { AB_AGILITY_URL: URL, AB_AGILITY_TOKEN: 'FAKE-token' };
const config = (env: Record<string, string> = {}) => loadConfig({ ...base, ...env }) as StdioConfig;
const names = (c: StdioConfig) => selectTools(c).map((t) => t.name);

describe('stdio serves every tool group the catalogue has (P6-13)', () => {
  it('has no group in the core catalogue that STDIO_GROUPS leaves out, and offers the history tools by default', () => {
    const groups = new Set(CORE_TOOLS.map((t) => t.group));
    for (const g of groups) expect(STDIO_GROUPS as readonly string[], `group ${g}`).toContain(g);
    expect(names(config())).toEqual(expect.arrayContaining(['get_asset_history', 'list_recent_changes']));
  });
});

describe('stdio composite reports (P6-07, D-101)', () => {
  const REPORTS = [
    'sprint_health',
    'standup_summary',
    'release_readiness',
    'defect_triage',
    'work_item_quality',
  ];

  it('offers no report by default and all five with AB_REPORTS=on', () => {
    for (const r of REPORTS) expect(names(config())).not.toContain(r);
    for (const r of REPORTS) expect(names(config({ AB_REPORTS: 'on' }))).toContain(r);
    expect(names(config({ AB_REPORTS: 'off' }))).not.toContain('sprint_health');
  });

  it('does not offer them in setup mode, and an allowlist naming one cannot bring it back', () => {
    expect(selectTools(loadConfig({})).map((t) => t.name)).not.toContain('sprint_health');
    expect(names(config({ AB_TOOLS: 'whoami,sprint_health' }))).toEqual(['whoami']);
  });

  it('names the reports a low AB_CALL_BUDGET hides, and nothing at the default (P6-36)', () => {
    const low = hiddenTools(config({ AB_REPORTS: 'on', AB_CALL_BUDGET: '10' })).map((t) => t.name);
    expect(low).toContain('sprint_health');
    expect(names(config({ AB_REPORTS: 'on', AB_CALL_BUDGET: '10' }))).not.toContain('sprint_health');
    expect(hiddenTools(config({ AB_REPORTS: 'on' }))).toEqual([]);
    expect(hiddenTools(loadConfig({}))).toEqual([]);
  });

  it('puts the switch into every call context', () => {
    for (const on of [false, true]) {
      const c = config(on ? { AB_REPORTS: 'on' } : {});
      const ctx = contextFactory(
        c,
        { fetch: () => Promise.reject(new Error('no')), logger: undefined as never },
        selectTools(c),
      )();
      expect(ctx.limits.reports).toBe(on);
      expect(ctx.workspace.groups.includes('reports')).toBe(on);
    }
  });
});

describe('stdio attachment download', () => {
  it('offers the collaboration tools, but not get_attachment, by default', () => {
    expect(names(config())).toEqual(expect.arrayContaining(['get_conversations', 'list_attachments']));
    expect(names(config())).not.toContain('get_attachment');
  });

  it('offers get_attachment only with AB_ATTACHMENT_DOWNLOAD=on', () => {
    expect(names(config({ AB_ATTACHMENT_DOWNLOAD: 'on' }))).toContain('get_attachment');
    expect(names(config({ AB_ATTACHMENT_DOWNLOAD: 'off' }))).not.toContain('get_attachment');
  });

  it('does not offer it in setup mode, and an allowlist naming it cannot bring it back', () => {
    expect(selectTools(loadConfig({})).map((t) => t.name)).not.toContain('get_attachment');
    expect(names(config({ AB_TOOLS: 'whoami,get_attachment' }))).toEqual(['whoami']);
  });

  it('puts the switch, the cap and the types into every call context', () => {
    for (const [env, on] of [
      [{}, false],
      [{ AB_ATTACHMENT_DOWNLOAD: 'on', AB_ATTACHMENT_MAX_BYTES: '2048' }, true],
    ] as const) {
      const c = config(env);
      const ctx = contextFactory(
        c,
        { fetch: () => Promise.reject(new Error('no')), logger: undefined as never },
        selectTools(c),
      )();
      expect(ctx.limits.attachmentDownload).toBe(on);
      expect(ctx.limits.attachmentMaxBytes).toBe(on ? 2_048 : 1_048_576);
      expect(ctx.limits.attachmentTypes).toContain('text/plain');
      expect(ctx.workspace.groups.includes('attachments')).toBe(on);
    }
  });
});
