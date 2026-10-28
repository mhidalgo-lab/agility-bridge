// SPDX-License-Identifier: Apache-2.0
// The notes a composite report takes over from a sibling tool (P6-48, L-038). A sibling's notes reach the report as plain
// text. A note is accepted as the report's own text only when the whole text matches one of the fixed templates below
// (fixed words and digits, nothing else), which an Agility name cannot satisfy; it is then reported with a stable code.
// Any other note is forwarded inside the untrusted-data envelope. The templates are tied to the sibling's wording by a
// test that reads every note `get_sprint` emits on the shared worlds, so a reworded note fails there, not silently.

export interface SiblingNote {
  readonly code: string;
  /** Matches the entire note: fixed text plus digits. */
  readonly pattern: RegExp;
}

const N = '\\d{1,9}';

/** `get_sprint` notes, by code. Order does not matter: the templates are disjoint. */
export const SPRINT_NOTES: readonly SiblingNote[] = Object.freeze([
  {
    code: 'sprint_no_dates',
    pattern:
      /^The sprint has no usable UTC begin and end dates: timing, committed and burndown are not reported\.$/,
  },
  {
    code: 'sprint_dates_read_as_utc',
    pattern: /^Agility gives sprint dates without a time zone; they are read as UTC\.$/,
  },
  {
    code: 'no_estimate_field',
    pattern: /^This instance has no estimate on backlog items: no estimates are reported\.$/,
  },
  {
    code: 'ended_beyond_history',
    pattern: new RegExp(
      `^The sprint ended more than ${N} days ago, beyond the history limit: items are shown as they are now, and carry-over, committed and burndown are not reported\\.$`,
    ),
  },
  {
    code: 'item_cap_reached',
    pattern: new RegExp(
      `^The sprint has more than ${N} items: totals cover the first ${N} and are lower bounds; burndown and scope change are not reported\\.$`,
    ),
  },
  {
    code: 'items_without_estimate',
    pattern: new RegExp(`^${N} items? (?:has|have) no estimate and are not in the estimate totals\\.$`),
  },
  {
    code: 'items_without_category',
    pattern: new RegExp(
      `^${N} items? (?:has|have) no status category on this instance; counted as not done\\.$`,
    ),
  },
  {
    code: 'sprint_not_started',
    pattern:
      /^The sprint has not started: nothing is committed yet and there is no burndown; totals are the plan\.$/,
  },
  {
    code: 'history_points_too_old',
    pattern: new RegExp(
      `^${N} history points? (?:is|are) older than ${N} days \\(the history limit\\) and left out\\.$`,
    ),
  },
  {
    code: 'history_points_cut',
    pattern: new RegExp(
      `^${N} history points? (?:is|are) left out: the sprint had more than ${N} items then\\.$`,
    ),
  },
  {
    code: 'committed_beyond_history',
    pattern: /^Committed is not reported: the begin date is beyond the history limit\.$/,
  },
  {
    code: 'committed_unreadable',
    pattern: /^Committed is not reported: the sprint’s items at its begin date could not be read in full\.$/,
  },
  {
    code: 'last_point_now',
    pattern: /^The last burndown point is now; earlier points are daily from the begin date \(UTC\)\.$/,
  },
  {
    code: 'closed_without_category',
    pattern: new RegExp(
      `^${N} closed items? (?:has|have) no status category: counted as done in the totals and the last point, but as remaining at earlier points \\(history cannot read an item’s state\\)\\.$`,
    ),
  },
  {
    code: 'no_capacity_model',
    pattern:
      /^Capacity is not reported: this Agility schema has no capacity model on sprints, and nothing is estimated in its place\.$/,
  },
  {
    code: 'item_list_cut',
    pattern: new RegExp(`^The item list shows the first ${N} of ${N} items; totals cover all of them\\.$`),
  },
  {
    code: 'items_outside_workspace',
    pattern:
      /^Some items were left out because they are outside the workspace or of a type this workspace does not allow\.$/,
  },
]);

export interface ClassifiedNotes {
  /** Notes that matched a template: safe to show as the report's own text. */
  readonly own: ReadonlyArray<{ readonly code: string; readonly text: string }>;
  /** Everything else, to be forwarded as untrusted data. */
  readonly untrusted: readonly string[];
}

/** Splits a sibling's notes into those that are fixed wording (with a code) and those that are not. */
export function classifySiblingNotes(
  notes: readonly unknown[],
  table: readonly SiblingNote[] = SPRINT_NOTES,
): ClassifiedNotes {
  const own: Array<{ code: string; text: string }> = [];
  const other: string[] = [];
  for (const n of notes) {
    if (typeof n !== 'string') continue;
    const hit = table.find((t) => t.pattern.test(n));
    if (hit === undefined) other.push(n);
    else own.push({ code: hit.code, text: n });
  }
  return { own, untrusted: other };
}
