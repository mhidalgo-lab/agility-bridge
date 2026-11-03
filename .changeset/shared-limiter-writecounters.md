---
"agility-bridge": patch
---

Write counters can live outside the storage `kv` table (P3-12): the HTTP app's write wiring takes an optional counter store, used by the Cloudflare Worker's optional Durable Object limiter. Nothing changes for `serve` or stdio.
