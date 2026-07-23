import * as vscode from 'vscode';
import type { ProviderConfig } from '../types';
import type { SecretStore } from '../secret';
import type {
  AuthConfig,
  AuthRuntimeConfig,
  AuthRuntimeConfigByMethod,
  SessionAuthConfig,
  SessionAuthMethod,
} from './types';
import { t } from '../i18n';
import {
  redactAuthForExport,
  resolveAuthForExport,
} from './definitions';
import {
  isSessionAuthConfig,
  stripSessionAuthState,
} from './local-auth-state';

type SessionAuthTransferConfig = {
  [M in SessionAuthMethod]: Omit<AuthRuntimeConfigByMethod[M], 'bindingId'>;
}[SessionAuthMethod];

export type AuthTransferConfig =
  | Exclude<AuthConfig, SessionAuthConfig>
  | SessionAuthTransferConfig;

export type ProviderTransferConfig = Omit<ProviderConfig, 'auth'> & {
  auth?: AuthTransferConfig;
};

interface AuthTransferContainer {
  auth?: AuthConfig | AuthTransferConfig;
  name?: string;
  type?: string;
  baseUrl?: string;
  useRawBaseUrl?: boolean;
}

function withoutBindingId(auth: AuthRuntimeConfig): AuthTransferConfig {
  switch (auth.method) {
    case 'none':
    case 'api-key':
    case 'google-vertex-ai-auth':
      return auth;
    case 'oauth2': {
      const { bindingId: _, ...transfer } = auth;
      return transfer;
    }
    case 'antigravity-oauth': {
      const { bindingId: _, ...transfer } = auth;
      return transfer;
    }
    case 'google-gemini-oauth': {
      const { bindingId: _, ...transfer } = auth;
      return transfer;
    }
    case 'openai-codex': {
      const { bindingId: _, ...transfer } = auth;
      return transfer;
    }
    case 'claude-code': {
      const { bindingId: _, ...transfer } = auth;
      return transfer;
    }
    case 'xai-grok-oauth': {
      const { bindingId: _, ...transfer } = auth;
      return transfer;
    }
    case 'github-copilot': {
      const { bindingId: _, ...transfer } = auth;
      return transfer;
    }
    case 'zed': {
      const { bindingId: _, ...transfer } = auth;
      return transfer;
    }
  }
}

function hydrateForSensitiveTransfer(
  secretStore: SecretStore,
  config: AuthTransferContainer,
  auth: AuthConfig,
): AuthRuntimeConfig {
  if (
    !isSessionAuthConfig(auth) ||
    typeof config.name !== 'string' ||
    typeof config.type !== 'string' ||
    typeof config.baseUrl !== 'string'
  ) {
    return auth;
  }

  const descriptor = {
    providerName: config.name,
    providerType: config.type,
    baseUrl: config.baseUrl,
    useRawBaseUrl: config.useRawBaseUrl,
  };
  const snapshot = secretStore.getLocalAuthCredentialSnapshot(
    descriptor,
    auth,
  );
  if (!snapshot?.token || !snapshot.sessionId) {
    throw new Error('Missing local authentication session.');
  }

  const identityId = snapshot.sessionId;
  const token = JSON.stringify(snapshot.token);
  const context = snapshot.authContext;

  switch (auth.method) {
    case 'oauth2': {
      const oauth =
        auth.oauth.grantType === 'device_code'
          ? auth.oauth
          : { ...auth.oauth, clientSecret: snapshot.clientSecret };
      return { ...auth, identityId, token, oauth };
    }
    case 'antigravity-oauth':
      return {
        ...auth,
        identityId,
        token,
        ...(context?.method === auth.method
          ? {
              projectId: context.projectId,
              managedProjectId: context.managedProjectId,
              tier: context.tier,
              tierId: context.tierId,
              email: context.email,
            }
          : {}),
      };
    case 'google-gemini-oauth':
      return {
        ...auth,
        identityId,
        token,
        ...(context?.method === auth.method
          ? {
              projectId: context.projectId,
              managedProjectId: context.managedProjectId,
              tier: context.tier,
              tierId: context.tierId,
              email: context.email,
            }
          : {}),
      };
    case 'openai-codex':
      return {
        ...auth,
        identityId,
        token,
        ...(context?.method === auth.method
          ? { accountId: context.accountId, email: context.email }
          : {}),
      };
    case 'claude-code':
    case 'xai-grok-oauth':
      return {
        ...auth,
        identityId,
        token,
        ...(context?.method === auth.method ? { email: context.email } : {}),
      };
    case 'github-copilot':
      return { ...auth, identityId, token };
    case 'zed':
      return {
        ...auth,
        identityId,
        token,
        ...(context?.method === auth.method
          ? {
              organizationId: context.organizationId,
              dataCollection:
                context.dataCollectionAllowed && context.dataCollection,
              dataCollectionAllowed: context.dataCollectionAllowed,
              email: context.email,
            }
          : {
              dataCollection: false,
              dataCollectionAllowed: false,
            }),
      };
  }
}

