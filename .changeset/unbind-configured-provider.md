---
"agility-bridge": patch
---

The owner's unbind (`POST /users/{id}/unbind`, `user unbind --to`, the panel) only accepts a provider this deployment has configured: a typo is refused with 422 before anything is written, and the panel offers a select of the configured providers.
