# Pending decisions — Phase 6

> Open questions and owner steps from Phase 6. Answer inline (`**Owner:** …` with a date).

## Open decisions

### D-89 — The activity stream is not read by the history tools *(P6-05)*
- **Context:** ADR-0011 and L-146 say the activity stream is "only a hint": it may not contain every change. It is also
  outside the live-test guard (only `rest-1.v1` `Data` and `Hist`, `meta.v1` and `query.v1` are allowed), so any code
  against it would ship unverified, and RESEARCH records it as never probed.
- **Options:** (a) do not read it; `get_asset_history` and `list_recent_changes` use `Hist` and `query.v1` only and say
  their source; (b) add an optional, clearly labelled `activity_hint` section later, after the endpoint is probed on the
  writable sandbox; (c) read it now, unverified.
- **Recommendation:** (a), built. (b) is task [P6-21](../tasks/phase-6-tool-breadth/P6-21-history-sandbox-verification.md),
  after the sandbox exists.
- **Owner:** pending.

### D-90 — `get_asset_history` is not paged; its window and row cap are the bound *(P6-05)*
- **Context:** `rest-1.v1/Hist/<type>/<id>` answers every version of the asset in one response; it cannot be narrowed by
  date on the request (not verified whether it accepts a `where` on `ChangeDate`, see RESEARCH §1.4). The tool therefore
  fetches once (response bytes are capped by the client), diffs, applies the window and returns at most `limit` rows
  (default: the workspace page size), newest first, with `truncated` when more exist. `time_range` defaults to the last
  30 days and may not exceed `maxTimeRangeDays`; `list_recent_changes` defaults to 7 days.
- **Options:** (a) as built: one request, row cap, no cursor; (b) a cursor over the diff rows (a second call repeats the
  whole `Hist` request, so it costs the same again for each page); (c) refuse assets with more than N versions.
- **Recommendation:** (a). A person asks about a window, not for page 7 of a version list; a window and a field list
  narrow the answer, and (b) adds a request per page for no new information.
- **Owner:** pending.

### D-91 — `list_recent_changes` covers the four work-item types, not portfolio items *(P6-05)*
- **Context:** the tool queries Story, Defect, Task and Test through the same filters and merge as `search_work_items`
  (one batched `query.v1`, per-type cursors). Epics and other portfolio items live under their own scope strategy and
  belong with the portfolio tools ([P6-01](../tasks/phase-6-tool-breadth/P6-01-tools-portfolio.md)). `get_asset_history`
  works on any readable asset type, epics included.
- **Options:** (a) four work-item types now; portfolio items later; (b) add `Epic` now.
- **Recommendation:** (a), with [P6-22](../tasks/phase-6-tool-breadth/P6-22-recent-changes-portfolio-items.md) adding epics
  once P6-01 settles how portfolio items are listed.
- **Owner:** pending.

### D-86 — Where the attachment download is switched on *(P6-04)*
- **Context:** D-08 wants `get_attachment` off by default and enabled "per workspace and grant". The access resolver
  lists every read tool of a workspace unless its tool list says otherwise, so an opt-in read tool needs a gate that
  does not depend on someone remembering to leave it out of a list.
- **Options:** (a) a workspace limit `attachmentDownload` (default off) that a grant can only turn off, like
  `genericQuery`, plus `attachmentMaxBytes` that a grant can only lower; the resolver drops the `attachments` group when
  it is off, and the handler refuses as well; stdio uses `AB_ATTACHMENT_DOWNLOAD` and friends; (b) a deployment-wide
  switch only; (c) tool lists only (name the tool in the workspace and the grant).
- **Recommendation:** (a): the same shape as every other switch (L-062: a grant can only tighten), visible in the admin
  limits form, and a tool named in a list is still not served while the switch is off.
- **Built:** (a). `AB_ATTACHMENT_DOWNLOAD` is not a deployment default for HTTP: the default is off and a workspace
  turns it on.
- **Owner:** pending.

### D-87 — What counts as an attachment that may be returned *(P6-04)*
- **Context:** the task allows text types, checked on the metadata and on the response. Agility may serve a different
  type than it stored, an attachment may have no content type, and a deployment may want more types.
- **Options:** (a) exact `type/subtype` allowlist (default `text/plain`, `text/markdown`, `text/csv`,
  `application/json`; `AB_ATTACHMENT_TYPES` replaces it), types that run or render (`text/html`, `image/svg+xml`,
  XML, JavaScript) refused even when listed, a missing content type refused, text must be valid UTF-8 without NUL;
  (b) allow wildcards such as `text/*`; (c) sniff the bytes instead of trusting types.
- **Recommendation:** (a): the allowlist is what an operator can reason about, wildcards would admit HTML, and sniffing
  adds a parser to a path that fetches untrusted bytes.
- **Built:** (a). Unverified until a sandbox run (P6-19): the exact endpoint spelling (`attachments.img`, from the
  developer library) and whether Agility answers with the stored content type.
- **Owner:** pending.

### D-88 — How much text one call returns *(P6-04)*
- **Context:** the download cap (1 MiB by default) bounds what the bridge reads, but a model's context should not take
  a megabyte of text in one result, and the output shaper caps one value at 4,000 characters.
- **Options:** (a) return up to `max_characters` (default 20,000, at most 100,000) in one enveloped text block, with a
  note and `truncated` when cut; ranged reads later (P6-20); (b) page through the text with a cursor now; (c) return
  the whole text up to the byte cap.
- **Recommendation:** (a): bounded results by default, and the common case (a log excerpt, a small CSV, a note) fits.
- **Built:** (a).
