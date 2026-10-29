# Pending decisions — Phase 7

> Open questions and owner steps from Phase 7 (opt-in writes). Answer inline (`**Owner:** …` with a date).

> The owner authorised the whole phase as a batch (2026-10-29): decisions marked *built as …* are implemented at their
> recommendation; say so if you want the alternative.

## Decisions

### D-155 — What an approval binds, and what it does not *(P7-01)*
- **Context:** ADR-0013 says the approval is bound to "a hash of the canonical arguments, actor, target and expiry". An out-of-band approval (the page, P7-02) is made before the agent repeats the call, so the repeated call has to arrive at the same hash; a hash that included a per-call expiry would never match.
- **Options:** (a) hash the tool, actor, operation, target OID and every field with its old and new value; keep the expiry on the ledger entry and check it on use; display-only data (asset number, title) is not hashed; (b) include the expiry in the hash (the page would have to fix it up front); (c) hash the raw tool arguments.
- **Recommendation:** (a), built. A different value, target, actor, tool or old value gives a different hash; the entry still dies at its expiry and after one use. (c) would let an unchanged argument approve a changed target.
- **Owner:** *(open; built as (a))*

### D-156 — How elicitation approves on each protocol era *(P7-01)*
- **Context:** On 2026-07-28 the client repeats the call with the answer (`input_required`); on a 2025-era connection that kept its capabilities (stdio) the server can push `elicitation/create`; a stateless 2025-era HTTP request cannot be asked (P0-07). The SDK turns an `input_required` for a client without the capability into a protocol error.
- **Options:** (a) the pipeline throws an `InputRequiredSignal` that the server wrapper turns into `input_required`, with an HMAC-sealed state naming a single-use ledger round, and uses the push request only where the connection declared the capability; no capability on the request means no channel and our own `AB_WRITE_APPROVAL_UNAVAILABLE`; (b) return `input_required` on every era and rely on the SDK's server-side shim for 2025-era connections (less code, untested here, and the capability check is then the SDK's); (c) keep the state only in the ledger without a seal.
- **Recommendation:** (a), built. The state and the ledger entry are both needed: the seal proves we issued the state for this change and actor, the ledger makes it single use across isolates.
- **Owner:** *(open; built as (a))*

### D-157 — Where the write limiter plugs in *(P7-01, P7-03)*
- **Context:** The limiter (P7-03) must refuse before a write is sent; it can also bound approval prompts.
- **Options:** (a) after the approval, before the re-read and the send: a refused, declined or unavailable attempt costs nothing, an approved write that the limiter refuses wastes the approval; (b) before the approval: bounds prompt spam too, but counts changes nobody approved; (c) both, with separate counters.
- **Recommendation:** (a), built as a `WriteLimiter.check` seam; P7-03 may add (c) if prompt spam shows up.
- **Owner:** *(open; built as (a))*

### D-158 — A new error code for a failed intent audit *(P7-01)*
- **Context:** The write is refused when its intent cannot be stored (L-109). The existing codes say nothing about this and the agent should not retry blindly.
- **Options:** (a) add `AB_WRITE_AUDIT_UNAVAILABLE` ("nothing was changed, try later, tell the administrator"); (b) reuse `AB_INTERNAL` (reference id only); (c) reuse `AB_AGILITY_UNAVAILABLE` (wrong: Agility was not called).
- **Recommendation:** (a), built; codes are only ever added.
- **Owner:** *(open; built as (a))*

### D-159 — The key that seals round-trip state in remote modes *(P7-01)*
- **Context:** Any isolate must verify the state another one issued, so the key cannot be per process there; stdio can use a random per-process key.
- **Options:** (a) derive it from the master key with the keyring's existing HMAC (`mac(AuditIdentity, 'write-approval-state|v1')`), no new key purpose; (b) add a `WriteApproval` key purpose (clean separation, but it changes the key derivation inventory and every `warm` list); (c) store a random key in `settings`.
- **Recommendation:** (a), built; domain separation comes from the data prefix, and rotating the master key only invalidates open questions (the pipeline asks again). Move to (b) if the cryptography inventory should list it.
- **Owner:** *(open; built as (a))*

### D-160 — What a write audit row holds *(P7-01)*
- **Context:** Old and new values would make the audit more useful, but they are customer text (T8: no Agility content in audit).
- **Options:** (a) the field names, the target and the hash of the change the approval bound; never a value; (b) also store the values (full forensics, customer text in the audit table and its CSV); (c) store the values encrypted.
- **Recommendation:** (a), built; the hash proves what was approved, and Agility's own history holds what changed.
- **Owner:** *(open; built as (a))*

