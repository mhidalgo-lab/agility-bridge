// SPDX-License-Identifier: Apache-2.0
// One manifest for the things an MCP server offers besides tools: resources (P6-09) and, later, prompts (P6-08).
// Every entry names the tools it is served through (`uses`); an entry exists for a caller only when every one of
// those tools is allowed for the workspace and grant. One rule, one place (L-153): registration, `resources/list`,
// the generated reference and the tests all read the same list.

/** What every manifest entry (resource, prompt) declares. */
export interface ManifestEntry {
  /** Stable id: snake_case, unique inside its manifest; audit rows say `resource:<id>`. */
  readonly id: string;
  /** Tools whose handlers serve the entry. All must be allowed for the caller. Empty: no tool needed. */
  readonly uses: readonly string[];
}

/** Whether a caller with these allowed tool names may see the entry. */
export function isAvailable(entry: Pick<ManifestEntry, 'uses'>, allowedTools: ReadonlySet<string>): boolean {
  return entry.uses.every((t) => allowedTools.has(t));
}

/** The entries of a manifest available to a caller, in manifest order. */
export function availableEntries<T extends ManifestEntry>(
  manifest: readonly T[],
  allowedTools: Iterable<string>,
): T[] {
  const allowed = new Set(allowedTools);
  return manifest.filter((e) => isAvailable(e, allowed));
}

const ID_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/** Throws when a manifest has a malformed or duplicate id. */
export function assertManifest(manifest: readonly ManifestEntry[]): void {
  const seen = new Set<string>();
  for (const e of manifest) {
    if (!ID_RE.test(e.id)) throw new Error(`Manifest id "${e.id}" must be snake_case.`);
    if (seen.has(e.id)) throw new Error(`Duplicate manifest id "${e.id}".`);
    seen.add(e.id);
  }
}
