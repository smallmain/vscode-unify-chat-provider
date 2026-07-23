import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderType } from '../../src/client/definitions';
import {
  createCompatibleApiProvider,
  type CompatibleChatModel,
} from '../../src/completion/api/compatible-provider';
import {
  buildOpenAICodeGemmaRequestBody,
  buildOpenAIFimRequestBody,
  createOpenAICompletionsApiProvider,
  parseOpenAICompletionsResponse,
} from '../../src/completion/api/openai-completions-provider';
import { runNativeCompletionOperation } from '../../src/completion/api/http';
import { buildCompletionBaseUrl } from '../../src/completion/api/base-url';
import { nativeCompletionApiProviderRegistry } from '../../src/completion/api/registry';
import {
  buildOllamaCodeGemmaRequestBody,
  buildOllamaFimRequestBody,
  createOllamaGenerateApiProvider,
  parseOllamaGenerateResponse,
} from '../../src/completion/api/ollama-generate-provider';
import type { NativeCompletionApiContext } from '../../src/completion/api/provider';
import type {
  CodeGemmaCompletionRequest,
  CodestralCompletionRequest,
  CopilotReplicaNesCompletionRequest,
  FimCompletionRequest,
  MercuryEditCompletionRequest,
} from '../../src/completion/model/requests';
import { FIM_PROTOCOL_STOPS } from '../../src/completion/template/fim';
import { CompletionRuntimeError } from '../../src/completion/model/errors';
import type { ModelConfig, ProviderConfig } from '../../src/types';

const vscodeMockState = vi.hoisted(() => ({
  verbose: false,
  outputChannelNames: [] as string[],
  logs: [] as Array<{
    level: 'info' | 'warn' | 'error';
    message: string;
  }>,
}));

vi.mock('vscode', () => {
  class Disposable {
    constructor(private readonly callback: () => void = () => undefined) {}

    dispose(): void {
      this.callback();
    }
  }

  class EventEmitter<T> {
    private readonly listeners = new Set<(value: T) => void>();
    readonly event = (listener: (value: T) => void): Disposable => {
      this.listeners.add(listener);
      return new Disposable(() => this.listeners.delete(listener));
    };

    fire(value: T): void {
      for (const listener of this.listeners) listener(value);
    }

    dispose(): void {
      this.listeners.clear();
    }
  }

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
    Disposable,
    EventEmitter,
    LanguageModelChatMessage,
    LanguageModelChatMessageRole: { User: 1, Assistant: 2, System: 3 },
    ThemeIcon: class ThemeIcon {
      constructor(readonly id: string) {}
    },
    extensions: { getExtension: () => undefined },
    l10n: { t: (message: string) => message },
    workspace: {
      getConfiguration: () => ({
        get: (key: string, defaultValue?: unknown) =>
          key === 'verbose' ? vscodeMockState.verbose : defaultValue,
      }),
    },
    window: {
      createOutputChannel: (name: string) => {
        vscodeMockState.outputChannelNames.push(name);
        return {
          info: (message: string) =>
            vscodeMockState.logs.push({ level: 'info', message }),
          warn: (message: string) =>
            vscodeMockState.logs.push({ level: 'warn', message }),
          error: (message: string) =>
            vscodeMockState.logs.push({ level: 'error', message }),
        };
      },
    },
  };
});

const fimRequest: FimCompletionRequest = {
  kind: 'fim',
  prefix: 'const value = ',
  suffix: ';\n',
  options: { maxTokens: 20, candidateCount: 2, stop: ['END', ''] },
};

const codeGemmaRequest: CodeGemmaCompletionRequest = {
  kind: 'codegemma',
  targetPath: 'src/main.ts',
  prefix: 'const value = ',
  suffix: ';\n',
  contexts: [
    { path: 'src/context.ts', content: 'export const context = 1;' },
  ],
  options: { maxTokens: 30, candidateCount: 3, stop: ['END'] },
};

const nesRequest: CopilotReplicaNesCompletionRequest = {
  kind: 'copilot-replica-nes',
  messages: [
    { role: 'system', content: 'system bytes' },
    { role: 'user', content: 'user bytes' },
  ],
  maxTokens: 40,
  prediction: { type: 'content', content: 'predicted bytes' },
  responseFormat: { kind: 'nes', format: 'unifiedXml' },
};

function createModel(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id: 'code-model#variant',
    maxOutputTokens: 64,
    ...overrides,
  };
}

function createProvider(
  type: ProviderType,
  model: ModelConfig,
  baseUrl = 'https://example.test',
  overrides: Partial<ProviderConfig> = {},
): ProviderConfig {
  return {
    type,
    name: 'completion-test',
    baseUrl,
    models: [model],
    retry: {
      maxRetries: 0,
      initialDelayMs: 1,
      maxDelayMs: 1,
      backoffMultiplier: 1,
      jitterFactor: 0,
    },
    proxy: { type: 'direct' },
    ...overrides,
  };
}

function cancellationToken(cancelled = false): vscode.CancellationToken {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: (_listener, _thisArgs, disposables) => {
      const disposable = { dispose: () => undefined };
      disposables?.push(disposable);
      return disposable;
    },
  };
}

