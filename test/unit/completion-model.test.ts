import type * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig, ProviderConfig } from '../../src/types';
import type {
  CompletionApiProvider,
  CompletionApiCapability,
} from '../../src/completion/api/provider';
import { defineCompletionApiProvider } from '../../src/completion/api/provider';
import { ConfiguredCompletionModel } from '../../src/completion/model/completion-model';
import type {
  CompletionConfigNormalizationResult,
  ResolvedCompletionConfig,
} from '../../src/completion/model/configuration';
import type { CompletionModelCapabilities } from '../../src/completion/types';
import type {
  CompletionRequest,
  CompletionTemplates,
  CopilotReplicaAlgorithmCursorPredictionRequest,
  CopilotReplicaAlgorithmFimRequest,
  CopilotReplicaAlgorithmNesRequest,
  SimpleAlgorithmRequest,
} from '../../src/completion/model/requests';
import { createVsCodeModelId } from '../../src/model-id-utils';
import { computeCompletionRequestTargetSignature } from '../../src/completion/provider-target';

interface MockChatModel {
  readonly vendor: string;
  readonly id: string;
  readonly usesResponsesApi?: boolean;
  readonly supportsNextCursorLinePrediction?: boolean;
  sendRequest(
    messages: readonly { readonly role: number; readonly content: string }[],
    options?: {
      readonly justification?: string;
      readonly modelOptions?: Readonly<Record<string, unknown>>;
    },
    token?: vscode.CancellationToken,
  ): Promise<{
    readonly text: AsyncIterable<string>;
    readonly stream: AsyncIterable<string>;
  }>;
}

interface MockChatCall {
  readonly messages: readonly {
    readonly role: number;
    readonly content: string;
  }[];
  readonly options:
    | {
        readonly justification?: string;
        readonly modelOptions?: Readonly<Record<string, unknown>>;
      }
    | undefined;
  readonly token: vscode.CancellationToken | undefined;
}

const vscodeMock = vi.hoisted(() => ({
  models: [] as MockChatModel[],
  selectors: [] as Array<{ vendor?: string; id?: string }>,
  verbose: false,
  completionLogs: [] as string[],
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
    lm: {
      selectChatModels: vi.fn(
        async (selector: { vendor?: string; id?: string }) => {
          vscodeMock.selectors.push(selector);
          return vscodeMock.models;
        },
      ),
    },
    l10n: { t: (message: string) => message },
    extensions: { getExtension: () => undefined },
    ThemeIcon: class ThemeIcon {
      constructor(readonly id: string) {}
    },
    workspace: {
      getConfiguration: () => ({
        get: (key: string, fallback: unknown) =>
          key === 'verbose' ? vscodeMock.verbose : fallback,
      }),
    },
    window: {
      createOutputChannel: () => ({
        info: (message: string) => vscodeMock.completionLogs.push(message),
        warn: (message: string) => vscodeMock.completionLogs.push(message),
        error: (message: string) => vscodeMock.completionLogs.push(message),
      }),
    },
  };
});

import {
  ConfiguredCompletionModelResolver,
  INTERNAL_COMPLETION_VENDOR,
} from '../../src/completion/model/resolver';

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

async function collectText(
  chunks: AsyncIterable<string>,
): Promise<readonly string[]> {
  const result: string[] = [];
  for await (const chunk of chunks) {
    result.push(chunk);
  }
  return result;
}

interface ProviderCalls {
  readonly requests: CompletionRequest[];
  readonly transports: Array<'native' | 'compatible'>;
}

interface RecordingProviderOptions {
  readonly fim?: boolean;
  readonly codegemma?: boolean;
  readonly nes?: boolean;
  readonly singleResultOnly?: boolean;
  readonly failFim?: boolean;
}

