// SPDX-License-Identifier: Apache-2.0
// Waves 1 and 2 of the write tools (P7-04, P7-05): the everyday changes, create and update fields, all built with `defineWriteTool` (group `writes`).
import type { ToolDefinition } from '../../tool.ts';
import { addComment } from './add-comment.ts';
import { assignOwners } from './assign-owners.ts';
import { createWorkItem } from './create-work-item.ts';
import { LIFECYCLE_TOOLS } from './lifecycle.ts';
import { logEffort } from './log-effort.ts';
import { moveToSprint } from './move-to-sprint.ts';
import { updateFields } from './update-fields.ts';
import { updateStatus } from './update-status.ts';

export const WRITE_TOOLS: readonly ToolDefinition[] = Object.freeze([
  addComment,
  updateStatus,
  logEffort,
  assignOwners,
  moveToSprint,
  ...LIFECYCLE_TOOLS,
  createWorkItem,
  updateFields,
] as ToolDefinition[]);
