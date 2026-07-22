import type * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface RecordedLogEvent {
  readonly name: string;
  readonly args: readonly unknown[];
}

const loggingMock = vi.hoisted(() => ({
  enabled: true,
  contexts: [] as unknown[],
  events: [] as RecordedLogEvent[],
}));

vi.mock('../../src/completion/api/logging', () => ({
  createCompletionRequestLogger: vi.fn((context: unknown) => {
    loggingMock.contexts.push(context);
    if (!loggingMock.enabled) return undefined;
    const record = (name: string, ...args: readonly unknown[]): void => {
      loggingMock.events.push({ name, args });
    };
    return {
      languageModelRequest: (
        messages: readonly unknown[],
        options: unknown,
      ) => record('request', messages, options),
      languageModelResponseChunk: (chunk: string) => record('chunk', chunk),
      complete: () => record('complete'),
      cancelled: () => record('cancelled'),
      error: (error: unknown) => record('error', error),
    };
  }),
}));

vi.mock('vscode', () => {
  class LanguageModelChatMessage {
    static User(content: string): LanguageModelChatMessage {
      return new LanguageModelChatMessage(1, content);
    }

    constructor(
      readonly role: number,
      readonly content: string,
    ) {}
  }

  return {
    LanguageModelChatMessage,
    LanguageModelChatMessageRole: { User: 1, Assistant: 2, System: 3 },
    l10n: { t: (message: string) => message },
    extensions: { getExtension: () => undefined },
    ThemeIcon: class ThemeIcon {
      constructor(readonly id: string) {}
    },
  };
});

import {
  createCompatibleApiProvider,
  type CompatibleChatModel,
} from '../../src/completion/api/compatible-provider';
import type {
  CopilotReplicaNesCompletionRequest,
  FimCompletionRequest,
} from '../../src/completion/model/requests';

const fimRequest: FimCompletionRequest = {
  kind: 'fim',
  prefix: 'const value = ',
  suffix: ';',
  options: {},
};

const nesRequest: CopilotReplicaNesCompletionRequest = {
  kind: 'copilot-replica-nes',
  messages: [
    { role: 'system', content: 'system source' },
    { role: 'user', content: 'user source' },
  ],
  maxTokens: 32,
  prediction: { type: 'content', content: 'predicted source' },
  responseFormat: { kind: 'nes', format: 'unifiedXml' },
};

function cancellationController(): {
  readonly token: vscode.CancellationToken;
  cancel(): void;
} {
  let cancelled = false;
  const listeners = new Set<() => void>();
  const event: vscode.Event<unknown> = (listener, thisArgs, disposables) => {
    const callback = (): void => {
      listener.call(thisArgs, undefined);
    };
    const disposable: vscode.Disposable = {
      dispose: () => listeners.delete(callback),
    };
    listeners.add(callback);
    disposables?.push(disposable);
    return disposable;
  };
  return {
    token: {
      get isCancellationRequested(): boolean {
        return cancelled;
      },
      onCancellationRequested: event,
    },
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      for (const listener of [...listeners]) listener();
    },
  };
}

function stream(...chunks: readonly string[]): AsyncIterable<string> {
  return (async function* () {
    yield* chunks;
  })();
}

function operationEventNames(): string[] {
  return loggingMock.events.map((event) => event.name);
}

