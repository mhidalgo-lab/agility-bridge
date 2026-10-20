# P0-09 results: Cloudflare Workers limits with Agility-shaped payloads

Date: 2026-10-20. Status: **local measurements, parser choice and portability prototype done; production numbers per
plan need the owner's Cloudflare account** ([`deploy-and-measure.md`](deploy-and-measure.md)). Payloads are synthetic,
except the public `meta.v1` of Digital.ai's example instance (schema only, no content), which is downloaded to the
git-ignored `results/` folder and never committed.

## Versions

Node 24.16.0 (Intel i7-10750H, WSL2), wrangler 4.149.0 (local workerd), `@cloudflare/workers-types` 5.20261013.1,
fast-xml-parser 5.11.2, txml 6.0.3, saxes 6.0.0, @xmldom/xmldom 0.9.12, esbuild 0.28.2. All at least 3 days old.

## 1. `meta.v1` is big, and also serves JSON

Measured against `https://www14.v1host.com/v1sdktesting/meta.v1` (public, unauthenticated, Agility 26.2.6.29):

| Request | Format | Size | Time |
|---|---|---|---|
| `meta.v1` (all 175 asset types) | XML | 4,148,930 bytes (467,816 gzip on the wire) | 6.5 s |
| `meta.v1` with `Accept: application/json` | **JSON** | 4,839,315 bytes | — |
| `meta.v1/Story` | XML | 83,095 bytes | 1.1 s |
| `meta.v1/Story` with `Accept: application/json` | **JSON** | 97,021 bytes | — |

- **`meta.v1` answers JSON** when asked with `Accept: application/json` (RESEARCH §1 said XML only). The metadata
  service (P1-03) can avoid XML parsing for the schema.
- The whole schema (4–5 MB decompressed) **cannot be read on Workers Free** under the 512 KiB cap and would cost about
  20–45 ms of CPU to parse (§2), so the Worker loads metadata **per asset type** (about 100 KB each) and caches it; Node
  can load it whole.

## 2. CPU of the hot path (read with a byte cap, parse, shape)

`src/node-bench.ts`, Node (same V8 as workerd), CPU from `process.cpuUsage`, 40 iterations, one event-loop turn each
(L-159). Synthetic `query.v1` rows (Story-like, with HTML descriptions); shaping keeps 100 rows and 120-character cells.

| Payload | Capped read p50 / p95 | Parse + shape p50 / p95 | Total p50 / p95 | ms per MB (p50) |
|---|---|---|---|---|
| 10 KB | 0.02 / 0.08 | 0.05 / 0.10 | 0.07 / 0.18 | 6.7 |
| 100 KB | 0.07 / 0.20 | 0.38 / 0.87 | 0.45 / 1.32 | 4.5 |
| 512 KiB | 0.57 / 4.79 | 1.61 / 6.24 | 2.31 / 9.57 | 4.4 |
| 1 MB | 0.88 / 5.36 | 2.70 / 3.92 | 3.56 / 9.21 | 3.6 |
| 5 MB | 2.27 / 16.09 | 13.85 / 51.56 | 17.73 / 60.20 | 3.5 |

Local workerd, wall time per request from `curl` (`/bench`, 15 requests after 3 warm-up; includes generating the payload
inside the Worker, so an upper bound): 10 KB 3.1 ms, 100 KB 4.2 ms, 512 KiB 10.8 ms, 1 MB 22.5 ms, 5 MB 74.6 ms (p50).

**Production reference** (relic-bridge P0-09, 2026-10-02, the same maintainer's Workers Free account, the same
read-cap-parse pattern on JSON): CPU p50 2.8 ms at 10 KB, 3.7 ms at 100 KB, 10.2 ms at 1 MB, 45.8 ms at 5 MB; about
**9 ms per MB** in production against about 5 ms locally; cold first calls 17–35 ms; **no request was terminated** for
exceeding 10 ms on Free (Cloudflare documents tolerance for occasional overruns; not something to design on).
Platform behaviour does not depend on the upstream API, so these numbers carry over; the owner's deploy re-checks them
with Agility-shaped payloads.

**Conclusion:** the presets in ADR-0010 hold. At 512 KiB the parse costs about 2.3 ms locally (about 4.5 ms with the
production factor), which leaves room for the SDK and the cold path inside Free's 10 ms. Anything near 1 MB needs
Workers Paid.

## 3. XML parser for `meta.v1`, `Hist` and `rest-1.v1`

`src/xml-bench.ts`: CPU p50 in ms (Node), bundle size with esbuild (minified, `platform: neutral`), and entity handling
(a billion-laughs internal-entity document; an external entity `SYSTEM "file:///etc/hostname"`).

