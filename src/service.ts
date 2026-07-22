import * as vscode from 'vscode';
import { ConfigStore } from './config-store';
import {
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from './defaults';
import { ApiProvider } from './client/interface';
import { createRequestLogger } from './logger';
import {
  ChatRequestTrace,
  ModelConfig,
  PerformanceTrace,
  ProviderConfig,
} from './types';
import {
  createVsCodeModelId,
  getBaseModelId,
  parseVsCodeModelId,
} from './model-id-utils';
import { createProvider } from './client/utils';
import {
  formatProviderBadgeSuffixForModelSelection,
  formatModelTooltipForModelSelection,
  formatProviderDetailForModelSelection,
} from './ui/form-utils';
import {
  calculateBackoffDelay,
  delay,
  getAllModelsForProvider,
  getAllModelsForProviderSync,
  createUsageDataPart,
  describeNetworkError,
  isAbortLikeError,
  isPlaceholderModelId,
  resolveMeaningfulError,
  resolveChatNetwork,
} from './utils';
import { SecretStore } from './secret';
import { AuthManager } from './auth';
import type { AuthCredential, AuthTokenInfo } from './auth/types';
import { t } from './i18n';
import {
  applyPresetTemplateSelections,
  buildPresetTemplateConfigurationSchema,
} from './preset-templates';
import { runUiStack } from './ui/router/stack-router';
import type { UiContext } from './ui/router/types';
import {
  TOKENIZERS,
  resolveTokenCountMultiplier,
  resolveTokenizerId,
} from './tokenizer/tokenizers';
import {
  formatPrimaryBadge,
  formatSummaryLine,
  formatSnapshotLines,
  type BalanceManager,
  type BalanceProviderState,
} from './balance';
import { evaluateBalanceWarning } from './balance/warning-utils';
import { resolveConfiguredEditToolsForVsCode } from './model-capabilities';

const MODEL_DISPLAY_NAME_PLACEHOLDER_PATTERN =
  /\{(modelId|modelName|modelFamily|providerName|remainingBalance)\}/g;
const BALANCE_CONFIGURATION_KEY = '__unifyBalance';
const RETRYABLE_STREAM_READ_ERROR_CODES = new Set([
  'stream_read_error',
]);

interface ModelDisplayNameTemplateValues {
  modelId: string;
  modelName: string;
  modelFamily: string;
  providerName: string;
  remainingBalance: string;
}

interface ModelInfoDraft {
  provider: ProviderConfig;
  model: ModelConfig;
  resolvedModelName: string;
}

interface BalanceConfigurationOption {
  id: string;
  label: string;
  description: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function getErrorCause(error: unknown): unknown {
  return isRecord(error) && 'cause' in error ? error.cause : undefined;
}

function getRetryableStreamReadErrorFields(error: unknown): {
  code?: string;
  message?: string;
} {
  if (error instanceof Error) {
    return { message: error.message };
  }

  if (!isRecord(error)) {
    return typeof error === 'string' ? { message: error } : {};
  }

  const nestedError = isRecord(error.error) ? error.error : undefined;
  return {
    code:
      readStringField(error, 'code') ??
      (nestedError ? readStringField(nestedError, 'code') : undefined),
    message:
      readStringField(error, 'message') ??
      (nestedError ? readStringField(nestedError, 'message') : undefined),
  };
}

function isRetryableStreamReadError(error: unknown): boolean {
  if (isAbortLikeError(error)) {
    return false;
  }

  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current !== undefined && !seen.has(current)) {
    seen.add(current);

    const { code, message } = getRetryableStreamReadErrorFields(current);
    if (code && RETRYABLE_STREAM_READ_ERROR_CODES.has(code)) {
      return true;
    }

    const normalizedMessage = message?.toLowerCase();
    if (normalizedMessage) {
      const isInternalStreamError =
        (normalizedMessage.includes('internal_server_error') ||
          normalizedMessage.includes('internal_error')) &&
        (normalizedMessage.includes('stream error') ||
          normalizedMessage.includes('stream id') ||
          normalizedMessage.includes('received from peer'));
      if (
        normalizedMessage.includes('stream_read_error') ||
        normalizedMessage.includes('stream read error') ||
        isInternalStreamError
      ) {
        return true;
      }
    }

    current = getErrorCause(current);
  }

  return false;
}

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
    private readonly canUseChatProviderProposal = true,
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
    const modelDrafts: ModelInfoDraft[] = [];
    const modelNameCounts = new Map<string, number>();

    for (const provider of this.configStore.endpoints) {
      const allModels = getAllModelsForProviderSync(provider);

      for (const model of allModels) {
        const resolvedModelName = model.name ?? model.id;
        modelDrafts.push({ provider, model, resolvedModelName });
        modelNameCounts.set(
          resolvedModelName,
          (modelNameCounts.get(resolvedModelName) ?? 0) + 1,
        );
      }
    }

    return modelDrafts.map((draft) =>
      this.createModelInfo(
        draft.provider,
        draft.model,
        draft.resolvedModelName,
        (modelNameCounts.get(draft.resolvedModelName) ?? 0) > 1,
      ),
    );
  }

  /**
   * Create model information object
   */
  private createModelInfo(
    provider: ProviderConfig,
    model: ModelConfig,
    resolvedModelName: string,
    hasDuplicateModelName: boolean,
  ): vscode.LanguageModelChatInformation {
    const modelId = this.createModelId(provider.name, model.id);
    const resolvedModelFamily = model.family ?? getBaseModelId(model.id);
    const balanceState = this.balanceManager?.getProviderState(
      provider.name,
    );
    const balanceSnapshot = balanceState?.snapshot;
    const remainingBalance =
      formatProviderBadgeSuffixForModelSelection(balanceSnapshot);
    const displayName = this.renderModelDisplayName(
      {
        modelId: model.id,
        modelName: resolvedModelName,
        modelFamily: resolvedModelFamily,
        providerName: provider.name,
        remainingBalance,
      },
      hasDuplicateModelName,
    );
    const detail = formatProviderDetailForModelSelection(
      provider.name,
      balanceSnapshot,
    );
    const pricing = formatPrimaryBadge(balanceSnapshot)?.trim();
    const tooltip = formatModelTooltipForModelSelection(
      provider,
      model,
      balanceSnapshot,
    );

    const stableModelInfo: vscode.LanguageModelChatInformation = {
      id: modelId,
      name: displayName,
      family: resolvedModelFamily,
      version: '',
      maxInputTokens: model.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS,
      maxOutputTokens: model.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      capabilities: {
        toolCalling: model.capabilities?.toolCalling ?? false,
        imageInput: model.capabilities?.imageInput ?? false,
      },
      detail,
      tooltip,
      pricing,
    };
    if (!this.canUseChatProviderProposal) {
      return stableModelInfo;
    }

    const warning = evaluateBalanceWarning(
      balanceSnapshot?.items,
      this.configStore.balanceWarning,
    );
    const statusIcon = warning.isNearThreshold
      ? new vscode.ThemeIcon('warning')
      : undefined;
    const editTools = resolveConfiguredEditToolsForVsCode(
      model.capabilities?.editTools,
    );
    const configurationSchema = this.buildModelConfigurationSchema(
      model,
      balanceState,
    );

    return {
      ...stableModelInfo,
      capabilities:
        editTools === undefined
          ? stableModelInfo.capabilities
          : { ...stableModelInfo.capabilities, editTools },
      isUserSelectable: true,
      statusIcon,
      ...(configurationSchema ? { configurationSchema } : {}),
      multiplierNumeric: 1,
      pricing,
    };
  }

  private buildModelConfigurationSchema(
    model: ModelConfig,
    balanceState: BalanceProviderState | undefined,
  ): vscode.LanguageModelConfigurationSchema | undefined {
    const properties: Record<string, Record<string, unknown>> = {
      ...(buildPresetTemplateConfigurationSchema(model)?.properties ?? {}),
    };
    const balanceProperty =
      this.buildBalanceConfigurationProperty(balanceState);
    if (
      balanceProperty &&
      properties[BALANCE_CONFIGURATION_KEY] === undefined &&
      !this.hasConfigurationGroup(properties, 'tokens')
    ) {
      properties[BALANCE_CONFIGURATION_KEY] = balanceProperty;
    }

    return Object.keys(properties).length > 0 ? { properties } : undefined;
  }

  private hasConfigurationGroup(
    properties: Record<string, Record<string, unknown>>,
    group: string,
  ): boolean {
    return Object.values(properties).some(
      (property) => property['group'] === group,
    );
  }

  private buildBalanceConfigurationProperty(
    state: BalanceProviderState | undefined,
  ): Record<string, unknown> | undefined {
    if (!this.configStore.displayBalanceInConfiguration) {
      return undefined;
    }

    const options = this.buildBalanceConfigurationOptions(state);
    if (options.length === 0) {
      return undefined;
    }

    return {
      type: 'string',
      title: 'Balance',
      enum: options.map((option) => option.id),
      enumItemLabels: options.map((option) => option.label),
      enumDescriptions: options.map((option) => option.description),
      default: options[0].id,
      group: 'tokens',
    };
  }

  private buildBalanceConfigurationOptions(
    state: BalanceProviderState | undefined,
  ): BalanceConfigurationOption[] {
    const snapshot = state?.snapshot;
    const primaryOption = this.buildPrimaryBalanceConfigurationOption(state);
    const options = formatSnapshotLines(snapshot).map((line, index) => {
      const { label, description } = this.splitBalanceConfigurationLine(line);
      return {
        id: `balance-${index}`,
        label,
        description,
      };
    });
    const allOptions = primaryOption
      ? [primaryOption, ...options]
      : options;

    const lastRefreshAt = this.resolveBalanceLastRefreshAt(state);
    if (allOptions.length > 0 && lastRefreshAt !== undefined) {
      allOptions.push({
        id: 'balance-last-refresh',
        label: new Date(lastRefreshAt).toLocaleString(),
        description: t('Last refreshed'),
      });
    }

    return allOptions;
  }

  private buildPrimaryBalanceConfigurationOption(
    state: BalanceProviderState | undefined,
  ): BalanceConfigurationOption | undefined {
    const snapshot = state?.snapshot;
    const label = formatPrimaryBadge(snapshot)?.trim();
    if (!label) {
      return undefined;
    }

    return {
      id: 'balance-primary',
      label,
      description: formatSummaryLine(snapshot) ?? t('Balance'),
    };
  }

  private resolveBalanceLastRefreshAt(
    state: BalanceProviderState | undefined,
  ): number | undefined {
    const lastRefreshAt = state?.lastRefreshAt;
    if (
      typeof lastRefreshAt === 'number' &&
      Number.isFinite(lastRefreshAt) &&
      lastRefreshAt >= 0
    ) {
      return lastRefreshAt;
    }

    const updatedAt = state?.snapshot?.updatedAt;
    return typeof updatedAt === 'number' &&
      Number.isFinite(updatedAt) &&
      updatedAt >= 0
      ? updatedAt
      : undefined;
  }

  private splitBalanceConfigurationLine(line: string): {
    label: string;
    description: string;
  } {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) {
      return {
        label: line,
        description: line,
      };
    }

    const description = line.slice(0, separatorIndex).trim();
    const label = line.slice(separatorIndex + 1).trim();
    if (!description || !label) {
      return {
        label: line,
        description: line,
      };
    }

    return { label, description };
  }

  private renderModelDisplayName(
    values: ModelDisplayNameTemplateValues,
    hasDuplicateModelName: boolean,
  ): string {
    const rendered = this.renderModelDisplayNameTemplate(
      this.configStore.modelDisplayNameTemplate,
      values,
      hasDuplicateModelName,
    );
    const trimmed = rendered.trim();
    return trimmed || values.modelName;
  }

  private renderModelDisplayNameTemplate(
    template: string,
    values: ModelDisplayNameTemplateValues,
    hasDuplicateModelName: boolean,
  ): string {
    let rendered = '';
    let index = 0;

    while (index < template.length) {
      const blockStart = template.indexOf('{{', index);

      if (blockStart === -1) {
        rendered += this.renderModelDisplayNamePlaceholders(
          template.slice(index),
          values,
        );
        break;
      }

      rendered += this.renderModelDisplayNamePlaceholders(
        template.slice(index, blockStart),
        values,
      );

      const blockEnd = template.indexOf('}}', blockStart + 2);
      if (blockEnd === -1) {
        rendered += this.renderModelDisplayNamePlaceholders(
          template.slice(blockStart),
          values,
        );
        break;
      }

      if (hasDuplicateModelName) {
        rendered += this.renderModelDisplayNamePlaceholders(
          template.slice(blockStart + 2, blockEnd),
          values,
        );
      }

      index = blockEnd + 2;
    }

    return rendered;
  }

  private renderModelDisplayNamePlaceholders(
    template: string,
    values: ModelDisplayNameTemplateValues,
  ): string {
    return template.replace(
      MODEL_DISPLAY_NAME_PLACEHOLDER_PATTERN,
      (_match, key: string) =>
        this.resolveModelDisplayNameTemplateValue(key, values),
    );
  }

  private resolveModelDisplayNameTemplateValue(
    key: string,
    values: ModelDisplayNameTemplateValues,
  ): string {
    switch (key) {
      case 'modelId':
        return values.modelId;
      case 'modelName':
        return values.modelName;
      case 'modelFamily':
        return values.modelFamily;
      case 'providerName':
        return values.providerName;
      case 'remainingBalance':
        return values.remainingBalance;
      default:
        return `{${key}}`;
    }
  }

  /**
   * Create a unique model ID combining provider and model names
   */
  private createModelId(providerName: string, modelId: string): string {
    return createVsCodeModelId(providerName, modelId);
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

    const parsed = parseVsCodeModelId(modelId);
    if (!parsed) {
      return null;
    }

    const provider = this.configStore.endpoints.find(
      (p) => p.name === parsed.providerName,
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

  private async refreshCredential(providerName: string): Promise<AuthTokenInfo> {
    if (!this.authManager) {
      throw new Error(
        t('Authentication required for provider "{0}".', providerName),
      );
    }
    const refreshed = await this.authManager.retryRefresh(providerName);
    if (!refreshed) {
      throw (
        this.authManager.getLastError(providerName)?.error ??
        new Error(t('Failed to refresh authentication for "{0}".', providerName))
      );
    }
    return this.toAuthTokenInfo(
      await this.authManager.getCredential(providerName),
    );
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
    const requestTrace: ChatRequestTrace = {
      performance: performanceTrace,
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
      const resolvedRequestModel = applyPresetTemplateSelections(
        resolvedModel,
        this.canUseChatProviderProposal
          ? options.modelConfiguration
          : undefined,
      );
      providerForBalance = resolvedProvider;
      this.balanceManager?.notifyChatRequestStarted(resolvedProvider.name);

      logger.start({
        providerName: resolvedProvider.name,
        providerType: resolvedProvider.type,
        baseUrl: resolvedProvider.baseUrl,
        vscodeModelId: model.id,
        modelId: resolvedRequestModel.id,
        modelName: resolvedRequestModel.name,
      });
      logger.vscodeInput(messages, options);

      const client = this.getClient(resolvedProvider);
      const chatNetwork = resolveChatNetwork(resolvedProvider);
      const retryConfig = chatNetwork.retry;
      const retryAbortController = new AbortController();
      const retryCancellationListener = token.onCancellationRequested(() => {
        retryAbortController.abort();
      });
      if (token.isCancellationRequested) {
        retryAbortController.abort();
      }

      try {
        let streamRetryAttempt = 0;

        // eslint-disable-next-line no-constant-condition
        while (true) {
          if (streamRetryAttempt > 0) {
            // Reset performance trace for retry
            performanceTrace.tts = Date.now();
            performanceTrace.ttf = 0;
            performanceTrace.ttft = 0;
            performanceTrace.tps = 0;
            performanceTrace.tl = 0;
            requestTrace.usage = undefined;
          }

          let partCount = 0;

          // Stream the response
          const stream = client.streamChat(
            model.id,
            resolvedRequestModel,
            messages,
            options,
            requestTrace,
            token,
            logger,
            credential,
            () => this.refreshCredential(resolvedProvider.name),
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
            if (token.isCancellationRequested && isAbortLikeError(error)) {
              // User cancelled the request; treat provider abort errors as expected.
              outcome = 'cancelled';
            } else if (
              partCount === 0 &&
              !token.isCancellationRequested &&
              isRetryableStreamReadError(error) &&
              streamRetryAttempt < retryConfig.maxRetries
            ) {
              const delayMs = calculateBackoffDelay(
                streamRetryAttempt,
                retryConfig,
              );
              logger.retry(
                streamRetryAttempt + 1,
                retryConfig.maxRetries,
                0,
                delayMs,
                undefined,
                describeNetworkError(error),
              );
              await delay(delayMs, retryAbortController.signal);
              streamRetryAttempt++;
              continue;
            } else {
              outcome = 'error';
              const normalizedError = resolveMeaningfulError(error);
              // sometimes, the chat panel in VSCode does not display the specific error,
              // but instead shows the output from `stackTrace.format`.
              logger.error(normalizedError);
              throw normalizedError;
            }
          }

          // If the stream produced any parts or was cancelled, we're done
          if (partCount > 0 || token.isCancellationRequested) {
            if (token.isCancellationRequested) {
              outcome = 'cancelled';
            }
            break;
          }

          // 0-part responses are valid for some providers. In particular,
          // Anthropic Messages may legitimately return usage-only streams
          // (e.g. `message_start` + `message_delta` with only usage /
          // stop_reason + `message_stop`) where the final message has an empty
          // content array. Copilot Chat interprets a visibly empty assistant
          // response as an error, so the Anthropic client suppresses all
          // parts in this scenario. We must treat those 0-part responses as
          // successful no-op completions and not retry.
          if (resolvedProvider.type === 'anthropic') {
            break;
          }

          // Empty stream (200 OK but no data) — treat as transient and retry
          if (streamRetryAttempt >= retryConfig.maxRetries) {
            break;
          }

          const delayMs = calculateBackoffDelay(
            streamRetryAttempt,
            retryConfig,
          );
          logger.emptyStreamRetry(
            streamRetryAttempt + 1,
            retryConfig.maxRetries,
            delayMs,
          );
          await delay(delayMs, retryAbortController.signal);
          streamRetryAttempt++;
        }
      } finally {
        retryCancellationListener.dispose();
      }

      if (requestTrace.usage && !token.isCancellationRequested) {
        const usagePart = createUsageDataPart(requestTrace.usage);
        logger.vscodeOutput(usagePart);
        progress.report(usagePart);
      }

      performanceTrace.tl = Date.now() - performanceTrace.tts;
      logger.complete(performanceTrace);
    } catch (error) {
      if (token.isCancellationRequested && isAbortLikeError(error)) {
        outcome = 'cancelled';
      } else if (outcome !== 'cancelled') {
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
    let baseRaw: number;
    try {
      baseRaw = await TOKENIZERS[tokenizerId].provideTokenCount(
        model,
        text,
        token,
      );
    } catch {
      try {
        baseRaw = await TOKENIZERS.default.provideTokenCount(
          model,
          text,
          token,
        );
      } catch {
        baseRaw = 0;
      }
    }
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
