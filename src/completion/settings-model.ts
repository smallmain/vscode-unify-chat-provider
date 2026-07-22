import type {
  NesAggressivenessSetting,
  NesPromptStrategy,
} from '../chat-lib/core/behavior-config';
import {
  DEFAULT_COPILOT_REPLICA_N,
  normalizeCopilotReplicaAlgorithmOptions,
  type CopilotReplicaAlgorithmOptions,
} from './copilot/options';
import { mergeCompletionDisabledGlobs } from './disabled-globs';
import {
  DEFAULT_MISTRAL_MAX_TOKENS,
  DEFAULT_ZED_MAX_TOKENS,
  normalizeInceptionAlgorithmOptions,
  normalizeMistralAlgorithmOptions,
  normalizeZedAlgorithmOptions,
} from './edit/options';
import { normalizeSimpleAlgorithmOptions } from './simple/options';
import type {
  CompletionAlgorithmId,
  CompletionAlgorithmEntry,
  CompletionModelReference,
  CompletionStopCondition,
  CompletionStrategy,
} from './types';

export interface SimpleOptionsDraft {
  model?: CompletionModelReference;
}

export interface CopilotReplicaOptionsDraft {
  enableFIM: boolean;
  enableNES: boolean;
  n: number;
  fimModel?: CompletionModelReference;
  nesModel?: CompletionModelReference;
  unifiedModel?: CompletionModelReference;
  cursorPredictionModel?: CompletionModelReference;
  strategy: NesPromptStrategy;
  eagerness: NesAggressivenessSetting;
  modelUnification: boolean;
}

export interface ZedOptionsDraft {
  model?: CompletionModelReference;
  maxTokens: number;
}

export interface InceptionOptionsDraft {
  model?: CompletionModelReference;
}

export interface MistralOptionsDraft {
  model?: CompletionModelReference;
  maxTokens: number;
}

export interface CompletionAlgorithmEntryDraft {
  id: string;
  algorithm?: CompletionAlgorithmId;
  simple: SimpleOptionsDraft;
  copilotReplica: CopilotReplicaOptionsDraft;
  zed: ZedOptionsDraft;
  inception: InceptionOptionsDraft;
  mistral: MistralOptionsDraft;
  preservedCopilotReplicaOptions?: CopilotReplicaAlgorithmOptions;
}

export interface CopilotReplicaOptionsEditSelection {
  readonly enableFIM: boolean;
  readonly enableNES: boolean;
  readonly n: number;
  readonly fimModel?: CompletionModelReference;
  readonly nesModel?: CompletionModelReference;
  readonly unifiedModel?: CompletionModelReference;
  readonly cursorPredictionModel?: CompletionModelReference;
  readonly strategy: NesPromptStrategy;
  readonly eagerness: NesAggressivenessSetting;
  readonly modelUnification: boolean;
}

export type CompletionAlgorithmEntryDraftError =
  | 'entryIdRequired'
  | 'entryIdDuplicate'
  | 'algorithmRequired'
  | 'simpleModelRequired'
  | 'copilotReplicaModeRequired'
  | 'copilotReplicaFimModelRequired'
  | 'copilotReplicaNInvalid'
  | 'copilotReplicaNesModelRequired'
  | 'copilotReplicaUnifiedModelRequired'
  | 'zedModelRequired'
  | 'zedMaxTokensInvalid'
  | 'inceptionModelRequired'
  | 'mistralModelRequired'
  | 'mistralMaxTokensInvalid';

export type CompletionAlgorithmEntryDraftResult =
  | { ok: true; entry: CompletionAlgorithmEntry }
  | { ok: false; error: CompletionAlgorithmEntryDraftError };

export type CompletionStopConditionType = CompletionStopCondition['type'];

export interface CompletionStrategyDraft {
  mode: CompletionStrategy['mode'];
  disableVSCodeBuiltinCompletion: boolean;
  disabledGlobs: string[];
  mainProvider?: string;
  mainFirstTimeoutMs: number;
  parallelRequestOthers: boolean;
  stopType: CompletionStopConditionType;
  firstUsableGraceMs: number;
  deadlineTimeoutMs: number;
  enoughResultsMinItems: number;
  enoughResultsGraceMs: number;
}

