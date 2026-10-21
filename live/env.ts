// SPDX-License-Identifier: Apache-2.0
// P0-12: the live target from AB_LIVE_AGILITY_URL / AB_LIVE_AGILITY_TOKEN (CI: the protected `live` environment) or,
// locally, from ~/.config/agility-bridge/live.env (or AB_LIVE_ENV_FILE). Values are never logged or returned in errors.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LiveTarget } from './readonly-fetch.ts';

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m?.[1] || line.trimStart().startsWith('#')) continue;
    out[m[1]] = (m[2] ?? '').replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/** The live target, or undefined when no credentials are configured (live tests then skip). */
export function liveTarget(env: NodeJS.ProcessEnv = process.env): LiveTarget | undefined {
  let url = env['AB_LIVE_AGILITY_URL'];
  let token = env['AB_LIVE_AGILITY_TOKEN'];
  const file = env['AB_LIVE_ENV_FILE'] ?? join(homedir(), '.config', 'agility-bridge', 'live.env');
  if ((!url || !token) && existsSync(file)) {
    if ((statSync(file).mode & 0o077) !== 0)
      throw new Error(`${file} must not be readable by group or others (chmod 600)`);
    const parsed = parseEnvFile(readFileSync(file, 'utf8'));
    url ||= parsed['AB_LIVE_AGILITY_URL'];
    token ||= parsed['AB_LIVE_AGILITY_TOKEN'];
  }
  return url && token ? { baseUrl: url, token } : undefined;
}
