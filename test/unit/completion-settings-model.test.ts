import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  env: { language: "en" },
  l10n: { t: (message: string) => message },
}));
import {
  buildCompletionAlgorithmEntry,
  buildCompletionStrategy,
  cloneCompletionAlgorithmEntry,
  createCompletionAlgorithmEntryDraft,
  createCompletionStrategyDraft,
  nextCompletionAlgorithmEntryCloneId,
  updateStrategyForRemovedEntry,
  updateStrategyForRenamedEntry,
} from "../../src/completion/settings-model";
import { DEFAULT_COMPLETION_DISABLED_GLOBS } from "../../src/completion/disabled-globs";
import type {
  CompletionModelReference,
  CompletionAlgorithmEntry,
  CompletionStrategy,
} from "../../src/completion/types";

const simpleModel: CompletionModelReference = {
  vendor: "test",
  id: "simple-model",
};
const fimModel: CompletionModelReference = {
  vendor: "test",
  id: "fim-model",
};
const nesModel: CompletionModelReference = {
  vendor: "test",
  id: "nes-model",
};
const unifiedModel: CompletionModelReference = {
  vendor: "test",
  id: "unified-model",
};
const cursorPredictionModel: CompletionModelReference = {
  vendor: "test",
  id: "cursor-model",
};

function entry(id: string): CompletionAlgorithmEntry {
  return {
    id,
    algorithm: "simple",
    options: { model: simpleModel },
  };
}

