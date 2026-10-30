import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthTokenInfo } from '../../src/auth/types';
import type { ModelConfig, ProviderConfig } from '../../src/types';

const state = vi.hoisted(() => ({
  fetch: vi.fn<typeof fetch>(),
  createCustomFetch: vi.fn(),
  error: vi.fn(),
  getAvailableModels: vi.fn<(...args: unknown[]) => Promise<ModelConfig[]>>(),
}));

vi.mock('vscode', () => ({
  env: { language: 'en' },
  l10n: { t: (message: string) => message },
}));
vi.mock('../../src/logger', () => ({
  createSimpleHttpLogger: () => ({ error: state.error }),
}));
vi.mock('../../src/utils', () => ({
  DEFAULT_NORMAL_TIMEOUT_CONFIG: { connection: 10000, response: 30000 },
  resolveChatNetwork: (config: ProviderConfig) => ({ proxy: config.proxy }),
}));
vi.mock('../../src/client/utils', () => ({
  createCustomFetch: (options: unknown) => {
    state.createCustomFetch(options);
    return state.fetch;
  },
  getToken: (credential: AuthTokenInfo) =>
    credential.kind === 'token' ? credential.token : undefined,
}));
vi.mock('../../src/client/openai/responses-client', () => ({
  OpenAIResponsesProvider: class {
    constructor(protected readonly config: ProviderConfig) {}

    protected buildHeaders(): Record<string, string> {
      return { ...this.config.extraHeaders };
    }

    async getAvailableModels(...args: unknown[]): Promise<ModelConfig[]> {
      return state.getAvailableModels(...args);
    }
  },
}));

import { OpenAICodexProvider } from '../../src/client/openai/codex-client';

