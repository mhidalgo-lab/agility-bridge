// SPDX-License-Identifier: Apache-2.0
// P0-06: read-only probes of Agility's API against the owner's third-party tenant (D-01). Every request goes through the
// P0-12 guard (live/readonly-fetch.ts). Output: shapes, counts, booleans, timings, product attribute names and number
// prefixes only; never content, custom attribute names, ids or the instance URL. Raw output goes to the git-ignored
// results/ folder. Errors are limited to a handful of single requests; no rate-limit or quota probing.
// Usage: node spikes/agility-api/probe.ts
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { liveTarget } from '../../live/env.ts';
import { type LiveFetch, readOnlyFetch } from '../../live/readonly-fetch.ts';
import { shape } from '../../live/shape.ts';

const target = liveTarget();
if (!target) {
  console.error('no live target configured');
  process.exit(2);
}
const live: LiveFetch = readOnlyFetch(target);
const out: Record<string, unknown> = { date: new Date().toISOString() };
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function q(body: unknown, endpoint = 'query.v1') {
  const t0 = performance.now();
  const res = await live(endpoint, { method: 'POST', body });
  const text = await res.text();
  const ms = Math.round(performance.now() - t0);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  await pause(150); // gentle on a tenant we do not own
  return {
    status: res.status,
    ms,
    bytes: text.length,
    contentType: res.headers.get('content-type'),
    json,
    text,
  };
}
const rows = (j: unknown, i = 0): unknown[] =>
  Array.isArray(j) && Array.isArray(j[i]) ? (j[i] as unknown[]) : [];
/** Error body shape without values (messages may echo tenant data). */
const errShape = (r: { json: unknown; text: string }) =>
  r.json !== undefined ? shape(r.json) : `text(${r.text.length})`;

async function meta(path: string) {
  const t0 = performance.now();
  const res = await live(`meta.v1/${path}`, { accept: 'application/json' });
  const text = await res.text();
  await pause(150);
  return {
    status: res.status,
    ms: Math.round(performance.now() - t0),
    bytes: text.length,
    headers: Object.fromEntries(
      ['etag', 'last-modified', 'cache-control'].map((h) => [h, res.headers.get(h)]),
    ),
    json: JSON.parse(text) as {
      Version?: string;
      Attributes?: Record<
        string,
        { Name?: string; AttributeType?: string; RelatedAsset?: unknown; IsMultivalue?: boolean }
      >;
      Operations?: Record<string, unknown>;
      Base?: { nameref?: string };
    },
    sha256: createHash('sha256').update(text).digest('hex').slice(0, 16),
  };
}

// 1. Authentication.
{
  const ok = await q({ from: 'Member', select: ['ID'], where: { IsSelf: 'true' } });
  const legacy = await q({ from: 'Member', select: ['ID'], where: { IsSelf: 'true' } }, 'query.legacy.v1');
  const badToken = readOnlyFetch({ ...target, token: `1.${'x'.repeat(28)}=` });
  const bad = await badToken('query.v1', { method: 'POST', body: { from: 'Member', select: ['ID'] } });
  const badText = await bad.text();
  const none = await fetch(
    new URL('query.v1', target.baseUrl.endsWith('/') ? target.baseUrl : `${target.baseUrl}/`),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'Member', select: ['ID'] }),
      redirect: 'manual',
    },
  );
  const noneText = await none.text();
  out['auth'] = {
    queryV1Bearer: { status: ok.status, rows: rows(ok.json).length },
    queryLegacyBearer: { status: legacy.status, rows: rows(legacy.json).length },
    badToken: {
      status: bad.status,
      contentType: bad.headers.get('content-type'),
      wwwAuthenticate: bad.headers.get('www-authenticate'),
      body: badText.length,
    },
    noAuthHeader: {
      status: none.status,
      contentType: none.headers.get('content-type'),
      location: none.headers.has('location'),
      body: noneText.length,
    },
  };
}

