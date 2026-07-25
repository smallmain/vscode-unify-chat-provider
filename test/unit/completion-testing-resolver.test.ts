import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { TestingCompletionModelResolver } from '../../src/completion/model/testing-resolver';
import type {
  AlgorithmRequest,
  CopilotReplicaAlgorithmCursorPredictionRequest,
  CopilotReplicaAlgorithmFimRequest,
  CopilotReplicaAlgorithmNesRequest,
  InceptionAlgorithmRequest,
  MistralAlgorithmRequest,
  SimpleAlgorithmRequest,
  ZedAlgorithmRequest,
} from '../../src/completion/model/requests';
import type {
  AlgorithmResponse,
  CopilotReplicaAlgorithmCursorPredictionResponse,
  CopilotReplicaAlgorithmFimResponse,
  CopilotReplicaAlgorithmNesResponse,
  InceptionAlgorithmResponse,
  MistralAlgorithmResponse,
  SimpleAlgorithmResponse,
  ZedAlgorithmResponse,
} from '../../src/completion/model/responses';
import type {
  CompletionModel,
  CompletionModelReference,
  CompletionModelResolver,
} from '../../src/completion/types';

const token = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose() {} }),
} satisfies vscode.CancellationToken;

class DelegateModel implements CompletionModel {
  getCapabilities() {
    return Promise.resolve({ supportsNextCursorLinePrediction: false });
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
  complete(
    request: AlgorithmRequest,
    _token: vscode.CancellationToken,
  ): Promise<AlgorithmResponse> {
    if (request.kind === 'simple') {
      return Promise.resolve({ kind: 'simple', text: 'delegate' });
    }
    throw new Error(`Unexpected delegated request: ${request.kind}`);
  }
}

function createDelegate() {
  const model = new DelegateModel();
  const resolveCompletionModel = vi.fn(
    async (_reference: CompletionModelReference) => model,
  );
  const evaluateModelForRequest = vi.fn(async () => ({
    eligible: false,
    code: 'completion-model-not-found' as const,
  }));
  const delegate: CompletionModelResolver & {
    getConfigurationFingerprint(reference: CompletionModelReference): string;
  } = {
    getConfigurationFingerprint: (reference) =>
      `${reference.vendor}/${reference.id}`,
    resolveCompletionModel,
    evaluateModelForRequest,
  };
  return {
    delegate,
    model,
    resolveCompletionModel,
    evaluateModelForRequest,
  };
}

describe('TestingCompletionModelResolver', () => {
  it('intercepts only the dedicated test vendor', async () => {
    const stubs = createDelegate();
    const resolver = new TestingCompletionModelResolver(stubs.delegate);
    resolver.setTestResponse('controlled');

    const testReference = { vendor: 'test', id: 'model' };
    const testModel = await resolver.resolveCompletionModel(
      testReference,
      token,
    );
    await expect(
      testModel.complete(
        { kind: 'simple', prefix: 'pre', suffix: 'post' },
        token,
      ),
    ).resolves.toMatchObject({ kind: 'simple', text: 'controlled' });
    expect(resolver.getTestRequests()).toEqual([
      { kind: 'simple', prefix: 'pre', suffix: 'post' },
    ]);
    expect(stubs.resolveCompletionModel).not.toHaveBeenCalled();
    await expect(
      resolver.evaluateModelForRequest(testReference, 'simple'),
    ).resolves.toEqual({ eligible: true });
    expect(stubs.evaluateModelForRequest).not.toHaveBeenCalled();

    const externalReference = { vendor: 'external', id: 'model' };
    await expect(
      resolver.resolveCompletionModel(externalReference, token),
    ).resolves.toBe(stubs.model);
    await expect(
      resolver.evaluateModelForRequest(externalReference, 'simple'),
    ).resolves.toEqual({
      eligible: false,
      code: 'completion-model-not-found',
    });
    expect(stubs.resolveCompletionModel).toHaveBeenCalledWith(
      externalReference,
      token,
    );
    expect(stubs.evaluateModelForRequest).toHaveBeenCalledWith(
      externalReference,
      'simple',
    );
  });

  it('returns structured edit metadata only for edit algorithms', async () => {
    const stubs = createDelegate();
    const resolver = new TestingCompletionModelResolver(stubs.delegate);
    expect(
      resolver.setTestResponse({
        text: 'predicted snapshot',
        edit: {
          requestId: 'request-id',
          targetUri: 'file:///workspace/target.ts',
          requestSnapshot: 'old snapshot',
          jumpOffset: 4,
          edits: [{ startOffset: 4, endOffset: 7, text: 'new' }],
        },
      }),
    ).toBe(true);
    const model = await resolver.resolveCompletionModel(
      { vendor: 'test', id: 'model' },
      token,
    );
    await expect(
      model.complete(
        {
          kind: 'zed',
          document: {
            uri: 'file:///workspace/source.ts',
            languageId: 'typescript',
            version: 1,
            text: 'source',
            cursorOffset: 6,
          },
          trigger: 'explicit',
          editHistory: [],
          contexts: [],
          diagnostics: [],
          maxTokens: 64,
        },
        token,
      ),
    ).resolves.toMatchObject({
      kind: 'zed',
      text: 'predicted snapshot',
      edit: {
        requestId: 'request-id',
        targetUri: 'file:///workspace/target.ts',
        requestSnapshot: 'old snapshot',
        jumpOffset: 4,
        edits: [{ startOffset: 4, endOffset: 7, text: 'new' }],
      },
    });
    expect(resolver.setTestResponse({ text: 'bad', edit: { jumpOffset: 1.5 } })).toBe(
      false,
    );
    expect(
      resolver.setTestResponse({
        text: 'bad',
        edit: { edits: [{ startOffset: 3, endOffset: 2, text: 'new' }] },
      }),
    ).toBe(false);
  });
});
