import { describe, expect, it, vi } from 'vitest';
import type { LanguageModelChatRequestMessage } from 'vscode';

vi.mock('vscode', () => {
  class LanguageModelDataPart {
    constructor(
      readonly data: Uint8Array,
      readonly mimeType: string,
    ) {}
  }

  class LanguageModelTextPart {
    constructor(readonly value: string) {}
  }

  class LanguageModelThinkingPart {
    constructor(readonly value: string | readonly string[]) {}
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

  class LanguageModelToolResultPart2 extends LanguageModelToolResultPart {}

  return {
    LanguageModelChatMessageRole: { System: 1, User: 2, Assistant: 3 },
    LanguageModelDataPart,
    LanguageModelTextPart,
    LanguageModelThinkingPart,
    LanguageModelToolCallPart,
    LanguageModelToolResultPart,
    LanguageModelToolResultPart2,
  };
});

vi.mock('../../src/logger', () => ({
  createSimpleHttpLogger: () => undefined,
}));

vi.mock('../../src/client/types', () => ({
  ENCRYPTED_THINKING_PLACEHOLDER: 'Encrypted thinking...',
}));

vi.mock('../../src/client/definitions', () => ({
  FeatureId: {},
}));

vi.mock('../../src/model-id-utils', () => ({
  getBaseModelId: (id: string) => id,
}));

vi.mock('../../src/client/utils', () => ({
  buildBaseUrl: (baseUrl: string) => baseUrl,
  isFeatureSupportedByProvider: () => false,
}));

vi.mock('../../src/utils', () => ({
  DEFAULT_CONTEXT_CACHE_TTL_SECONDS: 300,
  DEFAULT_NORMAL_TIMEOUT_CONFIG: {
    connection: 10_000,
    response: 300_000,
  },
  decodeStatefulMarkerPart: (
    _expectedIdentity: string,
    _modelId: string,
    part: { readonly data: Uint8Array },
  ) => JSON.parse(Buffer.from(part.data).toString('utf8')),
  isCacheControlMarker: () => false,
  isImageMarker: (part: { readonly mimeType: string }) =>
    part.mimeType.startsWith('image/'),
  isInternalMarker: (part: { readonly mimeType: string }) =>
    part.mimeType === 'stateful_marker',
  isRawBaseUrlEnabled: () => false,
  isUsageMarker: () => false,
  normalizeImageMimeType: (mimeType: string) =>
    mimeType === 'image/png' ? mimeType : undefined,
  tryNormalizeCopilotUsage: () => undefined,
}));

import * as vscode from 'vscode';
import { OpenAIChatCompletionProvider } from '../../src/client/openai/chat-completion-client';

class TestDeepSeekChatProvider extends OpenAIChatCompletionProvider {
  convertForRequest(messages: readonly LanguageModelChatRequestMessage[]) {
    return this.convertMessages(
      'provider/deepseek-v4-flash-vision-exp',
      messages,
      false,
      'none',
      'deepseek-provider-identity',
    );
  }
}

function userMessage(
  content: LanguageModelChatRequestMessage['content'],
): LanguageModelChatRequestMessage {
  return {
    role: vscode.LanguageModelChatMessageRole.User,
    name: undefined,
    content,
  };
}

function imagePart(byte: number): vscode.LanguageModelDataPart {
  return new vscode.LanguageModelDataPart(
    new Uint8Array([byte]),
    'image/png',
  );
}

function toolResult(
  callId: string,
  content: unknown[],
): vscode.LanguageModelToolResultPart2 {
  return new vscode.LanguageModelToolResultPart2(callId, content);
}

function assistantToolRound(callIds: readonly string[]): {
  message: LanguageModelChatRequestMessage;
  raw: {
    role: 'assistant';
    content: null;
    tool_calls: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
  };
} {
  const toolCalls = callIds.map((callId) => ({
    id: callId,
    type: 'function' as const,
    function: { name: `tool_${callId}`, arguments: '{}' },
  }));
  const raw = {
    role: 'assistant' as const,
    content: null,
    tool_calls: toolCalls,
  };
  const marker = new vscode.LanguageModelDataPart(
    Buffer.from(JSON.stringify({ data: raw })),
    'stateful_marker',
  );

  return {
    message: {
      role: vscode.LanguageModelChatMessageRole.Assistant,
      name: undefined,
      content: [
        ...callIds.map(
          (callId) =>
            new vscode.LanguageModelToolCallPart(
              callId,
              `tool_${callId}`,
              {},
            ),
        ),
        marker,
      ],
    },
    raw,
  };
}

const provider = new TestDeepSeekChatProvider({
  type: 'openai-chat-completion',
  name: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com',
  models: [],
});

describe('DeepSeek vision Chat Completions message conversion', () => {
  it('keeps text and image blocks in one user message', () => {
    const converted = provider.convertForRequest([
      userMessage([
        new vscode.LanguageModelTextPart('Inspect this image.'),
        new vscode.LanguageModelDataPart(
          new Uint8Array([1, 2, 3]),
          'image/png',
        ),
      ]),
    ]);

    expect(converted).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect this image.' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,AQID' },
          },
        ],
      },
    ]);
  });

  it('moves tool-result images into a typed user content block', () => {
    const converted = provider.convertForRequest([
      userMessage([
        new vscode.LanguageModelToolResultPart2('call-1', [
          new vscode.LanguageModelTextPart('Screenshot captured.'),
          new vscode.LanguageModelDataPart(
            new Uint8Array([1, 2, 3]),
            'image/png',
          ),
        ]),
      ]),
    ]);

    expect(converted).toEqual([
      {
        role: 'tool',
        content: 'Screenshot captured.',
        tool_call_id: 'call-1',
      },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,AQID' },
          },
        ],
      },
    ]);
  });

  it('emits every parallel tool result before their ordered images', () => {
    const assistant = assistantToolRound(['call-1', 'call-2']);
    const converted = provider.convertForRequest([
      assistant.message,
      userMessage([
        toolResult('call-1', [
          new vscode.LanguageModelTextPart('First result.'),
          imagePart(1),
          new vscode.LanguageModelTextPart('First result tail.'),
          imagePart(2),
        ]),
      ]),
      userMessage([
        toolResult('call-2', [
          imagePart(3),
          new vscode.LanguageModelTextPart('Second result.'),
        ]),
      ]),
      userMessage([
        new vscode.LanguageModelTextPart('Next ordinary request.'),
        imagePart(4),
      ]),
    ]);

    expect(converted).toEqual([
      assistant.raw,
      {
        role: 'tool',
        content: [
          { type: 'text', text: 'First result.' },
          { type: 'text', text: 'First result tail.' },
        ],
        tool_call_id: 'call-1',
      },
      {
        role: 'tool',
        content: 'Second result.',
        tool_call_id: 'call-2',
      },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,AQ==' },
          },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,Ag==' },
          },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,Aw==' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Next ordinary request.' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,BA==' },
          },
        ],
      },
    ]);
  });

  it('keeps ordinary user messages as hard tool-result boundaries', () => {
    const assistant = assistantToolRound(['call-1', 'call-2']);
    const converted = provider.convertForRequest([
      assistant.message,
      userMessage([toolResult('call-1', [imagePart(1)])]),
      userMessage([new vscode.LanguageModelTextPart('Do not reorder me.')]),
      userMessage([toolResult('call-2', [imagePart(2)])]),
    ]);

    expect(converted).toEqual([
      assistant.raw,
      { role: 'tool', content: '', tool_call_id: 'call-1' },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,AQ==' },
          },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Do not reorder me.' }],
      },
      { role: 'tool', content: '', tool_call_id: 'call-2' },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,Ag==' },
          },
        ],
      },
    ]);
  });

  it('groups pure-text and image-only tool results without losing either', () => {
    const converted = provider.convertForRequest([
      userMessage([
        toolResult('call-text', [
          new vscode.LanguageModelTextPart('Text-only result.'),
        ]),
      ]),
      userMessage([toolResult('call-image', [imagePart(1), imagePart(2)])]),
    ]);

    expect(converted).toEqual([
      {
        role: 'tool',
        content: 'Text-only result.',
        tool_call_id: 'call-text',
      },
      { role: 'tool', content: '', tool_call_id: 'call-image' },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,AQ==' },
          },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,Ag==' },
          },
        ],
      },
    ]);
  });

  it('keeps mixed content from one tool-result user message together', () => {
    const converted = provider.convertForRequest([
      userMessage([
        toolResult('call-1', [
          new vscode.LanguageModelTextPart('Tool text.'),
          imagePart(1),
        ]),
        new vscode.LanguageModelTextPart('User follow-up.'),
        imagePart(2),
      ]),
    ]);

    expect(converted).toEqual([
      { role: 'tool', content: 'Tool text.', tool_call_id: 'call-1' },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,AQ==' },
          },
          { type: 'text', text: 'User follow-up.' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,Ag==' },
          },
        ],
      },
    ]);
  });
});
