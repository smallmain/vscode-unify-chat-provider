import { beforeEach, describe, expect, it, vi } from 'vitest';

const network = vi.hoisted(() => ({
  fetcher: (async () => new Response('', { status: 500 })) as typeof fetch,
}));

vi.mock('vscode', () => {
  class LanguageModelTextPart {
    constructor(readonly value: string) {}
  }
  class LanguageModelThinkingPart {
    constructor(
      readonly value: string | string[],
      readonly id?: string,
      readonly metadata?: Record<string, unknown>,
    ) {}
  }
  class LanguageModelToolCallPart {
    constructor(
      readonly callId: string,
      readonly name: string,
      readonly input: object,
    ) {}
  }
  class LanguageModelToolResultPart {
    constructor(
      readonly callId: string,
      readonly content: unknown[],
    ) {}
  }
  class LanguageModelDataPart {
    constructor(
      readonly data: Uint8Array,
      readonly mimeType: string,
    ) {}
  }
  return {
    env: { language: 'en' },
    l10n: { t: (message: string) => message },
    LanguageModelTextPart,
    LanguageModelThinkingPart,
    LanguageModelToolCallPart,
    LanguageModelToolResultPart,
    LanguageModelDataPart,
    LanguageModelChatMessageRole: { System: 1, User: 2, Assistant: 3 },
    LanguageModelChatToolMode: { Auto: 1, Required: 2 },
    window: {
      createOutputChannel: () => ({
        info: () => undefined,
        error: () => undefined,
        warn: () => undefined,
        debug: () => undefined,
        trace: () => undefined,
        append: () => undefined,
        appendLine: () => undefined,
        replace: () => undefined,
        clear: () => undefined,
        show: () => undefined,
        hide: () => undefined,
        dispose: () => undefined,
        name: 'test',
        logLevel: 2,
        onDidChangeLogLevel: () => ({ dispose: () => undefined }),
      }),
    },
    workspace: {
      getConfiguration: () => ({ get: <T>(_key: string, fallback: T) => fallback }),
    },
  };
});

vi.mock('../../src/config-store', () => ({
  CONFIG_NAMESPACE: 'unifyChatProvider',
}));

vi.mock('../../src/client/utils', () => ({
  createCustomFetch: () => network.fetcher,
}));

vi.mock('../../src/utils', () => ({
  resolveChatNetwork: () => ({
    timeout: { connection: 1000, response: 1000 },
    retry: { maxRetries: 0 },
    proxy: undefined,
  }),
}));

import * as vscode from 'vscode';
import { RequestLogger } from '../../src/logger';
import type { ChatRequestTrace, ModelConfig, ProviderConfig } from '../../src/types';
import { buildZedProviderRequest } from '../../src/client/zed/chat-codecs';
import { ZedChatEventDecoder } from '../../src/client/zed/codecs';
import {
  ZedProvider,
  ZedStreamEndedUnexpectedlyError,
} from '../../src/client/zed/provider';
import {
  clearAllZedModelRoutes,
  clearZedModelRoutes,
  rememberZedModelRoutes,
  resolveCachedZedModelRoute,
} from '../../src/client/zed/route-cache';
import { createZedLlmTokenSource } from '../../src/client/zed/runtime';
import type { ZedFetch } from '../../src/client/zed/types';

const BINDING_ID = '00000000-0000-4000-8000-000000000108';
const SESSION_ID = '00000000-0000-4000-8000-000000000109';

function zedCredential(token = 'llm-token', bindingId = BINDING_ID) {
  return {
    kind: 'token' as const,
    token,
    authContext: {
      method: 'zed' as const,
      bindingId,
      sessionId: SESSION_ID,
      revision: 1,
      organizationId: 'org',
      dataCollection: false,
      dataCollectionAllowed: false,
    },
  };
}

