import type {
  CompletionAlgorithm,
  CompletionAlgorithmDefinition,
  CompletionAlgorithmOptionsResult,
} from "../types";
import { t } from "../../i18n";
import {
  normalizeCopilotReplicaAlgorithmOptions,
  type CopilotReplicaAlgorithmOptions,
} from "./options";
import { CopilotRuntime } from "./runtime";

class InvalidCopilotReplicaAlgorithm implements CompletionAlgorithm {
  async provideInlineCompletions() {
    return undefined;
  }
}

export function copilotReplicaRuntimeIdentity(options: unknown): unknown {
  const normalized = normalizeCopilotReplicaAlgorithmOptions(options);
  if (!normalized.ok) {
    return options;
  }
  const { eagerness: _eagerness, ...identity } = normalized.value;
  return identity;
}

export const copilotReplicaAlgorithmDefinition: CompletionAlgorithmDefinition = {
  id: "copilot-replica",
  label: t("Copilot (Replica)"),
  description: t(
    "Official-compatible GhostText and next-edit completion runtime",
  ),
  getSettingsDetail(rawOptions) {
    const normalized = normalizeCopilotReplicaAlgorithmOptions(rawOptions);
    if (!normalized.ok) {
      return t("Invalid configuration: {0}", normalized.error);
    }
    if (normalized.value.modelUnification) {
      const unified = normalized.value.unifiedModel
        ? `${normalized.value.unifiedModel.vendor}/${normalized.value.unifiedModel.id}`
        : t("Not Set");
      return t("Unified FIM + NES: {0}", unified);
    }
    const fim = !normalized.value.enableFIM
      ? t("Disabled")
      : normalized.value.fimModel
        ? `${normalized.value.fimModel.vendor}/${normalized.value.fimModel.id}`
        : t("Not Set");
    const nes = !normalized.value.enableNES
      ? t("Disabled")
      : normalized.value.nesModel
        ? `${normalized.value.nesModel.vendor}/${normalized.value.nesModel.id}`
        : t("Not Set");
    return t("FIM: {0} | NES: {1}", fim, nes);
  },
  getModelReferences(options) {
    const normalized = normalizeCopilotReplicaAlgorithmOptions(options);
    if (!normalized.ok) {
      return [];
    }
    const references = [
      ...(normalized.value.fimModel ? [normalized.value.fimModel] : []),
      ...(normalized.value.nesModel ? [normalized.value.nesModel] : []),
      ...(normalized.value.unifiedModel
        ? [normalized.value.unifiedModel]
        : []),
      ...(normalized.value.cursorPredictionModel
        ? [normalized.value.cursorPredictionModel]
        : []),
    ];
    const seen = new Set<string>();
    return references.filter((reference) => {
      const key = `${reference.vendor}\0${reference.id}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  },
  getRuntimeIdentity: copilotReplicaRuntimeIdentity,
  normalizeOptions(raw): CompletionAlgorithmOptionsResult {
    return normalizeCopilotReplicaAlgorithmOptions(raw);
  },
  create(context): CompletionAlgorithm {
    const normalized = normalizeCopilotReplicaAlgorithmOptions(context.options);
    return normalized.ok
      ? new CopilotRuntime(
          context,
          normalized.value satisfies CopilotReplicaAlgorithmOptions,
        )
      : new InvalidCopilotReplicaAlgorithm();
  },
};
