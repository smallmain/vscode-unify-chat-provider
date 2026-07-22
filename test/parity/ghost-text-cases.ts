import * as vscode from "vscode";
import { expect } from "vitest";
import { resolveGhostTextBehavior } from "../../src/chat-lib/core/ghost-text/behavior";
import {
  FIM_RECENT_EDITS_CONFIG,
  FimRecentEditsTracker,
} from "../../src/chat-lib/core/ghost-text/recent-edits";
import { GhostTextEngine } from "../../src/chat-lib/core/ghost-text/engine";
import {
  buildGhostTextNetworkStrategy,
  determineGhostTextMultilineStrategy,
  ghostTextTrimmerLookahead,
  resolveGhostTextBlockMode,
  splitGhostTextCompletion,
  trimMultilineCompletion,
} from "../../src/chat-lib/core/ghost-text/multiline";
import {
  CPP_NES_SIMILAR_FILES_OPTIONS,
  DEFAULT_NES_SIMILAR_FILES_OPTIONS,
  selectSimilarFileSnippets,
  type NesSimilarFilesOptions,
} from "../../src/chat-lib/core/nes/similar-files";
import {
  GhostTextPromptFactory,
  renderGhostTextSplitContextPrompt,
  type GhostTextPromptRenderBlock,
} from "../../src/chat-lib/core/ghost-text/prompt";
import { processGhostTextChoice } from "../../src/chat-lib/core/ghost-text/postprocess";
import { FimGhostTextModelBoundary } from "../../src/chat-lib/core/ghost-text/model-boundary";
import {
  CharacterGhostTextTokenizer,
  O200kGhostTextTokenizer,
  RecordingCompletionModel,
  type RecordedFimRequest,
} from "../support/ghost-text";
import type {
  GhostTextBehavior,
  GhostTextModelBoundary,
  GhostTextModelChoice,
  GhostTextModelRequest,
  GhostTextRequest,
} from "../../src/chat-lib/core/ghost-text/types";
import {
  fimNotebookLineInActiveCell,
  prepareFimNotebookContext,
} from "../../src/completion/copilot/fim-notebook-context";
import { coreContextFromWorkspace } from "../support/copilot-fim";
import {
  CopilotContextProviderRegistry,
  type CopilotContextProviderRequest,
} from "../../src/completion/copilot/context-provider";
import type { CopilotWorkspaceContext } from "../../src/completion/copilot/workspace";
import {
  completionInput,
  createCancellationSource,
  createDeferred,
  expectedFor,
  flushMicrotasks,
  offsetAtPosition,
  sequenceId,
  type ParityCase,
} from "./support";

function fixtureRequest(
  overrides: Partial<GhostTextRequest> = {},
): GhostTextRequest {
  const input = completionInput;
  return {
    document: {
      uri: input.document.uri,
      filePath: "/workspace/src/counter.ts",
      relativePath: "src/counter.ts",
      languageId: input.document.languageId,
      text: input.document.text,
      version: input.document.version,
    },
    position: input.document.position,
    trigger: "invoke",
    context: {
      similarFiles: input.contextFiles.map((file) => ({
        path: new URL(file.uri).pathname.replace("/workspace/", ""),
        content: file.text,
        score: 1,
      })),
      recentEdits: input.history.map((entry) => ({
        uri: entry.uri,
        path: new URL(entry.uri).pathname.replace("/workspace/", ""),
        summary: `before:\n${entry.before}\nafter:\n${entry.after}`,
      })),
      diagnostics: input.diagnostics.map((diagnostic) => ({
        path: "src/counter.ts",
        line: diagnostic.line,
        character: 0,
        message: diagnostic.message,
        severity: diagnostic.severity,
      })),
    },
    formattingOptions: { tabSize: 2, insertSpaces: true },
    opportunityId: "completion-request",
    multiline: "single",
    ...overrides,
  };
}

function choice(
  completionText: string,
  choiceIndex = 0,
  requestId = "model-request",
): GhostTextModelChoice {
  return {
    choiceIndex,
    completionText,
    requestId,
    clientCompletionId: `${requestId}-choice-${choiceIndex}`,
    finishReason: "stop",
  };
}

function recordingModel(
  complete: (
    request: GhostTextModelRequest,
    token: vscode.CancellationToken,
    call: number,
  ) => Promise<readonly GhostTextModelChoice[]>,
): GhostTextModelBoundary & {
  readonly requests: GhostTextModelRequest[];
  readonly tokens: vscode.CancellationToken[];
} {
  const requests: GhostTextModelRequest[] = [];
  const tokens: vscode.CancellationToken[] = [];
  return {
    requests,
    tokens,
    async complete(request, token) {
      requests.push(request);
      tokens.push(token);
      return complete(request, token, requests.length);
    },
  };
}

function engineWithModel(
  model: GhostTextModelBoundary,
  behaviorOverrides: Partial<GhostTextBehavior> = {},
): GhostTextEngine {
  return new GhostTextEngine({
    model,
    tokenizer: new CharacterGhostTextTokenizer(),
    idFactory: sequenceId("ghost"),
    behavior: {
      minPromptCharacters: 0,
      completionDelayMs: 0,
      asyncCompletionTimeoutMs: 0,
      ...behaviorOverrides,
    },
    clock: { now: () => 1_000, sleep: async () => undefined },
  });
}

