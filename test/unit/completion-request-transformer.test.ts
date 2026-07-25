import type * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import {
  REQUEST_TRANSFORMERS,
  validateRequestTransformerTable,
  type CompletionRequestExecutionContext,
  type RequestTransformerValidationTable,
} from '../../src/completion/model/request-transformer';
import type {
  CompletionRequest,
  CopilotReplicaAlgorithmCursorPredictionRequest,
  CopilotReplicaAlgorithmFimRequest,
  CopilotReplicaAlgorithmNesRequest,
  InceptionAlgorithmRequest,
  MistralAlgorithmRequest,
  SimpleAlgorithmRequest,
  ZedAlgorithmRequest,
} from '../../src/completion/model/requests';
import type {
  BufferedCompletionResponse,
  StreamingCompletionResponse,
} from '../../src/completion/model/responses';

function cancellationToken(): vscode.CancellationToken {
  return {
    isCancellationRequested: false,
    onCancellationRequested: (_listener, _thisArgs, disposables) => {
      const disposable = { dispose: () => undefined };
      disposables?.push(disposable);
      return disposable;
    },
  };
}

function textStream(...chunks: readonly string[]): AsyncIterable<string> {
  return (async function* () {
    yield* chunks;
  })();
}

function executionContext(
  requests: CompletionRequest[],
  buffered: BufferedCompletionResponse = {
    mode: 'buffered',
    choices: [
      { text: 'first', finishReason: 'stop' },
      { text: 'second', finishReason: 'length' },
    ],
    usage: { total_tokens: 7 },
  },
  streaming: StreamingCompletionResponse = {
    mode: 'streaming',
    text: textStream('stream'),
  },
): CompletionRequestExecutionContext {
  return {
    async executeFim(request) {
      requests.push(request);
      return buffered;
    },
    async executeCodeGemma(request) {
      requests.push(request);
      return buffered;
    },
    async executeCopilotReplicaNes(request) {
      requests.push(request);
      return streaming;
    },
    async executeZeta1(request) {
      requests.push(request);
      return buffered;
    },
    async executeZeta2(request) {
      requests.push(request);
      return buffered;
    },
    async executeZeta21(request) {
      requests.push(request);
      return buffered;
    },
    async executeZeta3Internal(request) {
      requests.push(request);
      return buffered;
    },
    async executeMercuryEdit(request) {
      requests.push(request);
      return buffered;
    },
    async executeCodestral(request) {
      requests.push(request);
      return buffered;
    },
  };
}

