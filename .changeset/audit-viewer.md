---
'agility-bridge': minor
---

Audit viewer and usage statistics (P4-05): the panel at `/admin` gains an audit log (filters for time, kind, outcome, tool or
action, workspace and user; keyset paging; every stored string shown as text; a formula-safe CSV download of the newest 1,000
matching rows) and, for owners and admins, usage statistics (calls, errors, denials, Agility requests and durations per tool,
workspace, grant, user or day). Members see only their own audit rows: `GET /api/admin/v1/audit` is now open to them and scoped
to their user id by the server (another `userId` is refused), and it gains an `action` filter. New `GET
/api/admin/v1/audit/stats` (owner and admin) aggregates at most the newest 10,000 tool calls of a window and reports when it
stopped there. Storage gains `audit.stats` on memory, SQLite and D1, with no schema change.