function recordingProvider(
  transport: 'native' | 'compatible',
  calls: ProviderCalls,
  options: RecordingProviderOptions,
): CompletionApiProvider {
  const multiCandidateSupport: CompletionApiCapability['multiCandidateSupport'] =
    options.singleResultOnly ? 'single-result-only' : 'single-request';
  return defineCompletionApiProvider({
    transport,
    capabilities: {
      ...(options.fim
        ? {
            fim: { responseMode: 'buffered' as const, multiCandidateSupport },
          }
        : {}),
      ...(options.codegemma
        ? {
            codegemma: {
              responseMode: 'buffered' as const,
              multiCandidateSupport,
            },
          }
        : {}),
      ...(options.nes
        ? {
            'copilot-replica-nes': {
              responseMode: 'streaming' as const,
              multiCandidateSupport: 'single-result-only' as const,
            },
          }
        : {}),
    },
    operations: {
      ...(options.fim
        ? {
            fim: {
              async execute(request) {
                calls.requests.push(request);
                calls.transports.push(transport);
                if (options.failFim) {
                  throw new Error('native failed');
                }
                return {
                  mode: 'buffered',
                  choices: [{ text: `${transport}:fim` }],
                };
              },
            },
          }
        : {}),
      ...(options.codegemma
        ? {
            codegemma: {
              async execute(request) {
                calls.requests.push(request);
                calls.transports.push(transport);
                return {
                  mode: 'buffered',
                  choices: [{ text: `${transport}:codegemma` }],
                };
              },
            },
          }
        : {}),
      ...(options.nes
        ? {
            'copilot-replica-nes': {
              async execute(request) {
                calls.requests.push(request);
                calls.transports.push(transport);
                return { mode: 'streaming', text: textStream(transport) };
              },
            },
          }
        : {}),
      },
  });
}

function configuredModel(input: {
  readonly transport: ResolvedCompletionConfig['transport'];
  readonly templates?: CompletionTemplates;
  readonly native?: CompletionApiProvider;
  readonly compatible: CompletionApiProvider;
  readonly capabilities?: CompletionModelCapabilities;
}) {
  const resolveCompatible = vi.fn(async () => input.compatible);
  const resolveCapabilities = vi.fn(async () =>
    input.capabilities ?? { supportsNextCursorLinePrediction: true },
  );
  const model = new ConfiguredCompletionModel({
    completion: {
      transport: input.transport,
      templates: input.templates ?? 'all',
    },
    ...(input.native === undefined ? {} : { native: input.native }),
    resolveCompatible,
    resolveCapabilities,
  });
  return { model, resolveCompatible, resolveCapabilities };
}

const simpleRequest: SimpleAlgorithmRequest = {
  kind: 'simple',
  prefix: 'before',
  suffix: 'after',
};

const copilotFimRequest: CopilotReplicaAlgorithmFimRequest = {
  kind: 'copilot-replica/fim',
  targetPath: 'src/file.ts',
  prefix: 'before',
  suffix: 'after',
  contexts: [{ path: 'src/context.ts', content: 'context' }],
  options: { candidateCount: 3, maxTokens: 20, stop: ['END'] },
};

const nesRequest: CopilotReplicaAlgorithmNesRequest = {
  kind: 'copilot-replica/nes',
  messages: [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'user' },
  ],
  maxTokens: 80,
  prediction: { type: 'content', content: 'prediction' },
  responseFormat: { kind: 'nes', format: 'unifiedXml' },
};

const cursorRequest: CopilotReplicaAlgorithmCursorPredictionRequest = {
  kind: 'copilot-replica/cursor-prediction',
  messages: [{ role: 'user', content: 'cursor' }],
  maxTokens: 40,
  responseFormat: { kind: 'cursor-prediction' },
};