function stream(...chunks: readonly string[]): AsyncIterable<string> {
  return (async function* () {
    yield* chunks;
  })();
}

async function collectText(chunks: AsyncIterable<string>): Promise<string> {
  let result = '';
  for await (const chunk of chunks) result += chunk;
  return result;
}

describe('native Completion API request bodies', () => {
  it('builds OpenAI FIM with validated options and immutable protocol fields', () => {
    const model = createModel({
      temperature: 0.7,
      topP: 0.8,
      frequencyPenalty: 0.1,
      presencePenalty: 0.2,
      extraBody: {
        shared: 'model',
        max_tokens: 2,
        n: 8,
        model: 'wrong-model',
        prompt: 'wrong-prompt',
        suffix: 'wrong-suffix',
        stop: ['wrong-stop'],
        stream: true,
      },
    });
    const provider = createProvider('openai-chat-completion', model, undefined, {
      extraBody: {
        shared: 'provider',
        max_tokens: 1,
        n: 9,
        provider_field: true,
      },
    });

    expect(buildOpenAIFimRequestBody(provider, model, fimRequest)).toEqual({
      temperature: 0.7,
      top_p: 0.8,
      frequency_penalty: 0.1,
      presence_penalty: 0.2,
      shared: 'model',
      provider_field: true,
      max_tokens: 20,
      n: 2,
      model: 'code-model',
      prompt: 'const value = ',
      suffix: ';\n',
      stop: [...FIM_PROTOCOL_STOPS],
      stream: false,
    });
  });

  it('builds OpenAI CodeGemma with one complete PSM prompt and no suffix', () => {
    const model = createModel({
      extraBody: {
        suffix: 'wrong-model-suffix',
        raw: true,
        messages: ['wrong-model-messages'],
        prediction: { type: 'content', content: 'wrong-prediction' },
      },
    });
    const body = buildOpenAICodeGemmaRequestBody(
      createProvider('openai-responses', model, undefined, {
        extraBody: {
          suffix: 'wrong-provider-suffix',
          input: 'wrong-input',
          options: { stop: ['wrong-nested-stop'] },
        },
      }),
      model,
      codeGemmaRequest,
    );

    expect(body).toEqual({
      max_tokens: 30,
      n: 3,
      model: 'code-model',
      prompt:
        'src/context.ts\nexport const context = 1;<|file_separator|>src/main.ts\n<|fim_prefix|>const value = <|fim_suffix|>;\n<|fim_middle|>',
      stop: [...FIM_PROTOCOL_STOPS],
      stream: false,
    });
    expect(body).not.toHaveProperty('suffix');
    expect(body).not.toHaveProperty('raw');
    expect(body).not.toHaveProperty('messages');
    expect(body).not.toHaveProperty('input');
    expect(body).not.toHaveProperty('options');
    expect(body).not.toHaveProperty('prediction');
  });

  it('merges Ollama options by field and protects final FIM fields', () => {
    const model = createModel({
      temperature: 0.7,
      topK: 10,
      topP: 0.8,
      frequencyPenalty: 0.1,
      presencePenalty: 0.2,
      extraBody: {
        shared: 'model',
        prompt: 'wrong-prompt',
        suffix: 'wrong-suffix',
        raw: true,
        stream: true,
        stop: ['wrong-top-level-stop'],
        options: {
          shared_option: 'model',
          top_k: 30,
          num_predict: 2,
          stop: ['wrong-nested-stop'],
          prediction: {
            type: 'content',
            content: 'wrong-nested-prediction',
          },
        },
      },
    });
    const provider = createProvider('ollama', model, undefined, {
      extraBody: {
        provider_field: true,
        shared: 'provider',
        stop: ['wrong-provider-stop'],
        options: {
          provider_option: true,
          shared_option: 'provider',
          temperature: 0.4,
        },
      },
    });
    const body = buildOllamaFimRequestBody(provider, model, fimRequest);

    expect(body).toEqual({
      provider_field: true,
      shared: 'model',
      model: 'code-model',
      prompt: 'const value = ',
      suffix: ';\n',
      raw: false,
      options: {
        num_predict: 20,
        temperature: 0.4,
        top_k: 30,
        top_p: 0.8,
        frequency_penalty: 0.1,
        presence_penalty: 0.2,
        provider_option: true,
        shared_option: 'model',
        stop: ['END', ...FIM_PROTOCOL_STOPS],
      },
      stream: false,
    });
    expect(body).not.toHaveProperty('stop');
  });

  it('builds Ollama CodeGemma as raw PSM without a suffix field', () => {
    const model = createModel({
      extraBody: {
        suffix: 'wrong-model-suffix',
        input: 'wrong-input',
        messages: ['wrong-messages'],
        prediction: { type: 'content', content: 'wrong-prediction' },
      },
    });
    const body = buildOllamaCodeGemmaRequestBody(
      createProvider('ollama', model, undefined, {
        extraBody: {
          suffix: 'wrong-provider-suffix',
          stop: ['wrong-top-level-stop'],
        },
      }),
      model,
      codeGemmaRequest,
    );

    expect(body).toMatchObject({
      model: 'code-model',
      prompt:
        'src/context.ts\nexport const context = 1;<|file_separator|>src/main.ts\n<|fim_prefix|>const value = <|fim_suffix|>;\n<|fim_middle|>',
      raw: true,
      options: {
        num_predict: 30,
        stop: ['END', ...FIM_PROTOCOL_STOPS],
      },
      stream: false,
    });
    expect(body).not.toHaveProperty('suffix');
    expect(body).not.toHaveProperty('input');
    expect(body).not.toHaveProperty('messages');
    expect(body).not.toHaveProperty('prediction');
    expect(body).not.toHaveProperty('stop');
  });
});

