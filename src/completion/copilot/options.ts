import { isRecord } from '../configuration';
import type { CompletionModelReference } from '../types';
import type {
  NesAggressivenessSetting,
  NesPromptStrategy,
} from '../../chat-lib/core/behavior-config';
import { t } from '../../i18n';

export const DEFAULT_COPILOT_REPLICA_N = 1;

export interface CopilotReplicaAlgorithmOptions {
  enableFIM: boolean;
  enableNES: boolean;
  n: number;
  modelUnification?: boolean;
  strategy?: NesPromptStrategy;
  enabledLanguages?: Readonly<Record<string, boolean>>;
  inlineEditsEnabledLanguages?: Readonly<Record<string, boolean>>;
  eagerness?: NesAggressivenessSetting;
  respectSelectedCompletionInfo?: boolean;
  includeInlineCompletions?: boolean;
  includeInlineEdits?: boolean;
  fimModel?: CompletionModelReference;
  nesModel?: CompletionModelReference;
  unifiedModel?: CompletionModelReference;
  cursorPredictionModel?: CompletionModelReference;
}

export type CopilotReplicaAlgorithmOptionsResult =
  | { ok: true; value: CopilotReplicaAlgorithmOptions }
  | { ok: false; error: string };

function normalizeModelReference(
  raw: unknown,
): CompletionModelReference | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const vendor = typeof raw.vendor === 'string' ? raw.vendor.trim() : '';
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  return vendor && id ? { vendor, id } : undefined;
}

function isStrategy(value: unknown): value is NesPromptStrategy {
  return (
    value === 'copilotNesXtab' ||
    value === 'xtab275' ||
    value === 'xtabUnifiedModel' ||
    value === 'xtabAggressiveness' ||
    value === 'xtab275Aggressiveness' ||
    value === 'xtab275AggressivenessHighLow' ||
    value === 'xtab275EditIntent' ||
    value === 'xtab275EditIntentShort'
  );
}

function isAggressivenessSetting(
  value: unknown,
): value is NesAggressivenessSetting {
  return (
    value === 'auto' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high'
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0
  );
}

function normalizeEnabledLanguages(
  raw: unknown,
): Readonly<Record<string, boolean>> | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const normalized: Record<string, boolean> = {};
  for (const [languageId, enabled] of Object.entries(raw)) {
    const normalizedLanguageId = languageId.trim();
    if (normalizedLanguageId.length === 0 || typeof enabled !== 'boolean') {
      return undefined;
    }
    normalized[normalizedLanguageId] = enabled;
  }
  return normalized;
}

