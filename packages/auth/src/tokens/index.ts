// SPDX-License-Identifier: Apache-2.0
export {
  type AuthenticationDecision,
  authenticateDeviceToken,
  bearerToken,
  crc32,
  DEFAULT_TOKEN_DAYS,
  generateDeviceToken,
  hashDeviceToken,
  isWellFormedDeviceToken,
  type NewDeviceToken,
  TOUCH_INTERVAL_MS,
  type TokenEnvironment,
} from './device.ts';
