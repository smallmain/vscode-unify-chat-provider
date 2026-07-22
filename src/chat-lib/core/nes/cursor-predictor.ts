import {
  COPILOT_BEHAVIOR_CONFIG,
  type CopilotBehaviorConfig,
} from "../behavior-config";
import { buildOfficialNesPrompt } from "./prompt";
import type { NesPromptBuildResult, NesPromptContext } from "./types";

/**
 * Ported from microsoft/vscode@fc3def6774c76082adf699d366f31a557ce5573f:
 * xtabNextCursorPredictor.ts lines 35-47, 96-180, and 314-367.
 */
export const NEXT_CURSOR_PREDICTION_SYSTEM_MESSAGE = `Your task is to predict the line number where the developer is most likely to make their next edit. If you jump in the current file, just output the line number. If you want to jump to another file, output the filepath (relative to workspace root), colon, then line number. If you don't think anywhere is a good next line jump target, just output the current line number of the cursor. Make sure to output no explanation, reasoning, extra spaces, etc.`;

export const CURSOR_PREDICTION_CURRENT_FILE_MAX_TOKENS = 3_000;
export const DEFAULT_CURSOR_PREDICTION_MODEL_ID =
  "copilot-suggestions-himalia-001";

export const CURSOR_PREDICTION_PROMPT_CONFIG = Object.freeze({
  currentFileIncludeTags: false,
  currentFileLineNumbers: "withSpaceAfter" as const,
  recentSnippetsLineNumbers: "none" as const,
  includePostScript: false,
  lintOptions: Object.freeze({
    tagName: "linter",
    warnings: "yesIfNoErrors" as const,
    showCode: "yesWithSurroundingLines" as const,
    maxLints: 5,
    maxLineDistance: 1_000,
    nRecentFiles: 0,
  }),
});

/** XtabProvider.computeTokens at the frozen commit (xtabProvider.ts line 160). */
export function countCursorPredictionTokens(text: string): number {
  return Math.floor(text.length / 4);
}

export interface CursorPredictionLineRange {
  readonly start: number;
  readonly endExclusive: number;
}

export type CursorJumpPrediction =
  | { readonly kind: "sameFile"; readonly lineNumber: number }
  | {
      readonly kind: "differentFile";
      readonly filePath: string;
      readonly lineNumber: number;
    };

export type CursorPredictionParseFailureReason =
  | "negativeLineNumber"
  | "modelNotSeenLineNumber"
  | "gotNaN"
  | "crossFileInvalidLineNumber"
  | "crossFileEmptyFilePath";

export type CursorPredictionParseResult =
  | { readonly ok: true; readonly prediction: CursorJumpPrediction }
  | {
      readonly ok: false;
      readonly reason: CursorPredictionParseFailureReason;
    };

export interface CursorPredictionMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

export interface CursorPredictionPrompt {
  readonly messages: readonly [
    CursorPredictionMessage,
    CursorPredictionMessage,
  ];
  readonly keptRange: CursorPredictionLineRange;
  readonly currentFileContent: string;
  readonly currentFileTokens: number;
  readonly userPromptTokens: number;
  readonly totalTokens: number;
}

export type CursorPredictionPromptResult =
  | { readonly ok: true; readonly prompt: CursorPredictionPrompt }
  | {
      readonly ok: false;
      readonly reason: "invalidPrompt" | "outOfBudget";
    };

export interface CursorPredictionPromptOptions {
  readonly areaAroundEditWindow?: CursorPredictionLineRange;
  readonly pageSize?: number;
  readonly maxCurrentFileTokens?: number;
  readonly countTokens?: (text: string) => number;
  readonly behaviorConfig?: CopilotBehaviorConfig;
}

export type CursorPredictionDecision =
  | {
      readonly kind: "crossFile";
      readonly prediction: Extract<
        CursorJumpPrediction,
        { readonly kind: "differentFile" }
      >;
    }
  | {
      readonly kind: "outOfBounds";
      readonly lineNumber: number;
      readonly reason: "negativeLineNumber" | "exceedsDocumentLines";
    }
  | { readonly kind: "withinEditWindow"; readonly lineNumber: number }
  | { readonly kind: "outsideEditWindow"; readonly lineNumber: number };

function countLineTokens(
  lines: readonly string[],
  countTokens: (text: string) => number,
): number {
  return lines.reduce((total, line) => total + countTokens(line) + 1, 0);
}

