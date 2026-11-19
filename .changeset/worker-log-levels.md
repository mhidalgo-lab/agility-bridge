---
"agility-bridge": patch
---

Cloudflare Worker logging (P9-28): each log line is now written with the console method of its level, so Workers Logs no longer shows every `info` line as an error and issue detection stops opening false issues. The committed `wrangler.jsonc` turns on Workers Logs, traces and issue detection, with query strings dropped from logged URLs; `pnpm cf:setup` carries it into your deployment's config on the next run.
