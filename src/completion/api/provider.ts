import type * as vscode from 'vscode';
import type { AuthTokenInfo } from '../../auth/types';
import type { ModelConfig, ProviderConfig } from '../../types';
import type { ResolvedCompletionConfig } from '../model/configuration';
import type {
  CompletionRequestKind,
  CompletionRequestMap,
} from '../model/requests';
import type { CompletionResponseMap } from '../model/responses';
import { COMPLETION_REQUEST_RESPONSE_MODES } from '../model/request-definitions';
import { CompletionInvariantError } from '../model/errors';

export interface CompletionApiCapability {
  readonly responseMode: 'buffered' | 'streaming';
  readonly multiCandidateSupport: 'single-request' | 'single-result-only';
}

export interface CompletionApiOperation<
  Kind extends CompletionRequestKind,
> {
  execute(
    request: CompletionRequestMap[Kind],
    token: vscode.CancellationToken,
  ): Promise<CompletionResponseMap[Kind]>;
}

export interface CompletionApiOperations {
  readonly fim?: CompletionApiOperation<'fim'>;
  readonly codegemma?: CompletionApiOperation<'codegemma'>;
  readonly 'copilot-replica-nes'?: CompletionApiOperation<'copilot-replica-nes'>;
  readonly zeta1?: CompletionApiOperation<'zeta1'>;
  readonly zeta2?: CompletionApiOperation<'zeta2'>;
  readonly 'zeta2.1'?: CompletionApiOperation<'zeta2.1'>;
  readonly 'zeta3-internal'?: CompletionApiOperation<'zeta3-internal'>;
  readonly 'mercury-edit-2'?: CompletionApiOperation<'mercury-edit-2'>;
  readonly codestral?: CompletionApiOperation<'codestral'>;
}

export type CompletionApiCapabilities = Partial<{
  readonly [Kind in CompletionRequestKind]: CompletionApiCapability;
}>;

export interface CompletionApiProvider {
  readonly transport: 'native' | 'compatible';
  readonly capabilities: CompletionApiCapabilities;
  readonly operations: CompletionApiOperations;
}

export interface CompletionApiProviderValidationInput {
  readonly transport: string;
  readonly capabilities: object;
  readonly operations: object;
}

function responseModeForKind(kind: string): string | undefined {
  return Object.entries(COMPLETION_REQUEST_RESPONSE_MODES).find(
    ([candidate]) => candidate === kind,
  )?.[1];
}

export function validateCompletionApiProvider(
  provider: CompletionApiProviderValidationInput,
): void {
  if (provider.transport !== 'native' && provider.transport !== 'compatible') {
    throw new CompletionInvariantError(
      `Completion API Provider has invalid transport "${provider.transport}".`,
    );
  }
  for (const kind of Object.keys(provider.capabilities)) {
    const expectedMode = responseModeForKind(kind);
    if (expectedMode === undefined) {
      throw new CompletionInvariantError(
        `Completion API Provider declares unknown capability "${kind}".`,
      );
    }
    const operation = Reflect.get(provider.operations, kind);
    if (
      !Object.hasOwn(provider.operations, kind) ||
      typeof operation !== 'object' ||
      operation === null ||
      typeof Reflect.get(operation, 'execute') !== 'function'
    ) {
      throw new CompletionInvariantError(
        `Completion API Provider capability "${kind}" has no implementation.`,
      );
    }
    const capability = Reflect.get(provider.capabilities, kind);
    const responseMode =
      typeof capability === 'object' && capability !== null
        ? Reflect.get(capability, 'responseMode')
        : undefined;
    const multiCandidateSupport =
      typeof capability === 'object' && capability !== null
        ? Reflect.get(capability, 'multiCandidateSupport')
        : undefined;
    if (
      responseMode !== expectedMode ||
      (multiCandidateSupport !== 'single-request' &&
        multiCandidateSupport !== 'single-result-only')
    ) {
      throw new CompletionInvariantError(
        `Completion API Provider capability "${kind}" is invalid.`,
      );
    }
  }
  for (const kind of Object.keys(provider.operations)) {
    if (!Object.hasOwn(provider.capabilities, kind)) {
      throw new CompletionInvariantError(
        `Completion API Provider implementation "${kind}" has no capability.`,
      );
    }
  }
}

export function defineCompletionApiProvider(
  provider: CompletionApiProvider,
): CompletionApiProvider {
  validateCompletionApiProvider(provider);
  return provider;
}

export interface NativeCompletionApiContext {
  readonly provider: ProviderConfig;
  readonly model: ModelConfig;
  readonly completion: ResolvedCompletionConfig;
  resolveCredential(): Promise<AuthTokenInfo>;
  resolveProvider?(): ProviderConfig;
  refreshCredential?(): Promise<AuthTokenInfo>;
}