function redactForTransfer(auth: AuthConfig): AuthTransferConfig {
  return withoutBindingId(
    isSessionAuthConfig(auth)
      ? stripSessionAuthState(auth)
      : redactAuthForExport(auth),
  );
}

export async function resolveAuthForExportOrShowError(
  secretStore: SecretStore,
  config: AuthTransferContainer,
  options: { includeSensitive: boolean; message?: string },
): Promise<boolean> {
  const auth = config.auth;
  if (!auth || !isPersistedAuthConfig(auth)) {
    return true;
  }

  if (!options.includeSensitive) {
    config.auth = redactForTransfer(auth);
    return true;
  }

  try {
    const hydrated = hydrateForSensitiveTransfer(secretStore, config, auth);
    const resolved = await resolveAuthForExport(hydrated, secretStore);
    config.auth = withoutBindingId(resolved);
    return true;
  } catch {
    vscode.window.showErrorMessage(
      options.message ??
        t(
          'Sensitive data is missing. Please re-authenticate before exporting.',
        ),
      { modal: true },
    );
    return false;
  }
}

export async function resolveProviderForExportOrShowError(options: {
  secretStore: SecretStore;
  provider: ProviderConfig;
  includeSensitive: boolean;
  message?: string;
}): Promise<ProviderTransferConfig | undefined> {
  const auth = options.provider.auth;
  if (!auth) {
    return { ...options.provider };
  }

  if (!options.includeSensitive) {
    return {
      ...options.provider,
      auth: redactForTransfer(auth),
    };
  }

  try {
    const hydrated = hydrateForSensitiveTransfer(
      options.secretStore,
      options.provider,
      auth,
    );
    const resolved = await resolveAuthForExport(hydrated, options.secretStore);
    return { ...options.provider, auth: withoutBindingId(resolved) };
  } catch {
    const message =
      options.message ??
      t(
        'Sensitive data is missing for provider "{0}". Please re-authenticate before exporting.',
        options.provider.name,
      );
    vscode.window.showErrorMessage(message, { modal: true });
    return undefined;
  }
}

export async function resolveProvidersForExportOrShowError(options: {
  secretStore: SecretStore;
  providers: readonly ProviderConfig[];
  includeSensitive: boolean;
  message?: string;
}): Promise<ProviderTransferConfig[] | undefined> {
  if (!options.includeSensitive) {
    return options.providers.map((p) => {
      if (!p.auth) return { ...p };
      return {
        ...p,
        auth: redactForTransfer(p.auth),
      };
    });
  }

  const resolvedProviders: ProviderTransferConfig[] = [];
  const missing: string[] = [];

  for (const provider of options.providers) {
    if (!provider.auth) {
      resolvedProviders.push({ ...provider });
      continue;
    }

    try {
      const hydrated = hydrateForSensitiveTransfer(
        options.secretStore,
        provider,
        provider.auth,
      );
      const resolvedAuth = await resolveAuthForExport(
        hydrated,
        options.secretStore,
      );
      resolvedProviders.push({
        ...provider,
        auth: withoutBindingId(resolvedAuth),
      });
    } catch {
      missing.push(provider.name);
    }
  }

  if (missing.length > 0) {
    const message =
      options.message ??
      t(
        'Sensitive data is missing for: {0}. Please re-authenticate before exporting.',
        missing.join(', '),
      );
    vscode.window.showErrorMessage(message, { modal: true });
    return undefined;
  }

  return resolvedProviders;
}

function isPersistedAuthConfig(
  auth: AuthConfig | AuthTransferConfig,
): auth is AuthConfig {
  return !isSessionAuthConfigShape(auth) || 'bindingId' in auth;
}

function isSessionAuthConfigShape(
  auth: AuthConfig | AuthTransferConfig,
): auth is SessionAuthConfig | SessionAuthTransferConfig {
  switch (auth.method) {
    case 'oauth2':
    case 'antigravity-oauth':
    case 'google-gemini-oauth':
    case 'openai-codex':
    case 'claude-code':
    case 'xai-grok-oauth':
    case 'github-copilot':
    case 'zed':
      return true;
    case 'none':
    case 'api-key':
    case 'google-vertex-ai-auth':
      return false;
  }
}
