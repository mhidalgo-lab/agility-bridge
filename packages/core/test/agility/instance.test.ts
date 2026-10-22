// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { addressClass, canonicalInstanceUrl, parseXml } from '../../src/index.ts';

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

describe('instance URL policy (P2-19)', () => {
  it('refuses plain-HTTP loopback when servers turn it off', () => {
    expect(canonicalInstanceUrl('http://127.0.0.1:8080/X')).toBe('http://127.0.0.1:8080/X');
    for (const u of ['http://127.0.0.1:8080/X', 'http://localhost/X', 'http://[::1]/X']) {
      expect(() => canonicalInstanceUrl(u, { httpLoopback: false })).toThrow(/https/);
    }
    expect(canonicalInstanceUrl('https://127.0.0.1/X', { httpLoopback: false })).toBe('https://127.0.0.1/X');
  });

  it('classifies address literals: loopback, private, link-local (metadata), public', () => {
    const cases: [string, string][] = [
      ['127.0.0.1', 'loopback'],
      ['127.8.9.10', 'loopback'],
      ['10.1.2.3', 'private'],
      ['172.16.0.1', 'private'],
      ['172.31.255.255', 'private'],
      ['172.32.0.1', 'public'],
      ['192.168.1.1', 'private'],
      ['100.64.0.1', 'private'],
      ['169.254.169.254', 'link-local'],
      ['0.0.0.0', 'unspecified'],
      ['224.0.0.1', 'reserved'],
      ['8.8.8.8', 'public'],
      ['::1', 'loopback'],
      ['[::1]', 'loopback'],
      ['::', 'unspecified'],
      ['fd00::1', 'private'],
      ['fe80::1', 'link-local'],
      ['::ffff:127.0.0.1', 'loopback'],
      ['::ffff:10.0.0.1', 'private'],
      ['::ffff:a9fe:a9fe', 'link-local'],
      ['2001:db8::1', 'reserved'],
      ['2606:4700::1111', 'public'],
      ['999.1.1.1', 'invalid'],
      ['example.com', 'invalid'],
      ['fe80::1%eth0', 'invalid'],
      // P3-11 review: IPv4 embedded in IPv6, site-local, discard, and special IPv4 ranges.
      ['::7f00:1', 'loopback'],
      ['64:ff9b::7f00:1', 'loopback'],
      ['64:ff9b::a9fe:a9fe', 'link-local'],
      ['64:ff9b::808:808', 'public'],
      ['2002:7f00:1::1', 'loopback'],
      ['2002:a00:1::1', 'private'],
      ['::ffff:0:7f00:1', 'loopback'],
      ['fec0::1', 'private'],
      ['100::1', 'reserved'],
      ['192.0.0.192', 'reserved'],
      ['198.18.0.1', 'reserved'],
      ['192.0.2.1', 'reserved'],
      ['198.51.100.1', 'reserved'],
      ['203.0.113.7', 'reserved'],
    ];
    for (const [ip, kind] of cases) expect(addressClass(ip), ip).toBe(kind);
  });
});
