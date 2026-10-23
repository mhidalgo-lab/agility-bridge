---
'agility-bridge': minor
---

Admin sign-in (P4-01): Google, GitHub, Cloudflare Access and any OpenID Connect provider at `/auth/*`, deny by default
with allowlists and optional auto-provisioning, one identity per user. The first owner is created with a single-use
setup link (`agility-bridge setup-link`, `POST /api/admin/v1/setup-links`) whose code travels in the URL fragment. New
settings `AB_GOOGLE_*`, `AB_GITHUB_*`, `AB_OIDC_*`, `AB_CF_ACCESS_*`, `AB_LOGIN_*`, `AB_RATE_LIMIT_SIGN_IN` and
`AB_IDENTITY_PRIVATE_ADDRESSES`; client secrets may come from `*_FILE`. Browser sessions follow in the next release.