export interface NativeCompletionApiOperationFactories {
  readonly fim?: (
    context: NativeCompletionApiContext,
  ) => CompletionApiOperation<'fim'>;
  readonly codegemma?: (
    context: NativeCompletionApiContext,
  ) => CompletionApiOperation<'codegemma'>;
  readonly 'copilot-replica-nes'?: (
    context: NativeCompletionApiContext,
  ) => CompletionApiOperation<'copilot-replica-nes'>;
  readonly zeta1?: (
    context: NativeCompletionApiContext,
  ) => CompletionApiOperation<'zeta1'>;
  readonly zeta2?: (
    context: NativeCompletionApiContext,
  ) => CompletionApiOperation<'zeta2'>;
  readonly 'zeta2.1'?: (
    context: NativeCompletionApiContext,
  ) => CompletionApiOperation<'zeta2.1'>;
  readonly 'zeta3-internal'?: (
    context: NativeCompletionApiContext,
  ) => CompletionApiOperation<'zeta3-internal'>;
  readonly 'mercury-edit-2'?: (
    context: NativeCompletionApiContext,
  ) => CompletionApiOperation<'mercury-edit-2'>;
  readonly codestral?: (
    context: NativeCompletionApiContext,
  ) => CompletionApiOperation<'codestral'>;
}

export interface NativeCompletionApiProviderDefinition {
  readonly capabilities: CompletionApiCapabilities;
  readonly operationFactories: NativeCompletionApiOperationFactories;
}

function operationFactoryMarkers(
  factories: NativeCompletionApiOperationFactories,
): object {
  return {
    ...(factories.fim === undefined
      ? {}
      : { fim: { execute: factories.fim } }),
    ...(factories.codegemma === undefined
      ? {}
      : { codegemma: { execute: factories.codegemma } }),
    ...(factories['copilot-replica-nes'] === undefined
      ? {}
      : {
          'copilot-replica-nes': {
            execute: factories['copilot-replica-nes'],
          },
        }),
    ...(factories.zeta1 === undefined
      ? {}
      : { zeta1: { execute: factories.zeta1 } }),
    ...(factories.zeta2 === undefined
      ? {}
      : { zeta2: { execute: factories.zeta2 } }),
    ...(factories['zeta2.1'] === undefined
      ? {}
      : { 'zeta2.1': { execute: factories['zeta2.1'] } }),
    ...(factories['zeta3-internal'] === undefined
      ? {}
      : { 'zeta3-internal': { execute: factories['zeta3-internal'] } }),
    ...(factories['mercury-edit-2'] === undefined
      ? {}
      : { 'mercury-edit-2': { execute: factories['mercury-edit-2'] } }),
    ...(factories.codestral === undefined
      ? {}
      : { codestral: { execute: factories.codestral } }),
  };
}

export function defineNativeCompletionApiProvider(
  definition: NativeCompletionApiProviderDefinition,
): NativeCompletionApiProviderDefinition {
  validateCompletionApiProvider({
    transport: 'native',
    capabilities: definition.capabilities,
    operations: operationFactoryMarkers(definition.operationFactories),
  });
  return definition;
}

export function createNativeCompletionApiProvider(
  definition: NativeCompletionApiProviderDefinition,
  context: NativeCompletionApiContext,
): CompletionApiProvider {
  const factories = definition.operationFactories;
  return defineCompletionApiProvider({
    transport: 'native',
    capabilities: definition.capabilities,
    operations: {
      ...(factories.fim === undefined
        ? {}
        : { fim: factories.fim(context) }),
      ...(factories.codegemma === undefined
        ? {}
        : { codegemma: factories.codegemma(context) }),
      ...(factories['copilot-replica-nes'] === undefined
        ? {}
        : {
            'copilot-replica-nes':
              factories['copilot-replica-nes'](context),
          }),
      ...(factories.zeta1 === undefined
        ? {}
        : { zeta1: factories.zeta1(context) }),
      ...(factories.zeta2 === undefined
        ? {}
        : { zeta2: factories.zeta2(context) }),
      ...(factories['zeta2.1'] === undefined
        ? {}
        : { 'zeta2.1': factories['zeta2.1'](context) }),
      ...(factories['zeta3-internal'] === undefined
        ? {}
        : { 'zeta3-internal': factories['zeta3-internal'](context) }),
      ...(factories['mercury-edit-2'] === undefined
        ? {}
        : { 'mercury-edit-2': factories['mercury-edit-2'](context) }),
      ...(factories.codestral === undefined
        ? {}
        : { codestral: factories.codestral(context) }),
    },
  });
}
