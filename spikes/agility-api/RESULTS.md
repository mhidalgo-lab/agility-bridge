# P0-06 results: Agility API behaviour, limits and fixtures

Date: 2026-10-21. Instance: the owner's **read-only third-party tenant**, hosted on `v1host.com`, **Agility 26.0.3.2**
(D-01). About 140 read requests from `probe.ts` (plus two short follow-ups), one at a time with 150–200 ms pauses,
every one through the P0-12 guard (`live/readonly-fetch.ts`). Nothing from the tenant is recorded: only statuses,
shapes, counts, timings, product attribute names and number prefixes. Raw output stays in the git-ignored `results/`.
Latency was measured from Buenos Aires (WSL2 on a home connection), so absolute times include network; compare them
with each other.

## 1. Authentication

| Request | Result |
|---|---|
| `POST query.v1` with `Authorization: Bearer <access token>` | 200 |
| `POST query.legacy.v1` with the same bearer token | 200 |
| Invalid token | **401**, `application/json`, 24-byte body, **no `WWW-Authenticate`** |
| No `Authorization` header | **401**, same shape, no redirect to a login page |

Responses carry `V1-MemberID`, `V1-AuthType` and `V1-SurrogateID` headers. Access tokens work on both query endpoints,
so no fallback to `rest-1.v1` reads is needed for authentication (ADR-0011 consequence).

## 2. Errors that reads trigger

Unknown asset type, unknown attribute and a malformed filter all return **400** `application/json` with the shape
`{ "error": string, "exceptions": [ { "type": string, "message": string } ] }` (a malformed filter returns two
exceptions). Messages can echo the request, so they are untrusted text (L-038). 404/405/429/500 were not triggered
(no write paths, no rate-limit probing on this tenant).

## 3. `with` binding (security)

`filter: ["Number=$v"], with: { "$v": <value> }` on `Story`, page size 5. A value that matches no number must return 0
rows.

| Value | Rows | Meaning |
|---|---|---|
| `zz-no-such-number`, `zz'`, `zz'\|Number!='`, `zz"\|Number!="`, `zz')\|(Number!='`, `zz;Number!=""`, `zz[Owners]`, `$other`, newline injection, Unicode, a 10,000-character string | **0** | treated as one literal value: no quote, OR, AND, grouping, variable or newline injection |
| `zz\|<real number>` | 0 | `\|` inside a value is literal |
| **`zz,<real number>`** | **1** | **a comma inside a bound value splits it into a value list**: the real number matched |
| `["zz-1", "zz-2"]` (array) | 0 | arrays are value lists (documented) |
| `["zz-1", <real number>]` | 1 | as expected for a list |
| the real number | 1 | exact match |
| contrast: the injection written into the filter text, `Number='zz'\|Number!=''` | **5** (page full) | why values must never be interpolated |

**Finding (L-162):** binding is safe against quotes and operators, but **a comma in a scalar bound value widens the
filter into a list**. A caller can make `Number = "x,B-01234"` match `B-01234`, or a name filter match several values.
It cannot escape the workspace's top-level scope filter, which is a separate clause the server adds (T3), but it changes
what the filter means. The query compiler (P1-04) must refuse commas in scalar values (or split them into an explicit
list only where a list is allowed) and test it with these cases.

## 4. Paging, totals and several queries per call

- **No totals on this version:** `needTotal: true` returns no total anywhere (body or headers), and `rest-1.v1/Data`
  reports only `pageSize`/`pageStart` in XML and JSON (the documented `total` attribute is absent). Counting needs
  another approach (an aggregate such as `Workitems.@Count` on a parent, or `hasMore` from fetching `size + 1` rows);
  outputs show "more available" rather than totals (ADR-0015).
- Page sizes 100 / 500 / 1,000 / 2,000 all work: 254 / 305 / 452 / 696 ms, about 100 bytes per row for `ID` only.
- Without `page`, `query.v1` returns the whole result set (checked only on `Scope`, a small type).
- Sorted by `ID`, consecutive pages are disjoint and the same page is identical twice; sorted by `-ChangeDate` the same
  page is also identical twice.
- Several queries in one call (a JSON array) return one result set per query.

## 5. Latency and size of typical reads

| Query (25 rows unless noted) | ms (3 runs) |
|---|---|
| 8 attributes incl. dot paths (`Status.Name`, `Owners.Name`, `Timebox.Name`, `Scope.Name`), no sort | 1,157 (cold), 259, 221 |
| the same, **sort `-ChangeDate`** | 1,092, 1,102, 1,120 |
| `ID` only, **sort `-ChangeDate`** | 1,098, 1,307, 1,203 |
| the same 8 attributes, **sort `ID`** | 227, 238, 248 |
| nested `{from: Owners}` selection, sort `-ChangeDate` | 1,228, 1,351, 1,111 |
| 100 rows, 8 attributes, sort `-ChangeDate` | 1,189 – 1,707 (45.6 KB, about 456 bytes per row) |

