import * as vscode from 'vscode';
import { ConfigStore } from './config-store';
import { createProvider } from './client';
import {
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from './defaults';
import { ApiProvider, ProviderConfig, ModelConfig } from './client/interface';
import { logInfo } from './logger';
import { PerformanceTrace } from './types';

export class UnifyChatService implements vscode.LanguageModelChatProvider {
  private readonly clients = new Map<string, ApiProvider>();

  constructor(private readonly configStore: ConfigStore) {}

  /**
   * Provide information about available models
   */
  provideLanguageModelChatInformation(
    options: { silent: boolean },
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
    const models: vscode.LanguageModelChatInformation[] = [];

    for (const provider of this.configStore.endpoints) {
      for (const model of provider.models) {
        models.push(this.createModelInfo(provider, model));
      }
    }

    // If no models configured and not silent, prompt user to add a provider
    if (models.length === 0 && !options.silent) {
      vscode.commands.executeCommand('unifyChatProvider.addProvider');
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
      family: model.family ?? model.id,
      version: '1.0.0',
      maxInputTokens: model.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS,
      maxOutputTokens: model.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      capabilities: {
        toolCalling: model.capabilities?.toolCalling ?? false,
        imageInput: model.capabilities?.imageInput ?? false,
      },
    };
  }

  /**
   * Create a unique model ID combining provider and model names
   */
  private createModelId(providerName: string, modelId: string): string {
    return `${this.sanitizeName(providerName)}/${modelId}`;
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
   * Sanitize provider name for use in model ID
   */
  private sanitizeName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  }

  /**
   * Find provider and model configuration by model ID
   */
  private findProviderAndModel(
    modelId: string,
  ): { provider: ProviderConfig; model: ModelConfig } | null {
    const parsed = this.parseModelId(modelId);
    if (!parsed) {
      return null;
    }

    for (const provider of this.configStore.endpoints) {
      const sanitizedName = this.sanitizeName(provider.name);
      if (sanitizedName === parsed.providerName) {
        const model = provider.models.find((m) => m.id === parsed.modelName);
        if (model) {
          return { provider, model };
        }
      }
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
    const performanceTrace: PerformanceTrace = {
      tts: Date.now(),
      tl: 0,
      tps: 0,
      ttf: 0,
      ttft: 0,
    };

    logInfo(`[Chat Request] Model: ${model.id}`);
    logInfo(
      `[Chat Request] Raw Messages: ${JSON.stringify(messages, null, 2)}`,
    );
    logInfo(`[Chat Request] Raw Options: ${JSON.stringify(options, null, 2)}`);

    const found = this.findProviderAndModel(model.id);
    if (!found) {
      throw new Error(`Model not found: ${model.id}`);
    }

    const { provider, model: modelConfig } = found;
    const client = this.getClient(provider);

    // Stream the response
    const stream = client.streamChat(
      modelConfig,
      messages,
      options,
      performanceTrace,
      token,
    );

    for await (const part of stream) {
      if (token.isCancellationRequested) {
        break;
      }
      logInfo(`[Chat Response] Chunk: ${JSON.stringify(part)}`);
      progress.report(part);
    }

    performanceTrace.tl = Date.now() - performanceTrace.tts;
    logInfo(
      `[Chat Response] Performance trace: TimeToFetch: ${
        performanceTrace.ttf
      }ms, TimeToFirstToken: ${
        performanceTrace.ttft
      }ms, TokensPerSecond: ${performanceTrace.tps.toFixed(
        1,
      )}/s, TotalLatency: ${performanceTrace.tl}ms`,
    );
  }

  /**
   * Provide token count estimation
   */
  async provideTokenCount(
    model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    const found = this.findProviderAndModel(model.id);

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
      const client = this.getClient(found.provider);
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
}
