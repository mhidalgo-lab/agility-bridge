---
"agility-bridge": minor
---

OAuth client registration (P5-03): Client ID Metadata Documents (clients named by an https URL; fetched through a public-only, redirect-free, size- and time-bounded fetch, cached 5 minutes to 24 hours) and hardened dynamic registration (only the fields we use are kept, strict redirect rules, per-address and per-deployment caps, unused registrations expire after a day). New settings `AB_OAUTH_CIMD`, `AB_OAUTH_CIMD_MAX_CLIENTS`, `AB_OAUTH_CIMD_FETCH_LIMIT`, `AB_OAUTH_DCR`, `AB_OAUTH_DCR_MAX_CLIENTS`, `AB_OAUTH_DCR_IP_LIMIT`, `AB_OAUTH_DCR_REDIRECT_HOSTS` and `AB_OAUTH_DCR_UNUSED_TTL`. The Worker sets the `global_fetch_strictly_public` compatibility flag. Still unreachable until the consent screen arrives.
