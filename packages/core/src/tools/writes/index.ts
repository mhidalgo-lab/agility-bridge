// SPDX-License-Identifier: Apache-2.0
// Wave 1 of the write tools (P7-04): the everyday changes, all built with `defineWriteTool` (group `writes`).
import type { ToolDefinition } from '../../tool.ts';
import { addComment } from './add-comment.ts';
import { assignOwners } from './assign-owners.ts';
import { LIFECYCLE_TOOLS } from './lifecycle.ts';
import { logEffort } from './log-effort.ts';
import { moveToSprint } from './move-to-sprint.ts';
import { updateStatus } from './update-status.ts';

export const WRITE_TOOLS: readonly ToolDefinition[] = Object.freeze([
  addComment,
  updateStatus,
  logEffort,
  assignOwners,
  moveToSprint,
  ...LIFECYCLE_TOOLS,
] as ToolDefinition[]);
