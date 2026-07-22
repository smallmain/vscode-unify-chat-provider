import { describe, expect, it, vi } from 'vitest';
import type { LanguageModelChatRequestMessage } from 'vscode';
import { appendMistralContentChunks } from '../../src/client/openai/mistral-content';

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

  return {
    LanguageModelChatMessageRole: { System: 1, User: 2, Assistant: 3 },
    LanguageModelDataPart,
    LanguageModelTextPart,
    LanguageModelThinkingPart,
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
  isFeatureSupportedByProvider: (
    _featureId: unknown,
    provider: { baseUrl?: string },
  ) => (provider.baseUrl ?? '').includes('api.mistral.ai'),
}));

vi.mock('../../src/utils', () => ({
  DEFAULT_CONTEXT_CACHE_TTL_SECONDS: 300,
  DEFAULT_NORMAL_TIMEOUT_CONFIG: {
    connection: 10_000,
    response: 300_000,
  },
  decodeStatefulMarkerPart: (
    expectedIdentity: string,
    modelId: string,
    part: { readonly data: Uint8Array },
  ) => {
    const raw = Buffer.from(part.data).toString();
    const prefix = `${modelId}\\`;
    if (!raw.startsWith(prefix)) {
      throw new Error('Invalid marker model ID');
    }
    const envelope: unknown = JSON.parse(
      Buffer.from(raw.slice(prefix.length), 'base64').toString('utf8'),
    );
    if (
      typeof envelope !== 'object' ||
      envelope === null ||
      !('identity' in envelope) ||
      envelope.identity !== expectedIdentity ||
      !('data' in envelope)
    ) {
      throw new Error('Invalid marker identity');
    }
    return envelope.data;
  },
  isCacheControlMarker: () => false,
  isImageMarker: () => false,
  isInternalMarker: (part: { readonly mimeType: string }) =>
    part.mimeType === 'stateful_marker',
  isRawBaseUrlEnabled: () => false,
  isUsageMarker: () => false,
  normalizeImageMimeType: () => undefined,
  tryNormalizeCopilotUsage: () => undefined,
}));

import * as vscode from 'vscode';
import { OpenAIChatCompletionProvider } from '../../src/client/openai/chat-completion-client';

class TestMistralProvider extends OpenAIChatCompletionProvider {
  replayAssistantHistory(
    encodedModelId: string,
    messages: readonly LanguageModelChatRequestMessage[],
    expectedIdentity: string,
  ) {
    return this.convertMessages(
      encodedModelId,
      messages,
      false,
      'none',
      expectedIdentity,
    );
  }
}

describe('Mistral multi-turn replay', () => {
  it('restores structured assistant chunks from the stateful marker', () => {
    const encodedModelId = 'provider/mistral-medium-3-5';
    const expectedIdentity = 'mistral-provider-identity';
    const thinkingChunk = {
      type: 'thinking',
      thinking: [{ type: 'text', text: 'reasoning' }],
    };
    const textChunk = { type: 'text', text: 'answer' };
    const accumulated = appendMistralContentChunks(undefined, [thinkingChunk]);
    const rawContent = appendMistralContentChunks(accumulated, [textChunk]);
    const rawAssistantMessage = {
      role: 'assistant',
      content: rawContent,
    };
    const markerData = {
      data: rawAssistantMessage,
    };
    const envelope = Buffer.from(
      JSON.stringify({ identity: expectedIdentity, data: markerData }),
    ).toString('base64');
    const marker = new vscode.LanguageModelDataPart(
      Buffer.from(`${encodedModelId}\\${envelope}`),
      'stateful_marker',
    );
    const assistantHistory: LanguageModelChatRequestMessage = {
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [marker],
      name: undefined,
    };
    const provider = new TestMistralProvider({
      type: 'openai-chat-completion',
      name: 'Mistral',
      baseUrl: 'https://api.mistral.ai/v1',
      models: [],
    });

    const replayed = provider.replayAssistantHistory(
      encodedModelId,
      [assistantHistory],
      expectedIdentity,
    );
    const replayedAssistant: { content?: unknown } = replayed[0];

    expect(replayedAssistant.content).toEqual([thinkingChunk, textChunk]);
  });
});
