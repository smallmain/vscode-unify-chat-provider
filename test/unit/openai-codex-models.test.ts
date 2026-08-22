import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  env: { language: 'en' },
  l10n: {
    t: (message: string | { message: string }) =>
      typeof message === 'string' ? message : message.message,
  },
  LanguageModelChatMessageRole: { User: 1, Assistant: 2, System: 3 },
  LanguageModelToolMode: { Auto: 1, Required: 2 },
  window: {
    createOutputChannel: () => ({
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    }),
  },
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, fallback: unknown) => fallback,
    }),
  },
}));

vi.mock('../../src/client/definitions', () => ({ FeatureId: {} }));

vi.mock('../../src/logger', () => ({
  createSimpleHttpLogger: () => undefined,
}));

vi.mock('../../src/client/utils', () => ({
  buildBaseUrl: (baseUrl: string) => baseUrl,
  createCustomFetch: vi.fn(),
  getToken: () => undefined,
  matchProvider: (url: string, pattern: string | RegExp) =>
    typeof pattern === 'string'
      ? url.includes(pattern.replaceAll('*', ''))
      : pattern.test(url),
}));

vi.mock('../../src/utils', () => ({
  DEFAULT_NORMAL_TIMEOUT_CONFIG: {
    connection: 60000,
    response: 300000,
  },
  FetchMode: { Normal: 'normal' },
  isRawBaseUrlEnabled: () => false,
}));

import { OpenAICodexProvider } from '../../src/client/openai/codex-client';
import type { ProviderConfig } from '../../src/types';
import { mergeWithWellKnownModels } from '../../src/well-known/models';

const providerConfig: ProviderConfig = {
  type: 'openai-codex',
  name: 'OpenAI Codex (ChatGPT Plus/Pro)',
  baseUrl: 'https://chatgpt.com/backend-api/codex/responses',
  models: [],
  autoFetchOfficialModels: true,
};

describe('OpenAI Codex official models', () => {
  it('reports the GPT-5.6 long-context input budget after catalog merging', async () => {
    const provider = new OpenAICodexProvider(providerConfig);
    const fetched = await provider.getAvailableModels({ kind: 'none' });
    const models = mergeWithWellKnownModels(fetched, providerConfig);
    const modelsById = new Map(models.map((model) => [model.id, model]));

    for (const modelId of [
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]) {
      expect(modelsById.get(modelId)?.maxInputTokens).toBe(872000);
    }

    expect(modelsById.get('gpt-5.5')?.maxInputTokens).toBe(272000);
  });
});
