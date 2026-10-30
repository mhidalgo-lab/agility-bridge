---
"agility-bridge": patch
---

Cheaper repeated work (P8-35): the public tool catalogue's `initialize`, `server/discover` and `tools/list` answers are kept per process or Worker isolate with only the JSON-RPC id replaced, and identical reads in flight together inside one request send one Agility request when the query cache is on. Expired query-cache entries are dropped wherever they sit in the map.