// 2. Errors that reads can trigger (one request each).
{
  const unknownType = await q({ from: 'NoSuchAssetType', select: ['Name'] });
  const badAttr = await q({ from: 'Story', select: ['NoSuchAttribute'], page: { start: 0, size: 1 } });
  const badFilter = await q({
    from: 'Story',
    select: ['ID'],
    filter: ["Name='unterminated"],
    page: { start: 0, size: 1 },
  });
  out['errors'] = {
    unknownAssetType: {
      status: unknownType.status,
      contentType: unknownType.contentType,
      shape: errShape(unknownType),
    },
    unknownAttribute: { status: badAttr.status, contentType: badAttr.contentType, shape: errShape(badAttr) },
    malformedFilter: {
      status: badFilter.status,
      contentType: badFilter.contentType,
      shape: errShape(badFilter),
    },
  };
}

// 3. `with` binding: values that would change the filter if they were substituted as text (L-139). A filter that
// matches nothing must keep matching nothing; a value equal to an existing Number must match exactly one row.
{
  const sample = rows(
    (await q({ from: 'Story', select: ['Number'], page: { start: 0, size: 1 } })).json,
  )[0] as { Number?: string } | undefined;
  const number = sample?.Number ?? '';
  const hostile: Record<string, string | string[]> = {
    plain: 'zz-no-such-number',
    singleQuote: "zz'",
    quoteOrInjection: "zz'|Number!='",
    doubleQuoteInjection: 'zz"|Number!="',
    commaList: `zz,${number}`,
    pipeOr: `zz|${number}`,
    semicolonAnd: 'zz;Number!=""',
    parentheses: "zz')|(Number!='",
    brackets: 'zz[Owners]',
    dollarVar: '$other',
    unicode: 'zz-ünïcødé-日本-🙂',
    longString: 'z'.repeat(10_000),
    newline: 'zz\nNumber!=""',
    arrayValue: ['zz-1', 'zz-2'],
    arrayWithReal: ['zz-1', number],
  };
  const results: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(hostile)) {
    const r = await q({
      from: 'Story',
      select: ['ID'],
      filter: ['Number=$v'],
      with: { $v: value },
      page: { start: 0, size: 5 },
    });
    results[name] = {
      status: r.status,
      rows: r.status === 200 ? rows(r.json).length : undefined,
      error: r.status === 200 ? undefined : errShape(r),
    };
  }
  const exact = await q({
    from: 'Story',
    select: ['ID'],
    filter: ['Number=$v'],
    with: { $v: number },
    page: { start: 0, size: 5 },
  });
  results['exactExistingNumber'] = { status: exact.status, rows: rows(exact.json).length };
  // The same hostile value interpolated into the filter text (what callers must never do), for contrast.
  const raw = await q({
    from: 'Story',
    select: ['ID'],
    filter: ["Number='zz'|Number!=''"],
    page: { start: 0, size: 5 },
  });
  results['contrastInterpolatedInjection'] = { status: raw.status, rows: rows(raw.json).length };
  out['withBinding'] = results;
}

// 4. Paging, several queries per call, sort stability, page size.
{
  const multi = await q([
    { from: 'Story', select: ['ID'], page: { start: 0, size: 2 } },
    { from: 'Defect', select: ['ID'], page: { start: 0, size: 3 } },
  ]);
  const p = (start: number, sort: string[]) =>
    q({ from: 'Story', select: ['ID'], sort, page: { start, size: 25 } });
  const ids = (j: unknown) => rows(j).map((r) => (r as { _oid: string })._oid);
  const byOid1 = ids((await p(0, ['ID'])).json);
  const byOid2 = ids((await p(25, ['ID'])).json);
  const byOidAgain = ids((await p(0, ['ID'])).json);
  const byDate1 = ids((await p(0, ['-ChangeDate'])).json);
  const byDateAgain = ids((await p(0, ['-ChangeDate'])).json);
  const sizes: Record<string, unknown> = {};
  for (const size of [100, 500, 1000, 2000]) {
    const r = await q({ from: 'Story', select: ['ID'], page: { start: 0, size } });
    sizes[size] = { status: r.status, rows: rows(r.json).length, ms: r.ms, bytes: r.bytes };
  }
  const noPage = await q({ from: 'Scope', select: ['ID'] });
  out['paging'] = {
    severalQueriesPerCall: {
      status: multi.status,
      resultSets: Array.isArray(multi.json) ? multi.json.length : 0,
      rows: [rows(multi.json, 0).length, rows(multi.json, 1).length],
    },
    pagesDisjointWhenSortedById: byOid1.filter((x) => byOid2.includes(x)).length === 0,
    samePageTwiceById: JSON.stringify(byOid1) === JSON.stringify(byOidAgain),
    samePageTwiceByChangeDate: JSON.stringify(byDate1) === JSON.stringify(byDateAgain),
    pageSizes: sizes,
    noPageOnScope: {
      status: noPage.status,
      rows: rows(noPage.json).length >= 10 ? '10+' : rows(noPage.json).length,
    },
  };
}