### D-161 — stdio enablement needs the tool named in `AB_TOOLS` *(P7-01)*
- **Context:** On a remote server a write tool must be named in both the workspace and the grant lists ("all tools" never includes it). stdio has one process and no lists.
- **Options:** (a) `AB_WRITE_TOOLS=on` **and** `AB_TOOLS` naming each write tool; with `AB_TOOLS` unset no write is offered; (b) `AB_WRITE_TOOLS=on` alone offers every write tool.
- **Recommendation:** (a), built: the same "name it explicitly" rule as the remote layers, so turning the switch on never adds a tool silently.
- **Owner:** *(open; built as (a))*

### D-162 — Value and approval size limits, and hidden characters *(P7-01)*
- **Context:** The approval must show the whole change (L-106), so there is a size beyond which it is refused; values with invisible characters would show something other than what is sent.
- **Options:** (a) at most 20 changes, 8,000 characters per value, 24,000 characters of approval text, 50 items per list; control, invisible and bidirectional characters are refused (not cleaned); (b) the same limits but strip the characters for the display only (what is shown differs from what is sent); (c) larger limits (more to read; clients truncate long prompts, which the design must not allow).
- **Recommendation:** (a), built. Raise the limits only after seeing what real clients render (P7-12).
- **Owner:** *(open; built as (a))*

### D-163 — Where the approval page lives *(P7-02)*
- **Context:** The task names `/approve/<id>`. The panel already has sessions, CSRF, fetch-metadata and Origin checks, re-authentication, the strict CSP, layout and an error page under `/admin/*`; a top-level route would need its own copy of each.
- **Options:** (a) `/admin/approve/<id>` inside the panel (a normal screen, no new CSP variant, 404 when write tools are off); (b) top-level `/approve/<id>` with its own wiring; (c) a page in the OAuth consent module.
- **Recommendation:** (a), built. The link in `AB_WRITE_APPROVAL_PENDING` is `AB_PUBLIC_URL`'s origin plus that path, never built from `Host` or a forwarded header (T8).
- **Owner:** *(open; built as (a))*

### D-164 — What a pending request stores, and who can read it *(P7-02)*
- **Context:** The page must show the exact change, but the ledger holds only a hash. The change contains customer text (old and new values); D-160 keeps values out of the audit.
- **Options:** (a) a short-lived `kv` record (`wr:pend:<userId>:<id>`, ten minutes) with the canonical mutation, looked up by the **signed-in person's own id** so another person's link finds nothing, taken atomically when answered; (b) only the hash, and the page asks the tool to plan again (the page would need the tool context, the credential and a second Agility read); (c) the sealed change inside the link (long links, values in URLs and logs).
- **Recommendation:** (a), built. The same change asked again before the person acts reuses the link; at most 20 open requests per person (the oldest is dropped); values are in `kv` only until it is answered or expires, never in audit rows or logs.
- **Owner:** *(open; built as (a))*

### D-165 — An out-of-band approval is bound to the workspace, and a decline is remembered *(P7-02)*
- **Context:** The change hash (D-155) holds tool, actor, target and values, not the workspace; the same person could in principle hold two workspaces whose instances produce the same target OID. The agent also needs to learn that the person said no.
- **Options:** (a) ledger grants and denials are keyed by actor, workspace and hash, and checked on take; a decline writes a single-use denial that the repeated call turns into `AB_WRITE_APPROVAL_DECLINED`; (b) add the workspace to the hash (changes the hash that the elicitation channel already issues); (c) no denial: a decline only lets the request expire, and the repeated call is pending again.
- **Recommendation:** (a), built; the elicitation hash is unchanged.
- **Owner:** *(open; built as (a))*

### D-166 — Who is offered the page *(P7-02)*
- **Context:** Only the grant's own signed-in user may approve. A service grant (no user) has nobody who can sign in and answer; stdio has no panel.
- **Options:** (a) the page channel exists only for a request whose grant has a user, on a server with write tools and sign-in configured; everything else keeps `AB_WRITE_APPROVAL_UNAVAILABLE`; (b) let any owner approve for a service grant (a second person approving what an agent asked is a different control, not this one); (c) offer the page without sign-in configured (a dead link).
- **Recommendation:** (a), built.
- **Owner:** *(open; built as (a))*

