---
"agility-bridge": patch
---

OAuth edge rate limit on Workers (P5-19): an optional `RL_OAUTH` Rate Limiting binding (60 per minute per address) turns a flood of `/oauth/authorize`, `/oauth/token`, `/oauth/register` and consent requests away before any D1 query of the OAuth abuse counters; it fails open and is only a backstop. Other hosts behave as before. The Worker warns at start when OAuth is on and the binding is missing. A WAF rate limiting rule recipe is in the Cloudflare limits guide.
