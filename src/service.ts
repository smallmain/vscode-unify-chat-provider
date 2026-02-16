import * as vscode from 'vscode';
import { ConfigStore } from './config-store';
import {
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from './defaults';
import { ApiProvider } from './client/interface';
import { createRequestLogger } from './logger';
import { ModelConfig, PerformanceTrace, ProviderConfig } from './types';
import { getBaseModelId } from './model-id-utils';
import { createProvider } from './client/utils';
import { formatModelTooltip, formatProviderDetail } from './ui/form-utils';
import {
  calculateBackoffDelay,
  delay,
  getAllModelsForProvider,
  getAllModelsForProviderSync,
  isAbortError,
  isPlaceholderModelId,
  resolveChatNetwork,
} from './utils';
import { SecretStore } from './secret';
import { AuthManager } from './auth';
import type { AuthCredential, AuthTokenInfo } from './auth/types';
import { t } from './i18n';
import { runUiStack } from './ui/router/stack-router';
import type { UiContext } from './ui/router/types';
import {
  TOKENIZERS,
  resolveTokenCountMultiplier,
  resolveTokenizerId,
} from './tokenizer/tokenizers';
import type { BalanceManager } from './balance';
import { evaluateBalanceWarning } from './balance/warning-utils';

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
    private readonly balanceManager?: BalanceManager,
  ) {}

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
    const displayName = `${model.name ?? model.id} [${provider.name}]`;
    const balanceSnapshot = this.balanceManager?.getProviderState(
      provider.name,
    )?.snapshot;
    const detail = formatProviderDetail(provider.name, balanceSnapshot);
    const tooltip = formatModelTooltip(provider, model, balanceSnapshot);

    const warning = evaluateBalanceWarning(
      balanceSnapshot?.modelDisplay,
      this.configStore.balanceWarning,
    );
    const statusIcon = warning.isNearThreshold
      ? new vscode.ThemeIcon('warning')
      : undefined;

    return {
      id: modelId,
      name: displayName,
      family: model.family ?? getBaseModelId(model.id),
      version: '',
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
      detail,
      tooltip,
      isUserSelectable: true,
      statusIcon,
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
   * Get or create client for a provider
   */
  private getClient(provider: ProviderConfig): ApiProvider {
    let client = this.clients.get(provider.name);
    if (!client) {
      client = createProvider(provider);
      this.clients.set(provider.name, client);
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
    providerName: string,
  ): Promise<AuthTokenInfo> {
    while (true) {
      const provider = this.configStore.getProvider(providerName);
      if (!provider) {
        throw new Error(t('Provider "{0}" not found.', providerName));
      }

      const auth = provider.auth;
      if (!auth || auth.method === 'none') {
        return { kind: 'none' };
      }

      if (!this.authManager) {
        throw new Error(
          t('Authentication required for provider "{0}".', provider.name),
        );
      }

      const credential = await this.authManager.getCredential(providerName);

      if (credential) {
        return this.toAuthTokenInfo(credential);
      }

      const lastError = this.authManager.getLastError(providerName);

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
          const success = await this.authManager.retryRefresh(providerName);
          if (success) {
            const newCredential =
              await this.authManager.getCredential(providerName);
            if (newCredential) {
              return this.toAuthTokenInfo(newCredential);
            }
          }
          continue;
        }

        if (action === t('Re-authorize')) {
          const ctx: UiContext = {
            store: this.configStore,
            secretStore: this.secretStore,
          };
          await runUiStack(ctx, {
            kind: 'providerForm',
            providerName,
          });

          const newCredential =
            await this.authManager.getCredential(providerName);
          if (newCredential) {
            return this.toAuthTokenInfo(newCredential);
          }

          throw new Error(
            t('Authentication required for provider "{0}".', providerName),
          );
        }

        throw new Error(
          t('Authentication required for provider "{0}".', providerName),
        );
      }

      const authProvider = this.authManager.getProvider(providerName);
      if (authProvider) {
        const confirm = await vscode.window.showErrorMessage(
          t('Authentication for provider "{0}" is required.', provider.name),
          { modal: true },
          t('Authenticate'),
        );
        if (confirm === t('Authenticate')) {
          const result = await authProvider.configure();
          if (result.success) {
            const newCredential =
              await this.authManager.getCredential(providerName);
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

    let providerForBalance: ProviderConfig | undefined;
    let outcome: 'success' | 'error' | 'cancelled' = 'success';

    try {
      const found = await this.findProviderAndModel(model.id);
      if (!found) {
        throw new Error(`Model not found: ${model.id}`);
      }

      const { provider } = found;
      const credential = await this.resolveCredential(provider.name);

      const resolved = await this.findProviderAndModel(model.id);
      if (!resolved) {
        throw new Error(`Model not found: ${model.id}`);
      }

      const { provider: resolvedProvider, model: resolvedModel } = resolved;
      providerForBalance = resolvedProvider;
      this.balanceManager?.notifyChatRequestStarted(resolvedProvider.name);

      logger.start({
        providerName: resolvedProvider.name,
        providerType: resolvedProvider.type,
        baseUrl: resolvedProvider.baseUrl,
        vscodeModelId: model.id,
        modelId: resolvedModel.id,
        modelName: resolvedModel.name,
      });
      logger.vscodeInput(messages, options);

      const client = this.getClient(resolvedProvider);
      const retryConfig = resolveChatNetwork(resolvedProvider).retry;

      let emptyStreamAttempt = 0;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (emptyStreamAttempt > 0) {
          // Reset performance trace for retry
          performanceTrace.tts = Date.now();
          performanceTrace.ttf = 0;
          performanceTrace.ttft = 0;
          performanceTrace.tps = 0;
          performanceTrace.tl = 0;
        }

        let partCount = 0;

        // Stream the response
        const stream = client.streamChat(
          model.id,
          resolvedModel,
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
              outcome = 'cancelled';
              break;
            }
            partCount++;
            // Log VSCode output (verbose only)
            logger.vscodeOutput(part);
            progress.report(part);
          }
        } catch (error) {
          if (token.isCancellationRequested && isAbortError(error)) {
            // User cancelled the request; treat provider abort errors as expected.
            outcome = 'cancelled';
          } else {
            outcome = 'error';
            // sometimes, the chat panel in VSCode does not display the specific error,
            // but instead shows the output from `stackTrace.format`.
            logger.error(error);
            throw error;
          }
        }

        // If the stream produced data or was cancelled, we're done
        if (partCount > 0 || token.isCancellationRequested) {
          if (token.isCancellationRequested) {
            outcome = 'cancelled';
          }
          break;
        }

        // Empty stream (200 OK but no data) — treat as transient and retry
        if (emptyStreamAttempt >= retryConfig.maxRetries) {
          break;
        }

        const delayMs = calculateBackoffDelay(emptyStreamAttempt, retryConfig);
        logger.emptyStreamRetry(
          emptyStreamAttempt + 1,
          retryConfig.maxRetries,
          delayMs,
        );
        await delay(delayMs);
        emptyStreamAttempt++;
      }

      performanceTrace.tl = Date.now() - performanceTrace.tts;
      logger.complete(performanceTrace);
    } catch (error) {
      if (outcome !== 'cancelled') {
        outcome = 'error';
      }
      throw error;
    } finally {
      if (providerForBalance) {
        this.balanceManager?.notifyChatRequestFinished(
          providerForBalance.name,
          outcome,
        );
      }
    }
  }

  /**
   * Provide token count estimation
   */
  async provideTokenCount(
    model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken,
  ): Promise<number> {
    let found: { provider: ProviderConfig; model: ModelConfig } | null = null;
    try {
      found = await this.findProviderAndModel(model.id);
    } catch {
      // Never fail token count; fall back to defaults.
      found = null;
    }

    const tokenizerId = resolveTokenizerId(found?.model.tokenizer);
    const baseRaw = await TOKENIZERS[tokenizerId].provideTokenCount(
      model,
      text,
      token,
    );
    const base =
      typeof baseRaw === 'number' && Number.isFinite(baseRaw) && baseRaw > 0
        ? baseRaw
        : 0;

    const multiplier = resolveTokenCountMultiplier(
      found?.model.tokenCountMultiplier,
    );
    return Math.ceil(base * multiplier);
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
