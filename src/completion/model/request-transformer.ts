import type * as vscode from 'vscode';
import type {
  AlgorithmRequestKind,
  AlgorithmRequestMap,
  CodeGemmaCompletionRequest,
  CodestralCompletionRequest,
  CompletionRequestKind,
  CompletionRequestMap,
  CopilotReplicaNesCompletionRequest,
  FimCompletionRequest,
  MercuryEditCompletionRequest,
  Zeta3InternalCompletionRequest,
} from './requests';
import { buildCodestralPromptWindow } from '../template/codestral';
import type {
  AlgorithmResponseMap,
  BufferedCompletionResponse,
  CompletionResponseMap,
} from './responses';
import {
  ALGORITHM_REQUEST_DEFINITIONS,
  COMPLETION_REQUEST_RESPONSE_MODES,
} from './request-definitions';
import { CompletionInvariantError } from './errors';

export {
  ALGORITHM_REQUEST_DEFINITIONS,
  COMPLETION_REQUEST_RESPONSE_MODES,
} from './request-definitions';

export interface RequestTransformer<
  SourceKind extends AlgorithmRequestKind,
  TargetKind extends CompletionRequestKind,
> {
  readonly sourceKind: SourceKind;
  readonly targetKind: TargetKind;
  transformRequest(
    source: AlgorithmRequestMap[SourceKind],
  ): CompletionRequestMap[TargetKind];
  transformResponse(
    source: AlgorithmRequestMap[SourceKind],
    target: CompletionRequestMap[TargetKind],
    response: CompletionResponseMap[TargetKind],
  ): AlgorithmResponseMap[SourceKind];
}

export interface CompletionRequestExecutionContext {
  executeFim(
    request: FimCompletionRequest,
    token: vscode.CancellationToken,
  ): Promise<CompletionResponseMap['fim']>;
  executeCodeGemma(
    request: CodeGemmaCompletionRequest,
    token: vscode.CancellationToken,
  ): Promise<CompletionResponseMap['codegemma']>;
  executeCopilotReplicaNes(
    request: CopilotReplicaNesCompletionRequest,
    token: vscode.CancellationToken,
  ): Promise<CompletionResponseMap['copilot-replica-nes']>;
  executeZeta1(
    request: CompletionRequestMap['zeta1'],
    token: vscode.CancellationToken,
  ): Promise<CompletionResponseMap['zeta1']>;
  executeZeta2(
    request: CompletionRequestMap['zeta2'],
    token: vscode.CancellationToken,
  ): Promise<CompletionResponseMap['zeta2']>;
  executeZeta21(
    request: CompletionRequestMap['zeta2.1'],
    token: vscode.CancellationToken,
  ): Promise<CompletionResponseMap['zeta2.1']>;
  executeZeta3Internal(
    request: Zeta3InternalCompletionRequest,
    token: vscode.CancellationToken,
  ): Promise<CompletionResponseMap['zeta3-internal']>;
  executeMercuryEdit(
    request: MercuryEditCompletionRequest,
    token: vscode.CancellationToken,
  ): Promise<CompletionResponseMap['mercury-edit-2']>;
  executeCodestral(
    request: CodestralCompletionRequest,
    token: vscode.CancellationToken,
  ): Promise<CompletionResponseMap['codestral']>;
}

export interface ExecutableRequestTransformer<
  SourceKind extends AlgorithmRequestKind,
> {
  readonly sourceKind: SourceKind;
  readonly targetKind: CompletionRequestKind;
  readonly responseMode: 'buffered' | 'streaming';
  run(
    source: AlgorithmRequestMap[SourceKind],
    context: CompletionRequestExecutionContext,
    token: vscode.CancellationToken,
  ): Promise<AlgorithmResponseMap[SourceKind]>;
}

type ExecuteTarget<TargetKind extends CompletionRequestKind> = (
  context: CompletionRequestExecutionContext,
  request: CompletionRequestMap[TargetKind],
  token: vscode.CancellationToken,
) => Promise<CompletionResponseMap[TargetKind]>;

function defineTransformer<
  SourceKind extends AlgorithmRequestKind,
  TargetKind extends CompletionRequestKind,
>(
  transformer: RequestTransformer<SourceKind, TargetKind>,
  executeTarget: ExecuteTarget<TargetKind>,
): ExecutableRequestTransformer<SourceKind> {
  return {
    sourceKind: transformer.sourceKind,
    targetKind: transformer.targetKind,
    responseMode: COMPLETION_REQUEST_RESPONSE_MODES[transformer.targetKind],
    async run(source, context, token) {
      const target = transformer.transformRequest(source);
      const response = await executeTarget(context, target, token);
      return transformer.transformResponse(source, target, response);
    },
  };
}

const executeFim: ExecuteTarget<'fim'> = (context, request, token) =>
  context.executeFim(request, token);

