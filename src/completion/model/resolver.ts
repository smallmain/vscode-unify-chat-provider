import * as vscode from 'vscode';
import type { AuthCredential, AuthTokenInfo } from '../../auth/types';
import {
  stableStringify,
  toComparableProviderConfig,
} from '../../config-ops';
import { parseVsCodeModelId } from '../../model-id-utils';
import { t } from '../../i18n';
import type { ModelConfig, ProviderConfig } from '../../types';
import { getAllModelsForProviderSync } from '../../utils';
import { createCompatibleApiProvider } from '../api/compatible-provider';
import type {
  CompletionApiProvider,
} from '../api/provider';
import { nativeCompletionApiProviderRegistry } from '../api/registry';
import type {
  CompletionModel,
  CompletionModelCapabilities,
  CompletionModelEligibility,
  CompletionModelReference,
  CompletionModelResolver,
} from '../types';
import { INTERNAL_COMPLETION_VENDOR } from '../types';
import {
  normalizeCompletionConfig,
  resolveCompletionConfig,
  resolveExternalCompletionConfig,
  type CompletionConfigNormalizationResult,
  type CompletionConfigIssue,
  type ResolvedCompletionConfig,
} from './configuration';
import { ConfiguredCompletionModel } from './completion-model';
import { CompletionConfigurationError } from './errors';
import type { AlgorithmRequestKind } from './requests';

export { INTERNAL_COMPLETION_VENDOR } from '../types';

interface CompletionCredentialManager {
  getCredential(
    providerName: string,
    reason: 'background',
  ): Promise<AuthCredential | undefined>;
  retryRefresh?(providerName: string): Promise<boolean>;
}

interface CompletionConfigStore {
  getProvider(name: string): ProviderConfig | undefined;
  getProviderCompletionConfigState(
    name: string,
  ): CompletionConfigNormalizationResult;
  getModelCompletionConfigState(
    providerName: string,
    modelId: string,
  ): CompletionConfigNormalizationResult;
}

type CompletionProviderModelCatalog = (
  provider: ProviderConfig,
) => readonly ModelConfig[];

function toAuthTokenInfo(
  credential:
    | { value: string; tokenType?: string; expiresAt?: number }
    | undefined,
): AuthTokenInfo {
  return credential?.value
    ? {
        kind: 'token',
        token: credential.value,
        tokenType: credential.tokenType,
        expiresAt: credential.expiresAt,
      }
    : { kind: 'none' };
}

function configurationError(
  scope: 'provider' | 'model',
  issues: readonly CompletionConfigIssue[],
): CompletionConfigurationError {
  const detail = issues.map(localizeCompletionConfigIssue).join(' ');
  return new CompletionConfigurationError(
    'completion-invalid-config',
    scope === 'provider'
      ? t('Invalid provider completion configuration: {0}', detail)
      : t('Invalid model completion configuration: {0}', detail),
  );
}

function localizeCompletionConfigIssue(issue: CompletionConfigIssue): string {
  switch (issue.code) {
    case 'completion-not-object':
      return t('Completion configuration must be an object.');
    case 'completion-unknown-field':
      return t(
        'Unknown completion configuration field "{0}".',
        issue.field ?? '',
      );
    case 'completion-invalid-transport':
      return t('Completion transport must be auto, native, or compatible.');
    case 'completion-invalid-base-url':
      return t('Completion baseUrl must be a string.');
    case 'completion-invalid-templates':
      return t(
        'Completion templates must be "all" or an array of registered template IDs.',
      );
  }
}

function modelProperty(model: vscode.LanguageModelChat, key: string): unknown {
  return Reflect.get(model, key);
}

function nestedModelProperty(
  model: vscode.LanguageModelChat,
  containerKey: string,
  key: string,
): unknown {
  const container = modelProperty(model, containerKey);
  return typeof container === 'object' && container !== null
    ? Reflect.get(container, key)
    : undefined;
}

