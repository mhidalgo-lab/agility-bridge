// SPDX-License-Identifier: Apache-2.0
// Device tokens, the effective-permission resolver, identity providers and OAuth integration (ARCHITECTURE §2).
export {
  type KeyringCheck,
  type KeyVersionStatus,
  keyStatus,
  openCredentialToken,
  type RotationOptions,
  type RotationResult,
  retireKeyVersion,
  rotateCredentialKeys,
  sealCredentialToken,
  tokenHint,
  verifyKeyring,
} from './secrets/credentials.ts';
export {
  generateMasterKey,
  KeyPurpose,
  Keyring,
  type MasterKeyMaterial,
  parseMasterKey,
  type Sealed,
  SecretsError,
  type SecretsErrorCode,
  timingSafeEqual,
} from './secrets/keyring.ts';
