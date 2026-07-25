export const NO_AUTH_METHOD = 'none' as const;
export type AuthMethod =
  | 'none'
  | 'api-key'
  | 'oauth2'
  | 'antigravity-oauth'
  | 'google-gemini-oauth'
  | 'google-vertex-ai-auth'
  | 'claude-code'
  | 'openai-codex'
  | 'xai-grok-oauth'
  | 'github-copilot'
  | 'zed';

export type SessionAuthMethod = Exclude<
  AuthMethod,
  'none' | 'api-key' | 'google-vertex-ai-auth'
>;

interface AuthContextBase<M extends SessionAuthMethod> {
  readonly method: M;
  readonly bindingId: string;
  readonly sessionId: string;
  readonly revision: number;
}

export interface OAuth2AuthContext extends AuthContextBase<'oauth2'> {}

export interface AntigravityAuthContext
  extends AuthContextBase<'antigravity-oauth'> {
  readonly projectId?: string;
  readonly managedProjectId?: string;
  readonly tier?: 'free' | 'paid';
  readonly tierId?: string;
  readonly email?: string;
}

export interface GeminiAuthContext
  extends AuthContextBase<'google-gemini-oauth'> {
  readonly projectId?: string;
  readonly managedProjectId?: string;
  readonly tier?: 'free' | 'paid';
  readonly tierId?: string;
  readonly email?: string;
}

export interface CodexAuthContext extends AuthContextBase<'openai-codex'> {
  readonly accountId?: string;
  readonly email?: string;
}

export interface ClaudeAuthContext extends AuthContextBase<'claude-code'> {
  readonly email?: string;
}

export interface XaiAuthContext extends AuthContextBase<'xai-grok-oauth'> {
  readonly email?: string;
}

export interface CopilotAuthContext
  extends AuthContextBase<'github-copilot'> {}

export interface ZedAuthContext extends AuthContextBase<'zed'> {
  readonly organizationId: string;
  readonly dataCollection: boolean;
  readonly dataCollectionAllowed: boolean;
  readonly email?: string;
}

export type AuthContext =
  | OAuth2AuthContext
  | AntigravityAuthContext
  | GeminiAuthContext
  | CodexAuthContext
  | ClaudeAuthContext
  | XaiAuthContext
  | CopilotAuthContext
  | ZedAuthContext;

export type AuthTokenInfo =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'token';
      readonly token: string;
      readonly tokenType?: string;
      readonly expiresAt?: number;
      readonly authContext?: AuthContext;
    };

export type AuthTokenRefresh = () => Promise<AuthTokenInfo>;

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