describe("completion settings model algorithm entry drafts", () => {
  it("starts a new entry without selecting an algorithm", () => {
    const draft = createCompletionAlgorithmEntryDraft();

    expect(draft).toMatchObject({
      id: "",
      algorithm: undefined,
      simple: {},
      copilotReplica: {
        enableFIM: true,
        enableNES: false,
        n: 1,
        strategy: "copilotNesXtab",
        eagerness: "auto",
        modelUnification: false,
      },
    });
    expect(buildCompletionAlgorithmEntry(draft, [])).toEqual({
      ok: false,
      error: "entryIdRequired",
    });

    draft.id = "new-entry";
    expect(buildCompletionAlgorithmEntry(draft, [])).toEqual({
      ok: false,
      error: "algorithmRequired",
    });
  });

  it("keeps independent Simple and Copilot Replica drafts while switching algorithms", () => {
    const draft = createCompletionAlgorithmEntryDraft();
    draft.id = "switchable";
    draft.simple.model = simpleModel;
    draft.copilotReplica.enableFIM = true;
    draft.copilotReplica.enableNES = true;
    draft.copilotReplica.n = 4;
    draft.copilotReplica.fimModel = fimModel;
    draft.copilotReplica.nesModel = nesModel;
    draft.copilotReplica.unifiedModel = unifiedModel;
    draft.copilotReplica.strategy = "xtabUnifiedModel";
    draft.copilotReplica.eagerness = "high";
    draft.copilotReplica.modelUnification = true;

    draft.algorithm = "simple";
    expect(buildCompletionAlgorithmEntry(draft, [])).toEqual({
      ok: true,
      entry: {
        id: "switchable",
        algorithm: "simple",
        options: { model: simpleModel },
      },
    });

    draft.algorithm = "copilot-replica";
    expect(buildCompletionAlgorithmEntry(draft, [])).toEqual({
      ok: true,
      entry: {
        id: "switchable",
        algorithm: "copilot-replica",
        options: {
          enableFIM: true,
          enableNES: true,
          unifiedModel,
          eagerness: "high",
          modelUnification: true,
        },
      },
    });

    draft.algorithm = "simple";
    expect(buildCompletionAlgorithmEntry(draft, [])).toMatchObject({
      ok: true,
      entry: { algorithm: "simple", options: { model: simpleModel } },
    });
  });

  it("retains disabled Copilot Replica mode drafts but omits them from saved options", () => {
    const draft = createCompletionAlgorithmEntryDraft({
      id: "copilot-replica",
      algorithm: "copilot-replica",
      options: {
        enableFIM: true,
        enableNES: true,
        n: 5,
        fimModel,
        nesModel,
        strategy: "xtab275EditIntent",
        eagerness: "medium",
        modelUnification: false,
      },
    });
    draft.copilotReplica.modelUnification = true;

    draft.copilotReplica.enableFIM = false;
    const nesOnly = buildCompletionAlgorithmEntry(draft, []);
    expect(nesOnly).toMatchObject({
      ok: true,
      entry: {
        algorithm: "copilot-replica",
        options: {
          enableFIM: false,
          enableNES: true,
          nesModel,
          strategy: "xtab275EditIntent",
          eagerness: "medium",
        },
      },
    });
    if (nesOnly.ok) {
      expect(nesOnly.entry.options).not.toHaveProperty("fimModel");
      expect(nesOnly.entry.options).not.toHaveProperty("n");
      expect(nesOnly.entry.options).not.toHaveProperty("modelUnification");
    }
    expect(draft.copilotReplica.fimModel).toEqual(fimModel);
    expect(draft.copilotReplica.n).toBe(5);

    draft.copilotReplica.enableFIM = true;
    draft.copilotReplica.enableNES = false;
    const fimOnly = buildCompletionAlgorithmEntry(draft, []);
    expect(fimOnly).toMatchObject({
      ok: true,
      entry: {
        algorithm: "copilot-replica",
        options: {
          enableFIM: true,
          enableNES: false,
          fimModel,
          n: 5,
        },
      },
    });
    if (fimOnly.ok) {
      expect(fimOnly.entry.options).not.toHaveProperty("nesModel");
      expect(fimOnly.entry.options).not.toHaveProperty("strategy");
      expect(fimOnly.entry.options).not.toHaveProperty("eagerness");
      expect(fimOnly.entry.options).not.toHaveProperty("modelUnification");
    }
    expect(draft.copilotReplica.nesModel).toEqual(nesModel);
    expect(draft.copilotReplica.strategy).toBe("xtab275EditIntent");
    expect(draft.copilotReplica.eagerness).toBe("medium");
    expect(draft.copilotReplica.modelUnification).toBe(true);
  });

  it("saves one unified model and omits independent-only fields", () => {
    const draft = createCompletionAlgorithmEntryDraft();
    draft.id = "unified";
    draft.algorithm = "copilot-replica";
    draft.copilotReplica.enableFIM = true;
    draft.copilotReplica.enableNES = true;
    draft.copilotReplica.modelUnification = true;
    draft.copilotReplica.unifiedModel = unifiedModel;
    draft.copilotReplica.fimModel = fimModel;
    draft.copilotReplica.nesModel = nesModel;
    draft.copilotReplica.n = 7;
    draft.copilotReplica.strategy = "xtab275EditIntent";
    draft.copilotReplica.eagerness = "medium";

    const result = buildCompletionAlgorithmEntry(draft, []);
    expect(result).toEqual({
      ok: true,
      entry: {
        id: "unified",
        algorithm: "copilot-replica",
        options: {
          enableFIM: true,
          enableNES: true,
          unifiedModel,
          eagerness: "medium",
          modelUnification: true,
        },
      },
    });
    if (result.ok) {
      expect(result.entry.options).not.toHaveProperty("fimModel");
      expect(result.entry.options).not.toHaveProperty("nesModel");
      expect(result.entry.options).not.toHaveProperty("n");
      expect(result.entry.options).not.toHaveProperty("strategy");
    }
  });

  it("persists only an explicitly selected cursor prediction model", () => {
    const implicitDraft = createCompletionAlgorithmEntryDraft({
      id: "implicit-cursor",
      algorithm: "copilot-replica",
      options: {
        enableFIM: false,
        enableNES: true,
        nesModel,
      },
    });
    expect(implicitDraft.copilotReplica.cursorPredictionModel).toBeUndefined();
    const implicitResult = buildCompletionAlgorithmEntry(implicitDraft, []);
    expect(implicitResult).toMatchObject({ ok: true });
    if (implicitResult.ok) {
      expect(implicitResult.entry.options).not.toHaveProperty(
        "cursorPredictionModel",
      );
    }

    const explicitDraft = createCompletionAlgorithmEntryDraft({
      id: "explicit-cursor",
      algorithm: "copilot-replica",
      options: {
        enableFIM: false,
        enableNES: true,
        nesModel,
        cursorPredictionModel,
      },
    });
    expect(explicitDraft.copilotReplica.cursorPredictionModel).toEqual(
      cursorPredictionModel,
    );
    expect(buildCompletionAlgorithmEntry(explicitDraft, [])).toMatchObject({
      ok: true,
      entry: {
        options: { cursorPredictionModel },
      },
    });
  });

  it("requires unifiedModel only while both modes use model unification", () => {
    const draft = createCompletionAlgorithmEntryDraft();
    draft.id = "unified";
    draft.algorithm = "copilot-replica";
    draft.copilotReplica.enableFIM = true;
    draft.copilotReplica.enableNES = true;
    draft.copilotReplica.modelUnification = true;

    expect(buildCompletionAlgorithmEntry(draft, [])).toEqual({
      ok: false,
      error: "copilotReplicaUnifiedModelRequired",
    });

    draft.copilotReplica.unifiedModel = unifiedModel;
    expect(buildCompletionAlgorithmEntry(draft, [])).toMatchObject({
      ok: true,
      entry: { options: { unifiedModel, modelUnification: true } },
    });
  });

  it("defaults n to one and rejects invalid FIM candidate counts", () => {
    const draft = createCompletionAlgorithmEntryDraft();
    draft.id = "copilot-replica";
    draft.algorithm = "copilot-replica";
    draft.copilotReplica.fimModel = fimModel;

    expect(draft.copilotReplica.n).toBe(1);
    expect(buildCompletionAlgorithmEntry(draft, [])).toMatchObject({
      ok: true,
      entry: { options: { n: 1 } },
    });

    for (const invalid of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      draft.copilotReplica.n = invalid;
      expect(buildCompletionAlgorithmEntry(draft, [])).toEqual({
        ok: false,
        error: "copilotReplicaNInvalid",
      });
    }
  });

  it("keeps Zed, Inception, and Mistral options independent", () => {
    const draft = createCompletionAlgorithmEntryDraft();
    draft.id = "edit-predictor";
    expect(draft.zed.maxTokens).toBe(64);
    expect(draft.mistral.maxTokens).toBe(150);

    draft.zed.model = { vendor: "zed", id: "zeta" };
    draft.zed.maxTokens = 96;
    draft.inception.model = { vendor: "inception", id: "mercury" };
    draft.mistral.model = { vendor: "mistral", id: "codestral" };
    draft.mistral.maxTokens = 200;

    draft.algorithm = "zed";
    expect(buildCompletionAlgorithmEntry(draft, [])).toEqual({
      ok: true,
      entry: {
        id: "edit-predictor",
        algorithm: "zed",
        options: {
          model: { vendor: "zed", id: "zeta" },
          maxTokens: 96,
        },
      },
    });

    draft.algorithm = "inception";
    expect(buildCompletionAlgorithmEntry(draft, [])).toEqual({
      ok: true,
      entry: {
        id: "edit-predictor",
        algorithm: "inception",
        options: { model: { vendor: "inception", id: "mercury" } },
      },
    });

    draft.algorithm = "mistral";
    expect(buildCompletionAlgorithmEntry(draft, [])).toEqual({
      ok: true,
      entry: {
        id: "edit-predictor",
        algorithm: "mistral",
        options: {
          model: { vendor: "mistral", id: "codestral" },
          maxTokens: 200,
        },
      },
    });
  });

  it("validates required edit-prediction models and token limits", () => {
    const draft = createCompletionAlgorithmEntryDraft();
    draft.id = "invalid";

    draft.algorithm = "zed";
    expect(buildCompletionAlgorithmEntry(draft, [])).toEqual({
      ok: false,
      error: "zedModelRequired",
    });
    draft.zed.model = simpleModel;
    draft.zed.maxTokens = 0;
    expect(buildCompletionAlgorithmEntry(draft, [])).toEqual({
      ok: false,
      error: "zedMaxTokensInvalid",
    });

    draft.algorithm = "inception";
    expect(buildCompletionAlgorithmEntry(draft, [])).toEqual({
      ok: false,
      error: "inceptionModelRequired",
    });

    draft.algorithm = "mistral";
    expect(buildCompletionAlgorithmEntry(draft, [])).toEqual({
      ok: false,
      error: "mistralModelRequired",
    });
    draft.mistral.model = simpleModel;
    draft.mistral.maxTokens = Number.NaN;
    expect(buildCompletionAlgorithmEntry(draft, [])).toEqual({
      ok: false,
      error: "mistralMaxTokensInvalid",
    });
  });
});

