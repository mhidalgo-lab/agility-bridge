---
"agility-bridge": patch
---

OAuth fixes from the Phase 5 review (P5-10). A revocation request no longer renews an unused dynamic registration (it could be kept for 90 days with one request). At the registration cap, registrations nobody used within the hour make room, and at the stored-document cap a cached client document is evicted instead of the new client being refused, so one source can no longer hold either cap for everyone else. A client whose metadata document is temporarily unreachable gets `503` or `429` at the token endpoint instead of `invalid_client`, which made SDK clients discard their tokens and ask for approval again. The OAuth per-address limits count an IPv6 address by its /64 network, as the general limiter does. Redaction now covers a Bearer OAuth token in free text. The admin Connect page no longer calls OAuth a later release.
