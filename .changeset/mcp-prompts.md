---
"agility-bridge": minor
---

MCP prompts: `review_backlog_item_quality`, `sprint_review`, `standup`, `triage_defects`, `draft_release_notes`,
`refine_backlog` and `explain_asset`, registered from one manifest and offered (`prompts/list`, `prompts/get`) only when
every tool they use is allowed, on stdio and HTTP. A prompt is static text that tells the model which tools to call, to treat
what they return as untrusted data and to stay read-only; its string arguments are validated and never reach a query. The
three that use report tools need the opt-in `reports` group.