const config: ProviderConfig = {
  type: 'openai-codex',
  name: 'Codex',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  auth: { method: 'openai-codex', bindingId: 'binding' },
  models: [],
  proxy: { type: 'direct' },
};
const credential: AuthTokenInfo = {
  kind: 'token',
  token: 'test-token',
  authContext: {
    method: 'openai-codex',
    bindingId: 'binding',
    sessionId: 'session',
    revision: 1,
    accountId: 'test-account',
  },
};
const catalogModel = {
  slug: 'gpt-6.1-sol',
  display_name: 'GPT-6.1-Sol',
  visibility: 'list',
  supported_in_api: true,
  context_window: 500000,
  max_context_window: 872000,
  input_modalities: ['text', 'image'],
  default_reasoning_level: 'medium',
  supported_reasoning_levels: [
    { effort: 'medium' }, { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' },
  ],
  default_reasoning_summary: 'auto',
  supports_reasoning_summaries: true,
  supports_reasoning_summary_parameter: true,
  apply_patch_tool_type: 'freeform',
  supports_parallel_tool_calls: true,
  support_verbosity: true,
  default_verbosity: 'low',
};

function mockDiscoveryResponse(body: unknown, version = '1.2.3'): void {
  state.fetch
    .mockResolvedValueOnce(Response.json({ tag_name: `rust-v${version}` }))
    .mockResolvedValueOnce(Response.json(body));
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('Codex model discovery', () => {
  it('never sends provider credentials or custom headers to the release API', async () => {
    mockDiscoveryResponse({ models: [] });
    const controller = new AbortController();
    await new OpenAICodexProvider({
      ...config,
      extraHeaders: {
        'X-Private-Key': 'private-value',
        Authorization: 'private-auth',
      },
    }).getAvailableModels(credential, undefined, controller.signal);
    expect(state.fetch).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/repos/openai/codex/releases/latest',
      {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'unify-chat-provider',
        },
        signal: controller.signal,
        redirect: 'error',
      },
    );
  });

  it('resolves the latest version on every model refresh', async () => {
    mockDiscoveryResponse({ models: [] });
    const provider = new OpenAICodexProvider(config);
    await provider.getAvailableModels(credential);

    mockDiscoveryResponse({ models: [] }, '1.3.0');
    await provider.getAvailableModels(credential);
    expect(state.fetch).toHaveBeenCalledTimes(4);
    expect(state.fetch).toHaveBeenLastCalledWith(
      'https://chatgpt.com/backend-api/codex/models?client_version=1.3.0',
      expect.objectContaining({
        headers: expect.objectContaining({
          'User-Agent': 'codex-tui/1.3.0',
        }),
      }),
    );
  });

  it('stops discovery when the release lookup fails', async () => {
    state.fetch.mockResolvedValueOnce(new Response(null, { status: 429 }));
    await expect(
      new OpenAICodexProvider(config).getAvailableModels(credential),
    ).rejects.toThrow('Failed to get latest Codex version: HTTP 429');
    expect(state.fetch).toHaveBeenCalledOnce();
    expect(state.error).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    {},
    { tag_name: 'v1.2.3' },
    { tag_name: 'rust-v1.2.3-alpha.1' },
    { tag_name: 'rust-v1.2.3', prerelease: true },
    { tag_name: 'rust-v1.2.3', draft: true },
  ])('rejects malformed or nonstable releases: %j', async (release) => {
    state.fetch.mockResolvedValueOnce(Response.json(release));
    await expect(
      new OpenAICodexProvider(config).getAvailableModels(credential),
    ).rejects.toThrow('unexpected release');
    expect(state.fetch).toHaveBeenCalledOnce();
  });

  it('does not reuse a previous version if the next lookup fails', async () => {
    mockDiscoveryResponse({ models: [] });
    const provider = new OpenAICodexProvider(config);
    await provider.getAvailableModels(credential);

    const error = new Error('Release lookup unavailable');
    state.fetch.mockRejectedValueOnce(error);
    await expect(provider.getAvailableModels(credential)).rejects.toBe(error);
    expect(state.fetch).toHaveBeenCalledTimes(3);
  });

  it('fetches the authenticated catalogue and maps visible model metadata', async () => {
    mockDiscoveryResponse({
      models: [
        catalogModel,
        { ...catalogModel, slug: 'hidden', visibility: 'hide' },
        { ...catalogModel, slug: 'unsupported', supported_in_api: false },
        { ...catalogModel, slug: '' },
        null,
      ],
    });
    const controller = new AbortController();
    const models = await new OpenAICodexProvider(config).getAvailableModels(
      credential,
      undefined,
      controller.signal,
    );

    expect(models).toMatchObject([
      {
        id: 'gpt-6.1-sol',
        name: 'GPT-6.1 Sol',
        maxInputTokens: 500000,
        maxOutputTokens: undefined,
        thinking: { type: 'enabled', effort: 'medium', summary: 'auto' },
        capabilities: {
          toolCalling: true, imageInput: true, editTools: 'apply-patch',
        },
        parallelToolCalling: true,
        verbosity: 'low',
      },
    ]);
    expect(state.fetch).toHaveBeenNthCalledWith(
      2,
      'https://chatgpt.com/backend-api/codex/models?client_version=1.2.3',
      expect.objectContaining({
        method: 'GET',
        signal: controller.signal,
        redirect: 'error',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          Accept: 'application/json',
          'Chatgpt-Account-Id': 'test-account',
          Originator: 'codex-tui',
          'User-Agent': 'codex-tui/1.2.3',
        }),
      }),
    );
    expect(state.createCustomFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        proxy: config.proxy,
        connectionTimeoutMs: 10000,
        responseTimeoutMs: 30000,
        type: 'normal',
      }),
    );
  });

  it('builds reasoning and verbosity presets from supported metadata', async () => {
    mockDiscoveryResponse({ models: [catalogModel] });
    const [model] = await new OpenAICodexProvider(config).getAvailableModels(credential);
    const reasoning = model?.presetTemplates?.find(template => template.id === 'reasoningEffort');
    expect(reasoning?.presets.map(preset => preset.id)).toEqual(['max', 'xhigh', 'medium']);
    expect(reasoning?.default).toBe('medium');
    expect(model?.presetTemplates?.find(template => template.id === 'verbosity'))
      .toMatchObject({ default: 'default' });
  });

  it('preserves false capabilities and omits unsupported settings', async () => {
    mockDiscoveryResponse({ models: [{
      ...catalogModel,
      supports_parallel_tool_calls: false,
      support_verbosity: false,
      apply_patch_tool_type: 'unknown',
      supports_reasoning_summary_parameter: false,
    }] });
    const [model] = await new OpenAICodexProvider(config).getAvailableModels(credential);
    expect(model?.parallelToolCalling).toBe(false);
    expect(model?.verbosity).toBeUndefined();
    expect(model?.capabilities?.editTools).toBeUndefined();
    expect(model?.thinking?.summary).toBeUndefined();
    expect(model?.presetTemplates?.some(template => template.id === 'verbosity')).toBe(false);
  });

  it('ignores invalid optional capability values', async () => {
    mockDiscoveryResponse({ models: [{
      ...catalogModel,
      supports_parallel_tool_calls: 'true',
      support_verbosity: 'true',
      apply_patch_tool_type: null,
      default_verbosity: 'invalid',
    }] });
    const [model] = await new OpenAICodexProvider(config).getAvailableModels(credential);
    expect(model?.parallelToolCalling).toBeUndefined();
    expect(model?.verbosity).toBeUndefined();
    expect(model?.capabilities?.editTools).toBeUndefined();
  });

  it('supports an advertised non-thinking default and explicit summary default', async () => {
    mockDiscoveryResponse({ models: [{
      ...catalogModel,
      default_reasoning_level: 'none',
      supported_reasoning_levels: [{ effort: 'none' }, { effort: 'low' }],
      default_reasoning_summary: 'concise',
    }] });
    const [model] = await new OpenAICodexProvider(config).getAvailableModels(credential);
    expect(model?.thinking).toEqual({ type: 'disabled', effort: 'none', summary: 'concise' });
  });

  it.each([
    ['gpt-6-astra', ' GPT-6-Astra ', 'GPT-6 Astra'],
    ['gpt-6.1-terra', 'GPT-6.1 Terra', 'GPT-6.1 Terra'],
    ['gpt-5.5', 'GPT-5.5', 'GPT-5.5'],
    ['other-model', 'Other-Model', 'Other-Model'],
  ])('formats %s without changing its API ID', async (id, name, expectedName) => {
    mockDiscoveryResponse({
      models: [{ ...catalogModel, slug: id, display_name: name }],
    });
    const [model] = await new OpenAICodexProvider(config).getAvailableModels(
      credential,
    );
    expect(model).toMatchObject({ id, name: expectedName });
  });

  it('uses a supported default effort when xhigh is unavailable', async () => {
    mockDiscoveryResponse({
      models: [
        {
          ...catalogModel,
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }],
          supports_reasoning_summaries: false,
          context_window: -1,
          input_modalities: ['text'],
        },
      ],
    });
    const [model] = await new OpenAICodexProvider(config).getAvailableModels(
      credential,
    );
    expect(model?.thinking).toEqual({
      type: 'enabled',
      effort: 'medium',
      summary: undefined,
    });
    expect(model?.maxInputTokens).toBeUndefined();
    expect(model?.capabilities?.imageInput).toBe(false);
  });

  it('does not invent an effort or context limit when metadata is absent', async () => {
    mockDiscoveryResponse({
      models: [
        { slug: 'future-model', visibility: 'list', supported_in_api: true },
      ],
    });
    const [model] = await new OpenAICodexProvider(config).getAvailableModels(
      credential,
    );
    expect(model?.id).toBe('future-model');
    expect(model?.thinking?.effort).toBeUndefined();
    expect(model?.maxInputTokens).toBeUndefined();
    expect(model?.maxOutputTokens).toBeUndefined();
    expect(model?.tokenizer).toBeUndefined();
    expect(model?.parallelToolCalling).toBeUndefined();
    expect(model?.verbosity).toBeUndefined();
    expect(model?.presetTemplates).toBeUndefined();
  });

  it('delegates API-key configurations without contacting ChatGPT', async () => {
    const apiCredential: AuthTokenInfo = { kind: 'token', token: 'api-key' };
    const refresh = vi.fn(async () => apiCredential);
    const controller = new AbortController();
    state.getAvailableModels.mockResolvedValue([{ id: 'proxy-model' }]);
    const provider = new OpenAICodexProvider({
      ...config,
      baseUrl: 'https://example.com/v1',
      auth: { method: 'api-key' },
    });
    await expect(
      provider.getAvailableModels(apiCredential, refresh, controller.signal),
    ).resolves.toEqual([{ id: 'proxy-model' }]);
    expect(state.getAvailableModels).toHaveBeenCalledWith(
      apiCredential,
      refresh,
      controller.signal,
    );
    expect(state.fetch).not.toHaveBeenCalled();
  });

  it('rejects missing authentication before making a request', async () => {
    await expect(
      new OpenAICodexProvider(config).getAvailableModels({ kind: 'none' }),
    ).rejects.toThrow('Authentication required');
    expect(state.fetch).not.toHaveBeenCalled();
  });

  it('propagates catalogue errors without a static replacement', async () => {
    state.fetch
      .mockResolvedValueOnce(Response.json({ tag_name: 'rust-v1.2.3' }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(
      new OpenAICodexProvider(config).getAvailableModels(credential),
    ).rejects.toThrow('Failed to get available models: HTTP 401');
    expect(state.error).toHaveBeenCalledOnce();
  });

  it.each([null, {}, { models: {} }])('rejects malformed catalogue envelopes: %j', async (body) => {
    mockDiscoveryResponse(body);
    await expect(
      new OpenAICodexProvider(config).getAvailableModels(credential),
    ).rejects.toThrow('unexpected Codex response');
  });

  it('returns a valid empty catalogue without injecting static models', async () => {
    mockDiscoveryResponse({ models: [] });
    await expect(
      new OpenAICodexProvider(config).getAvailableModels(credential),
    ).resolves.toEqual([]);
  });

  it('propagates cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      new OpenAICodexProvider(config).getAvailableModels(
        credential,
        undefined,
        controller.signal,
      ),
    ).rejects.toBe(controller.signal.reason);
    expect(state.fetch).not.toHaveBeenCalled();
  });
});