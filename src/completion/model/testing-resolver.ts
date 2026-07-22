import type * as vscode from 'vscode';
import type {
  CompletionModel,
  CompletionModelReference,
  CompletionModelResolver,
} from '../types';
import type {
  AlgorithmRequest,
  CopilotReplicaAlgorithmCursorPredictionRequest,
  CopilotReplicaAlgorithmFimRequest,
  CopilotReplicaAlgorithmNesRequest,
  InceptionAlgorithmRequest,
  MistralAlgorithmRequest,
  SimpleAlgorithmRequest,
  ZedAlgorithmRequest,
} from './requests';
import type {
  AlgorithmResponse,
  CompletionEditMetadata,
  CompletionTextEdit,
  CopilotReplicaAlgorithmCursorPredictionResponse,
  CopilotReplicaAlgorithmFimResponse,
  CopilotReplicaAlgorithmNesResponse,
  InceptionAlgorithmResponse,
  MistralAlgorithmResponse,
  SimpleAlgorithmResponse,
  ZedAlgorithmResponse,
} from './responses';

type FingerprintedModelResolver = CompletionModelResolver & {
  getConfigurationFingerprint(reference: CompletionModelReference): string;
};

const TEST_COMPLETION_VENDOR = 'test';

interface TestingCompletionResponse {
  readonly text: string;
  readonly edit?: CompletionEditMetadata;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined | null {
  const candidate = value[key];
  return candidate === undefined
    ? undefined
    : typeof candidate === 'string'
      ? candidate
      : null;
}

function optionalInteger(
  value: Record<string, unknown>,
  key: string,
): number | undefined | null {
  const candidate = value[key];
  return candidate === undefined
    ? undefined
    : typeof candidate === 'number' && Number.isSafeInteger(candidate)
      ? candidate
      : null;
}

function optionalTextEdits(
  value: Record<string, unknown>,
  key: string,
): readonly CompletionTextEdit[] | undefined | null {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (!Array.isArray(candidate)) return null;

  const edits: CompletionTextEdit[] = [];
  for (const item of candidate) {
    if (!isRecord(item)) return null;
    const startOffset = optionalInteger(item, 'startOffset');
    const endOffset = optionalInteger(item, 'endOffset');
    if (
      startOffset === undefined ||
      startOffset === null ||
      endOffset === undefined ||
      endOffset === null ||
      startOffset < 0 ||
      endOffset < startOffset ||
      typeof item.text !== 'string'
    ) {
      return null;
    }
    edits.push({ startOffset, endOffset, text: item.text });
  }
  return edits;
}

function normalizeEditMetadata(
  value: unknown,
): CompletionEditMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const requestId = optionalString(value, 'requestId');
  const modelVersion = optionalString(value, 'modelVersion');
  const targetUri = optionalString(value, 'targetUri');
  const requestSnapshot = optionalString(value, 'requestSnapshot');
  const startOffset = optionalInteger(value, 'startOffset');
  const endOffset = optionalInteger(value, 'endOffset');
  const jumpOffset = optionalInteger(value, 'jumpOffset');
  const edits = optionalTextEdits(value, 'edits');
  if (
    requestId === null ||
    modelVersion === null ||
    targetUri === null ||
    requestSnapshot === null ||
    startOffset === null ||
    endOffset === null ||
    jumpOffset === null ||
    edits === null
  ) {
    return undefined;
  }
  return {
    ...(requestId === undefined ? {} : { requestId }),
    ...(modelVersion === undefined ? {} : { modelVersion }),
    ...(targetUri === undefined ? {} : { targetUri }),
    ...(requestSnapshot === undefined ? {} : { requestSnapshot }),
    ...(startOffset === undefined ? {} : { startOffset }),
    ...(endOffset === undefined ? {} : { endOffset }),
    ...(jumpOffset === undefined ? {} : { jumpOffset }),
    ...(edits === undefined ? {} : { edits }),
  };
}

function normalizeTestResponse(
  value: unknown,
): TestingCompletionResponse | undefined {
  if (typeof value === 'string') return { text: value };
  if (!isRecord(value) || typeof value.text !== 'string') return undefined;
  if (value.edit === undefined) return { text: value.text };
  const edit = normalizeEditMetadata(value.edit);
  return edit ? { text: value.text, edit } : undefined;
}

function cloneRequest(request: AlgorithmRequest): AlgorithmRequest {
  switch (request.kind) {
    case 'simple':
      return { ...request };
    case 'copilot-replica/fim':
      return {
        ...request,
        contexts: request.contexts.map((context) => ({
          ...context,
          ...(context.range === undefined
            ? {}
            : { range: { ...context.range } }),
        })),
        options: {
          ...request.options,
          ...(request.options.stop === undefined
            ? {}
            : { stop: [...request.options.stop] }),
        },
        ...(request.metadata === undefined
          ? {}
          : { metadata: { ...request.metadata } }),
      };
    case 'copilot-replica/nes':
      return {
        ...request,
        messages: request.messages.map((message) => ({ ...message })),
        ...(request.prediction === undefined
          ? {}
          : { prediction: { ...request.prediction } }),
        responseFormat: { ...request.responseFormat },
      };
    case 'copilot-replica/cursor-prediction':
      return {
        ...request,
        messages: request.messages.map((message) => ({ ...message })),
        responseFormat: { ...request.responseFormat },
      };
    case 'zed':
      return {
        ...request,
        document: { ...request.document },
        editHistory: request.editHistory.map((entry) => ({ ...entry })),
        contexts: request.contexts.map((context) => ({
          ...context,
          ...(context.range === undefined
            ? {}
            : { range: { ...context.range } }),
        })),
        diagnostics: [...request.diagnostics],
      };
    case 'inception':
      return {
        ...request,
        document: { ...request.document },
        editHistory: request.editHistory.map((entry) => ({ ...entry })),
        contexts: request.contexts.map((context) => ({
          ...context,
          ...(context.range === undefined
            ? {}
            : { range: { ...context.range } }),
        })),
      };
    case 'mistral':
      return { ...request };
  }
}