describe('ConfiguredCompletionModel routing', () => {
  it('uses native for the selected template when auto supports it', async () => {
    const calls: ProviderCalls = { requests: [], transports: [] };
    const { model, resolveCompatible } = configuredModel({
      transport: 'auto',
      native: recordingProvider('native', calls, { fim: true }),
      compatible: recordingProvider('compatible', calls, {
        fim: true,
        codegemma: true,
      }),
    });

    await expect(model.complete(simpleRequest, cancellationToken())).resolves.toMatchObject(
      { text: 'native:fim' },
    );
    expect(calls.transports).toEqual(['native']);
    expect(resolveCompatible).not.toHaveBeenCalled();
  });

  it('keeps template priority and falls back to compatible instead of lower native', async () => {
    const calls: ProviderCalls = { requests: [], transports: [] };
    const { model } = configuredModel({
      transport: 'auto',
      native: recordingProvider('native', calls, { codegemma: true }),
      compatible: recordingProvider('compatible', calls, {
        fim: true,
        codegemma: true,
      }),
    });

    const response = await model.complete(simpleRequest, cancellationToken());
    expect(response.text).toBe('compatible:fim');
    expect(calls.requests.map((request) => request.kind)).toEqual(['fim']);
  });

  it('selects the first configured template implemented by explicit native transport', async () => {
    const calls: ProviderCalls = { requests: [], transports: [] };
    const { model, resolveCompatible } = configuredModel({
      transport: 'native',
      native: recordingProvider('native', calls, { codegemma: true }),
      compatible: recordingProvider('compatible', calls, { fim: true }),
    });

    await expect(
      model.complete(simpleRequest, cancellationToken()),
    ).resolves.toMatchObject({ text: 'native:codegemma' });
    await expect(model.evaluate('simple')).resolves.toEqual({ eligible: true });
    expect(calls.requests.map((request) => request.kind)).toEqual([
      'codegemma',
    ]);
    expect(resolveCompatible).not.toHaveBeenCalled();
  });

  it('selects CodeGemma when the model template set excludes FIM', async () => {
    const calls: ProviderCalls = { requests: [], transports: [] };
    const { model } = configuredModel({
      transport: 'auto',
      templates: ['codegemma'],
      native: recordingProvider('native', calls, { codegemma: true }),
      compatible: recordingProvider('compatible', calls, { codegemma: true }),
    });

    const response = await model.complete(simpleRequest, cancellationToken());
    expect(response.text).toBe('native:codegemma');
    expect(calls.requests[0]).toMatchObject({
      kind: 'codegemma',
      contexts: [],
    });
  });

  it('forces compatible transport even when native supports the template', async () => {
    const calls: ProviderCalls = { requests: [], transports: [] };
    const { model } = configuredModel({
      transport: 'compatible',
      native: recordingProvider('native', calls, { fim: true }),
      compatible: recordingProvider('compatible', calls, { fim: true }),
    });

    const response = await model.complete(simpleRequest, cancellationToken());
    expect(response.text).toBe('compatible:fim');
    expect(calls.transports).toEqual(['compatible']);
  });

  it('does not switch to compatible after a native runtime failure', async () => {
    const calls: ProviderCalls = { requests: [], transports: [] };
    const { model, resolveCompatible } = configuredModel({
      transport: 'auto',
      native: recordingProvider('native', calls, { fim: true, failFim: true }),
      compatible: recordingProvider('compatible', calls, { fim: true }),
    });

    await expect(model.complete(simpleRequest, cancellationToken())).rejects.toThrow(
      'native failed',
    );
    expect(calls.transports).toEqual(['native']);
    expect(resolveCompatible).not.toHaveBeenCalled();
  });

  it('downgrades candidate count only for single-result operations', async () => {
    const compatibleCalls: ProviderCalls = { requests: [], transports: [] };
    const compatible = configuredModel({
      transport: 'compatible',
      compatible: recordingProvider('compatible', compatibleCalls, {
        fim: true,
        singleResultOnly: true,
      }),
    }).model;
    await compatible.complete(copilotFimRequest, cancellationToken());
    expect(compatibleCalls.requests[0]).toMatchObject({
      kind: 'fim',
      options: { candidateCount: 1 },
    });

    const codeGemmaCalls: ProviderCalls = { requests: [], transports: [] };
    const codeGemma = configuredModel({
      transport: 'compatible',
      templates: ['codegemma'],
      compatible: recordingProvider('compatible', codeGemmaCalls, {
        codegemma: true,
        singleResultOnly: true,
      }),
    }).model;
    await codeGemma.complete(copilotFimRequest, cancellationToken());
    expect(codeGemmaCalls.requests[0]).toMatchObject({
      kind: 'codegemma',
      options: { candidateCount: 1 },
    });

    const nativeCalls: ProviderCalls = { requests: [], transports: [] };
    const native = configuredModel({
      transport: 'native',
      native: recordingProvider('native', nativeCalls, { fim: true }),
      compatible: recordingProvider('compatible', nativeCalls, { fim: true }),
    }).model;
    await native.complete(copilotFimRequest, cancellationToken());
    expect(nativeCalls.requests[0]).toMatchObject({
      kind: 'fim',
      options: { candidateCount: 3 },
    });
  });

  it('routes NES through compatible for auto and rejects explicit native', async () => {
    const autoCalls: ProviderCalls = { requests: [], transports: [] };
    const auto = configuredModel({
      transport: 'auto',
      native: recordingProvider('native', autoCalls, { fim: true }),
      compatible: recordingProvider('compatible', autoCalls, { nes: true }),
    }).model;
    const response = await auto.complete(nesRequest, cancellationToken());
    expect(await collectText(response.text)).toEqual(['compatible']);

    const nativeCalls: ProviderCalls = { requests: [], transports: [] };
    const native = configuredModel({
      transport: 'native',
      native: recordingProvider('native', nativeCalls, { fim: true }),
      compatible: recordingProvider('compatible', nativeCalls, { nes: true }),
    }).model;
    await expect(native.complete(nesRequest, cancellationToken())).rejects.toMatchObject(
      { code: 'completion-transport-unsupported' },
    );
  });

  it('routes cursor prediction through compatible for auto and rejects explicit native', async () => {
    const autoCalls: ProviderCalls = { requests: [], transports: [] };
    const auto = configuredModel({
      transport: 'auto',
      native: recordingProvider('native', autoCalls, { fim: true }),
      compatible: recordingProvider('compatible', autoCalls, { nes: true }),
    }).model;
    const response = await auto.complete(cursorRequest, cancellationToken());
    expect(await collectText(response.text)).toEqual(['compatible']);

    const nativeCalls: ProviderCalls = { requests: [], transports: [] };
    const native = configuredModel({
      transport: 'native',
      native: recordingProvider('native', nativeCalls, { fim: true }),
      compatible: recordingProvider('compatible', nativeCalls, { nes: true }),
    });
    await expect(native.model.evaluate(cursorRequest.kind)).resolves.toMatchObject({
      eligible: false,
      code: 'completion-transport-unsupported',
    });
    expect(native.resolveCapabilities).not.toHaveBeenCalled();
  });

  it('hides cursor-incompatible models after validating the selected route', async () => {
    const calls: ProviderCalls = { requests: [], transports: [] };
    const unsupported = configuredModel({
      transport: 'compatible',
      compatible: recordingProvider('compatible', calls, { nes: true }),
      capabilities: { supportsNextCursorLinePrediction: false },
    });
    await expect(
      unsupported.model.evaluate('copilot-replica/cursor-prediction'),
    ).resolves.toEqual({
      eligible: false,
      code: 'completion-cursor-prediction-unsupported',
      message: 'Completion model does not support cursor prediction.',
    });
    expect(unsupported.resolveCapabilities).toHaveBeenCalledOnce();

    const missingOperation = configuredModel({
      transport: 'compatible',
      compatible: recordingProvider('compatible', calls, { fim: true }),
      capabilities: { supportsNextCursorLinePrediction: true },
    });
    await expect(
      missingOperation.model.evaluate('copilot-replica/cursor-prediction'),
    ).resolves.toMatchObject({
      eligible: false,
      code: 'completion-transport-unsupported',
    });
    expect(missingOperation.resolveCapabilities).not.toHaveBeenCalled();
  });

  it('reports empty template sets without resolving compatible transport', async () => {
    const calls: ProviderCalls = { requests: [], transports: [] };
    const { model, resolveCompatible } = configuredModel({
      transport: 'auto',
      templates: [],
      compatible: recordingProvider('compatible', calls, { fim: true }),
    });

    await expect(model.complete(simpleRequest, cancellationToken())).rejects.toMatchObject(
      { code: 'completion-no-template' },
    );
    await expect(model.evaluate('simple')).resolves.toMatchObject({
      eligible: false,
      code: 'completion-no-template',
    });
    expect(resolveCompatible).not.toHaveBeenCalled();
  });
});

