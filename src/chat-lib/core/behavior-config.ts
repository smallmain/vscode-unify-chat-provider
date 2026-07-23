export const COPILOT_UPSTREAM_COMMIT =
  "fc3def6774c76082adf699d366f31a557ce5573f";

export type NesPromptStrategy =
  | "copilotNesXtab"
  | "xtab275"
  | "xtabUnifiedModel"
  | "xtabAggressiveness"
  | "xtab275Aggressiveness"
  | "xtab275AggressivenessHighLow"
  | "xtab275EditIntent"
  | "xtab275EditIntentShort";

export type NesAggressivenessSetting = "auto" | "low" | "medium" | "high";
export type NesAggressivenessLevel = Exclude<NesAggressivenessSetting, "auto">;
export type NesEditIntent = "no_edit" | "low" | "medium" | "high";
export type NesResponseFormat =
  | "codeBlock"
  | "editWindowOnly"
  | "unifiedXml"
  | "editWindowWithEditIntent"
  | "editWindowWithEditIntentShort";

export interface UserHappinessScoreConfig {
  readonly acceptedScore: number;
  readonly rejectedScore: number;
  readonly ignoredScore: number;
  readonly highThreshold: number;
  readonly mediumThreshold: number;
  readonly includeIgnored: boolean;
  readonly ignoredLimit: number;
  readonly limitConsecutiveIgnored: boolean;
  readonly limitTotalIgnored: boolean;
}

export type NesLineNumberStyle =
  "withSpaceAfter" | "withoutSpaceAfter" | "none";

export type NesGlobalBudgetPart =
  | "recentlyViewedDocuments"
  | "languageContext"
  | "neighborFiles"
  | "diffHistory";

export interface NesGlobalBudgetConfig {
  readonly totalTokens: number;
  readonly order: readonly NesGlobalBudgetPart[];
  readonly shares: Readonly<
    Record<NesGlobalBudgetPart | "currentFile", number>
  >;
}

export interface NesLintConfig {
  readonly tagName: string;
  readonly warnings: "yes" | "no" | "yesIfNoErrors";
  readonly showCode: "yes" | "no" | "yesWithSurroundingLines";
  readonly maxLints: number;
  readonly maxLineDistance: number;
  readonly nRecentFiles: number;
}

export interface FimDefaultDiagnosticsOptions {
  readonly warnings: "no" | "yes" | "yesIfNoErrors";
  readonly maxLineDistance: number;
  readonly maxDiagnostics: number;
}

