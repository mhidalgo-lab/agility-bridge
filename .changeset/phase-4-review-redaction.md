---
'agility-bridge': patch
---

Log redaction now also covers the admin sign-in values (P4-11): the CSRF token and `_csrf` form field, the PKCE verifier, the
nonce, the setup code, the session secret as an object key, and the OAuth `code` in a callback URL's query string.