function normalizeRange(
  range: CursorPredictionLineRange,
  lineCount: number,
): CursorPredictionLineRange {
  const start = Math.max(0, Math.min(lineCount - 1, range.start));
  const endExclusive = Math.max(
    start + 1,
    Math.min(lineCount, range.endExclusive),
  );
  return { start, endExclusive };
}

function defaultAreaRange(
  prompt: NesPromptBuildResult,
  lineCount: number,
  config: CopilotBehaviorConfig,
): CursorPredictionLineRange {
  const contextLines = config.prompt.surroundingLines;
  return {
    start: Math.max(0, prompt.editWindow.cursorLineOffset - contextLines),
    endExclusive: Math.min(
      lineCount,
      prompt.editWindow.cursorLineOffset + contextLines + 1,
    ),
  };
}

function clipNumberedCurrentFile(
  numberedLines: readonly string[],
  rangeToPreserve: CursorPredictionLineRange,
  pageSize: number,
  maxTokens: number,
  countTokens: (text: string) => number,
  prioritizeAbove: boolean,
  useLeftoverBudgetFromAbove: boolean,
):
  | {
      readonly ok: true;
      readonly lines: readonly string[];
      readonly keptRange: CursorPredictionLineRange;
      readonly tokens: number;
    }
  | { readonly ok: false } {
  let firstPage = Math.floor(rangeToPreserve.start / pageSize);
  let lastPage = Math.floor((rangeToPreserve.endExclusive - 1) / pageSize);
  const pageCost = (page: number): number =>
    countLineTokens(
      numberedLines.slice(
        page * pageSize,
        Math.min(numberedLines.length, (page + 1) * pageSize),
      ),
      countTokens,
    );
  let available =
    maxTokens -
    countLineTokens(
      numberedLines.slice(rangeToPreserve.start, rangeToPreserve.endExclusive),
      countTokens,
    );
  if (available < 0) {
    return { ok: false };
  }
  for (let page = firstPage; page <= lastPage; page += 1) {
    available -= pageCost(page);
  }
  if (available < 0) {
    return { ok: false };
  }

  let keptFirstPage = firstPage;
  let budgetAbove = prioritizeAbove ? available : Math.floor(available / 2);
  for (let page = firstPage - 1; page >= 0; page -= 1) {
    const cost = pageCost(page);
    if (cost > budgetAbove) {
      break;
    }
    keptFirstPage = page;
    budgetAbove -= cost;
  }

  let keptLastPage = lastPage;
  let budgetBelow = prioritizeAbove
    ? budgetAbove
    : Math.floor(available / 2) +
      (useLeftoverBudgetFromAbove ? budgetAbove : 0);
  const pageCount = Math.ceil(numberedLines.length / pageSize);
  for (let page = lastPage + 1; page < pageCount; page += 1) {
    const cost = pageCost(page);
    if (cost > budgetBelow) {
      break;
    }
    keptLastPage = page;
    budgetBelow -= cost;
  }

  const keptRange = {
    start: keptFirstPage * pageSize,
    endExclusive: Math.min(numberedLines.length, (keptLastPage + 1) * pageSize),
  };
  const lines = numberedLines.slice(keptRange.start, keptRange.endExclusive);
  const tokens = countLineTokens(lines, countTokens);
  return tokens <= maxTokens
    ? { ok: true, lines, keptRange, tokens }
    : { ok: false };
}

function createCursorPredictionBehaviorConfig(
  currentPrompt: NesPromptBuildResult,
  maxCurrentFileTokens: number,
  pageSize: number,
  base: CopilotBehaviorConfig,
): CopilotBehaviorConfig {
  const linesAboveEditWindow =
    currentPrompt.editWindow.cursorLineOffset -
    currentPrompt.editWindow.startLine;
  const linesBelowEditWindow =
    currentPrompt.editWindow.endLineExclusive -
    currentPrompt.editWindow.cursorLineOffset -
    1;
  return {
    ...base,
    prompt: {
      ...base.prompt,
      currentFileTokens: maxCurrentFileTokens,
      currentFileIncludeTags: {
        copilotNesXtab: CURSOR_PREDICTION_PROMPT_CONFIG.currentFileIncludeTags,
        xtab275: CURSOR_PREDICTION_PROMPT_CONFIG.currentFileIncludeTags,
        xtabUnifiedModel:
          CURSOR_PREDICTION_PROMPT_CONFIG.currentFileIncludeTags,
        xtabAggressiveness:
          CURSOR_PREDICTION_PROMPT_CONFIG.currentFileIncludeTags,
        xtab275Aggressiveness:
          CURSOR_PREDICTION_PROMPT_CONFIG.currentFileIncludeTags,
        xtab275AggressivenessHighLow:
          CURSOR_PREDICTION_PROMPT_CONFIG.currentFileIncludeTags,
        xtab275EditIntent:
          CURSOR_PREDICTION_PROMPT_CONFIG.currentFileIncludeTags,
        xtab275EditIntentShort:
          CURSOR_PREDICTION_PROMPT_CONFIG.currentFileIncludeTags,
      },
      currentFileLineNumbers:
        CURSOR_PREDICTION_PROMPT_CONFIG.currentFileLineNumbers,
      recentFilesLineNumbers:
        CURSOR_PREDICTION_PROMPT_CONFIG.recentSnippetsLineNumbers,
      includePostScript: CURSOR_PREDICTION_PROMPT_CONFIG.includePostScript,
      lintOptions: CURSOR_PREDICTION_PROMPT_CONFIG.lintOptions,
      pageSize,
      linesAboveEditWindow,
      linesBelowEditWindow,
      hardCharacterLimit: Number.MAX_SAFE_INTEGER,
    },
  };
}