describe('native Completion API response validation', () => {
  it('keeps a valid empty OpenAI result but rejects every malformed choice', () => {
    expect(parseOpenAICompletionsResponse({ choices: [] }, [])).toEqual({
      mode: 'buffered',
      choices: [],
    });
    expect(() =>
      parseOpenAICompletionsResponse({ choices: [{}] }, []),
    ).toThrow(CompletionRuntimeError);
    try {
      parseOpenAICompletionsResponse({ choices: [{ text: 1 }] }, []);
    } catch (error) {
      expect(error).toMatchObject({ code: 'completion-invalid-response' });
    }
  });

  it('uses the same stable invalid-response code for Ollama', () => {
    expect(() => parseOllamaGenerateResponse({ response: 1 }, [])).toThrow(
      CompletionRuntimeError,
    );
    try {
      parseOllamaGenerateResponse({}, []);
    } catch (error) {
      expect(error).toMatchObject({ code: 'completion-invalid-response' });
    }
  });
});

describe('Completion API runtime error boundary', () => {
  it.each([
    ['OpenAI Completions', 'openai-chat-completion', createOpenAICompletionsApiProvider],
    ['Ollama Generate', 'ollama', createOllamaGenerateApiProvider],
  ] as const)(
    'wraps %s credential failures with the stable request code',
    async (_label, providerType, createProviderApi) => {
      const model = createModel();
      const provider = createProvider(providerType, model);
      const credentialError = new Error('credential lookup failed');
      const api = createProviderApi({
        ...nativeContext(provider, model),
        resolveCredential: async () => {
          throw credentialError;
        },
      });
      const operation = api.operations.fim;
      if (operation === undefined) throw new Error('Missing FIM operation.');

      await expect(
        operation.execute(fimRequest, cancellationToken()),
      ).rejects.toMatchObject({
        code: 'completion-request-failed',
        cause: credentialError,
      });
    },
  );

  it('wraps compatible send and buffered iterator failures', async () => {
    const sendError = new Error('compatible send failed');
    const sendProvider = createCompatibleApiProvider(
      {
        sendRequest: async () => {
          throw sendError;
        },
      },
      { model: 'test/send-error' },
    );
    const sendOperation = sendProvider.operations.fim;
    if (sendOperation === undefined) throw new Error('Missing FIM operation.');
    await expect(
      sendOperation.execute(fimRequest, cancellationToken()),
    ).rejects.toMatchObject({
      code: 'completion-request-failed',
      cause: sendError,
    });

    const iteratorError = new Error('compatible iterator failed');
    const iteratorProvider = createCompatibleApiProvider(
      {
        async sendRequest() {
          const text = (async function* () {
            yield 'partial';
            throw iteratorError;
          })();
          return { text, stream: text };
        },
      },
      { model: 'test/buffered-iterator-error' },
    );
    const iteratorOperation = iteratorProvider.operations.fim;
    if (iteratorOperation === undefined) throw new Error('Missing FIM operation.');
    await expect(
      iteratorOperation.execute(fimRequest, cancellationToken()),
    ).rejects.toMatchObject({
      code: 'completion-request-failed',
      cause: iteratorError,
    });
  });

  it('wraps lazy compatible NES iterator failures and preserves cancellation', async () => {
    const iteratorError = new Error('NES iterator failed');
    const provider = createCompatibleApiProvider(
      {
        async sendRequest() {
          const text = (async function* () {
            yield 'partial';
            throw iteratorError;
          })();
          return { text, stream: text };
        },
      },
      { model: 'test/nes-iterator-error' },
    );
    const operation = provider.operations['copilot-replica-nes'];
    if (operation === undefined) throw new Error('Missing NES operation.');
    const response = await operation.execute(nesRequest, cancellationToken());
    await expect(collectText(response.text)).rejects.toMatchObject({
      code: 'completion-request-failed',
      cause: iteratorError,
    });

    const cancellation = new Error('cancelled');
    cancellation.name = 'Canceled';
    const cancelledProvider = createCompatibleApiProvider(
      {
        sendRequest: async () => {
          throw cancellation;
        },
      },
      { model: 'test/cancelled' },
    );
    const cancelledOperation = cancelledProvider.operations.fim;
    if (cancelledOperation === undefined) throw new Error('Missing FIM operation.');
    await expect(
      cancelledOperation.execute(fimRequest, cancellationToken(true)),
    ).rejects.toBe(cancellation);

    const abortError = new Error('transport abort');
    abortError.name = 'AbortError';
    const abortedProvider = createCompatibleApiProvider(
      {
        sendRequest: async () => {
          throw abortError;
        },
      },
      { model: 'test/aborted' },
    );
    const abortedOperation = abortedProvider.operations.fim;
    if (abortedOperation === undefined) throw new Error('Missing FIM operation.');
    await expect(
      abortedOperation.execute(fimRequest, cancellationToken()),
    ).rejects.toMatchObject({
      code: 'completion-request-failed',
      cause: abortError,
    });
  });
});

