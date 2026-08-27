import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class EventEmitter<T> {
    readonly event = (
      _listener: (value: T) => unknown,
    ): { dispose: () => void } => ({ dispose: () => undefined });
    fire(_value: T): void {}
    dispose(): void {}
  }

  class ThemeIcon {
    constructor(readonly id: string) {}
  }

  return {
    env: { language: 'en' },
    EventEmitter,
    extensions: { getExtension: () => undefined },
    l10n: {
      t: (message: string | { message: string }) =>
        typeof message === 'string' ? message : message.message,
    },
    ThemeIcon,
    workspace: {
      getConfiguration: () => ({
        get: (_key: string, fallback?: unknown) => fallback,
      }),
    },
  };
});

import { FeatureId } from '../../src/client/definitions';
import { OpenAIChatCompletionProvider } from '../../src/client/openai/chat-completion-client';
import { isFeatureSupported } from '../../src/client/utils';
import type { ModelConfig, ProviderConfig } from '../../src/types';

function providerConfig(baseUrl: string): ProviderConfig {
  return {
    type: 'openai-chat-completion',
    name: 'clear_thinking protocol test',
    baseUrl,
    models: [],
  };
}

const client = new OpenAIChatCompletionProvider(
  providerConfig('https://api.z.ai/api/paas/v4'),
);

function invokeReasoningBuilder(
  model: ModelConfig,
  type:
    | 'thinking'
    | 'thinking_with_high_max_reasoning_effort'
    | 'forced_thinking_with_reasoning_effort'
    | 'disable_reasoning',
  useNestedClearThinking: boolean,
): unknown {
  const builder: unknown = Reflect.get(client, 'buildReasoningParams');
  if (typeof builder !== 'function') {
    throw new Error('buildReasoningParams was not found');
  }
  return Reflect.apply(builder, client, [model, type, useNestedClearThinking]);
}

describe('clear_thinking protocol boundaries', () => {
  it.each([
    'https://open.bigmodel.cn/api/paas/v4',
    'https://api.z.ai/api/paas/v4',
  ])('uses the nested protocol on %s', (baseUrl) => {
    expect(
      isFeatureSupported(
        FeatureId.OpenAIUseClearThinking,
        providerConfig(baseUrl),
        { id: 'glm-4.7' },
      ),
    ).toBe(true);
  });

  it('uses the documented top-level variant for Cerebras GLM 4.7', () => {
    const provider = providerConfig('https://api.cerebras.ai/v1');
    const model = { id: 'zai-glm-4.7' };

    expect(
      isFeatureSupported(
        FeatureId.OpenAIUseTopLevelClearThinking,
        provider,
        model,
      ),
    ).toBe(true);
    expect(
      isFeatureSupported(FeatureId.OpenAIUseClearThinking, provider, model),
    ).toBe(false);
  });

  it('preserves the existing top-level NVIDIA compatibility path', () => {
    const provider = providerConfig('https://integrate.api.nvidia.com/v1');
    const model = { id: 'z-ai/glm4.7' };

    expect(
      isFeatureSupported(FeatureId.OpenAIUseClearThinking, provider, model),
    ).toBe(false);
    expect(
      isFeatureSupported(
        FeatureId.OpenAIUseTopLevelClearThinking,
        provider,
        model,
      ),
    ).toBe(true);
  });

  it.each([
    {
      type: 'thinking' as const,
      thinking: { type: 'enabled' as const },
      expectedType: 'enabled',
    },
    {
      type: 'thinking' as const,
      thinking: { type: 'disabled' as const },
      expectedType: 'disabled',
    },
    {
      type: 'thinking_with_high_max_reasoning_effort' as const,
      thinking: { type: 'auto' as const, effort: 'max' as const },
      expectedType: 'enabled',
    },
    {
      type: 'forced_thinking_with_reasoning_effort' as const,
      thinking: { type: 'disabled' as const },
      expectedType: 'enabled',
    },
  ])('nests the flag for $type / $thinking.type', (testCase) => {
    expect(
      invokeReasoningBuilder(
        { id: 'glm-model', thinking: testCase.thinking },
        testCase.type,
        true,
      ),
    ).toEqual({
      thinking: {
        type: testCase.expectedType,
        clear_thinking: false,
      },
    });
  });

  it('does not emit a standalone flag without a thinking object', () => {
    expect(
      invokeReasoningBuilder({ id: 'glm-model' }, 'thinking', true),
    ).toEqual({});
  });

  it('does not nest the flag into a protocol without a thinking object', () => {
    expect(
      invokeReasoningBuilder(
        { id: 'zai-glm-4.7', thinking: { type: 'enabled' } },
        'disable_reasoning',
        true,
      ),
    ).toEqual({ disable_reasoning: false });
  });
});
