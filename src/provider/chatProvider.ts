import * as vscode from 'vscode';
import { ConfigStore } from '../config/store';
import { AnthropicClient } from '../client/anthropic';
import { ProviderConfig, ModelConfig, ApiClient } from '../types';

/**
 * Default token limits for models
 */
const DEFAULT_MAX_INPUT_TOKENS = 200000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/**
 * Create an API client based on provider type
 */
function createClient(provider: ProviderConfig): ApiClient {
  switch (provider.type) {
    case 'anthropic':
      return new AnthropicClient(provider);
    default:
      throw new Error(`Unsupported provider type: ${provider.type}`);
  }
}

/**
 * LanguageModelChatProvider implementation for multiple API formats
 */
export class UnifyChatProvider implements vscode.LanguageModelChatProvider {
  private readonly clients = new Map<string, ApiClient>();

  constructor(private readonly configStore: ConfigStore) {}

  /**
   * Provide information about available models
   */
  provideLanguageModelChatInformation(
    options: { silent: boolean },
    _token: vscode.CancellationToken
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
  private createModelInfo(provider: ProviderConfig, model: ModelConfig): vscode.LanguageModelChatInformation {
    const modelId = this.createModelId(provider.name, model.id);

    return {
      id: modelId,
      name: model.name ?? model.id,
      family: provider.name,
      version: '1.0.0',
      maxInputTokens: model.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS,
      maxOutputTokens: model.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      capabilities: {
        toolCalling: true,
        imageInput: true,
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
  private parseModelId(modelId: string): { providerName: string; modelName: string } | null {
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
  private findProviderAndModel(modelId: string): { provider: ProviderConfig; model: ModelConfig } | null {
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
  private getClient(provider: ProviderConfig): ApiClient {
    let client = this.clients.get(provider.name);
    if (!client) {
      client = createClient(provider);
      this.clients.set(provider.name, client);
    }
    return client;
  }

  /**
   * Handle chat request and stream response
   */
  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const found = this.findProviderAndModel(model.id);
    if (!found) {
      throw new Error(`Model not found: ${model.id}`);
    }

    const { provider, model: modelConfig } = found;
    const client = this.getClient(provider);

    // Convert messages to Anthropic format
    const { system, messages: anthropicMessages } = client.convertMessages(messages);

    // Convert tools if provided
    const tools = options.tools ? client.convertTools(options.tools) : undefined;

    // Stream the response
    const stream = client.streamChat(
      anthropicMessages,
      modelConfig.id,
      {
        maxTokens: modelConfig.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        system,
        tools,
      },
      token
    );

    for await (const part of stream) {
      if (token.isCancellationRequested) {
        break;
      }
      progress.report(part);
    }
  }

  /**
   * Provide token count estimation
   */
  async provideTokenCount(
    model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatMessage,
    _token: vscode.CancellationToken
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
