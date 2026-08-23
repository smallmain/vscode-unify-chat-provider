import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  env: { language: 'en' },
  l10n: {
    t: (message: string | { message: string }) =>
      typeof message === 'string' ? message : message.message,
  },
}));

vi.mock('../../src/client/utils', () => ({
  matchProvider: (url: string, pattern: string | RegExp) =>
    typeof pattern === 'string'
      ? url.includes(pattern.replaceAll('*', ''))
      : pattern.test(url),
}));

import { prepareOfficialModels } from '../../src/well-known/opencode-models';
import type { ModelConfig, ProviderConfig } from '../../src/types';

type OpenCodeProviderType =
  | 'openai-chat-completion'
  | 'openai-responses'
  | 'anthropic'
  | 'google-ai-studio';

function provider(
  type: OpenCodeProviderType,
  baseUrl = 'https://opencode.ai/zen',
): ProviderConfig {
  return {
    type,
    name: `OpenCode ${type}`,
    baseUrl,
    models: [],
  };
}

function ids(models: ModelConfig[]): string[] {
  return models.map((model) => model.id);
}

describe('OpenCode official model aggregation', () => {
  const zenCatalog: ModelConfig[] = [
    { id: 'gpt-5.6-sol' },
    { id: 'grok-4.5' },
    { id: 'muse-spark-1.2' },
    { id: 'claude-sonnet-5' },
    { id: 'qwen3.7-plus' },
    { id: 'gemini-3.7-flash' },
    { id: 'minimax-m3' },
    { id: 'deepseek-v4-flash' },
    { id: 'deepseek-v4-flash-free' },
  ];

  it('partitions the Zen catalog into disjoint protocol-specific lists', () => {
    const expected = new Map<OpenCodeProviderType, string[]>([
      [
        'openai-chat-completion',
        [
          'minimax-m3',
          'deepseek-v4-flash',
          'deepseek-v4-flash-free',
        ],
      ],
      ['openai-responses', ['gpt-5.6-sol', 'grok-4.5', 'muse-spark-1.2']],
      ['anthropic', ['claude-sonnet-5', 'qwen3.7-plus']],
      ['google-ai-studio', ['gemini-3.7-flash']],
    ]);

    const occurrences = new Map<string, number>();
    for (const [type, expectedIds] of expected) {
      const actualIds = ids(prepareOfficialModels(zenCatalog, provider(type)));
      expect(actualIds).toEqual(expectedIds);
      for (const id of actualIds) {
        occurrences.set(id, (occurrences.get(id) ?? 0) + 1);
      }
    }

    expect(Object.fromEntries(occurrences)).toEqual(
      Object.fromEntries(zenCatalog.map((model) => [model.id, 1])),
    );
  });

  it('uses Go-specific Messages routing for MiniMax and Qwen models', () => {
    const goCatalog: ModelConfig[] = [
      { id: 'gpt-5.6-luna' },
      { id: 'grok-4.5' },
      { id: 'muse-spark-1.2-contributor' },
      { id: 'minimax-m3' },
      { id: 'minimax-m2.7' },
      { id: 'qwen3.8-max' },
      { id: 'deepseek-v4-pro' },
      { id: 'glm-5.3' },
    ];
    const baseUrl = 'https://opencode.ai/zen/go/v1';

    expect(
      ids(
        prepareOfficialModels(
          goCatalog,
          provider('openai-chat-completion', baseUrl),
        ),
      ),
    ).toEqual(['deepseek-v4-pro', 'glm-5.3']);
    expect(
      ids(prepareOfficialModels(goCatalog, provider('anthropic', baseUrl))),
    ).toEqual(['minimax-m3', 'minimax-m2.7', 'qwen3.8-max']);
    expect(
      ids(
        prepareOfficialModels(
          goCatalog,
          provider('openai-responses', baseUrl),
        ),
      ),
    ).toEqual(['gpt-5.6-luna', 'grok-4.5', 'muse-spark-1.2-contributor']);
  });

  it('marks a matched free variant without changing its API model ID', () => {
    const [model] = prepareOfficialModels(
      [{ id: 'deepseek-v4-flash-free' }],
      provider('openai-chat-completion'),
    );

    expect(model).toMatchObject({
      id: 'deepseek-v4-flash-free',
      name: 'DeepSeek V4 Flash (Free)',
    });
  });

  it('does not apply OpenCode routing to other hosts or paths', () => {
    for (const baseUrl of [
      'https://example.com/zen/v1',
      'https://opencode.ai.example.com/zen/v1',
      'https://opencode.ai/v1',
    ]) {
      expect(
        ids(
          prepareOfficialModels(
            zenCatalog,
            provider('openai-responses', baseUrl),
          ),
        ),
      ).toEqual(ids(zenCatalog));
    }
  });
});
