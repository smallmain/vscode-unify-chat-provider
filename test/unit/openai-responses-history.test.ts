import OpenAI from 'openai';
import * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';
import type { ModelConfig, ProviderConfig } from '../../src/types';

vi.mock('vscode', () => {
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

  class LanguageModelToolResultPart2 {
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
    LanguageModelTextPart,
    LanguageModelThinkingPart,
    LanguageModelToolCallPart,
    LanguageModelToolResultPart,
    LanguageModelToolResultPart2,
    LanguageModelDataPart,
    LanguageModelChatMessageRole: { System: 1, User: 2, Assistant: 3 },
    LanguageModelChatToolMode: { Auto: 1, Required: 2 },
    extensions: { getExtension: () => undefined },
    workspace: {
      getConfiguration: () => ({
        get: (_key: string, fallback: unknown) => fallback,
      }),
    },
  };
});

vi.mock('../../src/i18n', () => ({ t: (message: string) => message }));
vi.mock('../../src/official-models-manager', () => ({
  officialModelsManager: {},
}));
vi.mock('../../src/client/definitions', () => ({
  FeatureId: { OpenAIUsePreviousResponseId: 'previous_response_id' },
  FEATURES: { previous_response_id: { customCheckers: [() => true] } },
  PROVIDER_TYPES: {},
}));
vi.mock('../../src/logger', () => {
  class RequestLogger {
    constructor(readonly requestId: string) {}
    providerResponseChunk(): void {}
    verbose(): void {}
    usage(): void {}
  }
  return {
    RequestLogger,
    createSimpleHttpLogger: () => undefined,
    authLog: { warn: () => undefined },
  };
});

import { RequestLogger } from '../../src/logger';
import { createStatefulMarkerIdentity } from '../../src/utils';
import { OpenAIResponsesProvider } from '../../src/client/openai/responses-client';

const config: ProviderConfig = {
  type: 'openai-responses',
  name: 'history-test',
  baseUrl: 'https://api.z.ai/api/v1',
  models: [],
};
const model: ModelConfig = { id: 'test-model', stream: false };
const modelId = 'history-test/test-model';

class HistoryTestProvider extends OpenAIResponsesProvider {
  readonly requests: unknown[] = [];

  protected override createClient(): OpenAI {
    return new OpenAI({
      apiKey: 'test',
      baseURL: this.baseUrl,
      maxRetries: 0,
      fetch: async (_input, init) => {
        if (typeof init?.body !== 'string') {
          throw new Error('Expected a serialized Responses request');
        }
        const body: unknown = JSON.parse(init.body);
        this.requests.push(body);
        return Response.json({
          id: 'resp-test',
          status: 'completed',
          output: [
            {
              id: 'msg-test',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'done', annotations: [] }],
            },
          ],
          usage: null,
        });
      },
    });
  }
}

function message(
  role: vscode.LanguageModelChatMessageRole,
  ...content: vscode.LanguageModelChatRequestMessage['content']
): vscode.LanguageModelChatRequestMessage {
  return { role, content, name: undefined };
}

function toolRound(round: number): vscode.LanguageModelChatRequestMessage[] {
  const callId = `call-${round}`;
  return [
    message(
      vscode.LanguageModelChatMessageRole.Assistant,
      new vscode.LanguageModelThinkingPart('inspect the file', `rs_byok_${round}`),
    ),
    message(
      vscode.LanguageModelChatMessageRole.Assistant,
      new vscode.LanguageModelToolCallPart(callId, 'inspect', { path: 'file.ts' }),
    ),
    message(
      vscode.LanguageModelChatMessageRole.User,
      round % 2 === 0
        ? new vscode.LanguageModelToolResultPart(callId, [
            new vscode.LanguageModelTextPart(`result-${round}`),
          ])
        : new vscode.LanguageModelToolResultPart2(callId, [
            new vscode.LanguageModelTextPart(`result-${round}`),
          ]),
    ),
  ];
}

function expectedToolInput(round: number): object[] {
  return [
    {
      type: 'function_call',
      call_id: `call-${round}`,
      name: 'inspect',
      arguments: '{"path":"file.ts"}',
    },
    {
      type: 'function_call_output',
      call_id: `call-${round}`,
      output: `result-${round}`,
    },
  ];
}

function createMarker(
  identity = createStatefulMarkerIdentity(config, model),
): vscode.LanguageModelDataPart {
  const envelope = {
    identity,
    data: {
      data: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'prior answer', annotations: [] }],
        },
      ],
      sessionId: 'trusted-session',
      responseId: 'resp-trusted',
    },
  };
  return new vscode.LanguageModelDataPart(
    Buffer.from(`${modelId}\\${Buffer.from(JSON.stringify(envelope)).toString('base64')}`),
    'stateful_marker',
  );
}

async function send(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): Promise<unknown> {
  const provider = new HistoryTestProvider(config);
  const parts = [];
  for await (const part of provider.streamChat(
    modelId,
    model,
    messages,
    {
      requestInitiator: 'history-test',
      toolMode: vscode.LanguageModelChatToolMode.Auto,
    },
    { performance: { tts: Date.now(), ttf: 0, ttft: 0, tps: 0, tl: 0 } },
    {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose: () => undefined }),
    },
    new RequestLogger('history-test'),
    { kind: 'none' },
  )) {
    parts.push(part);
  }
  expect(parts).toContainEqual(new vscode.LanguageModelTextPart('done'));
  expect(provider.requests).toHaveLength(1);
  return provider.requests[0];
}

