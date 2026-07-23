import { t } from '../i18n';
import { SecretStore } from '../secret';
import { ApiKeyAuthProvider } from './providers/api-key';
import { AntigravityOAuthProvider } from './providers/antigravity-oauth';
import { GeminiCliOAuthProvider } from './providers/google-gemini-oauth';
import { GitHubCopilotAuthProvider } from './providers/github-copilot';
import { GoogleVertexAIAuthProvider } from './providers/google-vertex-ai-auth';
import { ClaudeCodeAuthProvider } from './providers/claude-code';
import { OpenAICodexAuthProvider } from './providers/openai-codex';
import { XaiGrokOAuthProvider } from './providers/xai-grok-build';
import { OAuth2AuthProvider } from './providers/oauth2';
import { ZedAuthProvider } from './providers/zed';
import { AuthMethod, AuthRuntimeConfig } from './types';

export interface AuthProviderBindingContext {
  readonly providerType?: string;
  readonly baseUrl?: string;
  readonly previousProviderType?: string;
  readonly previousBaseUrl?: string;
  readonly previousAuth?: AuthRuntimeConfig;
}

export type AuthMethodDefinition = {
  id: string;
  label: string;
  description?: string;
  /**
   * Category label used for grouping in UI (QuickPick separators).
   * Stored as an i18n key (passed through `t()` by the UI).
   */
  category: string;
};

export interface AuthImportOptions {
  secretStore: SecretStore;
  storeSecretsInSettings: boolean;
  existing?: AuthRuntimeConfig;
}

export interface AuthDuplicateOptions {
  secretStore: SecretStore;
  storeSecretsInSettings: boolean;
}

export const AUTH_METHODS = {
  'api-key': {
    id: 'api-key',
    label: t('API Key'),
    description: t('Authenticate using an API key'),
    category: 'General',
  },
  oauth2: {
    id: 'oauth2',
    label: t('OAuth 2.0'),
    description: t('Authenticate using OAuth 2.0'),
    category: 'General',
  },
  'google-vertex-ai-auth': {
    id: 'google-vertex-ai-auth',
    label: t('Google Vertex AI'),
    description: t('Authenticate with Google Vertex AI'),
    category: 'Dedicated',
  },
  'antigravity-oauth': {
    id: 'antigravity-oauth',
    label: t('Google Antigravity'),
    description: t('Authenticate using Google OAuth (Antigravity)'),
    category: 'Experimental',
  },
  'google-gemini-oauth': {
    id: 'google-gemini-oauth',
    label: t('Google Gemini CLI'),
    description: t('Authenticate using Google OAuth (Gemini CLI)'),
    category: 'Experimental',
  },
  'openai-codex': {
    id: 'openai-codex',
    label: t('OpenAI Codex'),
    description: t('Authenticate using OpenAI Codex OAuth (ChatGPT Plus/Pro)'),
    category: 'Experimental',
  },
  'xai-grok-oauth': {
    id: 'xai-grok-oauth',
    label: t('xAI Grok'),
    description: t(
      'Authenticate using xAI Grok OAuth (SuperGrok / X Premium+)',
    ),
    category: 'Experimental',
  },
  'claude-code': {
    id: 'claude-code',
    label: t('Claude Code'),
    description: t('Authenticate using Claude Code OAuth'),
    category: 'Experimental',
  },
  'github-copilot': {
    id: 'github-copilot',
    label: t('GitHub Copilot'),
    description: t('Authenticate using GitHub device code flow'),
    category: 'Experimental',
  },
  zed: {
    id: 'zed',
    label: 'Zed',
    description: 'Sign in with a Zed account',
    category: 'Experimental',
  },
} as const satisfies Record<string, AuthMethodDefinition>;

export function getAuthMethodDefinition<M extends keyof typeof AUTH_METHODS>(
  method: M | 'none',
): (typeof AUTH_METHODS)[M] | undefined {
  return method === 'none' ? undefined : AUTH_METHODS[method];
}

export function normalizeAuthForProvider(
  auth: AuthRuntimeConfig | undefined,
  context: AuthProviderBindingContext,
  method: AuthMethod = auth?.method ?? 'none',
): AuthRuntimeConfig | undefined {
  if (method === 'none') {
    return auth?.method === 'none' ? auth : undefined;
  }

  const matchingAuth = auth?.method === method ? auth : undefined;
  if (method === 'zed') {
    return ZedAuthProvider.normalizeForProvider(
      matchingAuth?.method === 'zed' ? matchingAuth : undefined,
      context,
    );
  }
  return matchingAuth;
}

