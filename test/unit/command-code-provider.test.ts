import type * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestLogger } from '../../src/logger';
import type { ChatRequestTrace, ModelConfig, ProviderConfig } from '../../src/types';

const state = vi.hoisted(() => ({
  anthropicConfigs: [] as unknown[],
  anthropicGetAvailableModels: vi.fn(),
  anthropicStreamChat: vi.fn(),
  fetch: vi.fn(),
  httpError: vi.fn(),
  openAIConfigs: [] as unknown[],
  openAIGetAvailableModels: vi.fn(),
  openAIEstimateTokenCount: vi.fn((_text: string) => 17),
  openAIStreamChat: vi.fn(),
}));

vi.mock('vscode', () => ({
  env: { language: 'en' },
  extensions: { getExtension: () => undefined },
  LanguageModelChatToolMode: { Auto: 1 },
  l10n: {
    t: (message: string | { message: string }) =>
      typeof message === 'string' ? message : message.message,
  },
}));

vi.mock('../../src/logger', () => ({
  createSimpleHttpLogger: () => ({ error: state.httpError }),
}));

vi.mock('../../src/utils', () => ({
  DEFAULT_NORMAL_TIMEOUT_CONFIG: {
    connection: 30_000,
    response: 30_000,
  },
  resolveChatNetwork: () => ({
    retry: { maxRetries: 0 },
    proxy: { type: 'direct' },
  }),
}));

vi.mock('../../src/client/utils', () => ({
  createCustomFetch: () => state.fetch,
  getToken: (credential: { kind: string; token?: string }) =>
    credential.kind === 'token' ? credential.token : undefined,
  getTokenType: (credential: { kind: string; tokenType?: string }) =>
    credential.kind === 'token' ? credential.tokenType : undefined,
  getUnifiedUserAgent: () => 'ucp/test',
  matchProvider: (url: string, pattern: string | RegExp) =>
    typeof pattern === 'string'
      ? url.includes(pattern.replaceAll('*', ''))
      : pattern.test(url),
  mergeHeaders: (
    _token: string | undefined,
    ...sources: Array<Record<string, string> | undefined>
  ) => Object.assign({}, ...sources.filter((source) => source !== undefined)),
  setUserAgentHeader: (headers: Record<string, string>, value: string) => {
    headers['User-Agent'] = value;
  },
}));

vi.mock('../../src/client/anthropic/client', () => ({
  AnthropicProvider: class AnthropicProvider {
    constructor(config: unknown) {
      state.anthropicConfigs.push(config);
    }

    async *streamChat(...args: unknown[]): AsyncGenerator<never> {
      state.anthropicStreamChat(...args);
    }

    estimateTokenCount(): number {
      return 13;
    }

    async getAvailableModels(): Promise<ModelConfig[]> {
      state.anthropicGetAvailableModels();
      return [];
    }
  },
}));

vi.mock('../../src/client/openai/chat-completion-client', () => ({
  OpenAIChatCompletionProvider: class OpenAIChatCompletionProvider {
    constructor(config: unknown) {
      state.openAIConfigs.push(config);
    }

    async *streamChat(...args: unknown[]): AsyncGenerator<never> {
      state.openAIStreamChat(...args);
    }

    estimateTokenCount(text: string): number {
      return state.openAIEstimateTokenCount(text);
    }

    async getAvailableModels(): Promise<ModelConfig[]> {
      state.openAIGetAvailableModels();
      return [];
    }
  },
}));

import {
  COMMAND_CODE_API_BASE_URL,
  COMMAND_CODE_CHAT_COMPLETIONS_URL,
  COMMAND_CODE_MESSAGES_URL,
  COMMAND_CODE_MODELS_URL,
  CommandCodeProvider,
  createCommandCodeDelegateConfigs,
  parseCommandCodeModelsResponse,
  resolveCommandCodeProtocol,
} from '../../src/client/command-code/provider';
import * as vscodeApi from 'vscode';
import { resolveEmptyChatResponsePolicy } from '../../src/client/interface';
import { createVsCodeModelId, parseVsCodeModelId } from '../../src/model-id-utils';
import { WELL_KNOWN_PROVIDERS } from '../../src/well-known/providers';

function commandCodeConfig(): ProviderConfig {
  return {
    type: 'command-code',
    name: 'Command Code',
    baseUrl: COMMAND_CODE_API_BASE_URL,
    useRawBaseUrl: true,
    transport: 'sse',
    serviceTier: 'priority',
    auth: { method: 'api-key', apiKey: 'secret-ref' },
    extraHeaders: { 'x-cmd-zdr': '1' },
    extraBody: { shared_provider_option: true },
    models: [],
    autoFetchOfficialModels: true,
  };
}

function trace(): ChatRequestTrace {
  return {
    performance: {
      tts: 0,
      ttf: 0,
      ttft: 0,
      tps: 0,
      tl: 0,
    },
  };
}