describe('Responses markerless history requests', () => {
  it.each(['redactedData', 'encrypted_content', 'encrypted'])(
    'preserves %s reasoning metadata without replaying display-only thinking',
    async (metadataKey) => {
      const round = toolRound(0);
      round[0] = message(
        vscode.LanguageModelChatMessageRole.Assistant,
        new vscode.LanguageModelThinkingPart('Encrypted thinking...'),
        new vscode.LanguageModelThinkingPart('Visible summary', 'rs_byok_summary'),
        new vscode.LanguageModelThinkingPart('', 'rs_original', {
          [metadataKey]: 'opaque-reasoning',
        }),
      );

      const request = await send([
        message(
          vscode.LanguageModelChatMessageRole.User,
          new vscode.LanguageModelTextPart('question'),
        ),
        ...round,
        ...toolRound(1),
      ]);

      expect(request).toMatchObject({
        input: [
          { role: 'user', content: [{ type: 'input_text', text: 'question' }] },
          {
            type: 'reasoning',
            id: 'rs_original',
            summary: [],
            encrypted_content: 'opaque-reasoning',
          },
          ...expectedToolInput(0),
          ...expectedToolInput(1),
        ],
      });
      expect(JSON.stringify(request)).not.toContain('reasoning_text');
      expect(JSON.stringify(request)).not.toContain('Encrypted thinking...');
      expect(JSON.stringify(request)).not.toContain('Visible summary');
    },
  );

  it.each([
    new vscode.LanguageModelThinkingPart('Visible summary', 'rs_byok_summary'),
    new vscode.LanguageModelThinkingPart(['First summary', 'Second summary']),
    new vscode.LanguageModelThinkingPart('', undefined, {
      _completeThinking: 'Display-only complete thinking',
    }),
    new vscode.LanguageModelThinkingPart('', 'rs_empty'),
  ])(
    'does not synthesize reasoning from display text or empty thinking (%#)',
    (part) => {
      const provider = new HistoryTestProvider(config);
      expect(
        provider.convertPart(vscode.LanguageModelChatMessageRole.Assistant, part),
      ).toBeUndefined();
    },
  );

  it('omits response-only fields when replaying encrypted reasoning', () => {
    const provider = new HistoryTestProvider(config);
    const input = provider.convertPart(
      vscode.LanguageModelChatMessageRole.Assistant,
      new vscode.LanguageModelThinkingPart(
        'Encrypted thinking...',
        'rs_original',
        { encrypted_content: 'opaque-reasoning' },
      ),
    );
    expect(input).toEqual({
      type: 'reasoning',
      id: 'rs_original',
      summary: [],
      encrypted_content: 'opaque-reasoning',
    });
    expect(input).not.toHaveProperty('content');
    expect(input).not.toHaveProperty('status');
  });

  it.each([false, true])(
    'sends full tool history with proxy previous-response metadata=%s',
    async (withPreviousResponse) => {
      const messages: vscode.LanguageModelChatRequestMessage[] = [];
      if (withPreviousResponse) {
        // VS Code's BYOK handler prepends this bare ID, not a Unify envelope.
        messages.push(
          message(
            vscode.LanguageModelChatMessageRole.Assistant,
            new vscode.LanguageModelDataPart(
              Buffer.from(`${modelId}\\resp-byok`),
              'stateful_marker',
            ),
          ),
        );
      }
      messages.push(
        message(
          vscode.LanguageModelChatMessageRole.System,
          new vscode.LanguageModelTextPart('system'),
        ),
        message(
          vscode.LanguageModelChatMessageRole.User,
          new vscode.LanguageModelTextPart('question'),
        ),
        ...toolRound(0),
        ...toolRound(1),
      );

      const request = await send(messages);

      expect(request).toMatchObject({
        input: [
          { role: 'system', content: [{ type: 'input_text', text: 'system' }] },
          { role: 'user', content: [{ type: 'input_text', text: 'question' }] },
          ...expectedToolInput(0),
          ...expectedToolInput(1),
        ],
      });
      expect(request).not.toHaveProperty('previous_response_id');
    },
  );

  it('keeps markerless rounds after a trusted previous-response boundary', async () => {
    const request = await send([
      message(
        vscode.LanguageModelChatMessageRole.User,
        new vscode.LanguageModelTextPart('earlier question'),
      ),
      message(vscode.LanguageModelChatMessageRole.Assistant, createMarker()),
      message(
        vscode.LanguageModelChatMessageRole.User,
        new vscode.LanguageModelTextPart('inspect'),
      ),
      ...toolRound(0),
    ]);

    expect(request).toMatchObject({
      previous_response_id: 'resp-trusted',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'inspect' }] },
        ...expectedToolInput(0),
      ],
    });
  });

  it('disables continuation when a later tool round has a foreign marker', async () => {
    const round = toolRound(0);
    round[1] = {
      ...round[1],
      content: [...round[1].content, createMarker('foreign-identity')],
    };
    const request = await send([
      message(
        vscode.LanguageModelChatMessageRole.User,
        new vscode.LanguageModelTextPart('earlier question'),
      ),
      message(vscode.LanguageModelChatMessageRole.Assistant, createMarker()),
      message(
        vscode.LanguageModelChatMessageRole.User,
        new vscode.LanguageModelTextPart('inspect'),
      ),
      ...round,
    ]);

    expect(request).not.toHaveProperty('previous_response_id');
    expect(request).toMatchObject({
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'earlier question' }] },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'prior answer', annotations: [] }],
        },
        { role: 'user', content: [{ type: 'input_text', text: 'inspect' }] },
      ],
    });
  });
});
