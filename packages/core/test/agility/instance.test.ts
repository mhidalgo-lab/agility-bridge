// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { canonicalInstanceUrl, parseXml } from '../../src/index.ts';

describe('canonicalInstanceUrl', () => {
  it.each([
    ['https://www7.v1host.com/SyntheticInstance/', 'https://www7.v1host.com/SyntheticInstance'],
    ['  https://WWW7.V1HOST.com/SyntheticInstance  ', 'https://www7.v1host.com/SyntheticInstance'],
    ['https://agility.example.com', 'https://agility.example.com'],
    ['https://agility.example.com:8443/a/b//', 'https://agility.example.com:8443/a/b'],
    ['http://127.0.0.1:8080/Inst', 'http://127.0.0.1:8080/Inst'],
    ['http://localhost/Inst', 'http://localhost/Inst'],
  ])('%s → %s', (input, out) => expect(canonicalInstanceUrl(input)).toBe(out));

  it.each([
    'http://agility.example.com/Inst',
    'ftp://agility.example.com/',
    'https://user:pw@agility.example.com/Inst',
    'https://agility.example.com/Inst?x=1',
    'https://agility.example.com/Inst?',
    'https://agility.example.com/Inst#top',
    'not a url',
  ])('refuses %s', (input) => expect(() => canonicalInstanceUrl(input)).toThrow(/instance URL/));
});

describe('parseXml', () => {
  it('reads elements, attributes and text', () => {
    const root = parseXml(
      '<Asset href="/x" id="Story:1001"><Attribute name="Name">A &amp; B</Attribute></Asset>',
    );
    expect(root.name).toBe('Asset');
    expect(root.attributes['id']).toBe('Story:1001');
    expect(root.children[0]?.text).toBe('A & B');
  });

  it.each([
    ['billion laughs', '<!DOCTYPE l [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><r>&b;</r>'],
    ['external entity', '<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>'],
    ['undeclared entity', '<r>&nope;</r>'],
    ['malformed', '<r><a></r>'],
    ['too deep', `${'<a>'.repeat(70)}${'</a>'.repeat(70)}`],
  ])('refuses %s', (_n, xml) => expect(() => parseXml(xml)).toThrow(/could not be read/));
});