### D-167 — D-12 stays (the page is built); URL-mode elicitation waits for a client that declares it *(P7-02)*
- **Context:** The owner's D-12 asked whether to keep or drop the page; it is built. The task also lists URL-mode elicitation. No client in the P0-07 matrix is known to declare `elicitation.url`, and a stateless 2025-era request cannot be asked anything (L-156).
- **Options:** (a) plain link in the tool error now; URL-mode in P7-13 after the client matrix shows who declares it; (b) build URL-mode now without a client to test it; (c) drop it.
- **Recommendation:** (a), built; filed as P7-13 with the browser suites and the staging run.
- **Owner:** *(open; built as (a))*


### D-168 — What the deployment-wide write limit counts in *(P7-03)*
- **Context:** ADR-0013 asks for a deployment-wide limit on Workers "through a shared limiter that fails closed". A per-isolate counter lets bursts through (L-081, L-111). The exact answer is a Durable Object (P3-12), which needs a new Cloudflare resource only the owner may create.
- **Options:** (a) fixed hourly counters in the storage `kv` table with the atomic capped `increment` (already used by the OAuth abuse limits, P5-09), shared by every isolate and replica on Workers (D1) and Node (SQLite); (b) the Workers Rate Limiting binding (approximate, per location, not a hard count: wrong for a limit that must hold); (c) a Durable Object limiter (exact and sliding, new resource, P3-12).
- **Recommendation:** (a), built. It is exact within a window and needs nothing new. Costs: one storage write per counter per write (two), and up to twice the limit across an hour boundary. Move to (c) when the owner creates the Durable Object and wants a sliding window.
- **Owner:** *(open; built as (a))*

### D-169 — Default limits and their settings *(P7-03)*
- **Context:** ADR-0013 names 20 writes an hour per grant; it gives no deployment figure.
- **Options:** (a) 20 per grant, 200 per deployment, as `AB_WRITE_RATE_PER_GRANT_HOURLY` (1-1,000) and `AB_WRITE_RATE_DEPLOYMENT_HOURLY` (1-10,000); stdio uses the grant variable for the process and has no deployment limit; (b) no deployment default (only when configured); (c) a per-grant override stored with the grant (admin UI and API work, filed as P7-15).
- **Recommendation:** (a), built; every limit is always on (the limit cannot be turned off, unlike reads, because writes are the highest-risk path). (c) is P7-15.
- **Owner:** *(open; built as (a))*

### D-170 — Which writes use a unit *(P7-03)*
- **Context:** The limiter runs after the approval and before the re-read (D-157), so a unit is taken before it is known that the write will happen.
- **Options:** (a) the unit is spent at the limiter and never refunded: an approved write that then turns out to be a conflict, an already-applied no-op or a failed send still counts; a refused call (declined, unavailable, over a limit) counts nothing; (b) refund on conflict or no-op (a second storage write, and a refund is an increment below the cap that cannot be made atomic across the two counters); (c) count only sent writes (the limiter would run after the intent audit, so a refused write would leave an intent row).
- **Recommendation:** (a), built: simple, errs on the side of fewer writes, and keeps "a refused write makes no upstream call and no intent audit".
- **Owner:** *(open; built as (a))*

### D-171 — Error codes of the limiter *(P7-03)*
- **Context:** A refusal for rate and a refusal because the limiter is broken need different advice: wait, or tell the administrator.
- **Options:** (a) `AB_LIMIT_RATE` (existing, with scope, limit and seconds in its local details) for the limit and a new `AB_WRITE_LIMIT_UNAVAILABLE` for an outage or an untrustworthy counter value; (b) `AB_LIMIT_QUOTA` for the deployment scope; (c) `AB_INTERNAL` for the outage.
- **Recommendation:** (a), built; codes are only ever added. Both say nothing was changed.
- **Owner:** *(open; built as (a))*

### D-172 — Wave-1 writes go through `rest-1.v1/Data` XML, built by one escaping builder *(P7-04)*
- **Context:** ADR-0011 allows `rest-1.v1/Data` (XML) or `api/asset` (JSON) for single-asset writes. The XML shapes for set, add and remove on attributes and relations are the ones RESEARCH 1.5 documents; the `api/asset` shapes for relation add/remove are not documented in the sources we have (the developer library pages were not reachable on 2026-10-29). The client already has a single-attempt `restWrite`.
- **Options:** (a) XML through `restWrite`, with a builder that checks attribute and relation names and OIDs against strict patterns and escapes every value (so no caller text can add an element); (b) `api/asset` JSON (no escaping concern, but the relation add/remove shape would be a guess); (c) both, chosen per tool.
- **Recommendation:** (a), built. Every shape stays *unverified* in RESEARCH and is a P7-07 item; if the sandbox shows the XML route refusing something, (b) is a change inside `send` only (the plan, the approval and the tests of the plan do not change).
- **Owner:** *(open; built as (a))*

