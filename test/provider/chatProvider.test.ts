/**
 * Tests for UnifyChatProvider
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import {
  vscode,
  CancellationTokenSource,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelChatMessage,
  createProgress,
} from '../mocks/vscode.js';
import { createTestProviderConfig, assertThrowsAsync } from '../utils/test-helpers.js';
import type { ProviderConfig, ModelConfig, AnthropicMessage } from '../types.js';

// Local ApiClient interface for testing
interface ApiClient {
  streamChat(
    messages: unknown[],
    modelId: string,
    options: { maxTokens?: number; system?: string; tools?: unknown[] },
    token: { isCancellationRequested: boolean }
  ): AsyncGenerator<InstanceType<typeof LanguageModelTextPart> | InstanceType<typeof LanguageModelToolCallPart>>;

  convertMessages(
    messages: readonly InstanceType<typeof LanguageModelChatMessage>[]
  ): { system?: string; messages: unknown[] };

  convertTools(tools: readonly unknown[]): unknown[];

  estimateTokenCount(text: string): number;
}

// Default token limits
const DEFAULT_MAX_INPUT_TOKENS = 200000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

// Mock ConfigStore
class MockConfigStore {
  private _endpoints: ProviderConfig[] = [];

  get endpoints(): ProviderConfig[] {
    return this._endpoints;
  }

  setEndpoints(endpoints: ProviderConfig[]): void {
    this._endpoints = endpoints;
  }
}

// Mock API Client
class MockApiClient implements ApiClient {
  streamChatCalls: Array<{
    messages: unknown[];
    modelId: string;
    options: { maxTokens?: number; system?: string; tools?: unknown[] };
  }> = [];
  private streamResponse: Array<InstanceType<typeof LanguageModelTextPart> | InstanceType<typeof LanguageModelToolCallPart>> = [];
  private shouldThrow: Error | null = null;

  setStreamResponse(parts: Array<InstanceType<typeof LanguageModelTextPart> | InstanceType<typeof LanguageModelToolCallPart>>): void {
    this.streamResponse = parts;
  }

  setShouldThrow(error: Error): void {
    this.shouldThrow = error;
  }

  async *streamChat(
    messages: unknown[],
    modelId: string,
    options: { maxTokens?: number; system?: string; tools?: unknown[] },
    _token: { isCancellationRequested: boolean }
  ): AsyncGenerator<InstanceType<typeof LanguageModelTextPart> | InstanceType<typeof LanguageModelToolCallPart>> {
    this.streamChatCalls.push({ messages, modelId, options });

    if (this.shouldThrow) {
      throw this.shouldThrow;
    }

    for (const part of this.streamResponse) {
      yield part;
    }
  }

  convertMessages(messages: readonly InstanceType<typeof LanguageModelChatMessage>[]): { system?: string; messages: AnthropicMessage[] } {
    return {
      system: undefined,
      messages: messages.map((m) => ({
        role: m.role === 1 ? 'user' : 'assistant',
        content: [{ type: 'text' as const, text: 'converted' }],
      })),
    };
  }

  convertTools(tools: readonly unknown[]): unknown[] {
    return tools.map((t) => ({ converted: true, original: t }));
  }

  estimateTokenCount(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

// Testable UnifyChatProvider
class TestableUnifyChatProvider {
  private readonly clients = new Map<string, ApiClient>();
  private clientFactory: ((provider: ProviderConfig) => ApiClient) | null = null;

  constructor(private readonly configStore: MockConfigStore) {}

  setClientFactory(factory: (provider: ProviderConfig) => ApiClient): void {
    this.clientFactory = factory;
  }

  provideLanguageModelChatInformation(
    _options: { silent: boolean },
    _token: { isCancellationRequested: boolean }
  ): Array<{
    id: string;
    name: string;
    family: string;
    version: string;
    maxInputTokens: number;
    maxOutputTokens: number;
    capabilities: { toolCalling: boolean; imageInput: boolean };
  }> {
    const models: Array<{
      id: string;
      name: string;
      family: string;
      version: string;
      maxInputTokens: number;
      maxOutputTokens: number;
      capabilities: { toolCalling: boolean; imageInput: boolean };
    }> = [];

    for (const provider of this.configStore.endpoints) {
      for (const model of provider.models) {
        models.push(this.createModelInfo(provider, model));
      }
    }

    return models;
  }

  private createModelInfo(
    provider: ProviderConfig,
    model: ModelConfig
  ): {
    id: string;
    name: string;
    family: string;
    version: string;
    maxInputTokens: number;
    maxOutputTokens: number;
    capabilities: { toolCalling: boolean; imageInput: boolean };
  } {
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

  private createModelId(providerName: string, modelId: string): string {
    return `${this.sanitizeName(providerName)}/${modelId}`;
  }

  parseModelId(modelId: string): { providerName: string; modelName: string } | null {
    const slashIndex = modelId.indexOf('/');
    if (slashIndex === -1) {
      return null;
    }
    return {
      providerName: modelId.slice(0, slashIndex),
      modelName: modelId.slice(slashIndex + 1),
    };
  }

  sanitizeName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  }

  findProviderAndModel(modelId: string): { provider: ProviderConfig; model: ModelConfig } | null {
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

  private getClient(provider: ProviderConfig): ApiClient {
    let client = this.clients.get(provider.name);
    if (!client) {
      if (this.clientFactory) {
        client = this.clientFactory(provider);
      } else {
        throw new Error(`No client factory set`);
      }
      this.clients.set(provider.name, client);
    }
    return client;
  }

  async provideLanguageModelChatResponse(
    model: { id: string },
    messages: readonly InstanceType<typeof LanguageModelChatMessage>[],
    options: { tools?: readonly unknown[] },
    progress: { report: (part: unknown) => void },
    token: { isCancellationRequested: boolean; onCancellationRequested: (fn: () => void) => { dispose: () => void } }
  ): Promise<void> {
    const found = this.findProviderAndModel(model.id);
    if (!found) {
      throw new Error(`Model not found: ${model.id}`);
    }

    const { provider, model: modelConfig } = found;
    const client = this.getClient(provider);

    const { system, messages: convertedMessages } = client.convertMessages(messages);
    const tools = options.tools ? client.convertTools(options.tools) : undefined;

    const stream = client.streamChat(
      convertedMessages,
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

  async provideTokenCount(
    model: { id: string },
    text: string | InstanceType<typeof LanguageModelChatMessage>,
    _token: { isCancellationRequested: boolean }
  ): Promise<number> {
    const found = this.findProviderAndModel(model.id);

    let content: string;
    if (typeof text === 'string') {
      content = text;
    } else {
      content = text.content
        .map((part) => {
          if (part instanceof LanguageModelTextPart) {
            return part.value;
          }
          return '';
        })
        .join('');
    }

    if (found) {
      const client = this.getClient(found.provider);
      return client.estimateTokenCount(content);
    }

    return Math.ceil(content.length / 4);
  }

  clearClients(): void {
    this.clients.clear();
  }

  getClientCount(): number {
    return this.clients.size;
  }
}

describe('UnifyChatProvider', () => {
  let configStore: MockConfigStore;
  let provider: TestableUnifyChatProvider;
  let cancellationSource: CancellationTokenSource;

  beforeEach(() => {
    configStore = new MockConfigStore();
    provider = new TestableUnifyChatProvider(configStore);
    cancellationSource = new CancellationTokenSource();
  });

  describe('provideLanguageModelChatInformation', () => {
    it('should return empty array when no endpoints configured', () => {
      configStore.setEndpoints([]);
      const models = provider.provideLanguageModelChatInformation({ silent: false }, cancellationSource.token);
      assert.deepStrictEqual(models, []);
    });

    it('should return model info for all configured models', () => {
      configStore.setEndpoints([
        createTestProviderConfig({
          name: 'Provider1',
          models: [
            { id: 'model-a', name: 'Model A' },
            { id: 'model-b' },
          ],
        }),
      ]);

      const models = provider.provideLanguageModelChatInformation({ silent: false }, cancellationSource.token);

      assert.strictEqual(models.length, 2);
      assert.strictEqual(models[0].id, 'provider1/model-a');
      assert.strictEqual(models[0].name, 'Model A');
      assert.strictEqual(models[0].family, 'Provider1');
      assert.strictEqual(models[1].id, 'provider1/model-b');
      assert.strictEqual(models[1].name, 'model-b'); // Falls back to ID
    });

    it('should use default token limits when not specified', () => {
      configStore.setEndpoints([
        createTestProviderConfig({
          models: [{ id: 'model-1' }],
        }),
      ]);

      const models = provider.provideLanguageModelChatInformation({ silent: false }, cancellationSource.token);

      assert.strictEqual(models[0].maxInputTokens, DEFAULT_MAX_INPUT_TOKENS);
      assert.strictEqual(models[0].maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS);
    });

    it('should use custom token limits when specified', () => {
      configStore.setEndpoints([
        createTestProviderConfig({
          models: [{ id: 'model-1', maxInputTokens: 50000, maxOutputTokens: 2000 }],
        }),
      ]);

      const models = provider.provideLanguageModelChatInformation({ silent: false }, cancellationSource.token);

      assert.strictEqual(models[0].maxInputTokens, 50000);
      assert.strictEqual(models[0].maxOutputTokens, 2000);
    });

    it('should include capabilities for all models', () => {
      configStore.setEndpoints([createTestProviderConfig()]);

      const models = provider.provideLanguageModelChatInformation({ silent: false }, cancellationSource.token);

      assert.strictEqual(models[0].capabilities.toolCalling, true);
      assert.strictEqual(models[0].capabilities.imageInput, true);
    });

    it('should handle multiple providers', () => {
      configStore.setEndpoints([
        createTestProviderConfig({ name: 'Provider1', models: [{ id: 'model-1' }] }),
        createTestProviderConfig({ name: 'Provider2', models: [{ id: 'model-2' }, { id: 'model-3' }] }),
      ]);

      const models = provider.provideLanguageModelChatInformation({ silent: false }, cancellationSource.token);

      assert.strictEqual(models.length, 3);
      assert.strictEqual(models[0].family, 'Provider1');
      assert.strictEqual(models[1].family, 'Provider2');
      assert.strictEqual(models[2].family, 'Provider2');
    });
  });

  describe('sanitizeName', () => {
    it('should convert to lowercase', () => {
      assert.strictEqual(provider.sanitizeName('ProviderName'), 'providername');
    });

    it('should replace spaces with dashes', () => {
      assert.strictEqual(provider.sanitizeName('My Provider'), 'my-provider');
    });

    it('should replace special characters with dashes', () => {
      assert.strictEqual(provider.sanitizeName('Test@Provider!123'), 'test-provider-123');
    });

    it('should keep alphanumeric and dashes', () => {
      assert.strictEqual(provider.sanitizeName('test-provider-123'), 'test-provider-123');
    });
  });

  describe('parseModelId', () => {
    it('should parse valid model ID', () => {
      const result = provider.parseModelId('provider/model-name');
      assert.deepStrictEqual(result, {
        providerName: 'provider',
        modelName: 'model-name',
      });
    });

    it('should return null for invalid model ID without slash', () => {
      const result = provider.parseModelId('invalid-id');
      assert.strictEqual(result, null);
    });

    it('should handle model ID with multiple slashes', () => {
      const result = provider.parseModelId('provider/model/version');
      assert.deepStrictEqual(result, {
        providerName: 'provider',
        modelName: 'model/version',
      });
    });
  });

  describe('findProviderAndModel', () => {
    beforeEach(() => {
      configStore.setEndpoints([
        createTestProviderConfig({
          name: 'Test Provider',
          models: [
            { id: 'model-1', name: 'Model One' },
            { id: 'model-2' },
          ],
        }),
      ]);
    });

    it('should find provider and model by sanitized ID', () => {
      const result = provider.findProviderAndModel('test-provider/model-1');
      assert.ok(result);
      assert.strictEqual(result.provider.name, 'Test Provider');
      assert.strictEqual(result.model.id, 'model-1');
    });

    it('should return null for unknown provider', () => {
      const result = provider.findProviderAndModel('unknown/model-1');
      assert.strictEqual(result, null);
    });

    it('should return null for unknown model', () => {
      const result = provider.findProviderAndModel('test-provider/unknown-model');
      assert.strictEqual(result, null);
    });

    it('should return null for invalid model ID', () => {
      const result = provider.findProviderAndModel('invalid-id');
      assert.strictEqual(result, null);
    });
  });

  describe('provideLanguageModelChatResponse', () => {
    let mockClient: MockApiClient;

    beforeEach(() => {
      mockClient = new MockApiClient();
      provider.setClientFactory(() => mockClient);
      configStore.setEndpoints([
        createTestProviderConfig({
          name: 'Test Provider',
          models: [{ id: 'test-model', maxOutputTokens: 4096 }],
        }),
      ]);
    });

    it('should throw error for unknown model', async () => {
      const progress = createProgress();

      await assertThrowsAsync(
        async () => {
          await provider.provideLanguageModelChatResponse(
            { id: 'unknown/model' },
            [],
            {},
            progress,
            cancellationSource.token
          );
        },
        'Model not found'
      );
    });

    it('should stream response parts to progress', async () => {
      mockClient.setStreamResponse([
        new LanguageModelTextPart('Hello'),
        new LanguageModelTextPart(' world'),
      ]);

      const progress = createProgress();

      await provider.provideLanguageModelChatResponse(
        { id: 'test-provider/test-model' },
        [LanguageModelChatMessage.User('Hi')],
        {},
        progress,
        cancellationSource.token
      );

      assert.strictEqual(progress.values.length, 2);
      assert.ok(progress.values[0] instanceof LanguageModelTextPart);
      assert.strictEqual((progress.values[0] as InstanceType<typeof LanguageModelTextPart>).value, 'Hello');
    });

    it('should pass converted messages to client', async () => {
      const progress = createProgress();

      await provider.provideLanguageModelChatResponse(
        { id: 'test-provider/test-model' },
        [LanguageModelChatMessage.User('Test message')],
        {},
        progress,
        cancellationSource.token
      );

      assert.strictEqual(mockClient.streamChatCalls.length, 1);
      assert.ok(mockClient.streamChatCalls[0].messages.length > 0);
    });

    it('should pass model ID to client', async () => {
      const progress = createProgress();

      await provider.provideLanguageModelChatResponse(
        { id: 'test-provider/test-model' },
        [],
        {},
        progress,
        cancellationSource.token
      );

      assert.strictEqual(mockClient.streamChatCalls[0].modelId, 'test-model');
    });

    it('should use model maxOutputTokens', async () => {
      const progress = createProgress();

      await provider.provideLanguageModelChatResponse(
        { id: 'test-provider/test-model' },
        [],
        {},
        progress,
        cancellationSource.token
      );

      assert.strictEqual(mockClient.streamChatCalls[0].options.maxTokens, 4096);
    });

    it('should convert and pass tools', async () => {
      const progress = createProgress();
      const tools = [{ name: 'test-tool', description: 'A test tool', inputSchema: {} }];

      await provider.provideLanguageModelChatResponse(
        { id: 'test-provider/test-model' },
        [],
        { tools },
        progress,
        cancellationSource.token
      );

      assert.ok(mockClient.streamChatCalls[0].options.tools);
      assert.strictEqual((mockClient.streamChatCalls[0].options.tools as Array<{ converted: boolean }>)[0].converted, true);
    });

    it('should stop streaming when cancelled', async () => {
      // Create a client that yields multiple parts
      const customClient = new MockApiClient();
      customClient.streamChat = async function* (_messages, _modelId, _options, _token) {
        yield new LanguageModelTextPart('Part 1');
        yield new LanguageModelTextPart('Part 2');
        yield new LanguageModelTextPart('Part 3');
      };

      provider.clearClients();
      provider.setClientFactory(() => customClient);

      const progress = createProgress();

      // Cancel immediately - the provider checks cancellation before reporting
      // so nothing should be reported when cancelled before streaming starts
      cancellationSource.cancel();

      await provider.provideLanguageModelChatResponse(
        { id: 'test-provider/test-model' },
        [],
        {},
        progress,
        cancellationSource.token
      );

      // When cancelled before streaming, nothing should be reported
      assert.strictEqual(progress.values.length, 0);
    });
  });

  describe('provideTokenCount', () => {
    let mockClient: MockApiClient;

    beforeEach(() => {
      mockClient = new MockApiClient();
      provider.setClientFactory(() => mockClient);
      configStore.setEndpoints([
        createTestProviderConfig({
          name: 'Test Provider',
          models: [{ id: 'test-model' }],
        }),
      ]);
    });

    it('should estimate tokens for string input', async () => {
      const count = await provider.provideTokenCount(
        { id: 'test-provider/test-model' },
        'Hello world!',
        cancellationSource.token
      );

      // 12 chars / 4 = 3
      assert.strictEqual(count, 3);
    });

    it('should estimate tokens for message input', async () => {
      const message = LanguageModelChatMessage.User('Test message');

      const count = await provider.provideTokenCount(
        { id: 'test-provider/test-model' },
        message,
        cancellationSource.token
      );

      // "Test message" = 12 chars / 4 = 3
      assert.strictEqual(count, 3);
    });

    it('should use default estimation for unknown model', async () => {
      const count = await provider.provideTokenCount(
        { id: 'unknown/model' },
        'Test',
        cancellationSource.token
      );

      // 4 chars / 4 = 1
      assert.strictEqual(count, 1);
    });

    it('should concatenate multiple text parts in message', async () => {
      const message = new LanguageModelChatMessage(1, [
        new LanguageModelTextPart('Hello'),
        new LanguageModelTextPart(' world'),
      ]);

      const count = await provider.provideTokenCount(
        { id: 'test-provider/test-model' },
        message,
        cancellationSource.token
      );

      // "Hello world" = 11 chars / 4 = 2.75 -> ceil = 3
      assert.strictEqual(count, 3);
    });

    it('should ignore non-text parts in message', async () => {
      const message = new LanguageModelChatMessage(1, [
        new LanguageModelTextPart('Hello'),
        new LanguageModelToolCallPart('call-1', 'tool', {}),
      ]);

      const count = await provider.provideTokenCount(
        { id: 'test-provider/test-model' },
        message,
        cancellationSource.token
      );

      // "Hello" = 5 chars / 4 = 1.25 -> ceil = 2
      assert.strictEqual(count, 2);
    });
  });

  describe('client caching', () => {
    let createCount: number;

    beforeEach(() => {
      createCount = 0;
      provider.setClientFactory(() => {
        createCount++;
        return new MockApiClient();
      });
      configStore.setEndpoints([
        createTestProviderConfig({ name: 'Provider1', models: [{ id: 'model-1' }] }),
        createTestProviderConfig({ name: 'Provider2', models: [{ id: 'model-2' }] }),
      ]);
    });

    it('should cache client per provider', async () => {
      const progress = createProgress();

      await provider.provideLanguageModelChatResponse(
        { id: 'provider1/model-1' },
        [],
        {},
        progress,
        cancellationSource.token
      );

      await provider.provideLanguageModelChatResponse(
        { id: 'provider1/model-1' },
        [],
        {},
        progress,
        cancellationSource.token
      );

      assert.strictEqual(createCount, 1);
    });

    it('should create separate clients for different providers', async () => {
      const progress = createProgress();

      await provider.provideLanguageModelChatResponse(
        { id: 'provider1/model-1' },
        [],
        {},
        progress,
        cancellationSource.token
      );

      await provider.provideLanguageModelChatResponse(
        { id: 'provider2/model-2' },
        [],
        {},
        progress,
        cancellationSource.token
      );

      assert.strictEqual(createCount, 2);
    });

    it('should clear cached clients', async () => {
      const progress = createProgress();

      await provider.provideLanguageModelChatResponse(
        { id: 'provider1/model-1' },
        [],
        {},
        progress,
        cancellationSource.token
      );

      assert.strictEqual(provider.getClientCount(), 1);

      provider.clearClients();

      assert.strictEqual(provider.getClientCount(), 0);
    });
  });
});
