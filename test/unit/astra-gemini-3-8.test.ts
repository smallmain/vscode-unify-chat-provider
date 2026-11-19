import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class EventEmitter<T> {
    readonly event = (_listener: (value: T) => unknown) => ({
      dispose: () => undefined,
    });
    fire(_value: T): void {}
    dispose(): void {}
  }

  class ThemeIcon {
    constructor(readonly id: string) {}
  }

  class LanguageModelTextPart {
    constructor(readonly value: string) {}
  }

  class LanguageModelThinkingPart {
    constructor(
      readonly value: string | string[],
      readonly id?: string,
      readonly metadata?: object,
    ) {}
  }

  return {
    env: { language: 'en' },
    LanguageModelTextPart,
    LanguageModelThinkingPart,
    LanguageModelChatMessageRole: {
      System: 1,
      User: 2,
      Assistant: 3,
    },
    EventEmitter,
    ThemeIcon,
    extensions: { getExtension: () => undefined },
    l10n: {
      t: (message: string | { message: string }) =>
        typeof message === 'string' ? message : message.message,
    },
    workspace: {
      getConfiguration: () => ({
        get: (_key: string, fallback?: unknown) => fallback,
      }),
    },
  };
});

import { FeatureId } from '../../src/client/definitions';
import { GoogleAIStudioProvider } from '../../src/client/google/ai-studio-client';
import { OpenAIChatCompletionProvider } from '../../src/client/openai/chat-completion-client';
import { OpenAIResponsesProvider } from '../../src/client/openai/responses-client';
import { isFeatureSupported } from '../../src/client/utils';
import {
  applyPresetTemplateSelections,
  buildPresetTemplateConfigurationSchema,
} from '../../src/preset-templates';
import type { ModelConfig, ProviderConfig } from '../../src/types';
import { mergeWithWellKnownModel } from '../../src/well-known/models';
import {
  resolveProviderModels,
  WELL_KNOWN_PROVIDERS,
} from '../../src/well-known/providers';

function resolveModel(providerName: string, modelId: string): ModelConfig {
  const provider = WELL_KNOWN_PROVIDERS.find(
    (candidate) => candidate.name === providerName,
  );
  if (!provider) throw new Error(`Missing provider: ${providerName}`);
  const model = resolveProviderModels(provider).find(
    (candidate) => candidate.id === modelId,
  );
  if (!model) throw new Error(`Missing model: ${modelId}`);
  return model;
}

function invokeBuilder(
  client: object,
  method: string,
  args: readonly unknown[],
): unknown {
  const builder: unknown = Reflect.get(client, method);
  if (typeof builder !== 'function') {
    throw new Error(`Missing builder: ${method}`);
  }
  return Reflect.apply(builder, client, args);
}

const openaiConfig: ProviderConfig = {
  name: 'OpenAI test',
  type: 'openai-responses',
  baseUrl: 'https://api.openai.com/v1',
  models: [],
};
const googleConfig: ProviderConfig = {
  name: 'Google test',
  type: 'google-ai-studio',
  baseUrl: 'https://generativelanguage.googleapis.com',
  models: [],
};

