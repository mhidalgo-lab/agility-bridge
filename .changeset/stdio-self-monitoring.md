---
"agility-bridge": minor
---

The stdio server now exports the same self-monitoring spans as `serve` when `AB_OTEL_ENDPOINT` (and optionally `AB_OTEL_HEADERS`) are set: one allowlisted span per MCP request and notification, sent to your OTLP/HTTP collector without ever delaying a call or writing to stdout (P8-20). It is off by default.