/** Whether a method may intentionally persist its sensitive data in settings. */
export function supportsSensitiveAuthInSettings(
  auth: AuthRuntimeConfig,
): boolean {
  switch (auth.method) {
    case 'none':
      return false;
    case 'api-key':
      return ApiKeyAuthProvider.supportsSensitiveDataInSettings(auth);
    case 'oauth2':
      return OAuth2AuthProvider.supportsSensitiveDataInSettings(auth);
    case 'google-vertex-ai-auth':
      return GoogleVertexAIAuthProvider.supportsSensitiveDataInSettings(auth);
    case 'antigravity-oauth':
      return AntigravityOAuthProvider.supportsSensitiveDataInSettings(auth);
    case 'google-gemini-oauth':
      return GeminiCliOAuthProvider.supportsSensitiveDataInSettings(auth);
    case 'openai-codex':
      return OpenAICodexAuthProvider.supportsSensitiveDataInSettings(auth);
    case 'xai-grok-oauth':
      return XaiGrokOAuthProvider.supportsSensitiveDataInSettings(auth);
    case 'claude-code':
      return ClaudeCodeAuthProvider.supportsSensitiveDataInSettings(auth);
    case 'github-copilot':
      return GitHubCopilotAuthProvider.supportsSensitiveDataInSettings(auth);
    case 'zed':
      return ZedAuthProvider.supportsSensitiveDataInSettings(auth);
  }
}

export function redactAuthForExport(
  auth: AuthRuntimeConfig,
): AuthRuntimeConfig {
  switch (auth.method) {
    case 'none':
      return auth;
    case 'api-key':
      return ApiKeyAuthProvider.redactForExport(auth);
    case 'oauth2':
      return OAuth2AuthProvider.redactForExport(auth);
    case 'google-vertex-ai-auth':
      return GoogleVertexAIAuthProvider.redactForExport(auth);
    case 'antigravity-oauth':
      return AntigravityOAuthProvider.redactForExport(auth);
    case 'google-gemini-oauth':
      return GeminiCliOAuthProvider.redactForExport(auth);
    case 'openai-codex':
      return OpenAICodexAuthProvider.redactForExport(auth);
    case 'xai-grok-oauth':
      return XaiGrokOAuthProvider.redactForExport(auth);
    case 'claude-code':
      return ClaudeCodeAuthProvider.redactForExport(auth);
    case 'github-copilot':
      return GitHubCopilotAuthProvider.redactForExport(auth);
    case 'zed':
      return ZedAuthProvider.redactForExport(auth);
  }
}

export async function resolveAuthForExport(
  auth: AuthRuntimeConfig,
  secretStore: SecretStore,
): Promise<AuthRuntimeConfig> {
  switch (auth.method) {
    case 'none':
      return auth;
    case 'api-key':
      return ApiKeyAuthProvider.resolveForExport(auth, secretStore);
    case 'oauth2':
      return OAuth2AuthProvider.resolveForExport(auth, secretStore);
    case 'google-vertex-ai-auth':
      return GoogleVertexAIAuthProvider.resolveForExport(auth, secretStore);
    case 'antigravity-oauth':
      return AntigravityOAuthProvider.resolveForExport(auth, secretStore);
    case 'google-gemini-oauth':
      return GeminiCliOAuthProvider.resolveForExport(auth, secretStore);
    case 'openai-codex':
      return OpenAICodexAuthProvider.resolveForExport(auth, secretStore);
    case 'xai-grok-oauth':
      return XaiGrokOAuthProvider.resolveForExport(auth, secretStore);
    case 'claude-code':
      return ClaudeCodeAuthProvider.resolveForExport(auth, secretStore);
    case 'github-copilot':
      return GitHubCopilotAuthProvider.resolveForExport(auth, secretStore);
    case 'zed':
      return ZedAuthProvider.resolveForExport(auth, secretStore);
  }
}

