import * as vscode from 'vscode';
import { ConfigStore } from './config-store';
import {
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_PROVIDER_TYPE,
} from './defaults';
import { ApiProvider } from './client/interface';
import { createRequestLogger } from './logger';
import { ModelConfig, PerformanceTrace, ProviderConfig } from './types';
import { getBaseModelId } from './model-id-utils';
import { createProvider } from './client/utils';
import { formatModelDetail } from './ui/form-utils';
import {
  getAllModelsForProvider,
  getAllModelsForProviderSync,
  isAbortError,
  isPlaceholderModelId,
} from './utils';
import { SecretStore } from './secret';
import { AuthManager } from './auth';
import type { AuthCredential, AuthTokenInfo } from './auth/types';
import { t } from './i18n';
import { runUiStack } from './ui/router/stack-router';
import type { UiContext } from './ui/router/types';
import { ApiType } from './client/definitions';

export class UnifyChatService implements vscode.LanguageModelChatProvider {
  private readonly clients = new Map<string, ApiProvider>();
  private readonly onDidChangeModelInfoEmitter =
    new vscode.EventEmitter<void>();

  readonly onDidChangeLanguageModelChatInformation =
    this.onDidChangeModelInfoEmitter.event;

  constructor(
    private readonly configStore: ConfigStore,
    private readonly secretStore: SecretStore,
    private readonly authManager?: AuthManager,
  ) {}

  /**
   * Get the actual API type for a model.
   * Model-level type takes precedence over provider-level type.
   * If neither is specified, returns the default API type.
   */
  private getActualApiType(
    provider: ProviderConfig,
    model: ModelConfig,
  ): ApiType {
    const modelApiType = model.type;
    const providerApiType = provider.type;
    return modelApiType ?? providerApiType ?? DEFAULT_PROVIDER_TYPE;
  }

  /**
   * Provide information about available models (synchronous, non-blocking)
   */
  async provideLanguageModelChatInformation(
    options: { silent: boolean },
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    // Check if user has configured any providers with models or auto-fetch enabled
    const hasConfiguredProviders = this.configStore.endpoints.some(
      (provider) =>
        provider.models.length > 0 || provider.autoFetchOfficialModels,
    );

    // If no providers configured and not silent, prompt user to add a provider
    if (!hasConfiguredProviders && !options.silent) {
      vscode.commands.executeCommand('unifyChatProvider.manageProviders');
    }

    // Build model list synchronously
    const models: vscode.LanguageModelChatInformation[] = [];

    for (const provider of this.configStore.endpoints) {
      const allModels = getAllModelsForProviderSync(provider);

      for (const model of allModels) {
        models.push(this.createModelInfo(provider, model));
      }
    }

    return models;
  }

  /**
   * Create model information object
   */
  private createModelInfo(
    provider: ProviderConfig,
    model: ModelConfig,
  ): vscode.LanguageModelChatInformation {
    const modelId = this.createModelId(provider.name, model.id);

    return {
      id: modelId,
      name: model.name ?? model.id,
      family: model.family ?? getBaseModelId(model.id),
      version: '1.0.0',
      maxInputTokens: model.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS,
      maxOutputTokens: model.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      capabilities: {
        toolCalling: model.capabilities?.toolCalling ?? false,
        imageInput: model.capabilities?.imageInput ?? false,
      },
      category: {
        label: provider.name,
        order: 2,
      },
      detail: provider.name,
      tooltip: formatModelDetail(model),
      isUserSelectable: true,
    };
  }

  /**
   * Create a unique model ID combining provider and model names
   */
  private createModelId(providerName: string, modelId: string): string {
    return `${this.encodeProviderName(providerName)}/${modelId}`;
  }

  /**
   * Parse model ID to extract provider and model names
   */
  private parseModelId(
    modelId: string,
  ): { providerName: string; modelName: string } | null {
    const slashIndex = modelId.indexOf('/');
    if (slashIndex === -1) {
      return null;
    }
    return {
      providerName: modelId.slice(0, slashIndex),
      modelName: modelId.slice(slashIndex + 1),
    };
  }

