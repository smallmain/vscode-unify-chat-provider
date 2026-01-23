export const NO_AUTH_METHOD = 'none' as const;
export type AuthMethod =
  | 'none'
  | 'api-key'
  | 'oauth2'
  | 'iflow-cli'
  | 'antigravity-oauth'
  | 'google-vertex-ai-auth'
  | 'openai-codex'
  | 'qwen-code'
  | 'github-copilot';

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

export interface IFlowCliAuthConfig {
  method: 'iflow-cli';
  label?: string;
  description?: string;
  identityId?: string;
  token?: string;
  email?: string;
}

export interface AntigravityOAuthConfig {
  method: 'antigravity-oauth';
  label?: string;
  description?: string;
  identityId?: string;
  token?: string;
  projectId?: string;
  tier?: 'free' | 'paid';
  email?: string;
}

export interface OpenAICodexAuthConfig {
  method: 'openai-codex';
  label?: string;
  description?: string;
  identityId?: string;
  token?: string;
  /** ChatGPT organization/subscription account ID (for ChatGPT-Account-Id header) */
  accountId?: string;
  email?: string;
}

export interface QwenCodeAuthConfig {
  method: 'qwen-code';
  label?: string;
  description?: string;
  identityId?: string;
  token?: string;
  /** Optional user label (email/alias) for display */
  email?: string;
  /** Resource hostname returned by Qwen OAuth (e.g. portal.qwen.ai) */
  resourceUrl?: string;
}

export interface GitHubCopilotAuthConfig {
  method: 'github-copilot';
  label?: string;
  description?: string;
  identityId?: string;
  token?: string;
  /**
   * Enterprise domain (hostname, optional port), e.g. `github.mycompany.com`.
   * When unset, defaults to `github.com`.
   */
  enterpriseUrl?: string;
}

/**
 * Google Vertex AI authentication sub-type
 */
export type GoogleVertexAIAuthSubType = 'adc' | 'service-account' | 'api-key';

/**
 * Base configuration shared by all Google Vertex AI auth types
 */
interface GoogleVertexAIAuthBaseConfig {
  method: 'google-vertex-ai-auth';
  /** Display label for UI */
  label?: string;
  /** Display description for UI */
  description?: string;
}

/**
 * ADC (Application Default Credentials) configuration
 */
export interface GoogleVertexAIAdcConfig extends GoogleVertexAIAuthBaseConfig {
  subType: 'adc';
  /** Google Cloud Project ID (required for ADC) */
  projectId: string;
  /** Google Cloud Location/Region (required for ADC) */
  location: string;
}

/**
 * Service Account JSON key file configuration
 */
export interface GoogleVertexAIServiceAccountConfig
  extends GoogleVertexAIAuthBaseConfig {
  subType: 'service-account';
  /** Path to service account JSON key file */
  keyFilePath: string;
  /** Google Cloud Project ID (can be extracted from key file or overridden) */
  projectId?: string;
  /** Google Cloud Location/Region (required) */
  location: string;
}

/**
 * API Key configuration (for Vertex AI Express Mode)
 */
export interface GoogleVertexAIApiKeyConfig
  extends GoogleVertexAIAuthBaseConfig {
  subType: 'api-key';
  /** API key value or secret reference */
  apiKey?: string;
}

/**
 * Google Vertex AI unified authentication configuration
 */
export type GoogleVertexAIAuthConfig =
  | GoogleVertexAIAdcConfig
  | GoogleVertexAIServiceAccountConfig
  | GoogleVertexAIApiKeyConfig;

export type AuthConfig =
  | NoAuthConfig
  | ApiKeyAuthConfig
  | OAuth2AuthConfig
  | IFlowCliAuthConfig
  | AntigravityOAuthConfig
  | OpenAICodexAuthConfig
  | QwenCodeAuthConfig
  | GitHubCopilotAuthConfig
  | GoogleVertexAIAuthConfig;

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