export function normalizeCopilotReplicaAlgorithmOptions(
  raw: unknown,
): CopilotReplicaAlgorithmOptionsResult {
  if (!isRecord(raw)) {
    return {
      ok: false,
      error: t('Copilot Replica options must be an object.'),
    };
  }
  if (
    typeof raw.enableFIM !== 'boolean' ||
    typeof raw.enableNES !== 'boolean'
  ) {
    return {
      ok: false,
      error: t(
        'Copilot Replica options require boolean enableFIM and enableNES values.',
      ),
    };
  }
  if (!raw.enableFIM && !raw.enableNES) {
    return {
      ok: false,
      error: t('Copilot Replica options must enable FIM, NES, or both.'),
    };
  }
  const n = raw.n === undefined ? DEFAULT_COPILOT_REPLICA_N : raw.n;
  if (!isPositiveSafeInteger(n)) {
    return {
      ok: false,
      error: t('Copilot Replica n must be a positive integer.'),
    };
  }
  const fimModel = normalizeModelReference(raw.fimModel);
  const nesModel = normalizeModelReference(raw.nesModel);
  const unifiedModel = normalizeModelReference(raw.unifiedModel);
  const configuredCursorPredictionModel = normalizeModelReference(
    raw.cursorPredictionModel,
  );
  if (
    raw.modelUnification !== undefined &&
    typeof raw.modelUnification !== 'boolean'
  ) {
    return {
      ok: false,
      error: t('Copilot Replica modelUnification must be boolean.'),
    };
  }
  const modelUnification = raw.modelUnification ?? false;
  if (modelUnification && (!raw.enableFIM || !raw.enableNES)) {
    return {
      ok: false,
      error: t(
        'Copilot Replica model unification requires both FIM and NES.',
      ),
    };
  }
  if (modelUnification && !unifiedModel) {
    return {
      ok: false,
      error: t('Copilot Replica model unification requires unifiedModel.'),
    };
  }
  if (!modelUnification && raw.enableFIM && !fimModel) {
    return {
      ok: false,
      error: t('Copilot Replica FIM requires fimModel.'),
    };
  }
  if (!modelUnification && raw.enableNES && !nesModel) {
    return {
      ok: false,
      error: t('Copilot Replica NES requires nesModel.'),
    };
  }
  if (
    raw.cursorPredictionModel !== undefined &&
    !configuredCursorPredictionModel
  ) {
    return {
      ok: false,
      error: t(
        'Copilot Replica cursorPredictionModel must contain vendor and id.',
      ),
    };
  }
  const nesRuntimeModel = modelUnification ? unifiedModel : nesModel;
  const cursorPredictionModel =
    raw.enableNES && nesRuntimeModel
      ? (configuredCursorPredictionModel ?? { ...nesRuntimeModel })
      : undefined;
  if (raw.strategy !== undefined && !isStrategy(raw.strategy)) {
    return {
      ok: false,
      error: t('Copilot Replica strategy is invalid.'),
    };
  }
  if (raw.eagerness !== undefined && !isAggressivenessSetting(raw.eagerness)) {
    return {
      ok: false,
      error: t('Copilot Replica eagerness is invalid.'),
    };
  }
  const enabledLanguages =
    raw.enabledLanguages === undefined
      ? undefined
      : normalizeEnabledLanguages(raw.enabledLanguages);
  if (raw.enabledLanguages !== undefined && !enabledLanguages) {
    return {
      ok: false,
      error: t(
        'Copilot Replica enabledLanguages must map language IDs to booleans.',
      ),
    };
  }
  const inlineEditsEnabledLanguages =
    raw.inlineEditsEnabledLanguages === undefined
      ? undefined
      : normalizeEnabledLanguages(raw.inlineEditsEnabledLanguages);
  if (
    raw.inlineEditsEnabledLanguages !== undefined &&
    !inlineEditsEnabledLanguages
  ) {
    return {
      ok: false,
      error: t(
        'Copilot Replica inlineEditsEnabledLanguages must map language IDs to booleans.',
      ),
    };
  }
  if (
    raw.respectSelectedCompletionInfo !== undefined &&
    typeof raw.respectSelectedCompletionInfo !== 'boolean'
  ) {
    return {
      ok: false,
      error: t(
        'Copilot Replica respectSelectedCompletionInfo must be boolean.',
      ),
    };
  }
  if (
    raw.includeInlineCompletions !== undefined &&
    typeof raw.includeInlineCompletions !== 'boolean'
  ) {
    return {
      ok: false,
      error: t('Copilot Replica includeInlineCompletions must be boolean.'),
    };
  }
  if (
    raw.includeInlineEdits !== undefined &&
    typeof raw.includeInlineEdits !== 'boolean'
  ) {
    return {
      ok: false,
      error: t('Copilot Replica includeInlineEdits must be boolean.'),
    };
  }
  if (
    raw.enableNES &&
    raw.includeInlineCompletions === false &&
    raw.includeInlineEdits === false
  ) {
    return {
      ok: false,
      error: t(
        'Copilot Replica NES must include inline completions, inline edits, or both.',
      ),
    };
  }

  return {
    ok: true,
    value: {
      enableFIM: raw.enableFIM,
      enableNES: raw.enableNES,
      n,
      ...(raw.modelUnification === undefined
        ? {}
        : { modelUnification }),
      ...(modelUnification
        ? { strategy: 'xtabUnifiedModel' as const }
        : raw.strategy === undefined
          ? {}
          : { strategy: raw.strategy }),
      ...(raw.eagerness === undefined ? {} : { eagerness: raw.eagerness }),
      ...(enabledLanguages === undefined ? {} : { enabledLanguages }),
      ...(inlineEditsEnabledLanguages === undefined
        ? {}
        : { inlineEditsEnabledLanguages }),
      ...(raw.respectSelectedCompletionInfo === undefined
        ? {}
        : {
            respectSelectedCompletionInfo: raw.respectSelectedCompletionInfo,
          }),
      ...(raw.includeInlineCompletions === undefined
        ? {}
        : { includeInlineCompletions: raw.includeInlineCompletions }),
      ...(raw.includeInlineEdits === undefined
        ? {}
        : { includeInlineEdits: raw.includeInlineEdits }),
      ...(!modelUnification && fimModel ? { fimModel } : {}),
      ...(!modelUnification && nesModel ? { nesModel } : {}),
      ...(modelUnification && unifiedModel ? { unifiedModel } : {}),
      ...(cursorPredictionModel === undefined ? {} : { cursorPredictionModel }),
    },
  };
}