  /**
   * Encode provider name for use in model ID (reversible via decodeURIComponent)
   */
  private encodeProviderName(name: string): string {
    return encodeURIComponent(name);
  }

  private decodeProviderName(encodedName: string): string | null {
    try {
      return decodeURIComponent(encodedName);
    } catch {
      return null;
    }
  }

  /**
   * Find provider and model configuration by model ID
   */
  private async findProviderAndModel(
    modelId: string,
  ): Promise<{ provider: ProviderConfig; model: ModelConfig } | null> {
    // Check for placeholder model ID
    if (isPlaceholderModelId(modelId)) {
      throw new Error(
        t(
          'This is a placeholder model while official models are loading. Please select a different model or wait for the models to finish loading.',
        ),
      );
    }

    const parsed = this.parseModelId(modelId);
    if (!parsed) {
      return null;
    }

    const decodedProviderName = this.decodeProviderName(parsed.providerName);
    if (!decodedProviderName) {
      return null;
    }

    const provider = this.configStore.endpoints.find(
      (p) => p.name === decodedProviderName,
    );
    if (!provider) {
      return null;
    }

    const allModels = await getAllModelsForProvider(provider);
    const model = allModels.find((m) => m.id === parsed.modelName);
    if (model) {
      return { provider, model };
    }

    return null;
  }

  /**
   * Get or create client for a provider with an optional model type override.
   * Uses the provider's type, or the model's type if specified.
   * Returns a cached client if available, or creates a new one.
   */
  private getClient(provider: ProviderConfig, model?: ModelConfig): ApiProvider {
    const actualApiType = model
      ? this.getActualApiType(provider, model)
      : (() => {
          const providerApiType = provider.type;
          return providerApiType ?? DEFAULT_PROVIDER_TYPE;
        })();

    const clientKey = `${provider.name}:${actualApiType}`;
    let client = this.clients.get(clientKey);
    if (!client) {
      const providerConfigWithType = {
        ...provider,
        type: actualApiType,
      };
      client = createProvider(providerConfigWithType);
      this.clients.set(clientKey, client);
    }
    return client;
  }

  private toAuthTokenInfo(
    credential: AuthCredential | undefined,
  ): AuthTokenInfo {
    if (!credential?.value) {
      return { kind: 'none' };
    }

    return {
      kind: 'token',
      token: credential.value,
      tokenType: credential.tokenType,
      expiresAt: credential.expiresAt,
    };
  }

  private async resolveCredential(
    provider: ProviderConfig,
  ): Promise<AuthTokenInfo> {
    const auth = provider.auth;

    // Prefer auth manager when auth config is present
    if (auth && auth.method !== 'none') {
      if (!this.authManager) {
        throw new Error(
          t('Authentication required for provider "{0}".', provider.name),
        );
      }

      const credential = await this.authManager.getCredential(
        provider.name,
        auth,
      );

      if (credential) {
        return this.toAuthTokenInfo(credential);
      }

      const lastError = this.authManager.getLastError(
        provider.name,
        auth.method,
      );

      if (lastError) {
        const isAuthError = lastError.errorType === 'auth_error';
        const buttons = isAuthError
          ? [t('Re-authorize')]
          : [t('Retry'), t('Re-authorize')];

        const message = isAuthError
          ? t(
              'Authentication expired for "{0}". Please re-authorize.',
              provider.name,
            )
          : t(
              'Authentication error for "{0}": {1}',
              provider.name,
              lastError.error.message,
            );

        const action = await vscode.window.showErrorMessage(
          message,
          { modal: true },
          ...buttons,
        );

        if (action === t('Retry')) {
          const success = await this.authManager.retryRefresh(
            provider.name,
            auth,
          );
          if (success) {
            const newCredential = await this.authManager.getCredential(
              provider.name,
              auth,
            );
            if (newCredential) {
              return this.toAuthTokenInfo(newCredential);
            }
          }

          return this.resolveCredential(provider);
        }

        if (action === t('Re-authorize')) {
          const ctx: UiContext = {
            store: this.configStore,
            secretStore: this.secretStore,
          };
          await runUiStack(ctx, {
            kind: 'providerForm',
            providerName: provider.name,
          });
          // After user finishes editing, retry credential resolution
          return this.resolveCredential(provider);
        }

        throw new Error(
          t('Authentication required for provider "{0}".', provider.name),
        );
      }

      const authProvider = this.authManager.getProvider(provider.name, auth);
      if (authProvider) {
        const confirm = await vscode.window.showErrorMessage(
          t('Authentication for provider "{0}" is required.', provider.name),
          { modal: true },
          t('Authenticate'),
        );
        if (confirm === t('Authenticate')) {
          const result = await authProvider.configure();
          if (result.success) {
            const newCredential = await authProvider.getCredential();
            if (newCredential) {
              return this.toAuthTokenInfo(newCredential);
            }
          }
        }
      }

      throw new Error(
        t('Authentication required for provider "{0}".', provider.name),
      );
    }

    // No auth configured
    return { kind: 'none' };
  }