function externalChatModel(
  vendor: string,
  id: string,
  text = 'external completion',
): MockChatModel {
  return {
    vendor,
    id,
    async sendRequest() {
      const stream = textStream(text);
      return { text: stream, stream };
    },
  };
}

function recordingChatModel(
  vendor: string,
  id: string,
  calls: MockChatCall[],
): MockChatModel {
  return {
    vendor,
    id,
    async sendRequest(messages, options, token) {
      calls.push({ messages, options, token });
      const stream = textStream('completion');
      return { text: stream, stream };
    },
  };
}

function internalProvider(): ProviderConfig {
  return {
    type: 'openai-chat-completion',
    name: 'internal-provider',
    baseUrl: 'https://example.test/v1',
    models: [{ id: 'code-model' }],
  };
}

function resolverStore(input: {
  readonly provider?: ProviderConfig;
  readonly providerCompletion?: CompletionConfigNormalizationResult;
  readonly modelCompletion?: CompletionConfigNormalizationResult;
}) {
  return {
    getProvider: (name: string) =>
      input.provider?.name === name ? input.provider : undefined,
    getProviderCompletionConfigState: () =>
      input.providerCompletion ?? { status: 'absent' as const },
    getModelCompletionConfigState: () =>
      input.modelCompletion ?? { status: 'absent' as const },
  };
}

