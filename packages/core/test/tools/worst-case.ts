// SPDX-License-Identifier: Apache-2.0
// The worst-case fixture of every tool (P6-11, L-114): the arguments of the most expensive call the shared world can
// make on a cold cache. `cost.test.ts` iterates CORE_TOOLS and fails for a tool without an entry here, so a new tool
// cannot ship without its worst case. Deeper cases (four-level trees, every page) stay in the tool's own test file.
export interface WorstCase {
  readonly args: Record<string, unknown>;
  /** What makes this the expensive call, for the reader of a failure. */
  readonly why: string;
}

export const WORST_CASES: Readonly<Record<string, WorstCase>> = {
  whoami: { args: {}, why: 'member metadata on a cold cache plus the member query' },
  list_projects: { args: {}, why: 'scope metadata plus one page' },
  list_asset_types: { args: {}, why: 'metadata of every type' },
  describe_asset_type: { args: { asset_type: 'Story' }, why: 'one type with its attributes' },
  query_assets: {
    args: { asset_type: 'Story', fields: ['Name', 'Status.Name', 'Owners.Name', 'Team.Name', 'Scope.Name'] },
    why: 'resolved paths on several relations',
  },
  get_assets: {
    args: { assets: ['B-01001', 'B-01002', 'D-01101'], fields: ['Name', 'Status.Name'] },
    why: 'number lookup of several prefixes',
  },
  search_work_items: {
    args: { member: 'me', team: 'Blue', project: 'Mobile App', contains: 'a' },
    why: 'every resolver (member, team, project, sprint) before the query',
  },
  get_work_item: { args: { asset: 'B-01001' }, why: 'number lookup, details and children' },
  list_my_work: { args: {}, why: 'member resolution plus one page per work item type' },
  list_teams: { args: {}, why: 'teams with their projects' },
  get_team: { args: { team: 'Team:5' }, why: 'team, members and sprints' },
  list_sprints: { args: { team: 'Team:5' }, why: 'team resolution then sprints' },
  get_sprint: {
    args: { sprint: 'current', project: 'Mobile App' },
    why: 'sprint, team and project resolution plus items',
  },
  list_members: { args: {}, why: 'members with roles' },
  get_asset_history: {
    args: { asset: 'B-01001', time_range: 'last 30 days' },
    why: 'number lookup then the history',
  },
  list_recent_changes: {
    args: { project: 'Mobile App', team: 'Blue' },
    why: 'project and team resolution, all five types (epics included)',
  },
  get_conversations: { args: { asset: 'B-01001' }, why: 'number lookup then comments' },
  list_attachments: { args: { asset: 'B-01001' }, why: 'number lookup then attachments and links' },
  get_attachment: {
    args: { asset: 'B-01001', attachment: 'Attachment:1' },
    why: 'lookup, metadata read and the content download',
  },
  list_portfolio_items: {
    args: {
      project: 'Mobile App',
      parent: 'E-00001',
      category: ['Feature'],
      status: ['In Progress'],
      contains: 'a',
    },
    why: 'project and parent resolution plus every filter',
  },
  get_portfolio_tree: { args: { asset: 'E-00001', depth: 3, include_items: true }, why: 'a tree with items' },
  sprint_health: { args: { sprint: 'current' }, why: 'two sections on a cold cache' },
  standup_summary: { args: { member: 'me', time_range: 'last 3 days' }, why: 'two searches' },
  release_readiness: { args: { asset: 'E-00001' }, why: 'one tree' },
  defect_triage: { args: {}, why: 'one search' },
  work_item_quality: { args: { asset: 'B-01002' }, why: 'item plus the priority read' },
};