describe('Compatible Completion transport logging', () => {
  beforeEach(() => {
    loggingMock.enabled = true;
    loggingMock.contexts.length = 0;
    loggingMock.events.length = 0;
  });

  it('logs buffered LanguageModelChat wire values, chunks, and one completion', async () => {
    const calls: Array<{
      readonly messages: readonly (
        | vscode.LanguageModelChatMessage
        | vscode.LanguageModelChatMessage2
      )[];
      readonly options: vscode.LanguageModelChatRequestOptions | undefined;
    }> = [];
    const model: CompatibleChatModel = {
      async sendRequest(messages, options) {
        calls.push({ messages, options });
        const text = stream('alpha', 'beta');
        return { text, stream: text };
      },
    };
    const provider = createCompatibleApiProvider(model, {
      model: 'external-vendor/external-model',
    });
    const operation = provider.operations.fim;
    if (!operation) throw new Error('Missing compatible FIM operation.');

    await operation.execute(fimRequest, cancellationController().token);

    expect(loggingMock.contexts).toEqual([
      {
        transport: 'compatible',
        requestKind: 'fim',
        model: 'external-vendor/external-model',
      },
    ]);
    expect(operationEventNames()).toEqual([
      'request',
      'chunk',
      'chunk',
      'complete',
    ]);
    expect(loggingMock.events[0]?.args[0]).toBe(calls[0]?.messages);
    expect(loggingMock.events[0]?.args[1]).toBe(calls[0]?.options);
    expect(loggingMock.events.slice(1, 3).map((event) => event.args[0])).toEqual([
      'alpha',
      'beta',
    ]);
    expect(operationEventNames().filter((name) => name === 'complete')).toHaveLength(1);
  });

  it('wraps streaming text lazily without pre-reading or changing backpressure', async () => {
    let pulls = 0;
    const source = (async function* () {
      pulls += 1;
      yield 'first';
      pulls += 1;
      yield 'second';
    })();
    const model: CompatibleChatModel = {
      async sendRequest() {
        return { text: source, stream: source };
      },
    };
    const provider = createCompatibleApiProvider(model, {
      model: 'vendor/lazy-model',
    });
    const operation = provider.operations['copilot-replica-nes'];
    if (!operation) throw new Error('Missing compatible NES operation.');
    const response = await operation.execute(
      nesRequest,
      cancellationController().token,
    );
    const iterator = response.text[Symbol.asyncIterator]();

    expect(pulls).toBe(0);
    expect(operationEventNames()).toEqual(['request']);
    await expect(iterator.next()).resolves.toEqual({ value: 'first', done: false });
    expect(pulls).toBe(1);
    expect(operationEventNames()).toEqual(['request', 'chunk']);
    await expect(iterator.next()).resolves.toEqual({ value: 'second', done: false });
    expect(pulls).toBe(2);
    expect(operationEventNames()).toEqual(['request', 'chunk', 'chunk']);
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    expect(operationEventNames()).toEqual([
      'request',
      'chunk',
      'chunk',
      'complete',
    ]);
  });

  it('writes exactly one streaming cancellation terminal', async () => {
    const controller = cancellationController();
    const source = stream('first', 'second');
    const model: CompatibleChatModel = {
      async sendRequest() {
        return { text: source, stream: source };
      },
    };
    const provider = createCompatibleApiProvider(model, {
      model: 'vendor/cancel-model',
    });
    const operation = provider.operations['copilot-replica-nes'];
    if (!operation) throw new Error('Missing compatible NES operation.');
    const response = await operation.execute(nesRequest, controller.token);
    const iterator = response.text[Symbol.asyncIterator]();

    await iterator.next();
    controller.cancel();
    controller.cancel();
    await iterator.next();

    expect(operationEventNames().filter((name) => name === 'cancelled')).toHaveLength(1);
    expect(operationEventNames()).not.toContain('complete');
    expect(operationEventNames()).not.toContain('error');
  });

  it('records a pre-cancelled stream without requiring the response to be consumed', async () => {
    const controller = cancellationController();
    controller.cancel();
    let pulls = 0;
    const source = (async function* () {
      pulls += 1;
      yield 'unconsumed';
    })();
    const provider = createCompatibleApiProvider(
      {
        async sendRequest() {
          return { text: source, stream: source };
        },
      },
      { model: 'vendor/pre-cancelled-model' },
    );
    const operation = provider.operations['copilot-replica-nes'];
    if (!operation) throw new Error('Missing compatible NES operation.');

    await operation.execute(nesRequest, controller.token);

    expect(pulls).toBe(0);
    expect(operationEventNames()).toEqual(['request', 'cancelled']);
  });

  it('writes one error terminal for send and lazy iterator failures', async () => {
    const sendError = new Error('send failed');
    const sendProvider = createCompatibleApiProvider(
      {
        sendRequest: async () => {
          throw sendError;
        },
      },
      { model: 'vendor/send-error-model' },
    );
    const sendOperation = sendProvider.operations.fim;
    if (!sendOperation) throw new Error('Missing compatible FIM operation.');

    await expect(
      sendOperation.execute(fimRequest, cancellationController().token),
    ).rejects.toMatchObject({ cause: sendError });
    expect(operationEventNames()).toEqual(['request', 'error']);
    expect(loggingMock.events[1]?.args[0]).toBe(sendError);

    loggingMock.events.length = 0;
    const iteratorError = new Error('iterator failed');
    const source = (async function* () {
      yield 'partial';
      throw iteratorError;
    })();
    const iteratorProvider = createCompatibleApiProvider(
      {
        async sendRequest() {
          return { text: source, stream: source };
        },
      },
      { model: 'vendor/iterator-error-model' },
    );
    const iteratorOperation =
      iteratorProvider.operations['copilot-replica-nes'];
    if (!iteratorOperation) {
      throw new Error('Missing compatible NES operation.');
    }
    const response = await iteratorOperation.execute(
      nesRequest,
      cancellationController().token,
    );

    await expect(async () => {
      for await (const _chunk of response.text) {
        // Consume through the failure boundary.
      }
    }).rejects.toMatchObject({ cause: iteratorError });
    expect(operationEventNames()).toEqual(['request', 'chunk', 'error']);
    expect(loggingMock.events[2]?.args[0]).toBe(iteratorError);
  });

  it('keeps LanguageModelChat messages and options identical when logging is disabled', async () => {
    const run = async (enabled: boolean) => {
      loggingMock.enabled = enabled;
      const calls: Array<{
        readonly messages: readonly (
          | vscode.LanguageModelChatMessage
          | vscode.LanguageModelChatMessage2
        )[];
        readonly options: vscode.LanguageModelChatRequestOptions | undefined;
      }> = [];
      const model: CompatibleChatModel = {
        async sendRequest(messages, options) {
          calls.push({ messages, options });
          const text = stream('response');
          return { text, stream: text };
        },
      };
      const provider = createCompatibleApiProvider(model, {
        model: 'vendor/wire-model',
      });
      const operation = provider.operations['copilot-replica-nes'];
      if (!operation) throw new Error('Missing compatible NES operation.');
      const response = await operation.execute(
        nesRequest,
        cancellationController().token,
      );
      for await (const _chunk of response.text) {
        // Consume the public response without transforming it.
      }
      return calls.map((call) => ({
        messages: call.messages,
        options: call.options,
      }));
    };

    const enabledCalls = await run(true);
    loggingMock.events.length = 0;
    const disabledCalls = await run(false);

    expect(disabledCalls).toEqual(enabledCalls);
    expect(disabledCalls[0]?.options).toEqual({
      justification: 'Predict the next code edit',
      modelOptions: {
        max_tokens: 32,
        prediction: { type: 'content', content: 'predicted source' },
      },
    });
    expect(loggingMock.events).toEqual([]);
  });
});
