import { randomUUID } from 'crypto';

/**
 * Secret reference format used in configuration.
 * Format: $UCPSECRET:{uuid}$
 */
export const SECRET_REF_PREFIX = '$UCPSECRET:';
export const SECRET_REF_SUFFIX = '$';

/**
 * SecretStorage key prefix for all extension secrets.
 */
export const SECRET_STORAGE_PREFIX = 'ucp:';

/**
 * SecretStorage key prefixes by secret type.
 */
export const SECRET_KEY_PREFIXES = {
  apiKey: `${SECRET_STORAGE_PREFIX}api-key:`,
  oauth2Token: `${SECRET_STORAGE_PREFIX}oauth2-token:`,
  oauth2ClientSecret: `${SECRET_STORAGE_PREFIX}oauth2-client-secret:`,
} as const;

const UUID_V4_LIKE_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Create a new secret reference string.
 * Format: $UCPSECRET:{uuid}$
 */
export function createSecretRef(): string {
  return `${SECRET_REF_PREFIX}${randomUUID()}${SECRET_REF_SUFFIX}`;
}

/**
 * Check if a value is a secret reference.
 */
export function isSecretRef(value: string): boolean {
  if (
    !value.startsWith(SECRET_REF_PREFIX) ||
    !value.endsWith(SECRET_REF_SUFFIX)
  ) {
    return false;
  }
  const inner = value.slice(
    SECRET_REF_PREFIX.length,
    -SECRET_REF_SUFFIX.length,
  );
  return UUID_V4_LIKE_REGEX.test(inner);
}

/**
 * Extract UUID from a secret reference.
 * Returns null if the value is not a valid secret reference.
 */
export function extractUuidFromRef(ref: string): string | null {
  if (!isSecretRef(ref)) {
    return null;
  }
  return ref.slice(SECRET_REF_PREFIX.length, -SECRET_REF_SUFFIX.length);
}

/**
 * Build the SecretStorage key for an API key.
 * @param ref The secret reference (e.g., $UCPSECRET:{uuid}$)
 */
export function buildApiKeyStorageKey(ref: string): string | null {
  const uuid = extractUuidFromRef(ref);
  if (!uuid) {
    return null;
  }
  return `${SECRET_KEY_PREFIXES.apiKey}${uuid}`;
}

/**
 * Build the SecretStorage key for an OAuth2 token.
 * @param ref The secret reference (e.g., $UCPSECRET:{uuid}$)
 */
export function buildOAuth2TokenStorageKey(ref: string): string | null {
  const uuid = extractUuidFromRef(ref);
  if (!uuid) {
    return null;
  }
  return `${SECRET_KEY_PREFIXES.oauth2Token}${uuid}`;
}

/**
 * Build the SecretStorage key for an OAuth2 client secret.
 * @param ref The secret reference (e.g., $UCPSECRET:{uuid}$)
 */
export function buildOAuth2ClientSecretStorageKey(ref: string): string | null {
  const uuid = extractUuidFromRef(ref);
  if (!uuid) {
    return null;
  }
  return `${SECRET_KEY_PREFIXES.oauth2ClientSecret}${uuid}`;
}

/**
 * Extract UUID from a SecretStorage key.
 * Works for api-key and oauth2-client-secret keys.
 */
export function extractUuidFromStorageKey(key: string): string | null {
  if (key.startsWith(SECRET_KEY_PREFIXES.apiKey)) {
    return key.slice(SECRET_KEY_PREFIXES.apiKey.length);
  }
  if (key.startsWith(SECRET_KEY_PREFIXES.oauth2ClientSecret)) {
    return key.slice(SECRET_KEY_PREFIXES.oauth2ClientSecret.length);
  }
  if (key.startsWith(SECRET_KEY_PREFIXES.oauth2Token)) {
    return key.slice(SECRET_KEY_PREFIXES.oauth2Token.length);
  }
  return null;
}

/**
 * Rebuild a secret reference from a UUID.
 */
export function buildRefFromUuid(uuid: string): string {
  return `${SECRET_REF_PREFIX}${uuid}${SECRET_REF_SUFFIX}`;
}