**Finding (L-163):** sorting by `ChangeDate` costs about **1.1 s per call** whatever is selected; sorting by `ID` costs
about 0.23 s. Default sorts use `ID` (stable and cheap); "most recent first" is an explicit choice whose cost the tool
declares. Typical list rows are about 430–460 bytes, so 100 rows with owners and status is about 46 KB, well under the
Workers Free cap.

## 6. Numbers and asset identity

- Prefixes on this instance: `Story` **B-**, `Defect` **D-**, `Task` **TK-**, `Test` **AT-**, `Epic` **E-**, `Issue`
  **I-**, `Theme` **FG-**, `Goal` **G-**; `Request`, `RegressionTest` and `TestSet` had no rows to read. `meta.v1` does
  not expose prefixes, so they are learned from data and configurable (P1-06).
- A number resolves across types in **one** query with `from: "Workitem"` (or `PrimaryWorkitem`), returning
  `AssetType`; `from: "BaseAsset"` is refused (400).

## 7. Metadata (`meta.v1`)

- **JSON** with `Accept: application/json` (also on the public example instance, P0-09). Whole schema: **5.1 MB, 192
  asset types, 5.1 s**; one type about 90 KB (`Story`).
- **Fingerprint:** `ETag: "26.0.3.2.<schema stamp>"` and `Cache-Control: public, max-age≈2,600 s`; the same body twice
  hashes identically. The ETag (version + stamp) is the change detector (P1-03); no `Last-Modified`.
- Custom attributes appear as `<Type>.Custom_…` with types `Text`, `LongText`, `Date` and `Relation` (to custom list
  types). Counts: Story 3, Defect 7, Epic 32, TestSet 4, Member 2, others 0. Whether administrators can add asset
  types was not settled: this tenant lists 192 types against 175 on the 26.2 example instance (edition or version
  differences are as likely as custom types). *not verified*
- Operations are listed per type (e.g. Story: `QuickClose`, `Inactivate`, `Reactivate`, `Split`, `ConvertToDefect`,
  `Delete`, `Undelete`, …).

### Relations and scope strategy (ARCHITECTURE §6.3)

| Type | Base | Reaches its Agility project through | Other relations |
|---|---|---|---|
| Story, Defect, TestSet | PrimaryWorkitem | `Scope` | `Super` → Epic, `Parent` → **Theme**, `Children`/`Subs` → Workitem[], `Owners` → Member[], `Team`, `Timebox`, `Status` (StoryStatus) |
| Task | Workitem | `Scope` | `Parent` → PrimaryWorkitem, `Status` → TaskStatus |
| Test | Workitem | `Scope` | `Parent` → Workitem, `Status` → TestStatus |
| Epic | Workitem | `Scope` | `Super` → Epic, `Category` → EpicCategory, `Status` → EpicStatus |
| Issue, Request, RegressionTest, Actual (effort) | BaseAsset | `Scope` | Issue: `Team`, `Category`; Request: `Status`; Actual: `Team`, `Timebox` |
| Timebox (sprint) | BaseAsset | `Schedule` (projects share a schedule) | `Workitems` |
| Expression (comment) | — | `BelongsTo` → Conversation, `Mentions` → BaseAsset[] | — |
| Attachment, Link | — | `Asset` → BaseAsset | `Category` |
| Team, Member | BaseAsset | global | Team has **no member roster** relation; Member has a `Members` relation (meaning not probed) |
| Scope (project) | BaseAsset | — | `Parent`, `Children`, **`ChildrenMeAndDown`** (project and descendants), `ParentAndUp`, `Schedule`, `Members` |

**Team membership** has no roster relation on `Team`: membership comes from assignments (owners of work items with
that team) or the team room, which this spike did not probe. *not verified*

## 8. History

`rest-1.v1/Hist/Story/<id>` answers JSON (11 versions, 194 ms) and `query.v1` with `asof: "All"` returns the same 11
versions in 227 ms; `asof` with a date returns the state at that date. Both cost about the same for one asset; `Hist` is
kept as the authority (ADR-0011). Activity stream not probed. *not verified*

## Not verified (needs the writable sandbox or another instance)

- Writes: `api/asset` versus `rest-1.v1` POST, `previewOnly=true` side effects, comments, effort, links, `QuickClose`,
  `Reactivate`, read-after-write lag (P7-07).
- Rate limits, 429 bodies and `RetryAfter`, the error-count quota (D-01: never probed on this tenant).
- Whether `needTotal` / `rest-1.v1` totals exist on 26.2 and later.
- Custom asset types; team-room membership; the activity stream; `assetdetail.v1` links (URL shape documented, not
  requested); attachment content (`attachment.img` is outside the guard).
- On-premises: version range, private CA, base URL shapes (no instance, D-13).

## Reproduce

```sh
# ~/.config/agility-bridge/live.env (chmod 600) holds AB_LIVE_AGILITY_URL and AB_LIVE_AGILITY_TOKEN
node spikes/agility-api/probe.ts      # writes spikes/agility-api/results/probe.json (git-ignored)
```
