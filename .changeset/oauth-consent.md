---
"agility-bridge": minor
---

Add the OAuth sign-in and consent screen and connected apps (P5-04): `AB_OAUTH=on` now starts on `serve` and the Worker when a sign-in provider is configured. `/oauth/authorize` sends a signed-out browser through sign-in and back, then shows a consent page (the app's unverified name, where it sends you, the workspace and the access it will get; strict policy, no inline script) whose approval is a CSRF-checked post with a single-use handle bound to the exact request, so replayed or swapped forms approve nothing; `prompt=none` redirects errors only. Approved apps are listed on My access with Disconnect (and Disconnect all), at most 25 per person; an authorization request alone never ends an existing connection. New admin API routes `GET /me/oauth-devices` and `POST /me/oauth-devices/{id}/revoke` and `/me/oauth-devices/revoke-all`.
