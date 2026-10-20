// SPDX-License-Identifier: Apache-2.0
// ADR-0002, P0-02: the trademark disclaimer is identical on every public surface.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DISCLAIMER =
  'agility-bridge is an unofficial, community project. It is not affiliated with, endorsed by, or supported by ' +
  'Digital.ai. Digital.ai, Agility and VersionOne are trademarks of their respective owners.';

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
// Line breaks and Markdown emphasis don't count; the words and punctuation do.
const normalise = (text: string): string => text.replace(/[*_]/g, '').replace(/\s+/g, ' ');

describe('trademark disclaimer', () => {
  it.each(['README.md', 'NOTICE', 'apps/cli/README.md', 'docs/adr/0002-name-and-trademark.md'])(
    'appears verbatim in %s',
    (path) => {
      expect(normalise(read(path))).toContain(DISCLAIMER);
    },
  );

  it('is not contradicted by the npm description', () => {
    const pkg = JSON.parse(read('apps/cli/package.json')) as { description: string };
    expect(pkg.description).toMatch(/^Unofficial /);
    expect(pkg.description).not.toMatch(/official (Digital\.ai|Agility)/i);
  });
});