function cancellationToken(): vscode.CancellationToken {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => undefined }),
  };
}

async function consume(source: AsyncIterable<unknown>): Promise<void> {
  for await (const part of source) {
    void part;
  }
}

beforeEach(() => {
  state.anthropicConfigs = [];
  state.anthropicGetAvailableModels.mockReset();
  state.anthropicStreamChat.mockReset();
  state.fetch.mockReset();
  state.httpError.mockReset();
  state.openAIConfigs = [];
  state.openAIGetAvailableModels.mockReset();
  state.openAIEstimateTokenCount.mockClear();
  state.openAIStreamChat.mockReset();
});

describe('Command Code provider facade', () => {
  it('registers one well-known provider and constructs both protocol delegates', () => {
    const providers = WELL_KNOWN_PROVIDERS.filter(
      (provider) => provider.name === 'Command Code',
    );
    expect(providers).toEqual([
      expect.objectContaining({
        type: 'command-code',
        baseUrl: COMMAND_CODE_API_BASE_URL,
        authTypes: ['api-key'],
        models: [],
        autoFetchOfficialModels: true,
      }),
    ]);

    const config = commandCodeConfig();
    const delegates = createCommandCodeDelegateConfigs(config);

    expect(delegates.openAI).toMatchObject({
      type: 'openai-chat-completion',
      baseUrl: COMMAND_CODE_API_BASE_URL,
      useRawBaseUrl: false,
      transport: 'sse',
      serviceTier: 'priority',
      extraBody: { shared_provider_option: true },
    });
    expect(delegates.anthropic).toMatchObject({
      type: 'anthropic',
      baseUrl: COMMAND_CODE_API_BASE_URL,
      useRawBaseUrl: false,
      transport: 'sse',
      serviceTier: 'priority',
      extraBody: { shared_provider_option: true },
    });
    expect(delegates.openAI.auth).toBe(config.auth);
    expect(delegates.anthropic.auth).toBe(config.auth);
    expect(delegates.openAI.extraHeaders).toBe(config.extraHeaders);
    expect(delegates.anthropic.extraHeaders).toBe(config.extraHeaders);
    expect(delegates.openAI.models).toBe(config.models);
    expect(delegates.anthropic.models).toBe(config.models);
    expect(`${delegates.openAI.baseUrl}/chat/completions`).toBe(
      COMMAND_CODE_CHAT_COMPLETIONS_URL,
    );
    expect(
      `${delegates.anthropic.baseUrl.replace(/\/v1$/, '')}/v1/messages`,
    ).toBe(COMMAND_CODE_MESSAGES_URL);

    new CommandCodeProvider(config);
    expect(state.openAIConfigs).toEqual([delegates.openAI]);
    expect(state.anthropicConfigs).toEqual([delegates.anthropic]);
  });

  it.each([
    [{ id: 'claude-sonnet-5' }, 'anthropic-messages'],
    [{ id: 'anthropic/sonnet-next' }, 'anthropic-messages'],
    [{ id: 'vendor/claude3-model' }, 'anthropic-messages'],
    [{ id: 'vendor/models/CLAUDE-sonnet-next' }, 'anthropic-messages'],
    [{ id: 'vendor/models/ClaudeSonnetNext' }, 'anthropic-messages'],
    [{ id: 'opaque-id', family: 'Anthropic Claude' }, 'anthropic-messages'],
    [
      { id: 'opaque-id', name: '  CLAUDE Model With Opaque ID  ' },
      'anthropic-messages',
    ],
    [{ id: 'claudette-code' }, 'openai-chat-completions'],
    [{ id: 'claudemeter/model' }, 'openai-chat-completions'],
    [{ id: 'anthropicist/model' }, 'openai-chat-completions'],
    [{ id: 'deepseek/deepseek-v4-flash' }, 'openai-chat-completions'],
    [{ id: 'opaque-id', name: 'Unknown Frontier Model' }, 'openai-chat-completions'],
  ] as const)('routes model identity %o through %s', (model, expected) => {
    expect(resolveCommandCodeProtocol(model)).toBe(expected);
  });

  it('forwards every stream argument and preserves model-level overrides', async () => {
    const provider = new CommandCodeProvider(commandCodeConfig());
    const claudeModel: ModelConfig = {
      id: 'opaque-id',
      name: 'Claude Opaque',
      serviceTier: 'standard',
      extraBody: { model_option: 'override' },
    };
    const openAIModel: ModelConfig = {
      id: 'gpt-5.6-sol',
      serviceTier: 'flex',
      extraBody: { model_option: 'openai' },
    };
    const messages: readonly vscode.LanguageModelChatRequestMessage[] = [];
    const options: vscode.ProvideLanguageModelChatResponseOptions = {
      requestInitiator: 'test',
      toolMode: vscodeApi.LanguageModelChatToolMode.Auto,
      tools: [],
    };
    const requestTrace = trace();
    const token = cancellationToken();
    const logger = Object.create(null) as RequestLogger;
    const credential = {
      kind: 'token',
      token: 'command-code-key',
      tokenType: 'Bearer',
    } as const;
    const refreshCredential = vi.fn(async () => credential);

    await consume(
      provider.streamChat(
        'Command Code/opaque-id',
        claudeModel,
        messages,
        options,
        requestTrace,
        token,
        logger,
        credential,
        refreshCredential,
      ),
    );
    expect(state.anthropicStreamChat).toHaveBeenCalledWith(
      'Command Code/opaque-id',
      claudeModel,
      messages,
      options,
      requestTrace,
      token,
      logger,
      credential,
      refreshCredential,
    );
    expect(state.openAIStreamChat).not.toHaveBeenCalled();

    await consume(
      provider.streamChat(
        'Command Code/gpt-5.6-sol',
        openAIModel,
        messages,
        options,
        requestTrace,
        token,
        logger,
        credential,
        refreshCredential,
      ),
    );
    expect(state.openAIStreamChat).toHaveBeenCalledWith(
      'Command Code/gpt-5.6-sol',
      openAIModel,
      messages,
      options,
      requestTrace,
      token,
      logger,
      credential,
      refreshCredential,
    );
    expect(provider.estimateTokenCount('count me')).toBe(17);
    expect(state.openAIEstimateTokenCount).toHaveBeenCalledWith('count me');
  });

  it('uses the Anthropic empty-response policy only for Messages models', () => {
    const provider = new CommandCodeProvider(commandCodeConfig());
    expect(
      resolveEmptyChatResponsePolicy({}, provider, {
        id: 'opaque-id',
        name: 'Claude Opaque',
      }),
    ).toBe('success');
    expect(
      resolveEmptyChatResponsePolicy({}, provider, { id: 'gpt-5.6-sol' }),
    ).toBe('retry');
    expect(
      resolveEmptyChatResponsePolicy(
        { emptyChatResponsePolicy: 'success' },
        {},
        { id: 'any-model' },
      ),
    ).toBe('success');
  });

  it('fetches one strict catalog and preserves context_length', async () => {
    state.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          object: 'list',
          data: [
            {
              id: 'opaque-id',
              object: 'model',
              created: 1_787_812_951,
              owned_by: 'command-code',
              name: 'Claude Opaque',
              context_length: 1_000_000,
            },
            {
              id: 'gpt-5.6-sol',
              object: 'model',
              created: 1_787_812_952,
              owned_by: 'command-code',
              name: 'GPT 5.6 Sol',
              context_length: 400_000,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const provider = new CommandCodeProvider(commandCodeConfig());
    const abortController = new AbortController();

    const models = await provider.getAvailableModels(
      {
        kind: 'token',
        token: 'command-code-key',
        tokenType: 'Bearer',
      },
      undefined,
      abortController.signal,
    );

    expect(state.fetch).toHaveBeenCalledOnce();
    expect(state.fetch).toHaveBeenCalledWith(
      COMMAND_CODE_MODELS_URL,
      expect.objectContaining({
        method: 'GET',
        signal: abortController.signal,
        headers: expect.objectContaining({
          Accept: 'application/json',
          Authorization: 'Bearer command-code-key',
          'User-Agent': 'ucp/test',
          'x-cmd-zdr': '1',
        }),
      }),
    );
    expect(state.anthropicGetAvailableModels).not.toHaveBeenCalled();
    expect(state.openAIGetAvailableModels).not.toHaveBeenCalled();
    expect(models).toEqual([
      {
        id: 'opaque-id',
        name: 'Claude Opaque',
        maxInputTokens: 1_000_000,
      },
      {
        id: 'gpt-5.6-sol',
        name: 'GPT 5.6 Sol',
        maxInputTokens: 400_000,
      },
    ]);
  });

  it('rejects malformed current catalog fields without requiring supported_endpoints', () => {
    expect(() =>
      parseCommandCodeModelsResponse({
        object: 'list',
        data: [
          {
            id: 'valid-without-supported-endpoints',
            object: 'model',
            created: 1,
            owned_by: 'command-code',
            name: 'Valid Model',
            context_length: 128_000,
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      parseCommandCodeModelsResponse({
        object: 'list',
        data: [
          {
            id: 'invalid-context',
            object: 'model',
            created: 1,
            owned_by: 'command-code',
            name: 'Invalid Model',
            context_length: '128000',
          },
        ],
      }),
    ).toThrow('context_length must be a positive integer');
  });

  it('keeps one provider/model identity for the VS Code UI', () => {
    const encoded = createVsCodeModelId('Command Code', 'opaque/model');
    expect(parseVsCodeModelId(encoded)).toEqual({
      providerName: 'Command Code',
      modelName: 'opaque/model',
    });
  });
});
