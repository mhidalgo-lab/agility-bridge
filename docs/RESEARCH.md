# Research and platform facts

> Status: **initial research** (2026-10-16). Facts here come from vendor documentation and specifications and are
> **not yet verified against a live Agility instance or real clients**. The Phase 0 spikes (P0-06 – P0-09) confirm or
> correct each one and record the result here with a date. Mark every new fact with its source URL and how it was
> verified: `docs` (read in documentation), `live` (observed against a real system, with date and version) or
> `unverified` (secondary source or inference).

Contents:

1. [Digital.ai Agility](#1-digitalai-agility)
2. [MCP protocol and TypeScript SDK](#2-mcp-protocol-and-typescript-sdk)
3. [MCP clients](#3-mcp-clients)
4. [OAuth 2.1 for MCP](#4-oauth-21-for-mcp)
5. [Cloudflare Workers platform](#5-cloudflare-workers-platform)
6. [Node.js, Docker, SQLite, npm and registries](#6-nodejs-docker-sqlite-npm-and-registries)
7. [Prior art](#7-prior-art)
8. [Open questions for the Phase 0 spikes](#8-open-questions-for-the-phase-0-spikes)
9. [Admin sign-in providers](#9-admin-sign-in-providers-p4-01)

Abbreviation: **DL** = `https://docs.digital.ai/agility/docs/developerlibrary/` (Agility developer library).

---

## 1. Digital.ai Agility

### 1.1 Product, versions and terminology

- Digital.ai Agility is the enterprise agile planning product formerly known as **VersionOne** (VersionOne → CollabNet
  VersionOne → Digital.ai). The API surface (`rest-1.v1`, `meta.v1`, attachments) has been stable since 2007 with no
  deprecation notices across the rebrands. *docs*
- Latest release at the time of writing: **26.2** (July 2026; public example instances report build `26.2.6.29`);
  **26.3** is planned for late October 2026. Releases are quarterly (`xx.0` … `xx.3`) with bi-weekly point releases.
  The 26.0 – 26.2 release notes show no API deprecations. *docs, unverified for point releases* — *live (P0-06,
  2026-10-21):* the owner's hosted tenant runs **26.0.3.2**.
- UI vocabulary depends on the methodology template; the API names are fixed. *docs* —
  [DL assets](https://docs.digital.ai/agility/docs/developerlibrary/assets)

| API name | Scrum UI | Other UIs |
|---|---|---|
| `Story` | Backlog Item | Story (XP), Requirement (AgileUP/DSDM) |
| `Scope` | Project (also "Planning Level" in portfolio docs) | Project |
| `ScopeLabel` | Program | Program |
| `Timebox` | Sprint | Iteration |
| `Epic` | Portfolio Item (categories such as Epic, Feature, Initiative are values of a type field, not asset types) | — |
| `TeamRoom` | Team Room | — |

### 1.2 API inventory

| Family | URL pattern | Methods / format | Purpose | Source |
|---|---|---|---|---|
| `rest-1.v1/Data` | `/rest-1.v1/Data/<AssetType>[/<id>]` | GET/POST, XML or **JSON** (`Accept: application/json`, *live* P0-06) | Read; create/update one asset; operations via `?op=` | [DL rest-1-v1-endpoints](https://docs.digital.ai/agility/docs/developerlibrary/rest-1-v1-endpoints) |
| `rest-1.v1/Hist` | `/rest-1.v1/Hist/<AssetType>` | GET, XML or **JSON** (*live* P0-06) | History: one row per version (moment) of an asset | [DL history queries](https://docs.digital.ai/agility/docs/developerlibrary/learn-by-example-history-queries) |
| `rest-1.v1/New` | `/rest-1.v1/New/<AssetType>?ctx=<OID>` | GET, XML | Template for a new asset (defaults, context copy) | DL rest-1-v1-endpoints |
| `query.v1` | `/query.v1` | POST (GET), JSON or YAML in, JSON out | Read-only, nested selections, several queries per call (*live* P0-06) | [DL tour of query.v1](https://docs.digital.ai/agility/docs/developerlibrary/tour-query-v-1) |
| `query.legacy.v1` | `/query.legacy.v1` | as above | Same, accepting Basic auth or the browser session cookie; bearer access tokens also work (*live* P0-06) | DL tour of query.v1 |
| `meta.v1` | `/meta.v1[/<AssetType>[/<Attribute or Operation>]]` | GET, XML or **JSON** (`Accept: application/json`, *live* 2026-10-20), **no authentication** | Schema: asset types, attributes, types, inheritance, operations, validators | [DL meta API](https://docs.digital.ai/agility/docs/developerlibrary/meta-api) |
| `api/asset` (Bulk API) | `/api/asset[?previewOnly=true]` | POST, JSON (object or array) | Create, update, add/remove relations, execute operations; deferred execution with `previewOnly` | [Bulk API](https://docs.digital.ai/agility/docs/agility-bulk-api), [quickstart](https://docs.digital.ai/agility/docs/bulk-api-quickstart), [advanced topics](https://docs.digital.ai/agility/docs/advanced-bulk-topics) |
| `api/ActivityStream` | `/api/ActivityStream/<OID>` | GET, JSON | Activity feed; "may not contain every change" | [DL activity stream](https://docs.digital.ai/agility/docs/developerlibrary/activity-stream) |
| `attachments.img` | `/attachments.img/<id>` | GET / POST multipart | Attachment content (two steps: create the `Attachment` asset, then upload) | [DL attachments](https://docs.digital.ai/agility/docs/developerlibrary/working-with-attachments-and-images) |
| `api/tags` | `/api/tags/...` | GET/POST, JSON only | Tag management (assignment via the `TaggedWith` relation) | [DL tags](https://docs.digital.ai/agility/docs/developerlibrary/api-tags) |
| `assetdetail.v1` | `/assetdetail.v1?oid=<OID>` or `?number=<Number>` | GET → redirect | Permalink to an asset in the UI | [DL utility endpoints](https://docs.digital.ai/agility/docs/developerlibrary/utility-endpoints) |
| `API/ProjectRoles` | `/API/ProjectRoles` | GET, JSON | Member ↔ project ↔ role queries | DL utility endpoints |
| `loc.v1`, `loc-2.v1` | `/loc.v1?<key>`, `/loc-2.v1?[k1,k2]` | GET | Localised labels | [DL localization](https://docs.digital.ai/agility/docs/developerlibrary/localization-endpoints) |
| Webhooks | UI-configured outbound webhooks; a 2018-era `api/webhook` subscription API | JSON | Change notifications | [webhooks](https://docs.digital.ai/agility/docs/agility/webhook) (subscription API: *unverified current*) |
| Data Mart | SQL star schema (not HTTP) | SQL | Reporting warehouse | [DL data mart](https://docs.digital.ai/agility/docs/developerlibrary/data-mart) |

There is no `config.v1` endpoint. *docs*

### 1.3 Authentication and visibility

- **Access tokens** (recommended): created in the UI from the member's **Applications** page by adding a grant of type
  *Access Token* to a personal or public application. Applications can be created through the API; **grants cannot**.
  Sent as `Authorization: Bearer <token>`. They **never expire** and are revoked by the member or an administrator.
  The grant "allows an application to operate on the member's behalf with the same Roles and Project Memberships that
  are assigned to that member" — **there are no scopes**. They work whatever the instance's login method (Basic, NTLM,
  SAML SSO). *docs* — [DL access tokens](https://docs.digital.ai/agility/docs/developerlibrary/access-token-authentication)
  — *live (P0-06):* `Bearer` works on `query.v1` and `query.legacy.v1`; an invalid or missing token gets **401**
  `application/json` (24-byte body) with **no `WWW-Authenticate`** header and no redirect; responses carry `V1-MemberID`,
  `V1-AuthType` and `V1-SurrogateID`.
- **OAuth2 grants**: a different grant type on the same page, with expiring tokens and refresh. *docs* —
  [authorizing external application access](https://docs.digital.ai/agility/docs/agility/authorizing-external-application-access)
- **Basic authentication** (username/password) is supported and documented as less secure; **Windows Integrated
  Authentication (NTLM)** exists for on-premises installations. *docs* —
  [DL Windows authentication](https://docs.digital.ai/agility/docs/developerlibrary/windows-integrated-authentication)
- The API authentication table lists, per endpoint: `query.v1` — all methods except NTLM; `meta.v1` and `loc.v1` — none
  (no authentication); `attachment.img`, `rest-1.v1/Hist`, `rest-1.v1/New` — all. Access tokens therefore work with
  `query.v1`; P0-06 still checks older on-premises versions. (The query.v1 tour's remark about OAuth2 scope
  `query-api-1.0` concerns the interactive API console; `query.legacy.v1` accepts Basic auth or the session cookie.)
  *docs* — [DL API authentication](https://docs.digital.ai/agility/docs/developerlibrary/api-authentication)
- **Visibility**: every read and write is filtered to what the token's member can see (roles and project memberships).
  A 404 is returned both for missing assets and for assets the member cannot see. *docs* (404 not probed on the
  read-only tenant) — read errors (unknown type or attribute, malformed filter) are **400** `application/json`
  `{error, exceptions: [{type, message}]}` (*live* P0-06) —
  [DL HTTP error codes](https://docs.digital.ai/agility/docs/developerlibrary/http-error-codes)
- **Attribution**: writes are recorded under the token's member; there is no "on behalf of" header. *inferred*

### 1.4 Reading data

Parameters ([DL queries](https://docs.digital.ai/agility/docs/developerlibrary/queries)): `query.v1` supports `from`,
`select`, `page`, `sort`, `group`, `where`, `filter`, `find`, `findin`, `with`, `asof`; `rest-1.v1` supports the same
except `group`, and adds `op` (POST only). *docs*

- **rest-1.v1**: `sel` (attribute tokens), `where` (filter tokens), `sort` (`+`/`-`), `page=<size>,<start>` (size first),
  `find`/`findin` (substring search, "relatively expensive"), `asof`, `with` (`$Var=a,b|$Other=c`). `where` is ignored on
  single-asset URLs. Omitting `page` returns the whole result set. *docs / archived grammar*
- **Filter tokens**: `=`, `!=`, `<`, `<=`, `>`, `>=`, `~=` (contains); `+Attr` / `-Attr` (set / not set); `&` and `;`
  (AND), `|` (OR), parentheses; value lists (`AssetType="Task","Test"`); variables `$Name`; dot paths
  (`Category.Name`); downcasts (`Workitems:Story`); bracket filters on multi-value relations
  (`Workitems[Owners='Member:20']`); aggregations `.@Count`, `.@Sum`, `.@MinDate`, `.@MaxDate` (the archived grammar
  also lists `DistinctCount`, `Any`, `And`, `Or`, `MaxState`). Aggregations do **not** exclude deleted or template
  assets automatically. *docs / archived grammar* — [DL attributes](https://docs.digital.ai/agility/docs/developerlibrary/attributes),
  [VersionOne grammars (archived)](https://github.com/versionone/Grammars)
- **query.v1 body**: `from` (required), `select` (strings or nested `{from, select}` for relations), `where` (equality
  mapping), `filter` (list of filter-token strings, may reference `$vars`), `with` (mapping of `$var` to value, which
  "alleviates quoting issues"), `sort`, `group` (children under `_children`), `page` (`{start, size}`), `asof` (date or
  `All`), `needTotal` (otherwise `total` is `-1`). Several queries per call as a JSON array or a YAML stream. The
  response is always an **array of arrays** (one per query). *docs* — *live (P0-12, 2026-10-21, a hosted 26.0.3.2
  tenant):* the array-of-arrays shape holds, bearer access tokens work, but **`needTotal` returned no total anywhere**
  (body or headers), and `rest-1.v1/Data` reported only `pageSize`/`pageStart` (no `total`) in XML and JSON;
  **`rest-1.v1` answers JSON** with `Accept: application/json` (`{_type, pageSize, pageStart, Assets}`). P0-06 checks
  whether this depends on the version.
- **Filter composition (live, P1-04, 2026-10-21):** the entries of `filter` are ANDed (`["ID=$me","ID!=$me"]` returns
  no rows), parentheses group inside an entry, and an OR inside one entry does not leak into the others. Compiled
  shapes accepted by 26.0.3.2: `(Scope=$s|Scope.ParentAndUp=$s)` with a list, `Asset:Workitem.Scope=$s`,
  `Schedule.ScheduledScopes=$s` on `Timebox`, `Parent:Story.Number` in `select`, `Children[AssetState!='Dead'].@Count`,
  `Actuals[IsDeleted='false'].Value.@Sum`, `IsDeleted=$v` on `Actual`, `Name~=$v` and `asof` with a timestamp. — *live*
- **Predicate cost (live, P1-06, 2026-10-21):** `(Scope=$s|Scope.ParentAndUp=$s)` with one project took about 5.1 s on
  `Story` and 1.9 s on `Task`; `Scope=$list` with the project's `ChildrenMeAndDown` took 0.22–0.43 s, and the tree query
  itself about 0.2 s. `IsSelf` exists on `Member` (also on the public example instance). — *live*
- **Dates**: ISO 8601 with `Z` and up to 7 fractional digits (e.g. `2018-08-24T15:06:53.1347214Z`); date-only values are
  accepted; `ChangeDate`/`ChangeDateUTC`-style pairs exist, and the semantic difference is not documented. *docs* — **live, 2026-10-26 (P1-19):** the plain variant is a zone-less
  local time (`2026-10-01T05:00:00.0000000`) and the `…UTC` one carries `Z`; on one asset they differed by 11 hours. The
  zone of the plain variant (server, instance or member) is *unverified* (P1-20). Tools read the `…UTC` sibling whenever
  a caller selects, filters or sorts by the plain attribute.
- **Binding**: `with` substitutes named constants into the same filter grammar; it is not a prepared-statement channel,
  and no escaping rule is documented for values containing `,`, `|` or quotes on the `rest-1.v1` side. *docs* —
  **corrected (live, P0-06):** on `query.v1`, quotes, `|`, `;`, parentheses, brackets, `$`, newlines, Unicode and
  10,000-character values stay one literal value, but **a comma splits a scalar value into a value list**
  (`"zz,B-01234"` matched `B-01234`); arrays are value lists by design. Scalars with commas must be refused or split
  deliberately (L-162, P1-04). Interpolating the same text into `filter` is injectable (a contrast query matched every
  row).
- **Cost and limits (live, P0-06):** page sizes up to 2,000 work (696 ms, about 100 bytes per `ID` row); a typical row
  with status, owners, sprint and project is about 430–460 bytes; **sorting by `ChangeDate` costs about 1.1 s per call**
  against about 0.23 s by `ID` (L-163); sorting by `ID` gives disjoint, repeatable pages.

- **History tools (P6-05, 2026-10-27):** `GET rest-1.v1/Hist/<Type>/<id>?sel=<attrs>` answers JSON `{ Assets: [ { id:
  "<Type>:<id>:<moment>", Attributes: { "<path>": { value } } } ] }`, one entry per version, and the `sel` selection is
  honoured (relation paths such as `Status.Name` come back under that key). The `ChangeDateUTC` of a version carries a
  zone. — *live* (shapes and consistency only: the newest history value of `Name`, `Status.Name` and `Estimate` equals the
  current `query.v1` value on sampled recently changed assets). **Unverified:** whether `Hist` accepts a date `where` or
  `filter` on the request (the tool fetches all versions and windows them locally), how a deleted or moved asset looks, and
  that history rows match known edits (needs the writable sandbox, P6-21). `ChangeDateUTC >= $since` as a `query.v1`
  filter worked on `Story`, `Defect`, `Task` and `Test` (*live*). The activity stream was not probed (D-89).
  Selecting `AssetState` in the `asof` (history) queries of `get_sprint` made batched burndown requests time out (30 s) on the
  third-party tenant on 2026-10-27 (*live*, bisected: the same reads without it passed); the current-state read selects it without
  trouble. `asof` queries should select the fewest attributes.
  Size (P6-13, *unverified* on a tenant: measured on a synthetic body of the same shape): about 1 KB per version for 12
  selected attributes, so an asset with about 500 versions fills the Workers 512 KiB response cap; the tool then fails with a
  specific message and P6-43 looks for a way to narrow the request.

### 1.5 Writing data

- **rest-1.v1 POST** (XML): scalar `<Attribute name="X" act="set">…</Attribute>`; single relation `<Relation name="Owner"
  act="set"><Asset idref="Member:20"/></Relation>`; multi-value relation children with `act="add"` / `act="remove"`.
  *docs*
- **Operations**: `POST /rest-1.v1/Data/<Type>/<id>?op=<Name>` with an empty body; operations and their validators
  (e.g. whether an asset is deletable) are listed in `meta.v1`. Common ones: `Inactivate`, `Reactivate`, `QuickClose`,
  `Close`, `Delete`, plus an undelete endpoint. *docs* —
  [DL undelete](https://docs.digital.ai/agility/docs/developerlibrary/undelete-asset)
- **Bulk API** (`api/asset`, JSON): create `{"AssetType":"Story","Name":"…","Scope":"…"}`; update
  `{"from":"Epic:4622","update":{…}}` or **many** assets with `from` + `where`/`filter` + `update`; relation
  add/remove; `execute` an operation over a filtered set; aliases (`@name`) to reference created assets in the same
  call. `?previewOnly=true` returns the full execution plan without executing it, and the plan can be resubmitted.
  *docs* — [creation](https://docs.digital.ai/agility/docs/asset-creation-examples-1),
  [update](https://docs.digital.ai/agility/docs/asset-updation-examples),
  [operations](https://docs.digital.ai/agility/docs/asset-operation-examples), advanced topics
- **Comments, effort, links**: comments are `Conversation`/`Expression` assets, effort is `Actual`, external links are
  `Link`. *live (P0-06, metadata):* `Expression` has `BelongsTo` → `Conversation` and `Mentions` → `BaseAsset[]`;
  `Link` and `Attachment` have `Asset` → `BaseAsset`; `Actual` has `Scope`, `Team`, `Timebox`. The attributes needed to
  create them stay **unverified** until the writable sandbox (P7-07).
- **Attachments**: create an `Attachment` asset, then upload the content; documented size limit 4 MB. *docs*
  *live (P6-04, 2026-10-27, Agility 26.0.3.2, metadata and `query.v1` only):* `Attachment` has `Name`, `Filename`,
  `ContentType`, `Asset` (→ `BaseAsset`), `Description` (long text), `CreateDate`, `CreateDateUTC` and `CreatedBy` (→
  `Member`) and **no `ContentLength`**, so the size is unknown until the content is read; `ID` cannot be sorted on
  (a relation), so newest-first uses `CreateDateUTC`. `Expression` has `Author`, `AuthoredAt`, `Content`, `BelongsTo`
  and `Mentions`; comments of a work item are the `Expression` rows that mention it. The content endpoint
  (`attachments.img/<id>`, as in the developer library's utility endpoints page; `attachment.img` appears in SDK
  examples) and its `Content-Type` behaviour are **unverified**: the read-only tenant's guard allows no such request
  (P6-19).
- **Wave-1 write shapes (P7-04, 2026-10-29), all *unverified* against a real instance until the sandbox run (P7-07).** The
  tools send `POST rest-1.v1/Data/<Type>[/<id>]` with `Content-Type: application/xml` through the client's single-attempt
  `restWrite`; the document is `<Asset>` with `<Attribute name="X" act="set">value</Attribute>` and
  `<Relation name="R" act="set|add|remove"><Asset idref="Type:id"/></Relation>` children (the documented shapes above), built
  by one escaping builder (D-172). Per tool: `update_status` sets the `Status` relation on the item
  (`/Data/Story/<id>`); `assign_owners` sends `act="add"` and `act="remove"` on `Owners` for the difference only;
  `move_to_sprint` sets the `Timebox` relation; `add_comment` creates an `Expression` (`/Data/Expression`) with `Content` and a
  `Mentions` relation to the item (the shape the read side already uses: comments are the `Expression` rows that mention
  the item); `log_effort` creates an `Actual` (`/Data/Actual`) with `Value`, `Date`, `Member` and `Workitem`. Open
  questions for P7-07 (listed in P7-07): does a bare `Expression` need a `BelongsTo` `Conversation`, and does it set `Author` and
  `AuthoredAt` itself; is `Expression.Content` plain text or HTML (the tool sends plain text, escaped as XML); are `Scope`,
  `Team` and `Timebox` of an `Actual` derived from the work item or required in the request; is the response `<Asset id="Type:id:moment">`
  (the tools read the OID from it when it is) and how soon the read side shows the change (L-051); does a team workflow
  restrict `Status` on write the way the status list's `Team` attribute suggests; is `Owners` `add`/`remove` accepted in one document.
- **Lifecycle operations (P7-06, 2026-10-29), *unverified* until P7-07.** `close_asset` and `reopen_asset` send `POST rest-1.v1/Data/<Type>/<id>?op=<Name>` with no body through `restWrite` (the documented operation route above). The name is chosen from the type's `meta.v1` `Operations` (close: `QuickClose`, `Close`, `Inactivate` in that order; reopen: `Reactivate`); the developer pages for these operations were not reachable, so the names, which types have which, whether `QuickClose` also closes a story's open tasks and tests, whether a reopen is refused when the parent is closed, and the response shape are all open for P7-07 (D-186, D-187). The Phase 0 snapshot lists `QuickClose` (Story, Defect, Task), `Inactivate` and `Reactivate` (Story) and `Reactivate` (Defect) only; it is synthetic, not an instance's full list.
- **Wave-2 write shapes (P7-05, 2026-10-29), all *unverified* until P7-07.** `create_work_item` sends `POST rest-1.v1/Data/<Type>`
  (`Story`, `Defect`, `Task`, `Test`, `Epic`) with `<Attribute name="Name|Description|Estimate|DetailEstimate" act="set">` and
  `<Relation name="Scope|Priority|Super|Parent" act="set"><Asset idref="Type:id"/></Relation>`; the response is expected to be
  `<Asset id="Type:id:moment">` (the tool reports the OID). `update_fields` posts the same attributes and the `Priority` relation to
  `/Data/<Type>/<id>`, only for fields that differ. `Description` is sent as escaped HTML paragraphs. Open questions for P7-07: are
  `Scope` and `Parent` both required for a Task (does Agility derive `Scope` from `Parent`), which attributes are required on create
  without a default (the metadata flags `IsRequired` on defaulted attributes, so the tool leaves it to Agility), what `rest-1.v1/New`
  returns for each type, whether `Description` HTML is kept or re-sanitised, whether `Estimate` applies to epics and
  `DetailEstimate` to stories on this instance, and how soon `CreateDateUTC` and `CreatedBy` make the new item visible to the
  duplicate check (L-051).
- **Wave-1 extension shapes (P7-17, 2026-10-29), *unverified* until P7-07.** `move_to_sprint` with `to_backlog` sends the `Timebox` relation as `<Relation name="Timebox" act="set"></Relation>` with no child (the documented way to empty a single-valued relation; not yet seen to be accepted for `Timebox`). `log_effort` with `member` sends the `Actual` with that member's `Member` relation; whether Agility accepts an `Actual` for a member other than the token's one (permissions, project membership) is open. `update_fields` with `todo` sets the `ToDo` attribute of a Task or Test (a rollup on a Story or Defect, which the tool refuses); whether `ToDo` is writable on every instance (it can be turned off with the tracking level) is open.
- **Writable custom attributes (P7-20, 2026-10-29), *unverified* until P7-07.** `create_work_item` and `update_fields` send a custom attribute as `<Attribute name="Custom_X" act="set">value</Attribute>` (text as is, a long text as escaped HTML paragraphs like `Description`, a number as its decimal form), only for a custom, writable, single-valued attribute of kind `Text`, `LongText` or `Numeric` in `meta.v1`. Open for the sandbox: whether a `LongText` custom attribute is stored as HTML or plain text on this instance (the escaped paragraphs assume HTML, as for `Description`); whether a `Text` custom attribute has a length limit below the tool's 400 characters; whether a custom attribute that is `IsRequired` or has a default behaves differently on create; and whether a custom attribute written on create must be on the type's form for the project.
- **Create relations, re-parent and move (P7-21, 2026-10-29), *unverified* until P7-07.** `create_work_item` adds `<Relation name="Owners" act="add">` with one `<Asset idref>` per owner, `<Relation name="Team" act="set">` and `<Relation name="Timebox" act="set">` to the create document. `update_fields` sets `Super` (an epic above a story, defect or epic) or `Parent` (a story or defect above a task or test) and, to move an item, `Scope`, each as `<Relation name="R" act="set"><Asset idref="Type:id"/></Relation>`. Open: whether Agility accepts a `Scope` set on an existing story, defect or epic (and what it does to its open children, its tasks and tests, its epic and its sprint: the tool refuses an item that is in a sprint), whether a re-parent of a task or test to a story of another project is refused or moves the task, whether an epic cycle is refused, which relations are writable on create for each type, and what `rest-1.v1/New/<Type>` returns for the defaults (D-180).
- **Idempotency**: no idempotency keys; each `rest-1.v1` POST is atomic for one asset. *docs / inferred*

### 1.6 Asset model

- Inheritance (from `meta.v1` `<Base>` elements): `BaseAsset` → `Workitem` → `PrimaryWorkitem` → `Story`, `Defect`,
  `TestSet`; `Epic`, `Task`, `Test`, `Theme` derive from `Workitem`; `Scope`, `Timebox`, `Team`, `Member`,
  `RegressionTest`, `RegressionPlan`, `RegressionSuite`, `Goal`, `Request`, `Issue`, `ChangeSet`, `BuildRun`, `Milestone`,
  `Retrospective`, `Schedule` derive from `BaseAsset`; `ScopeLabel` derives from `Label`; `TeamRoom` from `Room`.
  `Attachment`, `Link`, `Conversation`, `Actual`, `Expression`, `Capacity`, `Environment` stand alone. A `Note` type no
  longer exists (`Conversation` replaced it). *docs (public meta.v1 example instance), partially unverified* — *live
  (P0-06):* `Story`, `Defect`, `TestSet` → `PrimaryWorkitem`; `Task`, `Test`, `Epic` → `Workitem`; `Issue`, `Request`,
  `RegressionTest`, `Timebox`, `Team`, `Member`, `Scope` → `BaseAsset`; `Expression`, `Attachment`, `Link`, `Actual`
  report no base. The tenant lists **192** asset types (175 on the 26.2 example instance).
- **Numbers**: work items carry a `Number` with a type prefix. Documentation examples show stories as `S-01054`; other
  instances use `B-` for stories (backlog items). Commonly seen: `E-` (Epic), `D-` (Defect), `TK-` (Task), `AT-` (Test),
  `I-` (Issue), `R-` (Request), `RP-` (RegressionPlan), `RS-` (RegressionSuite), `TS-` (TestSet). Prefixes for
  `RegressionTest`, `Goal` and `Environment` are unverified. `meta.v1` does not expose prefixes. An instance's stored prefixes (admin panel) override what is learned, per call, so an edit applies at once (P4-30). *docs + unverified* —
  *live (P0-06):* `B-`, `D-`, `TK-`, `AT-`, `E-`, `I-`, **`FG-` (Theme)**, **`G-` (Goal)**; a number resolves across
  types in one query with `from: "Workitem"` (or `PrimaryWorkitem`), which returns `AssetType`; `BaseAsset` is refused.
- **Status vs AssetState vs rollup category**: `Status` is an admin-configurable list per type; `AssetState` is the
  shared lifecycle integer: 0 Future, 64 Active, 128 Closed, 200 Template (dead), 208 Broken down (dead), 255 Deleted
  (dead), 209 Guest collaborator (members only); the rollup category (Not Started / In Progress / Completed) is for
  reporting only. *docs* — [rollup categories](https://docs.digital.ai/agility/docs/agility/rollup-category-status-values)
- **Common attributes**: `Name`, `Number`, `Description` (long text, HTML), `Status`, `Owners` (multi-relation to
  `Member`), `Team`, `Scope`, `Timebox`, `Super`/`Subs` (portfolio tree), `Estimate`, `ChangeDate`, `CreateDate`,
  `ClosedDate`-style dates with `…UTC` variants. `DetailEstimate`, `ToDo`, `Priority`, `Source`, the task/test parent
  relation and `Children` are well known from VersionOne usage but **unverified** against current metadata. — *live
  (P0-06):* `Task.Parent` → `PrimaryWorkitem`, `Test.Parent` → `Workitem`, `Story.Parent` → **`Theme`** (the epic is
  `Super`), `Children`/`Subs` → `Workitem[]`, `Scope.ChildrenMeAndDown` (a project and its descendants), `Timebox`
  reaches projects through `Schedule`, and `Team` has **no member roster** relation.
- **Custom attributes** use the `Custom_` prefix and carry `iscustom="True"` in `meta.v1`. *docs / unverified rule* —
  *live (P0-06):* the `Custom_` prefix holds; custom types seen: `Text`, `LongText`, `Date`, `Relation`.
- **`meta.v1` JSON shape (live and public example instance, P1-03, 2026-10-21):** an asset type's **`Token` is its
  name**; `Name` is an object `{ href, tokenref }` pointing at the type's Name attribute. Type keys: `_type`, `HREF`,
  `Version`, `Name`, `Token`, `DisplayName`, `Abstract`, `Base`, `DefaultOrderBy`, `DefaultDisplayBy`, `ShortName`,
  `Description`, `Attributes`, `Operations`. Attribute definitions carry `Name`, `Token`, `DisplayName`,
  `AttributeType`, `IsReadOnly`, `IsRequired`, `IsMultivalue`, `IsCanned`, `IsCustom`, `Base`, `OrderByAttribute`,
  `DisplayByAttribute`, `RelatedAsset` and `ReciprocalRelation`; operations `Name` and `Validator`. `AttributeType`
  values seen: `AssetType`, `Boolean`, `Date`, `LocalizerTag` (e.g. `Role.Name`), `LongInt`, `LongText`, `Numeric`,
  `Opaque`, `Rank`, `Relation`, `State`, `Text`. Every type's `ID` relates to the type itself. — *live + public*
- **Status lists (live, P1-03):** `StoryStatus` and `EpicStatus` derive from `Status` (itself a `List`) and carry
  `RollupState`; `TaskStatus` and `TestStatus` derive from `List` directly and have no rollup. Every list type has
  `Order`, `Inactive` and a `Team` relation (team-specific workflows). — *live*
- **`Actual` (effort) has no `AssetState`** (it has `IsDeleted`), no `Name` and no base type; `Role` and `Attachment`
  report no base either. The dead-asset filter (L-143) must use `IsDeleted` for such types. — *live + public*
- **Metadata fingerprint (live, P0-06):** `meta.v1` sends `ETag: "<version>.<schema stamp>"` and
  `Cache-Control: public, max-age≈2,600 s`; no `Last-Modified`. The whole schema is 5.1 MB of JSON (5.1 s).

### 1.7 Limits and behaviour

- **Rate limiting** on hosted instances: per-consumer quotas by time window, response size, request count or **error
  count**. Exceeding one returns **HTTP 429** with a JSON body naming the limit and the wait:
  `{"Message": "API request quota exceeded. Maximum of 20 errors per 60 second(s)", "RetryAfter": "50"}`. A usage-metrics
  page exists for self-service. *docs* — [DL rate limiting](https://docs.digital.ai/agility/docs/developerlibrary/what-is-api-rate-limiting),
  [DL usage metrics](https://docs.digital.ai/agility/docs/developerlibrary/retrieving-api-usage-metrics)
- **HTTP errors**: 400 (bad request), 401 (unauthenticated), 404 (not found or not visible), 405 (wrong verb or
  non-updatable URL), 429, 500 (XML exception body). *docs*
- **Paging**: no documented maximum page size; omitted paging returns everything. *docs*
- **Payload limits**: only the 4 MB attachment limit is documented. **ETags/caching**: not documented. **Read-after-write
  consistency**: not documented. *docs*
- **URLs**: hosted `https://www{N}.v1host.com/{Instance}/…`; on-premises base URLs are chosen by the customer. TLS, CORS
  and IP allowlist behaviour are not documented. *docs*

### 1.8 Events

- Outbound webhooks are configured in the UI ([outbound webhook creation](https://docs.digital.ai/agility/docs/agility/outbound-webhook-creation)).
  A 2018-era subscription API (`POST api/webhook`, events `AssetCreated`/`AssetChanged`, 5 enabled subscriptions,
  disabled after 5 consecutive failures) appears only in archived documentation. *unverified current*
- Without webhooks, change detection polls `rest-1.v1/Hist` (authoritative) or the activity stream (not complete).

### 1.9 SDKs

| SDK | Repository | Last activity | Notes |
|---|---|---|---|
| Java | `versionone/VersionOne.SDK.Java.APIClient` | 2026 | Maintained; `V1Connector` builder with access token, username/password, Windows auth |
| .NET | `versionone/VersionOne.SDK.NET.APIClient` | 2022 | Stale |
| Python | `versionone/VersionOne.SDK.Python` | 2021 | Semi-stale |
| JavaScript | `versionone/VersionOne.SDK.JavaScript` (`v1sdk`) | 2020 | Stale; we will not depend on it |
| PowerShell | prototype | 2017 | Never published |

The SDKs confirm the request patterns (connector → services → query/save/execute operation) but none is a suitable
dependency for a Workers-compatible core. *docs (GitHub)*

### 1.10 Terms and trademarks

- "Digital.ai" is a trademark of Digital.ai Software, Inc.; the Terms of Use forbid using its trademarks "in connection
  with any product or service that is not ours, or in any manner that is likely to cause confusion". There is no
  dedicated trademark page. *docs* — [Terms of Use](https://digital.ai/terms-of-use/)
- The Acceptable Use Policy limits use to interfaces "provided or expressly authorized" and prohibits using service data
  to create, train or improve machine-learning systems. agility-bridge uses the documented APIs, keeps no corpus and
  trains nothing; the README says so ([ADR-0002](adr/0002-name-and-trademark.md)). *docs*

---

## 2. MCP protocol and TypeScript SDK

Checked 2026-10 in specifications and SDK documentation; P0-07 re-verifies with real clients.

- **Protocol eras.** The 2026-07-28 revision removes protocol-level sessions: no `initialize` handshake and no
  `Mcp-Session-Id`; `server/discover` replaces up-front negotiation; protocol version and client capabilities travel in
  each request's `_meta`; new `Mcp-Method` and `Mcp-Name` HTTP headers must match the body. 2025-era clients
  (2025-06-18, 2025-11-25) still use `initialize`. — [specification](https://modelcontextprotocol.io/specification/2026-07-28)
- **2026-07-28 also** replaces server-initiated elicitation, sampling and roots requests with *multi round-trip requests*
  (the server answers `input_required` and the client repeats the call with the answers), deprecates roots, sampling and
  logging (12-month grace period), makes Client ID Metadata Documents the standard client registration and requires
  RFC 9207 issuer validation. — [2026-07-28 announcement](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- **Adoption is uneven (October 2026):** Claude Code, Copilot CLI, Windsurf/Devin Desktop and MCP Inspector v2 speak
  2026-07-28; Cursor was documented as capped at 2025-11-25 *(unverified)*. VS Code (GitHub Copilot) was documented the
  same way, but **P0-07 found it on 2026-07-28** over stdio and HTTP (2026-10-20, *live*), while **Copilot in JetBrains
  and MCP Inspector CLI 2.11.0 negotiate a 2025-era revision** (*live*). Serving both eras is mandatory
  ([client compatibility](reference/client-compatibility.md)).
- **Batching** was removed in 2025-06-18. — [changelog](https://modelcontextprotocol.io/specification/2025-06-18/changelog)
- **Headers on the legacy path**: `Mcp-Method`/`Mcp-Name` are only trustworthy after modern-era validation; legacy
  requests can carry arbitrary values, so audit and rate limiting must read the JSON body there.
- **`subscriptions/listen`** is a long-lived POST that some clients (e.g. Claude Code) open on connect; it must not be
  counted as a tool call.
- **Tool-list changes on stateless HTTP**: there is no session to receive `notifications/tools/list_changed`; the
  2026-07-28 revision offers cache hints (`ttlMs`, `cacheScope`) but no list version or ETag. Advertise `listChanged:
  false` and tell users to reconnect after upgrades.
- **Tools**: input and output schemas are JSON Schema 2020-12; a tool with an `outputSchema` returns `structuredContent`
  together with the `content` text; annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`)
  are hints for clients.
- **Elicitation** lets a server ask the user a question during a request when the client declares the capability.
  Stateless 2025-era HTTP requests carry no capabilities after `initialize`, so they cannot be elicited reliably.
- **Tasks extension** (`io.modelcontextprotocol/tasks`, SEP-2663): declared by the client per request and by the server
  in `server/discover`; statuses `working`, `input_required`, `completed`, `failed`, `cancelled`; methods `tasks/get`,
  `tasks/update`, `tasks/cancel` (no `tasks/list` or `tasks/result` in 2026-07-28); task ids must be unguessable and every
  task request authorised. — [ext-tasks](https://github.com/modelcontextprotocol/ext-tasks)
- **MCP Apps** (`io.modelcontextprotocol/ui`): `ui://` resources with MIME `text/html;profile=mcp-app`, linked from a tool
  through `_meta.ui.resourceUri`, rendered by the host in a sandboxed iframe with CSP declarations; the view talks
  JSON-RPC over `postMessage`. Hosts that do not support it ignore the metadata. —
  [ext-apps](https://github.com/modelcontextprotocol/ext-apps)
- Logging and sampling moved out of the core protocol in 2026-07-28; do not depend on them.
- **TypeScript SDK v2** (`@modelcontextprotocol/server`, `@modelcontextprotocol/client`, 2.x): `serveStdio(() => build())`
  for stdio; `createMcpHandler(factory, { legacy: 'stateless' })` for HTTP, building a server per request and serving
  both eras; the handler passes `authInfo` unchanged to the factory. The legacy stateless path still executes JSON-RPC
  batches (reject them before the SDK). The default body limit is 4 MiB. Host/Origin validation is hostname-based and
  lets a missing `Origin` through. Prompts and resources are registered with `listChanged: true` unless set explicitly.
  `ProtocolError(code, message, data)` produces stable JSON-RPC errors; other thrown errors become `-32603`. The SDK has
  no server-side Tasks runtime; task storage and `tasks/*` routing are the application's job. — SDK repository
  [typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- **Measured with SDK 2.3.1** (P0-07, 2026-10-20, *live* on Node 24 and local workerd; [results](../spikes/mcp-sdk-v2/RESULTS.md)):
  both eras pass on Node, workerd (no `nodejs_compat`) and stdio; the 2025-era HTTP path answered a two-request JSON-RPC
  batch; converting tool schemas to JSON Schema once and registering them with `fromJsonSchema` makes a per-request
  25-tool `tools/list` about 7× cheaper (0.70 ms vs 4.89 ms p50; 40 tools 0.91 ms vs 7.60 ms). Write approval: 2025-era
  push elicitation (`ctx.mcpReq.elicitInput`) works on stdio only; 2026-07-28 `inputRequired(...)` works on stdio and
  HTTP; both need the client to declare the capability, and on 2026-07-28 an `inputRequired(...)` sent to a client
  without it becomes an SDK error rather than a tool result. Input-schema validation failures come back as tool results,
  not JSON-RPC errors.

## 3. MCP clients

Summary only; the per-client matrix, configuration formats and verification status are in
[reference/client-compatibility.md](reference/client-compatibility.md).

- **Protocol eras**: Cursor negotiates up to 2025-11-25 only *(documented, unverified)*; Claude Code (from v2.1.292,
  2026-10-06), Copilot CLI (v1.0.81, 2026-08-27), Windsurf/Devin Desktop (v3.10.67, 2026-10-12) and MCP Inspector v2
  (explicit `protocolEra` switch) speak 2026-07-28. *live, P0-07 (2026-10-20):* 2026-07-28 on stdio and HTTP for
  VS Code (Copilot), Claude Code 2.1.304 and Copilot CLI 1.0.87; a 2025-era revision for Copilot in JetBrains (HTTP)
  and MCP Inspector CLI 2.11.0.
- **Tool-count caps**: Cursor 40 tools; Windsurf/Devin Desktop 100 enabled tools across all servers; VS Code 128 tools per
  request (with automatic "virtual tool" grouping). A small default catalogue matters (L-155).
- **Annotations**: only VS Code uses `readOnlyHint` (to skip confirmation); no surveyed client changes its UI for
  `destructiveHint`. Safety cannot rely on annotations (L-154).
- **Elicitation**: form mode in VS Code, JetBrains, Cursor; form and URL mode in Claude Code and Copilot CLI; not in the
  Copilot cloud agent, Zed or Gemini CLI. Over stateless remote HTTP, 2025-era clients cannot be elicited (*live*, P0-07:
  even a client that declares elicitation is refused, because each request builds a server that never saw its
  capabilities), so remote write approval needs an out-of-band path for 2025-era clients: Copilot in JetBrains
  (verified) and Cursor (documented) (L-156, P7-02). VS Code, Claude Code and Copilot CLI approved and declined writes
  through `input_required` on stdio and HTTP (*live*, P0-07).
- **MCP Inspector CLI 2.11.0** (*live*, P0-07): 2025 era on HTTP and stdio, renders `structuredContent`, cannot elicit;
  `-e KEY=value` reaches a stdio server's environment.
- **Remote authentication**: static headers everywhere (JetBrains nests them under `requestInit.headers`; Claude Desktop
  and claude.ai allow a few headers in a beta UI); OAuth with DCR and CIMD in VS Code, Claude, Copilot CLI and Inspector;
  DCR plus static clients in Cursor; the Copilot cloud agent supports no OAuth (static headers from `COPILOT_MCP_*`
  secrets only).
- **Hosted Claude connectors** (claude.ai, desktop Chat tab, mobile) reach only public IPv4 HTTPS endpoints (private,
  CGNAT, loopback, link-local and IPv6-only hosts are refused) and use the fixed callback
  `https://claude.ai/api/mcp/auth_callback`.
- **Secrets in configuration**: VS Code prompts and stores secrets (`inputs` with `password: true`); Cursor, JetBrains and
  Inspector headers are stored in plain text; Claude Code blanks credential-like variables referenced from a project
  `.mcp.json` for remote servers and keeps OAuth tokens in the OS keychain.
- **Windsurf** became **Devin Desktop** (Cascade agent removed 2026-09-08; configuration moved from
  `~/.codeium/windsurf/mcp_config.json` to `~/.config/devin/mcp_config.json`).

### Remote client configuration formats (P4-06)

Read 2026-10-23 in the vendors' documentation; *docs* unless stated, none run by P4-06 itself (the per-client verification
status is in [client-compatibility](reference/client-compatibility.md#remote-snippets-p4-06)).

- **Claude Code**: `claude mcp add --transport http <name> <url> --header "Authorization: Bearer …"`; `--scope local|project|user`
  (default `local`); `.mcp.json` `mcpServers.<name>` with `type: "http"`, `url`, `headers`, and `${VAR}` / `${VAR:-default}`
  expansion in `url` and `headers`. Variables named like credentials (`ANTHROPIC_AUTH_TOKEN`, `NPM_TOKEN`, …) read as empty in
  remote `url` and `headers`; a configured `Authorization` header is not replaced by OAuth; `claude mcp add` does not check the
  credential. Source: https://code.claude.com/docs/en/mcp
- **VS Code**: `servers.<name>` with `type: "http"`, `url`, `headers`; `inputs` entries `{ type: "promptString", id, description,
  password: true }` referenced as `${input:id}`, asked once and stored securely; input variables are not supported in portable
  `.mcp.json` or Copilot `mcp-config.json` files. Source: https://code.visualstudio.com/docs/agents/reference/mcp-configuration
- **Cursor**: `mcpServers.<name>` with `url` and `headers`; `${env:NAME}` resolves in `command`, `args`, `env`, `url` and
  `headers`; files `~/.cursor/mcp.json` and `.cursor/mcp.json`. Source: https://cursor.com/docs/context/mcp
- **Copilot CLI**: `~/.copilot/mcp-config.json` `mcpServers.<name>` with `type: "http"`, `url`, `headers`, `tools` (default
  `["*"]`); `copilot mcp add --transport http --header "H: V" <name> <url>` (transport defaults to stdio). Header variable
  substitution is not documented on that page: *unverified*. Source:
  https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers
- **Copilot in JetBrains**: remote `servers.<name>` with `url` and `requestInit.headers`; no OAuth option described. Source:
  https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/extend-copilot-chat-with-mcp
- **Windsurf / Devin Desktop**: legacy Cascade agent only: `mcpServers.<name>` with `serverUrl` (or `url`) and `headers`; `${env:VAR}`
  (empty when unset) and `${file:/path}` interpolation in `command`, `args`, `env`, `serverUrl`, `url`, `headers`; file
  `~/.config/devin/mcp_config.json` (`%APPDATA%\devin\mcp_config.json` on Windows). The Devin Local agent uses the Devin CLI
  files instead (not covered). Source: https://docs.devin.ai/desktop/cascade/mcp
- **MCP Inspector CLI**: `--cli <url> --transport http --header "Name: value" --method tools/list` as run in the P0-07 spike
  (`spikes/mcp-sdk-v2/RESULTS.md`); the repository README does not document the flags (*live*, not *docs*).
- **PowerShell**: `Read-Host -MaskInput` needs PowerShell 7.1+ (*unverified*, from memory of the cmdlet's release notes); the
  Windows snippet is marked accordingly.

## 4. OAuth 2.1 for MCP

- **Protected resource metadata** (RFC 9728): a 401 carries `WWW-Authenticate` with `resource_metadata`; otherwise
  clients try `/.well-known/oauth-protected-resource/{path}` and then the root. The metadata must list at least one
  authorization server. — [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization),
  [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728)
- **Resource indicators** (RFC 8707) are required on authorization and token requests, and clients send `resource` again
  on refresh; tokens must be audience-bound to the exact MCP resource URL. — [RFC 8707](https://www.rfc-editor.org/rfc/rfc8707)
- **Authorization server discovery**: RFC 8414 metadata first, OpenID discovery second; clients validate the RFC 9207
  `iss` response parameter when advertised. — [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414),
  [RFC 9207](https://www.rfc-editor.org/rfc/rfc9207)
- **Client ID Metadata Documents** (CIMD) are the preferred registration: the `client_id` is an HTTPS URL whose JSON
  document (recommended ≤ 5 KiB) lists `client_name` and `redirect_uris`; the `client_id` must equal the document URL.
  Servers must treat fetching it as an SSRF risk and should show the redirect host. **Dynamic Client Registration**
  (RFC 7591) remains for compatibility. — [CIMD draft](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/),
  [RFC 7591](https://www.rfc-editor.org/rfc/rfc7591)
- **PKCE** S256 should be required for every client, including confidential ones; token endpoints take
  `application/x-www-form-urlencoded`.
- **Refresh-token rotation** with a reuse interval: identity providers commonly allow 0–60 s (Okta's default 30 s) for
  concurrent refreshes. — [Okta refresh tokens](https://developer.okta.com/docs/guides/refresh-tokens/main/)
- **Claude hosted clients** (claude.ai web, Claude Desktop remote connectors, Claude mobile) share one OAuth client:
  CIMD `https://claude.ai/oauth/mcp-oauth-client-metadata`, callback `https://claude.ai/api/mcp/auth_callback`; they
  need an internet-reachable HTTPS URL, use only the first authorization server listed, and allow about 10 s for
  discovery, registration and token calls (30 s for refresh). Claude Code's CIMD is
  `https://claude.ai/oauth/claude-code-client-metadata` with a loopback callback. —
  [Claude connector authentication](https://claude.com/docs/connectors/building/authentication) *(re-verify)*
- **Consent pages** must work in mobile browsers: a CSP `form-action 'self'` blocks a consent POST that redirects to a
  loopback callback, so the callback origin must be allowed (IPv6 literals need the `http:` scheme source).
- **Cloudflare `workers-oauth-provider`** (1.2.x) implements DCR, CIMD, PKCE S256, RFC 9207, refresh rotation and
  revocation, accepts only form-encoded token requests, and its code exchange is not atomic on KV (add a single-use
  marker). — [workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider) — *live (P0-08, 1.2.3, local
  workerd and Node, 2026-10-21):* per-path protected resource metadata, audience binding with refresh that cannot
  retarget, CIMD with Claude Code's real document, PKCE S256 only, RFC 9207 `iss`, DCR and revocation all confirmed;
  **five parallel refreshes all succeed but only the last new refresh token stays usable** (no reuse interval, L-164).
  The same holds in production on Workers Free, where endpoints answer in about 0.2 s; Claude Code 2.1.304 and VS Code
  1.142.0 register through CIMD (`https://claude.ai/oauth/claude-code-client-metadata`,
  `https://vscode.dev/oauth/client-metadata.json`), MCP Inspector CLI 2.11.0 through DCR. *live*

- **P5-05 (2026-10-24), refresh handling of `workers-oauth-provider` 1.2.3** (read in the package's `dist/oauth-provider.js`,
  `handleRefreshTokenGrant`, and [storage-schema.md](https://github.com/cloudflare/workers-oauth-provider/blob/main/storage-schema.md)).
  A grant record holds the current and the previous refresh token ids; a refresh with either is accepted, with no time
  limit on the previous one, and rotates again (the old "previous" is dropped), so parallel refreshes each mint a
  successor and only the last survives. The token endpoint authenticates the client (secret, auth method) **before** it
  dispatches the grant, and the refresh handler checks token, client id, grant expiry and `resource` after that; a refresh
  with a well-formed but unknown token for an existing grant answers `invalid_grant` without changing anything, which is
  what the reuse window's client-authentication probe relies on. `unwrapToken(accessToken)` returns the decrypted grant
  props of a live access token. Okta documents the same pattern (grace period of 0-60 s, default 30 s) for concurrent
  refresh requests. *Verified against the provider's code and the suites on Node memory, SQLite and workerd/D1; not
  against a real instance of any MCP client.*

- **P5-01 (2026-10-24), `workers-oauth-provider` 1.2.3 as built into the server.** Confirmed against the package's own
  documentation ([storage-schema.md](https://github.com/cloudflare/workers-oauth-provider/blob/main/storage-schema.md),
  [AGENTS.md](https://github.com/cloudflare/workers-oauth-provider/blob/main/AGENTS.md); read through Context7) and by
  the P5-01 suites on Node (memory, SQLite) and workerd (D1): codes, access tokens and refresh tokens are stored as
  SHA-256 hashes (client secrets too; PKCE keeps only the challenge); `props` are AES-GCM encrypted with a per-grant key
  wrapped under the code, the refresh token and each access token, so only a token holder can open them; tokens are
  `userId:grantId:secret` (secret 32 characters). **Public clients** get PKCE enforced by the provider; the provider also
  refused a confidential client without `code_challenge` in the tests, and our own check stands behind it. **Refresh
  rotation keeps the previous refresh token usable** until the new one is first used (a lost response must not strand a
  client): the previous token still answered `200` after a rotation, so strict reuse detection is ours to build (P5-05).
  Expiry of codes rests on the key's TTL in `kv`, not a timestamp the provider checks. The library prints a
  `console.warn` about CIMD when it is loaded without Workers' `global_fetch_strictly_public` flag (harmless: we turn its
  CIMD off, P5-03 supplies our own). The `@modelcontextprotocol/client` 2.3.1 OAuth functions (`discoverAuthorizationServerMetadata`,
  `registerClient`, `startAuthorization`, `exchangeAuthorization` with the RFC 9207 `iss` check, `refreshAuthorization`,
  `auth()`) drive the server as written; without a protected resource metadata document the SDK does not send `resource`
  (P5-02) unless the client provider names it through `validateResourceURL`. 1.2.4 was published 2026-10-22 and is not
  used yet (3-day release age). *live (local, workerd and Node)*

- **P5-02 (2026-10-24), discovery as the clients do it.** The MCP authorization pages
  ([2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization),
  [2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)) and
  [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728): a server publishes protected resource metadata and either names it
  in `WWW-Authenticate: Bearer resource_metadata="…"` on `401` or serves it at the well-known URI; clients use the header
  first, else try `/.well-known/oauth-protected-resource` with the resource's path inserted (RFC 9728 §3.1), then the root;
  the document's `resource` must match the URL the client used, and `authorization_servers` lists at least one issuer;
  `scope` in the challenge is a SHOULD and `offline_access` stays out of it. Read in the `@modelcontextprotocol/client`
  2.3.1 source and exercised by the P5-02 suites: `extractWWWAuthenticateParams` takes `resource_metadata`, `scope` and
  `error` from a `Bearer` challenge (it needs a parameter after the scheme, so `realm` is kept); `auth()` without a
  `resourceMetadataUrl` fetches `/.well-known/oauth-protected-resource/w/{slug}/mcp`, falls back to the root document
  (our `404`: no resource lives at the root) and then derives the `resource` it sends from the document, so no
  `validateResourceURL` workaround is needed; it adds `offline_access` to the scope itself when the server metadata lists
  it. The challenge and the document are the same for every denial and every slug of valid syntax, as the MCP route's
  own `401` is (T19). *live (local, workerd and Node)*

- **Client ID Metadata Documents (P5-03, 2026-10-24).** `draft-ietf-oauth-client-id-metadata-document-02` (6 July 2026,
  <https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document>) and the MCP authorization spec
  (2025-11-25 and 2026-07-28, <https://modelcontextprotocol.io/specification/draft/basic/authorization>): the client id is an
  https URL with a path, no userinfo, dot segments or fragment (a port is allowed, we refuse it); the document's `client_id`
  must equal the URL by simple string comparison; only a `200` is success and redirects must not be followed; read at most
  about 5 KB; caching optional, follow HTTP cache headers within server bounds, never cache errors; `token_endpoint_auth_method`
  must not be a shared-secret method and `client_secret*` must not appear; the server must not fetch a URL that resolves
  to a special-use address (loopback only for development with a loopback server); redirect URIs compare exactly (the
  provider adds RFC 8252 any-port matching for loopback). MCP names metadata documents as the preferred method and keeps
  DCR (RFC 7591) as a compatibility path. The provider (1.2.3) with `allowPrivateUseRedirectUris` off sends codes only to
  https and loopback http redirects. *Spec read 2026-10-24; behaviour exercised by the P5-03 suites, no real client yet
  (P5-06)*; client behaviour (which clients send which metadata) is *unverified*.

## 5. Cloudflare Workers platform

Checked 2026-10 in Cloudflare documentation; P0-09 measures with Agility-shaped payloads.

- **Workers limits**: Free — 100,000 requests/day, 10 ms CPU per request, 50 external subrequests (plus 1,000 to
  Cloudflare services), 128 MB memory, 6 simultaneous open connections; Paid — 30 s default CPU (configurable up to
  5 min), 10,000 subrequests (configurable), no daily request cap. —
  [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- **Pricing (2026-10-22)**: Workers Paid from 5 USD a month per account, 10 million requests and 30 million CPU-ms
  included; D1 Free 5 million rows read and 100,000 written a day, 5 GB; D1 on Paid 25 billion read and 50 million
  written a month included. — [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
  [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- **D1**: no interactive transactions (`batch()` is one transaction); statement size ≤ 100 KB; ≤ 100 bound parameters;
  rows/strings ≤ 2 MB; 30 s per query; read-only queries retried by the platform, writes not; foreign keys enforced;
  Free: 5 M rows read and 100,000 written per day. — [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- **D1 write accounting for counters (2026-10-24)**: Free allows 100,000 rows written a day; a refused conditional upsert
  (`INSERT … ON CONFLICT DO UPDATE … WHERE … RETURNING` that changes no row) writes nothing locally (`node:sqlite` and
  local D1 agree, P5-09 tests); whether D1 bills the attempt of a statement that changed no row is *unverified* against a
  real database (no probing of the service), so the design caps counters by their own `max` and remembers a refusal in the
  isolate instead of relying on it. — [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- **Durable Objects** (SQLite-backed on Free): good for an exact deployment-wide limiter; each call is billed and placed
  near the first caller. — [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- **Rate Limiting binding**: `limit({ key })` → `{ success }`, periods of 10 or 60 s, per location and eventually
  consistent — a backstop only. — [Rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- **Cache API**: per data centre, not replicated; counts toward subrequest limits; unavailable behind Cloudflare Access
  *(unverified)*. On `workers.dev` it **worked** in P0-09 (`put` then `match` hit within and across requests, Free plan,
  2026-10-20, *live*); a custom domain is still to check (P3-03). —
  [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)
- **Cross-request I/O**: a promise for I/O started by one request must not be awaited by another (it can hang or fail).
- **Outbound TLS**: Workers verify publicly trusted certificates only; there is no option to trust a private CA for
  `fetch`, and private networks are reachable only through Cloudflare connectivity products (e.g. a tunnel). On-premises
  instances with a private CA therefore need the Node/Docker deployment ([ADR-0014](adr/0014-supported-agility-installations.md)).
  *live, P0-09:* a deployed Worker gets **HTTP 526** for self-signed, untrusted-root and expired certificates (local
  workerd throws an opaque error instead, L-160).
- **No `DOMParser`** in Workers: XML from `meta.v1`, `Hist` and `rest-1.v1` needs a pure-JavaScript parser with entity
  expansion disabled. P0-09 chose **saxes 6** (streaming, 8 KB gzip, refuses custom and external entities, about 1 ms
  for an 83 KB `meta.v1/Story`) and prefers JSON wherever Agility serves it. *live, P0-09*
- **Measured in P0-09** (2026-10-20, [results](../spikes/workers-limits/RESULTS.md)): `meta.v1` for all 175 asset types
  is 4.1 MB of XML or 4.8 MB of JSON (one type about 83–97 KB), so a Worker loads metadata per asset type; read + parse +
  shape costs about 3.5–4.5 ms per MB on Node and **about 8 ms per MB on a deployed Worker** (Free plan: 4 ms p50 /
  8 ms p99 at 512 KiB, 8 / 18 ms at 1 MB, 39 / 56 ms at 5 MB, nothing terminated), so the 512 KiB Free cap stands; the
  Rate Limiting binding let 8 of 10 calls through against a limit of 5 per 10 s (a backstop only); an untrusted certificate fails `fetch` on workerd with an opaque `internal error;
  reference = …` (L-160); local D1 and `node:sqlite` agree on STRICT tables, foreign keys, `ON CONFLICT … DO UPDATE …
  WHERE … RETURNING` and JSON functions, but D1's `meta.changes` includes cascaded rows (L-161). *live (local), P0-09*
- **Sealing a shared-tier entry on workerd (2026-10-30, P8-38; local workerd 1.20261006.1 through miniflare, *local and
  indicative*, not a deployed Worker).** Measured by timing from outside one request that loops an operation (timers do not
  advance while code computes in an isolate), on a machine with a load average of about 2, best of three, per call, for 8 /
  64 / 100 / 256 KB of JSON: `toBase64` with the byte-slice loop 0.2 / 1.8 / 2.7 / 7.3 ms, with the runtime's own
  `Uint8Array.prototype.toBase64` 0.0 / 0.02 / 0.01 / 0.05 ms (workerd has it; Node 24 does not, so the loop stays as the
  fallback); `seal` 0.25 / 2.2 / 3.2 / 8.7 ms before and 0.04 / 0.24 / 0.37 / 1.1 ms after using it; `open` 0.05 / 0.45 / 0.73 /
  2.0 ms before and 0.04 / 0.29 / 0.45 / 1.4 ms after; parsing the sealed wrapper and the body (the "double parse") 0.01 to
  0.3 ms even at 256 KB, so it does not matter. A hit costs about `open` plus the body parse; a miss about `seal` plus
  `Cache.put` and the first read-back. Not measured: `Cache.put` and `Cache.match` themselves, CPU as Cloudflare bills it, a
  deployed Worker (needs P8-13). — [Uint8Array base64 proposal](https://github.com/tc39/proposal-arraybuffer-base64)
- **Browser Integrity Check / bot protection** on custom domains can answer non-browser MCP clients with error 1010 or
  403; a WAF exception for the MCP paths is needed.

## 6. Node.js, Docker, SQLite, npm and registries

- **Node 24 LTS** ships `node:sqlite` (synchronous SQLite, D1-compatible SQL). Its stability index is below "Stable"
  (release candidate at the time of writing, *verify*): pin a minimum Node 24 minor and test the next LTS before
  claiming support for it. The distroless image
  `gcr.io/distroless/nodejs24-debian13:nonroot` includes it, has no shell, and needs a Node-based healthcheck. —
  [Node.js sqlite](https://nodejs.org/api/sqlite.html)
- **Custom CAs on Node**: `NODE_EXTRA_CA_CERTS` adds CA certificates at process start; a per-instance CA needs an
  undici `Agent` with `connect: { ca }` passed to `fetch`'s dispatcher (Node-only code, injected into the core). —
  [Node CLI docs](https://nodejs.org/api/cli.html#node_extra_ca_certsfile)
- **npm trusted publishing** (OIDC from GitHub Actions) needs npm CLI ≥ 11.5.1 and a GitHub-hosted runner; **staged
  publishing** keeps a published version private until a maintainer approves it with 2FA. —
  [trusted publishers](https://docs.npmjs.com/trusted-publishers), [staged publishing](https://docs.npmjs.com/staged-publishing) *(re-verify)*
- **npm staged publishing, observed 2026-10-19** (npm CLI 11.16.0, publishing `agility-bridge@0.0.0`): staged
  publishing needs npm CLI ≥ 11.15.0 (`npm stage publish|list|view|download|approve`). The first publish of a new name
  created a public stub `0.0.0-stage` ("Temporary package placeholder for staged publishing"). Approval asked for
  browser-based 2FA, which fails with `EOTP` in a non-interactive shell; once approved, the version became `latest`. —
  [staged publishing](https://docs.npmjs.com/staged-publishing), live
- `pnpm pack` resolves `workspace:` dependencies and adds the root `LICENSE`, but not `NOTICE` or `README.md`; include
  them explicitly.
- **MCP Registry**: servers are described by a `server.json` (package, transport, environment variables marked secret or
  not) and published under a namespace such as `io.github.<owner>/<name>`. —
  [MCP Registry](https://registry.modelcontextprotocol.io/)
- **OS keychains** without native modules: macOS `security` (read commands from stdin with `-i` so secrets never appear in
  argv), Linux `secret-tool` (Secret Service), Windows PowerShell `PasswordVault`/Credential Manager. `keytar` is
  archived.

## 7. Prior art

- **No maintained open-source MCP server for Digital.ai Agility or VersionOne was found** (searched GitHub, npm, PyPI, the
  MCP Registry, Smithery, Glama, mcp.so, PulseMCP and the Docker MCP catalog, October 2026). The only public artifact is
  [Quantiser/mcp-server](https://github.com/Quantiser/mcp-server): a single-commit Python prototype from 2025-07-30 with
  four read-only tools for stories and epics, no license and no activity since.
- Name collisions to keep in mind: **Agility CMS** (an unrelated headless CMS with its own MCP server) and **Agility PR
  Solutions** (unrelated). Package descriptions must say "Digital.ai Agility".
- **Digital.ai** offers an official MCP server for its **Release** product, not for Agility. —
  [Release MCP server](https://docs.digital.ai/release/docs/next/how-to/release-mcp-server)
- **Comparable work-management MCP servers** (GitHub, Atlassian Rovo, Azure DevOps, Linear), the Agility SDKs and the
  Release MCP server were reviewed in P0-10 (2026-10-20). None binds query values (JQL, WIQL and Agility `where` filters
  are strings the caller builds), and none ties write approval to the exact change; both are agility-bridge
  differentiators (ADR-0012, ADR-0013). The SDK pages never mention `query.v1` or `with` variables, so the binding
  behaviour remains a P0-06 question. Matrix, adopt / avoid / differentiate lists and follow-ups:
  [research/prior-art.md](research/prior-art.md).

## 8. Open questions for the Phase 0 spikes

**P0-06 (Agility API)** — on a hosted sandbox and, if available, an on-premises instance:

1. Confirm access tokens with `query.v1` on every instance version we support (documented as supported). Which errors
   and bodies come back for bad tokens, missing permissions, invalid attributes and unknown asset types (status, content
   type, shape)?
2. `with` binding in `query.v1` JSON: behaviour with quotes, commas, pipes, Unicode, very long strings and arrays.
3. Paging: maximum practical page size, `needTotal` cost, behaviour without `page`, stability of ordering.
4. Rate limits: which quotas apply to a sandbox, 429 body and headers, `RetryAfter` accuracy, error-count quota behaviour.
5. Latency and response size per endpoint for typical queries (list 25/100 work items with owners and status).
6. Number prefixes: how to learn them per instance; resolving an unknown number across asset types in one query.
7. Relations: exact names for task/test parents, children, portfolio tree, owners, team, timebox, status per type.
8. Custom fields: discovery through `meta.v1`, types, value formats.
9. `meta.v1` size and caching: how to detect metadata changes (version, ETag, hash).
10. Writes in the sandbox: `api/asset` single-target update vs `rest-1.v1` POST; `previewOnly=true` guarantees; creating
    comments (`Expression`), effort (`Actual`) and links; operations (`QuickClose`, `Reactivate`); response bodies;
    read-after-write lag.
11. History: `Hist` vs `asof` cost; activity stream completeness.
12. `assetdetail.v1` links for every asset type; attachments metadata.
13. On-premises differences: version, TLS/custom CA, base-URL shapes, Windows authentication interplay with access
    tokens.

**P0-07 (SDK and clients)**, **P0-08 (OAuth)** and **P0-09 (Workers limits)**: see the task files.

## 9. Admin sign-in providers (P4-01)

Checked 2026-10-23 against the providers' documentation. Nothing here was run against a real Google, GitHub or
Cloudflare Access application (they need OAuth apps and an Access application the autonomous run may not create):
those flows are tested against local fake providers and stay **unverified** end to end until the owner runs them
(`docs/pending-decisions/phase-4.md`).

- **Google (OpenID Connect).** `iss` is `https://accounts.google.com` or `accounts.google.com`; the `hd` request
  parameter only tunes the account chooser ("Don't rely on this UI optimization"), the signed `hd` claim is what to
  check and exists only for Workspace or Cloud organization members; `email_verified` may be a string; use `sub`, not
  the email, as the identifier.
  Source: https://developers.google.com/identity/openid-connect/openid-connect
- **GitHub OAuth app.** The web flow supports PKCE (`code_challenge`, `code_challenge_method=S256` only, `code_verifier`
  at the token request) and `allow_signup=false`. Source:
  https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps. Scopes `user:email` (for
  `GET /user/emails`) and `read:org` (for `GET /user/memberships/orgs/{org}`, `state: active`) are from our knowledge of
  the REST API, *unverified* here. Token revocation: `DELETE /applications/{client_id}/token`, Basic auth with the client
  id and secret (a Bearer header would replace it), JSON body `{"access_token": …}`, `204` on success, `422` on
  validation failure or when spammed. Source: https://docs.github.com/en/rest/apps/oauth-applications#delete-an-app-token
- **Cloudflare Access.** The identity is the `Cf-Access-Jwt-Assertion` header (the `CF_Authorization` cookie "is not
  guaranteed to be passed"); keys come from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` and rotate about
  every six weeks (never hard-code them); check `aud` against the application's AUD tag, `iss` against the team domain
  and verify RS256. Source:
  https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/. **Verified
  2026-10-26** on a real Access application (Worker on a custom domain, Workers Free): the `keys` array is read, the
  assertion verifies against team, AUD and RS256, and the first-owner sign-in through `/auth/setup` succeeded once that
  path was inside the Access application (L-262). A path outside it gets no header (`missing_assertion`).
- **Generic OIDC.** Discovery (`/.well-known/openid-configuration`, exact `issuer` match), PKCE S256, `nonce`, RFC 9207
  `iss` on the authorization response when advertised (`authorization_response_iss_parameter_supported`), client
  authentication by Basic (default) or body, `email_verified` required. Specification-level facts; no vendor was run.

### Sessions, `Clear-Site-Data` and re-authentication (P4-02)

Checked 2026-10-23.

- **`Clear-Site-Data`.** Each directive is a quoted string (`"cookies"`; an unquoted value is invalid). `"cookies"` removes
  the cookies of the **registered domain including its subdomains** ("`https://example.com` as well as
  `https://stage.example.com`"), unlike the other directives, which act on the origin. Browsers honour it in secure
  contexts only; the page does not say how a redirect response is handled, so logout answers with a 200 page. Source:
  https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Clear-Site-Data
- **Forcing a fresh login.** OIDC Core section 3.1.2.1: `prompt=login` asks the provider to re-authenticate the user;
  `max_age=0` has the same effect and makes `auth_time` mandatory in the ID token. We send both for OIDC providers and
  check `auth_time` only when the provider sends it. Google documents `prompt` values `none`, `consent` and
  `select_account` (not `login`) and sends no `auth_time` in our scopes: **unverified** whether Google re-prompts for
  `prompt=login`; GitHub's authorization endpoint has no re-authentication parameter (a signed-in browser is redirected
  straight back). Cloudflare Access: the assertion's `iat` is used as the time of authentication, *unverified* against a
  live tenant. Source: https://openid.net/specs/openid-connect-core-1_0.html#AuthRequest
- **Fetch metadata.** A redirect chain that began on another site keeps `Sec-Fetch-Site: cross-site` for its last
  request, so the page after an IdP redirect arrives as a cross-site top-level navigation (`Sec-Fetch-Mode: navigate`,
  `Sec-Fetch-Dest: document`). Source: https://web.dev/articles/fetch-metadata

### CSP `form-action` and redirects after a form post (P4-03)

- MDN warns that whether `form-action` blocks the redirects that follow a form submission "is debated and browser
  implementations of this aspect are inconsistent (e.g., Firefox 57 doesn't block the redirects whereas Chrome 63 does)"
  (checked 2026-10-23,
  <https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/form-action>). The owner
  setup page therefore has a policy without `form-action` ([L-195](LESSONS-LEARNED.md), D-35). Chromium confirmed it in the P4-08 browser run
  (2026-10-23, the policy and the redirect behave as specified); Firefox and WebKit are *unverified* (D-44).

### Issues, requests, goals, themes and retrospectives (P6-06)

- **Product model.** The public example instance (26.2.6.29, public `meta.v1`, checked 2026-10-27 with
  `pnpm metadata:drift`) defines `RequestStatus` with base `List` (no `RollupState`) and `Retrospective` with no `Number`;
  `Issue` has a single `Owner` relation, `Request` a `Status` relation to `RequestStatus`, `Goal` neither. The committed
  snapshot is hand-written and matches these product attributes. Source: https://www14.v1host.com/v1sdktesting/meta.v1
- **Read-only tenant (26.0.3.2, 2026-10-27).** Issues, goals, themes and retrospectives each answer `query_assets` and
  `get_assets` with default tiers (levels only; the tenant is a third party's). `Request` is a defined type with no
  assets: the query returns an empty page, not an error. Writable-sandbox checks of requests: P6-27.

### Downcast aggregates over `Subs` for portfolio roll-ups (P6-15)

- **Read-only tenant (26.0.3.2, 2026-10-28), shapes only.** `query.v1` on `Epic` accepts the downcast aggregate selections
  `Subs:Story[AssetState!='Dead'].@Count`, `Subs:Story[AssetState!='Dead'].Estimate.@Sum`, `Subs:Defect[...]@Count` and
  conditions on `AssetState` (`[AssetState='128']`, `[AssetState='64']`) with HTTP 200 and numeric values. **They do not agree with the
  rows:** for three epics with stories, the rows read with `Super = epic` were more than the aggregate in every case, and with no
  condition at all the aggregate was still lower (`Subs:Story.@Count`); `Children:Story` returned zero. So the relation an
  aggregate follows is not the one the tree reads (`Story.Super`), and no aggregate form was found that equals the rows
  (D-143). Roll-ups stay computed from the rows. Live check: `live/portfolio-aggregates.live.test.ts` (asserts that the forms are
  accepted; the disagreement is recorded on stderr as a level, not asserted). *verified on one tenant; unverified elsewhere*

### Defect priority and severity for `defect_triage` (P6-57)

- **Read-only tenant (2026-10-29), shapes only.** `Defect.Priority` is a relation; `Priority.Name` and `Priority.Order` read
  with HTTP 200 for 50 defects in one query. Exactly one single-valued relation attribute on `Defect` has "severity" in its
  name, and `<that>.Name` reads in the same query. With the fix below, `defect_triage` reports priority read and severity read
  on the tenant (`live/reports.live.test.ts` prints the two states, never the attribute name or values). A text-typed severity
  and the two-candidate case are verified on fixtures only. *verified on one tenant*
- **Found by the live check:** the read passed every defect of the page (up to 100) to one `ID in [...]` filter, which the
  compiler bounds at 50 values for caller input, so on a tenant with more than 50 open defects the read failed and the report
  said "could not be read". The OIDs come from the call's own scope-checked search, so the filter is now a trusted list
  (bound 2,000), as the Scope lists of the search tools already are.
