// SPDX-License-Identifier: Apache-2.0
// The tool catalogue (docs/reference/tool-catalogue.md). Tool tasks add their definitions here; the contract, probe and
// cost tests in test/ run over every entry.
import type { ToolDefinition } from '../tool.ts';
import { getAttachment, listAttachments } from './collaboration/attachments.ts';
import { getConversations } from './collaboration/conversations.ts';
import { describeAssetType, listAssetTypes } from './core/asset-types.ts';
import { listProjects } from './core/list-projects.ts';
import { whoami } from './core/whoami.ts';
import { getAssetHistory } from './history/asset-history.ts';
import { listRecentChanges } from './history/recent-changes.ts';
import { listMembers } from './planning/members.ts';
import { getSprint } from './planning/sprint.ts';
import { listSprints } from './planning/sprints.ts';
import { getTeam, listTeams } from './planning/teams.ts';
import { getVelocity } from './planning/velocity.ts';
import { getPortfolioTree } from './portfolio/get-tree.ts';
import { listPortfolioItems } from './portfolio/list-items.ts';
import { getAssets } from './query/get-assets.ts';
import { queryAssets } from './query/query-assets.ts';
import { defectTriage } from './reports/defect-triage.ts';
import { workItemQuality } from './reports/quality.ts';
import { qualityScan } from './reports/quality-scan.ts';
import { releaseReadiness } from './reports/release-readiness.ts';
import { sprintHealth } from './reports/sprint-health.ts';
import { standupSummary } from './reports/standup.ts';
import { getWorkItem } from './work/get-item.ts';
import { listMyWork } from './work/my-work.ts';
import { searchWorkItems } from './work/search.ts';
import { WRITE_TOOLS } from './writes/index.ts';

export const CORE_TOOLS: readonly ToolDefinition[] = Object.freeze([
  whoami,
  listProjects,
  listAssetTypes,
  describeAssetType,
  queryAssets,
  getAssets,
  searchWorkItems,
  getWorkItem,
  listMyWork,
  listTeams,
  getTeam,
  listSprints,
  getSprint,
  getVelocity,
  listMembers,
  getAssetHistory,
  listRecentChanges,
  getConversations,
  listAttachments,
  getAttachment,

  listPortfolioItems,
  getPortfolioTree,
  sprintHealth,
  standupSummary,
  releaseReadiness,
  defectTriage,
  workItemQuality,
  qualityScan,

  ...WRITE_TOOLS,
] as ToolDefinition[]);
