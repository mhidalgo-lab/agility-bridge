// SPDX-License-Identifier: Apache-2.0
// The deprecation registry (L-045, tool conventions "Deprecations"): every deprecated tool, argument, output field and
// environment variable, with its replacement and the version that removes it. Machine-readable, so docs, warnings and
// the removal check all come from this one list. A tool lists its own deprecated arguments in `deprecatedArguments`; a test ties the two together.

export interface Deprecation {
  readonly kind: 'tool' | 'argument' | 'output' | 'env';
  /** `list_x`, `list_x.old_arg`, `list_x.oldField` or `AB_OLD_NAME`. */
  readonly name: string;
  readonly replacement?: string;
  /** The version that deprecated it. */
  readonly since: string;
  /** The first version that removes it. */
  readonly removeIn: string;
  readonly note?: string;
}

export const DEPRECATIONS: readonly Deprecation[] = Object.freeze([
  {
    kind: 'argument',
    name: 'get_work_item.minimal_output',
    replacement: 'get_work_item.skip_related',
    since: '0.6.0',
    removeIn: '0.7.0',
    note: 'minimal_output means "identity columns only" in query_assets and get_assets; the related-assets switch has its own name.',
  },
]);

/** The deprecated environment variables that are set, for one warning each at startup. */
export function deprecatedEnv(
  env: Readonly<Record<string, string | undefined>>,
  registry: readonly Deprecation[] = DEPRECATIONS,
): Deprecation[] {
  return registry.filter((d) => d.kind === 'env' && env[d.name] !== undefined);
}
