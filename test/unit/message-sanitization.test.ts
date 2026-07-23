import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class LanguageModelTextPart {
    constructor(readonly value: string) {}
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
    LanguageModelChatMessageRole: { System: 1, User: 2, Assistant: 3 },
    LanguageModelDataPart,
    LanguageModelTextPart,
    LanguageModelToolCallPart,
    LanguageModelToolResultPart,
    LanguageModelToolResultPart2: LanguageModelToolResultPart,
  };
});

vi.mock('../../src/i18n', () => ({
  t: (message: string) => message,
}));

vi.mock('../../src/official-models-manager', () => ({
  officialModelsManager: {},
}));

import * as vscode from 'vscode';
import { sanitizeMessagesForModelSwitchDetailed } from '../../src/utils';

const modelId = 'provider/target-model';
const expectedIdentity = 'target-model-identity';

function sanitize(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
) {
  return sanitizeMessagesForModelSwitchDetailed(messages, {
    modelId,
    expectedIdentity,
  });
}

function textValues(
  message: vscode.LanguageModelChatRequestMessage,
): string[] {
  return message.content.flatMap((part) =>
    part instanceof vscode.LanguageModelTextPart ? [part.value] : [],
  );
}

function createTrustedMarker(): vscode.LanguageModelDataPart {
  const envelope = Buffer.from(
    JSON.stringify({
      identity: expectedIdentity,
      data: { providerMessage: 'raw' },
    }),
  ).toString('base64');
  return new vscode.LanguageModelDataPart(
    Buffer.from(`${modelId}\\${envelope}`),
    'stateful_marker',
  );
}

describe('model-switch message sanitization', () => {
  it('keeps portable text from a sanitized assistant message without tools', () => {
    const result = sanitize([
      {
        role: vscode.LanguageModelChatMessageRole.User,
        name: undefined,
        content: [new vscode.LanguageModelTextPart('question')],
      },
      {
        role: vscode.LanguageModelChatMessageRole.Assistant,
        name: undefined,
        content: [new vscode.LanguageModelTextPart('answer')],
      },
    ]);

    expect(result.messages).toHaveLength(2);
    expect(textValues(result.messages[1])).toEqual(['answer']);
    expect(result.sanitizedMessageIndexes).toEqual(new Set([0, 1]));
  });

  it('drops assistant text together with a sanitized tool call and its result', () => {
    const result = sanitize([
      {
        role: vscode.LanguageModelChatMessageRole.User,
        name: undefined,
        content: [new vscode.LanguageModelTextPart('question')],
      },
      {
        role: vscode.LanguageModelChatMessageRole.Assistant,
        name: undefined,
        content: [
          new vscode.LanguageModelTextPart('I will inspect that.'),
          new vscode.LanguageModelToolCallPart('call-1', 'inspect', {}),
        ],
      },
      {
        role: vscode.LanguageModelChatMessageRole.User,
        name: undefined,
        content: [
          new vscode.LanguageModelToolResultPart('call-1', [
            new vscode.LanguageModelTextPart('result'),
          ]),
        ],
      },
    ]);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe(
      vscode.LanguageModelChatMessageRole.User,
    );
    expect(textValues(result.messages[0])).toEqual(['question']);
    expect(result.messageOriginIndexes).toEqual([0]);
    expect(result.sanitizedMessageIndexes).toEqual(new Set([0, 1, 2]));
  });

  it('keeps an intact tool exchange produced by the target model', () => {
    const marker = createTrustedMarker();
    const messages: vscode.LanguageModelChatRequestMessage[] = [
      {
        role: vscode.LanguageModelChatMessageRole.User,
        name: undefined,
        content: [new vscode.LanguageModelTextPart('question')],
      },
      {
        role: vscode.LanguageModelChatMessageRole.Assistant,
        name: undefined,
        content: [
          new vscode.LanguageModelTextPart('I will inspect that.'),
          new vscode.LanguageModelToolCallPart('call-1', 'inspect', {}),
          marker,
        ],
      },
      {
        role: vscode.LanguageModelChatMessageRole.User,
        name: undefined,
        content: [
          new vscode.LanguageModelToolResultPart('call-1', [
            new vscode.LanguageModelTextPart('result'),
          ]),
        ],
      },
    ];

    const result = sanitize(messages);

    expect(result.messages).toEqual(messages);
    expect(result.messageOriginIndexes).toEqual([0, 1, 2]);
    expect(result.sanitizedMessageIndexes).toEqual(new Set());
  });

  it('drops the originating assistant message when its tool result is sanitized later', () => {
    const marker = createTrustedMarker();
    const result = sanitize([
      {
        role: vscode.LanguageModelChatMessageRole.User,
        name: undefined,
        content: [new vscode.LanguageModelTextPart('question')],
      },
      {
        role: vscode.LanguageModelChatMessageRole.Assistant,
        name: undefined,
        content: [
          new vscode.LanguageModelTextPart('I will inspect that.'),
          new vscode.LanguageModelToolCallPart('call-1', 'inspect', {}),
          marker,
        ],
      },
      {
        role: vscode.LanguageModelChatMessageRole.User,
        name: undefined,
        content: [
          new vscode.LanguageModelToolResultPart('call-1', [
            new vscode.LanguageModelTextPart('result'),
          ]),
        ],
      },
      {
        role: vscode.LanguageModelChatMessageRole.Assistant,
        name: undefined,
        content: [new vscode.LanguageModelTextPart('final answer')],
      },
    ]);

    expect(result.messages).toHaveLength(2);
    expect(textValues(result.messages[0])).toEqual(['question']);
    expect(textValues(result.messages[1])).toEqual(['final answer']);
    expect(result.messageOriginIndexes).toEqual([0, 3]);
    expect(result.sanitizedMessageIndexes).toEqual(new Set([1, 2, 3]));
  });
});