async function* singleChunk(text: string): AsyncIterable<string> {
  yield text;
}

class TestingCompletionModel implements CompletionModel {
  constructor(
    private readonly response: TestingCompletionResponse,
    private readonly recordRequest: (request: AlgorithmRequest) => void,
  ) {}

  getCapabilities() {
    return Promise.resolve({ supportsNextCursorLinePrediction: true });
  }

  complete(
    request: SimpleAlgorithmRequest,
    token: vscode.CancellationToken,
  ): Promise<SimpleAlgorithmResponse>;
  complete(
    request: CopilotReplicaAlgorithmFimRequest,
    token: vscode.CancellationToken,
  ): Promise<CopilotReplicaAlgorithmFimResponse>;
  complete(
    request: CopilotReplicaAlgorithmNesRequest,
    token: vscode.CancellationToken,
  ): Promise<CopilotReplicaAlgorithmNesResponse>;
  complete(
    request: CopilotReplicaAlgorithmCursorPredictionRequest,
    token: vscode.CancellationToken,
  ): Promise<CopilotReplicaAlgorithmCursorPredictionResponse>;
  complete(
    request: ZedAlgorithmRequest,
    token: vscode.CancellationToken,
  ): Promise<ZedAlgorithmResponse>;
  complete(
    request: InceptionAlgorithmRequest,
    token: vscode.CancellationToken,
  ): Promise<InceptionAlgorithmResponse>;
  complete(
    request: MistralAlgorithmRequest,
    token: vscode.CancellationToken,
  ): Promise<MistralAlgorithmResponse>;
  async complete(
    request: AlgorithmRequest,
    _token: vscode.CancellationToken,
  ): Promise<AlgorithmResponse> {
    this.recordRequest(cloneRequest(request));
    switch (request.kind) {
      case 'simple':
        return {
          kind: 'simple',
          text: this.response.text,
          finishReason: 'test',
        };
      case 'copilot-replica/fim':
        return {
          kind: 'copilot-replica/fim',
          text: this.response.text,
          finishReason: 'test',
        };
      case 'copilot-replica/nes':
        return {
          kind: 'copilot-replica/nes',
          text: singleChunk(this.response.text),
        };
      case 'copilot-replica/cursor-prediction':
        return {
          kind: 'copilot-replica/cursor-prediction',
          text: singleChunk(this.response.text),
        };
      case 'zed':
        return {
          kind: 'zed',
          text: this.response.text,
          finishReason: 'test',
          ...(this.response.edit === undefined
            ? {}
            : { edit: { ...this.response.edit } }),
        };
      case 'inception':
        return {
          kind: 'inception',
          text: this.response.text,
          finishReason: 'test',
          ...(this.response.edit === undefined
            ? {}
            : { edit: { ...this.response.edit } }),
        };
      case 'mistral':
        return {
          kind: 'mistral',
          text: this.response.text,
          finishReason: 'test',
          ...(this.response.edit === undefined
            ? {}
            : { edit: { ...this.response.edit } }),
        };
    }
  }
}

/** Development-only model wrapper loaded dynamically by Extension Host tests. */
export class TestingCompletionModelResolver
  implements CompletionModelResolver
{
  private response: TestingCompletionResponse | undefined;
  private readonly requests: AlgorithmRequest[] = [];

  constructor(private readonly delegate: FingerprintedModelResolver) {}

  setTestResponse(value: unknown): boolean {
    if (value === undefined) {
      this.response = undefined;
      this.requests.length = 0;
      return true;
    }
    const response = normalizeTestResponse(value);
    if (!response) return false;
    this.response = response;
    this.requests.length = 0;
    return true;
  }

  getTestRequests(): readonly AlgorithmRequest[] {
    return this.requests.map(cloneRequest);
  }

  getConfigurationFingerprint(reference: CompletionModelReference): string {
    return this.delegate.getConfigurationFingerprint(reference);
  }

  evaluateModelForRequest(
    reference: CompletionModelReference,
    sourceKind: Parameters<
      NonNullable<CompletionModelResolver['evaluateModelForRequest']>
    >[1],
  ) {
    if (
      this.response !== undefined &&
      reference.vendor === TEST_COMPLETION_VENDOR
    ) {
      return Promise.resolve({ eligible: true });
    }
    return (
      this.delegate.evaluateModelForRequest?.(reference, sourceKind) ??
      Promise.resolve({ eligible: true })
    );
  }

  async resolveCompletionModel(
    reference: CompletionModelReference,
    token: vscode.CancellationToken,
  ): Promise<CompletionModel> {
    if (
      this.response === undefined ||
      reference.vendor !== TEST_COMPLETION_VENDOR
    ) {
      return this.delegate.resolveCompletionModel(reference, token);
    }
    return new TestingCompletionModel(this.response, (request) => {
      this.requests.push(cloneRequest(request));
    });
  }
}