function resolveModelCapabilities(
  model: vscode.LanguageModelChat,
  configuredProviderType?: ProviderConfig['type'],
): CompletionModelCapabilities {
  const cursorCapability =
    modelProperty(model, 'supportsNextCursorLinePrediction') ??
    nestedModelProperty(
      model,
      'capabilities',
      'supportsNextCursorLinePrediction',
    );
  const responsesCapability =
    modelProperty(model, 'usesResponsesApi') ??
    nestedModelProperty(model, 'capabilities', 'usesResponsesApi');
  const usesResponsesApi =
    configuredProviderType === 'openai-responses' ||
    (typeof responsesCapability === 'boolean'
      ? responsesCapability
      : modelProperty(model, 'apiType') === 'responses' ||
        nestedModelProperty(model, 'capabilities', 'apiType') === 'responses');
  return {
    supportsNextCursorLinePrediction: cursorCapability !== false,
    ...(usesResponsesApi ? { minimumCursorPredictionTokens: 2_048 } : {}),
  };
}

export class ConfiguredCompletionModelResolver
  implements CompletionModelResolver
{
  constructor(
    private readonly configStore: CompletionConfigStore,
    private readonly authManager: CompletionCredentialManager,
    private readonly getProviderModels: CompletionProviderModelCatalog =
      getAllModelsForProviderSync,
    private readonly canUseSystemMessage = true,
  ) {}

  getConfigurationFingerprint(reference: CompletionModelReference): string {
    if (reference.vendor !== INTERNAL_COMPLETION_VENDOR) {
      return stableStringify({ kind: 'external', reference });
    }
    const modelId = parseVsCodeModelId(reference.id);
    const provider = modelId
      ? this.configStore.getProvider(modelId.providerName)
      : undefined;
    const model =
      provider && modelId
        ? this.findProviderModel(provider, modelId.modelName)
        : undefined;
    return stableStringify({
      kind: 'internal',
      reference,
      provider: provider
        ? toComparableProviderConfig({
            ...provider,
            models: model ? [model] : [],
          })
        : undefined,
      providerCompletion: modelId
        ? this.configStore.getProviderCompletionConfigState(
            modelId.providerName,
          )
        : undefined,
      modelCompletion: modelId
        ? provider && model
          ? this.resolveModelCompletionConfigState(provider, model)
          : this.configStore.getModelCompletionConfigState(
              modelId.providerName,
              modelId.modelName,
            )
        : undefined,
    });
  }

  async resolveCompletionModel(
    reference: CompletionModelReference,
    _token: vscode.CancellationToken,
  ): Promise<CompletionModel> {
    return reference.vendor === INTERNAL_COMPLETION_VENDOR
      ? this.resolveInternalModel(reference)
      : this.resolveExternalModel(reference);
  }

  async evaluateModelForRequest(
    reference: CompletionModelReference,
    sourceKind: AlgorithmRequestKind,
  ): Promise<CompletionModelEligibility> {
    try {
      const model =
        reference.vendor === INTERNAL_COMPLETION_VENDOR
          ? await this.resolveInternalModel(reference)
          : await this.resolveExternalModel(reference);
      return await model.evaluate(sourceKind);
    } catch (error) {
      if (error instanceof CompletionConfigurationError) {
        return {
          eligible: false,
          code: error.code,
          message: error.message,
        };
      }
      return {
        eligible: false,
        code: 'completion-model-not-found',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private resolveInternalModel(
    reference: CompletionModelReference,
  ): ConfiguredCompletionModel {
    const modelId = parseVsCodeModelId(reference.id);
    if (!modelId) {
      throw new CompletionConfigurationError(
        'completion-invalid-model-reference',
        t('Invalid internal completion model ID "{0}".', reference.id),
      );
    }
    const provider = this.configStore.getProvider(modelId.providerName);
    if (!provider) {
      throw new CompletionConfigurationError(
        'completion-provider-not-found',
        t(
          'Completion model provider "{0}" was not found.',
          modelId.providerName,
        ),
      );
    }
    const model = this.findProviderModel(provider, modelId.modelName);
    if (!model) {
      throw new CompletionConfigurationError(
        'completion-model-not-found',
        t('Completion model "{0}" was not found.', reference.id),
      );
    }

    const providerCompletion =
      this.configStore.getProviderCompletionConfigState(provider.name);
    const modelCompletion = this.resolveModelCompletionConfigState(
      provider,
      model,
    );
    const resolved = resolveCompletionConfig(
      providerCompletion,
      modelCompletion,
    );
    if (resolved.status === 'invalid') {
      throw configurationError(resolved.scope, resolved.issues);
    }

    return this.createModel(
      reference,
      resolved.value,
      nativeCompletionApiProviderRegistry.create({
        provider,
        model,
        completion: resolved.value,
        resolveCredential: async () => {
          const credential =
            !provider.auth || provider.auth.method === 'none'
              ? undefined
              : await this.authManager.getCredential(
                  provider.name,
                  'background',
                );
          return toAuthTokenInfo(credential);
        },
        resolveProvider: () =>
          this.configStore.getProvider(provider.name) ?? provider,
        ...(this.authManager.retryRefresh
          ? {
              refreshCredential: async () => {
                const refreshed = await this.authManager.retryRefresh?.(
                  provider.name,
                );
                if (!refreshed) return { kind: 'none' as const };
                return toAuthTokenInfo(
                  await this.authManager.getCredential(
                    provider.name,
                    'background',
                  ),
                );
              },
            }
          : {}),
      }),
      undefined,
      provider.type,
    );
  }

  private findProviderModel(
    provider: ProviderConfig,
    modelId: string,
  ): ModelConfig | undefined {
    return this.getProviderModels(provider).find(
      (candidate) => candidate.id === modelId,
    );
  }

  private resolveModelCompletionConfigState(
    provider: ProviderConfig,
    model: ModelConfig,
  ): CompletionConfigNormalizationResult {
    const isUserModel = provider.models.some(
      (candidate) => candidate.id === model.id,
    );
    return isUserModel
      ? this.configStore.getModelCompletionConfigState(provider.name, model.id)
      : normalizeCompletionConfig(model.completion);
  }

  private async resolveExternalModel(
    reference: CompletionModelReference,
  ): Promise<ConfiguredCompletionModel> {
    const chatModel = await this.resolveCompatibleChatModel(reference);
    return this.createModel(
      reference,
      resolveExternalCompletionConfig(),
      undefined,
      chatModel,
    );
  }

  private createModel(
    reference: CompletionModelReference,
    completion: ResolvedCompletionConfig,
    native: CompletionApiProvider | undefined,
    initialChatModel?: vscode.LanguageModelChat,
    configuredProviderType?: ProviderConfig['type'],
  ): ConfiguredCompletionModel {
    let chatModelPromise:
      | Promise<vscode.LanguageModelChat>
      | undefined = initialChatModel
      ? Promise.resolve(initialChatModel)
      : undefined;
    let compatiblePromise: Promise<CompletionApiProvider> | undefined;
    const resolveChatModel = (): Promise<vscode.LanguageModelChat> => {
      chatModelPromise ??= this.resolveCompatibleChatModel(reference);
      return chatModelPromise;
    };
    return new ConfiguredCompletionModel({
      completion,
      ...(native === undefined ? {} : { native }),
      resolveCompatible: () => {
        compatiblePromise ??= resolveChatModel().then((model) =>
          createCompatibleApiProvider(model, {
            model: `${reference.vendor}/${reference.id}`,
            canUseSystemMessage: this.canUseSystemMessage,
          }),
        );
        return compatiblePromise;
      },
      resolveCapabilities: async () =>
        resolveModelCapabilities(
          await resolveChatModel(),
          configuredProviderType,
        ),
    });
  }

  private async resolveCompatibleChatModel(
    reference: CompletionModelReference,
  ): Promise<vscode.LanguageModelChat> {
    const models = await vscode.lm.selectChatModels({
      vendor: reference.vendor,
      id: reference.id,
    });
    const model = models.find(
      (candidate) =>
        candidate.vendor === reference.vendor && candidate.id === reference.id,
    );
    if (!model) {
      throw new CompletionConfigurationError(
        'completion-model-not-found',
        t(
          'Completion model "{0}/{1}" was not found.',
          reference.vendor,
          reference.id,
        ),
      );
    }
    return model;
  }
}
