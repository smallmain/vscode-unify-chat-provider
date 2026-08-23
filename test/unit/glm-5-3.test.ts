import { describe, expect, it, vi } from 'vitest';
import type {
  ChatRequestTrace,
  ModelConfig,
  ProviderConfig,
} from '../../src/types';

const network = vi.hoisted(() => ({
  requests: [] as Array<{ url: string; body: unknown }>,
}));

vi.mock('vscode', () => {
  class EventEmitter<T> {
    readonly event = (
      _listener: (value: T) => unknown,
    ): { dispose: () => void } => ({ dispose: () => undefined });
    fire(_value: T): void {}
    dispose(): void {}
  }

  class LanguageModelTextPart {
    constructor(readonly value: string) {}
  }

  class LanguageModelDataPart {
    constructor(
      readonly data: Uint8Array,
      readonly mimeType: string,
    ) {}
  }

  class LanguageModelThinkingPart {
    constructor(
      readonly value: string | string[],
      readonly id?: string,
      readonly metadata?: object,
    ) {}
  }

  class LanguageModelToolCallPart {
    constructor(
      readonly callId: string,
      readonly name: string,
      readonly input: object,
    ) {}
  }

  class LanguageModelToolResultPart {}
  class LanguageModelToolResultPart2 {}
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
    LanguageModelChatMessageRole: { System: 1, User: 2, Assistant: 3 },
    LanguageModelChatToolMode: { Auto: 1, Required: 2 },
    LanguageModelDataPart,
    LanguageModelTextPart,
    LanguageModelThinkingPart,
    LanguageModelToolCallPart,
    LanguageModelToolResultPart,
    LanguageModelToolResultPart2,
    ThemeIcon,
    workspace: {
      getConfiguration: () => ({
        get: (_key: string, fallback?: unknown) => fallback,
      }),
    },
  };
});

vi.mock('../../src/logger', () => {
  class RequestLogger {
    constructor(readonly requestId: string) {}
    providerRequest(): void {}
    providerResponseMeta(): void {}
    providerResponseBody(): void {}
    providerResponseChunk(): void {}
    retry(): void {}
    usage(): void {}
    verbose(): void {}
  }

  return {
    RequestLogger,
    createSimpleHttpLogger: () => undefined,
  };
});

vi.mock('../../src/client/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/client/utils')>();
  return {
    ...actual,
    createCustomFetch:
      () =>
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const body =
          typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        network.requests.push({ url: input.toString(), body });
        return new Response(
          JSON.stringify({
            id: 'chatcmpl_glm_5_3_test',
            object: 'chat.completion',
            created: 0,
            model: 'glm-5.3',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'ok' },
                finish_reason: 'stop',
                logprobs: null,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
  };
});

import * as vscode from 'vscode';
import { FeatureId } from '../../src/client/definitions';
import { OpenAIChatCompletionProvider } from '../../src/client/openai/chat-completion-client';
import { isFeatureSupported } from '../../src/client/utils';
import { RequestLogger } from '../../src/logger';
import {
  applyPresetTemplateSelections,
  buildPresetTemplateConfigurationSchema,
} from '../../src/preset-templates';
import { WELL_KNOWN_MODELS } from '../../src/well-known/models';
import {
  resolveProviderModels,
  WELL_KNOWN_PROVIDERS,
} from '../../src/well-known/providers';

const OFFICIAL_ENDPOINTS = [
  'https://open.bigmodel.cn/api/paas/v4',
  'https://open.bigmodel.cn/api/coding/paas/v4',
  'https://api.z.ai/api/paas/v4',
  'https://api.z.ai/api/coding/paas/v4',
] as const;

const cancellationToken: vscode.CancellationToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
};

function requireModel(model: ModelConfig | undefined): ModelConfig {
  if (model === undefined) {
    throw new Error('GLM-5.3 model was not found');
  }
  return model;
}

function providerConfig(baseUrl: string): ProviderConfig {
  return {
    type: 'openai-chat-completion',
    name: 'GLM-5.3 test',
    baseUrl,
    models: [],
  };
}