describe('ConfiguredCompletionModelResolver', () => {
  beforeEach(() => {
    vscodeMock.models.length = 0;
    vscodeMock.selectors.length = 0;
    vscodeMock.verbose = false;
    vscodeMock.completionLogs.length = 0;
  });

  it('limits credential target signatures to authentication and request URL inputs', () => {
    const bindingId = '00000000-0000-4000-8000-000000000205';
    const provider: ProviderConfig = {
      ...internalProvider(),
      auth: { method: 'openai-codex', bindingId },
      completion: { baseUrl: './completions', templates: ['fim'] },
      extraBody: { original: true },
    };
    const unrelatedUpdate: ProviderConfig = {
      ...provider,
      models: [...provider.models, { id: 'another-model' }],
      retry: {
        maxRetries: 3,
        initialDelayMs: 25,
        maxDelayMs: 100,
        backoffMultiplier: 2,
        jitterFactor: 0,
      },
      extraBody: { arrivedFromSync: true },
      autoFetchOfficialModels: true,
    };
    const options = { modelId: provider.models[0].id };

    expect(
      computeCompletionRequestTargetSignature(unrelatedUpdate, options),
    ).toBe(computeCompletionRequestTargetSignature(provider, options));
    expect(
      computeCompletionRequestTargetSignature(
        {
          ...provider,
          completion: { ...provider.completion, baseUrl: './other-target' },
        },
        options,
      ),
    ).not.toBe(computeCompletionRequestTargetSignature(provider, options));
  });

  it('resolves external models as compatible with all request templates', async () => {
    vscodeMock.models.push(
      externalChatModel('other-vendor', 'external-model'),
      externalChatModel('external-vendor', 'external-model'),
    );
    const resolver = new ConfiguredCompletionModelResolver(
      resolverStore({}),
      { getCredential: async () => undefined },
    );
    const reference = { vendor: 'external-vendor', id: 'external-model' };
    const model = await resolver.resolveCompletionModel(
      reference,
      cancellationToken(),
    );

    await expect(
      resolver.evaluateModelForRequest(reference, 'simple'),
    ).resolves.toEqual({ eligible: true });
    await expect(
      resolver.evaluateModelForRequest(reference, 'copilot-replica/nes'),
    ).resolves.toEqual({ eligible: true });
    await expect(model.complete(simpleRequest, cancellationToken())).resolves.toMatchObject(
      { text: 'external completion' },
    );
    expect(vscodeMock.selectors).toEqual(
      Array.from({ length: 3 }, () => ({
        vendor: 'external-vendor',
        id: 'external-model',
      })),
    );
  });

  it('uses the same public chat contract for internal compatible and external models', async () => {
    vscodeMock.verbose = true;
    const provider = internalProvider();
    const internalReference = {
      vendor: INTERNAL_COMPLETION_VENDOR,
      id: createVsCodeModelId(provider.name, provider.models[0].id),
    };
    const externalReference = {
      vendor: 'external-vendor',
      id: 'external-model',
    };
    const internalCalls: MockChatCall[] = [];
    const externalCalls: MockChatCall[] = [];
    vscodeMock.models.push(
      recordingChatModel(
        internalReference.vendor,
        internalReference.id,
        internalCalls,
      ),
      recordingChatModel(
        externalReference.vendor,
        externalReference.id,
        externalCalls,
      ),
    );
    const resolver = new ConfiguredCompletionModelResolver(
      resolverStore({
        provider,
        providerCompletion: {
          status: 'valid',
          value: { transport: 'compatible', templates: 'all' },
        },
      }),
      { getCredential: async () => undefined },
    );
    const token = cancellationToken();
    const internalModel = await resolver.resolveCompletionModel(
      internalReference,
      token,
    );
    const externalModel = await resolver.resolveCompletionModel(
      externalReference,
      token,
    );

    await internalModel.complete(simpleRequest, token);
    await externalModel.complete(simpleRequest, token);
    await internalModel.complete(nesRequest, token);
    await externalModel.complete(nesRequest, token);

    expect(internalCalls).toEqual(externalCalls);
    expect(internalCalls).toHaveLength(2);
    expect(internalCalls[0]?.options).toEqual({
      justification: 'Provide inline code completion',
    });
    expect(internalCalls[1]?.options).toEqual({
      justification: 'Predict the next code edit',
      modelOptions: {
        max_tokens: 80,
        prediction: { type: 'content', content: 'prediction' },
      },
    });
    const starts = vscodeMock.completionLogs.filter((message) =>
      message.includes('Request started'),
    );
    expect(
      starts.filter((message) =>
        message.includes(
          `Model: ${internalReference.vendor}/${internalReference.id}`,
        ),
      ),
    ).toHaveLength(2);
    expect(
      starts.filter((message) =>
        message.includes(
          `Model: ${externalReference.vendor}/${externalReference.id}`,
        ),
      ),
    ).toHaveLength(2);
  });

  it('rejects missing external models and invalid internal configuration', async () => {
    const resolver = new ConfiguredCompletionModelResolver(
      resolverStore({}),
      { getCredential: async () => undefined },
    );
    await expect(
      resolver.resolveCompletionModel(
        { vendor: 'missing', id: 'model' },
        cancellationToken(),
      ),
    ).rejects.toMatchObject({ code: 'completion-model-not-found' });

    const provider = internalProvider();
    const invalidResolver = new ConfiguredCompletionModelResolver(
      resolverStore({
        provider,
        providerCompletion: {
          status: 'invalid',
          issues: [
            {
              code: 'completion-unknown-field',
              field: 'fimType',
              message: 'Unknown completion configuration field "fimType".',
            },
          ],
        },
      }),
      { getCredential: async () => undefined },
    );
    await expect(
      invalidResolver.resolveCompletionModel(
        {
          vendor: INTERNAL_COMPLETION_VENDOR,
          id: createVsCodeModelId(provider.name, provider.models[0].id),
        },
        cancellationToken(),
      ),
    ).rejects.toMatchObject({ code: 'completion-invalid-config' });
  });

  it('derives the cursor token floor from an internal Responses provider', async () => {
    const provider: ProviderConfig = {
      ...internalProvider(),
      type: 'openai-responses',
    };
    const reference = {
      vendor: INTERNAL_COMPLETION_VENDOR,
      id: createVsCodeModelId(provider.name, provider.models[0].id),
    };
    vscodeMock.models.push(externalChatModel(reference.vendor, reference.id));
    const resolver = new ConfiguredCompletionModelResolver(
      resolverStore({ provider }),
      { getCredential: async () => undefined },
    );

    const model = await resolver.resolveCompletionModel(
      reference,
      cancellationToken(),
    );

    await expect(model.getCapabilities()).resolves.toEqual({
      supportsNextCursorLinePrediction: true,
      minimumCursorPredictionTokens: 2_048,
    });
  });

  it.each(['openai-chat-completion', 'openai-responses'] as const)(
    'treats internal %s as native /completions capable in auto mode',
    async (type) => {
      const provider: ProviderConfig = {
        ...internalProvider(),
        type,
        completion: { templates: ['fim'] },
      };
      const reference = {
        vendor: INTERNAL_COMPLETION_VENDOR,
        id: createVsCodeModelId(provider.name, provider.models[0].id),
      };
      const resolver = new ConfiguredCompletionModelResolver(
        resolverStore({
          provider,
          providerCompletion: {
            status: 'valid',
            value: { templates: ['fim'] },
          },
        }),
        { getCredential: async () => undefined },
      );

      await expect(
        resolver.evaluateModelForRequest(reference, 'simple'),
      ).resolves.toEqual({ eligible: true });
      expect(vscodeMock.selectors).toEqual([]);
    },
  );

  it('rejects a native request when its provider target changes during credential lookup', async () => {
    const bindingId = '00000000-0000-4000-8000-000000000211';
    const originalProvider: ProviderConfig = {
      ...internalProvider(),
      auth: { method: 'openai-codex', bindingId },
      completion: { transport: 'native', templates: ['fim'] },
    };
    const updatedProvider: ProviderConfig = {
      ...originalProvider,
      baseUrl: 'https://updated.example.test/v1',
    };
    let currentProvider = originalProvider;
    const store = {
      ...resolverStore({
        provider: originalProvider,
        providerCompletion: {
          status: 'valid' as const,
          value: { transport: 'native' as const, templates: ['fim'] as const },
        },
      }),
      getProvider: (name: string) =>
        name === currentProvider.name ? currentProvider : undefined,
    };
    const getCredential = vi.fn(async () => {
      currentProvider = updatedProvider;
      return {
        value: 'updated-token',
        tokenType: 'Bearer',
        authContext: {
          method: 'openai-codex' as const,
          bindingId,
          sessionId: '00000000-0000-4000-8000-000000000212',
          revision: 2,
        },
      };
    });
    const resolver = new ConfiguredCompletionModelResolver(store, {
      getCredential,
    });
    const model = await resolver.resolveCompletionModel(
      {
        vendor: INTERNAL_COMPLETION_VENDOR,
        id: createVsCodeModelId(
          originalProvider.name,
          originalProvider.models[0].id,
        ),
      },
      cancellationToken(),
    );

    await expect(
      model.complete(simpleRequest, cancellationToken()),
    ).rejects.toMatchObject({
      code: 'completion-request-failed',
      cause: {
        message:
          'Authentication configuration changed while the completion request was starting. Please retry.',
      },
    });
    expect(getCredential).toHaveBeenCalledTimes(1);
  });

  it('keeps stable API key credential resolution on the existing background path', async () => {
    const provider: ProviderConfig = {
      ...internalProvider(),
      auth: { method: 'api-key', apiKey: '$UCPSECRET:test-api-key$' },
      completion: { transport: 'native', templates: ['fim'] },
    };
    const credentialError = new Error('stable API key credential lookup');
    const getCredential = vi.fn(async () => {
      throw credentialError;
    });
    const resolver = new ConfiguredCompletionModelResolver(
      resolverStore({
        provider,
        providerCompletion: {
          status: 'valid',
          value: { transport: 'native', templates: ['fim'] },
        },
      }),
      { getCredential },
    );
    const model = await resolver.resolveCompletionModel(
      {
        vendor: INTERNAL_COMPLETION_VENDOR,
        id: createVsCodeModelId(provider.name, provider.models[0].id),
      },
      cancellationToken(),
    );

    await expect(
      model.complete(simpleRequest, cancellationToken()),
    ).rejects.toMatchObject({
      code: 'completion-request-failed',
      cause: credentialError,
    });
    expect(getCredential).toHaveBeenCalledOnce();
    expect(getCredential).toHaveBeenCalledWith(provider.name, 'background');
  });

  it('resolves cached official models without persisting them as user models', async () => {
    const provider: ProviderConfig = {
      type: 'zed',
      name: 'zed-provider',
      baseUrl: 'https://zed.dev',
      models: [],
      autoFetchOfficialModels: true,
    };
    let cachedModel: ModelConfig = {
      id: 'zeta-cloud',
      name: 'Zeta Cloud',
      completion: { templates: ['zeta3-internal'] },
    };
    const getProviderModels = vi.fn(() => [cachedModel]);
    const resolver = new ConfiguredCompletionModelResolver(
      resolverStore({ provider }),
      { getCredential: async () => undefined },
      getProviderModels,
    );
    const reference = {
      vendor: INTERNAL_COMPLETION_VENDOR,
      id: createVsCodeModelId(provider.name, cachedModel.id),
    };

    const firstFingerprint = resolver.getConfigurationFingerprint(reference);
    await expect(
      resolver.evaluateModelForRequest(reference, 'zed'),
    ).resolves.toEqual({ eligible: true });
    await expect(
      resolver.resolveCompletionModel(reference, cancellationToken()),
    ).resolves.toBeInstanceOf(ConfiguredCompletionModel);
    expect(provider.models).toEqual([]);
    expect(vscodeMock.selectors).toEqual([]);

    cachedModel = { ...cachedModel, completion: { templates: [] } };
    expect(resolver.getConfigurationFingerprint(reference)).not.toBe(
      firstFingerprint,
    );
    await expect(
      resolver.evaluateModelForRequest(reference, 'zed'),
    ).resolves.toMatchObject({
      eligible: false,
      code: 'completion-no-template',
    });
    expect(getProviderModels).toHaveBeenCalledWith(provider);
  });

  it('fingerprints normalized Provider and Model completion state', () => {
    const provider = internalProvider();
    let modelCompletion: CompletionConfigNormalizationResult = {
      status: 'valid',
      value: { transport: 'auto', templates: ['fim'] },
    };
    const store = {
      ...resolverStore({ provider }),
      getModelCompletionConfigState: () => modelCompletion,
    };
    const resolver = new ConfiguredCompletionModelResolver(store, {
      getCredential: async () => undefined,
    });
    const reference = {
      vendor: INTERNAL_COMPLETION_VENDOR,
      id: createVsCodeModelId(provider.name, provider.models[0].id),
    };

    const first = resolver.getConfigurationFingerprint(reference);
    modelCompletion = {
      status: 'valid',
      value: { transport: 'compatible', templates: ['codegemma'] },
    };
    const second = resolver.getConfigurationFingerprint(reference);

    expect(second).not.toBe(first);
    expect(
      resolver.getConfigurationFingerprint({ vendor: 'external', id: 'model' }),
    ).toContain('external');
  });
});