/**
 * Rebuilds the cursor-prediction PromptPieces from source context with the
 * dedicated frozen lint, line-number, recent-snippet, and postscript options.
 */
export function buildCursorPredictionPrompt(
  context: NesPromptContext,
  currentPrompt: NesPromptBuildResult,
  options: CursorPredictionPromptOptions = {},
): CursorPredictionPromptResult {
  const lines = context.current.text.split(/\r?\n/);
  const behaviorConfig = options.behaviorConfig ?? COPILOT_BEHAVIOR_CONFIG;
  const countTokens = options.countTokens ?? countCursorPredictionTokens;
  const pageSize = Math.max(
    1,
    Math.floor(options.pageSize ?? behaviorConfig.prompt.pageSize),
  );
  const maxCurrentFileTokens = Math.max(
    0,
    Math.floor(
      options.maxCurrentFileTokens ??
        behaviorConfig.nextEdit.cursorPrediction.currentFileMaxTokens,
    ),
  );
  const rangeToPreserve = normalizeRange(
    options.areaAroundEditWindow ??
      defaultAreaRange(currentPrompt, lines.length, behaviorConfig),
    lines.length,
  );
  const numberedLines = lines.map((line, index) => `${index}| ${line}`);
  const clipped = clipNumberedCurrentFile(
    numberedLines,
    rangeToPreserve,
    pageSize,
    maxCurrentFileTokens,
    countTokens,
    behaviorConfig.prompt.currentFilePrioritizeAboveCursor,
    behaviorConfig.prompt.currentFileUseLeftoverBudgetFromAbove,
  );
  if (!clipped.ok) {
    return { ok: false, reason: "outOfBudget" };
  }

  const currentFileContent = clipped.lines.join("\n");
  const cursorConfig = createCursorPredictionBehaviorConfig(
    currentPrompt,
    maxCurrentFileTokens,
    pageSize,
    behaviorConfig,
  );
  let rebuilt: NesPromptBuildResult;
  try {
    rebuilt = buildOfficialNesPrompt(
      context,
      currentPrompt.strategy,
      cursorConfig,
      {
        linesBelowEditWindow: cursorConfig.prompt.linesBelowEditWindow,
        currentFileTokens: maxCurrentFileTokens,
        currentFileRange: clipped.keptRange,
        areaAroundEditWindow: rangeToPreserve,
      },
    );
  } catch {
    return { ok: false, reason: "invalidPrompt" };
  }
  const userPrompt = rebuilt.messages.user;
  const userPromptTokens = countTokens(userPrompt);
  const systemTokens = countTokens(NEXT_CURSOR_PREDICTION_SYSTEM_MESSAGE);
  return {
    ok: true,
    prompt: {
      messages: [
        {
          role: "system",
          content: NEXT_CURSOR_PREDICTION_SYSTEM_MESSAGE,
        },
        { role: "user", content: userPrompt },
      ],
      keptRange: clipped.keptRange,
      currentFileContent,
      currentFileTokens: clipped.tokens,
      userPromptTokens,
      totalTokens: systemTokens + userPromptTokens,
    },
  };
}

/** Mirrors the thinking-model cleanup at upstream lines 355-367. */
export function stripCursorPredictionThinkBlocks(text: string): string {
  let result = text.replace(/<think>[\s\S]*?<\/think>\s*/g, "");
  if (result.trimStart().startsWith("<think>")) {
    result = "";
  }
  return result.trim();
}

