import { describe, expect, it } from "vitest";
import {
  COPILOT_BEHAVIOR_CONFIG,
  validateCopilotBehaviorConfig,
} from "../../src/chat-lib/core/behavior-config";

function cloneConfig(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(COPILOT_BEHAVIOR_CONFIG)) as Record<
    string,
    unknown
  >;
}

function recordAt(
  root: Record<string, unknown>,
  path: readonly string[],
): Record<string, unknown> {
  let current = root;
  for (const key of path) {
    const next = current[key];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      throw new Error(`Expected ${[...path, key].join(".")} to be a record.`);
    }
    current = next as Record<string, unknown>;
  }
  return current;
}

function setPath(
  root: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): void {
  recordAt(root, path.slice(0, -1))[path[path.length - 1]] = value;
}

const numericPaths: readonly (readonly string[])[] = [
  ...[
    "currentFileTokens",
    "recentFileTokens",
    "recentFileCount",
    "diffHistoryTokens",
    "diffHistoryEntries",
    "languageContextTokens",
    "neighborFileTokens",
    "pageSize",
    "linesAboveEditWindow",
    "linesBelowEditWindow",
    "surroundingLines",
    "editWindowTokens",
    "hardCharacterLimit",
  ].map((key) => ["prompt", key]),
  ...[
    "recentChangeMs",
    "sameLineCooldownMs",
    "rejectionCooldownMs",
    "selectionDebounceMs",
    "immediateSelectionChanges",
    "documentSwitchMs",
  ].map((key) => ["trigger", key]),
  ...[
    "requestDebounceMs",
    "extraDebounceEndOfLineMs",
    "extraDebounceInlineSuggestionMs",
    "aggressivenessLowMinResponseTimeMs",
    "aggressivenessMediumMinResponseTimeMs",
    "aggressivenessHighDebounceMs",
    "cacheDelayMs",
    "rebasedCacheDelayMs",
    "subsequentCacheDelayMs",
    "speculativeCacheDelayMs",
    "maxCacheEntries",
    "diagnosticsStartDelayMs",
    "diagnosticsRaceDeadlineMs",
    "maxImperfectAgreementLength",
    "autoExpandEditWindowLines",
    "triggerOnEditorChangeAfterSeconds",
  ].map((key) => ["nextEdit", key]),
  ["nextEdit", "cursorPrediction", "currentFileMaxTokens"],
  ["nextEdit", "cursorPrediction", "maxResponseTokens"],
  ["joint", "nesCacheWaitMs"],
];

const booleanPaths: readonly (readonly string[])[] = [
  ["diagnosticsContextProvider", "enabled"],
  ...[
    "currentFileIncludeCursorTag",
    "currentFilePrioritizeAboveCursor",
    "currentFileUseLeftoverBudgetFromAbove",
    "recentFilesIncludeViewed",
    "recentFilesUseLeftoverBudgetFromAbove",
    "diffHistoryOnlyForDocumentsInPrompt",
    "diffHistoryUseRelativePaths",
    "languageContextEnabled",
    "neighborFilesEnabled",
    "includePostScript",
  ].map((key) => ["prompt", key]),
  ["trigger", "documentSwitchRequiresAcceptance"],
  ...[
    "backoffDebounceEnabled",
    "debounceUseCoreRequestTime",
    "ignoreWhenSuggestVisible",
    "inlineCompletionsAdvanced",
    "mimicGhostTextBehavior",
    "useAlternativeNotebookFormat",
    "javaImportDiagnostics",
    "usePrediction",
    "allowWhitespaceOnlyChanges",
    "absorbSubsequenceTyping",
    "reverseAgreement",
    "cacheCursorDistanceCheck",
    "asyncCompletions",
  ].map((key) => ["nextEdit", key]),
  ["joint", "enabled"],
  ["joint", "suppressChangeWhileFimInFlight"],
  ["prompt", "currentFileIncludeTags", "copilotNesXtab"],
  ["prompt", "currentFileIncludeTags", "xtab275"],
  ["prompt", "currentFileIncludeTags", "xtabUnifiedModel"],
  ["prompt", "currentFileIncludeTags", "xtabAggressiveness"],
  ["prompt", "currentFileIncludeTags", "xtab275Aggressiveness"],
  ["prompt", "currentFileIncludeTags", "xtab275AggressivenessHighLow"],
  ["prompt", "currentFileIncludeTags", "xtab275EditIntent"],
  ["prompt", "currentFileIncludeTags", "xtab275EditIntentShort"],
];

