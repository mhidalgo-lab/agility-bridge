// SPDX-License-Identifier: Apache-2.0
// The test harness (P1-12, docs/dev/testing.md). Tool tests import from here.

export { makeContext } from '../helpers/context.ts';
export {
  FAKE_BASE_URL,
  FakeAgility,
  FakeAgilityError,
  type FakeAgilityOptions,
  type FakeCall,
  type Row,
} from './agility.ts';
export {
  DEFAULT_CATALOGUE_MAX_BYTES,
  DEFAULT_CATALOGUE_MAX_TOOLS,
  defaultCatalogue,
  FULL_CATALOGUE_MAX_BYTES,
  OPT_IN_GROUPS,
  type ToolsListContract,
  toolsListContract,
} from './contract.ts';
export { type CostMeasurement, measureCost } from './cost.ts';
export {
  CANARY_RE,
  FORGED_ROWS,
  foreignScopeRow,
  MALFORMED_BODIES,
  permissionLimitedRow,
  poison,
  poisonedRows,
} from './hostile.ts';
export { findLeaks, type Leak, outsideEnvelopes, probeTool } from './probe.ts';
export { PROPERTY_SEED, propertyParams } from './property.ts';