describe('completion request transformers', () => {
  it('maps Simple to FIM and adapts all buffered choices', async () => {
    const requests: CompletionRequest[] = [];
    const source: SimpleAlgorithmRequest = {
      kind: 'simple',
      prefix: 'before',
      suffix: 'after',
    };

    const response = await REQUEST_TRANSFORMERS.simple[0].run(
      source,
      executionContext(requests),
      cancellationToken(),
    );

    expect(requests).toEqual([
      { kind: 'fim', prefix: 'before', suffix: 'after', options: {} },
    ]);
    expect(response).toEqual({
      kind: 'simple',
      text: 'first',
      finishReason: 'stop',
      usage: { total_tokens: 7 },
      choices: [
        { text: 'first', finishReason: 'stop' },
        { text: 'second', finishReason: 'length' },
      ],
    });
  });

  it('maps Simple to pathless, context-free CodeGemma', async () => {
    const requests: CompletionRequest[] = [];
    const source: SimpleAlgorithmRequest = {
      kind: 'simple',
      prefix: 'before',
      suffix: 'after',
    };

    await REQUEST_TRANSFORMERS.simple[1].run(
      source,
      executionContext(requests),
      cancellationToken(),
    );

    expect(requests).toEqual([
      {
        kind: 'codegemma',
        prefix: 'before',
        suffix: 'after',
        contexts: [],
        options: {},
      },
    ]);
  });

  it('drops Copilot path, contexts, metadata, and temperature from FIM', async () => {
    const requests: CompletionRequest[] = [];
    const source: CopilotReplicaAlgorithmFimRequest = {
      kind: 'copilot-replica/fim',
      targetPath: 'src/file.ts',
      prefix: 'before',
      suffix: 'after',
      contexts: [{ path: 'src/context.ts', content: 'context' }],
      options: { candidateCount: 3, maxTokens: 40, stop: ['END'] },
      metadata: {
        languageId: 'typescript',
        nextIndent: 2,
        trimByIndentation: true,
        promptTokens: 100,
        suffixTokens: 5,
        codeAnnotations: false,
      },
    };

    await REQUEST_TRANSFORMERS['copilot-replica/fim'][0].run(
      source,
      executionContext(requests),
      cancellationToken(),
    );

    expect(requests).toEqual([
      {
        kind: 'fim',
        prefix: 'before',
        suffix: 'after',
        options: { candidateCount: 3, maxTokens: 40, stop: ['END'] },
      },
    ]);
    expect(requests[0]).not.toHaveProperty('temperature');
    expect(requests[0]).not.toHaveProperty('metadata');
    expect(requests[0]).not.toHaveProperty('contexts');
    expect(requests[0]).not.toHaveProperty('targetPath');
  });

  it('preserves safe structured Copilot context for CodeGemma', async () => {
    const requests: CompletionRequest[] = [];
    const contexts = [{ path: 'src/context.ts', content: 'context' }];
    const source: CopilotReplicaAlgorithmFimRequest = {
      kind: 'copilot-replica/fim',
      targetPath: 'src/file.ts',
      prefix: 'before',
      suffix: 'after',
      contexts,
      options: { maxTokens: 40 },
    };

    await REQUEST_TRANSFORMERS['copilot-replica/fim'][1].run(
      source,
      executionContext(requests),
      cancellationToken(),
    );

    expect(requests).toEqual([
      {
        kind: 'codegemma',
        targetPath: 'src/file.ts',
        prefix: 'before',
        suffix: 'after',
        contexts,
        options: { maxTokens: 40 },
      },
    ]);
  });

  it('round-trips NES messages, prediction, response format, and stream', async () => {
    const requests: CompletionRequest[] = [];
    const stream = textStream('one', 'two');
    const source: CopilotReplicaAlgorithmNesRequest = {
      kind: 'copilot-replica/nes',
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'user' },
      ],
      maxTokens: 80,
      prediction: { type: 'content', content: 'predicted' },
      responseFormat: { kind: 'nes', format: 'unifiedXml' },
    };

    const response = await REQUEST_TRANSFORMERS['copilot-replica/nes'][0].run(
      source,
      executionContext(requests, undefined, {
        mode: 'streaming',
        text: stream,
      }),
      cancellationToken(),
    );

    expect(requests).toEqual([
      {
        kind: 'copilot-replica-nes',
        messages: source.messages,
        maxTokens: 80,
        prediction: source.prediction,
        responseFormat: source.responseFormat,
      },
    ]);
    expect(response.kind).toBe('copilot-replica/nes');
    expect(response.text).toBe(stream);
  });

  it('uses the cursor response kind without inventing prediction options', async () => {
    const requests: CompletionRequest[] = [];
    const stream = textStream('12');
    const source: CopilotReplicaAlgorithmCursorPredictionRequest = {
      kind: 'copilot-replica/cursor-prediction',
      messages: [{ role: 'user', content: 'cursor' }],
      maxTokens: 40,
      responseFormat: { kind: 'cursor-prediction' },
    };

    const response = await REQUEST_TRANSFORMERS[
      'copilot-replica/cursor-prediction'
    ][0].run(
      source,
      executionContext(requests, undefined, {
        mode: 'streaming',
        text: stream,
      }),
      cancellationToken(),
    );

    expect(requests).toEqual([
      {
        kind: 'copilot-replica-nes',
        messages: source.messages,
        maxTokens: 40,
        responseFormat: source.responseFormat,
      },
    ]);
    expect(response.kind).toBe('copilot-replica/cursor-prediction');
    expect(response.text).toBe(stream);
  });

  it('declares and executes edit-prediction targets in their fixed priority order', async () => {
    expect(REQUEST_TRANSFORMERS.zed.map(({ targetKind }) => targetKind)).toEqual([
      'zeta3-internal',
      'zeta2.1',
      'zeta2',
      'zeta1',
    ]);
    expect(
      REQUEST_TRANSFORMERS.inception.map(({ targetKind }) => targetKind),
    ).toEqual(['mercury-edit-2']);
    expect(
      REQUEST_TRANSFORMERS.mistral.map(({ targetKind }) => targetKind),
    ).toEqual(['codestral']);

    const document = {
      uri: 'file:///workspace/main.ts',
      path: 'main.ts',
      languageId: 'typescript',
      version: 3,
      text: 'const value = 1;',
      cursorOffset: 14,
    };
    const zed: ZedAlgorithmRequest = {
      kind: 'zed',
      document,
      trigger: 'explicit',
      editHistory: [],
      contexts: [{ path: 'context.ts', content: 'export {};' }],
      diagnostics: [
        {
          severity: 1,
          message: 'diagnostic',
          snippet: 'const value = 1;',
          snippetStartRow: 0,
          snippetEndRow: 1,
          diagnosticStartByte: 0,
          diagnosticEndByte: 5,
        },
      ],
      maxTokens: 64,
    };
    const requests: CompletionRequest[] = [];
    const zedResponse = await REQUEST_TRANSFORMERS.zed[0].run(
      zed,
      executionContext(requests),
      cancellationToken(),
    );
    expect(requests).toEqual([
      {
        kind: 'zeta3-internal',
        document,
        trigger: 'explicit',
        editHistory: [],
        diagnostics: zed.diagnostics,
      },
    ]);
    expect(zedResponse).toMatchObject({ kind: 'zed', text: 'first' });

    const inception: InceptionAlgorithmRequest = {
      kind: 'inception',
      document,
      editHistory: [],
      contexts: zed.contexts,
    };
    await REQUEST_TRANSFORMERS.inception[0].run(
      inception,
      executionContext(requests),
      cancellationToken(),
    );
    const mistral: MistralAlgorithmRequest = {
      kind: 'mistral',
      document: {
        ...document,
        text: 'beforeafter',
        cursorOffset: 'before'.length,
      },
      maxTokens: 150,
    };
    await REQUEST_TRANSFORMERS.mistral[0].run(
      mistral,
      executionContext(requests),
      cancellationToken(),
    );
    expect(requests.slice(1)).toEqual([
      {
        kind: 'mercury-edit-2',
        document,
        editHistory: [],
        contexts: zed.contexts,
      },
      {
        kind: 'codestral',
        prefix: 'before',
        suffix: 'after',
        options: { maxTokens: 150 },
      },
    ]);
  });
});