const executeCodeGemma: ExecuteTarget<'codegemma'> = (
  context,
  request,
  token,
) => context.executeCodeGemma(request, token);

const executeCopilotReplicaNes: ExecuteTarget<'copilot-replica-nes'> = (
  context,
  request,
  token,
) => context.executeCopilotReplicaNes(request, token);

const executeZeta1: ExecuteTarget<'zeta1'> = (context, request, token) =>
  context.executeZeta1(request, token);
const executeZeta2: ExecuteTarget<'zeta2'> = (context, request, token) =>
  context.executeZeta2(request, token);
const executeZeta21: ExecuteTarget<'zeta2.1'> = (context, request, token) =>
  context.executeZeta21(request, token);
const executeZeta3Internal: ExecuteTarget<'zeta3-internal'> = (
  context,
  request,
  token,
) => context.executeZeta3Internal(request, token);
const executeMercuryEdit: ExecuteTarget<'mercury-edit-2'> = (
  context,
  request,
  token,
) => context.executeMercuryEdit(request, token);
const executeCodestral: ExecuteTarget<'codestral'> = (context, request, token) =>
  context.executeCodestral(request, token);

function firstChoice(response: BufferedCompletionResponse) {
  return response.choices[0];
}

const simpleToFim = defineTransformer(
  {
    sourceKind: 'simple',
    targetKind: 'fim',
    transformRequest(source) {
      return {
        kind: 'fim',
        prefix: source.prefix,
        suffix: source.suffix,
        options: {},
      };
    },
    transformResponse(_source, _target, response) {
      const first = firstChoice(response);
      return {
        kind: 'simple',
        text: first?.text ?? '',
        ...(first?.finishReason === undefined
          ? {}
          : { finishReason: first.finishReason }),
        ...(response.usage === undefined ? {} : { usage: response.usage }),
        ...(response.choices.length > 1 ? { choices: response.choices } : {}),
      };
    },
  } satisfies RequestTransformer<'simple', 'fim'>,
  executeFim,
);

const simpleToCodeGemma = defineTransformer(
  {
    sourceKind: 'simple',
    targetKind: 'codegemma',
    transformRequest(source) {
      return {
        kind: 'codegemma',
        prefix: source.prefix,
        suffix: source.suffix,
        contexts: [],
        options: {},
      };
    },
    transformResponse(_source, _target, response) {
      const first = firstChoice(response);
      return {
        kind: 'simple',
        text: first?.text ?? '',
        ...(first?.finishReason === undefined
          ? {}
          : { finishReason: first.finishReason }),
        ...(response.usage === undefined ? {} : { usage: response.usage }),
        ...(response.choices.length > 1 ? { choices: response.choices } : {}),
      };
    },
  } satisfies RequestTransformer<'simple', 'codegemma'>,
  executeCodeGemma,
);

const copilotFimToFim = defineTransformer(
  {
    sourceKind: 'copilot-replica/fim',
    targetKind: 'fim',
    transformRequest(source) {
      return {
        kind: 'fim',
        prefix: source.prefix,
        suffix: source.suffix,
        options: source.options,
      };
    },
    transformResponse(_source, _target, response) {
      const first = firstChoice(response);
      return {
        kind: 'copilot-replica/fim',
        text: first?.text ?? '',
        ...(first?.finishReason === undefined
          ? {}
          : { finishReason: first.finishReason }),
        ...(response.usage === undefined ? {} : { usage: response.usage }),
        ...(response.choices.length > 1 ? { choices: response.choices } : {}),
      };
    },
  } satisfies RequestTransformer<'copilot-replica/fim', 'fim'>,
  executeFim,
);

const copilotFimToCodeGemma = defineTransformer(
  {
    sourceKind: 'copilot-replica/fim',
    targetKind: 'codegemma',
    transformRequest(source) {
      return {
        kind: 'codegemma',
        ...(source.targetPath === undefined
          ? {}
          : { targetPath: source.targetPath }),
        prefix: source.prefix,
        suffix: source.suffix,
        contexts: source.contexts,
        options: source.options,
      };
    },
    transformResponse(_source, _target, response) {
      const first = firstChoice(response);
      return {
        kind: 'copilot-replica/fim',
        text: first?.text ?? '',
        ...(first?.finishReason === undefined
          ? {}
          : { finishReason: first.finishReason }),
        ...(response.usage === undefined ? {} : { usage: response.usage }),
        ...(response.choices.length > 1 ? { choices: response.choices } : {}),
      };
    },
  } satisfies RequestTransformer<'copilot-replica/fim', 'codegemma'>,
  executeCodeGemma,
);

