// SPDX-License-Identifier: Apache-2.0
// Property and fuzz tests for the parsers that take text from outside the trust boundary (P9-01, THREAT_MODEL T4, T8,
// T35, A1, A9): seeded and replayable (L-123). Each property states what must hold for *any* input, so a regression
// shows up as a counter-example with a seed instead of a hand-picked case that nobody thought of.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AbError,
  addressClass,
  canonicalInstanceUrl,
  decodeCursor,
  formatRows,
  htmlToText,
  parseAssetRef,
  parseAssetType,
  parseXml,
  REDACTED,
  redact,
} from '../src/index.ts';
import { propertyParams } from './harness/property.ts';
import { makeContext } from './helpers/context.ts';

/** Text that leans on the characters parsers care about, mixed with arbitrary unicode. */
const nasty = fc.oneof(
  fc.string({ maxLength: 120 }),
  fc.string({ unit: 'binary', maxLength: 60 }),
  fc
    .array(
      fc.constantFrom(
        '<',
        '>',
        '/',
        '"',
        "'",
        '=',
        '&',
        ';',
        ' ',
        '\n',
        '\0',
        '‮',
        '​',
        '<script>',
        '</script>',
        '<!--',
        '-->',
        '<![CDATA[',
        ']]>',
        '<!DOCTYPE x [<!ENTITY a "b">]>',
        'javascript:',
        'data:',
        'onerror=',
        '<a href="',
        '<img src=x onerror=alert(1)>',
        '%00',
        '..',
        '@',
        '#',
        '?',
      ),
      { maxLength: 24 },
    )
    .map((parts) => parts.join('')),
);

const params = propertyParams(300);

describe('fuzz: rich text to plain text (A1)', () => {
  it('never throws and never lets a script, handler or script-scheme link through', () => {
    fc.assert(
      fc.property(nasty, (input) => {
        const out = htmlToText(input);
        expect(typeof out).toBe('string');
        // Entities can legitimately decode to angle brackets as plain text; tags in the input never survive as tags.
        const noEntities = input.replaceAll('&', ' ');
        const clean = htmlToText(noEntities);
        expect(clean.toLowerCase()).not.toMatch(/<\s*script/);
        expect(clean.toLowerCase()).not.toMatch(/\]\((?:\s*)(?:javascript|data|vbscript):/);
        expect(clean).not.toMatch(/\bon[a-z]+\s*=\s*["']?alert/i);
      }),
      params,
    );
  });

  it('stays fast on hostile repetitions', () => {
    const unit = fc.constantFrom('<', '<a ', '<!--', '&#', '<![CDATA[', '<p><p><p>', '<ul><li>');
    fc.assert(
      fc.property(unit, fc.integer({ min: 2000, max: 20_000 }), (u, n) => {
        const start = performance.now();
        htmlToText(u.repeat(n));
        expect(performance.now() - start).toBeLessThan(1500);
      }),
      { ...params, numRuns: 30 },
    );
  });
});

describe('fuzz: secret redaction (T8)', () => {
  const secretBody = fc.stringMatching(/^[A-Za-z0-9]{16,48}$/);
  const secrets: ReadonlyArray<(body: string) => string> = [
    (b) => `ab_live_${b}`,
    (b) => `ab_admin_${b}`,
    (b) => `Bearer ${b}`,
    (b) => `Authorization: Basic ${b}`,
    (b) => `api_key=${b}`,
    (b) => `AB_MASTER_KEY=${b}`,
    (b) => `__Host-ab_session=${b}`,
  ];

  it('removes a planted secret wherever it sits in arbitrary text, and is idempotent', () => {
    fc.assert(
      fc.property(
        nasty,
        nasty,
        secretBody,
        fc.integer({ min: 0, max: secrets.length - 1 }),
        (before, after, body, which) => {
          const text = `${before}\n${(secrets[which] as (b: string) => string)(body)}\n${after}`;
          const out = redact(text);
          expect(out).not.toContain(body);
          expect(out).toContain(REDACTED);
          expect(redact(out)).toBe(out);
        },
      ),
      params,
    );
  });

  it('never throws and runs in bounded time on arbitrary input', () => {
    fc.assert(
      fc.property(nasty, (input) => {
        const start = performance.now();
        redact(input.repeat(40));
        expect(performance.now() - start).toBeLessThan(1500);
      }),
      { ...params, numRuns: 60 },
    );
  });
});

describe('fuzz: instance URLs and addresses (A9, T11)', () => {
  it('either refuses with a typed error or returns a canonical https (or loopback http) origin without credentials', () => {
    fc.assert(
      fc.property(nasty, (input) => {
        let out: string;
        try {
          out = canonicalInstanceUrl(input, { httpLoopback: false });
        } catch (error) {
          expect(error).toBeInstanceOf(AbError);
          return;
        }
        const url = new URL(out);
        expect(url.protocol).toBe('https:');
        expect([url.username, url.password, url.search, url.hash]).toEqual(['', '', '', '']);
        expect(out.endsWith('/')).toBe(false);
        expect(canonicalInstanceUrl(out, { httpLoopback: false })).toBe(out);
      }),
      params,
    );
  });

  it('refuses every userinfo, query and fragment smuggled behind a valid host', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('@evil.example', '?x=1', '#frag', '/p?x', '/p#x', ':pw@evil.example'),
        fc.domain(),
        (suffix, host) => {
          const input =
            suffix.startsWith('@') || suffix.startsWith(':')
              ? `https://user${suffix}/`
              : `https://${host}${suffix}`;
          expect(() => canonicalInstanceUrl(input)).toThrow(AbError);
        },
      ),
      params,
    );
  });

  it('classifies any text without throwing, and never calls a private IPv4 literal public', () => {
    fc.assert(
      fc.property(nasty, (input) => {
        expect(typeof addressClass(input)).toBe('string');
      }),
      params,
    );
    const octet = fc.integer({ min: 0, max: 255 });
    fc.assert(
      fc.property(octet, octet, octet, (b, c, d) => {
        expect(addressClass(`10.${b}.${c}.${d}`)).toBe('private');
        expect(addressClass(`127.${b}.${c}.${d}`)).toBe('loopback');
        expect(addressClass(`169.254.${c}.${d}`)).toBe('link-local');
        expect(addressClass(`192.168.${c}.${d}`)).toBe('private');
        expect(addressClass(`::ffff:10.${b}.${c}.${d}`)).not.toBe('public');
      }),
      params,
    );
  });
});

