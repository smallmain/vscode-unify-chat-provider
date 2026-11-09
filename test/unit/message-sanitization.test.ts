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

  class LanguageModelToolResultPart2 {
    constructor(
      readonly callId: string,
      readonly content: unknown[],
    ) {}
  }

  class LanguageModelThinkingPart {
    constructor(
      readonly value: string | string[],
      readonly id?: string,
      readonly metadata?: object,
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
    LanguageModelToolResultPart2,
    LanguageModelThinkingPart,
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

function createMarker(
  identity = expectedIdentity,
  markerModelId = modelId,
): vscode.LanguageModelDataPart {
  const envelope = Buffer.from(
    JSON.stringify({
      identity,
      data: { providerMessage: 'raw' },
    }),
  ).toString('base64');
  return new vscode.LanguageModelDataPart(
    Buffer.from(`${markerModelId}\\${envelope}`),
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
        content: [
          new vscode.LanguageModelTextPart('answer'),
          createMarker('foreign-identity'),
        ],
      },
    ]);

    expect(result.messages).toHaveLength(2);
    expect(textValues(result.messages[1])).toEqual(['answer']);
    expect(result.sanitizedMessageIndexes).toEqual(new Set([0, 1]));
  });

  it.each([
    {
      name: 'foreign identity',
      markers: () => [createMarker('foreign-identity')],
    },
    {
      name: 'foreign model ID',
      markers: () => [createMarker(expectedIdentity, 'other/model')],
    },
    {
      name: 'malformed marker',
      markers: () => [
        new vscode.LanguageModelDataPart(Buffer.from('invalid'), 'stateful_marker'),
      ],
    },
    {
      name: 'duplicate markers',
      markers: () => [createMarker(), createMarker()],
    },
  ])('drops a tool exchange with $name', ({ markers }) => {
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
          ...markers(),
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
    const marker = createMarker();
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
    const marker = createMarker();
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
        content: [
          new vscode.LanguageModelTextPart('final answer'),
          createMarker('foreign-identity'),
        ],
      },
    ]);

    expect(result.messages).toHaveLength(2);
    expect(textValues(result.messages[0])).toEqual(['question']);
    expect(textValues(result.messages[1])).toEqual(['final answer']);
    expect(result.messageOriginIndexes).toEqual([0, 3]);
    expect(result.sanitizedMessageIndexes).toEqual(new Set([1, 2, 3]));
  });

  it('preserves markerless text and metadata for best-effort replay', () => {
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
          new vscode.LanguageModelThinkingPart('reasoning', 'rs_byok_1'),
          new vscode.LanguageModelTextPart('answer'),
        ],
      },
    ];

    const result = sanitize(messages);

    expect(result.messages).toEqual(messages);
    expect(result.messageOriginIndexes).toEqual([0, 1]);
    expect(result.sanitizedMessageIndexes).toEqual(new Set());
  });

  it.each([
    { name: 'ToolResultPart', ResultPart: vscode.LanguageModelToolResultPart },
    { name: 'ToolResultPart2', ResultPart: vscode.LanguageModelToolResultPart2 },
  ])('preserves multiple markerless tool rounds using $name', ({ ResultPart }) => {
    const messages: vscode.LanguageModelChatRequestMessage[] = [
      {
        role: vscode.LanguageModelChatMessageRole.System,
        name: undefined,
        content: [new vscode.LanguageModelTextPart('system')],
      },
      {
        role: vscode.LanguageModelChatMessageRole.User,
        name: undefined,
        content: [new vscode.LanguageModelTextPart('question')],
      },
    ];
    for (let round = 0; round < 6; round++) {
      messages.push({
        role: vscode.LanguageModelChatMessageRole.Assistant,
        name: undefined,
        content: [
          new vscode.LanguageModelThinkingPart('reasoning', `rs_byok_${round}`),
        ],
      });
      for (let tool = 0; tool < 2; tool++) {
        messages.push({
          role: vscode.LanguageModelChatMessageRole.Assistant,
          name: undefined,
          content: [
            new vscode.LanguageModelToolCallPart(`call-${round}-${tool}`, 'inspect', {}),
          ],
        });
      }
      for (let tool = 0; tool < 2; tool++) {
        messages.push({
          role: vscode.LanguageModelChatMessageRole.User,
          name: undefined,
          content: [
            new ResultPart(`call-${round}-${tool}`, [
              new vscode.LanguageModelTextPart('result'),
            ]),
          ],
        });
      }
    }
    messages.push({
      role: vscode.LanguageModelChatMessageRole.Assistant,
      name: undefined,
      content: [new vscode.LanguageModelTextPart('final answer')],
    });

    const result = sanitize(messages);

    expect(result.messages).toEqual(messages);
    expect(result.messageOriginIndexes).toEqual(
      messages.map((_, index) => index),
    );
    expect(result.sanitizedMessageIndexes).toEqual(new Set());
  });

  it.each([expectedIdentity, 'foreign-identity'])(
    'validates present markers in a round that also has markerless assistants (%s)',
    (identity) => {
      const messages: vscode.LanguageModelChatRequestMessage[] = [
        {
          role: vscode.LanguageModelChatMessageRole.User,
          name: undefined,
          content: [new vscode.LanguageModelTextPart('question')],
        },
        {
          role: vscode.LanguageModelChatMessageRole.Assistant,
          name: undefined,
          content: [new vscode.LanguageModelThinkingPart('reasoning')],
        },
        {
          role: vscode.LanguageModelChatMessageRole.Assistant,
          name: undefined,
          content: [
            new vscode.LanguageModelToolCallPart('call-1', 'inspect', {}),
            createMarker(identity),
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

      if (identity === expectedIdentity) {
        expect(result.messages).toEqual(messages);
        expect(result.sanitizedMessageIndexes).toEqual(new Set());
      } else {
        expect(result.messages).toEqual([messages[0]]);
        expect(result.sanitizedMessageIndexes).toEqual(new Set([0, 1, 2, 3]));
      }
    },
  );
});