| Parser | meta.v1 4.1 MB | meta.v1/Story 83 KB | rest-1.v1 100 KB | rest-1.v1 1 MB | KiB min / gzip | Billion laughs | External entity |
|---|---|---|---|---|---|---|---|
| fast-xml-parser 5.11.2 | 248.2 | 3.6 | 8.7 | 77.7 | 62 / 20.8 | not expanded | rejected |
| txml 6.0.3 (`txml/txml`) | 48.9 | 1.0 | 1.0 | 9.0 | 4 / 2.0 | not expanded | not expanded |
| **saxes 6.0.0** (SAX) | 46.1 | 0.9 | 1.2 | 10.7 | 28 / 8.0 | **rejected** | **rejected** |
| @xmldom/xmldom 0.9.12 (DOM) | 311.8 | 3.4 | 7.8 | 83.7 | 92 / 30.4 | not expanded | not expanded |

- txml's package root imports `node:stream` (it fails to bundle for Workers); its `txml/txml` subpath is stream-free.
  It is the smallest and fast, but it decodes **no** entities, not even `&amp;` or `&lt;`, so every caller would have to.
- fast-xml-parser and xmldom are 5–8× slower on the large documents.

**Choice: saxes**, for the XML that remains. It is as fast as txml, decodes the predefined entities, refuses custom and
external entities by default (no DTD processing), and streams, so the byte cap and a node budget can be enforced while
parsing. **Prefer JSON wherever Agility serves it** (`query.v1`, `meta.v1`; `rest-1.v1` and `Hist` JSON support is a
P0-06 question), so XML stays on the error and history paths.

## 4. Storage and crypto portability (input for ADR-0006 and ADR-0007)

`src/storage.ts` runs the same STRICT schema and 14 statements on `node:sqlite` and on local D1 (`src/portability.ts`
against `wrangler dev`):

| Step | node:sqlite | D1 (local) |
|---|---|---|
| insert; UNIQUE violation; STRICT type check; FOREIGN KEY violation | same (errors normalised to `unique`, `strict-type`, `foreign-key`) | same |
| optimistic `UPDATE … WHERE version = ? RETURNING version` (current, then stale) | `[{version: 2}]`, `[]` | same |
| quota `INSERT … ON CONFLICT DO UPDATE … WHERE calls < ? RETURNING calls` (×3, cap 2) | `1`, `2`, `[]` | same |
| `json_extract`, `unixepoch` arithmetic | same | same |
| `DELETE` of a workspace with one credential (`ON DELETE CASCADE`) | `changes: 1` | **`changes: 2`** |
| rows left after the cascade | 0 | 0 |

- **13 of 14 steps are identical.** D1's `meta.changes` counts rows changed by cascades; `node:sqlite` counts only the
  statement's own rows. The storage layer must decide on `RETURNING` rows, never on driver change counters (lesson
  L-161).
- `node:sqlite` needs `PRAGMA foreign_keys = ON` per connection; D1 enforces foreign keys by default.
- **Crypto:** HKDF-SHA-256 → AES-256-GCM (96-bit random IV, record id as additional data) sealed on Node opens on
  workerd and the reverse; a wrong additional-data value is refused on workerd (`OperationError`). The envelope format is
  portable as designed.

## 5. Outbound TLS to an untrusted certificate (input for ADR-0014)

From local workerd: `https://self-signed.badssl.com/`, `https://untrusted-root.badssl.com/` and
`https://expired.badssl.com/` all fail with an opaque `internal error; reference = …` that **does not mention TLS**;
the public Agility host works (200). Workers offer no option to trust a private CA, so an on-premises instance with a
private CA needs the Node or Docker deployment, as ADR-0014 decided; the Agility client must map this opaque failure to
an actionable `AB_` error ("could not connect securely: certificate not trusted, or the host is unreachable") (lesson
L-160). The production Worker's behaviour is part of the owner's checklist.

## 6. Not measured here (owner's Cloudflare account)

Per-plan production CPU with Agility-shaped payloads (Free and Paid), cold starts, the Cache API on `workers.dev` versus
a custom domain, the Rate Limiting binding, subrequest accounting with retries, and the private-CA failure in production:
[`deploy-and-measure.md`](deploy-and-measure.md).

## Reproduce

```sh
cd spikes/workers-limits && pnpm install
mkdir -p results
curl -s -o results/meta.v1.xml https://www14.v1host.com/v1sdktesting/meta.v1
curl -s -o results/Story.xml https://www14.v1host.com/v1sdktesting/meta.v1/Story
pnpm bench                     # CPU of read + parse + shape on Node
pnpm xml                       # XML parsers
pnpm worker &                  # local workerd + D1 on port 8790
pnpm portability               # node:sqlite vs D1, crypto round trip
curl "localhost:8790/tls?url=https://self-signed.badssl.com/"
```