const copilotNesToCompatible = defineTransformer(
  {
    sourceKind: 'copilot-replica/nes',
    targetKind: 'copilot-replica-nes',
    transformRequest(source) {
      return {
        kind: 'copilot-replica-nes',
        messages: source.messages,
        ...(source.maxTokens === undefined
          ? {}
          : { maxTokens: source.maxTokens }),
        ...(source.prediction === undefined
          ? {}
          : { prediction: source.prediction }),
        responseFormat: source.responseFormat,
      };
    },
    transformResponse(_source, _target, response) {
      return { kind: 'copilot-replica/nes', text: response.text };
    },
  } satisfies RequestTransformer<
    'copilot-replica/nes',
    'copilot-replica-nes'
  >,
  executeCopilotReplicaNes,
);

const cursorPredictionToCompatible = defineTransformer(
  {
    sourceKind: 'copilot-replica/cursor-prediction',
    targetKind: 'copilot-replica-nes',
    transformRequest(source) {
      return {
        kind: 'copilot-replica-nes',
        messages: source.messages,
        ...(source.maxTokens === undefined
          ? {}
          : { maxTokens: source.maxTokens }),
        responseFormat: source.responseFormat,
      };
    },
    transformResponse(_source, _target, response) {
      return {
        kind: 'copilot-replica/cursor-prediction',
        text: response.text,
      };
    },
  } satisfies RequestTransformer<
    'copilot-replica/cursor-prediction',
    'copilot-replica-nes'
  >,
  executeCopilotReplicaNes,
);

function zedResponse(
  response: BufferedCompletionResponse,
): AlgorithmResponseMap['zed'] {
  const first = firstChoice(response);
  return {
    kind: 'zed',
    text: first?.text ?? '',
    ...(first?.finishReason === undefined
      ? {}
      : { finishReason: first.finishReason }),
    ...(response.usage === undefined ? {} : { usage: response.usage }),
    ...(response.edit === undefined ? {} : { edit: response.edit }),
  };
}

const zedToZeta3 = defineTransformer(
  {
    sourceKind: 'zed',
    targetKind: 'zeta3-internal',
    transformRequest(source) {
      return {
        kind: 'zeta3-internal',
        document: source.document,
        trigger: source.trigger,
        editHistory: source.editHistory,
        diagnostics: source.diagnostics,
      };
    },
    transformResponse(_source, _target, response) {
      return zedResponse(response);
    },
  } satisfies RequestTransformer<'zed', 'zeta3-internal'>,
  executeZeta3Internal,
);

const zedToZeta21 = defineTransformer(
  {
    sourceKind: 'zed',
    targetKind: 'zeta2.1',
    transformRequest(source) {
      return {
        kind: 'zeta2.1',
        document: source.document,
        trigger: source.trigger,
        editHistory: source.editHistory,
        contexts: source.contexts,
        diagnostics: source.diagnostics,
        options: { maxTokens: source.maxTokens },
      };
    },
    transformResponse(_source, _target, response) {
      return zedResponse(response);
    },
  } satisfies RequestTransformer<'zed', 'zeta2.1'>,
  executeZeta21,
);

const zedToZeta2 = defineTransformer(
  {
    sourceKind: 'zed',
    targetKind: 'zeta2',
    transformRequest(source) {
      return {
        kind: 'zeta2',
        document: source.document,
        trigger: source.trigger,
        editHistory: source.editHistory,
        contexts: source.contexts,
        diagnostics: source.diagnostics,
        options: { maxTokens: source.maxTokens },
      };
    },
    transformResponse(_source, _target, response) {
      return zedResponse(response);
    },
  } satisfies RequestTransformer<'zed', 'zeta2'>,
  executeZeta2,
);

const zedToZeta1 = defineTransformer(
  {
    sourceKind: 'zed',
    targetKind: 'zeta1',
    transformRequest(source) {
      return {
        kind: 'zeta1',
        document: source.document,
        trigger: source.trigger,
        editHistory: source.editHistory,
        contexts: source.contexts,
        diagnostics: source.diagnostics,
        options: { maxTokens: source.maxTokens },
      };
    },
    transformResponse(_source, _target, response) {
      return zedResponse(response);
    },
  } satisfies RequestTransformer<'zed', 'zeta1'>,
  executeZeta1,
);

const inceptionToMercury = defineTransformer(
  {
    sourceKind: 'inception',
    targetKind: 'mercury-edit-2',
    transformRequest(source) {
      return {
        kind: 'mercury-edit-2',
        document: source.document,
        editHistory: source.editHistory,
        contexts: source.contexts,
      };
    },
    transformResponse(_source, _target, response) {
      const first = firstChoice(response);
      return {
        kind: 'inception',
        text: first?.text ?? '',
        ...(first?.finishReason === undefined
          ? {}
          : { finishReason: first.finishReason }),
        ...(response.usage === undefined ? {} : { usage: response.usage }),
        ...(response.edit === undefined ? {} : { edit: response.edit }),
      };
    },
  } satisfies RequestTransformer<'inception', 'mercury-edit-2'>,
  executeMercuryEdit,
);

