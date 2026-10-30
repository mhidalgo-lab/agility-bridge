---
id: P8-43
title: Batch OTLP spans per isolate on Workers
phase: 8
status: todo
priority: low
depends_on: [P8-35]
adr: ["0010"]
lessons: [L-453, L-096]
owner: ""
---

# P8-43 — Batch OTLP spans per isolate on Workers

> Split from [P8-35](P8-35-catalogue-cache-single-flight.md) (D-312), review P-3.

## Goal
Cut the outgoing OTLP requests of the Worker from one per request to one per batch, without losing the spans of an isolate that is evicted and without a promise or I/O object crossing requests.

## Scope
- Queue finished spans per isolate (bytes only, no I/O object) and flush by size or age, through the `waitUntil` of whichever request is live when the limit is reached.
- Decide what happens to spans still queued when an isolate goes away (accepted loss, bounded by the age limit) and say so in the guide.
- The Node host keeps its periodic flush; the unauthenticated sampling of D-304 stays.

## Acceptance criteria
- [ ] A test on the Worker host shows many requests produce fewer collector requests, with every span's attributes intact.
- [ ] A test shows a collector that is down or slow neither delays a response nor grows the queue without bound.
- [ ] The same tests run against the Node host's behaviour (no change in what is exported).
- [ ] `pnpm bench:worker` shows the telemetry row (see P8-37) with and without batching.

## Security notes
THREAT_MODEL T30: the attribute allowlist applies to queued spans exactly as to exported ones.

## Lessons applied
- L-453
- L-096

## Docs to update
- docs/guide/observability.md, docs/guide/cloudflare-limits.md

## Out of scope
- Changing what a span contains.