### D-173 — Relation values in a mutation read `Name [OID]` *(P7-04)*
- **Context:** The approval must be readable (a status, a person, a sprint) and the hash must bind the identity, not a name two statuses or two members can share; Agility names are untrusted text.
- **Options:** (a) the value is `"<name> [<OID>]"`: the name inside the envelope for the reader, the OID in the hash and parsed back by `send`; (b) the OID alone (unreadable approval); (c) the name alone (ambiguous, and the hash would not bind the identity).
- **Recommendation:** (a), built. Lists (owners) are sorted by OID so one set hashes one way. A name with control or hidden characters is refused by the framework (not cleaned).
- **Owner:** *(open; built as (a))*

### D-174 — `log_effort` is for the caller, creates an `Actual` and shows the logged total *(P7-04)*
- **Context:** Logging hours is a create, so there is no old value to compare. Logging for another member and updating the remaining to-do are bigger surface.
- **Options:** (a) the caller only; the mutation shows `Actual.Value` as the item's logged total before and after (the re-read compares the total, so another person logging meanwhile is a conflict), plus the date and the member; an identical entry (same item, member, date, hours) already present is a no-op so a retried call never doubles the hours; no to-do update; (b) any member (needs a policy on who may log for whom); (c) also set `ToDo` in the same call.
- **Recommendation:** (a), built; (b) and (c) are P7-17.
- **Owner:** *(open; built as (a))*

### D-175 — `move_to_sprint` stays inside the item's project schedule, and only into an open sprint *(P7-04)*
- **Context:** Sprints of other schedules overlap by date; moving an item into a closed sprint is almost always a mistake. The task text of the catalogue also mentions "back to the backlog".
- **Options:** (a) the sprint is resolved with the item's own Agility project (the schedule must be scheduled for it), closed sprints are refused, no "back to the backlog" in wave 1; (b) any visible sprint; (c) also clear the sprint.
- **Recommendation:** (a), built; clearing the sprint is P7-17.
- **Owner:** *(open; built as (a))*

### D-176 — Which targets a wave-1 write refuses *(P7-04)*
- **Context:** Agility keeps closed and deleted assets readable; editing them is rarely intended.
- **Options:** (a) deleted, template and broken-down items are refused by every tool; a closed item is refused by every tool except `add_comment`; the re-read treats a target that went missing, deleted or (except for comments) closed as `AB_WRITE_CONFLICT`; types per tool: status, owners and comment on Story, Defect, Task, Test and Epic; effort on Story, Defect, Task, Test; sprint on Story and Defect; (b) allow edits to closed items; (c) refuse comments on closed items too.
- **Recommendation:** (a), built; the attribute must also exist and be writable on the type in the instance metadata, else the call is refused with a message naming it.
- **Owner:** *(open; built as (a))*

### D-177 — What `add_comment` sends, and what counts as a repeat *(P7-04)*
- **Context:** The read side treats comments as the `Expression` rows that mention the item. Whether a bare `Expression` needs a `Conversation` is unverified.
- **Options:** (a) create an `Expression` with `Content` and `Mentions` (the item) only; plain text, 4,000 characters, line breaks normalised to `\n`, control and hidden characters refused; the same text as the member's latest comment on the item is a no-op; (b) create a `Conversation` first (two requests, two non-atomic writes); (c) accept HTML.
- **Recommendation:** (a), built; (b) becomes a change inside `send` if P7-07 shows it is required. Agent mentions of other members and rich text are P7-18.
- **Owner:** *(open; built as (a))*

### D-178 — `update_status` takes `new_status`, offers only the item's workflow, and never closes *(P7-04)*
- **Context:** `status` is a list filter everywhere else (an array), and the argument lint keeps one meaning per name. Statuses can be per team (`Team` on the status). L-142: Status, AssetState and the rollup category are different things.
- **Options:** (a) `new_status` (one name or OID); candidates are the type's active statuses that have no team or the item's team; an inactive status is refused; only `Status` changes (closing is a separate, destructive tool); (b) reuse `status` as a string (breaks the lint); (c) accept any status of the list and let Agility refuse.
- **Recommendation:** (a), built.
- **Owner:** *(open; built as (a))*
