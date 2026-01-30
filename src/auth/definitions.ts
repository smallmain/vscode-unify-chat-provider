import { t } from '../i18n';
import { SecretStore } from '../secret';
import type { AuthProvider, AuthProviderContext } from './auth-provider';
import { ApiKeyAuthProvider } from './providers/api-key';
import { IFlowCliAuthProvider } from './providers/iflow-cli';
import { AntigravityOAuthProvider } from './providers/antigravity-oauth';
import { GeminiCliOAuthProvider } from './providers/google-gemini-oauth';
import { GitHubCopilotAuthProvider } from './providers/github-copilot';
import { GoogleVertexAIAuthProvider } from './providers/google-vertex-ai-auth';
import { ClaudeCodeAuthProvider } from './providers/claude-code';
import { OpenAICodexAuthProvider } from './providers/openai-codex';
import { QwenCodeAuthProvider } from './providers/qwen-code';
import { OAuth2AuthProvider } from './providers/oauth2';
import { AuthConfig } from './types';

export type AuthMethodDefinition = {
  id: string;
  label: string;
  description?: string;
  /**
   * Category label used for grouping in UI (QuickPick separators).
   * Stored as an i18n key (passed through `t()` by the UI).
   */
  category: string;
  ctor: (new (context: AuthProviderContext, config?: any) => AuthProvider) &
    AuthProviderStatics<any>;
};

export type AuthProviderStatics<TAuth extends AuthConfig> = {
  /**
   * Whether this auth method supports storing its sensitive data in `settings.json`
   * when the user enables `unifyChatProvider.storeApiKeyInSettings`.
   *
   * This must be `false` for OAuth-based credentials to avoid multi-device token
   * refresh conflicts via Settings Sync.
   */
  supportsSensitiveDataInSettings: (auth: TAuth) => boolean;
  redactForExport: (auth: TAuth) => TAuth;
  resolveForExport: (auth: TAuth, secretStore: SecretStore) => Promise<TAuth>;
  normalizeOnImport: (
    auth: TAuth,
    options: {
      secretStore: SecretStore;
      storeSecretsInSettings: boolean;
      existing?: TAuth;
    },
  ) => Promise<TAuth>;
  prepareForDuplicate: (
    auth: TAuth,
    options: { secretStore: SecretStore; storeSecretsInSettings: boolean },
  ) => Promise<TAuth>;
  cleanupOnDiscard?: (auth: TAuth, secretStore: SecretStore) => Promise<void>;
};

export const AUTH_METHODS = {
  'api-key': {
    id: 'api-key',
    label: t('API Key'),
    description: t('Authenticate using an API key'),
    category: 'General',
    ctor: ApiKeyAuthProvider,
  },
  oauth2: {
    id: 'oauth2',
    label: t('OAuth 2.0'),
    description: t('Authenticate using OAuth 2.0'),
    category: 'General',
    ctor: OAuth2AuthProvider,
  },
  'google-vertex-ai-auth': {
    id: 'google-vertex-ai-auth',
    label: t('Google Vertex AI'),
    description: t('Authenticate with Google Vertex AI'),
    category: 'Dedicated',
    ctor: GoogleVertexAIAuthProvider,
  },
  'iflow-cli': {
    id: 'iflow-cli',
    label: t('iFlow CLI'),
    description: t('Authenticate using iFlow OAuth (CLI)'),
    category: 'Experimental',
    ctor: IFlowCliAuthProvider,
  },
  'antigravity-oauth': {
    id: 'antigravity-oauth',
    label: t('Google (Antigravity)'),
    description: t('Authenticate using Google OAuth (Antigravity)'),
    category: 'Experimental',
    ctor: AntigravityOAuthProvider,
  },
  'google-gemini-oauth': {
    id: 'google-gemini-oauth',
    label: t('Google Gemini CLI'),
    description: t('Authenticate using Google OAuth (Gemini CLI)'),
    category: 'Experimental',
    ctor: GeminiCliOAuthProvider,
  },
  'openai-codex': {
    id: 'openai-codex',
    label: t('OpenAI CodeX'),
    description: t('Authenticate using OpenAI CodeX OAuth (ChatGPT Plus/Pro)'),
    category: 'Experimental',
    ctor: OpenAICodexAuthProvider,
  },
  'claude-code': {
    id: 'claude-code',
    label: t('Claude Code'),
    description: t('Authenticate using Claude Code OAuth'),
    category: 'Experimental',
    ctor: ClaudeCodeAuthProvider,
  },
  'qwen-code': {
    id: 'qwen-code',
    label: t('Qwen Code'),
    description: t('Authenticate using Qwen Code device authorization flow'),
    category: 'Experimental',
    ctor: QwenCodeAuthProvider,
  },
  'github-copilot': {
    id: 'github-copilot',
    label: t('GitHub Copilot'),
    description: t('Authenticate using GitHub device code flow'),
    category: 'Experimental',
    ctor: GitHubCopilotAuthProvider,
  },
} as const satisfies Record<string, AuthMethodDefinition>;

export function getAuthMethodDefinition<M extends keyof typeof AUTH_METHODS>(
  method: M | 'none',
): (typeof AUTH_METHODS)[M] | undefined {
  return method === 'none' ? undefined : AUTH_METHODS[method];
}

export function getAuthMethodCtor<M extends keyof typeof AUTH_METHODS>(
  method: M | 'none',
):
  | ((new (context: AuthProviderContext, config?: any) => AuthProvider) &
      AuthProviderStatics<any>)
  | undefined {
  return method === 'none' ? undefined : AUTH_METHODS[method].ctor;
}
