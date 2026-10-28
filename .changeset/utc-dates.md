---
"agility-bridge": patch
---

Dates a caller selects, filters or sorts by on `query_assets` and `get_assets` (`ChangeDate`, `CreateDate`, …) are read
through their `…UTC` siblings and returned as ISO 8601 UTC under the requested key; a zone-less date with no sibling is
returned raw with a note. `get_work_item` and the work lists now include `createdAt`.