describe('Zed LLM token source', () => {
  it('updates only the token when the authentication context is unchanged', async () => {
    const source = createZedLlmTokenSource(
      zedCredential('stale-token'),
      async () => zedCredential('fresh-token'),
    );

    await expect(source.refresh()).resolves.toBe('fresh-token');
    await expect(source.cached()).resolves.toBe('fresh-token');
  });

  it('rejects refreshes that change binding, session, or organization', async () => {
    const initial = zedCredential('stale-token');
    const changedContexts = [
      {
        ...initial.authContext,
        bindingId: '00000000-0000-4000-8000-000000000110',
      },
      { ...initial.authContext, sessionId: 'other-session' },
      { ...initial.authContext, organizationId: 'other-organization' },
    ];

    for (const authContext of changedContexts) {
      const source = createZedLlmTokenSource(initial, async () => ({
        kind: 'token',
        token: 'fresh-token',
        authContext,
      }));
      await expect(source.refresh()).rejects.toThrow(
        'Zed authentication context changed during the request.',
      );
      await expect(source.cached()).resolves.toBe('stale-token');
    }
  });
});

function configuredProvider(bindingId = BINDING_ID): ProviderConfig {
  return {
    type: 'zed',
    name: 'Zed',
    baseUrl: 'https://zed.dev',
    models: [],
    auth: {
      method: 'zed',
      bindingId,
      baseUrl: 'https://zed.dev',
    },
  };
}

const model: ModelConfig = {
  id: 'cloud-model',
  maxInputTokens: 100_000,
  maxOutputTokens: 4096,
  stream: true,
  capabilities: { toolCalling: true },
};

function cloudModelPayload(id = 'cloud-model'): Record<string, unknown> {
  return {
    provider: 'open_ai',
    id,
    display_name: 'Cloud Model',
    is_latest: true,
    max_token_count: 100_000,
    max_token_count_in_max_mode: null,
    max_output_tokens: 4096,
    supports_tools: true,
    supports_images: false,
    supports_thinking: false,
    supports_disabling_thinking: false,
    supports_fast_mode: false,
    supports_server_side_compaction: false,
    supported_effort_levels: [],
    supports_streaming_tools: false,
    supports_parallel_tool_calls: false,
    is_disabled: false,
    disabled_reason: null,
  };
}

function messages(): vscode.LanguageModelChatRequestMessage[] {
  return [
    {
      role: vscode.LanguageModelChatMessageRole.System,
      name: undefined,
      content: [new vscode.LanguageModelTextPart('system')],
    },
    {
      role: vscode.LanguageModelChatMessageRole.User,
      name: undefined,
      content: [new vscode.LanguageModelTextPart('hello')],
    },
  ];
}

function options(): vscode.ProvideLanguageModelChatResponseOptions {
  return {
    requestInitiator: 'test',
    toolMode: vscode.LanguageModelChatToolMode.Auto,
    tools: [
      {
        name: 'lookup',
        description: 'Lookup a value',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
        },
      },
    ],
  };
}

function cancellationToken(cancelled = false): vscode.CancellationToken {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: () => ({ dispose: () => undefined }),
  };
}

function logger(): {
  instance: RequestLogger;
  requests: Array<{ body?: unknown }>;
  chunks: string[];
} {
  const requests: Array<{ body?: unknown }> = [];
  const chunks: string[] = [];
  class TestRequestLogger extends RequestLogger {
    override providerRequest(details: {
      endpoint: string;
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
    }): void {
      requests.push(details);
    }
    override providerResponseMeta(_response: Response): void {}
    override providerResponseChunk(chunk: string): void {
      chunks.push(chunk);
    }
    override vscodeOutput(_part: vscode.LanguageModelResponsePart2): void {}
  }
  return {
    instance: new TestRequestLogger('zed-provider-test'),
    requests,
    chunks,
  };
}