interface RecordedRequest {
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly headers: IncomingMessage['headers'];
  readonly body: Record<string, unknown>;
}

interface StubServer {
  readonly baseUrl: string;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

type StubHandler = (
  request: RecordedRequest,
  response: ServerResponse,
) => void | Promise<void>;

const openServers = new Set<StubServer>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJsonBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!isRecord(value)) throw new Error('Expected a JSON object request body.');
  return value;
}

async function startStubServer(handler: StubHandler): Promise<StubServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (incoming, response) => {
    try {
      const request: RecordedRequest = {
        method: incoming.method,
        path: incoming.url,
        headers: incoming.headers,
        body: await readJsonBody(incoming),
      };
      requests.push(request);
      await handler(request, response);
    } catch (error) {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected the HTTP stub to listen on a TCP port.');
  }
  const stub: StubServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
  openServers.add(stub);
  return stub;
}

function respondJson(
  response: ServerResponse,
  value: unknown,
  status = 200,
): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(value));
}

function nativeContext(
  provider: ProviderConfig,
  model: ModelConfig,
  completionBaseUrl?: string,
): NativeCompletionApiContext {
  return {
    provider,
    model,
    completion: {
      transport: 'native',
      templates: 'all',
      ...(completionBaseUrl === undefined
        ? {}
        : { baseUrl: completionBaseUrl }),
    },
    resolveCredential: async () => ({
      kind: 'token',
      token: 'secret-token',
      tokenType: 'Token',
    }),
  };
}

describe('native Completion API base URL', () => {
  it('resolves relative completion paths after normalizing the provider API base', () => {
    const model = createModel();
    const withoutVersion = createProvider(
      'openai-chat-completion',
      model,
      'https://example.test',
    );
    const withVersion = createProvider(
      'openai-chat-completion',
      model,
      'https://example.test/v1',
    );
    const options = {
      ensureSuffix: '/v1',
      skipSuffixIfMatch: /\/v\d+$/,
    };

    expect(
      buildCompletionBaseUrl(
        nativeContext(withoutVersion, model, './edit'),
        options,
      ),
    ).toBe('https://example.test/v1/edit');
    expect(
      buildCompletionBaseUrl(
        nativeContext(withVersion, model, './fim'),
        options,
      ),
    ).toBe('https://example.test/v1/fim');
    expect(
      buildCompletionBaseUrl(
        nativeContext(
          createProvider(
            'openai-chat-completion',
            model,
            'https://api.deepseek.com',
          ),
          model,
          '../beta',
        ),
        options,
      ),
    ).toBe('https://api.deepseek.com/beta');
  });

  it('keeps absolute completion base URLs as replacements', () => {
    const model = createModel();
    const provider = createProvider(
      'openai-chat-completion',
      model,
      'https://example.test/v1',
    );
    expect(
      buildCompletionBaseUrl(
        nativeContext(provider, model, 'https://completion.test/custom'),
        { ensureSuffix: '/v1', skipSuffixIfMatch: /\/v\d+$/ },
      ),
    ).toBe('https://completion.test/custom/v1');
  });
});

afterEach(async () => {
  const servers = [...openServers];
  openServers.clear();
  await Promise.all(servers.map((server) => server.close()));
  vscodeMockState.verbose = false;
  vscodeMockState.outputChannelNames.length = 0;
  vscodeMockState.logs.length = 0;
  vi.restoreAllMocks();
});