describe('completion request transformer registry validation', () => {
  it('accepts the complete built-in table', () => {
    expect(() => validateRequestTransformerTable()).not.toThrow();
  });

  it('rejects duplicate and empty target registrations', () => {
    const duplicate: RequestTransformerValidationTable = {
      ...REQUEST_TRANSFORMERS,
      simple: [REQUEST_TRANSFORMERS.simple[0], REQUEST_TRANSFORMERS.simple[0]],
    };
    const empty: RequestTransformerValidationTable = {
      ...REQUEST_TRANSFORMERS,
      simple: [],
    };

    expect(() => validateRequestTransformerTable(duplicate)).toThrow(
      '"simple" -> "fim" is duplicated',
    );
    expect(() => validateRequestTransformerTable(empty)).toThrow(
      'source "simple" has no targets',
    );
  });

  it('rejects missing, unknown, and undeclared source/target registrations', () => {
    const { simple: _simple, ...missingSimple } = REQUEST_TRANSFORMERS;
    const unknownSource: RequestTransformerValidationTable = {
      ...REQUEST_TRANSFORMERS,
      unknown: [],
    };
    const wrongSource: RequestTransformerValidationTable = {
      ...REQUEST_TRANSFORMERS,
      simple: [
        {
          ...REQUEST_TRANSFORMERS.simple[0],
          sourceKind: 'copilot-replica/fim',
        },
        REQUEST_TRANSFORMERS.simple[1],
      ],
    };
    const undeclaredTarget: RequestTransformerValidationTable = {
      ...REQUEST_TRANSFORMERS,
      simple: [
        REQUEST_TRANSFORMERS.simple[0],
        REQUEST_TRANSFORMERS.simple[1],
        {
          ...REQUEST_TRANSFORMERS.simple[1],
          targetKind: 'copilot-replica-nes',
          responseMode: 'streaming',
        },
      ],
    };

    expect(() => validateRequestTransformerTable(missingSimple)).toThrow(
      'source "simple" is missing',
    );
    expect(() => validateRequestTransformerTable(unknownSource)).toThrow(
      'source "unknown" is not declared',
    );
    expect(() => validateRequestTransformerTable(wrongSource)).toThrow(
      'registered under "simple" declares source "copilot-replica/fim"',
    );
    expect(() => validateRequestTransformerTable(undeclaredTarget)).toThrow(
      '"simple" -> "copilot-replica-nes" is not declared',
    );
  });

  it('rejects missing priority targets and incompatible response modes', () => {
    const missingTarget: RequestTransformerValidationTable = {
      ...REQUEST_TRANSFORMERS,
      simple: [REQUEST_TRANSFORMERS.simple[0]],
    };
    const reversedTargets: RequestTransformerValidationTable = {
      ...REQUEST_TRANSFORMERS,
      simple: [
        REQUEST_TRANSFORMERS.simple[1],
        REQUEST_TRANSFORMERS.simple[0],
      ],
    };
    const wrongMode: RequestTransformerValidationTable = {
      ...REQUEST_TRANSFORMERS,
      simple: [
        {
          ...REQUEST_TRANSFORMERS.simple[0],
          responseMode: 'streaming',
        },
        REQUEST_TRANSFORMERS.simple[1],
      ],
    };

    expect(() => validateRequestTransformerTable(missingTarget)).toThrow(
      '"simple" -> "codegemma" is missing',
    );
    expect(() => validateRequestTransformerTable(reversedTargets)).toThrow(
      'requires target "fim" at priority 1',
    );
    expect(() => validateRequestTransformerTable(wrongMode)).toThrow(
      'incompatible response mode "streaming"',
    );
  });
});