/** Mirrors XtabNextCursorPredictor.parseResponse, including its error names. */
export function parseCursorPredictionResponse(
  rawResponse: string,
  keptRange: CursorPredictionLineRange,
): CursorPredictionParseResult {
  const trimmed = stripCursorPredictionThinkBlocks(rawResponse);
  const lineNumber = Number.parseInt(trimmed, 10);
  if (!Number.isNaN(lineNumber) && String(lineNumber) === trimmed) {
    if (lineNumber < 0) {
      return { ok: false, reason: "negativeLineNumber" };
    }
    if (lineNumber < keptRange.start || keptRange.endExclusive <= lineNumber) {
      return { ok: false, reason: "modelNotSeenLineNumber" };
    }
    return { ok: true, prediction: { kind: "sameFile", lineNumber } };
  }

  const lastColonIndex = trimmed.lastIndexOf(":");
  if (lastColonIndex <= 0) {
    return { ok: false, reason: "gotNaN" };
  }
  const filePath = trimmed.slice(0, lastColonIndex);
  const crossFileLineNumber = Number.parseInt(
    trimmed.slice(lastColonIndex + 1),
    10,
  );
  if (Number.isNaN(crossFileLineNumber) || crossFileLineNumber < 0) {
    return { ok: false, reason: "crossFileInvalidLineNumber" };
  }
  if (filePath.trim().length === 0) {
    return { ok: false, reason: "crossFileEmptyFilePath" };
  }
  return {
    ok: true,
    prediction: {
      kind: "differentFile",
      filePath: filePath.trim(),
      lineNumber: crossFileLineNumber,
    },
  };
}

/**
 * Ports the observable cursor-decision branches at xtabProvider.ts 1283-1307.
 */
export function decideCursorPrediction(
  prediction: CursorJumpPrediction,
  documentLineCount: number,
  editWindow: CursorPredictionLineRange,
): CursorPredictionDecision {
  if (prediction.kind === "differentFile") {
    return { kind: "crossFile", prediction };
  }
  if (prediction.lineNumber < 0) {
    return {
      kind: "outOfBounds",
      lineNumber: prediction.lineNumber,
      reason: "negativeLineNumber",
    };
  }
  if (prediction.lineNumber >= documentLineCount) {
    return {
      kind: "outOfBounds",
      lineNumber: prediction.lineNumber,
      reason: "exceedsDocumentLines",
    };
  }
  if (
    editWindow.start <= prediction.lineNumber &&
    prediction.lineNumber < editWindow.endExclusive
  ) {
    return { kind: "withinEditWindow", lineNumber: prediction.lineNumber };
  }
  return { kind: "outsideEditWindow", lineNumber: prediction.lineNumber };
}

export type NesCrossFileOpenCancellationReason =
  "afterCrossFileOpenTextDocument" | "afterCrossFileOpenTextDocumentUserTyped";

export interface NesCrossFileOpenContinuationResult<TResult> {
  readonly value: TResult;
}

export interface NesCrossFileOpenContinuation<TDocument, TResult> {
  readonly open: () => PromiseLike<TDocument>;
  readonly isCancellationRequested: () => boolean;
  readonly hasUserTypedSinceRequestStarted: () => boolean;
  readonly onOpenFailed: () => NesCrossFileOpenContinuationResult<TResult>;
  readonly onCancelled: (
    reason: NesCrossFileOpenCancellationReason,
  ) => NesCrossFileOpenContinuationResult<TResult>;
  readonly onOpened: (
    document: TDocument,
  ) => NesCrossFileOpenContinuationResult<TResult>;
}

/**
 * Preserves the official cross-file retry continuation: an open failure is
 * terminal, while a successful open checks cancellation and typing before any
 * caller-provided document read in onOpened.
 */
export async function runNesCrossFileOpenContinuation<TDocument, TResult>(
  continuation: NesCrossFileOpenContinuation<TDocument, TResult>,
): Promise<NesCrossFileOpenContinuationResult<TResult>> {
  let document: TDocument;
  try {
    document = await continuation.open();
  } catch {
    return continuation.onOpenFailed();
  }

  if (continuation.isCancellationRequested()) {
    return continuation.onCancelled("afterCrossFileOpenTextDocument");
  }
  if (continuation.hasUserTypedSinceRequestStarted()) {
    return continuation.onCancelled("afterCrossFileOpenTextDocumentUserTyped");
  }
  return continuation.onOpened(document);
}
