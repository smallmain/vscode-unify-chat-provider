import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  env: { language: 'en' },
  l10n: {
    t: (message: string | { message: string }) =>
      typeof message === 'string' ? message : message.message,
  },
}));

vi.mock('../../src/client/utils', () => ({
  buildBaseUrl: (baseUrl: string) => baseUrl,
  matchProvider: (url: string, pattern: string | RegExp) =>
    typeof pattern === 'string'
      ? url.includes(pattern.replaceAll('*', ''))
      : pattern.test(url),
}));

vi.mock('../../src/client/definitions', () => ({
  FeatureId: {},
}));

vi.mock('../../src/logger', () => ({
  createSimpleHttpLogger: () => undefined,
}));

vi.mock('../../src/utils', () => ({
  isRawBaseUrlEnabled: () => false,
}));

import { WELL_KNOWN_MODELS } from '../../src/well-known/models';
import { WELL_KNOWN_PROVIDERS } from '../../src/well-known/providers';
import {
  applyPresetTemplateSelections,
  buildPresetTemplateConfigurationSchema,
} from '../../src/preset-templates';
import { OpenAIChatCompletionProvider } from '../../src/client/openai/chat-completion-client';
import type { ModelConfig } from '../../src/types';

function requireModel(model: ModelConfig | undefined): ModelConfig {
  if (model === undefined) {
    throw new Error('qwen3.8-max model was not found');
  }
  return model;
}

function getFeatureBlock(source: string, featureId: string): string {
  const marker = `[FeatureId.${featureId}]: {`;
  const start = source.indexOf(marker);
  if (start < 0) {
    throw new Error(`Feature ${featureId} was not found`);
  }

  const rest = source.slice(start);
  const end = rest.indexOf('\n  },\n  [FeatureId.');
  return end < 0 ? rest : rest.slice(0, end);
}

function buildChatReasoningParams(model: ModelConfig): unknown {
  const provider = new OpenAIChatCompletionProvider({
    type: 'openai-chat-completion',
    name: 'Qwen test',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [],
  });
  const builder: unknown = Reflect.get(provider, 'buildReasoningParams');
  if (typeof builder !== 'function') {
    throw new Error('Chat reasoning parameter builder was not found');
  }
  return Reflect.apply(builder, provider, [
    model,
    'enable_thinking_with_reasoning_effort',
  ]);
}

describe('Qwen3.8-Max catalog support', () => {
  const model = WELL_KNOWN_MODELS.find(
    (candidate) => candidate.id === 'qwen3.8-max',
  );

  it('declares the official limits and capabilities', () => {
    expect(model).toMatchObject({
      id: 'qwen3.8-max',
      name: 'Qwen3.8-Max',
      maxInputTokens: 983616,
      maxOutputTokens: 131072,
      stream: true,
      thinking: {
        type: 'enabled',
        effort: 'xhigh',
      },
      parallelToolCalling: false,
      capabilities: {
        toolCalling: true,
        imageInput: true,
      },
    });
  });

  it('exposes the three native reasoning levels in the VS Code configuration schema', () => {
    const qwen = requireModel(model);
    const effortTemplate = qwen.presetTemplates?.find(
      (template) => template.id === 'reasoningEffort',
    );

    expect(effortTemplate?.default).toBe('xhigh');
    expect(effortTemplate?.presets).toMatchObject([
      {
        id: 'xhigh',
        config: {
          thinking: {
            type: 'enabled',
            effort: 'xhigh',
          },
        },
      },
      {
        id: 'medium',
        config: {
          thinking: {
            type: 'enabled',
            effort: 'medium',
          },
        },
      },
      {
        id: 'low',
        config: {
          thinking: {
            type: 'enabled',
            effort: 'low',
          },
        },
      },
    ]);

    const schema = buildPresetTemplateConfigurationSchema(qwen);
    expect(schema?.properties?.['reasoningEffort']).toMatchObject({
      enum: ['xhigh', 'medium', 'low'],
      default: 'xhigh',
    });

    expect(
      applyPresetTemplateSelections(qwen, {
        reasoningEffort: 'medium',
      }).thinking,
    ).toEqual({
      type: 'enabled',
      effort: 'medium',
    });
  });

  it.each(['low', 'medium', 'xhigh'] as const)(
    'maps %s to Qwen Chat Completion parameters',
    (effort) => {
      const configured = applyPresetTemplateSelections(requireModel(model), {
        reasoningEffort: effort,
      });

      expect(buildChatReasoningParams(configured)).toEqual({
        enable_thinking: true,
        reasoning_effort: effort,
      });
    },
  );

  it('disables thinking without sending an effort or budget', () => {
    const qwen = requireModel(model);
    expect(
      buildChatReasoningParams({
        ...qwen,
        thinking: { type: 'disabled' },
      }),
    ).toEqual({ enable_thinking: false });
  });

  it('enables the Qwen 3.8 protocol features for Model Studio endpoints', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/client/definitions.ts'),
      'utf8',
    );

    expect(getFeatureBlock(source, 'OpenAIUseReasoningEffortParam')).toContain(
      'isQwen38ModelStudioEndpoint',
    );
    expect(getFeatureBlock(source, 'OpenAIUseThinkingParam3')).toContain(
      'isQwen38ModelStudioEndpoint',
    );
    expect(getFeatureBlock(source, 'OpenAIUseReasoningContent')).toContain(
      'isQwen38ModelStudioEndpoint',
    );
    expect(source).toContain("value?.toLowerCase() === 'qwen3.8-max'");
    expect(source).toContain("'dashscope.aliyuncs.com'");
    expect(source).toContain("'dashscope-intl.aliyuncs.com'");
  });

  it.each([
    'Alibaba Cloud Model Studio (China)',
    'Alibaba Cloud Model Studio (International)',
  ])('is available from the %s built-in provider', (providerName) => {
    const provider = WELL_KNOWN_PROVIDERS.find(
      (candidate) => candidate.name === providerName,
    );

    expect(provider?.models).toContain('qwen3.8-max');
  });

  it('is not added to non-Chat built-in providers', () => {
    const providers = WELL_KNOWN_PROVIDERS.filter((provider) =>
      provider.models.includes('qwen3.8-max'),
    );

    expect(
      providers.every(
        (provider) => provider.type === 'openai-chat-completion',
      ),
    ).toBe(true);
  });
});
