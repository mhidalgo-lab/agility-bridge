// SPDX-License-Identifier: Apache-2.0
// The sibling tools each composite report reads (P6-11, L-037). One table: the reports' tests tie it to the sections
// they run, `whoami` and the admin panel use it to warn when a composite is granted without some of its siblings
// (the missing sections are skipped and named, never shown as empty, but the operator should know before a caller does).

/** Composite tool name -> the tools its sections read (sorted). */
export const COMPOSITE_SIBLINGS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  defect_triage: Object.freeze(['search_work_items']),
  quality_scan: Object.freeze(['get_work_item']),
  release_readiness: Object.freeze(['get_portfolio_tree']),
  sprint_health: Object.freeze(['get_sprint', 'search_work_items']),
  standup_summary: Object.freeze(['search_work_items']),
  work_item_quality: Object.freeze(['get_work_item']),
});

export interface CompositeWarning {
  /** The granted composite. */
  readonly tool: string;
  /** Siblings it reads that are not granted (sorted). */
  readonly missing: readonly string[];
  /** Fixed text for an agent or an operator (names are our own tool names). */
  readonly message: string;
}

/**
 * One warning per composite in `granted` that lacks some sibling in `granted`. A composite that is not granted, or has
 * every sibling, produces nothing. `table` is a parameter for tests.
 */
export function compositeWarnings(
  granted: Iterable<string>,
  table: Readonly<Record<string, readonly string[]>> = COMPOSITE_SIBLINGS,
): CompositeWarning[] {
  const have = new Set(granted);
  const out: CompositeWarning[] = [];
  for (const [tool, siblings] of Object.entries(table)) {
    if (!have.has(tool)) continue;
    const missing = siblings.filter((s) => !have.has(s));
    if (missing.length === 0) continue;
    out.push({
      tool,
      missing,
      message: `${tool} is granted without ${missing.join(', ')}: the section${missing.length === 1 ? '' : 's'} that read${missing.length === 1 ? 's' : ''} ${missing.length === 1 ? 'it' : 'them'} will be skipped and named as not read.`,
    });
  }
  return out;
}
