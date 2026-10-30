---
"agility-bridge": patch
---

Self-monitoring on Workers (P8-43): spans are queued per isolate and sent in batches (64 spans, about 128 KiB or five seconds) through the `waitUntil` of the request that triggers the send, instead of one collector request per request; the queue is bounded in count, bytes and sends in flight, and spans of an evicted isolate are lost (at most five seconds). Fixes the OTLP exporter on Workers, which workerd rejected (`redirect: 'error'`), so no span was delivered from a Worker before.
