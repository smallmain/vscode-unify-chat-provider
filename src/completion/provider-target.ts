import { computeProviderAuthTargetSignature } from '../auth/provider-source-guard';
import { stableAuthStateStringify } from '../auth/local-auth-state';
import type { ProviderConfig } from '../types';

export function computeCompletionRequestTargetSignature(
  provider: ProviderConfig,
  options: {
    modelId?: string;
    requestTarget?: string;
    includeCompletionBaseUrls?: boolean;
  } = {},
): string {
  const model = options.modelId
    ? provider.models.find((candidate) => candidate.id === options.modelId)
    : undefined;
  const includeCompletionBaseUrls =
    options.includeCompletionBaseUrls !== false;
  return stableAuthStateStringify({
    authTarget: computeProviderAuthTargetSignature(provider),
    ...(includeCompletionBaseUrls
      ? {
          providerCompletionBaseUrl: provider.completion?.baseUrl,
          modelCompletionBaseUrl: model?.completion?.baseUrl,
        }
      : {}),
    requestTarget: options.requestTarget,
  });
}
