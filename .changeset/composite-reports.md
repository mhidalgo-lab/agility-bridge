---
"agility-bridge": minor
---

Composite reports in a new opt-in `reports` group: `sprint_health`, `standup_summary`, `release_readiness`, `defect_triage`
and `work_item_quality` (scored with the versioned rubric). Each report reads through its sibling tools with the call's own
scope and budget, skips and names any section whose tool the caller was not granted, and never turns missing data into a
zero. The group is off by default: enable it per workspace (limit `reports`; a grant can only turn it off) or with
`AB_REPORTS=on` in stdio. `search_work_items` now lists `changedAt` when sorted by recent change.