describe('native Completion API HTTP transport', () => {
  it('rejects a changed completion target before dispatching credentials', async () => {
    const oldServer = await startStubServer((_request, response) => {
      respondJson(response, { choices: [{ text: 'old-target' }] });
    });
    const newServer = await startStubServer((_request, response) => {
      respondJson(response, { choices: [{ text: 'new-target' }] });
    });
    const model = createModel();
    const bindingId = '00000000-0000-4000-8000-000000000201';
    const oldProvider = createProvider(
      'openai-chat-completion',
      model,
      'https://api.example.test/v1',
      {
        auth: { method: 'openai-codex', bindingId },
        completion: { baseUrl: oldServer.baseUrl },
      },
    );
    const newProvider = {
      ...oldProvider,
      completion: { baseUrl: newServer.baseUrl },
    };
    let currentProvider: ProviderConfig = oldProvider;
    const resolveCredential = vi.fn(async () => {
      currentProvider = newProvider;
      return {
        kind: 'token' as const,
        token: 'new-target-token',
        tokenType: 'Bearer',
        authContext: {
          method: 'openai-codex' as const,
          bindingId,
          sessionId: '00000000-0000-4000-8000-000000000202',
          revision: 2,
        },
      };
    });
    const operation = createOpenAICompletionsApiProvider({
      ...nativeContext(oldProvider, model, oldServer.baseUrl),
      resolveCredential,
      resolveProvider: () => currentProvider,
    }).operations.fim;
    if (operation === undefined) {
      throw new Error('Missing OpenAI FIM operation.');
    }

    await expect(
      operation.execute(fimRequest, cancellationToken()),
    ).rejects.toMatchObject({
      code: 'completion-request-failed',
      cause: {
        message:
          'Authentication configuration changed while the completion request was starting. Please retry.',
      },
    });

    expect(resolveCredential).toHaveBeenCalledTimes(1);
    expect(oldServer.requests).toHaveLength(0);
    expect(newServer.requests).toHaveLength(0);
  });

  it('keeps the original request snapshot when unrelated provider fields change', async () => {
    const server = await startStubServer((_request, response) => {
      respondJson(response, { choices: [{ text: 'old-snapshot' }] });
    });
    const model = createModel();
    const bindingId = '00000000-0000-4000-8000-000000000203';
    const originalProvider = createProvider(
      'openai-chat-completion',
      model,
      'https://api.example.test/v1',
      {
        auth: { method: 'openai-codex', bindingId },
        completion: { baseUrl: server.baseUrl },
      },
    );
    const updatedProvider: ProviderConfig = {
      ...originalProvider,
      models: [...originalProvider.models, { id: 'unrelated-model' }],
      autoFetchOfficialModels: true,
      extraBody: { arrivedFromSync: true },
    };
    let currentProvider = originalProvider;
    const resolveCredential = vi.fn(async () => {
      currentProvider = updatedProvider;
      return {
        kind: 'token' as const,
        token: 'snapshot-token',
        tokenType: 'Bearer',
        authContext: {
          method: 'openai-codex' as const,
          bindingId,
          sessionId: '00000000-0000-4000-8000-000000000204',
          revision: 2,
        },
      };
    });
    const operation = createOpenAICompletionsApiProvider({
      ...nativeContext(originalProvider, model, server.baseUrl),
      resolveCredential,
      resolveProvider: () => currentProvider,
    }).operations.fim;
    if (operation === undefined) {
      throw new Error('Missing OpenAI FIM operation.');
    }

    await expect(
      operation.execute(fimRequest, cancellationToken()),
    ).resolves.toMatchObject({ choices: [{ text: 'old-snapshot' }] });

    expect(resolveCredential).toHaveBeenCalledOnce();
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.headers.authorization).toBe(
      'Bearer snapshot-token',
    );
    expect(server.requests[0]?.body).not.toHaveProperty('arrivedFromSync');
  });

  it('combines relative completion roots with template-selected endpoints', async () => {
    const server = await startStubServer((_request, response) => {
      respondJson(response, {
        choices: [{ message: { content: 'result' }, finish_reason: 'stop' }],
      });
    });

    const mercuryModel = createModel({ id: 'mercury-edit-2' });
    const mercuryProvider = createProvider(
      'openai-chat-completion',
      mercuryModel,
      `${server.baseUrl}/v1`,
    );
    const mercuryApi = nativeCompletionApiProviderRegistry.create({
      ...nativeContext(mercuryProvider, mercuryModel, './edit'),
      completion: {
        transport: 'native',
        baseUrl: './edit',
        templates: ['mercury-edit-2'],
      },
    });
    const mercuryOperation = mercuryApi?.operations['mercury-edit-2'];
    if (mercuryOperation === undefined) {
      throw new Error('Missing Mercury Edit operation.');
    }
    const mercuryRequest: MercuryEditCompletionRequest = {
      kind: 'mercury-edit-2',
      document: {
        uri: 'file:///workspace/main.ts',
        path: 'src/main.ts',
        languageId: 'typescript',
        version: 1,
        text: 'const value = 1;\n',
        cursorOffset: 14,
      },
      editHistory: [],
      contexts: [],
    };
    await mercuryOperation.execute(mercuryRequest, cancellationToken());

    const codestralModel = createModel({ id: 'codestral-2508' });
    const codestralProvider = createProvider(
      'openai-chat-completion',
      codestralModel,
      `${server.baseUrl}/v1`,
    );
    const codestralApi = nativeCompletionApiProviderRegistry.create({
      ...nativeContext(codestralProvider, codestralModel, './fim'),
      completion: {
        transport: 'native',
        baseUrl: './fim',
        templates: ['codestral'],
      },
    });
    const codestralOperation = codestralApi?.operations.codestral;
    if (codestralOperation === undefined) {
      throw new Error('Missing Codestral operation.');
    }
    const codestralRequest: CodestralCompletionRequest = {
      kind: 'codestral',
      prefix: 'const value = ',
      suffix: ';\n',
      options: {},
    };
    await codestralOperation.execute(codestralRequest, cancellationToken());

    expect(server.requests.map((request) => request.path)).toEqual([
      '/v1/edit/completions',
      '/v1/fim/completions',
    ]);
  });

  it('uses the completion URL, merged headers, retry policy, and local stops', async () => {
    vscodeMockState.verbose = true;
    let attempt = 0;
    const server = await startStubServer((_request, response) => {
      attempt += 1;
      if (attempt === 1) {
        respondJson(response, { error: 'retry' }, 503);
        return;
      }
      respondJson(response, {
        choices: [
          { text: 'firstENDignored', finish_reason: 'length' },
          {
            text: 'second<|fim_suffix|>ignored',
            finish_reason: 'stop',
          },
        ],
        usage: { total_tokens: 7 },
      });
    });
    const model = createModel({
      extraHeaders: { 'X-Shared': 'model', 'X-Model': 'model-value' },
    });
    const provider = createProvider(
      'openai-chat-completion',
      model,
      `${server.baseUrl}/chat`,
      {
        extraHeaders: {
          'X-Shared': 'provider',
          'X-Provider': 'provider-value',
        },
        retry: {
          maxRetries: 1,
          initialDelayMs: 1,
          maxDelayMs: 1,
          backoffMultiplier: 1,
          jitterFactor: 0,
        },
      },
    );
    const operation = createOpenAICompletionsApiProvider(
      nativeContext(provider, model, `${server.baseUrl}/completion`),
    ).operations.fim;
    if (operation === undefined) throw new Error('Missing OpenAI FIM operation.');

    await expect(
      operation.execute(fimRequest, cancellationToken()),
    ).resolves.toEqual({
      mode: 'buffered',
      choices: [
        { text: 'first', finishReason: 'length' },
        { text: 'second', finishReason: 'stop' },
      ],
      usage: { total_tokens: 7 },
    });
    expect(server.requests).toHaveLength(2);
    const request = server.requests[1];
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/completion/v1/completions');
    expect(request.headers.authorization).toBe('Token secret-token');
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.headers['x-provider']).toBe('provider-value');
    expect(request.headers['x-model']).toBe('model-value');
    expect(request.headers['x-shared']).toBe('model');
    expect(request.body).toMatchObject({
      model: 'code-model',
      max_tokens: 20,
      n: 2,
      stop: [...FIM_PROTOCOL_STOPS],
      stream: false,
    });

    const messages = vscodeMockState.logs.map((entry) => entry.message);
    expect(messages.some((message) => message.includes('[native:fim]'))).toBe(
      true,
    );
    expect(
      messages.some((message) =>
        message.includes('Model: completion-test/code-model#variant'),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (message) =>
          message.includes('Request Headers:') &&
          message.includes('"Authorization": "[REDACTED]"'),
      ),
    ).toBe(true);
    expect(messages.some((message) => message.includes('secret-token'))).toBe(
      false,
    );
    expect(
      messages.some(
        (message) =>
          message.includes('Request Body:') &&
          message.includes('"prompt": "const value = "'),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (message) =>
          message.includes('Retry 1/1') && message.includes('HTTP 503'),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (message) =>
          message.includes('Retry Response Body:') &&
          message.includes('"retry"'),
      ),
    ).toBe(true);
    expect(
      messages.filter((message) => message.includes('Request completed')),
    ).toHaveLength(1);
    expect(
      messages.some(
        (message) =>
          message.includes('Response Body:') &&
          message.includes('firstENDignored'),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (message) =>
          message.includes('<- Status 200 OK') &&
          message.includes('(application/json)'),
      ),
    ).toBe(true);
    expect(messages.some((message) => message.includes('Request failed'))).toBe(
      false,
    );
  });

  it('redacts JSON request secrets when Content-Type is overridden', async () => {
    vscodeMockState.verbose = true;
    const server = await startStubServer((_request, response) => {
      respondJson(response, { choices: [{ text: 'result' }] });
    });
    const model = createModel({
      extraBody: { client_secret: 'body-string-secret' },
    });
    const provider = createProvider(
      'openai-chat-completion',
      model,
      server.baseUrl,
      { extraHeaders: { 'Content-Type': 'text/plain' } },
    );
    const operation = createOpenAICompletionsApiProvider(
      nativeContext(provider, model),
    ).operations.fim;
    if (operation === undefined) throw new Error('Missing OpenAI FIM operation.');

    await operation.execute(fimRequest, cancellationToken());

    expect(server.requests[0]?.body.client_secret).toBe('body-string-secret');
    const messages = vscodeMockState.logs.map((entry) => entry.message);
    expect(messages.join('\n')).toContain('"client_secret": "[REDACTED]"');
    expect(messages.join('\n')).not.toContain('body-string-secret');
  });

  it('uses Ollama Generate and postprocesses with the full effective stops', async () => {
    const server = await startStubServer((_request, response) => {
      respondJson(response, {
        response: '\n  valueENDignored',
        done_reason: 'stop',
      });
    });
    const model = createModel();
    const provider = createProvider('ollama', model, `${server.baseUrl}/api`);
    const operation = createOllamaGenerateApiProvider(
      nativeContext(provider, model),
    ).operations.fim;
    if (operation === undefined) throw new Error('Missing Ollama FIM operation.');

    await expect(
      operation.execute(fimRequest, cancellationToken()),
    ).resolves.toMatchObject({
      mode: 'buffered',
      choices: [{ text: '\n  value', finishReason: 'stop' }],
    });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0].path).toBe('/api/generate');
    expect(server.requests[0].body).toMatchObject({
      prompt: 'const value = ',
      suffix: ';\n',
      raw: false,
      options: { stop: ['END', ...FIM_PROTOCOL_STOPS] },
      stream: false,
    });
    expect(vscodeMockState.logs).toEqual([]);
  });

  it('logs the full final HTTP error body before preserving the stable error code', async () => {
    vscodeMockState.verbose = true;
    const errorTail = 'full-response-tail';
    const errorBody = `api_key=plain-error-secret\n${'x'.repeat(
      2_100,
    )}${errorTail}`;
    const server = await startStubServer((_request, response) => {
      response.statusCode = 400;
      response.setHeader('Content-Type', 'text/plain');
      response.end(errorBody);
    });
    const model = createModel();
    const provider = createProvider(
      'openai-chat-completion',
      model,
      server.baseUrl,
    );
    const operation = createOpenAICompletionsApiProvider(
      nativeContext(provider, model),
    ).operations.fim;
    if (operation === undefined) throw new Error('Missing OpenAI FIM operation.');

    await expect(
      operation.execute(fimRequest, cancellationToken()),
    ).rejects.toMatchObject({ code: 'completion-http-error' });

    const messages = vscodeMockState.logs.map((entry) => entry.message);
    expect(
      messages.some(
        (message) =>
          message.includes('Response Body:') && message.includes(errorTail),
      ),
    ).toBe(true);
    expect(
      messages.filter((message) => message.includes('Request failed')),
    ).toHaveLength(1);
    expect(messages.join('\n')).not.toContain('plain-error-secret');
    expect(messages.some((message) => message.includes('Request completed'))).toBe(
      false,
    );
  });

  it('redacts credentials from both an HTTP error body and its terminal error', async () => {
    vscodeMockState.verbose = true;
    const server = await startStubServer((_request, response) => {
      respondJson(
        response,
        { error: 'denied', client_secret: 'response-body-secret' },
        400,
      );
    });
    const model = createModel();
    const provider = createProvider(
      'openai-chat-completion',
      model,
      server.baseUrl,
    );
    const operation = createOpenAICompletionsApiProvider(
      nativeContext(provider, model),
    ).operations.fim;
    if (operation === undefined) throw new Error('Missing OpenAI FIM operation.');

    await expect(
      operation.execute(fimRequest, cancellationToken()),
    ).rejects.toMatchObject({ code: 'completion-http-error' });

    const output = vscodeMockState.logs
      .map((entry) => entry.message)
      .join('\n');
    expect(output).toContain('"client_secret": "[REDACTED]"');
    expect(output).not.toContain('response-body-secret');
  });

  it('logs an invalid JSON response before reporting the parse failure', async () => {
    vscodeMockState.verbose = true;
    const invalidBody = '{"partial": true\ninvalid-json-tail';
    const server = await startStubServer((_request, response) => {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/json');
      response.end(invalidBody);
    });
    const model = createModel();
    const provider = createProvider('ollama', model, server.baseUrl);
    const operation = createOllamaGenerateApiProvider(
      nativeContext(provider, model),
    ).operations.fim;
    if (operation === undefined) throw new Error('Missing Ollama FIM operation.');

    await expect(
      operation.execute(fimRequest, cancellationToken()),
    ).rejects.toMatchObject({ code: 'completion-invalid-response' });

    const messages = vscodeMockState.logs.map((entry) => entry.message);
    expect(
      messages.some(
        (message) =>
          message.includes('Response Body:') && message.includes(invalidBody),
      ),
    ).toBe(true);
    expect(
      messages.filter((message) => message.includes('Request failed')),
    ).toHaveLength(1);
  });

  it('logs one failed terminal when the native request times out', async () => {
    vscodeMockState.verbose = true;
    const server = await startStubServer((_request, response) => {
      setTimeout(() => {
        respondJson(response, { choices: [{ text: 'too late' }] });
      }, 150);
    });
    const model = createModel();
    const provider = createProvider(
      'openai-chat-completion',
      model,
      server.baseUrl,
      { timeout: { connection: 20, response: 1_000 } },
    );
    const operation = createOpenAICompletionsApiProvider(
      nativeContext(provider, model),
    ).operations.fim;
    if (operation === undefined) throw new Error('Missing OpenAI FIM operation.');

    await expect(
      operation.execute(fimRequest, cancellationToken()),
    ).rejects.toBeDefined();

    const messages = vscodeMockState.logs.map((entry) => entry.message);
    expect(server.requests).toHaveLength(1);
    expect(messages.join('\n')).toMatch(/Timeout|timeout/);
    expect(
      messages.filter((message) => message.includes('Request failed')),
    ).toHaveLength(1);
    expect(messages.some((message) => message.includes('Request completed'))).toBe(
      false,
    );
  });

  it('logs a pre-cancelled native operation exactly once as cancelled', async () => {
    vscodeMockState.verbose = true;
    const server = await startStubServer((_request, response) => {
      respondJson(response, { choices: [{ text: 'unexpected' }] });
    });
    const model = createModel();
    const provider = createProvider(
      'openai-chat-completion',
      model,
      server.baseUrl,
    );
    const operation = createOpenAICompletionsApiProvider(
      nativeContext(provider, model),
    ).operations.fim;
    if (operation === undefined) throw new Error('Missing OpenAI FIM operation.');

    await expect(
      operation.execute(fimRequest, cancellationToken(true)),
    ).rejects.toBeDefined();

    const messages = vscodeMockState.logs.map((entry) => entry.message);
    expect(
      messages.filter((message) => message.includes('Request cancelled')),
    ).toHaveLength(1);
    expect(messages.some((message) => message.includes('Request failed'))).toBe(
      false,
    );
    expect(messages.some((message) => message.includes('Request completed'))).toBe(
      false,
    );
  });

  it('uses a cancelled terminal when cancellation wins as an operation resolves', async () => {
    vscodeMockState.verbose = true;
    const model = createModel();
    const provider = createProvider('ollama', model);
    let cancelled = false;
    const token: vscode.CancellationToken = {
      get isCancellationRequested() {
        return cancelled;
      },
      onCancellationRequested: (_listener, _thisArgs, disposables) => {
        const disposable = { dispose: () => undefined };
        disposables?.push(disposable);
        return disposable;
      },
    };

    await expect(
      runNativeCompletionOperation(
        nativeContext(provider, model),
        'fim',
        token,
        async () => {
          cancelled = true;
          return 'result';
        },
      ),
    ).resolves.toBe('result');

    const messages = vscodeMockState.logs.map((entry) => entry.message);
    expect(
      messages.filter((message) => message.includes('Request cancelled')),
    ).toHaveLength(1);
    expect(messages.some((message) => message.includes('Request failed'))).toBe(
      false,
    );
    expect(messages.some((message) => message.includes('Request completed'))).toBe(
      false,
    );
  });
});

