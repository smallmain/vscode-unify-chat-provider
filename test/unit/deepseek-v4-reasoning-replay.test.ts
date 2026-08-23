import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
    constructor(
      readonly value: string | readonly string[],
      readonly id?: string,
      readonly metadata?: Readonly<Record<string, unknown>>,
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
      readonly content: readonly unknown[],
    ) {}
  }

  return {
    LanguageModelChatMessageRole: { System: 1, User: 2, Assistant: 3 },
    LanguageModelDataPart,
    LanguageModelTextPart,
    LanguageModelThinkingPart,
    LanguageModelToolCallPart,
    LanguageModelToolResultPart,
    LanguageModelToolResultPart2: LanguageModelToolResultPart,
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
  decodeStatefulMarkerPart: () => {
    throw new Error('No stateful marker is expected in this test');
  },
  isCacheControlMarker: () => false,
  isImageMarker: () => false,
  isInternalMarker: () => false,
  isRawBaseUrlEnabled: () => false,
  isUsageMarker: () => false,
  normalizeImageMimeType: () => undefined,
  tryNormalizeCopilotUsage: () => undefined,
}));

import * as vscode from 'vscode';
import { OpenAIChatCompletionProvider } from '../../src/client/openai/chat-completion-client';

class TestDeepSeekProvider extends OpenAIChatCompletionProvider {
  replayAssistantHistory(
    messages: readonly LanguageModelChatRequestMessage[],
  ) {
    return this.convertMessages(
      'custom/deepseek-v4-pro',
      messages,
      false,
      'content',
      'deepseek-v4-test',
    );
  }
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

describe('DeepSeek V4 reasoning replay', () => {
  it('enables reasoning_content for DeepSeek V4 on custom endpoints', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/client/definitions.ts'),
      'utf8',
    );

    expect(getFeatureBlock(source, 'OpenAIUseReasoningContent')).toContain(
      "modelFamilyIncludes(model, 'deepseek-v4')",
    );
  });

  it('replays reasoning, content, and tool calls in one assistant message', () => {
    const provider = new TestDeepSeekProvider({
      type: 'openai-chat-completion',
      name: 'Custom DeepSeek',
      baseUrl: 'https://custom.example/v1',
      models: [],
    });
    const assistantHistory: LanguageModelChatRequestMessage = {
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [
        new vscode.LanguageModelThinkingPart('private reasoning'),
        new vscode.LanguageModelTextPart('Calling tools'),
        new vscode.LanguageModelToolCallPart('call-1', 'lookup', {
          query: 'first',
        }),
        new vscode.LanguageModelToolCallPart('call-2', 'lookup', {
          query: 'second',
        }),
      ],
      name: undefined,
    };

    expect(provider.replayAssistantHistory([assistantHistory])).toEqual([
      {
        role: 'assistant',
        reasoning_content: 'private reasoning',
        content: [{ type: 'text', text: 'Calling tools' }],
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: {
              name: 'lookup',
              arguments: '{"query":"first"}',
            },
          },
          {
            id: 'call-2',
            type: 'function',
            function: {
              name: 'lookup',
              arguments: '{"query":"second"}',
            },
          },
        ],
      },
    ]);
  });
});