export interface CopilotBehaviorConfig {
  readonly upstreamCommit: string;
  readonly fim: {
    /** Undefined at the pinned commit unless an experiment treatment enables it. */
    readonly defaultDiagnostics: FimDefaultDiagnosticsOptions | null;
  };
  readonly diagnosticsContextProvider: {
    readonly enabled: boolean;
    readonly enabledLanguages: Readonly<Record<string, boolean>>;
  };
  readonly prompt: {
    readonly currentFileTokens: number;
    readonly currentFileIncludeTags: Readonly<
      Record<NesPromptStrategy, boolean>
    >;
    readonly currentFileLineNumbers: NesLineNumberStyle;
    readonly currentFileIncludeCursorTag: boolean;
    readonly currentFilePrioritizeAboveCursor: boolean;
    readonly currentFileUseLeftoverBudgetFromAbove: boolean;
    readonly recentFileTokens: number;
    readonly recentFileCount: number;
    readonly recentFilesIncludeViewed: boolean;
    readonly recentFilesLineNumbers: NesLineNumberStyle;
    readonly recentFilesClippingStrategy: "aroundEditRange" | "proportional";
    readonly recentFilesUseLeftoverBudgetFromAbove: boolean;
    readonly diffHistoryTokens: number;
    readonly diffHistoryEntries: number;
    readonly diffHistoryOnlyForDocumentsInPrompt: boolean;
    readonly diffHistoryUseRelativePaths: boolean;
    readonly languageContextTokens: number;
    readonly languageContextEnabled: boolean;
    readonly languageContextEnabledLanguages: Readonly<Record<string, boolean>>;
    readonly languageContextTraitPosition: "before" | "after";
    readonly neighborFileTokens: number;
    readonly neighborFilesEnabled: boolean;
    readonly pageSize: number;
    readonly linesAboveEditWindow: number;
    readonly linesBelowEditWindow: number;
    readonly surroundingLines: number;
    readonly editWindowTokens: number;
    readonly includePostScript: boolean;
    readonly lintOptions?: NesLintConfig;
    readonly globalBudget?: NesGlobalBudgetConfig;
    readonly hardCharacterLimit: number;
  };
  readonly trigger: {
    readonly recentChangeMs: number;
    readonly sameLineCooldownMs: number;
    readonly rejectionCooldownMs: number;
    readonly selectionDebounceMs: number;
    readonly immediateSelectionChanges: number;
    readonly documentSwitchMs: number;
    readonly documentSwitchRequiresAcceptance: boolean;
  };
  readonly nextEdit: {
    readonly requestDebounceMs: number;
    readonly backoffDebounceEnabled: boolean;
    readonly debounceUseCoreRequestTime: boolean;
    readonly extraDebounceEndOfLineMs: number;
    readonly extraDebounceInlineSuggestionMs: number;
    readonly defaultAggressivenessSetting: NesAggressivenessSetting;
    readonly configuredAggressivenessLevel: NesAggressivenessLevel | null;
    readonly aggressivenessLowMinResponseTimeMs: number;
    readonly aggressivenessMediumMinResponseTimeMs: number;
    readonly aggressivenessHighDebounceMs: number;
    readonly userHappinessScore: UserHappinessScoreConfig;
    readonly cacheDelayMs: number;
    readonly rebasedCacheDelayMs: number;
    readonly subsequentCacheDelayMs: number;
    readonly speculativeCacheDelayMs: number;
    readonly maxCacheEntries: number;
    readonly earlyDivergenceCancellation: "off" | "cursor" | "editWindow";
    readonly absorbSubsequenceTyping: boolean;
    readonly reverseAgreement: boolean;
    readonly maxImperfectAgreementLength: number;
    readonly cacheCursorDistanceCheck: boolean;
    readonly asyncCompletions: boolean;
    readonly speculativeRequests: "on" | "off";
    readonly speculativeRequestsCursorPlacement:
      "afterEditApplied" | "afterEditWindow";
    readonly speculativeRequestsAutoExpandEditWindowLines:
      "off" | "always" | "smart";
    readonly autoExpandEditWindowLines: number;
    readonly triggerOnEditorChangeAfterSeconds: number;
    readonly responseFormatByStrategy: Readonly<
      Record<NesPromptStrategy, NesResponseFormat>
    >;
    readonly diagnosticsStartDelayMs: number;
    readonly diagnosticsRaceDeadlineMs: number;
    readonly ignoreWhenSuggestVisible: boolean;
    readonly inlineCompletionsAdvanced: boolean;
    readonly mimicGhostTextBehavior: boolean;
    readonly useAlternativeNotebookFormat: boolean;
    readonly javaImportDiagnostics: boolean;
    readonly usePrediction: boolean;
    readonly allowWhitespaceOnlyChanges: boolean;
    readonly filterSubstrings: readonly string[];
    readonly undoInsertionFiltering: "v1";
    readonly cursorPrediction: {
      readonly mode: "onlyWithEdit";
      readonly currentFileMaxTokens: number;
      readonly maxResponseTokens: number;
    };
  };
  readonly joint: {
    readonly enabled: boolean;
    readonly strategy: "regular" | "cursorEndOfLine";
    readonly nesCacheWaitMs: number;
    readonly suppressChangeWhileFimInFlight: boolean;
  };
}