export const ghostTextCases: readonly ParityCase[] = [
  {
    id: "fim-provider-input",
    assertion: "request context and exact range/text reach and leave GhostText",
    async run() {
      const expected = expectedFor<{
        itemCount: number;
        insertText: string;
        range: {
          start: { line: number; character: number };
          end: { line: number; character: number };
        };
        opportunityId: string;
        isCycling: boolean;
        formattingOptions: { tabSize: number; insertSpaces: boolean };
        selectedCompletionForwarded: boolean;
      }>("fim-provider-input");
      const model = recordingModel(async () => [
        choice(completionInput.modelOutputs.fim.join("")),
      ]);
      const engine = engineWithModel(model);
      const source = createCancellationSource();
      const result = await engine.provide(fixtureRequest(), source.token);

      expect(model.tokens).toHaveLength(1);
      expect(model.tokens[0].isCancellationRequested).toBe(
        source.token.isCancellationRequested,
      );
      expect(model.requests).toHaveLength(1);
      expect(model.requests[0]).toMatchObject({
        filePath: "src/counter.ts",
        candidateCount: expected.itemCount,
        prompt: {
          virtualDocumentText: completionInput.document.text,
          virtualCursorOffset: offsetAtPosition(
            completionInput.document.text,
            completionInput.document.position,
          ),
        },
      });
      expect(result.type).toBe("success");
      if (result.type !== "success")
        throw new Error("Expected GhostText success.");
      expect(result.list.items[0]).toMatchObject({
        insertText: expected.insertText,
        range: expected.range,
        metadata: {
          opportunityId: expected.opportunityId,
        },
      });
      expect(fixtureRequest().formattingOptions).toEqual(
        expected.formattingOptions,
      );
      expect(fixtureRequest().trigger === "invoke").toBe(expected.isCycling);

      const behavior = resolveGhostTextBehavior({
        minPromptCharacters: 0,
        completionDelayMs: 0,
      });
      const selectedPrompt = new GhostTextPromptFactory(
        behavior,
        new CharacterGhostTextTokenizer(),
      ).build(
        fixtureRequest({
          selectedCompletionInfo: {
            text: " + STEP",
            range: {
              start: offsetAtPosition(
                completionInput.document.text,
                completionInput.document.position,
              ),
              end: offsetAtPosition(
                completionInput.document.text,
                completionInput.document.position,
              ),
            },
          },
        }),
        source.token,
      );
      expect(selectedPrompt.type).toBe("prompt");
      if (selectedPrompt.type !== "prompt") throw new Error("Expected prompt.");
      expect(selectedPrompt.prompt.virtualDocumentText).toContain(
        "return value + STEP",
      );
      expect(expected.selectedCompletionForwarded).toBe(true);
      expect(
        selectedPrompt.prompt.selectedCompletionLineLengthIncrease,
      ).toBeGreaterThan(0);
    },
  },
  {
    id: "fim-production-context-adapter",
    assertion:
      "production workspace items reach the exact prompt and final source usage feeds the next provider request",
    async run() {
      const expected = expectedFor<{
        context: {
          traits: Array<{ name: string; value: string; importance: number }>;
          codeSnippets: Array<{
            uri: string;
            path: string;
            value: string;
            importance: number;
          }>;
          similarFiles: Array<{ path: string; content: string }>;
          providerFileDeduplicated: boolean;
          neighborFileDeduplicated: boolean;
          turnOffSimilarFiles: boolean;
        };
        prompt: {
          prefix: string;
          suffix: string;
          context: string[];
          prefixTokens: number;
          suffixTokens: number;
          isFimEnabled: boolean;
        };
        tightTraitBudget: {
          limit: number;
          leaves: Array<{ id: string; value: string }>;
          retainedLeaves: string[];
          context: string[];
          prefix: string;
          prefixTokens: number;
        };
        usageFeedback: {
          providerStatistics: unknown;
          previousUsageStatistics: unknown;
          secondProviderValue: string;
        };
        maxPromptLength: number;
      }>("fim-production-context-adapter");
      const base = fixtureRequest();
      const current = {
        uri: base.document.uri,
        path: base.document.filePath,
        relativePath: base.document.relativePath ?? base.document.filePath,
        scheme: "file",
        languageId: base.document.languageId,
        version: base.document.version,
        text: base.document.text,
        visibleRanges: [],
        lastViewedAt: 100,
        lastEditedAt: 100,
      } as const;
      const providerUri = expected.context.codeSnippets[0].uri;
      const workspace = {
        current,
        ignored: false,
        recentDocuments: [
          {
            ...current,
            uri: providerUri,
            path: "/workspace/p.ts",
            relativePath: "p.ts",
            text: "value();",
            lastViewedAt: 90,
          },
          {
            ...current,
            uri: "file:///workspace/o.ts",
            path: "/workspace/o.ts",
            relativePath: "o.ts",
            text: "value;",
            lastViewedAt: 80,
          },
        ],
        editHistory: [],
        diagnostics: [],
        promptDiagnostics: [],
        neighborSnippets: [
          {
            uri: providerUri,
            path: "p.ts",
            snippet: "duplicate provider neighbor",
            startLine: 0,
            source: "open-tab",
          },
          {
            uri: "file:///workspace/o.ts",
            path: "o.ts",
            snippet: "duplicate open-tab neighbor",
            startLine: 0,
            source: "open-tab",
          },
        ],
        languageContext: {
          items: [
            { kind: "trait", name: "F", value: "V", importance: 2 },
            { kind: "trait", name: "R", value: "N", importance: 1 },
            {
              kind: "snippet",
              uri: providerUri,
              path: "p.ts",
              value: "value();",
              importance: 5,
            },
          ],
          symbols: [],
        },
      } satisfies CopilotWorkspaceContext;
      const context = coreContextFromWorkspace(workspace);
      expect(context.traits).toEqual(expected.context.traits);
      expect(context.codeSnippets).toEqual(
        expected.context.codeSnippets.map(({ path, value, importance }) => ({
          path,
          value,
          importance,
        })),
      );
      expect(context.similarFiles).toEqual(expected.context.similarFiles);
      expect(!context.similarFiles?.some((file) => file.path === "p.ts")).toBe(
        expected.context.providerFileDeduplicated,
      );
      expect(
        context.similarFiles?.filter((file) => file.path === "o.ts"),
      ).toHaveLength(expected.context.neighborFileDeduplicated ? 1 : 2);
      expect(expected.context.turnOffSimilarFiles).toBe(false);

      const providerRequests: CopilotContextProviderRequest[] = [];
      const registry = new CopilotContextProviderRegistry({
        enabledProviderIds: ["official-provider"],
      });
      registry.register(
        {
          id: "official-provider",
          selector: "typescript",
          resolver: {
            resolve: async (request) => {
              providerRequests.push(request);
              return [
                {
                  id: "full-item",
                  name: "Full",
                  value: request.previousUsageStatistics
                    ? `adapted:${request.previousUsageStatistics.usage}`
                    : "initial",
                },
                {
                  id: "partial-item",
                  name: "Partial",
                  value: "partial",
                  origin: "request" as const,
                },
                { id: "none-item", name: "None", value: "none" },
                {
                  id: "excluded-item",
                  uri: "file:///workspace/excluded.ts",
                  value: "excluded",
                },
                {
                  id: "missing-item",
                  uri: vscode.Uri.parse("file:///workspace/missing.ts"),
                  values: [],
                },
              ];
            },
          },
        },
        ["completions"],
      );
      const providerDocument = {
        uri: vscode.Uri.parse(base.document.uri),
        languageId: base.document.languageId,
        version: base.document.version,
        getText: () => base.document.text,
        positionAt: (offset: number) =>
          new vscode.Position(0, Math.max(0, offset)),
      } as vscode.TextDocument;
      const firstProviderItems = await registry.resolve(
        {
          target: "completions",
          document: providerDocument,
          offset: 0,
          completionId: "previous-completion",
        },
        createCancellationSource().token,
      );
      const providerSource = (id: string) => {
        const item = firstProviderItems.find(
          (candidate) => candidate.item.id === id,
        );
        if (!item) throw new Error(`Missing provider context item ${id}.`);
        return item.source;
      };
      registry.markContentExcluded(
        "previous-completion",
        providerSource("excluded-item"),
      );
      registry.submitPromptUsage("previous-completion", [
        {
          source: providerSource("full-item"),
          expectedTokens: 8,
          actualTokens: 8,
        },
        {
          source: providerSource("partial-item"),
          expectedTokens: 8,
          actualTokens: 4,
        },
        {
          source: providerSource("none-item"),
          expectedTokens: 8,
          actualTokens: 0,
        },
      ]);
      expect(
        registry.getUsageStatistics("previous-completion", "official-provider"),
      ).toEqual(expected.usageFeedback.providerStatistics);
      const secondProviderItems = await registry.resolve(
        {
          target: "completions",
          document: providerDocument,
          offset: 0,
          completionId: "current-completion",
        },
        createCancellationSource().token,
      );
      expect(providerRequests[1]?.previousUsageStatistics).toEqual(
        expected.usageFeedback.previousUsageStatistics,
      );
      expect(secondProviderItems[0]?.item).toMatchObject({
        value: expected.usageFeedback.secondProviderValue,
      });
      registry.dispose();

      const model = recordingModel(async () => [choice(" + 1")]);
      const engine = engineWithModel(model, {
        maxPromptCompletionTokens: 512,
        maxCompletionTokens: 64,
        suffixPercent: 20,
      });
      await engine.provide(
        fixtureRequest({ trigger: "automatic", context }),
        createCancellationSource().token,
      );
      expect(model.requests).toHaveLength(1);
      const prompt = model.requests[0].prompt;
      expect(prompt.prefix).toBe(expected.prompt.prefix);
      expect(prompt.suffix).toBe(expected.prompt.suffix);
      expect(prompt.contextFiles.map((file) => file.content)).toEqual(
        expected.prompt.context.filter((value) => value.length > 0),
      );
      expect(prompt.prefixTokens).toBe(expected.prompt.prefixTokens);
      expect(prompt.suffixTokens).toBe(expected.prompt.suffixTokens);
      expect(prompt.prefixTokens + prompt.suffixTokens).toBeLessThanOrEqual(
        expected.maxPromptLength,
      );
      expect(prompt.suffix.length > 0).toBe(expected.prompt.isFimEnabled);

      const tightPrompt = new GhostTextPromptFactory(
        resolveGhostTextBehavior({
          maxPromptCompletionTokens: expected.tightTraitBudget.limit + 1,
          maxCompletionTokens: 1,
          minPromptCharacters: 0,
          suffixPercent: 0,
        }),
        new CharacterGhostTextTokenizer(),
      ).build(
        {
          document: {
            uri: "file:///workspace/tight.ts",
            filePath: "/workspace/tight.ts",
            languageId: "plaintext",
            version: 1,
            text: "CURSOR",
          },
          position: { line: 0, character: 6 },
          trigger: "automatic",
          context: { traits: context.traits },
          multiline: "single",
        },
        createCancellationSource().token,
      );
      expect(tightPrompt.type).toBe("prompt");
      if (tightPrompt.type !== "prompt") throw new Error("Expected prompt.");
      const tightLeaves = [
        { id: "header", value: "Consider this related information:\n" },
        ...(context.traits ?? []).map((trait) => ({
          id: trait.name === "R" ? "runtime" : "framework",
          value: `${trait.name}: ${trait.value}`,
        })),
      ];
      const retainedContext = tightPrompt.prompt.contextFiles.map(
        (file) => file.content,
      );
      const tightOutput = {
        limit: expected.tightTraitBudget.limit,
        leaves: tightLeaves,
        retainedLeaves: [
          ...tightLeaves
            .filter((leaf) =>
              retainedContext.some((value) =>
                value.includes(leaf.value.trim()),
              ),
            )
            .map((leaf) => leaf.id),
          ...(tightPrompt.prompt.prefix.length > 0 ? ["prefix"] : []),
        ],
        context: retainedContext,
        prefix: tightPrompt.prompt.prefix,
        prefixTokens: tightPrompt.prompt.prefixTokens,
      };
      expect(tightOutput).toEqual(expected.tightTraitBudget);
    },
  },
  {
    id: "fim-similar-file-selection",
    assertion:
      "case-sensitive Jaccard selection and ordinary/C++ limits match the reviewed effect baseline",
    run() {
      const expected = expectedFor<{
        options: {
          ordinary: NesSimilarFilesOptions;
          cpp: NesSimilarFilesOptions;
          numberOfSnippets: { ordinary: number; cpp: number };
        };
        caseSensitiveStops: Array<{
          relativePath: string;
          snippet: string;
          score: number;
          startLine: number;
          endLine: number;
        }>;
        fileLimit: {
          candidateCount: number;
          ordinaryPaths: string[];
          cppPaths: string[];
        };
        characterLimit: {
          sourceLength: number;
          ordinaryPaths: string[];
          cppPaths: string[];
        };
        multipleWindows: {
          ordinary: Array<{
            startLine: number;
            endLine: number;
            score: number;
          }>;
          cpp: Array<{ startLine: number; endLine: number; score: number }>;
        };
      }>("fim-similar-file-selection");
      const candidate = (path: string, text: string) => ({
        uri: `file:///workspace/${path}`,
        path,
        text,
      });
      const selection = (
        reference: string,
        documents: readonly ReturnType<typeof candidate>[],
        options: NesSimilarFilesOptions,
      ) =>
        selectSimilarFileSnippets(
          reference,
          reference.length,
          documents,
          options,
        ).map((snippet) => ({
          relativePath: snippet.path,
          snippet: snippet.snippet,
          score: snippet.score,
          startLine: snippet.startLine,
          endLine: snippet.startLine + snippet.snippet.split("\n").length,
        }));
      const stopwordReference = "TODO todo IF if anchor";
      const caseSensitiveStops = selection(
        stopwordReference,
        [
          candidate("src/stopped.ts", "TODO if anchor"),
          candidate("src/retained.ts", "todo IF"),
        ],
        DEFAULT_NES_SIMILAR_FILES_OPTIONS,
      );
      const lateFileReference = "lateFileNeedle";
      const lateFileCandidates = [
        ...Array.from({ length: 20 }, (_value, index) =>
          candidate(`src/noise-${index}.ts`, `unrelated${index}`),
        ),
        candidate("src/late.ts", lateFileReference),
      ];
      const ordinaryLateFiles = selection(
        lateFileReference,
        lateFileCandidates,
        DEFAULT_NES_SIMILAR_FILES_OPTIONS,
      );
      const cppLateFiles = selection(
        lateFileReference,
        lateFileCandidates,
        CPP_NES_SIMILAR_FILES_OPTIONS,
      );
      const oversizedReference = "oversizedNeedle";
      const oversizedSource = [
        oversizedReference,
        ...Array.from(
          { length: 80 },
          (_value, index) => `padding${index}${"x".repeat(150)}`,
        ),
      ].join("\n");
      const oversizedCandidate = [
        candidate("src/oversized.cpp", oversizedSource),
      ];
      const ordinaryOversized = selection(
        oversizedReference,
        oversizedCandidate,
        DEFAULT_NES_SIMILAR_FILES_OPTIONS,
      );
      const cppOversized = selection(
        oversizedReference,
        oversizedCandidate,
        CPP_NES_SIMILAR_FILES_OPTIONS,
      );
      const multiWindowTokens = [
        "multiNeedleA",
        "multiNeedleB",
        "multiNeedleC",
        "multiNeedleD",
      ];
      const multiWindowLines = Array.from({ length: 421 }, (_value, index) => {
        const tokenIndex = index / 120;
        return Number.isInteger(tokenIndex) &&
          tokenIndex < multiWindowTokens.length
          ? multiWindowTokens[tokenIndex]
          : "windowPadding";
      });
      const multiWindowReference = multiWindowTokens.join(" ");
      const multiWindowCandidate = [
        candidate("src/multiple.cpp", multiWindowLines.join("\n")),
      ];
      const summarizeWindows = (snippets: ReturnType<typeof selection>) =>
        snippets.map(({ startLine, endLine, score }) => ({
          startLine,
          endLine,
          score,
        }));
      const output = {
        options: {
          ordinary: DEFAULT_NES_SIMILAR_FILES_OPTIONS,
          cpp: CPP_NES_SIMILAR_FILES_OPTIONS,
          numberOfSnippets: {
            ordinary: DEFAULT_NES_SIMILAR_FILES_OPTIONS.maxTopSnippets,
            cpp: CPP_NES_SIMILAR_FILES_OPTIONS.maxTopSnippets,
          },
        },
        caseSensitiveStops,
        fileLimit: {
          candidateCount: lateFileCandidates.length,
          ordinaryPaths: ordinaryLateFiles.map(
            (snippet) => snippet.relativePath,
          ),
          cppPaths: cppLateFiles.map((snippet) => snippet.relativePath),
        },
        characterLimit: {
          sourceLength: oversizedSource.length,
          ordinaryPaths: ordinaryOversized.map(
            (snippet) => snippet.relativePath,
          ),
          cppPaths: cppOversized.map((snippet) => snippet.relativePath),
        },
        multipleWindows: {
          ordinary: summarizeWindows(
            selection(
              multiWindowReference,
              multiWindowCandidate,
              DEFAULT_NES_SIMILAR_FILES_OPTIONS,
            ),
          ),
          cpp: summarizeWindows(
            selection(
              multiWindowReference,
              multiWindowCandidate,
              CPP_NES_SIMILAR_FILES_OPTIONS,
            ),
          ),
        },
      };
      expect(output).toEqual(expected);

      const base = fixtureRequest().document;
      const current = {
        uri: "file:///workspace/src/current.cpp",
        path: "/workspace/src/current.cpp",
        relativePath: "src/current.cpp",
        scheme: "file",
        languageId: "cpp",
        version: base.version,
        text: lateFileReference,
        visibleRanges: [],
        lastViewedAt: 1_000,
        lastEditedAt: 1_000,
      } as const;
      const workspace = {
        current,
        ignored: false,
        recentDocuments: lateFileCandidates.map((document, index) => ({
          ...current,
          uri: document.uri,
          path: `/workspace/${document.path}`,
          relativePath: document.path,
          text: document.text,
          lastViewedAt: 900 - index,
          lastEditedAt: 900 - index,
        })),
        editHistory: [],
        diagnostics: [],
        promptDiagnostics: [],
        neighborSnippets: [
          {
            uri:
              lateFileCandidates.at(-1)?.uri ?? "file:///workspace/src/late.ts",
            path: "src/late.ts",
            snippet: lateFileReference,
            startLine: 0,
            source: "open-tab",
          },
        ],
        languageContext: { items: [], symbols: [] },
      } satisfies CopilotWorkspaceContext;
      const context = coreContextFromWorkspace(workspace);
      expect(context.similarFiles).toHaveLength(20);
      expect(context.similarFiles?.map((file) => file.path)).not.toContain(
        "src/late.ts",
      );
      const promptResult = new GhostTextPromptFactory(
        resolveGhostTextBehavior({
          maxPromptCompletionTokens: 4_096,
          maxCompletionTokens: 64,
          minPromptCharacters: 0,
          suffixPercent: 0,
        }),
        new CharacterGhostTextTokenizer(),
      ).build(
        {
          document: {
            uri: current.uri,
            filePath: current.path,
            relativePath: current.relativePath,
            languageId: current.languageId,
            text: current.text,
            version: current.version,
          },
          position: { line: 0, character: current.text.length },
          trigger: "automatic",
          context,
          multiline: "single",
        },
        createCancellationSource().token,
      );
      expect(promptResult.type).toBe("prompt");
      if (promptResult.type !== "prompt") throw new Error("Expected prompt.");
      expect(
        promptResult.prompt.contextFiles.some((file) =>
          file.content.includes(expected.fileLimit.cppPaths[0]),
        ),
      ).toBe(false);
    },
  },
  {
    id: "fim-recent-edits-reducer",
    assertion:
      "stateful production reducer matches official debounce, merge, limits, and summary bytes",
    run() {
      const expected = expectedFor<{
        config: {
          maxFiles: number;
          maxEdits: number;
          diffContextLines: number;
          editMergeLineDistance: number;
          maxCharsPerEdit: number;
          debounceTimeout: number;
          maxLinesPerEdit: number;
        };
        debounce: { beforeDeadlineCount: number; atDeadlineCount: number };
        merged: {
          editCount: number;
          uri: string;
          path: string;
          summary: string;
        };
        filters: {
          whitespace: null;
          tooManyLines: null;
          oversizedCharacterEditCount: number;
        };
        ignoredLargeDocument: {
          preservedState: boolean;
          currentAfterLarge: string;
          editCountAfterLarge: number;
          currentAfterSmall: string;
          editCountAfterSmall: number;
          finalSummary: string;
        };
        multiRoot: {
          edits: Array<{ uri: string; path: string; summary: string }>;
          identities: string[];
          displayPaths: string[];
          promptBytes: string;
        };
        proximityBoundary: {
          line101Filtered: boolean;
          line102Filtered: boolean;
        };
      }>("fim-recent-edits-reducer");
      expect(FIM_RECENT_EDITS_CONFIG).toMatchObject({
        maxFiles: expected.config.maxFiles,
        maxEdits: expected.config.maxEdits,
        diffContextLines: expected.config.diffContextLines,
        editMergeLineDistance: expected.config.editMergeLineDistance,
        maxCharsPerEdit: expected.config.maxCharsPerEdit,
        debounceTimeoutMs: expected.config.debounceTimeout,
        maxLinesPerEdit: expected.config.maxLinesPerEdit,
      });
      const tracker = new FimRecentEditsTracker();
      const base = [
        "const zero = 0;",
        "const first = 1;",
        "const second = 2;",
        "const tail = true;",
      ].join("\n");
      const first = base.replace("first = 1", "first = 10");
      const second = first.replace("second = 2", "second = 20");
      const events = [
        {
          uri: expected.merged.uri,
          path: expected.merged.path,
          before: base,
          after: first,
          timestamp: 100,
        },
        {
          uri: expected.merged.uri,
          path: expected.merged.path,
          before: first,
          after: second,
          timestamp: 400,
        },
      ];
      expect(tracker.ingest(events, 899)).toHaveLength(
        expected.debounce.beforeDeadlineCount,
      );
      const merged = tracker.ingest(events, 900);
      expect(merged).toHaveLength(expected.debounce.atDeadlineCount);
      expect(merged).toHaveLength(expected.merged.editCount);
      expect(merged[0]).toMatchObject({
        uri: expected.merged.uri,
        path: expected.merged.path,
        summary: expected.merged.summary,
      });

      const whitespace = new FimRecentEditsTracker();
      expect(
        whitespace.ingest(
          [
            {
              uri: "file:///workspace/src/whitespace.ts",
              path: "src/whitespace.ts",
              before: "const value = 1;",
              after: "  const value = 1;  ",
              timestamp: 1,
            },
          ],
          501,
        )[0] ?? null,
      ).toBe(expected.filters.whitespace);
      const lines = new FimRecentEditsTracker();
      expect(
        lines.ingest(
          [
            {
              uri: "file:///workspace/src/lines.ts",
              path: "src/lines.ts",
              before: "before",
              after: Array.from(
                { length: 11 },
                (_value, index) => `line ${index}`,
              ).join("\n"),
              timestamp: 1,
            },
          ],
          501,
        )[0] ?? null,
      ).toBe(expected.filters.tooManyLines);
      const large = new FimRecentEditsTracker();
      large.ingest(
        [
          {
            uri: "file:///workspace/src/large.ts",
            path: "src/large.ts",
            before: "before",
            after: "x".repeat(2_001),
            timestamp: 1,
          },
        ],
        501,
      );
      expect(large.getState().edits).toBe(
        expected.filters.oversizedCharacterEditCount,
      );

      const ignoredLargeUri = "file:///workspace/src/ignored-large.ts";
      const ignoredLargeBase = "const value = 1;";
      const ignoredLargeEdited = "const value = 2;";
      const ignoredLargeFinal = "const value = 3;";
      const ignoredLarge = new FimRecentEditsTracker();
      const initialIgnoredLargeSummaries = ignoredLarge.ingest(
        [
          {
            uri: ignoredLargeUri,
            path: "src/ignored-large.ts",
            before: ignoredLargeBase,
            after: ignoredLargeEdited,
            timestamp: 1,
          },
        ],
        501,
      );
      const summariesBeforeLarge = ignoredLarge.ingest(
        [
          {
            uri: ignoredLargeUri,
            path: "src/ignored-large.ts",
            before: ignoredLargeEdited,
            after: "x".repeat(2 * 1024 * 1024 + 1),
            timestamp: 1_000,
          },
        ],
        1_500,
      );
      const afterLarge = ignoredLarge
        .getState()
        .documents.find((document) => document.uri === ignoredLargeUri);
      const finalSummaries = ignoredLarge.ingest(
        [
          {
            uri: ignoredLargeUri,
            path: "src/ignored-large.ts",
            before: "x".repeat(2 * 1024 * 1024 + 1),
            after: ignoredLargeFinal,
            timestamp: 2_000,
          },
        ],
        2_500,
      );
      const afterSmall = ignoredLarge
        .getState()
        .documents.find((document) => document.uri === ignoredLargeUri);
      const ignoredLargeOutput = {
        preservedState:
          summariesBeforeLarge[0]?.summary ===
          initialIgnoredLargeSummaries[0]?.summary,
        currentAfterLarge: afterLarge?.currentContent,
        editCountAfterLarge: afterLarge?.editCount,
        currentAfterSmall: afterSmall?.currentContent,
        editCountAfterSmall: afterSmall?.editCount,
        finalSummary: finalSummaries.at(-1)?.summary,
      };
      expect(ignoredLargeOutput).toEqual(expected.ignoredLargeDocument);

      const promptForRecentEdits = (
        recentEdits: NonNullable<GhostTextRequest["context"]>["recentEdits"],
      ) =>
        new GhostTextPromptFactory(
          resolveGhostTextBehavior({
            maxPromptCompletionTokens: 4_096,
            maxCompletionTokens: 64,
            minPromptCharacters: 0,
            suffixPercent: 0,
          }),
          new CharacterGhostTextTokenizer(),
        ).build(
          fixtureRequest({
            document: {
              ...fixtureRequest().document,
              uri: "file:///active/current.ts",
              filePath: "/active/current.ts",
              relativePath: "current.ts",
              text: "const current = true;",
            },
            position: { line: 0, character: 21 },
            context: { recentEdits },
          }),
          createCancellationSource().token,
        );
      const multiRootPrompt = promptForRecentEdits(
        expected.multiRoot.edits.map((edit, index) => ({
          ...edit,
          startLine: 200 + index,
          endLine: 200 + index,
        })),
      );
      if (multiRootPrompt.type !== "prompt") {
        throw new Error("Expected multi-root recent prompt.");
      }
      const renderedRecent = multiRootPrompt.prompt.contextFiles.find((file) =>
        file.content.startsWith("These are recently edited files."),
      );
      expect({
        identities: expected.multiRoot.edits.map((edit) => edit.uri),
        displayPaths: expected.multiRoot.edits.map((edit) => edit.path),
        promptBytes: renderedRecent?.content,
      }).toEqual({
        identities: expected.multiRoot.identities,
        displayPaths: expected.multiRoot.displayPaths,
        promptBytes: expected.multiRoot.promptBytes,
      });

      const proximityFiltered = (line: number): boolean => {
        const prompt = new GhostTextPromptFactory(
          resolveGhostTextBehavior({
            maxPromptCompletionTokens: 4_096,
            maxCompletionTokens: 64,
            minPromptCharacters: 0,
            suffixPercent: 0,
          }),
          new CharacterGhostTextTokenizer(),
        ).build(
          fixtureRequest({
            document: {
              ...fixtureRequest().document,
              uri: expected.merged.uri,
              text: "const current = true;",
            },
            position: { line: 0, character: 21 },
            context: {
              recentEdits: [
                {
                  uri: expected.merged.uri,
                  path: expected.merged.path,
                  summary: expected.merged.summary,
                  startLine: line,
                  endLine: line,
                },
              ],
            },
          }),
          createCancellationSource().token,
        );
        return (
          prompt.type === "prompt" &&
          !prompt.prompt.contextFiles.some((file) =>
            file.content.startsWith("These are recently edited files."),
          )
        );
      };
      expect({
        line101Filtered: proximityFiltered(101),
        line102Filtered: proximityFiltered(102),
      }).toEqual(expected.proximityBoundary);
    },
  },
  {
    id: "fim-notebook-context",
    assertion:
      "production notebook virtual document and cursor mapping match official compatible-cell execution",
    run() {
      const expected = expectedFor<{
        prependedText: string;
        virtualText: string;
        virtualCursorOffset: number;
        virtualPosition: { line: number; character: number };
        activeCellOffset: number;
        activeCellLineOffset: number;
        includedCellIndices: number[];
        excludedCellIndices: number[];
      }>("fim-notebook-context");
      const activeText = "const active = same + alias;\nactive";
      const result = prepareFimNotebookContext({
        activeCellIndex: 3,
        activeLanguageId: "typescript",
        activeText,
        activeCursorOffset: activeText.length,
        cells: [
          { index: 0, languageId: "typescript", text: "const same = 1;" },
          {
            index: 1,
            languageId: "typescriptreact",
            text: "const alias = <div />;\nrender(alias);",
          },
          { index: 2, languageId: "python", text: "incompatible = True" },
          { index: 3, languageId: "typescript", text: activeText },
        ],
      });
      const beforeCursor = result.text
        .slice(0, result.cursorOffset)
        .split("\n");
      const position = {
        line: beforeCursor.length - 1,
        character: beforeCursor.at(-1)?.length ?? 0,
      };
      expect(result).toMatchObject({
        prependedText: expected.prependedText,
        text: expected.virtualText,
        cursorOffset: expected.virtualCursorOffset,
        activeCellOffset: expected.activeCellOffset,
        activeCellLineOffset: expected.activeCellLineOffset,
      });
      expect(position).toEqual(expected.virtualPosition);
      expect(
        fimNotebookLineInActiveCell(position.line, result.activeCellLineOffset),
      ).toBe(1);
      expect(expected.includedCellIndices).toEqual([0, 1]);
      expect(expected.excludedCellIndices).toEqual([2]);
    },
  },
  {
    id: "fim-prompt-cascade-budget",
    assertion:
      "registered split-context suffix reserve, shared budget, chunk removal, and line elision match the reviewed effect baseline",
    run() {
      const expected = expectedFor<{
        limits: unknown;
        sharedBudget: unknown;
        chunkRemoval: unknown;
        lineElision: unknown;
        o200kTruncation: {
          takeFirst: {
            input: string;
            limit: number;
            text: string;
            tokens: number[];
          };
          takeLast: {
            input: string;
            limit: number;
            text: string;
            tokens: number[];
          };
        };
      }>("fim-prompt-cascade-budget");
      const tokenizer = new CharacterGhostTextTokenizer();
      const block = (
        path: string,
        type: "context" | "prefix",
        value: string,
        weight: number,
        group?: "stable" | "volatile",
        chunk?: string,
      ): GhostTextPromptRenderBlock => ({
        path,
        type,
        value,
        weight,
        ...(group ? { group } : {}),
        ...(chunk ? { chunk } : {}),
      });
      const render = (
        blocks: readonly GhostTextPromptRenderBlock[],
        suffix: string,
        limit: number,
        suffixPercent: number,
      ) => {
        const result = renderGhostTextSplitContextPrompt(
          blocks,
          suffix,
          limit,
          suffixPercent,
          tokenizer,
        );
        return {
          suffix: result.suffix,
          suffixTokens: result.suffixTokens,
          prefix: result.prefix,
          context: result.context,
          prefixTokens: result.prefixTokens,
          blocks: result.blocks.map((rendered, index) => ({
            componentPath: rendered.path,
            type: rendered.type,
            weight: blocks[index].weight,
            index:
              blocks[index].group === "stable"
                ? 0
                : blocks[index].group === "volatile"
                  ? 1
                  : null,
            originalValue: blocks[index].value,
            originalTokens: tokenizer.count(blocks[index].value),
            elidedValue: rendered.value,
            elidedTokens: rendered.tokens,
          })),
        };
      };
      const sharedBlocks = [
        block("$.Context.Low", "context", "CTX-LOW\n", 0.2, "stable"),
        block("$.Context.High", "context", "CTX-HIGH\n", 0.99, "volatile"),
        block("$.CurrentFile.BeforeCursor", "prefix", "PREFIX-OLD\nCURSOR", 1),
      ];
      const sharedRendered = renderGhostTextSplitContextPrompt(
        sharedBlocks,
        "SUFFIX-LONG",
        40,
        20,
        tokenizer,
      );
      const emptyRendered = renderGhostTextSplitContextPrompt(
        [],
        "",
        40,
        20,
        tokenizer,
      );
      const output = {
        limits: {
          nonEmptySuffix: {
            prefixTokenLimit: sharedRendered.prefixTokenLimit,
            suffixTokenLimit: sharedRendered.suffixTokenLimit,
          },
          emptySuffix: {
            prefixTokenLimit: emptyRendered.prefixTokenLimit,
            suffixTokenLimit: emptyRendered.suffixTokenLimit,
          },
          reservedForSuffixEncoding:
            40 -
            sharedRendered.prefixTokenLimit -
            sharedRendered.suffixTokenLimit,
        },
        sharedBudget: render(sharedBlocks, "SUFFIX-LONG", 40, 20),
        chunkRemoval: render(
          [
            block("$.Chunk.A", "context", "CHUNK-A\n", 0.1, "stable", "pair"),
            block("$.Chunk.B", "context", "CHUNK-B\n", 0.9, "stable", "pair"),
            block("$.CurrentFile.BeforeCursor", "prefix", "CURSOR", 1),
          ],
          "",
          15,
          0,
        ),
        lineElision: render(
          [
            block(
              "$.CurrentFile.BeforeCursor",
              "prefix",
              "line-one\nline-two\nCURSOR",
              1,
            ),
          ],
          "",
          12,
          0,
        ),
        o200kTruncation: {
          takeFirst: {
            input: expected.o200kTruncation.takeFirst.input,
            limit: expected.o200kTruncation.takeFirst.limit,
            ...new O200kGhostTextTokenizer().takeFirst(
              expected.o200kTruncation.takeFirst.input,
              expected.o200kTruncation.takeFirst.limit,
            ),
          },
          takeLast: {
            input: expected.o200kTruncation.takeLast.input,
            limit: expected.o200kTruncation.takeLast.limit,
            ...new O200kGhostTextTokenizer().takeLast(
              expected.o200kTruncation.takeLast.input,
              expected.o200kTruncation.takeLast.limit,
            ),
          },
        },
      };
      expect(output).toEqual(expected);
    },
  },
  {
    id: "fim-current-cache",
    assertion:
      "typing-as-suggested reuses current/cache state without another request",
    async run() {
      const expected = expectedFor<{
        typing: [{ completionText: string }[], string];
        cache: [{ completionText: string }[], string];
      }>("fim-current-cache");
      const model = recordingModel(async () => [choice(" value + 1")]);
      const engine = engineWithModel(model);
      const token = createCancellationSource().token;
      const base = fixtureRequest({
        document: {
          ...fixtureRequest().document,
          text: "const result =",
          version: 1,
        },
        position: { line: 0, character: 14 },
        trigger: "automatic",
      });
      const first = await engine.provide(base, token);
      expect(first.type).toBe("success");
      const second = await engine.provide(
        {
          ...base,
          document: { ...base.document, text: "const result = v", version: 2 },
          position: { line: 0, character: 16 },
        },
        token,
      );

      expect(model.requests).toHaveLength(1);
      expect(second.type).toBe("success");
      if (second.type !== "success")
        throw new Error("Expected cached success.");
      expect(expected.typing[1]).toBe("TypingAsSuggested");
      expect(expected.cache[1]).toBe("Cache");
      expect(second.list.source).toBe("typing-as-suggested");
      expect(second.list.items[0].displayText).toBe(
        expected.typing[0][0].completionText.slice(2),
      );
      expect(engine.getDebugState()).toMatchObject({
        cacheEntries: 1,
        currentClientCompletionId: "model-request-choice-0",
      });
    },
  },
  {
    id: "fim-context-postprocess",
    assertion:
      "duplicate next lines are rejected while closing lines are snipped",
    async run() {
      const expected = expectedFor<{
        duplicate: null;
        closing: { completionText: string } | null;
        retained: { completionText: string };
      }>("fim-context-postprocess");
      const documentText = "function run() {\n  work();\n}\n";
      const request = fixtureRequest({
        document: {
          ...fixtureRequest().document,
          text: documentText,
        },
        position: { line: 0, character: 16 },
      });
      const prompt = {
        prefix: "function run() {",
        suffix: "",
        contextFiles: [],
        prefixTokens: 16,
        suffixTokens: 0,
        trailingWhitespace: "",
        selectedCompletionLineLengthIncrease: 0,
        virtualDocumentText: documentText,
        virtualCursorOffset: 16,
      };
      const closingDocumentText = "function run() {\n}\n";
      const closingRequest = fixtureRequest({
        document: {
          ...fixtureRequest().document,
          text: closingDocumentText,
        },
        position: { line: 0, character: 16 },
      });
      const closingPrompt = {
        ...prompt,
        virtualDocumentText: closingDocumentText,
      };
      const behavior = resolveGhostTextBehavior({ minPromptCharacters: 0 });
      const tokenizer = new CharacterGhostTextTokenizer();
      const duplicate = await processGhostTextChoice(
        request,
        prompt,
        choice("work();"),
        false,
        false,
        behavior,
        tokenizer,
      );
      const closing = await processGhostTextChoice(
        closingRequest,
        closingPrompt,
        choice("\n  work();\n}"),
        true,
        false,
        behavior,
        tokenizer,
      );
      const retained = await processGhostTextChoice(
        request,
        prompt,
        choice(" value + 1"),
        false,
        false,
        behavior,
        tokenizer,
      );
      expect(duplicate ?? null).toBe(expected.duplicate);
      expect(closing?.choice.completionText ?? null).toBe(
        expected.closing?.completionText ?? null,
      );
      expect(retained?.choice.completionText).toBe(
        expected.retained.completionText,
      );
    },
  },
  {
    id: "fim-speculative-request",
    assertion:
      "LRU scheduling, owned transport, EOL survival, cache fill, and async compatibility match official behavior",
    async run() {
      const expected = expectedFor<{
        scheduled: { callbackType: string; appliedText: string };
        queue: {
          capacity: number;
          oldestEvicted: boolean;
          newestExecutionCount: number;
        };
        shownTransport: {
          callCount: number;
          independentFromCaller: boolean;
          isSpeculative: boolean;
          completionFillsCache: boolean;
        };
        endOfLife: {
          itemDoesNotCancel: boolean;
          listDoesNotCancel: boolean;
        };
        asyncCompatibility: {
          matching: boolean;
          prefixMismatch: boolean;
          suffixMismatch: boolean;
        };
      }>("fim-speculative-request");
      const queueModel = recordingModel(async (_request, _token, call) => [
        choice(" value", 0, `queue-${call}`),
      ]);
      const queueEngine = engineWithModel(queueModel);
      const queueItems: Array<{ itemId: string }> = [];
      for (let index = 0; index <= expected.queue.capacity; index++) {
        const text = `const queue${index} =`;
        const result = await queueEngine.provide(
          fixtureRequest({
            document: {
              ...fixtureRequest().document,
              text,
              version: index + 1,
            },
            position: { line: 0, character: text.length },
            trigger: "automatic",
            context: undefined,
          }),
          createCancellationSource().token,
        );
        if (result.type !== "success") {
          throw new Error("Expected queued GhostText completion.");
        }
        queueItems.push({ itemId: result.list.items[0].id });
      }
      const queueCapacity = queueEngine.getDebugState().speculativeEntries;
      expect(queueCapacity).toBe(expected.queue.capacity);
      const callsBeforeShown = queueModel.requests.length;
      queueEngine.handleDidShowCompletionItem(queueItems[0].itemId);
      await flushMicrotasks(4);
      const oldestEvicted = queueModel.requests.length === callsBeforeShown;
      queueEngine.handleDidShowCompletionItem(
        queueItems[queueItems.length - 1].itemId,
      );
      await flushMicrotasks(12);
      const newestExecutionCount =
        queueModel.requests.length - callsBeforeShown;

      const speculativeCompletion =
        createDeferred<readonly GhostTextModelChoice[]>();
      const model = recordingModel(async (_request, _token, call) =>
        call === 1
          ? [choice(expected.scheduled.appliedText)]
          : speculativeCompletion.promise,
      );
      const engine = engineWithModel(model);
      const parent = createCancellationSource();
      const sourceText = "const result =";
      const result = await engine.provide(
        fixtureRequest({
          document: {
            ...fixtureRequest().document,
            text: sourceText,
            version: 1,
          },
          position: { line: 0, character: sourceText.length },
          trigger: "automatic",
          context: undefined,
        }),
        parent.token,
      );
      if (result.type !== "success")
        throw new Error("Expected GhostText success.");
      const scheduledCallbackType =
        engine.getDebugState().speculativeEntries === 1
          ? "function"
          : "missing";
      const initialCacheEntries = engine.getDebugState().cacheEntries;
      engine.handleDidShowCompletionItem(result.list.items[0].id);
      await flushMicrotasks(8);
      expect(model.requests).toHaveLength(2);
      const speculativeToken = model.tokens[1];
      parent.cancel();
      const independentFromCaller = !speculativeToken.isCancellationRequested;
      engine.handleEndOfLifetime(result.list.items[0].id, "discarded");
      const itemDoesNotCancel = !speculativeToken.isCancellationRequested;
      engine.handleListEndOfLifetime(result.list.id);
      const listDoesNotCancel = !speculativeToken.isCancellationRequested;
      speculativeCompletion.resolve([choice(" + 1", 0, "speculative-result")]);
      await flushMicrotasks(16);
      const shownTransport = {
        callCount: model.requests.length - 1,
        independentFromCaller,
        isSpeculative: model.requests[1].prompt.virtualDocumentText.includes(
          `${sourceText}${expected.scheduled.appliedText}`,
        ),
        completionFillsCache:
          engine.getDebugState().cacheEntries > initialCacheEntries,
      };

      const cancellationFor = async (
        nextText: string,
        nextPosition: { line: number; character: number },
      ): Promise<boolean> => {
        const pending = createDeferred<readonly GhostTextModelChoice[]>();
        const pendingModel = recordingModel(async (_request, _token, call) =>
          call === 1 ? pending.promise : [choice(" fresh")],
        );
        const pendingEngine = engineWithModel(pendingModel);
        const baseText = "const value = \nfirst();";
        const first = pendingEngine.provide(
          fixtureRequest({
            document: { ...fixtureRequest().document, text: baseText },
            position: { line: 0, character: "const value = ".length },
            trigger: "automatic",
            context: undefined,
          }),
          createCancellationSource().token,
        );
        await flushMicrotasks(6);
        const second = pendingEngine.provide(
          fixtureRequest({
            document: {
              ...fixtureRequest().document,
              text: nextText,
              version: 2,
            },
            position: nextPosition,
            trigger: "automatic",
            context: undefined,
          }),
          createCancellationSource().token,
        );
        await flushMicrotasks(8);
        const cancelled = pendingModel.tokens[0].isCancellationRequested;
        pending.resolve([choice(" typed")]);
        await Promise.allSettled([first, second]);
        return cancelled;
      };
      const matchingCancelled = await cancellationFor(
        "const value = t\nfirst();",
        { line: 0, character: "const value = t".length },
      );
      const prefixMismatchCancelled = await cancellationFor(
        "const other = \nfirst();",
        { line: 0, character: "const other = ".length },
      );
      const suffixMismatchCancelled = await cancellationFor(
        "const value = \nsecond();",
        { line: 0, character: "const value = ".length },
      );
      const output = {
        scheduled: {
          callbackType: scheduledCallbackType,
          appliedText: expected.scheduled.appliedText,
        },
        queue: {
          capacity: queueCapacity,
          oldestEvicted,
          newestExecutionCount,
        },
        shownTransport,
        endOfLife: { itemDoesNotCancel, listDoesNotCancel },
        asyncCompatibility: {
          matching: !matchingCancelled,
          prefixMismatch: !prefixMismatchCancelled,
          suffixMismatch: !suffixMismatchCancelled,
        },
      };
      expect(output).toEqual(expected);
    },
  },
  {
    id: "fim-default-block-mode",
    assertion:
      "default language modes match ConfigBlockModeConfig and StatementTree support",
    run() {
      const expected = expectedFor<{
        defaultBlockModes: Record<string, string>;
      }>("fim-default-block-mode");
      const behavior = resolveGhostTextBehavior(undefined);
      const actual = Object.fromEntries(
        Object.keys(expected.defaultBlockModes).map((languageId) => [
          languageId,
          resolveGhostTextBlockMode(behavior, languageId),
        ]),
      );
      expect(actual).toEqual(expected.defaultBlockModes);
    },
  },
  {
    id: "fim-multiline",
    assertion:
      "network strategies and accepted MoreMultiline requests match the reviewed effect baseline",
    async run() {
      const expected = expectedFor<{
        requestMultiline: boolean;
        blockMode: string;
        maxTokens: number;
        trimmed: string;
        defaultBlockModes: Record<string, string>;
        streamedSplitter: {
          lookaheads: {
            emptyBlock: number;
            blockEnd: number;
            other: number;
          };
          input: {
            languageId: string;
            prefix: string;
            completion: string;
            choiceIndex: number;
          };
          firstSegment: {
            text: string;
            finishOffset: number;
            choiceIndex: number;
            generatedChoiceIndex: number | null;
          };
          cachedSegments: Array<{
            prefixAddition: string;
            completionText: string;
            choiceIndex: number;
            generatedChoiceIndex: number;
          }>;
        };
        requestStrategies: Record<
          | "normalSingleline"
          | "afterAccept"
          | "moreMultiline"
          | "moreMultilineAfterAccept",
          {
            requestMultiline: boolean;
            blockMode: string;
            stop: string[] | null;
            maxTokens: number | null;
          }
        >;
      }>("fim-multiline");
      const behavior = resolveGhostTextBehavior({
        minPromptCharacters: 0,
        multilineAfterAcceptLines: 1,
      });
      const capture = async (
        languageId: string,
        text: string,
        position: GhostTextRequest["position"],
        multiline: NonNullable<GhostTextRequest["multiline"]>,
        afterAcceptedCompletion: boolean,
        id: string,
      ) => {
        const request = fixtureRequest({
          document: {
            ...fixtureRequest().document,
            uri: `file:///workspace/src/${id}`,
            filePath: `/workspace/src/${id}`,
            relativePath: `src/${id}`,
            languageId,
            text,
          },
          position,
          trigger: "automatic",
          context: undefined,
          multiline,
        });
        const promptResult = new GhostTextPromptFactory(
          behavior,
          new CharacterGhostTextTokenizer(),
        ).build(request, createCancellationSource().token);
        expect(promptResult.type).toBe("prompt");
        if (promptResult.type !== "prompt") throw new Error("Expected prompt.");
        const multilineStrategy = await determineGhostTextMultilineStrategy(
          request,
          promptResult.prompt,
          behavior,
          afterAcceptedCompletion,
        );
        const networkStrategy = buildGhostTextNetworkStrategy(
          request,
          promptResult.prompt,
          behavior,
          multilineStrategy.requestMultiline,
          afterAcceptedCompletion,
          multilineStrategy,
        );
        const sent: RecordedFimRequest[] = [];
        const boundary = new FimGhostTextModelBoundary(
          new RecordingCompletionModel((_call, fimRequest) => {
            sent.push(fimRequest);
            return { text: " completion" };
          }),
          sequenceId(`multiline-${id}`),
        );
        await boundary.complete(
          {
            requestId: `multiline-${id}`,
            prompt: promptResult.prompt,
            filePath: request.document.filePath,
            candidateCount: 1,
            ...(networkStrategy.stop === undefined
              ? {}
              : { stop: networkStrategy.stop }),
            ...(networkStrategy.maxTokens === undefined
              ? {}
              : { maxTokens: networkStrategy.maxTokens }),
            languageId,
            nextIndent: networkStrategy.nextIndent,
            trimByIndentation: networkStrategy.trimByIndentation,
            promptTokens: promptResult.prompt.prefixTokens,
            suffixTokens: promptResult.prompt.suffixTokens,
            codeAnnotations: false,
          },
          createCancellationSource().token,
        );
        expect(sent).toHaveLength(1);
        return {
          requestMultiline: multilineStrategy.requestMultiline,
          blockMode: multilineStrategy.blockMode,
          stop: sent[0].options.stop ?? null,
          maxTokens: sent[0].options.maxTokens ?? null,
          request,
          prompt: promptResult.prompt,
          multilineStrategy,
        };
      };
      const normal = await capture(
        "ruby",
        "value = 1",
        { line: 0, character: 9 },
        "single",
        false,
        "normal.rb",
      );
      const afterAccept = await capture(
        "ruby",
        "value = 1",
        { line: 0, character: 9 },
        "auto",
        true,
        "accepted.rb",
      );
      const moreMultiline = await capture(
        "typescript",
        "function run() {\n  \n}\n",
        { line: 1, character: 2 },
        "multi",
        false,
        "multi.ts",
      );
      const moreMultilineAfterAccept = await capture(
        "typescript",
        "function run() {\n  \n}\n",
        { line: 1, character: 2 },
        "multi",
        true,
        "accepted.ts",
      );
      const normalize = (value: Awaited<ReturnType<typeof capture>>) => ({
        requestMultiline: value.requestMultiline,
        blockMode: value.blockMode,
        stop: value.stop,
        maxTokens: value.maxTokens,
      });
      const splitInput = expected.streamedSplitter.input;
      const splitSegments = await splitGhostTextCompletion(
        splitInput.prefix,
        splitInput.completion,
        splitInput.languageId,
        ghostTextTrimmerLookahead("mid-block"),
        async (_languageId, _prefix, completion) => {
          const newline = completion.indexOf("\n");
          return newline < 0 ? undefined : newline + 1;
        },
      );
      const firstSplitSegment = splitSegments[0];
      if (!firstSplitSegment) throw new Error("Expected first split segment.");
      const output = {
        requestMultiline: afterAccept.requestMultiline,
        blockMode: afterAccept.blockMode,
        maxTokens: afterAccept.maxTokens,
        trimmed: await trimMultilineCompletion(
          "\n  first();\n  second();\n  third();",
          afterAccept.request.document.languageId,
          behavior,
          true,
          afterAccept.prompt.virtualDocumentText,
          afterAccept.prompt.virtualCursorOffset,
          afterAccept.multilineStrategy,
        ),
        defaultBlockModes: Object.fromEntries(
          Object.keys(expected.defaultBlockModes).map((languageId) => [
            languageId,
            resolveGhostTextBlockMode(behavior, languageId),
          ]),
        ),
        streamedSplitter: {
          lookaheads: {
            emptyBlock: ghostTextTrimmerLookahead("empty-block"),
            blockEnd: ghostTextTrimmerLookahead("block-end"),
            other: ghostTextTrimmerLookahead("mid-block"),
          },
          input: splitInput,
          firstSegment: {
            text: firstSplitSegment.completionText,
            finishOffset: firstSplitSegment.completionText.length,
            choiceIndex: splitInput.choiceIndex,
            generatedChoiceIndex:
              firstSplitSegment.generatedChoiceIndex ?? null,
          },
          cachedSegments: splitSegments.slice(1).map((segment) => ({
            prefixAddition: segment.prefixAddition,
            completionText: segment.completionText,
            choiceIndex: splitInput.choiceIndex,
            generatedChoiceIndex: segment.generatedChoiceIndex ?? 0,
          })),
        },
        requestStrategies: {
          normalSingleline: normalize(normal),
          afterAccept: normalize(afterAccept),
          moreMultiline: normalize(moreMultiline),
          moreMultilineAfterAccept: normalize(moreMultilineAfterAccept),
        },
      };
      expect(output).toEqual(expected);
    },
  },
];
