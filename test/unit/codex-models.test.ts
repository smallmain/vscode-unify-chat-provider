import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthTokenInfo } from '../../src/auth/types';
import type { ModelConfig, ProviderConfig } from '../../src/types';

const state = vi.hoisted(() => ({
  getAvailableModels: vi.fn<(...args: unknown[]) => Promise<ModelConfig[]>>(),
}));

vi.mock('vscode', () => ({
  LanguageModelChatMessageRole: { User: 1, Assistant: 2, System: 3 },
}));

vi.mock('../../src/utils', () => ({
  DEFAULT_NORMAL_TIMEOUT_CONFIG: { connection: 30_000, response: 30_000 },
  isRawBaseUrlEnabled: () => false,
  resolveChatNetwork: () => ({ proxy: { type: 'direct' } }),
  resolveSdkTotalTimeoutMs: () => 60_000,
}));

vi.mock('../../src/client/utils', () => ({
  createCustomFetch: () => vi.fn(),
  getToken: () => undefined,
}));

vi.mock('../../src/client/openai/responses-client', () => ({
  OpenAIResponsesProvider: class OpenAIResponsesProvider {
    constructor(protected readonly config: ProviderConfig) {}

    async getAvailableModels(...args: unknown[]): Promise<ModelConfig[]> {
      return state.getAvailableModels(...args);
    }
  },
}));

import { OpenAICodexProvider } from '../../src/client/openai/codex-client';

function createConfig(auth: ProviderConfig['auth']): ProviderConfig {
  return {
    type: 'openai-codex',
    name: 'Codex',
    baseUrl: 'https://127.0.0.1:9999/v1',
    models: [],
    auth,
  };
}

beforeEach(() => {
  state.getAvailableModels.mockReset();
});

describe('OpenAI Codex model list', () => {
  it('fetches models from the configured endpoint for API-key auth', async () => {
    const remoteModels: ModelConfig[] = [
      { id: 'claude-opus-5.5_zero' },
      { id: 'gemini-3.8-flash' },
    ];
    state.getAvailableModels.mockResolvedValue(remoteModels);
    const credential: AuthTokenInfo = { kind: 'token', token: 'sk-test' };
    const refreshCredential = vi.fn(async () => credential);
    const controller = new AbortController();
    const provider = new OpenAICodexProvider(
      createConfig({ method: 'api-key', apiKey: 'sk-test' }),
    );

    await expect(
      provider.getAvailableModels(
        credential,
        refreshCredential,
        controller.signal,
      ),
    ).resolves.toEqual(remoteModels);
    expect(state.getAvailableModels).toHaveBeenCalledWith(
      credential,
      refreshCredential,
      controller.signal,
    );
  });

  it('keeps the built-in model list for ChatGPT OAuth auth', async () => {
    const provider = new OpenAICodexProvider(
      createConfig({ method: 'openai-codex', bindingId: 'binding-1' }),
    );

    const models = await provider.getAvailableModels({ kind: 'none' });

    expect(state.getAvailableModels).not.toHaveBeenCalled();
    expect(models.map((model) => model.id)).toContain('gpt-6-astra');
  });
});