describe('GPT-6 Astra provider and request compatibility', () => {
  const model = resolveModel('Open AI', 'gpt-6-astra');
  const client = new OpenAIResponsesProvider(openaiConfig);

  it.each(['max', 'xhigh', 'high', 'medium', 'low'])(
    'preserves the %s preset alongside mode and context in Responses',
    (effort) => {
      const selected = applyPresetTemplateSelections(model, {
        reasoningEffort: effort,
        reasoningMode: 'pro',
        reasoningContext: 'all_turns',
      });
      expect(
        invokeBuilder(client, 'buildReasoningParams', [selected, false]),
      ).toEqual({ reasoning: { effort, mode: 'pro', context: 'all_turns' } });
    },
  );

  it('offers only supported effort levels and resolves the defaults', () => {
    expect(
      buildPresetTemplateConfigurationSchema(model)?.properties?.['reasoningEffort'],
    ).toMatchObject({
      enum: ['max', 'xhigh', 'high', 'medium', 'low'],
      default: 'max',
    });
    expect(invokeBuilder(client, 'buildReasoningParams', [
      applyPresetTemplateSelections(model, undefined),
      false,
    ])).toEqual({
      reasoning: { effort: 'max', mode: 'standard', context: 'auto' },
    });
  });

  it.each([
    { id: 'gpt-6-astra#reasoningEffort=max', expected: 'max' },
    { id: 'deployment', family: 'gpt-6-astra', expected: 'max' },
    { id: 'gpt-6.1-terra#reasoningEffort=max', expected: 'max' },
    { id: 'deployment', family: 'gpt-6.1-terra', expected: 'max' },
    { id: 'gpt-6.1-terrarium', expected: 'xhigh' },
    { id: 'gpt-5.6-sol', expected: 'max' },
    { id: 'gpt-5.4', expected: 'xhigh' },
    { id: 'gpt-6-astral', expected: 'xhigh' },
  ])('normalizes max effort for $id without changing older models', (entry) => {
    const configured: ModelConfig = {
      id: entry.id,
      family: entry.family,
      thinking: { type: 'enabled', effort: 'max' },
    };
    expect(
      invokeBuilder(client, 'buildReasoningParams', [configured, false]),
    ).toEqual({ reasoning: { effort: entry.expected } });
  });

  it('uses Responses for tools and configures Chat Completions correctly', () => {
    const chatConfig: ProviderConfig = {
      ...openaiConfig,
      type: 'openai-chat-completion',
    };
    const chatModel = mergeWithWellKnownModel({ id: model.id }, chatConfig);
    expect(model.capabilities?.toolCalling).toBe(true);
    expect(chatModel.capabilities).toMatchObject({
      toolCalling: false,
      imageInput: true,
    });
    expect(isFeatureSupported(
      FeatureId.OpenAIOnlyMaxCompletionTokens, chatConfig, chatModel,
    )).toBe(true);
    expect(invokeBuilder(
      new OpenAIChatCompletionProvider(chatConfig),
      'buildReasoningParams',
      [
        applyPresetTemplateSelections(chatModel, { reasoningEffort: 'max' }),
        'official',
      ],
    )).toEqual({ reasoning_effort: 'max' });
    expect(model).toMatchObject({
      maxInputTokens: 1050000,
      maxOutputTokens: 128000,
    });
  });
});

