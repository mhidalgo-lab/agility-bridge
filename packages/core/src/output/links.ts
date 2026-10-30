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

/** The pinned base, or undefined when it is not a plain http(s) origin plus path (it never is for a canonical URL). */
function pinnedBase(baseUrl: string): { href: string; origin: string; path: string } | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.search !== '' || url.hash !== '')
    return undefined;
  if (url.username !== '' || url.password !== '') return undefined;
  const path = url.pathname.replace(/\/+$/, '');
  return { href: `${url.origin}${path}`, origin: url.origin, path };
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
  if (base === undefined) return undefined;
  const { assetType, oid, number } = identity;
  if (typeof assetType !== 'string' || !ASSET_TYPE_RE.test(assetType)) return undefined;
  let query: string | undefined;
  const m = typeof oid === 'string' ? OID_RE.exec(oid) : null;
  if (m !== null && m[1] === assetType) query = `oid=${m[1]}:${m[2]}`;
  else if (typeof number === 'string' && NUMBER_RE.test(number)) query = `number=${number}`;
  if (query === undefined) return undefined;
  const link = `${base.href}/${ASSET_DETAIL_PATH}?${query}`;
  // Belt and braces: whatever happened above, the result stays on the pinned origin and under the pinned path.
  const parsed = new URL(link);
  return parsed.origin === base.origin && parsed.pathname === `${base.path}/${ASSET_DETAIL_PATH}`
    ? link
    : undefined;
}

const MAX_DEPTH = 8;

/**
 * Adds `url` to every object of `value` that is an asset row (`assetType` plus a valid `oid` or `number`) and has no
 * `url` of its own (a Link asset's `url` is Agility's text and is left alone). Returns the same value when nothing
 * changed, so an unaffected result is not copied.
 */
export function addLinks<T>(baseUrl: string, value: T): { value: T; linked: number } {
  let linked = 0;
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
      const link = assetLink(baseUrl, rec);
      if (link !== undefined) {
        linked += 1;
        out = { ...(out ?? rec), url: link };
      }
    }
    return out ?? v;
  };
  return { value: walk(value, 0) as T, linked };
}

/** The one fixed line the text output carries when items were linked (never a URL per row, never Agility text). */
export function linkNote(baseUrl: string): string | undefined {
  const base = pinnedBase(baseUrl);
  return base === undefined
    ? undefined
    : `Note: each item has a url that opens it in Agility (sign-in needed), like ${base.href}/${ASSET_DETAIL_PATH}?number=<number>.`;
}