interface SessionAuthConfigBase {
  /** Stable, non-secret identifier shared through Settings Sync. */
  bindingId: string;
  /** Display label for UI */
  label?: string;
  /** Display description for UI */
  description?: string;
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
  /** Client secret or local SecretStorage reference; omitted from settings. */
  clientSecret?: string;
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

export type OAuth2StaticConfig =
  | Omit<OAuth2AuthCodeConfig, 'clientSecret'>
  | Omit<OAuth2ClientCredentialsConfig, 'clientSecret'>
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
export interface PersistedOAuth2AuthConfig extends SessionAuthConfigBase {
  method: 'oauth2';
  oauth: OAuth2StaticConfig;
}

export interface PersistedAntigravityOAuthConfig
  extends SessionAuthConfigBase {
  method: 'antigravity-oauth';
}

export interface PersistedGeminiCliOAuthConfig
  extends SessionAuthConfigBase {
  method: 'google-gemini-oauth';
  /** Gemini OAuth account type. Defaults to Code Assist. */
  oauthType?: 'code_assist' | 'ai_studio' | 'google_one';
}

export interface PersistedOpenAICodexAuthConfig
  extends SessionAuthConfigBase {
  method: 'openai-codex';
}

export interface PersistedClaudeCodeAuthConfig extends SessionAuthConfigBase {
  method: 'claude-code';
}

export interface PersistedXaiGrokOAuthConfig extends SessionAuthConfigBase {
  method: 'xai-grok-oauth';
}

export interface PersistedGitHubCopilotAuthConfig
  extends SessionAuthConfigBase {
  method: 'github-copilot';
  /**
   * Enterprise domain (hostname, optional port), e.g. `github.mycompany.com`.
   * When unset, defaults to `github.com`.
   */
  enterpriseUrl?: string;
}

/** Zed native-app configuration synchronized between devices. */
export interface PersistedZedAuthConfig extends SessionAuthConfigBase {
  method: 'zed';
  /** Zed site used for native sign-in and cloud requests. */
  baseUrl?: string;
}

interface SessionAuthRuntimeFields {
  identityId?: string;
  token?: string;
}

export type OAuth2AuthConfig = Omit<
  PersistedOAuth2AuthConfig,
  'oauth'
> &
  SessionAuthRuntimeFields & {
    oauth: OAuth2Config;
  };

export interface AntigravityOAuthConfig
  extends PersistedAntigravityOAuthConfig,
    SessionAuthRuntimeFields {
  /** Optional user-provided project id (duetProject) */
  projectId?: string;
  /** Cloud Code Assist managed project id (cloudaicompanionProject) */
  managedProjectId?: string;
  tier?: 'free' | 'paid';
  /** More precise tier identifier (e.g. current_tier.id / paid_tier.id) */
  tierId?: string;
  email?: string;
}

/**
 * Gemini CLI OAuth authentication configuration.
 * Uses the official Google Gemini CLI OAuth credentials.
 */
export interface GeminiCliOAuthConfig
  extends PersistedGeminiCliOAuthConfig,
    SessionAuthRuntimeFields {
  /** Optional user-provided project id (duetProject). Used as fallback when managedProjectId is unavailable. */
  projectId?: string;
  /** Cloud Code Assist managed project id (cloudaicompanionProject) */
  managedProjectId?: string;
  tier?: 'free' | 'paid';
  /** More precise tier identifier (e.g. current_tier.id / paid_tier.id) */
  tierId?: string;
  email?: string;
}

export interface OpenAICodexAuthConfig
  extends PersistedOpenAICodexAuthConfig,
    SessionAuthRuntimeFields {
  /** ChatGPT organization/subscription account ID (for ChatGPT-Account-Id header) */
  accountId?: string;
  email?: string;
}

export interface ClaudeCodeAuthConfig
  extends PersistedClaudeCodeAuthConfig,
    SessionAuthRuntimeFields {
  email?: string;
}

export interface XaiGrokOAuthConfig
  extends PersistedXaiGrokOAuthConfig,
    SessionAuthRuntimeFields {
  email?: string;
}

export interface GitHubCopilotAuthConfig
  extends PersistedGitHubCopilotAuthConfig,
    SessionAuthRuntimeFields {}

/** Zed native-app sign-in configuration. */
export interface ZedAuthConfig
  extends PersistedZedAuthConfig,
    SessionAuthRuntimeFields {
  /** Stable identity used to partition provider-scoped cached state. */
  identityId?: string;
  /** SecretStorage reference containing the long-lived Zed credential. */
  token?: string;
  /** Selected organization for token exchange and Zed Cloud requests. */
  organizationId?: string;
  /** Explicit source/data collection opt-in. Defaults to false. */
  dataCollection?: boolean;
  /** Last observed organization policy. Missing values fail closed. */
  dataCollectionAllowed?: boolean;
  /** Account email, when returned by the Zed account endpoint. */
  email?: string;
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
export interface GoogleVertexAIServiceAccountConfig extends GoogleVertexAIAuthBaseConfig {
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
export interface GoogleVertexAIApiKeyConfig extends GoogleVertexAIAuthBaseConfig {
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
  | PersistedOAuth2AuthConfig
  | PersistedAntigravityOAuthConfig
  | PersistedGeminiCliOAuthConfig
  | PersistedOpenAICodexAuthConfig
  | PersistedClaudeCodeAuthConfig
  | PersistedXaiGrokOAuthConfig
  | PersistedGitHubCopilotAuthConfig
  | PersistedZedAuthConfig
  | GoogleVertexAIAuthConfig;

export type AuthRuntimeConfig =
  | NoAuthConfig
  | ApiKeyAuthConfig
  | OAuth2AuthConfig
  | AntigravityOAuthConfig
  | GeminiCliOAuthConfig
  | OpenAICodexAuthConfig
  | ClaudeCodeAuthConfig
  | XaiGrokOAuthConfig
  | GitHubCopilotAuthConfig
  | ZedAuthConfig
  | GoogleVertexAIAuthConfig;

export interface AuthConfigByMethod {
  none: NoAuthConfig;
  'api-key': ApiKeyAuthConfig;
  oauth2: PersistedOAuth2AuthConfig;
  'antigravity-oauth': PersistedAntigravityOAuthConfig;
  'google-gemini-oauth': PersistedGeminiCliOAuthConfig;
  'google-vertex-ai-auth': GoogleVertexAIAuthConfig;
  'claude-code': PersistedClaudeCodeAuthConfig;
  'openai-codex': PersistedOpenAICodexAuthConfig;
  'xai-grok-oauth': PersistedXaiGrokOAuthConfig;
  'github-copilot': PersistedGitHubCopilotAuthConfig;
  zed: PersistedZedAuthConfig;
}

export interface AuthRuntimeConfigByMethod {
  none: NoAuthConfig;
  'api-key': ApiKeyAuthConfig;
  oauth2: OAuth2AuthConfig;
  'antigravity-oauth': AntigravityOAuthConfig;
  'google-gemini-oauth': GeminiCliOAuthConfig;
  'google-vertex-ai-auth': GoogleVertexAIAuthConfig;
  'claude-code': ClaudeCodeAuthConfig;
  'openai-codex': OpenAICodexAuthConfig;
  'xai-grok-oauth': XaiGrokOAuthConfig;
  'github-copilot': GitHubCopilotAuthConfig;
  zed: ZedAuthConfig;
}

export type SessionAuthConfig = AuthConfigByMethod[SessionAuthMethod];
export type SessionAuthRuntimeConfig =
  AuthRuntimeConfigByMethod[SessionAuthMethod];

type DeviceSessionField =
  | 'identityId'
  | 'token'
  | 'projectId'
  | 'managedProjectId'
  | 'tier'
  | 'tierId'
  | 'accountId'
  | 'email'
  | 'organizationId'
  | 'dataCollection'
  | 'dataCollectionAllowed';
type PersistedSessionFieldLeak = {
  [M in SessionAuthMethod]: Extract<
    keyof AuthConfigByMethod[M],
    DeviceSessionField
  >;
}[SessionAuthMethod];
type PersistedOAuthClientSecretLeak = Extract<
  keyof Extract<
    PersistedOAuth2AuthConfig['oauth'],
    { grantType: 'authorization_code' | 'client_credentials' }
  >,
  'clientSecret'
>;
type AssertNever<T extends never> = T;
export type _AssertPersistedAuthContainsNoDeviceSessionState = AssertNever<
  PersistedSessionFieldLeak | PersistedOAuthClientSecretLeak
>;

/**
 * Resolved authentication credential.
 * - `expiresAt` is milliseconds since epoch.
 */
export interface AuthCredential {
  readonly value: string;
  readonly tokenType?: string;
  readonly expiresAt?: number;
  readonly authContext?: AuthContext;
}

export function toAuthTokenInfo(
  credential: AuthCredential | undefined,
): AuthTokenInfo {
  if (!credential?.value) return { kind: 'none' };
  return {
    kind: 'token',
    token: credential.value,
    tokenType: credential.tokenType,
    expiresAt: credential.expiresAt,
    authContext: credential.authContext,
  };
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
