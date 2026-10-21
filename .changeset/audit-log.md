---
'agility-bridge': minor
---

`agility-bridge serve` keeps an audit log of tool calls (asset numbers, masked queries, durations, Agility requests),
refused requests and admin changes — never tokens, request values or Agility content — with a retention of
`AB_AUDIT_RETENTION_DAYS` (default 90). See docs/guide/audit-log.md.
