import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/i18n", () => ({
  t: (message: string) => message,
}));

vi.mock("../../src/completion/copilot/runtime", () => ({
  CopilotRuntime: class {},
}));

import { copilotReplicaAlgorithmDefinition } from "../../src/completion/copilot/algorithm";
import { normalizeCopilotReplicaAlgorithmOptions } from "../../src/completion/copilot/options";

describe("Copilot Replica algorithm options", () => {
  it("normalizes independent FIM/NES model references", () => {
    expect(
      normalizeCopilotReplicaAlgorithmOptions({
        enableFIM: true,
        enableNES: true,
        n: 4,
        strategy: "xtabUnifiedModel",
        eagerness: "high",
        enabledLanguages: { "*": true, plaintext: false },
        inlineEditsEnabledLanguages: { "*": false, typescript: true },
        respectSelectedCompletionInfo: false,
        includeInlineCompletions: true,
        includeInlineEdits: false,
        fimModel: { vendor: " fim-vendor ", id: " fim-id " },
        nesModel: { vendor: "nes-vendor", id: "nes-id" },
        cursorPredictionModel: {
          vendor: " cursor-vendor ",
          id: " cursor-id ",
        },
      }),
    ).toEqual({
      ok: true,
      value: {
        enableFIM: true,
        enableNES: true,
        n: 4,
        strategy: "xtabUnifiedModel",
        eagerness: "high",
        enabledLanguages: { "*": true, plaintext: false },
        inlineEditsEnabledLanguages: { "*": false, typescript: true },
        respectSelectedCompletionInfo: false,
        includeInlineCompletions: true,
        includeInlineEdits: false,
        fimModel: { vendor: "fim-vendor", id: "fim-id" },
        nesModel: { vendor: "nes-vendor", id: "nes-id" },
        cursorPredictionModel: {
          vendor: "cursor-vendor",
          id: "cursor-id",
        },
      },
    });
  });

  it("normalizes a unified model without requiring independent models", () => {
    expect(
      normalizeCopilotReplicaAlgorithmOptions({
        enableFIM: true,
        enableNES: true,
        modelUnification: true,
        unifiedModel: { vendor: " unified-vendor ", id: " unified-id " },
        strategy: "xtab275EditIntent",
        eagerness: "medium",
      }),
    ).toEqual({
      ok: true,
      value: {
        enableFIM: true,
        enableNES: true,
        n: 1,
        modelUnification: true,
        strategy: "xtabUnifiedModel",
        eagerness: "medium",
        unifiedModel: {
          vendor: "unified-vendor",
          id: "unified-id",
        },
        cursorPredictionModel: {
          vendor: "unified-vendor",
          id: "unified-id",
        },
      },
    });
  });

  it.each([
    {
      name: "missing unified model",
      options: {
        enableFIM: true,
        enableNES: true,
        modelUnification: true,
      },
      error: "Copilot Replica model unification requires unifiedModel.",
    },
    {
      name: "FIM-only unified mode",
      options: {
        enableFIM: true,
        enableNES: false,
        modelUnification: true,
        unifiedModel: { vendor: "test", id: "unified" },
      },
      error: "Copilot Replica model unification requires both FIM and NES.",
    },
    {
      name: "NES-only unified mode",
      options: {
        enableFIM: false,
        enableNES: true,
        modelUnification: true,
        unifiedModel: { vendor: "test", id: "unified" },
      },
      error: "Copilot Replica model unification requires both FIM and NES.",
    },
    {
      name: "independent mode missing FIM model",
      options: {
        enableFIM: true,
        enableNES: true,
        modelUnification: false,
        nesModel: { vendor: "test", id: "nes" },
      },
      error: "Copilot Replica FIM requires fimModel.",
    },
    {
      name: "independent mode missing NES model",
      options: {
        enableFIM: true,
        enableNES: true,
        modelUnification: false,
        fimModel: { vendor: "test", id: "fim" },
      },
      error: "Copilot Replica NES requires nesModel.",
    },
  ])("rejects $name", ({ options, error }) => {
    expect(normalizeCopilotReplicaAlgorithmOptions(options)).toEqual({
      ok: false,
      error,
    });
  });

  it("defaults cursor prediction to the active NES model", () => {
    expect(
      normalizeCopilotReplicaAlgorithmOptions({
        enableFIM: false,
        enableNES: true,
        nesModel: { vendor: "custom-vendor", id: "nes" },
      }),
    ).toMatchObject({
      ok: true,
      value: {
        n: 1,
        cursorPredictionModel: {
          vendor: "custom-vendor",
          id: "nes",
        },
      },
    });
  });

  it("rejects disabled or unresolved model paths", () => {
    expect(
      normalizeCopilotReplicaAlgorithmOptions({
        enableFIM: false,
        enableNES: false,
      }),
    ).toMatchObject({ ok: false });
    expect(
      normalizeCopilotReplicaAlgorithmOptions({
        enableFIM: true,
        enableNES: false,
        fimModel: { vendor: "test", id: "fim" },
        n: 0,
      }),
    ).toEqual({
      ok: false,
      error: "Copilot Replica n must be a positive integer.",
    });
    expect(
      normalizeCopilotReplicaAlgorithmOptions({
        enableFIM: true,
        enableNES: false,
        fimModel: { vendor: "test", id: "fim" },
        n: 1.5,
      }),
    ).toEqual({
      ok: false,
      error: "Copilot Replica n must be a positive integer.",
    });
    for (const n of [-1, "2", null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        normalizeCopilotReplicaAlgorithmOptions({
          enableFIM: true,
          enableNES: false,
          fimModel: { vendor: "test", id: "fim" },
          n,
        }),
      ).toEqual({
        ok: false,
        error: "Copilot Replica n must be a positive integer.",
      });
    }
    expect(
      normalizeCopilotReplicaAlgorithmOptions({
        enableFIM: false,
        enableNES: true,
      }),
    ).toEqual({
      ok: false,
      error: "Copilot Replica NES requires nesModel.",
    });
    expect(
      normalizeCopilotReplicaAlgorithmOptions({
        enableFIM: false,
        enableNES: true,
        nesModel: { vendor: "test", id: "nes" },
        includeInlineCompletions: false,
        includeInlineEdits: false,
      }),
    ).toMatchObject({ ok: false });
    expect(
      normalizeCopilotReplicaAlgorithmOptions({
        enableFIM: true,
        enableNES: false,
        fimModel: { vendor: "test", id: "fim" },
        enabledLanguages: { typescript: "yes" },
      }),
    ).toMatchObject({ ok: false });
    expect(
      normalizeCopilotReplicaAlgorithmOptions({
        enableFIM: false,
        enableNES: true,
        nesModel: { vendor: "test", id: "nes" },
        inlineEditsEnabledLanguages: { typescript: "yes" },
      }),
    ).toMatchObject({ ok: false });
    expect(
      normalizeCopilotReplicaAlgorithmOptions({
        enableFIM: false,
        enableNES: true,
        nesModel: { vendor: "test", id: "nes" },
        cursorPredictionModel: { vendor: "test" },
      }),
    ).toMatchObject({ ok: false });
    expect(
      normalizeCopilotReplicaAlgorithmOptions({
        enableFIM: false,
        enableNES: true,
        nesModel: { vendor: "test", id: "nes" },
        eagerness: "maximum",
      }),
    ).toEqual({
      ok: false,
      error: "Copilot Replica eagerness is invalid.",
    });
  });

  it.each([
    "xtabAggressiveness",
    "xtab275Aggressiveness",
    "xtab275AggressivenessHighLow",
    "xtab275EditIntent",
    "xtab275EditIntentShort",
  ] as const)("accepts official adaptive strategy %s", (strategy) => {
    expect(
      normalizeCopilotReplicaAlgorithmOptions({
        enableFIM: false,
        enableNES: true,
        nesModel: { vendor: "test", id: "nes" },
        strategy,
      }),
    ).toMatchObject({ ok: true, value: { strategy } });
  });

  it("reports only the active unified model and cursor predictor references", () => {
    expect(
      copilotReplicaAlgorithmDefinition.getModelReferences?.({
        enableFIM: true,
        enableNES: true,
        modelUnification: true,
        unifiedModel: { vendor: "test", id: "unified" },
        fimModel: { vendor: "test", id: "unused-fim" },
        nesModel: { vendor: "test", id: "unused-nes" },
      }),
    ).toEqual([{ vendor: "test", id: "unified" }]);
  });

  it("reports both independent models and their cursor predictor reference", () => {
    expect(
      copilotReplicaAlgorithmDefinition.getModelReferences?.({
        enableFIM: true,
        enableNES: true,
        modelUnification: false,
        fimModel: { vendor: "fim-vendor", id: "fim" },
        nesModel: { vendor: "nes-vendor", id: "nes" },
      }),
    ).toEqual([
      { vendor: "fim-vendor", id: "fim" },
      { vendor: "nes-vendor", id: "nes" },
    ]);
  });

  it("reports an explicit cursor prediction model as a separate reference", () => {
    expect(
      copilotReplicaAlgorithmDefinition.getModelReferences?.({
        enableFIM: false,
        enableNES: true,
        nesModel: { vendor: "test", id: "nes" },
        cursorPredictionModel: { vendor: "test", id: "cursor" },
      }),
    ).toEqual([
      { vendor: "test", id: "nes" },
      { vendor: "test", id: "cursor" },
    ]);
  });
});
