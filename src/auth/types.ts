export const NO_AUTH_METHOD = 'none' as const;
export type AuthMethod = 'none' | 'api-key' | 'oauth2';

export type AuthTokenInfo =
  | { kind: 'none' }
  | {
      kind: 'token';
      token: string;
      tokenType?: string;
      expiresAt?: number;
    };

/**
 * OAuth 2.0 grant types
 */
export type OAuth2GrantType =
  | 'authorization_code'
  | 'client_credentials'
  | 'device_code';

/**
 * Base OAuth2 configuration shared by all grant types
 */
interface OAuth2ConfigBase {
  /** Token endpoint URL */
  tokenUrl: string;
  /** Token revocation endpoint URL (optional) */
  revocationUrl?: string;
  /** OAuth scopes */
  scopes?: string[];
}

/**
 * OAuth 2.0 Authorization Code configuration
 */
export interface OAuth2AuthCodeConfig extends OAuth2ConfigBase {
  grantType: 'authorization_code';
  /** Authorization endpoint URL */
  authorizationUrl: string;
  /** Client ID */
  clientId: string;
  /** Client secret reference (stored in SecretStorage) */
  clientSecret?: string;
  /** Whether to use PKCE (default: true) */
  pkce?: boolean;
  /** Redirect URI (auto-generated if not specified) */
  redirectUri?: string;
}

/**
 * OAuth 2.0 Client Credentials configuration
 */
export interface OAuth2ClientCredentialsConfig extends OAuth2ConfigBase {
  grantType: 'client_credentials';
  /** Client ID */
  clientId: string;
  /** Client secret reference (stored in SecretStorage) */
  clientSecret: string;
}

/**
 * OAuth 2.0 Device Code configuration
 */
export interface OAuth2DeviceCodeConfig extends OAuth2ConfigBase {
  grantType: 'device_code';
  /** Device authorization endpoint URL */
  deviceAuthorizationUrl: string;
  /** Client ID */
  clientId: string;
}

/**
 * OAuth 2.0 configuration (discriminated union by grantType)
 */
export type OAuth2Config =
  | OAuth2AuthCodeConfig
  | OAuth2ClientCredentialsConfig
  | OAuth2DeviceCodeConfig;

/**
 * No authentication configuration
 */
export interface NoAuthConfig {
  method: 'none';
}

/**
 * API Key authentication configuration
 */
export interface ApiKeyAuthConfig {
  method: 'api-key';
  /** Display label for UI */
  label?: string;
  /** Display description for UI */
  description?: string;
  /**
   * API key value or reference to SecretStorage.
   * - Plain text API key
   * - Or a secret reference like `$UCPSECRET:{uuid}$`
   */
  apiKey?: string;
}

/**
 * OAuth 2.0 authentication configuration
 */
export interface OAuth2AuthConfig {
  method: 'oauth2';
  /** Display label for UI */
  label?: string;
  /** Display description for UI */
  description?: string;
  identityId?: string;
  token?: string;
  oauth: OAuth2Config;
}

export type AuthConfig = NoAuthConfig | ApiKeyAuthConfig | OAuth2AuthConfig;

/**
 * Resolved authentication credential.
 * - `expiresAt` is milliseconds since epoch.
 */
export interface AuthCredential {
  value: string;
  tokenType?: string;
  expiresAt?: number;
}

/**
 * OAuth 2.0 token data structure
 */
export interface OAuth2TokenData {
  /** Access token */
  accessToken: string;
  /** Refresh token (optional, for authorization_code flow) */
  refreshToken?: string;
  /** Token type (usually "Bearer") */
  tokenType: string;
  /** Expiration timestamp in milliseconds */
  expiresAt?: number;
  /** OAuth scopes */
  scope?: string;
}