function trace(): ChatRequestTrace {
  return {
    performance: { tts: Date.now(), ttf: 0, ttft: 0, tps: 0, tl: 0 },
  };
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

beforeEach(() => {
  clearAllZedModelRoutes();
  network.fetcher = async () => new Response('', { status: 500 });
});

describe('Zed Chat adapters', () => {
  it('returns the static Zeta model with discovered models and caches routes', async () => {
    network.fetcher = async (input) => {
      const url = new URL(input.toString());
      if (url.pathname === '/models') {
        return new Response(
          JSON.stringify({
            models: [cloudModelPayload()],
            default_model: null,
            default_fast_model: null,
            recommended_models: [],
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    };
    const provider = configuredProvider();

    const credential = zedCredential();
    const models = await new ZedProvider(provider).getAvailableModels(
      credential,
    );

    expect(models.map((item) => item.id)).toEqual([
      'zeta-cloud',
      'cloud-model',
    ]);
    expect(
      resolveCachedZedModelRoute(provider, credential, 'cloud-model'),
    ).toMatchObject({ upstreamProvider: 'open_ai' });
  });

  it('clears routes only for the changed auth binding', () => {
    const otherBindingId = '00000000-0000-4000-8000-000000000118';
    const provider = configuredProvider();
    const credential = zedCredential();
    const otherProvider = configuredProvider(otherBindingId);
    const otherCredential = zedCredential('other-token', otherBindingId);
    const route = {
      organizationId: 'org',
      modelId: 'cloud-model',
      upstreamProvider: 'open_ai' as const,
    };
    rememberZedModelRoutes(provider, credential, [route]);
    rememberZedModelRoutes(otherProvider, otherCredential, [route]);

    clearZedModelRoutes(BINDING_ID);

    expect(
      resolveCachedZedModelRoute(provider, credential, 'cloud-model'),
    ).toBeUndefined();
    expect(
      resolveCachedZedModelRoute(
        otherProvider,
        otherCredential,
        'cloud-model',
      ),
    ).toEqual(route);
  });

  it('builds distinct Anthropic, Responses, Google and xAI request contracts', () => {
    const anthropic = buildZedProviderRequest(
      'anthropic',
      model,
      messages(),
      options(),
    );
    expect(anthropic).toMatchObject({
      model: 'cloud-model',
      system: 'system',
      temperature: 1,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'lookup' }],
      tool_choice: { type: 'auto' },
    });

    const responses = buildZedProviderRequest(
      'open_ai',
      model,
      messages(),
      options(),
    );
    expect(responses).toMatchObject({
      model: 'cloud-model',
      stream: true,
      store: false,
      input: [
        {
          type: 'message',
          role: 'system',
          content: [{ type: 'input_text', text: 'system' }],
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hello' }],
        },
      ],
      tools: [{ type: 'function', name: 'lookup' }],
      tool_choice: 'auto',
    });

    const google = buildZedProviderRequest(
      'google',
      model,
      messages(),
      options(),
    );
    expect(google).toMatchObject({
      model: 'models/cloud-model',
      systemInstruction: { parts: [{ text: 'system' }] },
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: { candidateCount: 1, stopSequences: [] },
      tools: [{ functionDeclarations: [{ name: 'lookup' }] }],
      toolConfig: { functionCallingConfig: { mode: 'auto' } },
    });

    const xai = buildZedProviderRequest(
      'x_ai',
      model,
      messages(),
      options(),
    );
    expect(xai).toMatchObject({
      model: 'cloud-model',
      stream: true,
      stream_options: { include_usage: true },
      temperature: 1,
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'hello' },
      ],
      tools: [{ type: 'function', function: { name: 'lookup' } }],
      tool_choice: 'auto',
    });
  });

  it('maps Required tool mode and replays thinking as reasoning, not output text', () => {
    const withThinking = [
      ...messages(),
      {
        role: vscode.LanguageModelChatMessageRole.Assistant,
        name: undefined,
        content: [new vscode.LanguageModelThinkingPart('private reasoning')],
      },
    ];
    const required = {
      ...options(),
      toolMode: vscode.LanguageModelChatToolMode.Required,
    };

    expect(
      buildZedProviderRequest('anthropic', model, withThinking, required),
    ).toMatchObject({ tool_choice: { type: 'any' } });
    expect(
      buildZedProviderRequest('open_ai', model, withThinking, required),
    ).toMatchObject({ store: false, tool_choice: 'required' });
    expect(
      buildZedProviderRequest('x_ai', model, withThinking, required),
    ).toMatchObject({ tool_choice: 'required' });
    expect(
      buildZedProviderRequest('google', model, withThinking, required),
    ).toMatchObject({
      toolConfig: { functionCallingConfig: { mode: 'any' } },
    });

    const openAi = buildZedProviderRequest(
      'open_ai',
      model,
      withThinking,
      required,
    );
    expect(openAi).toMatchObject({
      input: expect.arrayContaining([
        expect.objectContaining({
          type: 'reasoning',
          content: [{ type: 'reasoning_text', text: 'private reasoning' }],
        }),
      ]),
    });
    expect(JSON.stringify(openAi)).not.toContain(
      '"type":"output_text","text":"private reasoning"',
    );
    expect(openAi).toMatchObject({
      include: ['reasoning.encrypted_content'],
    });
  });

  it('matches Responses encrypted reasoning include and none-effort rules', () => {
    const reasoningModel: ModelConfig = {
      ...model,
      id: 'gpt-cloud#reasoningEffort=high',
      thinking: { type: 'auto', effort: 'high' },
      presetTemplates: [
        {
          id: 'reasoningEffort',
          name: 'Reasoning Effort',
          default: 'high',
          presets: [
            { id: 'none', name: 'None', config: { thinking: { type: 'disabled' } } },
            {
              id: 'high',
              name: 'High',
              config: { thinking: { type: 'auto', effort: 'high' } },
            },
          ],
        },
      ],
    };
    expect(
      buildZedProviderRequest('open_ai', reasoningModel, messages(), options()),
    ).toMatchObject({
      model: 'gpt-cloud',
      reasoning: { effort: 'high', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
    });

    const disabled = buildZedProviderRequest(
      'open_ai',
      { ...reasoningModel, thinking: { type: 'disabled' } },
      messages(),
      options(),
    );
    expect(disabled).toMatchObject({ reasoning: { effort: 'none' } });
    expect(disabled).not.toHaveProperty('include');
  });

  it('maps Google thinking configuration for enabled and disabled Gemini models', () => {
    const enabled = buildZedProviderRequest(
      'google',
      {
        ...model,
        id: 'gemini-3.5-flash#reasoningEffort=low',
        thinking: { type: 'auto', effort: 'low' },
      },
      messages(),
      options(),
    );
    expect(enabled).toMatchObject({
      model: 'models/gemini-3.5-flash',
      generationConfig: {
        thinkingConfig: { includeThoughts: true, thinkingLevel: 'LOW' },
      },
    });

    const disabledGemini3 = buildZedProviderRequest(
      'google',
      { ...model, id: 'gemini-3.5-flash', thinking: { type: 'disabled' } },
      messages(),
      options(),
    );
    expect(disabledGemini3).toMatchObject({
      generationConfig: { thinkingConfig: { thinkingLevel: 'MINIMAL' } },
    });

    const disabledGemini25 = buildZedProviderRequest(
      'google',
      { ...model, id: 'gemini-2.5-flash', thinking: { type: 'disabled' } },
      messages(),
      options(),
    );
    expect(disabledGemini25).toMatchObject({
      generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
    });
  });

  it('preserves Responses item order around mixed text and tool parts', () => {
    const mixed: vscode.LanguageModelChatRequestMessage[] = [
      {
        role: vscode.LanguageModelChatMessageRole.Assistant,
        name: undefined,
        content: [
          new vscode.LanguageModelTextPart('before call'),
          new vscode.LanguageModelToolCallPart('call-1', 'lookup', {
            query: 'one',
          }),
          new vscode.LanguageModelTextPart('after call'),
        ],
      },
      {
        role: vscode.LanguageModelChatMessageRole.User,
        name: undefined,
        content: [
          new vscode.LanguageModelTextPart('before result'),
          new vscode.LanguageModelToolResultPart('call-1', [
            new vscode.LanguageModelTextPart('result'),
          ]),
          new vscode.LanguageModelTextPart('after result'),
        ],
      },
    ];
    const request = buildZedProviderRequest(
      'open_ai',
      model,
      mixed,
      options(),
    );
    expect(request['input']).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'before call' }],
      },
      {
        type: 'function_call',
        call_id: 'call-1',
        name: 'lookup',
        arguments: '{"query":"one"}',
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'after call' }],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'before result' }],
      },
      {
        type: 'function_call_output',
        call_id: 'call-1',
        output: 'result',
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'after result' }],
      },
    ]);
  });

  it('accumulates Anthropic and xAI tool argument deltas until completion', () => {
    const anthropic = new ZedChatEventDecoder('anthropic');
    expect(
      anthropic.decode({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'call-a', name: 'lookup' },
      }),
    ).toEqual([]);
    expect(
      anthropic.decode({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"query":' },
      }),
    ).toEqual([]);
    anthropic.decode({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '"zed"}' },
    });
    expect(
      anthropic.decode({ type: 'content_block_stop', index: 0 }),
    ).toEqual([
      {
        kind: 'tool_call',
        callId: 'call-a',
        name: 'lookup',
        input: { query: 'zed' },
      },
    ]);

    const xai = new ZedChatEventDecoder('x_ai');
    expect(
      xai.decode({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-x',
                  function: { name: 'lookup', arguments: '{"query":' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    ).toEqual([]);
    expect(
      xai.decode({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '"xai"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    ).toEqual([
      {
        kind: 'tool_call',
        callId: 'call-x',
        name: 'lookup',
        input: { query: 'xai' },
      },
    ]);
  });

  it('preserves signed and encrypted reasoning metadata for replay', () => {
    const anthropicMessages: vscode.LanguageModelChatRequestMessage[] = [
      {
        role: vscode.LanguageModelChatMessageRole.Assistant,
        name: undefined,
        content: [
          new vscode.LanguageModelThinkingPart('', undefined, {
            signature: 'anthropic-signature',
            _completeThinking: 'complete thought',
          }),
          new vscode.LanguageModelThinkingPart('', undefined, {
            redactedData: 'encrypted-thought',
          }),
        ],
      },
    ];
    expect(
      buildZedProviderRequest(
        'anthropic',
        model,
        anthropicMessages,
        options(),
      ),
    ).toMatchObject({
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'complete thought',
              signature: 'anthropic-signature',
            },
            { type: 'redacted_thinking', data: 'encrypted-thought' },
          ],
        },
      ],
    });

    const reasoningItem = {
      type: 'reasoning',
      id: 'reasoning-1',
      summary: [{ type: 'summary_text', text: 'summary' }],
      encrypted_content: 'encrypted-openai',
      status: 'completed',
    };
    const openAiMessages: vscode.LanguageModelChatRequestMessage[] = [
      {
        role: vscode.LanguageModelChatMessageRole.Assistant,
        name: undefined,
        content: [
          new vscode.LanguageModelThinkingPart('', 'reasoning-1', {
            zedReasoningItem: reasoningItem,
          }),
        ],
      },
    ];
    const openAiReplay = buildZedProviderRequest(
      'open_ai',
      model,
      openAiMessages,
      options(),
    );
    expect(openAiReplay['input']).toEqual([reasoningItem]);
    expect(openAiReplay['include']).toEqual(['reasoning.encrypted_content']);

    const googleMessages: vscode.LanguageModelChatRequestMessage[] = [
      {
        role: vscode.LanguageModelChatMessageRole.Assistant,
        name: undefined,
        content: [
          new vscode.LanguageModelThinkingPart('', undefined, {
            signature: 'google-signature',
            _completeThinking: 'google thought',
          }),
        ],
      },
    ];
    expect(
      buildZedProviderRequest('google', model, googleMessages, options()),
    ).toMatchObject({
      contents: [
        {
          role: 'model',
          parts: [
            {
              text: 'google thought',
              thought: true,
              thoughtSignature: 'google-signature',
            },
          ],
        },
      ],
    });
  });

  it('emits replay metadata from streams and surfaces Responses error events', () => {
    const anthropic = new ZedChatEventDecoder('anthropic');
    anthropic.decode({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'thinking', thinking: 'first ' },
    });
    anthropic.decode({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'thinking_delta', thinking: 'second' },
    });
    anthropic.decode({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'signature_delta', signature: 'signed' },
    });
    expect(
      anthropic.decode({ type: 'content_block_stop', index: 1 }),
    ).toEqual([
      {
        kind: 'thinking',
        text: '',
        metadata: {
          signature: 'signed',
          _completeThinking: 'first second',
        },
      },
    ]);

    const google = new ZedChatEventDecoder('google');
    google.decode({
      candidates: [
        {
          content: {
            parts: [
              {
                text: 'thought',
                thought: true,
                thoughtSignature: 'google-signed',
              },
            ],
          },
        },
      ],
    });
    expect(google.finish()).toEqual([
      {
        kind: 'thinking',
        text: '',
        metadata: {
          signature: 'google-signed',
          _completeThinking: 'thought',
        },
      },
    ]);

    const openAi = new ZedChatEventDecoder('open_ai');
    expect(
      openAi.decode({
        type: 'response.output_item.done',
        item: {
          type: 'reasoning',
          id: 'reasoning-1',
          summary: [],
          encrypted_content: 'encrypted',
        },
      }),
    ).toEqual([
      {
        kind: 'thinking',
        text: '',
        id: 'reasoning-1',
        metadata: {
          zedReasoningItem: {
            type: 'reasoning',
            id: 'reasoning-1',
            summary: [],
            encrypted_content: 'encrypted',
          },
        },
      },
    ]);
    expect(() =>
      openAi.decode({
        type: 'response.failed',
        response: {
          error: { code: 'server_error', message: 'generation failed' },
        },
      }),
    ).toThrow('server_error: generation failed');
  });

  it('round-trips a Google tool-call thought signature on the functionCall part', () => {
    const google = new ZedChatEventDecoder('google');
    const decoded = google.decode({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  id: 'call-signed',
                  name: 'lookup',
                  args: { query: 'value' },
                },
                thoughtSignature: 'tool-signature',
              },
            ],
          },
        },
      ],
    });
    expect(decoded).toEqual([
      {
        kind: 'thinking',
        text: '',
        metadata: {
          zedGoogleToolCall: {
            callId: 'call-signed',
            thoughtSignature: 'tool-signature',
          },
        },
      },
      {
        kind: 'tool_call',
        callId: 'call-signed',
        name: 'lookup',
        input: { query: 'value' },
      },
    ]);
    expect(google.finish()).toEqual([]);

    const replay = buildZedProviderRequest(
      'google',
      model,
      [
        {
          role: vscode.LanguageModelChatMessageRole.Assistant,
          name: undefined,
          content: [
            new vscode.LanguageModelThinkingPart('', undefined, {
              zedGoogleToolCall: {
                callId: 'call-signed',
                thoughtSignature: 'tool-signature',
              },
            }),
            new vscode.LanguageModelToolCallPart('call-signed', 'lookup', {
              query: 'value',
            }),
          ],
        },
      ],
      options(),
    );
    expect(replay).toMatchObject({
      contents: [
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-signed',
                name: 'lookup',
                args: { query: 'value' },
              },
              thoughtSignature: 'tool-signature',
            },
          ],
        },
      ],
    });
  });

  it('keeps xAI image content and omits parallel tools without tools', () => {
    const request = buildZedProviderRequest(
      'x_ai',
      { ...model, parallelToolCalling: false },
      [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          name: undefined,
          content: [
            new vscode.LanguageModelTextPart('inspect'),
            new vscode.LanguageModelDataPart(
              new Uint8Array([1, 2, 3]),
              'image/png',
            ),
          ],
        },
      ],
      { requestInitiator: 'test', toolMode: vscode.LanguageModelChatToolMode.Auto },
    );
    expect(request).toMatchObject({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'inspect' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,AQID' },
            },
          ],
        },
      ],
    });
    expect(request).not.toHaveProperty('parallel_tool_calls');
  });

  it('sends wrapper IDs and removes status events from model output', async () => {
    const wrapperBodies: Array<Record<string, unknown>> = [];
    const fetcher: ZedFetch = async (input, init) => {
      const url = new URL(input.toString());
      if (url.pathname === '/client/users/me') {
        return new Response(
          JSON.stringify({
            user: { id_v2: 'user', username: 'user' },
            organizations: [{ id: 'org', name: 'Org', is_personal: true }],
            default_organization_id: 'org',
            configuration_by_organization: {},
          }),
          { status: 200 },
        );
      }
      if (url.pathname === '/client/llm_tokens') {
        return new Response(JSON.stringify({ token: 'llm-token' }), {
          status: 200,
        });
      }
      if (url.pathname === '/models') {
        return new Response(
          JSON.stringify({
            models: [
              {
                provider: 'open_ai',
                id: 'cloud-model',
                display_name: 'Cloud Model',
                is_latest: true,
                max_token_count: 100_000,
                max_token_count_in_max_mode: null,
                max_output_tokens: 4096,
                supports_tools: true,
                supports_images: false,
                supports_thinking: false,
                supports_disabling_thinking: false,
                supports_fast_mode: false,
                supports_server_side_compaction: false,
                supported_effort_levels: [],
                supports_streaming_tools: false,
                supports_parallel_tool_calls: false,
                is_disabled: false,
                disabled_reason: null,
              },
            ],
            default_model: null,
            default_fast_model: null,
            recommended_models: [],
          }),
          { status: 200 },
        );
      }
      if (url.pathname === '/completions') {
        wrapperBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          [
            JSON.stringify({ status: { queued: { position: 2 } } }),
            JSON.stringify({ status: 'started' }),
            JSON.stringify({
              event: {
                type: 'response.output_text.delta',
                delta: 'hello',
              },
            }),
            JSON.stringify({ status: 'stream_ended' }),
          ].join('\n'),
          {
            status: 200,
            headers: { 'x-zed-server-supports-status-messages': 'true' },
          },
        );
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    };
    network.fetcher = fetcher;
    const requestLogger = logger();
    const parts = await collect(
      new ZedProvider(configuredProvider()).streamChat(
        'encoded',
        { ...model, id: 'cloud-model#reasoningEffort=high' },
        messages(),
        options(),
        trace(),
        cancellationToken(),
        requestLogger.instance,
        zedCredential(),
      ),
    );
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ value: 'hello' });
    expect(wrapperBodies).toHaveLength(1);
    expect(wrapperBodies[0]).toMatchObject({
      provider: 'open_ai',
      model: 'cloud-model',
      provider_request: { model: 'cloud-model', stream: true },
    });
    expect(wrapperBodies[0]?.['thread_id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f-]{27}$/,
    );
    expect(wrapperBodies[0]?.['prompt_id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f-]{27}$/,
    );
    expect(requestLogger.chunks).toHaveLength(4);
  });

  it('reuses a token refreshed during route discovery for completion', async () => {
    const authorizations: string[] = [];
    network.fetcher = async (input, init) => {
      const url = new URL(input.toString());
      const authorization =
        new Headers(init?.headers).get('authorization') ?? '';
      authorizations.push(authorization);
      if (url.pathname === '/models') {
        if (authorization === 'Bearer stale-token') {
          return new Response('expired', { status: 401 });
        }
        return new Response(
          JSON.stringify({
            models: [cloudModelPayload()],
            default_model: null,
            default_fast_model: null,
            recommended_models: [],
          }),
          { status: 200 },
        );
      }
      if (url.pathname === '/completions') {
        return new Response(
          [
            JSON.stringify({
              event: {
                type: 'response.output_text.delta',
                delta: 'refreshed',
              },
            }),
            JSON.stringify({ status: 'stream_ended' }),
          ].join('\n'),
          {
            status: 200,
            headers: { 'x-zed-server-supports-status-messages': 'true' },
          },
        );
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    };
    const refreshCredential = vi.fn(async () => zedCredential('fresh-token'));

    const parts = await collect(
      new ZedProvider(configuredProvider()).streamChat(
        'encoded',
        model,
        messages(),
        options(),
        trace(),
        cancellationToken(),
        logger().instance,
        zedCredential('stale-token'),
        refreshCredential,
      ),
    );

    expect(parts[0]).toMatchObject({ value: 'refreshed' });
    expect(authorizations).toEqual([
      'Bearer stale-token',
      'Bearer fresh-token',
      'Bearer fresh-token',
    ]);
    expect(refreshCredential).toHaveBeenCalledTimes(1);
  });

  it('turns failed status events into errors and honors pre-cancellation', async () => {
    let calls = 0;
    let completionMode: 'failed' | 'truncated' = 'failed';
    const fetcher: ZedFetch = async (input) => {
      const url = new URL(input.toString());
      calls += 1;
      if (url.pathname === '/client/users/me') {
        return new Response(
          JSON.stringify({
            user: { id_v2: 'user', username: 'user' },
            organizations: [{ id: 'org', name: 'Org', is_personal: true }],
            default_organization_id: 'org',
            configuration_by_organization: {},
          }),
          { status: 200 },
        );
      }
      if (url.pathname === '/client/llm_tokens') {
        return new Response(JSON.stringify({ token: 'llm-token' }), {
          status: 200,
        });
      }
      if (url.pathname === '/models') {
        return new Response(
          JSON.stringify({
            models: [
              {
                provider: 'open_ai',
                id: 'cloud-model',
                display_name: 'Cloud Model',
                is_latest: true,
                max_token_count: 1000,
                max_token_count_in_max_mode: null,
                max_output_tokens: 100,
                supports_tools: false,
                supports_images: false,
                supports_thinking: false,
                supports_disabling_thinking: false,
                supports_fast_mode: false,
                supports_server_side_compaction: false,
                supported_effort_levels: [],
                supports_streaming_tools: false,
                supports_parallel_tool_calls: false,
                is_disabled: false,
                disabled_reason: null,
              },
            ],
            default_model: null,
            default_fast_model: null,
            recommended_models: [],
          }),
          { status: 200 },
        );
      }
      return new Response(
        completionMode === 'failed'
          ? JSON.stringify({
              status: {
                failed: {
                  code: 'rate_limited',
                  message: 'slow down',
                  request_id: '00000000-0000-0000-0000-000000000001',
                  retry_after: 1,
                },
              },
            })
          : JSON.stringify({
              event: { type: 'response.output_text.delta', delta: 'partial' },
            }),
        {
          status: 200,
          headers: { 'x-zed-server-supports-status-messages': 'true' },
        },
      );
    };
    network.fetcher = fetcher;
    const provider = new ZedProvider(configuredProvider());
    const credential = zedCredential();
    await expect(
      collect(
        provider.streamChat(
          'encoded',
          model,
          messages(),
          options(),
          trace(),
          cancellationToken(),
          logger().instance,
          credential,
        ),
      ),
    ).rejects.toThrow('Zed completion failed (rate_limited): slow down');
    completionMode = 'truncated';
    await expect(
      collect(
        provider.streamChat(
          'encoded',
          model,
          messages(),
          options(),
          trace(),
          cancellationToken(),
          logger().instance,
          credential,
        ),
      ),
    ).rejects.toBeInstanceOf(ZedStreamEndedUnexpectedlyError);
    const callsAfterError = calls;
    expect(
      await collect(
        provider.streamChat(
          'encoded',
          model,
          messages(),
          options(),
          trace(),
          cancellationToken(true),
          logger().instance,
          credential,
        ),
      ),
    ).toEqual([]);
    expect(calls).toBe(callsAfterError);
  });
});