interface CompatibleCall {
  messages: Array<
    vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2
  >;
  options: vscode.LanguageModelChatRequestOptions | undefined;
  token: vscode.CancellationToken | undefined;
}

function recordingChatModel(
  chunks: readonly string[],
  calls: CompatibleCall[],
): CompatibleChatModel {
  return {
    async sendRequest(messages, options, token) {
      calls.push({ messages, options, token });
      const text = stream(...chunks);
      return { text, stream: text };
    },
  };
}

describe('Compatible Completion API provider', () => {
  it('uses real System/User roles, exact prompts, and no generation model options', async () => {
    const calls: CompatibleCall[] = [];
    const token = cancellationToken();
    const provider = createCompatibleApiProvider(
      recordingChatModel(
        ['```typescript\n', 'resultENDignored\n', '```'],
        calls,
      ),
      { model: 'test/fim' },
    );
    const operation = provider.operations.fim;
    if (operation === undefined) throw new Error('Missing compatible FIM operation.');

    await expect(operation.execute(fimRequest, token)).resolves.toEqual({
      mode: 'buffered',
      choices: [{ text: 'result' }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].token).toBe(token);
    expect(calls[0].messages.map((message) => message.role)).toEqual([3, 1]);
    expect(calls[0].messages[0].content).toContain(
      'deterministic inline fill-in-the-middle code completion engine',
    );
    expect(calls[0].messages[1].content).toBe(
      '<|fim_prefix|>const value = <|fim_suffix|>;\n<|fim_middle|>',
    );
    expect(calls[0].options).toEqual({
      justification: 'Provide inline code completion',
    });
  });

  it('does not send generation model options for CodeGemma', async () => {
    const calls: CompatibleCall[] = [];
    const provider = createCompatibleApiProvider(
      recordingChatModel(['completion'], calls),
      { model: 'test/codegemma' },
    );
    const operation = provider.operations.codegemma;
    if (operation === undefined) {
      throw new Error('Missing compatible CodeGemma operation.');
    }

    await operation.execute(codeGemmaRequest, cancellationToken());

    expect(calls[0].options).toEqual({
      justification: 'Provide inline code completion',
    });
  });

  it('passes NES options through the public LanguageModelChat contract', async () => {
    const calls: CompatibleCall[] = [];
    const responseStream = stream('first', 'second');
    const model: CompatibleChatModel = {
      async sendRequest(messages, options, token) {
        calls.push({ messages, options, token });
        return { text: responseStream, stream: responseStream };
      },
    };
    const provider = createCompatibleApiProvider(model, { model: 'test/nes' });
    const operation = provider.operations['copilot-replica-nes'];
    if (operation === undefined) {
      throw new Error('Missing compatible NES operation.');
    }

    const response = await operation.execute(nesRequest, cancellationToken());
    expect(response.mode).toBe('streaming');
    expect(await collectText(response.text)).toBe('firstsecond');
    expect(calls[0].messages.map((message) => message.role)).toEqual([3, 1]);
    expect(calls[0].messages.map((message) => message.content)).toEqual([
      'system bytes',
      'user bytes',
    ]);
    expect(calls[0].options).toEqual({
      justification: 'Predict the next code edit',
      modelOptions: {
        max_tokens: 40,
        prediction: { type: 'content', content: 'predicted bytes' },
      },
    });
  });
});
