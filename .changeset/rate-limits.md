---
'agility-bridge': minor
---

`agility-bridge serve` limits requests per client address, failed authentications per address (valid tokens are never
locked out), and requests per device token and per grant, answering `429` with `Retry-After`. Settings:
`AB_RATE_LIMIT*` and `AB_TRUSTED_PROXY_HOPS` (docs/guide/configuration.md).
