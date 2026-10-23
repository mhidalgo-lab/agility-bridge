// SPDX-License-Identifier: Apache-2.0
// The session settings (P4-02), parsed by both hosts: defaults, ranges, and errors that name the variable only.
import { describe, expect, it } from 'vitest';
import { parseServerSettings, SERVER_SETTING_NAMES, SettingsError } from '../src/index.ts';

const defaults = { callBudget: 1_000, maxResponseBytes: 8 * 1024 * 1024 };
const parse = (env: Record<string, string>) => parseServerSettings(env, defaults).session;

describe('AB_SESSION_* and AB_LOGOUT_CLEAR_SITE_DATA', () => {
  it('default to 30 minutes idle, 12 hours, 20 sessions, and Clear-Site-Data on', () => {
    expect(parse({})).toEqual({
      timeouts: { idleMs: 30 * 60_000, absoluteMs: 12 * 3_600_000 },
      maxPerUser: 20,
      clearSiteData: true,
    });
  });

  it('are read as given', () => {
    expect(
      parse({
        AB_SESSION_IDLE_MINUTES: '10',
        AB_SESSION_MAX_HOURS: '2',
        AB_SESSION_MAX_PER_USER: '3',
        AB_LOGOUT_CLEAR_SITE_DATA: 'off',
      }),
    ).toEqual({ timeouts: { idleMs: 600_000, absoluteMs: 7_200_000 }, maxPerUser: 3, clearSiteData: false });
  });

  it('refuse bad values naming the variable and never echoing the value', () => {
    for (const [name, value] of [
      ['AB_SESSION_IDLE_MINUTES', '4'],
      ['AB_SESSION_IDLE_MINUTES', '1441'],
      ['AB_SESSION_IDLE_MINUTES', 'soon-secret'],
      ['AB_SESSION_MAX_HOURS', '0'],
      ['AB_SESSION_MAX_HOURS', '169'],
      ['AB_SESSION_MAX_PER_USER', '0'],
      ['AB_SESSION_MAX_PER_USER', '101'],
      ['AB_LOGOUT_CLEAR_SITE_DATA', 'storage-secret'],
    ] as const) {
      try {
        parse({ [name]: value });
        throw new Error(`accepted ${name}=${value}`);
      } catch (error) {
        expect(error).toBeInstanceOf(SettingsError);
        expect((error as Error).message).toContain(name);
        expect((error as Error).message).not.toContain('secret');
      }
    }
  });

  it('refuse an idle timeout longer than the session lifetime', () => {
    expect(() => parse({ AB_SESSION_IDLE_MINUTES: '180', AB_SESSION_MAX_HOURS: '2' })).toThrow(
      /AB_SESSION_IDLE_MINUTES must not exceed AB_SESSION_MAX_HOURS/,
    );
  });

  it('are known settings, so a typo is caught', () => {
    for (const name of [
      'AB_SESSION_IDLE_MINUTES',
      'AB_SESSION_MAX_HOURS',
      'AB_SESSION_MAX_PER_USER',
      'AB_LOGOUT_CLEAR_SITE_DATA',
    ]) {
      expect(SERVER_SETTING_NAMES).toContain(name);
    }
  });
});
