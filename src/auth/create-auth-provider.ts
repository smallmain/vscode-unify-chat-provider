import type { AuthProvider, AuthProviderContext } from './auth-provider';
import type { AuthMethod, AuthRuntimeConfig } from './types';
import {
  isSessionAuthConfig,
  stableAuthStateStringify,
} from './local-auth-state';
import { ApiKeyAuthProvider } from './providers/api-key';
import { AntigravityOAuthProvider } from './providers/antigravity-oauth';
import { ClaudeCodeAuthProvider } from './providers/claude-code';
import { GitHubCopilotAuthProvider } from './providers/github-copilot';
import { GeminiCliOAuthProvider } from './providers/google-gemini-oauth';
import { GoogleVertexAIAuthProvider } from './providers/google-vertex-ai-auth';
import { OAuth2AuthProvider } from './providers/oauth2';
import { OpenAICodexAuthProvider } from './providers/openai-codex';
import { XaiGrokOAuthProvider } from './providers/xai-grok-build';
import { ZedAuthProvider } from './providers/zed';

function attachLocalAuthContext(
  provider: AuthProvider,
  context: AuthProviderContext,
): AuthProvider {
  const getCredential = provider.getCredential.bind(provider);
  provider.getCredential = async () => {
    const configAtStart = provider.getConfig();
    const credential = await getCredential();
    if (
      !credential ||
      !context.providerType ||
      !context.baseUrl
    ) {
      return credential;
    }
    const config = provider.getConfig();
    if (!config || !isSessionAuthConfig(config)) return credential;
    if (
      configAtStart &&
      isSessionAuthConfig(configAtStart) &&
      (configAtStart.method !== config.method ||
        configAtStart.bindingId !== config.bindingId ||
        configAtStart.identityId !== config.identityId)
    ) {
      return undefined;
    }
    const descriptor = {
      providerName: context.providerLabel,
      providerType: context.providerType,
      baseUrl: context.baseUrl,
      useRawBaseUrl: context.useRawBaseUrl,
    };
    const localSnapshot = context.secretStore.getLocalAuthCredentialSnapshot(
      descriptor,
      config,
    );
    if (localSnapshot) {
      if (
        config.method !== 'zed' &&
        localSnapshot.token?.accessToken !== credential.value
      ) {
        return undefined;
      }
      if (
        credential.authContext &&
        stableAuthStateStringify(credential.authContext) !==
          stableAuthStateStringify(localSnapshot.authContext)
      ) {
        return undefined;
      }
      return localSnapshot.authContext
        ? { ...credential, authContext: localSnapshot.authContext }
        : undefined;
    }
    if (credential.authContext) return credential;
    const authContext = context.secretStore.getAuthContextForCredential(
      descriptor,
      config,
    );
    return authContext ? { ...credential, authContext } : credential;
  };
  return provider;
}

function createProviderForConfig(
  context: AuthProviderContext,
  config: AuthRuntimeConfig,
): AuthProvider | null {
  let provider: AuthProvider | null;
  switch (config.method) {
    case 'none':
      provider = null;
      break;
    case 'api-key':
      provider = new ApiKeyAuthProvider(context, config);
      break;
    case 'oauth2':
      provider = new OAuth2AuthProvider(context, config);
      break;
    case 'google-vertex-ai-auth':
      provider = new GoogleVertexAIAuthProvider(context, config);
      break;
    case 'antigravity-oauth':
      provider = new AntigravityOAuthProvider(context, config);
      break;
    case 'google-gemini-oauth':
      provider = new GeminiCliOAuthProvider(context, config);
      break;
    case 'openai-codex':
      provider = new OpenAICodexAuthProvider(context, config);
      break;
    case 'xai-grok-oauth':
      provider = new XaiGrokOAuthProvider(context, config);
      break;
    case 'claude-code':
      provider = new ClaudeCodeAuthProvider(context, config);
      break;
    case 'github-copilot':
      provider = new GitHubCopilotAuthProvider(context, config);
      break;
    case 'zed':
      provider = new ZedAuthProvider(context, config);
      break;
  }
  return provider ? attachLocalAuthContext(provider, context) : null;
}

export function createAuthProvider(
  context: AuthProviderContext,
  config: AuthRuntimeConfig,
): AuthProvider | null {
  const runtimeConfig =
    isSessionAuthConfig(config) && context.providerType && context.baseUrl
      ? context.secretStore.hydrateSessionAuth(
          {
            providerName: context.providerLabel,
            providerType: context.providerType,
            baseUrl: context.baseUrl,
            useRawBaseUrl: context.useRawBaseUrl,
          },
          config,
        )
      : config;

  return createProviderForConfig(context, runtimeConfig);
}

export function createAuthProviderForMethod(
  context: AuthProviderContext,
  method: AuthMethod,
  config?: AuthRuntimeConfig,
): AuthProvider | null {
  if (config?.method === method) {
    return createAuthProvider(context, config);
  }

  let provider: AuthProvider | null;
  switch (method) {
    case 'none':
      provider = null;
      break;
    case 'api-key':
      provider = new ApiKeyAuthProvider(context);
      break;
    case 'oauth2':
      provider = new OAuth2AuthProvider(context);
      break;
    case 'google-vertex-ai-auth':
      provider = new GoogleVertexAIAuthProvider(context);
      break;
    case 'antigravity-oauth':
      provider = new AntigravityOAuthProvider(context);
      break;
    case 'google-gemini-oauth':
      provider = new GeminiCliOAuthProvider(context);
      break;
    case 'openai-codex':
      provider = new OpenAICodexAuthProvider(context);
      break;
    case 'xai-grok-oauth':
      provider = new XaiGrokOAuthProvider(context);
      break;
    case 'claude-code':
      provider = new ClaudeCodeAuthProvider(context);
      break;
    case 'github-copilot':
      provider = new GitHubCopilotAuthProvider(context);
      break;
    case 'zed':
      provider = new ZedAuthProvider(context);
      break;
  }
  return provider ? attachLocalAuthContext(provider, context) : null;
}