  /**
   * Handle chat request and stream response
   */
  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const logger = createRequestLogger();
    const performanceTrace: PerformanceTrace = {
      tts: Date.now(),
      tl: 0,
      tps: 0,
      ttf: 0,
      ttft: 0,
    };

    const found = await this.findProviderAndModel(model.id);
    if (!found) {
      throw new Error(`Model not found: ${model.id}`);
    }

    const { provider, model: modelConfig } = found;
    const credential = await this.resolveCredential(provider);

    const actualApiType = this.getActualApiType(
      provider,
      modelConfig,
    );

    logger.start({
      providerName: provider.name,
      actualApiType: actualApiType,
      baseUrl: provider.baseUrl,
      vscodeModelId: model.id,
      modelId: modelConfig.id,
      modelName: modelConfig.name,
    });
    logger.vscodeInput(messages, options);

    const client = this.getClient(provider, modelConfig);

    // Stream the response
    const stream = client.streamChat(
      model.id,
      modelConfig,
      messages,
      options,
      performanceTrace,
      token,
      logger,
      credential,
    );

    try {
      for await (const part of stream) {
        if (token.isCancellationRequested) {
          break;
        }
        // Log VSCode output (verbose only)
        logger.vscodeOutput(part);
        progress.report(part);
      }
    } catch (error) {
      if (token.isCancellationRequested && isAbortError(error)) {
        // User cancelled the request; treat provider abort errors as expected.
      } else {
        // sometimes, the chat panel in VSCode does not display the specific error,
        // but instead shows the output from `stackTrace.format`.
        logger.error(error);
        throw error;
      }
    }

    performanceTrace.tl = Date.now() - performanceTrace.tts;
    logger.complete(performanceTrace);
  }

  /**
   * Provide token count estimation
   */
  async provideTokenCount(
    model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    const found = await this.findProviderAndModel(model.id);

    // Extract text content
    let content: string;
    if (typeof text === 'string') {
      content = text;
    } else {
      content = text.content
        .map((part) => {
          if (part instanceof vscode.LanguageModelTextPart) {
            return part.value;
          }
          return '';
        })
        .join('');
    }

    // Use client's estimation if available, otherwise use default
    if (found) {
      const client = this.getClient(found.provider, found.model);
      return client.estimateTokenCount(content);
    }

    // Default estimation: ~4 characters per token
    return Math.ceil(content.length / 4);
  }

  /**
   * Clear cached clients (useful when configuration changes)
   */
  clearClients(): void {
    this.clients.clear();
  }

  /**
   * Handle configuration change by clearing cached clients and notifying
   * VSCode to re-fetch model information.
   */
  handleConfigurationChange(): void {
    this.clearClients();
    // Notify VSCode to re-fetch model information
    this.onDidChangeModelInfoEmitter.fire();
  }

  dispose(): void {
    this.clearClients();
    this.onDidChangeModelInfoEmitter.dispose();
  }
}
