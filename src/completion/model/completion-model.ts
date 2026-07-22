import type * as vscode from 'vscode';
import { t } from '../../i18n';
import type {
  CompletionApiCapability,
  CompletionApiOperation,
  CompletionApiProvider,
} from '../api/provider';
import type {
  CompletionModel,
  CompletionModelCapabilities,
  CompletionModelEligibility,
} from '../types';
import type { ResolvedCompletionConfig } from './configuration';
import { CompletionConfigurationError } from './errors';
import {
  REQUEST_TRANSFORMERS,
  type CompletionRequestExecutionContext,
  type ExecutableRequestTransformer,
} from './request-transformer';
import type {
  AlgorithmRequest,
  AlgorithmRequestKind,
  AlgorithmRequestMap,
  CodeGemmaCompletionRequest,
  CompletionRequestKind,
  CompletionRequestMap,
  CopilotReplicaAlgorithmCursorPredictionRequest,
  CopilotReplicaAlgorithmFimRequest,
  CopilotReplicaAlgorithmNesRequest,
  CopilotReplicaNesCompletionRequest,
  FimCompletionRequest,
  InceptionAlgorithmRequest,
  MistralAlgorithmRequest,
  SimpleAlgorithmRequest,
  ZedAlgorithmRequest,
} from './requests';
import type {
  AlgorithmResponse,
  AlgorithmResponseMap,
  CopilotReplicaAlgorithmCursorPredictionResponse,
  CopilotReplicaAlgorithmFimResponse,
  CopilotReplicaAlgorithmNesResponse,
  InceptionAlgorithmResponse,
  MistralAlgorithmResponse,
  SimpleAlgorithmResponse,
  ZedAlgorithmResponse,
} from './responses';

export interface CompletionModelProviders {
  readonly completion: ResolvedCompletionConfig;
  readonly native?: CompletionApiProvider;
  resolveCompatible(): Promise<CompletionApiProvider>;
  resolveCapabilities(): Promise<CompletionModelCapabilities>;
}

function supportsTemplate(
  templates: ResolvedCompletionConfig['templates'],
  kind: CompletionRequestKind,
): boolean {
  return templates === 'all' || templates.includes(kind);
}

function withCandidateCapability<
  Kind extends 'fim' | 'codegemma',
>(
  request: CompletionRequestMap[Kind],
  capability: CompletionApiCapability,
): CompletionRequestMap[Kind] {
  if (
    capability.multiCandidateSupport !== 'single-result-only' ||
    (request.options.candidateCount ?? 1) <= 1
  ) {
    return request;
  }
  return {
    ...request,
    options: { ...request.options, candidateCount: 1 },
  };
}

interface ResolvedCompletionApiOperation<
  Kind extends CompletionRequestKind,
> {
  readonly capability: CompletionApiCapability;
  readonly operation: CompletionApiOperation<Kind>;
}

