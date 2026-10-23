---
'agility-bridge': minor
---

Admin panel scaffold (P4-03): a server-rendered, phone-friendly panel at `/admin` on `serve` and on the Worker, built with
Hono JSX under a strict content security policy (no inline script or style, hashed assets with SRI, no framing, Trusted
Types) and a page and form kit with session, role, CSRF and fetch-metadata checks. Changes go through the admin API in
process, so its guards, re-authentication rule and audit rows apply unchanged. Sign-in now lands on `/admin` (overview and
account pages); `/auth/account` redirects to `/admin/account`, and the sign-in pages share the panel's layout.
