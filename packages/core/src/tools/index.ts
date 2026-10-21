// SPDX-License-Identifier: Apache-2.0
// The tool catalogue (docs/reference/tool-catalogue.md). Tool tasks add their definitions here; the contract, probe and
// cost tests in test/ run over every entry.
import type { ToolDefinition } from '../tool.ts';
import { describeAssetType, listAssetTypes } from './core/asset-types.ts';
import { listProjects } from './core/list-projects.ts';
import { whoami } from './core/whoami.ts';

export const CORE_TOOLS: readonly ToolDefinition[] = Object.freeze([
  whoami,
  listProjects,
  listAssetTypes,
  describeAssetType,
] as ToolDefinition[]);