describe("completion settings model algorithm entry operations", () => {
  it("allocates id-copy and then id-copy-2 for cloned entries", () => {
    const original = entry("id");
    expect(nextCompletionAlgorithmEntryCloneId(original.id, [original])).toBe(
      "id-copy",
    );

    const firstClone = cloneCompletionAlgorithmEntry(original, [original]);
    expect(firstClone).toEqual({
      id: "id-copy",
      algorithm: original.algorithm,
      options: original.options,
    });
    expect(firstClone.options).not.toBe(original.options);

    const secondClone = cloneCompletionAlgorithmEntry(original, [
      original,
      firstClone,
    ]);
    expect(secondClone.id).toBe("id-copy-2");
  });

  it("updates only matching main-provider references on rename and removal", () => {
    const strategy: CompletionStrategy = {
      mode: "main-first",
      disableVSCodeBuiltinCompletion: false,
      mainProvider: "primary",
      mainFirstTimeoutMs: 750,
      parallelRequestOthers: true,
      stopWhen: { type: "enoughResults", minItems: 2, graceMs: 25 },
    };

    expect(
      updateStrategyForRenamedEntry(strategy, "primary", "renamed"),
    ).toEqual({ ...strategy, mainProvider: "renamed" });
    expect(updateStrategyForRenamedEntry(strategy, "other", "renamed")).toBe(
      strategy,
    );

    const removed = updateStrategyForRemovedEntry(strategy, "primary");
    expect(removed).toEqual({
      mode: "all",
      disableVSCodeBuiltinCompletion: false,
      disabledGlobs: [...DEFAULT_COMPLETION_DISABLED_GLOBS],
      stopWhen: { type: "enoughResults", minItems: 2, graceMs: 25 },
    });
    expect(removed.stopWhen).not.toBe(strategy.stopWhen);
    expect(updateStrategyForRemovedEntry(strategy, "other")).toBe(strategy);
  });
});

