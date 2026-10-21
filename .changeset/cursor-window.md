---
'agility-bridge': patch
---

Paging cursors bind and re-validate their time window and "now": an edited cursor is refused, and `list_sprints` keeps the first page's "now", so a sprint that starts or ends while you page is neither skipped nor repeated.
