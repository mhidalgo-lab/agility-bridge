---
"agility-bridge": minor
---

OAuth abuse controls (P5-09): the authorization, consent and token endpoints, dynamic registration and metadata-document fetches now have shared, exact limits per address and per deployment, kept in the database (SQLite on Node, D1 on Workers) with atomic counters; failed token exchanges are limited per address (and, for addresses that already failed, in all). Refusals answer `429` with `Retry-After` and are audited once per window (`oauth.request.refused`). Unused registrations are swept on a schedule (Node hourly, the Worker's cron in bounded slices), and `serve` now also purges expired rows hourly. New settings `AB_OAUTH_AUTHORIZE_IP_LIMIT`, `AB_OAUTH_AUTHORIZE_LIMIT`, `AB_OAUTH_CONSENT_IP_LIMIT`, `AB_OAUTH_CONSENT_LIMIT`, `AB_OAUTH_TOKEN_FAILURE_IP_LIMIT`, `AB_OAUTH_TOKEN_FAILURE_LIMIT`, `AB_OAUTH_DCR_LIMIT` and `AB_OAUTH_CIMD_LIMIT`.