describe('fuzz: asset references (A4)', () => {
  it('accepts only a number or an OID token, never throws anything but a typed error', () => {
    fc.assert(
      fc.property(nasty, (input) => {
        try {
          const ref = parseAssetRef(input);
          if (ref.kind === 'number') expect(ref.number).toMatch(/^[A-Z]{1,4}-\d{1,9}$/);
          else expect(ref.oid).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,63}:\d{1,12}$/);
        } catch (error) {
          expect(error).toBeInstanceOf(AbError);
        }
      }),
      params,
    );
  });
});

describe('fuzz: XML from Agility (A1, T35)', () => {
  it('returns an element or a typed error for any text, and always refuses a document type', () => {
    fc.assert(
      fc.property(nasty, (input) => {
        try {
          parseXml(input);
        } catch (error) {
          expect(error).toBeInstanceOf(AbError);
        }
      }),
      params,
    );
    fc.assert(
      fc.property(nasty, (entity) => {
        expect(() => parseXml(`<!DOCTYPE a [<!ENTITY x "${entity}">]><a>&x;</a>`)).toThrow(AbError);
      }),
      params,
    );
  });

  it('refuses nesting beyond the depth limit instead of recursing', () => {
    fc.assert(
      fc.property(fc.integer({ min: 65, max: 400 }), (depth) => {
        expect(() => parseXml(`${'<a>'.repeat(depth)}${'</a>'.repeat(depth)}`)).toThrow(AbError);
      }),
      { ...params, numRuns: 40 },
    );
  });
});

describe('fuzz: CSV output (T6)', () => {
  it('no cell starts as a spreadsheet formula, whatever the value', () => {
    fc.assert(
      fc.property(nasty, (value) => {
        const out = formatRows([{ name: value, other: 'x' }], { format: 'csv' });
        // The body is a header line and one row; a quoted cell may span lines, so read the cell the way a sheet would.
        const body = out.body.slice(out.body.indexOf('\n') + 1);
        const first = body.startsWith('"') ? body.slice(1) : body;
        expect(first).not.toMatch(/^[=+@\t\r]/);
        if (/^-/.test(first)) expect(first).toMatch(/^-\d/);
      }),
      params,
    );
  });
});

describe('fuzz: pagination cursors (T3, T4)', () => {
  it('refuses any arbitrary string as a cursor with the one typed error', async () => {
    const ctx = makeContext({ clock: { now: () => Date.UTC(2026, 9, 21) } });
    await fc.assert(
      fc.asyncProperty(nasty, async (cursor) => {
        await expect(decodeCursor(ctx, cursor, 'binding')).rejects.toBeInstanceOf(AbError);
      }),
      params,
    );
  });
});

describe('fuzz: instance metadata (A12)', () => {
  it('keeps only valid identifiers, whatever JSON the instance sends', () => {
    fc.assert(
      fc.property(
        fc.anything({ maxDepth: 4 }),
        fc.string({ maxLength: 40 }),
        fc.string({ maxLength: 40 }),
        (json, typeName, attr) => {
          for (const body of [
            json,
            {
              Token: typeName,
              Attributes: { a: { Name: attr, AttributeType: 'Text' } },
              Operations: { o: { Name: attr } },
            },
          ]) {
            try {
              const meta = parseAssetType(body);
              expect(meta.name).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
              for (const name of meta.attributes.keys()) expect(name).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,99}$/);
              for (const op of meta.operations) expect(op).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,99}$/);
            } catch (error) {
              expect(error).toBeInstanceOf(AbError);
            }
          }
        },
      ),
      params,
    );
  });
});