export async function normalizeAuthOnImport(
  auth: AuthRuntimeConfig,
  options: AuthImportOptions,
): Promise<AuthRuntimeConfig> {
  switch (auth.method) {
    case 'none':
      return auth;
    case 'api-key':
      return ApiKeyAuthProvider.normalizeOnImport(auth, {
        ...options,
        existing: options.existing?.method === auth.method ? options.existing : undefined,
      });
    case 'oauth2':
      return OAuth2AuthProvider.normalizeOnImport(auth, {
        ...options,
        existing: options.existing?.method === auth.method ? options.existing : undefined,
      });
    case 'google-vertex-ai-auth':
      return GoogleVertexAIAuthProvider.normalizeOnImport(auth, {
        ...options,
        existing: options.existing?.method === auth.method ? options.existing : undefined,
      });
    case 'antigravity-oauth':
      return AntigravityOAuthProvider.normalizeOnImport(auth, {
        ...options,
        existing: options.existing?.method === auth.method ? options.existing : undefined,
      });
    case 'google-gemini-oauth':
      return GeminiCliOAuthProvider.normalizeOnImport(auth, {
        ...options,
        existing: options.existing?.method === auth.method ? options.existing : undefined,
      });
    case 'openai-codex':
      return OpenAICodexAuthProvider.normalizeOnImport(auth, {
        ...options,
        existing: options.existing?.method === auth.method ? options.existing : undefined,
      });
    case 'xai-grok-oauth':
      return XaiGrokOAuthProvider.normalizeOnImport(auth, {
        ...options,
        existing: options.existing?.method === auth.method ? options.existing : undefined,
      });
    case 'claude-code':
      return ClaudeCodeAuthProvider.normalizeOnImport(auth, {
        ...options,
        existing: options.existing?.method === auth.method ? options.existing : undefined,
      });
    case 'github-copilot':
      return GitHubCopilotAuthProvider.normalizeOnImport(auth, {
        ...options,
        existing: options.existing?.method === auth.method ? options.existing : undefined,
      });
    case 'zed':
      return ZedAuthProvider.normalizeOnImport(auth, {
        ...options,
        existing: options.existing?.method === auth.method ? options.existing : undefined,
      });
  }
}

export async function prepareAuthForDuplicate(
  auth: AuthRuntimeConfig,
  options: AuthDuplicateOptions,
): Promise<AuthRuntimeConfig> {
  switch (auth.method) {
    case 'none':
      return auth;
    case 'api-key':
      return ApiKeyAuthProvider.prepareForDuplicate(auth, options);
    case 'oauth2':
      return OAuth2AuthProvider.prepareForDuplicate(auth, options);
    case 'google-vertex-ai-auth':
      return GoogleVertexAIAuthProvider.prepareForDuplicate(auth, options);
    case 'antigravity-oauth':
      return AntigravityOAuthProvider.prepareForDuplicate(auth, options);
    case 'google-gemini-oauth':
      return GeminiCliOAuthProvider.prepareForDuplicate(auth, options);
    case 'openai-codex':
      return OpenAICodexAuthProvider.prepareForDuplicate(auth, options);
    case 'xai-grok-oauth':
      return XaiGrokOAuthProvider.prepareForDuplicate(auth, options);
    case 'claude-code':
      return ClaudeCodeAuthProvider.prepareForDuplicate(auth, options);
    case 'github-copilot':
      return GitHubCopilotAuthProvider.prepareForDuplicate(auth, options);
    case 'zed':
      return ZedAuthProvider.prepareForDuplicate(auth, options);
  }
}

export async function cleanupDiscardedAuth(
  auth: AuthRuntimeConfig,
  secretStore: SecretStore,
): Promise<void> {
  switch (auth.method) {
    case 'none':
    case 'api-key':
    case 'oauth2':
      return;
    case 'google-vertex-ai-auth':
      return GoogleVertexAIAuthProvider.cleanupOnDiscard(auth, secretStore);
    case 'antigravity-oauth':
      return AntigravityOAuthProvider.cleanupOnDiscard(auth, secretStore);
    case 'google-gemini-oauth':
      return GeminiCliOAuthProvider.cleanupOnDiscard(auth, secretStore);
    case 'openai-codex':
      return OpenAICodexAuthProvider.cleanupOnDiscard(auth, secretStore);
    case 'xai-grok-oauth':
      return XaiGrokOAuthProvider.cleanupOnDiscard(auth, secretStore);
    case 'claude-code':
      return ClaudeCodeAuthProvider.cleanupOnDiscard(auth, secretStore);
    case 'github-copilot':
      return GitHubCopilotAuthProvider.cleanupOnDiscard(auth, secretStore);
    case 'zed':
      return ZedAuthProvider.cleanupOnDiscard(auth, secretStore);
  }
}
