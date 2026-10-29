// SPDX-License-Identifier: Apache-2.0
// Waiting for work the Worker leaves to `waitUntil` (audit rows, validations): wait on the condition itself with a
// deadline only a hung Worker reaches. A fixed number of short polls (about a second) failed on loaded runners (L-381).

/** Calls `check` until it returns true or `timeoutMs` passes; returns the last answer. */
export async function until(
  check: () => Promise<boolean>,
  timeoutMs = 20_000,
  everyMs = 25,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
