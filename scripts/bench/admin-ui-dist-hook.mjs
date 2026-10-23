// SPDX-License-Identifier: Apache-2.0
// A module resolution hook for the benchmark (P4-14): the panel is JSX, which Node cannot load from source, so
// `@agility-bridge/admin-ui` resolves to its built bundle (what the Worker's own bundle contains, compiled the same way).
// Every other package keeps resolving to source.
import { fileURLToPath } from 'node:url';

const DIST = new URL('../../packages/admin-ui/dist/index.mjs', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === '@agility-bridge/admin-ui') return { url: DIST, shortCircuit: true };
  return next(specifier, context);
}

export const distPath = fileURLToPath(DIST);