/**
 * Local treatment snapshot for microsoft/vscode@1.128.0. Values are sourced
 * from configurationService.ts, xtabPromptOptions.ts, inlineEditTriggerer.ts,
 * nextEditProvider.ts, and jointInlineCompletionProvider.ts at the commit above.
 * The selection debounce is deliberately frozen at the upstream 100ms request
 * debounce treatment so behavior does not depend on a remote experiment.
 */
export const COPILOT_BEHAVIOR_CONFIG: CopilotBehaviorConfig = Object.freeze({
  upstreamCommit: COPILOT_UPSTREAM_COMMIT,
  fim: Object.freeze({
    defaultDiagnostics: null,
  }),
  diagnosticsContextProvider: Object.freeze({
    enabled: false,
    enabledLanguages: Object.freeze({}),
  }),
  prompt: Object.freeze({
    currentFileTokens: 1500,
    currentFileIncludeTags: Object.freeze({
      copilotNesXtab: true,
      xtab275: false,
      xtabUnifiedModel: false,
      xtabAggressiveness: false,
      xtab275Aggressiveness: false,
      xtab275AggressivenessHighLow: false,
      xtab275EditIntent: false,
      xtab275EditIntentShort: false,
    }),
    currentFileLineNumbers: "none",
    currentFileIncludeCursorTag: false,
    currentFilePrioritizeAboveCursor: false,
    currentFileUseLeftoverBudgetFromAbove: true,
    recentFileTokens: 2000,
    recentFileCount: 5,
    recentFilesIncludeViewed: false,
    recentFilesLineNumbers: "none",
    recentFilesClippingStrategy: "aroundEditRange",
    recentFilesUseLeftoverBudgetFromAbove: false,
    diffHistoryTokens: 1000,
    diffHistoryEntries: 25,
    diffHistoryOnlyForDocumentsInPrompt: false,
    diffHistoryUseRelativePaths: false,
    languageContextTokens: 2000,
    languageContextEnabled: false,
    languageContextEnabledLanguages: Object.freeze({
      prompt: true,
      instructions: true,
      chatagent: true,
    }),
    languageContextTraitPosition: "before",
    neighborFileTokens: 1000,
    neighborFilesEnabled: false,
    pageSize: 10,
    linesAboveEditWindow: 2,
    linesBelowEditWindow: 5,
    surroundingLines: 15,
    editWindowTokens: 2000,
    includePostScript: true,
    hardCharacterLimit: 120_000,
  }),
  trigger: Object.freeze({
    recentChangeMs: 10_000,
    sameLineCooldownMs: 5_000,
    rejectionCooldownMs: 5_000,
    selectionDebounceMs: 100,
    immediateSelectionChanges: 2,
    documentSwitchMs: 10_000,
    documentSwitchRequiresAcceptance: true,
  }),
  nextEdit: Object.freeze({
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
    userHappinessScore: Object.freeze({
      acceptedScore: 1,
      rejectedScore: 0,
      ignoredScore: 0.5,
      highThreshold: 0.7,
      mediumThreshold: 0.4,
      includeIgnored: false,
      ignoredLimit: 0,
      limitConsecutiveIgnored: false,
      limitTotalIgnored: true,
    }),
    cacheDelayMs: 200,
    rebasedCacheDelayMs: 0,
    subsequentCacheDelayMs: 0,
    speculativeCacheDelayMs: 0,
    maxCacheEntries: 50,
    // Fixed defaults from configurationService.ts at the pinned commit.
    // Tests override these fields to exercise experiment-controlled branches.
    earlyDivergenceCancellation: "off",
    absorbSubsequenceTyping: false,
    reverseAgreement: true,
    maxImperfectAgreementLength: 1,
    cacheCursorDistanceCheck: false,
    asyncCompletions: true,
    speculativeRequests: "off",
    speculativeRequestsCursorPlacement: "afterEditApplied",
    speculativeRequestsAutoExpandEditWindowLines: "off",
    autoExpandEditWindowLines: 10,
    triggerOnEditorChangeAfterSeconds: 10,
    responseFormatByStrategy: Object.freeze({
      copilotNesXtab: "codeBlock",
      xtab275: "editWindowOnly",
      xtabUnifiedModel: "unifiedXml",
      xtabAggressiveness: "editWindowOnly",
      xtab275Aggressiveness: "editWindowOnly",
      xtab275AggressivenessHighLow: "editWindowOnly",
      xtab275EditIntent: "editWindowWithEditIntent",
      xtab275EditIntentShort: "editWindowWithEditIntentShort",
    }),
    diagnosticsStartDelayMs: 50,
    diagnosticsRaceDeadlineMs: 1_250,
    ignoreWhenSuggestVisible: true,
    inlineCompletionsAdvanced: true,
    mimicGhostTextBehavior: false,
    // Both gates are false for the fixed production build. Enhanced notebook
    // NES is experiment-controlled and Java diagnostics are prerelease-only.
    useAlternativeNotebookFormat: false,
    javaImportDiagnostics: false,
    usePrediction: true,
    allowWhitespaceOnlyChanges: true,
    filterSubstrings: Object.freeze([
      "<|current_file_content|>",
      "<|/current_file_content|>",
      "<|" + "diff_marker" + "|>",
    ]),
    undoInsertionFiltering: "v1",
    cursorPrediction: Object.freeze({
      mode: "onlyWithEdit",
      currentFileMaxTokens: 3_000,
      maxResponseTokens: 40,
    }),
  }),
  joint: Object.freeze({
    enabled: false,
    strategy: "regular",
    nesCacheWaitMs: 10,
    suppressChangeWhileFimInFlight: true,
  }),
});

function behaviorRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Copilot behavior config ${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function behaviorNumber(
  record: Record<string, unknown>,
  key: string,
  path: string,
  integer = false,
  positive = false,
): number {
  const value = record[key];
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (positive ? value <= 0 : value < 0) ||
    (integer && !Number.isInteger(value))
  ) {
    throw new Error(`Copilot behavior config ${path}.${key} is invalid.`);
  }
  return value;
}

function behaviorBoolean(
  record: Record<string, unknown>,
  key: string,
  path: string,
): void {
  if (typeof record[key] !== "boolean") {
    throw new Error(`Copilot behavior config ${path}.${key} must be boolean.`);
  }
}

function behaviorEnum(
  record: Record<string, unknown>,
  key: string,
  path: string,
  values: readonly string[],
): void {
  if (typeof record[key] !== "string" || !values.includes(record[key])) {
    throw new Error(`Copilot behavior config ${path}.${key} is invalid.`);
  }
}

const PROMPT_NUMBERS = [
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
] as const;

const PROMPT_BOOLEANS = [
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
] as const;

const TRIGGER_NUMBERS = [
  "recentChangeMs",
  "sameLineCooldownMs",
  "rejectionCooldownMs",
  "selectionDebounceMs",
  "immediateSelectionChanges",
  "documentSwitchMs",
] as const;

const NEXT_EDIT_NUMBERS = [
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
  "maxImperfectAgreementLength",
  "autoExpandEditWindowLines",
  "triggerOnEditorChangeAfterSeconds",
  "diagnosticsStartDelayMs",
  "diagnosticsRaceDeadlineMs",
] as const;

const NEXT_EDIT_BOOLEANS = [
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
] as const;

const GLOBAL_BUDGET_PARTS: readonly NesGlobalBudgetPart[] = [
  "recentlyViewedDocuments",
  "languageContext",
  "neighborFiles",
  "diffHistory",
];

const NES_PROMPT_STRATEGIES: readonly NesPromptStrategy[] = [
  "copilotNesXtab",
  "xtab275",
  "xtabUnifiedModel",
  "xtabAggressiveness",
  "xtab275Aggressiveness",
  "xtab275AggressivenessHighLow",
  "xtab275EditIntent",
  "xtab275EditIntentShort",
];

