// SPDX-License-Identifier: Apache-2.0
// Container healthcheck (no shell or curl in distroless): GET /health on the loopback port.
const port = process.env.AB_PORT || '8787';
try {
  const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(4000) });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
