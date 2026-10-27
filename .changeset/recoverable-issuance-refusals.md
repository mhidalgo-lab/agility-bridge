---
"agility-bridge": patch
---

An OAuth device now survives a token refusal that can pass (P5-21, D-77, ADR-0018). Refusals at a code exchange, a refresh or a repeat inside the refresh reuse window are final or recoverable. Final ones (access grant revoked, ended or deleted, person removed, client revoked, and so on) still end the device at once. Recoverable ones (workspace, instance or person disabled, credential revoked or not validated, no project, no tool) answer `503 temporarily_unavailable` with `Retry-After: 60`, keep the device and its refresh token, and write `oauth.token.refused` with `revoked: false`; once the cause is fixed the app refreshes with no new approval. Access tokens are still refused on every MCP request while the reason holds. A code exchange refused this way still spends the code.
