---
'agility-bridge': patch
---

Phase 2 review fixes for `agility-bridge serve`: requests whose target is not a plain path (`GET https://…`) get
`400`, and pass-through workspaces treat a request as HTTPS only when a trusted proxy says so; a client address out of
failed attempts no longer triggers Agility validations, new pass-through tokens are checked at most
`AB_RATE_LIMIT_VALIDATIONS_PER_MINUTE` times per instance (default 30) and concurrent requests share one check; IPv6
clients are rate-limited per /64; malformed `Host` headers are refused; an admin token file reached through a
symbolic link into the data directory is refused; the database refuses to leave the server without an active owner
and to un-revoke anything; only a member can issue device tokens for a grant on their own personal Agility token.