// 5. Latency and size of typical reads (bytes and ms only).
{
  const sel = [
    'Number',
    'Name',
    'Status.Name',
    'Owners.Name',
    'Estimate',
    'Timebox.Name',
    'Scope.Name',
    'ChangeDate',
  ];
  const typical: Record<string, unknown> = {};
  for (const size of [25, 100]) {
    const times: number[] = [];
    let bytes = 0;
    for (let i = 0; i < 3; i++) {
      const r = await q({ from: 'Story', select: sel, sort: ['-ChangeDate'], page: { start: 0, size } });
      times.push(r.ms);
      bytes = r.bytes;
    }
    typical[`stories${size}`] = { ms: times, bytes, bytesPerRow: Math.round(bytes / size) };
  }
  const nested = await q({
    from: 'Story',
    select: [
      'Number',
      { from: 'Owners', select: ['Name'] },
      { from: 'Children', select: ['Number', 'AssetType'] },
    ],
    page: { start: 0, size: 25 },
  });
  typical['nested25'] = {
    status: nested.status,
    ms: nested.ms,
    bytes: nested.bytes,
    shape: shape(rows(nested.json).slice(0, 1)),
  };
  out['latency'] = typical;
}

// 6. Number prefixes per type and resolving a number across types in one query.
{
  const prefixes: Record<string, unknown> = {};
  for (const t of [
    'Story',
    'Defect',
    'Task',
    'Test',
    'Epic',
    'Issue',
    'Request',
    'RegressionTest',
    'TestSet',
    'Theme',
    'Goal',
  ]) {
    const r = await q({ from: t, select: ['Number'], page: { start: 0, size: 1 } });
    const n = (rows(r.json)[0] as { Number?: string } | undefined)?.Number;
    prefixes[t] = r.status !== 200 ? `HTTP ${r.status}` : n ? n.replace(/[0-9]+$/, '') : '(no rows)';
  }
  const sample =
    (
      rows((await q({ from: 'Defect', select: ['Number'], page: { start: 0, size: 1 } })).json)[0] as
        | { Number?: string }
        | undefined
    )?.Number ?? '';
  const across: Record<string, unknown> = {};
  for (const from of ['Workitem', 'PrimaryWorkitem', 'BaseAsset']) {
    const r = await q({
      from,
      select: ['AssetType'],
      filter: ['Number=$n'],
      with: { $n: sample },
      page: { start: 0, size: 5 },
    });
    across[from] = {
      status: r.status,
      rows: rows(r.json).length,
      assetType: (rows(r.json)[0] as { AssetType?: string } | undefined)?.AssetType,
    };
  }
  out['numbers'] = { prefixes, resolveDefectNumberAcrossTypes: across };
}

