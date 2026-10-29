---
"agility-bridge": minor
---

Write rows in the audit viewer, CSV and statistics (P7-11): the panel pairs each write's intent with its outcome and shows the tool, target, field names, approval channel and change hash; an intent with no outcome after ten minutes is flagged. The CSV gains `write_*` columns, and `GET /api/admin/v1/audit/write-stats` (owner and admin) with a Writes section on the Usage page counts writes by tool, approval channel and outcome. A member still sees only their own write rows.
