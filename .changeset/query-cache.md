---
"agility-bridge": minor
---

Query cache (P8-01, off by default): `AB_QUERY_CACHE_TTL` (0 to 60 seconds) answers repeated `query.v1` reads from a bounded in-memory cache on stdio, `serve` and the Worker, with entries named by a keyed hash over the workspace, grant, credential, projects, asset types, limits and the compiled query. Callers with write tools never use it. On Workers, `AB_QUERY_CACHE_EDGE=on` adds a sealed Cache API tier that reports whether a read-back proved it works. `whoami` shows the cache status. See docs/guide/query-cache.md.