const mistralToCodestral = defineTransformer(
  {
    sourceKind: 'mistral',
    targetKind: 'codestral',
    transformRequest(source) {
      const window = buildCodestralPromptWindow(source.document);
      return {
        kind: 'codestral',
        prefix: window.prompt,
        suffix: window.suffix,
        options: { maxTokens: source.maxTokens },
      };
    },
    transformResponse(_source, _target, response) {
      const first = firstChoice(response);
      return {
        kind: 'mistral',
        text: first?.text ?? '',
        ...(first?.finishReason === undefined
          ? {}
          : { finishReason: first.finishReason }),
        ...(response.usage === undefined ? {} : { usage: response.usage }),
      };
    },
  } satisfies RequestTransformer<'mistral', 'codestral'>,
  executeCodestral,
);

export type RequestTransformerTable = {
  readonly [Kind in AlgorithmRequestKind]: readonly ExecutableRequestTransformer<Kind>[];
};

export const REQUEST_TRANSFORMERS = {
  simple: [simpleToFim, simpleToCodeGemma],
  'copilot-replica/fim': [copilotFimToFim, copilotFimToCodeGemma],
  'copilot-replica/nes': [copilotNesToCompatible],
  'copilot-replica/cursor-prediction': [cursorPredictionToCompatible],
  zed: [zedToZeta3, zedToZeta21, zedToZeta2, zedToZeta1],
  inception: [inceptionToMercury],
  mistral: [mistralToCodestral],
} satisfies RequestTransformerTable;

interface RequestTransformerRegistration {
  readonly sourceKind: string;
  readonly targetKind: string;
  readonly responseMode: string;
}

export type RequestTransformerValidationTable = Readonly<
  Partial<Record<string, readonly RequestTransformerRegistration[]>>
>;

export function validateRequestTransformerTable(
  table: RequestTransformerValidationTable = REQUEST_TRANSFORMERS,
): void {
  const declaredSourceKinds = Object.keys(ALGORITHM_REQUEST_DEFINITIONS);
  for (const sourceKind of declaredSourceKinds) {
    if (!Object.hasOwn(table, sourceKind)) {
      throw new CompletionInvariantError(
        `Completion request transformer source "${sourceKind}" is missing.`,
      );
    }
  }
  for (const sourceKind of Object.keys(table)) {
    if (!Object.hasOwn(ALGORITHM_REQUEST_DEFINITIONS, sourceKind)) {
      throw new CompletionInvariantError(
        `Completion request transformer source "${sourceKind}" is not declared.`,
      );
    }
  }

  for (const sourceKind of declaredSourceKinds) {
    const transformers = table[sourceKind] ?? [];
    if (transformers.length === 0) {
      throw new CompletionInvariantError(
        `Completion request transformer source "${sourceKind}" has no targets.`,
      );
    }
    const definition =
      ALGORITHM_REQUEST_DEFINITIONS[
        sourceKind as AlgorithmRequestKind
      ];
    const targets = new Set<string>();
    for (const [index, transformer] of transformers.entries()) {
      if (transformer.sourceKind !== sourceKind) {
        throw new CompletionInvariantError(
          `Completion request transformer registered under "${sourceKind}" declares source "${transformer.sourceKind}".`,
        );
      }
      if (targets.has(transformer.targetKind)) {
        throw new CompletionInvariantError(
          `Completion request transformer "${sourceKind}" -> "${transformer.targetKind}" is duplicated.`,
        );
      }
      targets.add(transformer.targetKind);
      const declaredTarget = definition.targets[index];
      if (declaredTarget !== transformer.targetKind) {
        throw new CompletionInvariantError(
          declaredTarget === undefined
            ? `Completion request transformer "${sourceKind}" -> "${transformer.targetKind}" is not declared.`
            : `Completion request transformer source "${sourceKind}" requires target "${declaredTarget}" at priority ${index + 1}.`,
        );
      }
      const targetResponseMode =
        COMPLETION_REQUEST_RESPONSE_MODES[
          transformer.targetKind as CompletionRequestKind
        ];
      if (
        targetResponseMode === undefined ||
        transformer.responseMode !== targetResponseMode ||
        transformer.responseMode !== definition.responseMode
      ) {
        throw new CompletionInvariantError(
          `Completion request transformer "${sourceKind}" -> "${transformer.targetKind}" has incompatible response mode "${transformer.responseMode}".`,
        );
      }
    }
    if (transformers.length < definition.targets.length) {
      const missingTarget = definition.targets[transformers.length];
      throw new CompletionInvariantError(
        `Completion request transformer "${sourceKind}" -> "${missingTarget}" is missing.`,
      );
    }
  }
}

validateRequestTransformerTable();
