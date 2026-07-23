// Constants and utilities
export {
  SECRET_REF_PREFIX,
  SECRET_REF_SUFFIX,
  LOCAL_AUTH_REF_PREFIX,
  LOCAL_AUTH_REF_SUFFIX,
  SECRET_STORAGE_PREFIX,
  SECRET_KEY_PREFIXES,
  DEVICE_STATE_STORAGE_PREFIX,
  ORPHAN_SECRET_RETENTION_MS,
  createSecretRef,
  isSecretRef,
  isSessionSecretRef,
  isLegacySecretRef,
  isLocalAuthRef,
  extractUuidFromRef,
  buildApiKeyStorageKey,
  buildOAuth2TokenStorageKey,
  buildOAuth2ClientSecretStorageKey,
  extractUuidFromStorageKey,
  buildRefFromUuid,
} from './constants';

// Secret store
export {
  SecretStore,
  type ApiKeyStorageStatus,
  type LocalAuthStateChange,
  type LocalAuthStateChangeReason,
  type LocalAuthCommitGuard,
  type LocalAuthSessionTransaction,
  LocalAuthStateConflictError,
  LOCAL_AUTH_STATE_CONFLICT_MESSAGE,
  isLocalAuthStateConflictError,
  type ActiveLocalAuthFingerprint,
  type LegacyOAuth2TokenCandidate,
  type LegacyOAuth2ClientSecretCandidate,
} from './secret-store';

// Cleanup
export {
  cleanupUnusedSecrets,
  reconcileLocalAuthStateWithConfiguredEndpoints,
} from './cleanup';

// Migration
export {
  migrateApiKeyToAuth,
  migrateProviderTypes,
  migrateSessionAuthState,
  migrateApiKeyStorage,
} from './migration';