function trace(): ChatRequestTrace {
  return {
    performance: {
      tts: Date.now(),
      ttf: 0,
      ttft: 0,
      tps: 0,
      tl: 0,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function serializeRequest(
  baseUrl: string,
  model: ModelConfig,
): Promise<Record<string, unknown>> {
  network.requests.length = 0;
  const provider = new OpenAIChatCompletionProvider(providerConfig(baseUrl));
  const messages: vscode.LanguageModelChatRequestMessage[] = [
    {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [new vscode.LanguageModelTextPart('hello')],
      name: undefined,
    },
  ];

  for await (const _part of provider.streamChat(
    `test/${model.id}`,
    { ...model, stream: false },
    messages,
    {
      requestInitiator: 'test',
      toolMode: vscode.LanguageModelChatToolMode.Auto,
    },
    trace(),
    cancellationToken,
    new RequestLogger('glm-5.3-test'),
    { kind: 'token', token: 'test-key' },
  )) {
    // Consume the response so the complete request path runs.
  }

  expect(network.requests).toHaveLength(1);
  const body = network.requests[0]?.body;
  if (!isRecord(body)) {
    throw new Error('Serialized request body was not an object');
  }
  return body;
}

describe('GLM-5.3 catalog support', () => {
  const model = WELL_KNOWN_MODELS.find(
    (candidate) => candidate.id === 'glm-5.3',
  );

  it('declares mandatory reasoning and the official limits', () => {
    expect(model).toMatchObject({
      id: 'glm-5.3',
      name: 'GLM-5.3',
      maxInputTokens: 1000000,
      maxOutputTokens: 128000,
      stream: true,
      thinking: { type: 'enabled', effort: 'max' },
      capabilities: { toolCalling: true, imageInput: false },
    });
  });

  it('generates only the three supported reasoning effort choices', () => {
    const glm53 = requireModel(model);
    const effortTemplate = glm53.presetTemplates?.find(
      (template) => template.id === 'reasoningEffort',
    );

    expect(effortTemplate?.default).toBe('max');
    expect(effortTemplate?.presets.map((preset) => preset.id)).toEqual([
      'max',
      'high',
      'low',
    ]);
    expect(
      buildPresetTemplateConfigurationSchema(glm53)?.properties?.[
        'reasoningEffort'
      ],
    ).toMatchObject({ enum: ['max', 'high', 'low'], default: 'max' });
  });

  it.each(['ZhiPu AI', 'ZhiPu AI (Coding Plan)', 'Z.AI', 'Z.AI (Coding Plan)'])(
    'generates the corrected model for the %s built-in provider',
    (providerName) => {
      const definition = WELL_KNOWN_PROVIDERS.find(
        (candidate) => candidate.name === providerName,
      );
      if (definition === undefined) {
        throw new Error(`${providerName} provider was not found`);
      }

      const generated = resolveProviderModels(definition).find(
        (candidate) => candidate.id === 'glm-5.3',
      );
      expect(generated?.thinking).toEqual({ type: 'enabled', effort: 'max' });
      expect(
        generated?.presetTemplates?.[0]?.presets.map((preset) => preset.id),
      ).toEqual(['max', 'high', 'low']);
    },
  );
});

describe('GLM-5.3 feature boundaries', () => {
  const model = requireModel(
    WELL_KNOWN_MODELS.find((candidate) => candidate.id === 'glm-5.3'),
  );

  it.each(OFFICIAL_ENDPOINTS)(
    'enables the dedicated protocol on %s',
    (baseUrl) => {
      expect(
        isFeatureSupported(
          FeatureId.OpenAIUseGlm53ReasoningEffortParam,
          providerConfig(baseUrl),
          model,
        ),
      ).toBe(true);
    },
  );

  it.each([
    { id: 'glm-5.3', family: 'glm-5' },
    { id: 'z-ai/glm-5.3' },
    { id: 'other-id', family: 'glm-5.3' },
  ] satisfies Array<Pick<ModelConfig, 'id' | 'family'>>)(
    'accepts the exact base ID or family identity: $id / $family',
    (identity) => {
      expect(
        isFeatureSupported(
          FeatureId.OpenAIUseGlm53ReasoningEffortParam,
          providerConfig(OFFICIAL_ENDPOINTS[0]),
          { ...model, ...identity },
        ),
      ).toBe(true);
    },
  );

  it.each([
    { id: 'glm-5.2' },
    { id: 'glm-5.1' },
    { id: 'glm-5.30' },
    { id: 'vendor/glm-5.3' },
    { id: 'z-ai/glm-5.3-pro' },
    { id: 'other-id', family: 'glm-5' },
    { id: 'other-id', family: 'glm-5.30' },
    { id: 'other-id', family: 'vendor/glm-5.3' },
  ] satisfies Array<Pick<ModelConfig, 'id' | 'family'>>)(
    'rejects non-GLM-5.3 identity: $id / $family',
    (identity) => {
      expect(
        isFeatureSupported(
          FeatureId.OpenAIUseGlm53ReasoningEffortParam,
          providerConfig(OFFICIAL_ENDPOINTS[0]),
          { ...model, ...identity },
        ),
      ).toBe(false);
    },
  );

  it.each([
    'https://third-party.example/v1',
    'https://api.z.ai.example/api/paas/v4',
    'https://api.z.ai/api/v1',
    'https://api.z.ai/api/paas/v4?route=other',
  ])('rejects non-official endpoint %s', (baseUrl) => {
    expect(
      isFeatureSupported(
        FeatureId.OpenAIUseGlm53ReasoningEffortParam,
        providerConfig(baseUrl),
        model,
      ),
    ).toBe(false);
  });

  it('rejects a different provider protocol at an official endpoint', () => {
    expect(
      isFeatureSupported(
        FeatureId.OpenAIUseGlm53ReasoningEffortParam,
        {
          ...providerConfig(OFFICIAL_ENDPOINTS[0]),
          type: 'openai-responses',
        },
        model,
      ),
    ).toBe(false);
  });
});

describe('GLM-5.3 serialized requests', () => {
  const model = requireModel(
    WELL_KNOWN_MODELS.find((candidate) => candidate.id === 'glm-5.3'),
  );

  it.each(OFFICIAL_ENDPOINTS)(
    'serializes mandatory max reasoning on %s',
    async (baseUrl) => {
      const body = await serializeRequest(baseUrl, model);
      expect(body['thinking']).toEqual({ type: 'enabled' });
      expect(body['reasoning_effort']).toBe('max');
    },
  );

  it('serializes the explicit Z.AI model alias', async () => {
    const body = await serializeRequest(OFFICIAL_ENDPOINTS[0], {
      ...model,
      id: 'z-ai/glm-5.3',
    });
    expect(body).toMatchObject({
      model: 'z-ai/glm-5.3',
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    });
  });

  it.each([
    { type: 'disabled' as const },
    { type: 'enabled' as const, effort: 'none' as const },
  ])(
    'migrates stale $type / $effort reasoning to enabled low',
    async (thinking) => {
      const body = await serializeRequest(OFFICIAL_ENDPOINTS[0], {
        ...model,
        thinking,
      });
      expect(body['thinking']).toEqual({ type: 'enabled' });
      expect(body['reasoning_effort']).toBe('low');
    },
  );

  it('serializes a selected low effort without rewriting it', async () => {
    const configured = applyPresetTemplateSelections(model, {
      reasoningEffort: 'low',
    });
    const body = await serializeRequest(OFFICIAL_ENDPOINTS[0], configured);
    expect(body['thinking']).toEqual({ type: 'enabled' });
    expect(body['reasoning_effort']).toBe('low');
  });

  it.each([
    { id: 'glm-5.2' },
    { id: 'glm-5.1' },
    { id: 'glm-5.30' },
    { id: 'vendor/glm-5.3' },
    { id: 'other-id', family: 'glm-5.30' },
    { id: 'other-id', family: 'vendor/glm-5.3' },
  ] satisfies Array<Pick<ModelConfig, 'id' | 'family'>>)(
    'does not force thinking for a non-GLM-5.3 identity: $id / $family',
    async (identity) => {
      const body = await serializeRequest(OFFICIAL_ENDPOINTS[0], {
        ...model,
        ...identity,
        thinking: { type: 'disabled' },
      });
      expect(body['thinking']).toEqual({ type: 'disabled' });
      expect(body['reasoning_effort']).toBeUndefined();
    },
  );

  it('does not use the forced protocol on a third-party endpoint', async () => {
    const body = await serializeRequest('https://third-party.example/v1', {
      ...model,
      thinking: { type: 'disabled' },
    });
    expect(body['thinking']).toBeUndefined();
    expect(body['reasoning_effort']).toBe('none');
  });
});