describe("Copilot behavior config validation", () => {
  it("accepts the fixed production treatment", () => {
    expect(COPILOT_BEHAVIOR_CONFIG.fim.defaultDiagnostics).toBeNull();
    expect(COPILOT_BEHAVIOR_CONFIG.diagnosticsContextProvider).toEqual({
      enabled: false,
      enabledLanguages: {},
    });
    expect(COPILOT_BEHAVIOR_CONFIG.nextEdit).toMatchObject({
      requestDebounceMs: 100,
      backoffDebounceEnabled: true,
      debounceUseCoreRequestTime: false,
      extraDebounceEndOfLineMs: 2_000,
      extraDebounceInlineSuggestionMs: 0,
      defaultAggressivenessSetting: "auto",
      configuredAggressivenessLevel: null,
      aggressivenessLowMinResponseTimeMs: 1_500,
      aggressivenessMediumMinResponseTimeMs: 700,
      aggressivenessHighDebounceMs: 0,
      userHappinessScore: {
        acceptedScore: 1,
        rejectedScore: 0,
        ignoredScore: 0.5,
        highThreshold: 0.7,
        mediumThreshold: 0.4,
        includeIgnored: false,
        ignoredLimit: 0,
        limitConsecutiveIgnored: false,
        limitTotalIgnored: true,
      },
    });
    expect(COPILOT_BEHAVIOR_CONFIG.joint).toMatchObject({
      enabled: false,
      strategy: "regular",
    });
    expect(() =>
      validateCopilotBehaviorConfig(COPILOT_BEHAVIOR_CONFIG),
    ).not.toThrow();
  });

  it("rejects every missing required field in each section and nested strategy", () => {
    const valid = cloneConfig();
    for (const section of [
      "fim",
      "diagnosticsContextProvider",
      "prompt",
      "trigger",
      "nextEdit",
      "joint",
    ]) {
      for (const key of Object.keys(recordAt(valid, [section]))) {
        const candidate = cloneConfig();
        delete recordAt(candidate, [section])[key];
        expect(
          () => validateCopilotBehaviorConfig(candidate),
          `${section}.${key}`,
        ).toThrow();
      }
    }
    for (const path of [
      ["prompt", "currentFileIncludeTags", "copilotNesXtab"],
      ["prompt", "currentFileIncludeTags", "xtab275"],
      ["prompt", "currentFileIncludeTags", "xtabUnifiedModel"],
      ["prompt", "currentFileIncludeTags", "xtabAggressiveness"],
      ["prompt", "currentFileIncludeTags", "xtab275Aggressiveness"],
      ["prompt", "currentFileIncludeTags", "xtab275AggressivenessHighLow"],
      ["prompt", "currentFileIncludeTags", "xtab275EditIntent"],
      ["prompt", "currentFileIncludeTags", "xtab275EditIntentShort"],
      ["prompt", "languageContextEnabledLanguages", "prompt"],
      ["prompt", "languageContextEnabledLanguages", "instructions"],
      ["prompt", "languageContextEnabledLanguages", "chatagent"],
      ["nextEdit", "cursorPrediction", "mode"],
      ["nextEdit", "cursorPrediction", "currentFileMaxTokens"],
      ["nextEdit", "cursorPrediction", "maxResponseTokens"],
      ["nextEdit", "userHappinessScore", "acceptedScore"],
      ["nextEdit", "userHappinessScore", "rejectedScore"],
      ["nextEdit", "userHappinessScore", "ignoredScore"],
      ["nextEdit", "userHappinessScore", "highThreshold"],
      ["nextEdit", "userHappinessScore", "mediumThreshold"],
      ["nextEdit", "userHappinessScore", "includeIgnored"],
      ["nextEdit", "userHappinessScore", "ignoredLimit"],
      ["nextEdit", "userHappinessScore", "limitConsecutiveIgnored"],
      ["nextEdit", "userHappinessScore", "limitTotalIgnored"],
    ] as const) {
      const candidate = cloneConfig();
      delete recordAt(candidate, path.slice(0, -1))[path[path.length - 1]];
      expect(
        () => validateCopilotBehaviorConfig(candidate),
        path.join("."),
      ).toThrow();
    }
  });

  it.each(numericPaths)("rejects invalid numeric field %s", (...path) => {
    const candidate = cloneConfig();
    setPath(candidate, path, -1);
    expect(() => validateCopilotBehaviorConfig(candidate)).toThrow();
  });

  it.each(booleanPaths)("rejects invalid boolean field %s", (...path) => {
    const candidate = cloneConfig();
    setPath(candidate, path, "true");
    expect(() => validateCopilotBehaviorConfig(candidate)).toThrow();
  });

  it("rejects invalid enums, arrays, and language records", () => {
    for (const path of [
      ["prompt", "currentFileLineNumbers"],
      ["prompt", "recentFilesLineNumbers"],
      ["prompt", "recentFilesClippingStrategy"],
      ["prompt", "languageContextTraitPosition"],
      ["nextEdit", "undoInsertionFiltering"],
      ["nextEdit", "earlyDivergenceCancellation"],
      ["nextEdit", "speculativeRequests"],
      ["nextEdit", "speculativeRequestsCursorPlacement"],
      ["nextEdit", "speculativeRequestsAutoExpandEditWindowLines"],
      ["nextEdit", "cursorPrediction", "mode"],
      ["nextEdit", "defaultAggressivenessSetting"],
      ["nextEdit", "configuredAggressivenessLevel"],
    ] as const) {
      const candidate = cloneConfig();
      setPath(candidate, path, "invalid");
      expect(
        () => validateCopilotBehaviorConfig(candidate),
        path.join("."),
      ).toThrow();
    }
    const badSubstrings = cloneConfig();
    setPath(badSubstrings, ["nextEdit", "filterSubstrings"], ["ok", 1]);
    expect(() => validateCopilotBehaviorConfig(badSubstrings)).toThrow();
    const badLanguages = cloneConfig();
    setPath(badLanguages, ["prompt", "languageContextEnabledLanguages"], {
      typescript: "yes",
    });
    expect(() => validateCopilotBehaviorConfig(badLanguages)).toThrow();
    const badDiagnosticsLanguages = cloneConfig();
    setPath(
      badDiagnosticsLanguages,
      ["diagnosticsContextProvider", "enabledLanguages"],
      { typescript: "yes" },
    );
    expect(() =>
      validateCopilotBehaviorConfig(badDiagnosticsLanguages),
    ).toThrow();
    for (const strategy of [
      "copilotNesXtab",
      "xtab275",
      "xtabUnifiedModel",
      "xtabAggressiveness",
      "xtab275Aggressiveness",
      "xtab275AggressivenessHighLow",
      "xtab275EditIntent",
      "xtab275EditIntentShort",
    ]) {
      const missing = cloneConfig();
      delete recordAt(missing, ["nextEdit", "responseFormatByStrategy"])[
        strategy
      ];
      expect(() => validateCopilotBehaviorConfig(missing), strategy).toThrow();
      const invalid = cloneConfig();
      setPath(
        invalid,
        ["nextEdit", "responseFormatByStrategy", strategy],
        "invalid",
      );
      expect(() => validateCopilotBehaviorConfig(invalid), strategy).toThrow();
    }
  });

  it("rejects invalid happiness relationships", () => {
    for (const mutate of [
      (candidate: Record<string, unknown>) =>
        setPath(
          candidate,
          ["nextEdit", "userHappinessScore", "acceptedScore"],
          0,
        ),
      (candidate: Record<string, unknown>) =>
        setPath(
          candidate,
          ["nextEdit", "userHappinessScore", "ignoredScore"],
          2,
        ),
      (candidate: Record<string, unknown>) =>
        setPath(
          candidate,
          ["nextEdit", "userHappinessScore", "mediumThreshold"],
          0.8,
        ),
    ]) {
      const candidate = cloneConfig();
      mutate(candidate);
      expect(() => validateCopilotBehaviorConfig(candidate)).toThrow();
    }
  });

  it("pins production-only notebook and Java treatments", () => {
    for (const key of [
      "useAlternativeNotebookFormat",
      "javaImportDiagnostics",
    ]) {
      const candidate = cloneConfig();
      setPath(candidate, ["nextEdit", key], true);
      expect(() => validateCopilotBehaviorConfig(candidate), key).toThrow();
    }
  });

  it("fully validates optional lint and global-budget records", () => {
    const valid = cloneConfig();
    setPath(valid, ["prompt", "lintOptions"], {
      tagName: "lint",
      warnings: "yesIfNoErrors",
      showCode: "yesWithSurroundingLines",
      maxLints: 3,
      maxLineDistance: 20,
      nRecentFiles: 2,
    });
    setPath(valid, ["prompt", "globalBudget"], {
      totalTokens: 8_000,
      order: [
        "recentlyViewedDocuments",
        "languageContext",
        "neighborFiles",
        "diffHistory",
      ],
      shares: {
        currentFile: 0.2,
        recentlyViewedDocuments: 0.2,
        languageContext: 0.2,
        neighborFiles: 0.2,
        diffHistory: 0.2,
      },
    });
    expect(() => validateCopilotBehaviorConfig(valid)).not.toThrow();

    for (const mutate of [
      (candidate: Record<string, unknown>) =>
        setPath(candidate, ["prompt", "lintOptions", "warnings"], "sometimes"),
      (candidate: Record<string, unknown>) =>
        setPath(candidate, ["prompt", "lintOptions", "maxLints"], -1),
      (candidate: Record<string, unknown>) =>
        setPath(
          candidate,
          ["prompt", "globalBudget", "order"],
          ["neighborFiles", "recentlyViewedDocuments"],
        ),
      (candidate: Record<string, unknown>) =>
        setPath(candidate, ["prompt", "globalBudget", "order"], ["badPart"]),
      (candidate: Record<string, unknown>) =>
        setPath(
          candidate,
          ["prompt", "globalBudget", "shares", "currentFile"],
          0.9,
        ),
    ]) {
      const candidate = JSON.parse(JSON.stringify(valid)) as Record<
        string,
        unknown
      >;
      mutate(candidate);
      expect(() => validateCopilotBehaviorConfig(candidate)).toThrow();
    }
  });

  it("validates an explicit FIM default-diagnostics treatment", () => {
    const valid = cloneConfig();
    setPath(valid, ["fim", "defaultDiagnostics"], {
      warnings: "yesIfNoErrors",
      maxLineDistance: 10,
      maxDiagnostics: 5,
    });
    expect(() => validateCopilotBehaviorConfig(valid)).not.toThrow();

    for (const [key, value] of [
      ["warnings", "sometimes"],
      ["maxLineDistance", -1],
      ["maxDiagnostics", 0],
    ] as const) {
      const invalid = JSON.parse(JSON.stringify(valid)) as Record<
        string,
        unknown
      >;
      setPath(invalid, ["fim", "defaultDiagnostics", key], value);
      expect(() => validateCopilotBehaviorConfig(invalid), key).toThrow();
    }
  });
});