export function validateCopilotBehaviorConfig(
  config: unknown,
): asserts config is CopilotBehaviorConfig {
  const root = behaviorRecord(config, "root");
  if (root.upstreamCommit !== COPILOT_UPSTREAM_COMMIT) {
    throw new Error(
      "Copilot behavior config does not match the extracted commit.",
    );
  }

  const fim = behaviorRecord(root.fim, "fim");
  const defaultDiagnostics = fim.defaultDiagnostics;
  if (defaultDiagnostics !== null) {
    const diagnostics = behaviorRecord(
      defaultDiagnostics,
      "fim.defaultDiagnostics",
    );
    behaviorEnum(diagnostics, "warnings", "fim.defaultDiagnostics", [
      "no",
      "yes",
      "yesIfNoErrors",
    ]);
    behaviorNumber(diagnostics, "maxLineDistance", "fim.defaultDiagnostics");
    behaviorNumber(
      diagnostics,
      "maxDiagnostics",
      "fim.defaultDiagnostics",
      true,
      true,
    );
  }
  const prompt = behaviorRecord(root.prompt, "prompt");
  const diagnosticsContextProvider = behaviorRecord(
    root.diagnosticsContextProvider,
    "diagnosticsContextProvider",
  );
  const trigger = behaviorRecord(root.trigger, "trigger");
  const nextEdit = behaviorRecord(root.nextEdit, "nextEdit");
  const joint = behaviorRecord(root.joint, "joint");

  for (const key of PROMPT_NUMBERS) {
    behaviorNumber(
      prompt,
      key,
      "prompt",
      key === "recentFileCount" ||
        key === "diffHistoryEntries" ||
        key === "pageSize",
      key === "pageSize" || key === "hardCharacterLimit",
    );
  }
  for (const key of PROMPT_BOOLEANS) behaviorBoolean(prompt, key, "prompt");
  behaviorBoolean(
    diagnosticsContextProvider,
    "enabled",
    "diagnosticsContextProvider",
  );
  const diagnosticsEnabledLanguages = behaviorRecord(
    diagnosticsContextProvider.enabledLanguages,
    "diagnosticsContextProvider.enabledLanguages",
  );
  for (const [language, enabled] of Object.entries(
    diagnosticsEnabledLanguages,
  )) {
    if (!language || typeof enabled !== "boolean") {
      throw new Error(
        "Copilot behavior config diagnosticsContextProvider.enabledLanguages is invalid.",
      );
    }
  }
  behaviorEnum(prompt, "currentFileLineNumbers", "prompt", [
    "withSpaceAfter",
    "withoutSpaceAfter",
    "none",
  ]);
  behaviorEnum(prompt, "recentFilesLineNumbers", "prompt", [
    "withSpaceAfter",
    "withoutSpaceAfter",
    "none",
  ]);
  behaviorEnum(prompt, "recentFilesClippingStrategy", "prompt", [
    "aroundEditRange",
    "proportional",
  ]);
  behaviorEnum(prompt, "languageContextTraitPosition", "prompt", [
    "before",
    "after",
  ]);

  const includeTags = behaviorRecord(
    prompt.currentFileIncludeTags,
    "prompt.currentFileIncludeTags",
  );
  for (const strategy of NES_PROMPT_STRATEGIES) {
    behaviorBoolean(includeTags, strategy, "prompt.currentFileIncludeTags");
  }

  const enabledLanguages = behaviorRecord(
    prompt.languageContextEnabledLanguages,
    "prompt.languageContextEnabledLanguages",
  );
  for (const language of ["prompt", "instructions", "chatagent"]) {
    behaviorBoolean(
      enabledLanguages,
      language,
      "prompt.languageContextEnabledLanguages",
    );
  }
  for (const [language, enabled] of Object.entries(enabledLanguages)) {
    if (!language || typeof enabled !== "boolean") {
      throw new Error(
        "Copilot behavior config prompt.languageContextEnabledLanguages is invalid.",
      );
    }
  }

  if (prompt.lintOptions !== undefined) {
    const lint = behaviorRecord(prompt.lintOptions, "prompt.lintOptions");
    if (typeof lint.tagName !== "string" || lint.tagName.length === 0) {
      throw new Error(
        "Copilot behavior config prompt.lintOptions.tagName is invalid.",
      );
    }
    behaviorEnum(lint, "warnings", "prompt.lintOptions", [
      "yes",
      "no",
      "yesIfNoErrors",
    ]);
    behaviorEnum(lint, "showCode", "prompt.lintOptions", [
      "yes",
      "no",
      "yesWithSurroundingLines",
    ]);
    for (const key of ["maxLints", "maxLineDistance", "nRecentFiles"]) {
      behaviorNumber(lint, key, "prompt.lintOptions", true);
    }
  }

  if (prompt.globalBudget !== undefined) {
    const globalBudget = behaviorRecord(
      prompt.globalBudget,
      "prompt.globalBudget",
    );
    behaviorNumber(globalBudget, "totalTokens", "prompt.globalBudget");
    if (!Array.isArray(globalBudget.order)) {
      throw new Error(
        "Copilot behavior config prompt.globalBudget.order is invalid.",
      );
    }
    const parts = new Set<NesGlobalBudgetPart>();
    for (const part of globalBudget.order) {
      if (
        typeof part !== "string" ||
        !GLOBAL_BUDGET_PARTS.includes(part as NesGlobalBudgetPart)
      ) {
        throw new Error(
          "Copilot prompt global budget contains an invalid part.",
        );
      }
      const budgetPart = part as NesGlobalBudgetPart;
      if (parts.has(budgetPart)) {
        throw new Error(
          "Copilot prompt global budget contains a duplicate part.",
        );
      }
      parts.add(budgetPart);
    }
    if (
      globalBudget.order.indexOf("neighborFiles") !== -1 &&
      globalBudget.order.indexOf("recentlyViewedDocuments") !== -1 &&
      globalBudget.order.indexOf("neighborFiles") <
        globalBudget.order.indexOf("recentlyViewedDocuments")
    ) {
      throw new Error(
        "Copilot prompt global budget must process recent documents before neighbors.",
      );
    }
    const sharesRecord = behaviorRecord(
      globalBudget.shares,
      "prompt.globalBudget.shares",
    );
    for (const key of ["currentFile", ...GLOBAL_BUDGET_PARTS]) {
      behaviorNumber(sharesRecord, key, "prompt.globalBudget.shares");
    }
    const selectedShares = [
      sharesRecord.currentFile as number,
      ...globalBudget.order.map((part) => sharesRecord[String(part)] as number),
    ];
    if (
      Math.abs(selectedShares.reduce((sum, share) => sum + share, 0) - 1) >
      0.001
    ) {
      throw new Error("Copilot prompt global budget is invalid.");
    }
  }

  for (const key of TRIGGER_NUMBERS) {
    behaviorNumber(
      trigger,
      key,
      "trigger",
      key === "immediateSelectionChanges",
    );
  }
  behaviorBoolean(trigger, "documentSwitchRequiresAcceptance", "trigger");

  for (const key of NEXT_EDIT_NUMBERS) {
    behaviorNumber(
      nextEdit,
      key,
      "nextEdit",
      key === "maxCacheEntries",
      key === "maxCacheEntries",
    );
  }
  for (const key of NEXT_EDIT_BOOLEANS) {
    behaviorBoolean(nextEdit, key, "nextEdit");
  }
  behaviorEnum(nextEdit, "defaultAggressivenessSetting", "nextEdit", [
    "auto",
    "low",
    "medium",
    "high",
  ]);
  if (nextEdit.configuredAggressivenessLevel !== null) {
    behaviorEnum(nextEdit, "configuredAggressivenessLevel", "nextEdit", [
      "low",
      "medium",
      "high",
    ]);
  }
  const happiness = behaviorRecord(
    nextEdit.userHappinessScore,
    "nextEdit.userHappinessScore",
  );
  for (const key of [
    "acceptedScore",
    "rejectedScore",
    "ignoredScore",
    "highThreshold",
    "mediumThreshold",
  ] as const) {
    const value = behaviorNumber(happiness, key, "nextEdit.userHappinessScore");
    if (value > 1) {
      throw new Error(
        `Copilot behavior config nextEdit.userHappinessScore.${key} is invalid.`,
      );
    }
  }
  behaviorNumber(
    happiness,
    "ignoredLimit",
    "nextEdit.userHappinessScore",
    true,
  );
  for (const key of [
    "includeIgnored",
    "limitConsecutiveIgnored",
    "limitTotalIgnored",
  ] as const) {
    behaviorBoolean(happiness, key, "nextEdit.userHappinessScore");
  }
  if (
    (happiness.acceptedScore as number) <=
      (happiness.rejectedScore as number) ||
    (happiness.ignoredScore as number) < (happiness.rejectedScore as number) ||
    (happiness.ignoredScore as number) > (happiness.acceptedScore as number) ||
    (happiness.highThreshold as number) <= (happiness.mediumThreshold as number)
  ) {
    throw new Error(
      "Copilot behavior config nextEdit.userHappinessScore relationships are invalid.",
    );
  }
  behaviorEnum(nextEdit, "earlyDivergenceCancellation", "nextEdit", [
    "off",
    "cursor",
    "editWindow",
  ]);
  behaviorEnum(nextEdit, "speculativeRequests", "nextEdit", ["on", "off"]);
  behaviorEnum(nextEdit, "speculativeRequestsCursorPlacement", "nextEdit", [
    "afterEditApplied",
    "afterEditWindow",
  ]);
  behaviorEnum(
    nextEdit,
    "speculativeRequestsAutoExpandEditWindowLines",
    "nextEdit",
    ["off", "always", "smart"],
  );
  const responseFormats = behaviorRecord(
    nextEdit.responseFormatByStrategy,
    "nextEdit.responseFormatByStrategy",
  );
  for (const strategy of NES_PROMPT_STRATEGIES) {
    behaviorEnum(
      responseFormats,
      strategy,
      "nextEdit.responseFormatByStrategy",
      [
        "codeBlock",
        "editWindowOnly",
        "unifiedXml",
        "editWindowWithEditIntent",
        "editWindowWithEditIntentShort",
      ],
    );
  }
  if (
    nextEdit.useAlternativeNotebookFormat !== false ||
    nextEdit.javaImportDiagnostics !== false
  ) {
    throw new Error(
      "Copilot behavior config nextEdit production-only gates are invalid.",
    );
  }
  if (
    !Array.isArray(nextEdit.filterSubstrings) ||
    nextEdit.filterSubstrings.some((value) => typeof value !== "string")
  ) {
    throw new Error(
      "Copilot behavior config nextEdit.filterSubstrings is invalid.",
    );
  }
  behaviorEnum(nextEdit, "undoInsertionFiltering", "nextEdit", ["v1"]);
  const cursorPrediction = behaviorRecord(
    nextEdit.cursorPrediction,
    "nextEdit.cursorPrediction",
  );
  behaviorEnum(cursorPrediction, "mode", "nextEdit.cursorPrediction", [
    "onlyWithEdit",
  ]);
  behaviorNumber(
    cursorPrediction,
    "currentFileMaxTokens",
    "nextEdit.cursorPrediction",
  );
  behaviorNumber(
    cursorPrediction,
    "maxResponseTokens",
    "nextEdit.cursorPrediction",
  );

  behaviorBoolean(joint, "enabled", "joint");
  behaviorEnum(joint, "strategy", "joint", ["regular", "cursorEndOfLine"]);
  behaviorNumber(joint, "nesCacheWaitMs", "joint");
  behaviorBoolean(joint, "suppressChangeWhileFimInFlight", "joint");
}