// 7–9, 12. Metadata: relations, scope strategy, custom attributes, team membership, fingerprinting, operations.
{
  const types = [
    'Story',
    'Defect',
    'Task',
    'Test',
    'Epic',
    'Issue',
    'Request',
    'Timebox',
    'Team',
    'Member',
    'Scope',
    'Expression',
    'Attachment',
    'Link',
    'Actual',
    'RegressionTest',
    'TestSet',
  ];
  const interesting = [
    'Scope',
    'Parent',
    'Super',
    'Subs',
    'Children',
    'Owners',
    'Team',
    'Timebox',
    'Status',
    'Category',
    'Workitems',
    'Members',
    'Participants',
    'Schedule',
    'ParentAndUp',
    'ChildrenMeAndDown',
    'Asset',
    'Mentions',
    'BelongsTo',
    'Number',
    'AssetState',
    'IsClosed',
    'IsDeleted',
  ];
  const perType: Record<string, unknown> = {};
  for (const t of types) {
    const m = await meta(t);
    const attrs = m.json.Attributes ?? {};
    const names = Object.keys(attrs).map((k) => k.replace(/^[A-Za-z]+\./, ''));
    const custom = Object.entries(attrs).filter(([k]) => /Custom_/.test(k));
    const relTo = (name: string) => {
      const a = Object.entries(attrs).find(([k]) => k.replace(/^[A-Za-z]+\./, '') === name)?.[1];
      return a
        ? `${a.AttributeType ?? '?'}${a.IsMultivalue ? '[]' : ''}${a.RelatedAsset ? `→${(a.RelatedAsset as { nameref?: string }).nameref ?? '?'}` : ''}`
        : undefined;
    };
    perType[t] = {
      status: m.status,
      base: m.json.Base?.nameref,
      attributes: names.length,
      relations: Object.fromEntries(interesting.filter((n) => names.includes(n)).map((n) => [n, relTo(n)])),
      customAttributes: custom.length,
      customTypes: [...new Set(custom.map(([, a]) => a.AttributeType))],
      operations: Object.keys(m.json.Operations ?? {}).map((k) => k.replace(/^[A-Za-z]+\./, '')),
    };
  }
  const a = await meta('Story');
  const b = await meta('Story');
  const full = await meta('');
  const assetTypes = (full.json as unknown as { AssetTypes?: Record<string, unknown> }).AssetTypes;
  out['metadata'] = {
    perType,
    version: a.json.Version,
    storyBytes: a.bytes,
    fingerprint: { headers: a.headers, sameBodyTwice: a.sha256 === b.sha256 },
    full: {
      status: full.status,
      bytes: full.bytes,
      ms: full.ms,
      topLevelKeys: Object.keys(full.json).slice(0, 10),
      assetTypeCount: assetTypes ? Object.keys(assetTypes).length : undefined,
    },
  };
}

// 11. History: Hist versus asof (timings and counts only).
{
  const sample = rows(
    (await q({ from: 'Story', select: ['ID'], sort: ['-ChangeDate'], page: { start: 0, size: 1 } })).json,
  )[0] as { _oid?: string } | undefined;
  const id = sample?._oid?.split(':')[1] ?? '0';
  const t0 = performance.now();
  const hist = await live(`rest-1.v1/Hist/Story/${id}?sel=Status.Name,ChangeDate`, {
    accept: 'application/json',
  });
  const histJson = (await hist.json()) as { Assets?: unknown[]; total?: number };
  const histMs = Math.round(performance.now() - t0);
  const asof = await q({
    from: 'Story',
    select: ['Status.Name'],
    filter: [`ID='Story:${id}'`],
    asof: '2026-01-01',
  });
  const histQ = await q({
    from: 'Story',
    select: ['Status.Name', 'ChangeDate'],
    filter: [`ID='Story:${id}'`],
    asof: 'All',
  });
  out['history'] = {
    restHist: {
      status: hist.status,
      ms: histMs,
      versions: histJson.Assets?.length,
      shape: shape((histJson.Assets ?? []).slice(0, 1)),
    },
    queryAsofDate: { status: asof.status, ms: asof.ms, rows: rows(asof.json).length },
    queryAsofAll: { status: histQ.status, ms: histQ.ms, rows: rows(histQ.json).length },
  };
}

mkdirSync('spikes/agility-api/results', { recursive: true });
writeFileSync('spikes/agility-api/results/probe.json', `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 1));