export type StrategyDraftError =
  | 'mainProviderRequired'
  | 'mainProviderMissing'
  | 'mainFirstTimeoutInvalid'
  | 'graceInvalid'
  | 'deadlineInvalid'
  | 'minimumResultsInvalid';

export type StrategyDraftResult =
  | { ok: true; strategy: CompletionStrategy }
  | { ok: false; error: StrategyDraftError };

type StrategyDraftFailure = Extract<StrategyDraftResult, { ok: false }>;

function isNonNegativeNumber(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function copyModelReference(
  reference: CompletionModelReference | undefined,
): CompletionModelReference | undefined {
  return reference ? { ...reference } : undefined;
}

export function createCompletionAlgorithmEntryDraft(
  existing?: CompletionAlgorithmEntry,
): CompletionAlgorithmEntryDraft {
  const normalizedSimple =
    existing?.algorithm === 'simple'
      ? normalizeSimpleAlgorithmOptions(existing.options)
      : undefined;
  const normalizedCopilotReplica =
    existing?.algorithm === 'copilot-replica'
      ? normalizeCopilotReplicaAlgorithmOptions(existing.options)
      : undefined;
  const normalizedZed =
    existing?.algorithm === 'zed'
      ? normalizeZedAlgorithmOptions(existing.options)
      : undefined;
  const normalizedInception =
    existing?.algorithm === 'inception'
      ? normalizeInceptionAlgorithmOptions(existing.options)
      : undefined;
  const normalizedMistral =
    existing?.algorithm === 'mistral'
      ? normalizeMistralAlgorithmOptions(existing.options)
      : undefined;
  const copilotReplica = normalizedCopilotReplica?.ok
    ? normalizedCopilotReplica.value
    : undefined;
  const hasExplicitCursorPredictionModel =
    existing?.options !== undefined &&
    Object.prototype.hasOwnProperty.call(
      existing.options,
      'cursorPredictionModel',
    );

  return {
    id: existing?.id ?? '',
    algorithm: existing?.algorithm,
    simple: {
      ...(normalizedSimple?.ok
        ? { model: copyModelReference(normalizedSimple.value.model) }
        : {}),
    },
    copilotReplica: {
      enableFIM: copilotReplica?.enableFIM ?? true,
      enableNES: copilotReplica?.enableNES ?? false,
      n: copilotReplica?.n ?? DEFAULT_COPILOT_REPLICA_N,
      ...(copyModelReference(copilotReplica?.fimModel)
        ? { fimModel: copyModelReference(copilotReplica?.fimModel) }
        : {}),
      ...(copyModelReference(copilotReplica?.nesModel)
        ? { nesModel: copyModelReference(copilotReplica?.nesModel) }
        : {}),
      ...(copyModelReference(copilotReplica?.unifiedModel)
        ? { unifiedModel: copyModelReference(copilotReplica?.unifiedModel) }
        : {}),
      ...(hasExplicitCursorPredictionModel &&
      copyModelReference(copilotReplica?.cursorPredictionModel)
        ? {
            cursorPredictionModel: copyModelReference(
              copilotReplica?.cursorPredictionModel,
            ),
          }
        : {}),
      strategy: copilotReplica?.strategy ?? 'copilotNesXtab',
      eagerness: copilotReplica?.eagerness ?? 'auto',
      modelUnification: copilotReplica?.modelUnification ?? false,
    },
    zed: {
      ...(normalizedZed?.ok
        ? { model: copyModelReference(normalizedZed.value.model) }
        : {}),
      maxTokens: normalizedZed?.ok
        ? normalizedZed.value.maxTokens
        : DEFAULT_ZED_MAX_TOKENS,
    },
    inception: {
      ...(normalizedInception?.ok
        ? { model: copyModelReference(normalizedInception.value.model) }
        : {}),
    },
    mistral: {
      ...(normalizedMistral?.ok
        ? { model: copyModelReference(normalizedMistral.value.model) }
        : {}),
      maxTokens: normalizedMistral?.ok
        ? normalizedMistral.value.maxTokens
        : DEFAULT_MISTRAL_MAX_TOKENS,
    },
    ...(copilotReplica
      ? { preservedCopilotReplicaOptions: copilotReplica }
      : {}),
  };
}

export function buildEditedCopilotReplicaOptions(
  existing: CopilotReplicaAlgorithmOptions | undefined,
  selection: CopilotReplicaOptionsEditSelection,
): Record<string, unknown> {
  const useUnifiedModel =
    selection.enableFIM &&
    selection.enableNES &&
    selection.modelUnification;
  return {
    enableFIM: selection.enableFIM,
    enableNES: selection.enableNES,
    ...(existing?.enabledLanguages
      ? { enabledLanguages: existing.enabledLanguages }
      : {}),
    ...(existing?.inlineEditsEnabledLanguages
      ? {
          inlineEditsEnabledLanguages: existing.inlineEditsEnabledLanguages,
        }
      : {}),
    ...(existing?.respectSelectedCompletionInfo === undefined
      ? {}
      : {
          respectSelectedCompletionInfo: existing.respectSelectedCompletionInfo,
        }),
    ...(existing?.includeInlineCompletions === undefined
      ? {}
      : { includeInlineCompletions: existing.includeInlineCompletions }),
    ...(existing?.includeInlineEdits === undefined
      ? {}
      : { includeInlineEdits: existing.includeInlineEdits }),
    ...(selection.enableFIM && !useUnifiedModel
      ? {
          fimModel: selection.fimModel,
          n: selection.n,
        }
      : {}),
    ...(selection.enableNES && !useUnifiedModel
      ? {
          nesModel: selection.nesModel,
          strategy: selection.strategy,
          eagerness: selection.eagerness,
        }
      : {}),
    ...(useUnifiedModel
      ? {
          unifiedModel: selection.unifiedModel,
          eagerness: selection.eagerness,
        }
      : {}),
    ...(selection.enableNES && selection.cursorPredictionModel
      ? { cursorPredictionModel: { ...selection.cursorPredictionModel } }
      : {}),
    ...(selection.enableFIM && selection.enableNES
      ? { modelUnification: selection.modelUnification }
      : {}),
  };
}

export function buildCompletionAlgorithmEntry(
  draft: CompletionAlgorithmEntryDraft,
  entries: readonly CompletionAlgorithmEntry[],
  originalId?: string,
): CompletionAlgorithmEntryDraftResult {
  const id = draft.id.trim();
  if (!id) {
    return { ok: false, error: 'entryIdRequired' };
  }
  if (
    entries.some(
      (entry) => entry.id === id && entry.id !== originalId,
    )
  ) {
    return { ok: false, error: 'entryIdDuplicate' };
  }

  if (!draft.algorithm) {
    return { ok: false, error: 'algorithmRequired' };
  }
  if (draft.algorithm === 'simple') {
    if (!draft.simple.model) {
      return { ok: false, error: 'simpleModelRequired' };
    }
    return {
      ok: true,
      entry: {
        id,
        algorithm: 'simple',
        options: { model: { ...draft.simple.model } },
      },
    };
  }

  if (draft.algorithm === 'zed') {
    if (!draft.zed.model) {
      return { ok: false, error: 'zedModelRequired' };
    }
    if (!Number.isSafeInteger(draft.zed.maxTokens) || draft.zed.maxTokens <= 0) {
      return { ok: false, error: 'zedMaxTokensInvalid' };
    }
    return {
      ok: true,
      entry: {
        id,
        algorithm: 'zed',
        options: {
          model: { ...draft.zed.model },
          maxTokens: draft.zed.maxTokens,
        },
      },
    };
  }

  if (draft.algorithm === 'inception') {
    if (!draft.inception.model) {
      return { ok: false, error: 'inceptionModelRequired' };
    }
    return {
      ok: true,
      entry: {
        id,
        algorithm: 'inception',
        options: { model: { ...draft.inception.model } },
      },
    };
  }

  if (draft.algorithm === 'mistral') {
    if (!draft.mistral.model) {
      return { ok: false, error: 'mistralModelRequired' };
    }
    if (
      !Number.isSafeInteger(draft.mistral.maxTokens) ||
      draft.mistral.maxTokens <= 0
    ) {
      return { ok: false, error: 'mistralMaxTokensInvalid' };
    }
    return {
      ok: true,
      entry: {
        id,
        algorithm: 'mistral',
        options: {
          model: { ...draft.mistral.model },
          maxTokens: draft.mistral.maxTokens,
        },
      },
    };
  }

  if (!draft.copilotReplica.enableFIM && !draft.copilotReplica.enableNES) {
    return { ok: false, error: 'copilotReplicaModeRequired' };
  }
  const useUnifiedModel =
    draft.copilotReplica.enableFIM &&
    draft.copilotReplica.enableNES &&
    draft.copilotReplica.modelUnification;
  if (useUnifiedModel && !draft.copilotReplica.unifiedModel) {
    return { ok: false, error: 'copilotReplicaUnifiedModelRequired' };
  }
  if (
    !useUnifiedModel &&
    draft.copilotReplica.enableFIM &&
    !draft.copilotReplica.fimModel
  ) {
    return { ok: false, error: 'copilotReplicaFimModelRequired' };
  }
  if (
    !useUnifiedModel &&
    draft.copilotReplica.enableFIM &&
    (!Number.isSafeInteger(draft.copilotReplica.n) ||
      draft.copilotReplica.n <= 0)
  ) {
    return { ok: false, error: 'copilotReplicaNInvalid' };
  }
  if (
    !useUnifiedModel &&
    draft.copilotReplica.enableNES &&
    !draft.copilotReplica.nesModel
  ) {
    return { ok: false, error: 'copilotReplicaNesModelRequired' };
  }

  return {
    ok: true,
    entry: {
      id,
      algorithm: 'copilot-replica',
      options: buildEditedCopilotReplicaOptions(
        draft.preservedCopilotReplicaOptions,
        {
          ...draft.copilotReplica,
        },
      ),
    },
  };
}

export function createCompletionStrategyDraft(
  strategy: CompletionStrategy,
): CompletionStrategyDraft {
  return {
    mode: strategy.mode,
    disableVSCodeBuiltinCompletion:
      strategy.disableVSCodeBuiltinCompletion ?? true,
    disabledGlobs: mergeCompletionDisabledGlobs(strategy.disabledGlobs),
    mainProvider: strategy.mainProvider,
    mainFirstTimeoutMs: strategy.mainFirstTimeoutMs ?? 500,
    parallelRequestOthers: strategy.parallelRequestOthers ?? false,
    stopType: strategy.stopWhen.type,
    firstUsableGraceMs:
      strategy.stopWhen.type === 'firstUsable'
        ? (strategy.stopWhen.graceMs ?? 0)
        : 0,
    deadlineTimeoutMs:
      strategy.stopWhen.type === 'deadline'
        ? strategy.stopWhen.timeoutMs
        : 500,
    enoughResultsMinItems:
      strategy.stopWhen.type === 'enoughResults'
        ? strategy.stopWhen.minItems
        : 1,
    enoughResultsGraceMs:
      strategy.stopWhen.type === 'enoughResults'
        ? (strategy.stopWhen.graceMs ?? 0)
        : 0,
  };
}

function buildStopCondition(
  draft: CompletionStrategyDraft,
): StrategyDraftFailure | CompletionStopCondition {
  switch (draft.stopType) {
    case 'firstUsable':
      return isNonNegativeNumber(draft.firstUsableGraceMs)
        ? { type: 'firstUsable', graceMs: draft.firstUsableGraceMs }
        : { ok: false, error: 'graceInvalid' };
    case 'deadline':
      return isNonNegativeNumber(draft.deadlineTimeoutMs)
        ? { type: 'deadline', timeoutMs: draft.deadlineTimeoutMs }
        : { ok: false, error: 'deadlineInvalid' };
    case 'enoughResults':
      if (
        !Number.isSafeInteger(draft.enoughResultsMinItems) ||
        draft.enoughResultsMinItems <= 0
      ) {
        return { ok: false, error: 'minimumResultsInvalid' };
      }
      return isNonNegativeNumber(draft.enoughResultsGraceMs)
        ? {
            type: 'enoughResults',
            minItems: draft.enoughResultsMinItems,
            graceMs: draft.enoughResultsGraceMs,
          }
        : { ok: false, error: 'graceInvalid' };
    case 'allSettled':
      return { type: 'allSettled' };
  }
}

function isStrategyError(
  value: StrategyDraftFailure | CompletionStopCondition,
): value is StrategyDraftFailure {
  return 'ok' in value && value.ok === false;
}

export function buildCompletionStrategy(
  draft: CompletionStrategyDraft,
  entries: readonly CompletionAlgorithmEntry[],
): StrategyDraftResult {
  const stopWhen = buildStopCondition(draft);
  if (isStrategyError(stopWhen)) {
    return stopWhen;
  }

  if (draft.mode === 'all') {
    return {
      ok: true,
      strategy: {
        mode: 'all',
        disableVSCodeBuiltinCompletion:
          draft.disableVSCodeBuiltinCompletion,
        disabledGlobs: mergeCompletionDisabledGlobs(draft.disabledGlobs),
        stopWhen,
      },
    };
  }
  if (!draft.mainProvider) {
    return { ok: false, error: 'mainProviderRequired' };
  }
  if (!entries.some((entry) => entry.id === draft.mainProvider)) {
    return { ok: false, error: 'mainProviderMissing' };
  }
  if (!isNonNegativeNumber(draft.mainFirstTimeoutMs)) {
    return { ok: false, error: 'mainFirstTimeoutInvalid' };
  }

  return {
    ok: true,
    strategy: {
      mode: 'main-first',
      disableVSCodeBuiltinCompletion: draft.disableVSCodeBuiltinCompletion,
      disabledGlobs: mergeCompletionDisabledGlobs(draft.disabledGlobs),
      mainProvider: draft.mainProvider,
      mainFirstTimeoutMs: draft.mainFirstTimeoutMs,
      parallelRequestOthers: draft.parallelRequestOthers,
      stopWhen,
    },
  };
}

export function nextCompletionAlgorithmEntryCloneId(
  entryId: string,
  entries: readonly CompletionAlgorithmEntry[],
): string {
  const ids = new Set(entries.map((entry) => entry.id));
  const base = `${entryId}-copy`;
  if (!ids.has(base)) {
    return base;
  }
  let suffix = 2;
  while (ids.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

export function cloneCompletionAlgorithmEntry(
  entry: CompletionAlgorithmEntry,
  entries: readonly CompletionAlgorithmEntry[],
): CompletionAlgorithmEntry {
  return {
    id: nextCompletionAlgorithmEntryCloneId(entry.id, entries),
    algorithm: entry.algorithm,
    ...(entry.options === undefined
      ? {}
      : { options: structuredClone(entry.options) }),
  };
}

export function updateStrategyForRenamedEntry(
  strategy: CompletionStrategy,
  oldId: string,
  newId: string,
): CompletionStrategy {
  return strategy.mode === 'main-first' && strategy.mainProvider === oldId
    ? { ...strategy, mainProvider: newId }
    : strategy;
}

export function updateStrategyForRemovedEntry(
  strategy: CompletionStrategy,
  providerId: string,
): CompletionStrategy {
  return strategy.mode === 'main-first' && strategy.mainProvider === providerId
    ? {
        mode: 'all',
        disableVSCodeBuiltinCompletion:
          strategy.disableVSCodeBuiltinCompletion ?? true,
        disabledGlobs: mergeCompletionDisabledGlobs(strategy.disabledGlobs),
        stopWhen: { ...strategy.stopWhen },
      }
    : strategy;
}
