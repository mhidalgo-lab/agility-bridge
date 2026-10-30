// SPDX-License-Identifier: Apache-2.0
// Deep links to the Agility UI (P8-02, ADR-0011, THREAT_MODEL T26). A link is the pinned instance URL plus the fixed
// `assetdetail.v1` path and one identity that matches a strict pattern. Nothing else reaches the URL: not the host, not
// the path, not a caller's text. `assetdetail.v1` is a permalink that needs a signed-in Agility session; no share,
// public or "anyone with the link" URL is ever built (L-056).

const TYPE = '[A-Za-z][A-Za-z0-9]{0,39}';
const OID_RE = new RegExp(`^(${TYPE}):([0-9]{1,12})$`);
const NUMBER_RE = /^[A-Za-z]{1,8}-[0-9]{1,12}$/;
const ASSET_TYPE_RE = new RegExp(`^${TYPE}$`);

/** The fixed path of the Agility UI permalink. */
export const ASSET_DETAIL_PATH = 'assetdetail.v1';

interface PinnedBase {
  readonly href: string;
  /** `<href>/assetdetail.v1?`: every link starts with exactly this. */
  readonly prefix: string;
}

/** The pinned base, or undefined when it is not a plain http(s) origin plus path (it never is for a canonical URL). */
function pinnedBase(baseUrl: string): PinnedBase | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.search !== '' || url.hash !== '')
    return undefined;
  if (url.username !== '' || url.password !== '') return undefined;
  const href = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  return { href, prefix: `${href}/${ASSET_DETAIL_PATH}?` };
}

/** What may follow the prefix: one strict identity query, nothing that could end the path or start another part. */
const QUERY_RE = new RegExp(`^(?:oid=${TYPE}:[0-9]{1,12}|number=[A-Za-z]{1,8}-[0-9]{1,12})$`);

/**
 * The link for one identity against a base that was parsed once (P8-40). The identity is matched against the strict
 * patterns, and the result is checked to be the parsed prefix (origin and path, fixed for the call) plus one strict
 * query, so no second `new URL` per row is needed to keep it on the pinned origin and path.
 */
function linkFor(
  base: PinnedBase,
  identity: { readonly assetType?: unknown; readonly oid?: unknown; readonly number?: unknown },
): string | undefined {
  const { assetType, oid, number } = identity;
  if (typeof assetType !== 'string' || !ASSET_TYPE_RE.test(assetType)) return undefined;
  let query: string | undefined;
  const m = typeof oid === 'string' ? OID_RE.exec(oid) : null;
  if (m !== null && m[1] === assetType) query = `oid=${m[1]}:${m[2]}`;
  else if (typeof number === 'string' && NUMBER_RE.test(number)) query = `number=${number}`;
  if (query === undefined || !QUERY_RE.test(query)) return undefined;
  return `${base.prefix}${query}`;
}

/**
 * The link to one asset, or undefined. `identity` comes from Agility rows, so it is only used when it matches the OID or
 * number pattern (letters, digits, one colon or hyphen): it cannot add a host, a path segment, a query or a fragment.
 */
export function assetLink(
  baseUrl: string,
  identity: { readonly assetType?: unknown; readonly oid?: unknown; readonly number?: unknown },
): string | undefined {
  const base = pinnedBase(baseUrl);
  return base === undefined ? undefined : linkFor(base, identity);
}

const MAX_DEPTH = 8;

/**
 * The most characters the links of one result may add (P8-40): the default data block cap. A link is about 85 characters
 * plus its JSON key, so this keeps about 250 rows linked; rows past it get no `url` and the note says so. The links are
 * added after the output caps, so this is what keeps a 1,000-row result from growing by a third.
 */
export const LINK_BUDGET_CHARS = 24_000;
/** What the key and quotes add to a link in JSON: `,"url":""`. */
const LINK_JSON_OVERHEAD = 9;

/**
 * Adds `url` to every object of `value` that is an asset row (`assetType` plus a valid `oid` or `number`) and has no
 * `url` of its own (a Link asset's `url` is Agility's text and is left alone). The base is parsed once per call and the
 * added characters stop at `LINK_BUDGET_CHARS`; `omitted` counts the rows left without a link for that reason. Returns
 * the same value when nothing changed, so an unaffected result is not copied.
 */
export function addLinks<T>(
  baseUrl: string,
  value: T,
  budgetChars: number = LINK_BUDGET_CHARS,
): { value: T; linked: number; omitted: number } {
  const base = pinnedBase(baseUrl);
  if (base === undefined) return { value, linked: 0, omitted: 0 };
  let linked = 0;
  let omitted = 0;
  let spent = 0;
  const walk = (v: unknown, depth: number): unknown => {
    if (v === null || typeof v !== 'object' || depth > MAX_DEPTH) return v;
    if (Array.isArray(v)) {
      let out: unknown[] | undefined;
      v.forEach((item, i) => {
        const next = walk(item, depth + 1);
        if (next === item) return;
        out ??= v.slice();
        out[i] = next;
      });
      return out ?? v;
    }
    const rec = v as Record<string, unknown>;
    let out: Record<string, unknown> | undefined;
    for (const [k, item] of Object.entries(rec)) {
      const next = walk(item, depth + 1);
      if (next === item) continue;
      out ??= { ...rec };
      out[k] = next;
    }
    if (!('url' in rec) && 'assetType' in rec) {
      const link = linkFor(base, rec);
      if (link !== undefined) {
        const cost = link.length + LINK_JSON_OVERHEAD;
        if (spent + cost > budgetChars) {
          omitted += 1;
        } else {
          spent += cost;
          linked += 1;
          out = { ...(out ?? rec), url: link };
        }
      }
    }
    return out ?? v;
  };
  return { value: walk(value, 0) as T, linked, omitted };
}

/** The one fixed line the text output carries when items were linked (never a URL per row, never Agility text). */
export function linkNote(baseUrl: string, omitted = 0): string | undefined {
  const base = pinnedBase(baseUrl);
  if (base === undefined) return undefined;
  const lead = omitted === 0 ? 'each item' : 'the first items';
  const tail = omitted === 0 ? '' : ` ${omitted} more row(s) have no url: ask for fewer rows to get them.`;
  return `Note: ${lead} has a url that opens it in Agility (sign-in needed), like ${base.href}/${ASSET_DETAIL_PATH}?number=<number>.${tail}`;
}