describe("completion settings model strategy drafts", () => {
  it("preserves each stop-condition draft and builds only the active one", () => {
    const draft = createCompletionStrategyDraft({
      mode: "all",
      disableVSCodeBuiltinCompletion: false,
      stopWhen: { type: "firstUsable", graceMs: 7 },
    });
    draft.firstUsableGraceMs = 11;
    draft.deadlineTimeoutMs = 222;
    draft.enoughResultsMinItems = 3;
    draft.enoughResultsGraceMs = 33;

    draft.stopType = "firstUsable";
    expect(buildCompletionStrategy(draft, [])).toEqual({
      ok: true,
      strategy: {
        mode: "all",
        disableVSCodeBuiltinCompletion: false,
        disabledGlobs: [...DEFAULT_COMPLETION_DISABLED_GLOBS],
        stopWhen: { type: "firstUsable", graceMs: 11 },
      },
    });

    draft.stopType = "deadline";
    expect(buildCompletionStrategy(draft, [])).toEqual({
      ok: true,
      strategy: {
        mode: "all",
        disableVSCodeBuiltinCompletion: false,
        disabledGlobs: [...DEFAULT_COMPLETION_DISABLED_GLOBS],
        stopWhen: { type: "deadline", timeoutMs: 222 },
      },
    });

    draft.stopType = "enoughResults";
    expect(buildCompletionStrategy(draft, [])).toEqual({
      ok: true,
      strategy: {
        mode: "all",
        disableVSCodeBuiltinCompletion: false,
        disabledGlobs: [...DEFAULT_COMPLETION_DISABLED_GLOBS],
        stopWhen: { type: "enoughResults", minItems: 3, graceMs: 33 },
      },
    });

    draft.stopType = "allSettled";
    expect(buildCompletionStrategy(draft, [])).toEqual({
      ok: true,
      strategy: {
        mode: "all",
        disableVSCodeBuiltinCompletion: false,
        disabledGlobs: [...DEFAULT_COMPLETION_DISABLED_GLOBS],
        stopWhen: { type: "allSettled" },
      },
    });

    expect(draft).toMatchObject({
      firstUsableGraceMs: 11,
      deadlineTimeoutMs: 222,
      enoughResultsMinItems: 3,
      enoughResultsGraceMs: 33,
    });
  });

  it("defaults legacy strategy drafts to disabling VS Code built-in completion", () => {
    const draft = createCompletionStrategyDraft({
      mode: "all",
      stopWhen: { type: "allSettled" },
    });

    expect(draft.disableVSCodeBuiltinCompletion).toBe(true);
    expect(buildCompletionStrategy(draft, [])).toEqual({
      ok: true,
      strategy: {
        mode: "all",
        disableVSCodeBuiltinCompletion: true,
        disabledGlobs: [...DEFAULT_COMPLETION_DISABLED_GLOBS],
        stopWhen: { type: "allSettled" },
      },
    });
  });

  it("persists the built-in completion switch for main-first strategies", () => {
    const draft = createCompletionStrategyDraft({
      mode: "main-first",
      disableVSCodeBuiltinCompletion: false,
      mainProvider: "primary",
      mainFirstTimeoutMs: 250,
      parallelRequestOthers: true,
      stopWhen: { type: "allSettled" },
    });

    expect(
      buildCompletionStrategy(draft, [
        { id: "primary", algorithm: "simple" },
      ]),
    ).toEqual({
      ok: true,
      strategy: {
        mode: "main-first",
        disableVSCodeBuiltinCompletion: false,
        disabledGlobs: [...DEFAULT_COMPLETION_DISABLED_GLOBS],
        mainProvider: "primary",
        mainFirstTimeoutMs: 250,
        parallelRequestOthers: true,
        stopWhen: { type: "allSettled" },
      },
    });
  });
});