export class ConfiguredCompletionModel
  implements CompletionModel, CompletionRequestExecutionContext
{
  constructor(private readonly providers: CompletionModelProviders) {}

  getCapabilities(): Promise<CompletionModelCapabilities> {
    return this.providers.resolveCapabilities();
  }

  async evaluate(
    sourceKind: AlgorithmRequestKind,
  ): Promise<CompletionModelEligibility> {
    const targetKind = await this.firstTargetKind(sourceKind);
    if (!targetKind) {
      const configuredTarget = this.firstConfiguredTargetKind(sourceKind);
      return {
        eligible: false,
        code: configuredTarget
          ? 'completion-transport-unsupported'
          : 'completion-no-template',
        message: configuredTarget
          ? t(
              'Completion transport does not support template "{0}".',
              configuredTarget,
            )
          : t(
              'Completion model has no supported template for "{0}".',
              sourceKind,
            ),
      };
    }
    if (sourceKind !== 'copilot-replica/cursor-prediction') {
      return { eligible: true };
    }
    const capabilities = await this.providers.resolveCapabilities();
    return capabilities.supportsNextCursorLinePrediction
      ? { eligible: true }
      : {
          eligible: false,
          code: 'completion-cursor-prediction-unsupported',
          message: t(
            'Completion model does not support cursor prediction.',
          ),
        };
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
    token: vscode.CancellationToken,
  ): Promise<AlgorithmResponse> {
    switch (request.kind) {
      case 'simple':
        return await this.completeSource(
          request,
          REQUEST_TRANSFORMERS.simple,
          token,
        );
      case 'copilot-replica/fim':
        return await this.completeSource(
          request,
          REQUEST_TRANSFORMERS['copilot-replica/fim'],
          token,
        );
      case 'copilot-replica/nes':
        return await this.completeSource(
          request,
          REQUEST_TRANSFORMERS['copilot-replica/nes'],
          token,
        );
      case 'copilot-replica/cursor-prediction':
        return await this.completeSource(
          request,
          REQUEST_TRANSFORMERS['copilot-replica/cursor-prediction'],
          token,
        );
      case 'zed':
        return await this.completeSource(request, REQUEST_TRANSFORMERS.zed, token);
      case 'inception':
        return await this.completeSource(
          request,
          REQUEST_TRANSFORMERS.inception,
          token,
        );
      case 'mistral':
        return await this.completeSource(
          request,
          REQUEST_TRANSFORMERS.mistral,
          token,
        );
    }
  }

  async executeFim(
    request: FimCompletionRequest,
    token: vscode.CancellationToken,
  ) {
    const resolved = await this.resolveOperation('fim');
    return await resolved.operation.execute(
      withCandidateCapability<'fim'>(request, resolved.capability),
      token,
    );
  }

  async executeCodeGemma(
    request: CodeGemmaCompletionRequest,
    token: vscode.CancellationToken,
  ) {
    const resolved = await this.resolveOperation('codegemma');
    return await resolved.operation.execute(
      withCandidateCapability<'codegemma'>(request, resolved.capability),
      token,
    );
  }

  async executeCopilotReplicaNes(
    request: CopilotReplicaNesCompletionRequest,
    token: vscode.CancellationToken,
  ) {
    const resolved = await this.resolveOperation('copilot-replica-nes');
    return await resolved.operation.execute(request, token);
  }

  async executeZeta1(
    request: CompletionRequestMap['zeta1'],
    token: vscode.CancellationToken,
  ) {
    return await (await this.resolveOperation('zeta1')).operation.execute(
      request,
      token,
    );
  }

  async executeZeta2(
    request: CompletionRequestMap['zeta2'],
    token: vscode.CancellationToken,
  ) {
    return await (await this.resolveOperation('zeta2')).operation.execute(
      request,
      token,
    );
  }

  async executeZeta21(
    request: CompletionRequestMap['zeta2.1'],
    token: vscode.CancellationToken,
  ) {
    return await (await this.resolveOperation('zeta2.1')).operation.execute(
      request,
      token,
    );
  }

  async executeZeta3Internal(
    request: CompletionRequestMap['zeta3-internal'],
    token: vscode.CancellationToken,
  ) {
    return await (
      await this.resolveOperation('zeta3-internal')
    ).operation.execute(request, token);
  }

  async executeMercuryEdit(
    request: CompletionRequestMap['mercury-edit-2'],
    token: vscode.CancellationToken,
  ) {
    return await (
      await this.resolveOperation('mercury-edit-2')
    ).operation.execute(request, token);
  }

  async executeCodestral(
    request: CompletionRequestMap['codestral'],
    token: vscode.CancellationToken,
  ) {
    return await (await this.resolveOperation('codestral')).operation.execute(
      request,
      token,
    );
  }

  private async completeSource<SourceKind extends AlgorithmRequestKind>(
    request: AlgorithmRequestMap[SourceKind],
    transformers: readonly ExecutableRequestTransformer<SourceKind>[],
    token: vscode.CancellationToken,
  ): Promise<AlgorithmResponseMap[SourceKind]> {
    let transformer: ExecutableRequestTransformer<SourceKind> | undefined;
    for (const candidate of transformers) {
      if (
        supportsTemplate(
          this.providers.completion.templates,
          candidate.targetKind,
        ) &&
        (await this.isOperationAvailable(candidate.targetKind))
      ) {
        transformer = candidate;
        break;
      }
    }
    if (!transformer) {
      const configuredTarget = transformers.find((candidate) =>
        supportsTemplate(
          this.providers.completion.templates,
          candidate.targetKind,
        ),
      )?.targetKind;
      if (configuredTarget) {
        throw this.unsupportedTransport(configuredTarget);
      }
      throw new CompletionConfigurationError(
        'completion-no-template',
        t(
          'Completion model has no supported template for "{0}".',
          request.kind,
        ),
      );
    }
    return await transformer.run(request, this, token);
  }

  private async resolveOperation(
    kind: 'fim',
  ): Promise<ResolvedCompletionApiOperation<'fim'>>;
  private async resolveOperation(
    kind: 'codegemma',
  ): Promise<ResolvedCompletionApiOperation<'codegemma'>>;
  private async resolveOperation(
    kind: 'copilot-replica-nes',
  ): Promise<ResolvedCompletionApiOperation<'copilot-replica-nes'>>;
  private async resolveOperation(
    kind: 'zeta1',
  ): Promise<ResolvedCompletionApiOperation<'zeta1'>>;
  private async resolveOperation(
    kind: 'zeta2',
  ): Promise<ResolvedCompletionApiOperation<'zeta2'>>;
  private async resolveOperation(
    kind: 'zeta2.1',
  ): Promise<ResolvedCompletionApiOperation<'zeta2.1'>>;
  private async resolveOperation(
    kind: 'zeta3-internal',
  ): Promise<ResolvedCompletionApiOperation<'zeta3-internal'>>;
  private async resolveOperation(
    kind: 'mercury-edit-2',
  ): Promise<ResolvedCompletionApiOperation<'mercury-edit-2'>>;
  private async resolveOperation(
    kind: 'codestral',
  ): Promise<ResolvedCompletionApiOperation<'codestral'>>;
  private async resolveOperation(
    kind: CompletionRequestKind,
  ): Promise<
    | ResolvedCompletionApiOperation<'fim'>
    | ResolvedCompletionApiOperation<'codegemma'>
    | ResolvedCompletionApiOperation<'copilot-replica-nes'>
    | ResolvedCompletionApiOperation<'zeta1'>
    | ResolvedCompletionApiOperation<'zeta2'>
    | ResolvedCompletionApiOperation<'zeta2.1'>
    | ResolvedCompletionApiOperation<'zeta3-internal'>
    | ResolvedCompletionApiOperation<'mercury-edit-2'>
    | ResolvedCompletionApiOperation<'codestral'>
  > {
    switch (kind) {
      case 'fim':
        return await this.resolveFimOperation();
      case 'codegemma':
        return await this.resolveCodeGemmaOperation();
      case 'copilot-replica-nes':
        return await this.resolveNesOperation();
      case 'zeta1':
        return await this.resolveNativeOnlyOperation(
          kind,
          (provider) => this.readZeta1Operation(provider),
        );
      case 'zeta2':
        return await this.resolveNativeOnlyOperation(
          kind,
          (provider) => this.readZeta2Operation(provider),
        );
      case 'zeta2.1':
        return await this.resolveNativeOnlyOperation(
          kind,
          (provider) => this.readZeta21Operation(provider),
        );
      case 'zeta3-internal':
        return await this.resolveNativeOnlyOperation(
          kind,
          (provider) => this.readZeta3Operation(provider),
        );
      case 'mercury-edit-2':
        return await this.resolveNativeOnlyOperation(
          kind,
          (provider) => this.readMercuryOperation(provider),
        );
      case 'codestral':
        return await this.resolveNativeOnlyOperation(
          kind,
          (provider) => this.readCodestralOperation(provider),
        );
    }
  }

  private async resolveFimOperation(): Promise<
    ResolvedCompletionApiOperation<'fim'>
  > {
    const transport = this.providers.completion.transport;
    if (transport !== 'compatible') {
      const resolved = this.providers.native
        ? this.readFimOperation(this.providers.native)
        : undefined;
      if (resolved) {
        return resolved;
      }
      if (transport === 'native') {
        throw this.unsupportedTransport('fim');
      }
    }
    const compatible = await this.providers.resolveCompatible();
    const resolved = this.readFimOperation(compatible);
    if (!resolved) {
      throw this.unsupportedTransport('fim');
    }
    return resolved;
  }

  private async resolveCodeGemmaOperation(): Promise<
    ResolvedCompletionApiOperation<'codegemma'>
  > {
    const transport = this.providers.completion.transport;
    if (transport !== 'compatible') {
      const resolved = this.providers.native
        ? this.readCodeGemmaOperation(this.providers.native)
        : undefined;
      if (resolved) {
        return resolved;
      }
      if (transport === 'native') {
        throw this.unsupportedTransport('codegemma');
      }
    }
    const compatible = await this.providers.resolveCompatible();
    const resolved = this.readCodeGemmaOperation(compatible);
    if (!resolved) {
      throw this.unsupportedTransport('codegemma');
    }
    return resolved;
  }

  private async resolveNesOperation(): Promise<
    ResolvedCompletionApiOperation<'copilot-replica-nes'>
  > {
    if (this.providers.completion.transport === 'native') {
      throw this.unsupportedTransport('copilot-replica-nes');
    }
    const compatible = await this.providers.resolveCompatible();
    const resolved = this.readNesOperation(compatible);
    if (!resolved) {
      throw this.unsupportedTransport('copilot-replica-nes');
    }
    return resolved;
  }

  private async resolveNativeOnlyOperation<Kind extends CompletionRequestKind>(
    kind: Kind,
    read: (
      provider: CompletionApiProvider,
    ) => ResolvedCompletionApiOperation<Kind> | undefined,
  ): Promise<ResolvedCompletionApiOperation<Kind>> {
    if (this.providers.completion.transport === 'compatible') {
      throw this.unsupportedTransport(kind);
    }
    const resolved = this.providers.native
      ? read(this.providers.native)
      : undefined;
    if (!resolved) {
      throw this.unsupportedTransport(kind);
    }
    return resolved;
  }

  private readFimOperation(
    provider: CompletionApiProvider,
  ): ResolvedCompletionApiOperation<'fim'> | undefined {
    const capability = provider.capabilities.fim;
    const operation = provider.operations.fim;
    return capability && operation ? { capability, operation } : undefined;
  }

  private readCodeGemmaOperation(
    provider: CompletionApiProvider,
  ): ResolvedCompletionApiOperation<'codegemma'> | undefined {
    const capability = provider.capabilities.codegemma;
    const operation = provider.operations.codegemma;
    return capability && operation ? { capability, operation } : undefined;
  }

  private readNesOperation(
    provider: CompletionApiProvider,
  ): ResolvedCompletionApiOperation<'copilot-replica-nes'> | undefined {
    const capability = provider.capabilities['copilot-replica-nes'];
    const operation = provider.operations['copilot-replica-nes'];
    return capability && operation ? { capability, operation } : undefined;
  }

  private readZeta1Operation(
    provider: CompletionApiProvider,
  ): ResolvedCompletionApiOperation<'zeta1'> | undefined {
    const capability = provider.capabilities.zeta1;
    const operation = provider.operations.zeta1;
    return capability && operation ? { capability, operation } : undefined;
  }

  private readZeta2Operation(
    provider: CompletionApiProvider,
  ): ResolvedCompletionApiOperation<'zeta2'> | undefined {
    const capability = provider.capabilities.zeta2;
    const operation = provider.operations.zeta2;
    return capability && operation ? { capability, operation } : undefined;
  }

  private readZeta21Operation(
    provider: CompletionApiProvider,
  ): ResolvedCompletionApiOperation<'zeta2.1'> | undefined {
    const capability = provider.capabilities['zeta2.1'];
    const operation = provider.operations['zeta2.1'];
    return capability && operation ? { capability, operation } : undefined;
  }

  private readZeta3Operation(
    provider: CompletionApiProvider,
  ): ResolvedCompletionApiOperation<'zeta3-internal'> | undefined {
    const capability = provider.capabilities['zeta3-internal'];
    const operation = provider.operations['zeta3-internal'];
    return capability && operation ? { capability, operation } : undefined;
  }

  private readMercuryOperation(
    provider: CompletionApiProvider,
  ): ResolvedCompletionApiOperation<'mercury-edit-2'> | undefined {
    const capability = provider.capabilities['mercury-edit-2'];
    const operation = provider.operations['mercury-edit-2'];
    return capability && operation ? { capability, operation } : undefined;
  }

  private readCodestralOperation(
    provider: CompletionApiProvider,
  ): ResolvedCompletionApiOperation<'codestral'> | undefined {
    const capability = provider.capabilities.codestral;
    const operation = provider.operations.codestral;
    return capability && operation ? { capability, operation } : undefined;
  }

  private unsupportedTransport(
    kind: CompletionRequestKind,
  ): CompletionConfigurationError {
    return new CompletionConfigurationError(
      'completion-transport-unsupported',
      t(
        'Completion transport does not support template "{0}".',
        kind,
      ),
    );
  }

  private targetsFor(
    sourceKind: AlgorithmRequestKind,
  ): readonly { readonly targetKind: CompletionRequestKind }[] {
    switch (sourceKind) {
      case 'simple':
        return REQUEST_TRANSFORMERS.simple;
      case 'copilot-replica/fim':
        return REQUEST_TRANSFORMERS['copilot-replica/fim'];
      case 'copilot-replica/nes':
        return REQUEST_TRANSFORMERS['copilot-replica/nes'];
      case 'copilot-replica/cursor-prediction':
        return REQUEST_TRANSFORMERS['copilot-replica/cursor-prediction'];
      case 'zed':
        return REQUEST_TRANSFORMERS.zed;
      case 'inception':
        return REQUEST_TRANSFORMERS.inception;
      case 'mistral':
        return REQUEST_TRANSFORMERS.mistral;
    }
  }

  private firstConfiguredTargetKind(
    sourceKind: AlgorithmRequestKind,
  ): CompletionRequestKind | undefined {
    return this.targetsFor(sourceKind).find((candidate) =>
      supportsTemplate(
        this.providers.completion.templates,
        candidate.targetKind,
      ),
    )?.targetKind;
  }

  private async firstTargetKind(
    sourceKind: AlgorithmRequestKind,
  ): Promise<CompletionRequestKind | undefined> {
    for (const candidate of this.targetsFor(sourceKind)) {
      if (
        supportsTemplate(
          this.providers.completion.templates,
          candidate.targetKind,
        ) &&
        (await this.isOperationAvailable(candidate.targetKind))
      ) {
        return candidate.targetKind;
      }
    }
    return undefined;
  }

  private async isOperationAvailable(
    kind: CompletionRequestKind,
  ): Promise<boolean> {
    const transport = this.providers.completion.transport;
    if (
      transport !== 'compatible' &&
      this.providers.native &&
      this.hasOperation(this.providers.native, kind)
    ) {
      return true;
    }
    if (transport === 'native') {
      return false;
    }
    if (
      kind !== 'fim' &&
      kind !== 'codegemma' &&
      kind !== 'copilot-replica-nes'
    ) {
      return false;
    }
    return this.hasOperation(await this.providers.resolveCompatible(), kind);
  }

  private hasOperation(
    provider: CompletionApiProvider,
    kind: CompletionRequestKind,
  ): boolean {
    switch (kind) {
      case 'fim':
        return provider.capabilities.fim !== undefined && provider.operations.fim !== undefined;
      case 'codegemma':
        return provider.capabilities.codegemma !== undefined && provider.operations.codegemma !== undefined;
      case 'copilot-replica-nes':
        return provider.capabilities['copilot-replica-nes'] !== undefined && provider.operations['copilot-replica-nes'] !== undefined;
      case 'zeta1':
        return provider.capabilities.zeta1 !== undefined && provider.operations.zeta1 !== undefined;
      case 'zeta2':
        return provider.capabilities.zeta2 !== undefined && provider.operations.zeta2 !== undefined;
      case 'zeta2.1':
        return provider.capabilities['zeta2.1'] !== undefined && provider.operations['zeta2.1'] !== undefined;
      case 'zeta3-internal':
        return provider.capabilities['zeta3-internal'] !== undefined && provider.operations['zeta3-internal'] !== undefined;
      case 'mercury-edit-2':
        return provider.capabilities['mercury-edit-2'] !== undefined && provider.operations['mercury-edit-2'] !== undefined;
      case 'codestral':
        return provider.capabilities.codestral !== undefined && provider.operations.codestral !== undefined;
    }
  }
}