describe('Gemini 3.8 Flash provider and request compatibility', () => {
  const model = resolveModel('Google AI Studio', 'gemini-3.8-flash');
  const client = new GoogleAIStudioProvider(googleConfig);

  it.each(['high', 'medium', 'low'])(
    'sends thinkingLevel for the %s preset without thinkingBudget',
    (effort) => {
      for (const id of ['gemini-3.8-flash', 'models/gemini-3.8-flash#custom']) {
        const selected = applyPresetTemplateSelections(
          mergeWithWellKnownModel({ id }),
          { reasoningEffort: effort },
        );
        const useThinkingLevel = isFeatureSupported(
          FeatureId.GeminiUseThinkingLevel,
          googleConfig,
          selected,
        );
        expect(invokeBuilder(client, 'buildThinkingConfig', [
          selected, useThinkingLevel,
        ])).toEqual({
          thinkingConfig: {
            includeThoughts: true,
            thinkingLevel: effort.toUpperCase(),
          },
        });
      }
    },
  );

  it('excludes minimal from the schema and shares the official limits with Vertex AI', () => {
    expect(
      buildPresetTemplateConfigurationSchema(model)?.properties?.['reasoningEffort'],
    ).toMatchObject({ enum: ['high', 'medium', 'low'], default: 'medium' });
    expect(resolveModel('Google Vertex AI', model.id)).toEqual(model);
    expect(model).toMatchObject({
      maxInputTokens: 1048576,
      maxOutputTokens: 65536,
    });
    const selected = applyPresetTemplateSelections(model, undefined);
    expect(
      invokeBuilder(client, 'buildThinkingConfig', [selected, true]),
    ).toEqual({
      thinkingConfig: { includeThoughts: true, thinkingLevel: 'MEDIUM' },
    });
  });

  it('continues to use token budgets for Gemini 2.5', () => {
    expect(isFeatureSupported(FeatureId.GeminiUseThinkingLevel, googleConfig, {
      id: 'gemini-2.5-flash',
    })).toBe(false);
  });

  it('drops empty plain text history parts but keeps signature-only thoughts', () => {
    const contents = [
      {
        role: 'model',
        parts: [{ text: '' }, { thought: true, thoughtSignature: 'sig' }],
      },
    ];

    const removeEmptyTextParts = Reflect.get(client, 'removeEmptyTextParts');
    if (typeof removeEmptyTextParts !== 'function') {
      throw new Error('Missing removeEmptyTextParts');
    }
    removeEmptyTextParts.call(client, contents);

    expect(contents).toEqual([{
      role: 'model',
      parts: [{ thought: true, thoughtSignature: 'sig' }],
    }]);
  });

  it('sanitizes tool schemas for native Gemini requests', () => {
    const tools = invokeBuilder(client, 'convertTools', [[{
      name: 'open_browser_page',
      description: 'Open a page',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Page URL',
            '$comment': 'unsupported',
          },
        },
        required: ['url'],
        '$schema': 'https://json-schema.org/draft/2020-12/schema',
      },
    }]]) as Array<{ functionDeclarations: Array<{ parametersJsonSchema: Record<string, unknown> }> }>;

    const schema = tools[0]?.functionDeclarations[0]?.parametersJsonSchema;
    expect(schema).toMatchObject({
      type: 'object',
      properties: { url: { type: 'string', description: 'Page URL' } },
      required: ['url'],
    });
    expect(schema).not.toHaveProperty('$schema');
    expect(schema.properties).not.toHaveProperty('url.$comment');
  });

  it.each([
    { label: 'text', text: 'internal reasoning' },
    { label: 'signature-only', text: undefined },
  ])('emits Gemini $label thought signatures in VS Code thinking metadata', async ({ text }) => {
    const parseMessage = Reflect.get(client, 'parseMessage');
    if (typeof parseMessage !== 'function') {
      throw new Error('Missing parseMessage');
    }

    const response = parseMessage.call(
      client,
      {
        candidates: [{
          content: {
            role: 'model',
            parts: [{
              thought: true,
              ...(text ? { text } : {}),
              thoughtSignature: 'gemini-signature',
            }],
          },
        }],
      },
      { performance: {} },
      { providerResponseChunk: () => undefined },
      'test-identity',
    ) as AsyncGenerator<unknown>;

    const first = await response.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({
      value: text ?? '',
      metadata: { signature: 'gemini-signature' },
    });
  });

  it('emits a signature-only thought delta from streaming metadata', async () => {
    const parseMessageStream = Reflect.get(client, 'parseMessageStream');
    if (typeof parseMessageStream !== 'function') {
      throw new Error('Missing parseMessageStream');
    }

    async function* chunks(): AsyncGenerator<unknown> {
      yield {
        candidates: [{
          content: {
            role: 'model',
            parts: [{
              thought: true,
              thoughtSignature: 'streaming-gemini-signature',
            }],
          },
        }],
      };
    }

    const response = parseMessageStream.call(
      client,
      chunks(),
      { isCancellationRequested: false },
      { providerResponseChunk: () => undefined },
      { performance: {} },
      'test-identity',
    ) as AsyncGenerator<unknown>;

    const first = await response.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({
      value: '',
      metadata: { signature: 'streaming-gemini-signature' },
    });
  });
});
