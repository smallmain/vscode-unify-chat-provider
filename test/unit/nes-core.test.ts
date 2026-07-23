import { describe, expect, it, vi } from "vitest";
import { COPILOT_BEHAVIOR_CONFIG } from "../../src/chat-lib/core/behavior-config";
import {
  NextEditCache,
  type NesCacheEntry,
} from "../../src/chat-lib/core/nes/cache";
import {
  buildOfficialNesPrompt,
  createUnifiedHistoryDiff,
} from "../../src/chat-lib/core/nes/prompt";
import {
  chunksFromString,
  filterOfficialNesEdits,
  parseOfficialNesResponse,
  streamOfficialNesResponse,
} from "../support/nes-response";
import {
  hasUserTypedSinceNesRequestStarted,
  NesStringEdit,
  NesStringReplacement,
} from "../../src/chat-lib/core/nes/string-edit";
import { runNesCrossFileOpenContinuation } from "../../src/chat-lib/core/nes/cursor-predictor";
import type {
  NesDocumentContext,
  NesPromptContext,
  NesTextEdit,
} from "../../src/chat-lib/core/nes/types";

function document(
  relativePath: string,
  text: string,
  overrides: Partial<NesDocumentContext> = {},
): NesDocumentContext {
  return {
    uri: `file:///workspace/${relativePath}`,
    path: `/workspace/${relativePath}`,
    relativePath,
    languageId: "typescript",
    version: 1,
    text,
    workspaceRoot: "/workspace",
    ...overrides,
  };
}

const sourceLines = Array.from(
  { length: 12 },
  (_value, index) => `const value${index} = ${index};`,
);
const sourceText = sourceLines.join("\n");
const cursorLine = 5;
const cursorOffset =
  sourceLines.slice(0, cursorLine).join("\n").length +
  (cursorLine > 0 ? 1 : 0) +
  "const value5".length;

describe("NES request edit state", () => {
  it("treats only an explicit empty tracked edit as no user typing", () => {
    expect(hasUserTypedSinceNesRequestStarted(NesStringEdit.empty)).toBe(false);
    expect(
      hasUserTypedSinceNesRequestStarted(
        NesStringEdit.single(
          new NesStringReplacement({ start: 0, endOffset: 0 }, "typed"),
        ),
      ),
    ).toBe(true);
    expect(hasUserTypedSinceNesRequestStarted(undefined)).toBe(true);
  });

  const runCrossFileOpen = async (options: {
    readonly openFails?: boolean;
    readonly cancelled?: boolean;
    readonly typed?: boolean;
  }) => {
    const order: string[] = [];
    const result = await runNesCrossFileOpenContinuation({
      open: async () => {
        order.push("open");
        if (options.openFails) throw new Error("missing");
        return {
          getText: () => {
            order.push("getText");
            return "target";
          },
        };
      },
      isCancellationRequested: () => {
        order.push("token");
        return options.cancelled === true;
      },
      hasUserTypedSinceRequestStarted: () => {
        order.push("typed");
        return options.typed === true;
      },
      onOpenFailed: () => {
        order.push("openFailed");
        return { value: "openFailed" as const };
      },
      onCancelled: (reason) => {
        order.push(`cancelled:${reason}`);
        return { value: reason };
      },
      onOpened: (target) => {
        order.push("opened");
        target.getText();
        return { value: "opened" as const };
      },
    });
    return { order, value: result.value };
  };

  it("makes an open failure terminal before token and typing checks", async () => {
    await expect(
      runCrossFileOpen({ openFails: true, cancelled: true, typed: true }),
    ).resolves.toEqual({
      order: ["open", "openFailed"],
      value: "openFailed",
    });
  });

  it("short-circuits cancellation before typing and target reads", async () => {
    await expect(runCrossFileOpen({ cancelled: true, typed: true })).resolves
      .toEqual({
        order: [
          "open",
          "token",
          "cancelled:afterCrossFileOpenTextDocument",
        ],
        value: "afterCrossFileOpenTextDocument",
      });
  });

  it("short-circuits typing before target reads", async () => {
    await expect(runCrossFileOpen({ typed: true })).resolves.toEqual({
      order: [
        "open",
        "token",
        "typed",
        "cancelled:afterCrossFileOpenTextDocumentUserTyped",
      ],
      value: "afterCrossFileOpenTextDocumentUserTyped",
    });
  });

  it("reads the opened target only after token and typing checks", async () => {
    await expect(runCrossFileOpen({})).resolves.toEqual({
      order: ["open", "token", "typed", "opened", "getText"],
      value: "opened",
    });
  });
});

function promptContext(
  overrides: Partial<NesPromptContext> = {},
): NesPromptContext {
  const current = document("src/main.ts", sourceText, {
    selection: { start: cursorOffset, end: cursorOffset, active: cursorOffset },
  });
  return {
    current,
    cursorOffset,
    recentDocuments: [
      document(
        "src/helper.ts",
        "export function helper() {\n  return true;\n}",
        {
          lastViewedAt: 20,
        },
      ),
    ],
    editHistory: [
      {
        uri: current.uri,
        path: "src/main.ts",
        languageId: "typescript",
        before: sourceText.replace("const value4 = 4;", "const value4 = 3;"),
        after: sourceText,
        timestamp: 10,
      },
    ],
    diagnostics: [
      {
        message: "value5 is never read",
        severity: "warning",
        startLine: 5,
        endLine: 5,
        source: "ts",
        code: "6133",
      },
    ],
    languageContext: {
      symbols: [
        {
          name: "helper",
          kind: "Function",
          startLine: 0,
          endLine: 2,
        },
      ],
    },
    gitDiff: "diff --git a/src/main.ts b/src/main.ts\n+const staged = true;",
    ...overrides,
  };
}

function applyEdits(text: string, edits: readonly NesTextEdit[]): string {
  let result = text;
  for (const edit of [...edits].sort(
    (left, right) => right.startOffset - left.startOffset,
  )) {
    result = `${result.slice(0, edit.startOffset)}${edit.newText}${result.slice(edit.endOffset)}`;
  }
  return result;
}

describe("official NES prompt port", () => {
  it.each([
    ["copilotNesXtab", "Your role as an AI assistant"],
    ["xtab275", "Predict the next code edit"],
    ["xtabUnifiedModel", "Your role as an AI assistant"],
  ] as const)(
    "builds %s messages with frozen default context",
    (strategy, marker) => {
      const prompt = buildOfficialNesPrompt(promptContext(), strategy);
      expect(prompt.messages.system).toContain(marker);
      expect(prompt.messages.user).toContain(
        "<|recently_viewed_code_snippets|>",
      );
      expect(prompt.messages.user).not.toContain("src/helper.ts");
      expect(prompt.messages.user).toContain("<|current_file_content|>");
      expect(prompt.messages.user).toContain("<|code_to_edit|>");
      expect(prompt.messages.user).toContain("<|cursor|>");
      expect(prompt.messages.user).toContain("<|edit_diff_history|>");
      expect(prompt.messages.user).not.toContain("value5 is never read");
      expect(prompt.messages.user).not.toContain("helper: Function");
      expect(prompt.messages.user).not.toContain("diff --git");
      expect(prompt.editWindow.startLine).toBe(3);
      expect(prompt.editWindow.endLineExclusive).toBe(11);
      expect(prompt.editWindow.cursorLineOffset).toBe(cursorLine);
      expect(prompt.tokenUsage.total).toBeGreaterThan(0);
    },
  );

  it("does not inject selected editor completion and clips opted-in viewed files to budgets", () => {
    const huge = Array.from(
      { length: 2_000 },
      (_value, index) => `const extremelyLongIdentifier${index} = ${index};`,
    ).join("\n");
    const context = promptContext({
      current: document("src/huge.ts", huge),
      cursorOffset: Math.floor(huge.length / 2),
      selectedCompletionText: "selectedSuggestion()",
      recentDocuments: [
        document("src/other.ts", huge, {
          lastViewedAt: 100,
          visibleRanges: [{ start: 0, end: 40 }],
        }),
      ],
    });
    const prompt = buildOfficialNesPrompt(context, "xtab275", {
      ...COPILOT_BEHAVIOR_CONFIG,
      prompt: {
        ...COPILOT_BEHAVIOR_CONFIG.prompt,
        recentFilesIncludeViewed: true,
      },
    });
    expect(prompt.messages.user).not.toContain("selectedSuggestion()");
    expect(prompt.messages.user).toContain("src/other.ts");
    expect(prompt.tokenUsage.currentFile).toBeLessThanOrEqual(
      COPILOT_BEHAVIOR_CONFIG.prompt.currentFileTokens * 2,
    );
    expect(prompt.tokenUsage.recentFiles).toBeLessThanOrEqual(
      COPILOT_BEHAVIOR_CONFIG.prompt.recentFileTokens,
    );
    expect(prompt.messages.user.length).toBeLessThan(
      COPILOT_BEHAVIOR_CONFIG.prompt.hardCharacterLimit,
    );
  });

  it("generates stable minimal unified history and filters no-op history", () => {
    expect(
      createUnifiedHistoryDiff({
        uri: "file:///a.ts",
        path: "a.ts",
        languageId: "typescript",
        before: "a\nb\nc",
        after: "a\nchanged\nc",
        timestamp: 1,
      }),
    ).toBe("--- a.ts\n+++ a.ts\n@@ -1,1 +1,1 @@\n-b\n+changed");
    expect(
      createUnifiedHistoryDiff({
        uri: "file:///a.ts",
        path: "a.ts",
        languageId: "typescript",
        before: "same",
        after: "same",
        timestamp: 1,
      }),
    ).toBeUndefined();
  });
});

describe("official NES response pipeline", () => {
  it("is invariant to stream chunk boundaries for fenced responses", async () => {
    const context = promptContext();
    const prompt = buildOfficialNesPrompt(context, "copilotNesXtab");
    const changedLines = [...prompt.editWindow.lines];
    changedLines[2] = "const value5 = 500;";
    const response = `\`\`\`ts\n${changedLines.join("\n")}\n\`\`\``;
    const first = await parseOfficialNesResponse(
      chunksFromString(response),
      "copilotNesXtab",
      prompt,
      context.current,
      context.recentDocuments,
    );
    const fragmented = await parseOfficialNesResponse(
      chunksFromString(response, [1, 2, 5, 3, 7, 11]),
      "copilotNesXtab",
      prompt,
      context.current,
      context.recentDocuments,
    );
    expect(fragmented.edits).toEqual(first.edits);
    expect(applyEdits(context.current.text, first.edits)).toContain(
      "const value5 = 500;",
    );
  });

  it("parses unified insert, edit, no-change, and rejects unsupported response tags", async () => {
    const context = promptContext();
    const prompt = buildOfficialNesPrompt(context, "xtabUnifiedModel");
    const insert = await parseOfficialNesResponse(
      chunksFromString("<INSERT>\n + suffix\n</INSERT>", [2, 1, 4]),
      "xtabUnifiedModel",
      prompt,
      context.current,
      [],
    );
    expect(insert.edits).toHaveLength(1);
    expect(applyEdits(context.current.text, insert.edits)).toContain(
      "const value5 + suffix = 5;",
    );

    const editedLines = [...prompt.editWindow.lines];
    editedLines[0] = "const value3 = 300;";
    const edit = await parseOfficialNesResponse(
      chunksFromString(`<EDIT>\n${editedLines.join("\n")}\n</EDIT>`),
      "xtabUnifiedModel",
      prompt,
      context.current,
      [],
    );
    expect(edit.edits).not.toHaveLength(0);

    const noChange = await parseOfficialNesResponse(
      chunksFromString("<NO_CHANGE>"),
      "xtabUnifiedModel",
      prompt,
      context.current,
      [],
    );
    expect(noChange).toMatchObject({ edits: [], noChange: true });

    const cursorDivergence = vi.fn();
    const cursor = await parseOfficialNesResponse(
      chunksFromString("<CURSOR>8:3</CURSOR>"),
      "xtabUnifiedModel",
      prompt,
      context.current,
      [],
      cursorDivergence,
    );
    expect(cursor.edits).toEqual([]);
    expect(cursorDivergence).toHaveBeenCalledOnce();

    const divergence = vi.fn();
    const malformed = await parseOfficialNesResponse(
      chunksFromString("<UNKNOWN>"),
      "xtabUnifiedModel",
      prompt,
      context.current,
      [],
      divergence,
    );
    expect(malformed.edits).toEqual([]);
    expect(divergence).toHaveBeenCalledOnce();
  });

  it("keeps xtab275 as EditWindowOnly", async () => {
    const context = promptContext();
    const prompt = buildOfficialNesPrompt(context, "xtab275");
    const result = await parseOfficialNesResponse(
      chunksFromString(
        "src/helper.ts:0\n-export const helper = false;\n+export const helper = true;",
      ),
      "xtab275",
      prompt,
      context.current,
      context.recentDocuments,
    );
    expect(result.format).toBe("editWindowOnly");
    expect(result.edits[0]?.uri).toBe(context.current.uri);
  });

  it("emits a unified INSERT cursor edit before the remaining stream arrives", async () => {
    const context = promptContext();
    const prompt = buildOfficialNesPrompt(context, "xtabUnifiedModel");
    let releaseRemainder: (() => void) | undefined;
    const remainder = new Promise<void>((resolve) => {
      releaseRemainder = resolve;
    });
    async function* response(): AsyncIterable<string> {
      yield "<INSERT>\n + suffix\n";
      await remainder;
      yield "console.log(value5);\n</INSERT>";
    }
    const stream = streamOfficialNesResponse(
      response(),
      "xtabUnifiedModel",
      prompt,
      context.current,
      [],
    );
    const first = await stream.next();
    expect(first.done).toBe(false);
    if (first.done) {
      throw new Error(
        "Expected the cursor-line edit before stream completion.",
      );
    }
    expect(applyEdits(context.current.text, [first.value])).toContain(
      "const value5 + suffix = 5;",
    );

    let secondSettled = false;
    const secondPromise = stream.next().then((value) => {
      secondSettled = true;
      return value;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    releaseRemainder?.();
    const second = await secondPromise;
    expect(second.done).toBe(false);
    if (second.done) {
      throw new Error("Expected the subsequent line insertion.");
    }
    expect(second.value.newText).toContain("console.log(value5);");
    const done = await stream.next();
    expect(done.done).toBe(true);
  });

  it("filters no-op, import-only, duplicate-continuation, and notebook marker edits", async () => {
    const context = promptContext();
    const prompt = buildOfficialNesPrompt(context, "xtab275");
    const noOp = await parseOfficialNesResponse(
      chunksFromString(prompt.editWindow.lines.join("\n")),
      "xtab275",
      prompt,
      context.current,
      [],
    );
    expect(noOp.edits).toEqual([]);

    const imported = [...prompt.editWindow.lines];
    imported[0] = "import { value3 } from './value3';";
    const importOnly = await parseOfficialNesResponse(
      chunksFromString(imported.join("\n")),
      "xtab275",
      prompt,
      context.current,
      [],
    );
    expect(importOnly.edits).toEqual([]);

    const notebook = [...prompt.editWindow.lines];
    notebook[0] = "%% vscode.cell [id=bad]";
    const markerOutsideNotebook = await parseOfficialNesResponse(
      chunksFromString(notebook.join("\n")),
      "xtab275",
      prompt,
      context.current,
      [],
    );
    expect(markerOutsideNotebook.edits).toHaveLength(1);
    const marker = await parseOfficialNesResponse(
      chunksFromString(notebook.join("\n")),
      "xtab275",
      prompt,
      context.current,
      [],
      undefined,
      {
        substrings: [],
        undoInsertionFiltering: false,
        filterNotebookCellMarkers: true,
      },
    );
    expect(marker.edits).toEqual([]);
  });

  it("filters configured marker substrings and edits that undo a recent insertion", () => {
    const before = "const values = [];\n";
    const insertedText = "values.push(1);\n";
    const after = `${before}${insertedText}`;
    const current = document("src/main.ts", after);
    const deletion: NesTextEdit = {
      uri: current.uri,
      startOffset: before.length,
      endOffset: after.length,
      newText: "",
      kind: "replace",
    };
    const marker: NesTextEdit = {
      uri: current.uri,
      startOffset: 0,
      endOffset: 0,
      newText: "<|current_file_content|>",
      kind: "insert",
    };
    expect(
      filterOfficialNesEdits(
        [deletion, marker],
        current,
        [
          {
            uri: current.uri,
            path: current.path,
            languageId: current.languageId,
            before,
            after,
            timestamp: 1,
          },
        ],
        {
          substrings: ["<|current_file_content|>"],
          undoInsertionFiltering: "v2",
        },
      ),
    ).toEqual([]);
  });

  it("keeps the upstream whitespace-only treatment enabled by default", () => {
    const current = document("src/main.ts", "const value = 1;\n");
    const whitespace: NesTextEdit = {
      uri: current.uri,
      startOffset: 0,
      endOffset: current.text.length,
      newText: "  const value = 1;\n",
      kind: "replace",
    };
    const baseOptions = {
      substrings: [] as readonly string[],
      undoInsertionFiltering: false as const,
    };
    expect(COPILOT_BEHAVIOR_CONFIG.nextEdit.allowWhitespaceOnlyChanges).toBe(
      true,
    );
    expect(
      filterOfficialNesEdits([whitespace], current, [], {
        ...baseOptions,
        allowWhitespaceOnlyChanges: true,
      }),
    ).toEqual([whitespace]);
    expect(
      filterOfficialNesEdits([whitespace], current, [], {
        ...baseOptions,
        allowWhitespaceOnlyChanges: false,
      }),
    ).toEqual([]);
  });
});

function cacheEntry(
  documentText: string,
  edits: readonly NesTextEdit[],
  overrides: Partial<NesCacheEntry> = {},
): NesCacheEntry {
  return {
    documentUri: "file:///a.ts",
    documentText,
    editWindow: { startOffset: 0, endOffset: documentText.length },
    cursorOffset: 5,
    requestId: "request-1",
    createdAt: 1,
    edits,
    source: "llm",
    subsequentN: 0,
    speculative: false,
    rejected: false,
    wasShown: false,
    wasRenderedAsInlineSuggestion: false,
    ...overrides,
  };
}

describe("NextEditCache", () => {
  it("supports exact hits, shown metadata, and rejection suppression", () => {
    const cache = new NextEditCache(5);
    const text = "const value = 1;";
    const entry = cacheEntry(text, [
      {
        uri: "file:///a.ts",
        startOffset: 14,
        endOffset: 15,
        newText: "2",
        kind: "replace",
      },
    ]);
    cache.put(entry);
    expect(cache.lookup("file:///a.ts", text, 5)?.edit).toEqual(entry.edits[0]);
    cache.markShown("request-1", true);
    expect(entry).toMatchObject({
      wasShown: true,
      wasRenderedAsInlineSuggestion: true,
    });
    cache.markRejected("request-1");
    expect(cache.lookup("file:///a.ts", text, 5)?.entry.rejected).toBe(true);
    expect(cache.isRejected("file:///a.ts", text, entry.edits[0])).toBe(true);
  });

  it("marks only the shown cache entry when one request has later candidates", () => {
    const cache = new NextEditCache(5);
    const first = cacheEntry("first", [
      {
        uri: "file:///a.ts",
        startOffset: 5,
        endOffset: 5,
        newText: " one",
        kind: "insert",
      },
    ]);
    const later = cacheEntry(
      "first one",
      [
        {
          uri: "file:///a.ts",
          startOffset: 9,
          endOffset: 9,
          newText: " two",
          kind: "insert",
        },
      ],
      {
        subsequentN: 1,
      },
    );
    cache.put(first);
    cache.put(later);

    cache.markShown("request-1", true, first);

    expect(first).toMatchObject({
      wasShown: true,
      wasRenderedAsInlineSuggestion: true,
    });
    expect(later).toMatchObject({
      wasShown: false,
      wasRenderedAsInlineSuggestion: false,
    });
  });

  it("suppresses an equivalent freshly fetched edit after document rebase", () => {
    const cache = new NextEditCache(5);
    const text = "const value = 1;\nconsole.log(value);";
    const edit: NesTextEdit = {
      uri: "file:///a.ts",
      startOffset: text.indexOf("1"),
      endOffset: text.indexOf("1") + 1,
      newText: "2",
      kind: "replace",
    };
    cache.put(cacheEntry(text, [edit]));
    cache.markRejected("request-1");

    const prefix = "// note\n";
    const current = `${prefix}${text}`;
    expect(
      cache.isRejected("file:///a.ts", current, {
        ...edit,
        startOffset: edit.startOffset + prefix.length,
        endOffset: edit.endOffset + prefix.length,
      }),
    ).toBe(true);
  });

  it("drops a persistent rejection after overlapping typing and cache eviction", () => {
    const cache = new NextEditCache(1);
    const text = "function fi";
    const shown: NesTextEdit = {
      uri: "file:///a.ts",
      startOffset: 11,
      endOffset: 11,
      newText: "bonacci",
      kind: "insert",
    };
    cache.put(cacheEntry(text, [shown], { requestId: "shown-request" }));
    cache.markRejected("shown-request");

    const typing = NesStringEdit.single(
      new NesStringReplacement({ start: 11, endOffset: 11 }, "b"),
    );
    const current = typing.apply(text);
    cache.handleDocumentEdit("file:///a.ts", typing, current);
    const later = cacheEntry(
      current,
      [
        {
          uri: "file:///a.ts",
          startOffset: 12,
          endOffset: 12,
          newText: "onacci",
          kind: "insert",
        },
      ],
      {
        requestId: "shown-request",
        subsequentN: 1,
      },
    );
    cache.put(later);

    expect(cache.lookup("file:///a.ts", text, 5)).toBeUndefined();
    expect(cache.lookup("file:///a.ts", current, 12)).toMatchObject({
      entry: { rejected: false, subsequentN: 1 },
      edit: { startOffset: 12, endOffset: 12, newText: "onacci" },
    });
    expect(cache.isRejected("file:///a.ts", current, later.edits[0])).toBe(
      false,
    );
  });

  it("rejects current request entries but not other or later unshown entries", () => {
    const cache = new NextEditCache(5);
    const first = cacheEntry(
      "abc",
      [
        {
          uri: "file:///a.ts",
          startOffset: 1,
          endOffset: 1,
          newText: "X",
          kind: "insert",
        },
      ],
      { requestId: "shared-request" },
    );
    const currentLater = cacheEntry(
      "aXbc",
      [
        {
          uri: "file:///a.ts",
          startOffset: 2,
          endOffset: 2,
          newText: "Y",
          kind: "insert",
        },
      ],
      { requestId: "shared-request", subsequentN: 1 },
    );
    const other = cacheEntry(
      "other",
      [
        {
          uri: "file:///a.ts",
          startOffset: 5,
          endOffset: 5,
          newText: "!",
          kind: "insert",
        },
      ],
      { requestId: "other-request" },
    );
    cache.put(first);
    cache.put(currentLater);
    cache.put(other);

    cache.markRejected(
      "shared-request",
      first.edits[0],
      first.documentText,
      first,
    );
    expect(cache.lookup("file:///a.ts", "abc", 1)?.entry.rejected).toBe(true);
    expect(cache.lookup("file:///a.ts", "aXbc", 2)?.entry.rejected).toBe(true);
    expect(cache.lookup("file:///a.ts", "other", 5)?.entry.rejected).toBe(
      false,
    );
    expect(
      cache.isPersistentlyRejected("file:///a.ts", "abc", first.edits[0]),
    ).toBe(true);
    expect(
      cache.isPersistentlyRejected(
        "file:///a.ts",
        "aXbc",
        currentLater.edits[0],
      ),
    ).toBe(false);

    cache.appendEdit(first, currentLater.edits[0]);
    expect(cache.lookup("file:///a.ts", "aXbc", 2)?.entry.rejected).toBe(false);
  });

  it("invalidates other document owners while retaining same-document rebase state", () => {
    const cache = new NextEditCache(5);
    const aText = "function fi";
    cache.put(
      cacheEntry(
        aText,
        [
          {
            uri: "file:///a.ts",
            startOffset: aText.length,
            endOffset: aText.length,
            newText: "bonacci",
            kind: "insert",
          },
        ],
        { userEditSince: NesStringEdit.empty },
      ),
    );
    cache.put(
      cacheEntry(
        "other",
        [
          {
            uri: "file:///b.ts",
            startOffset: 5,
            endOffset: 5,
            newText: "!",
            kind: "insert",
          },
        ],
        {
          documentUri: "file:///b.ts",
          requestId: "request-b",
        },
      ),
    );
    const typeThrough = NesStringEdit.single(
      new NesStringReplacement(
        { start: aText.length, endOffset: aText.length },
        "b",
      ),
    );
    const current = typeThrough.apply(aText);
    cache.handleDocumentEdit("file:///a.ts", typeThrough, current);

    expect(cache.lookup("file:///b.ts", "other", 5)).toBeUndefined();
    expect(cache.lookup("file:///a.ts", current, current.length)).toMatchObject(
      {
        rebased: true,
        edit: {
          startOffset: aText.length,
          endOffset: current.length,
          newText: "bonacci",
        },
      },
    );
  });

  it("serves a cross-file cache entry only while its target snapshot is open and unchanged", () => {
    const cache = new NextEditCache(5);
    const activeText = "runHelper();";
    const targetText = "export const enabled = false;";
    const entry = cacheEntry(
      activeText,
      [
        {
          uri: "file:///helper.ts",
          startOffset: targetText.indexOf("false"),
          endOffset: targetText.indexOf("false") + "false".length,
          newText: "true",
          kind: "replace",
        },
      ],
      {
        targetDocumentText: targetText,
      },
    );
    cache.put(entry);

    expect(
      cache.lookup("file:///a.ts", activeText, 5, (uri) =>
        uri === "file:///helper.ts" ? targetText : undefined,
      )?.edit,
    ).toEqual(entry.edits[0]);
    expect(
      cache.lookup(
        "file:///a.ts",
        activeText,
        5,
        () => `${targetText}\nchanged`,
      ),
    ).toBeUndefined();
    expect(
      cache.lookup("file:///a.ts", activeText, 5, () => undefined),
    ).toBeUndefined();
  });

  it.each([false, true])(
    "stores regular/speculative cross-file streams under each real target (speculative=%s)",
    (speculative) => {
      const cache = new NextEditCache(
        10,
        {
          absorbSubsequenceTyping: false,
          reverseAgreement: true,
          maxImperfectAgreementLength: 1,
        },
        true,
      );
      const activeUri = "file:///active.ts";
      const activeText = "runTargets();";
      const targetBUri = "file:///target-b.ts";
      const targetBText = "const one = 1;\nconst two = 2;";
      const targetCUri = "file:///target-c.ts";
      const targetCText = "const three = 3;";
      const context = {
        activeDocumentUri: activeUri,
        activeDocumentText: activeText,
        activeDocumentIsOpen: true,
        firstEditWindow: { startOffset: 0, endOffset: activeText.length },
        firstOriginalEditWindow: { startOffset: 2, endOffset: 4 },
        activeCursorOffset: 3,
        requestId: "cross-file-stream",
        createdAt: 1,
        source: "llm" as const,
        speculative,
        ...(!speculative ? { userEditSince: NesStringEdit.empty } : {}),
      };
      const firstB: NesTextEdit = {
        uri: targetBUri,
        startOffset: targetBText.indexOf("1"),
        endOffset: targetBText.indexOf("1") + 1,
        newText: "10",
        kind: "replace",
      };
      const cachedFirstB = cache.putStreamedEdit(context, {
        edit: firstB,
        documentBeforeEdit: targetBText,
        currentTargetDocumentText: targetBText,
        subsequentN: 0,
      });
      const targetBAfterFirst = applyEdits(targetBText, [firstB]);
      const firstC: NesTextEdit = {
        uri: targetCUri,
        startOffset: targetCText.indexOf("3"),
        endOffset: targetCText.indexOf("3") + 1,
        newText: "30",
        kind: "replace",
      };
      const cachedFirstC = cache.putStreamedEdit(context, {
        edit: firstC,
        documentBeforeEdit: targetCText,
        currentTargetDocumentText: targetCText,
        subsequentN: 1,
        bundledEntry: cachedFirstB.bundledEntry,
      });
      const secondB: NesTextEdit = {
        uri: targetBUri,
        startOffset: targetBAfterFirst.indexOf("2"),
        endOffset: targetBAfterFirst.indexOf("2") + 1,
        newText: "20",
        kind: "replace",
      };
      cache.putStreamedEdit(context, {
        edit: secondB,
        documentBeforeEdit: targetBAfterFirst,
        currentTargetDocumentText: targetBText,
        subsequentN: 2,
        bundledEntry: cachedFirstB.bundledEntry,
      });

      expect(cachedFirstB.targetEntry).toMatchObject({
        documentUri: targetBUri,
        documentText: targetBText,
        edits: [firstB, secondB],
        subsequentN: 0,
        speculative,
      });
      expect(cachedFirstB.targetEntry.cursorOffset).toBeUndefined();
      expect(cachedFirstB.targetEntry.editWindow).toEqual(
        context.firstEditWindow,
      );
      expect(cachedFirstB.targetEntry.originalEditWindow).toEqual(
        context.firstOriginalEditWindow,
      );
      expect(cachedFirstC.targetEntry).toMatchObject({
        documentUri: targetCUri,
        documentText: targetCText,
        edits: [firstC],
        subsequentN: 1,
        speculative,
      });
      expect(cachedFirstB.activeAlias).toMatchObject({
        documentUri: activeUri,
        documentText: activeText,
        targetDocumentText: targetBText,
        edits: [firstB],
        originalEditWindow: context.firstOriginalEditWindow,
      });
      expect(cachedFirstB.activeAliasAttempted).toBe(true);
      expect(cachedFirstB.activeAlias?.cursorOffset).toBeUndefined();
      expect(cachedFirstC.activeAliasAttempted).toBe(false);
      expect(cachedFirstC.activeAlias).toBeUndefined();
      expect(cachedFirstC.bundledEntry).toBeUndefined();

      cache.markShown(context.requestId, true, cachedFirstB.targetEntry);
      expect(cachedFirstB.targetEntry.wasRenderedAsInlineSuggestion).toBe(true);
      expect(cachedFirstB.activeAlias?.wasRenderedAsInlineSuggestion).toBe(
        false,
      );

      expect(
        cache.lookup(activeUri, activeText, 3, (uri) =>
          uri === targetBUri ? targetBText : undefined,
        ),
      ).toMatchObject({ edit: firstB, entry: cachedFirstB.activeAlias });
      expect(
        cache.lookup(activeUri, activeText, 3, (uri) =>
          uri === targetBUri ? targetBAfterFirst : undefined,
        ),
      ).toBeUndefined();
      expect(
        cache.lookup(activeUri, `${activeText}!`, 3, (uri) =>
          uri === targetBUri ? targetBText : undefined,
        ),
      ).toBeUndefined();
      expect(cache.lookup(targetBUri, targetBAfterFirst, 0)).toMatchObject({
        edit: secondB,
        subsequent: true,
        entry: { rejected: false, subsequentN: 2 },
      });
      expect(cache.lookup(targetCUri, targetCText, 0)).toMatchObject({
        edit: firstC,
        subsequent: true,
        entry: { edits: [firstC], subsequentN: 1 },
      });

      expect(cache.markAccepted(cachedFirstB.targetEntry)).toMatchObject({
        documentUri: targetBUri,
        documentText: targetBAfterFirst,
        edits: [secondB],
        subsequentN: 2,
      });
    },
  );

  it.each([false, true])(
    "stores only a reopen-safe active alias when the first target is closed (speculative=%s)",
    (speculative) => {
      const activeUri = "file:///closed-target-active.ts";
      const activeText = "runClosedTarget();";
      const targetUri = "file:///closed-target.ts";
      const targetText = "const closedTarget = 1;";
      const targetOffset = targetText.indexOf("1");
      const edit: NesTextEdit = {
        uri: targetUri,
        startOffset: targetOffset,
        endOffset: targetOffset + 1,
        newText: "2",
        kind: "replace",
      };
      const cache = new NextEditCache(10);
      const result = cache.putStreamedEdit(
        {
          activeDocumentUri: activeUri,
          activeDocumentText: activeText,
          activeDocumentIsOpen: true,
          firstEditWindow: { startOffset: 0, endOffset: activeText.length },
          activeCursorOffset: 3,
          requestId: `closed-target-${speculative}`,
          createdAt: 1,
          source: "llm",
          speculative,
          ...(!speculative ? { userEditSince: NesStringEdit.empty } : {}),
        },
        {
          edit,
          documentBeforeEdit: targetText,
          currentTargetDocumentText: undefined,
          subsequentN: 0,
        },
      );

      expect(result.targetEntry).toBeUndefined();
      expect(result.bundledEntry).toBeUndefined();
      expect(result.activeAliasAttempted).toBe(true);
      expect(result.activeAlias).toMatchObject({
        documentUri: activeUri,
        documentText: activeText,
        targetDocumentText: targetText,
        edits: [edit],
        speculative,
      });
      expect(result.activeAlias?.userEditSince).toBeUndefined();
      expect(cache.size).toBe(1);
      expect(cache.lookup(targetUri, targetText, 0)).toBeUndefined();

      cache.removeDocument(targetUri);
      expect(
        cache.lookup(activeUri, activeText, 3, () => undefined),
      ).toBeUndefined();
      expect(
        cache.lookup(activeUri, activeText, 3, (uri) =>
          uri === targetUri ? targetText : undefined,
        ),
      ).toMatchObject({
        edit,
        entry: result.activeAlias,
        rebased: false,
      });
    },
  );

  it.each([false, true])(
    "stores only the real target when the active source is closed (speculative=%s)",
    (speculative) => {
      const activeUri = "file:///closed-source.ts";
      const targetUri = "file:///open-target.ts";
      const targetText = "const openTarget = 1;";
      const offset = targetText.indexOf("1");
      const edit: NesTextEdit = {
        uri: targetUri,
        startOffset: offset,
        endOffset: offset + 1,
        newText: "2",
        kind: "replace",
      };
      const cache = new NextEditCache(10);
      const result = cache.putStreamedEdit(
        {
          activeDocumentUri: activeUri,
          activeDocumentText: "runOpenTarget();",
          activeDocumentIsOpen: false,
          activeCursorOffset: 3,
          requestId: `closed-source-${speculative}`,
          createdAt: 1,
          source: "llm",
          speculative,
          ...(!speculative ? { userEditSince: NesStringEdit.empty } : {}),
        },
        {
          edit,
          documentBeforeEdit: targetText,
          currentTargetDocumentText: targetText,
          subsequentN: 0,
        },
      );

      expect(result.targetEntry).toMatchObject({
        documentUri: targetUri,
        documentText: targetText,
        edits: [edit],
        speculative,
      });
      expect(result.activeAliasAttempted).toBe(true);
      expect(result.activeAlias).toBeUndefined();
      expect(cache.size).toBe(1);
      expect(cache.lookup(targetUri, targetText, 0)).toMatchObject({
        edit,
        entry: result.targetEntry,
      });
      expect(
        cache.lookup(activeUri, "runOpenTarget();", 3, () => targetText),
      ).toBeUndefined();
    },
  );

  it("does not bundle a target that first appears after global edit zero", () => {
    const cache = new NextEditCache(10);
    const activeUri = "file:///active.ts";
    const activeText = "const active = 1;";
    const targetUri = "file:///target.ts";
    const targetText = "const first = 1;\nconst second = 2;";
    const context = {
      activeDocumentUri: activeUri,
      activeDocumentText: activeText,
      activeDocumentIsOpen: true,
      activeCursorOffset: 5,
      requestId: "late-target-stream",
      createdAt: 1,
      source: "llm" as const,
      speculative: false,
      userEditSince: NesStringEdit.empty,
    };
    const activeResult = cache.putStreamedEdit(context, {
      edit: {
        uri: activeUri,
        startOffset: activeText.indexOf("1"),
        endOffset: activeText.indexOf("1") + 1,
        newText: "10",
        kind: "replace",
      },
      documentBeforeEdit: activeText,
      currentTargetDocumentText: activeText,
      subsequentN: 0,
    });
    expect(activeResult.targetEntry.editWindow).toBeUndefined();
    const firstTargetEdit: NesTextEdit = {
      uri: targetUri,
      startOffset: targetText.indexOf("1"),
      endOffset: targetText.indexOf("1") + 1,
      newText: "10",
      kind: "replace",
    };
    const firstTargetResult = cache.putStreamedEdit(context, {
      edit: firstTargetEdit,
      documentBeforeEdit: targetText,
      currentTargetDocumentText: targetText,
      subsequentN: 1,
    });
    const targetAfterFirst = applyEdits(targetText, [firstTargetEdit]);
    const secondTargetEdit: NesTextEdit = {
      uri: targetUri,
      startOffset: targetAfterFirst.lastIndexOf("2"),
      endOffset: targetAfterFirst.lastIndexOf("2") + 1,
      newText: "20",
      kind: "replace",
    };
    cache.putStreamedEdit(context, {
      edit: secondTargetEdit,
      documentBeforeEdit: targetAfterFirst,
      currentTargetDocumentText: targetText,
      subsequentN: 2,
      bundledEntry: firstTargetResult.bundledEntry,
    });

    expect(firstTargetResult.bundledEntry).toBeUndefined();
    expect(firstTargetResult.targetEntry.edits).toEqual([firstTargetEdit]);
    expect(firstTargetResult.targetEntry.editWindow).toBeUndefined();
    expect(cache.lookup(targetUri, targetAfterFirst, 0)).toMatchObject({
      edit: secondTargetEdit,
      entry: { edits: [secondTargetEdit], subsequentN: 2 },
    });
  });

  it("tracks only regular global-zero real entries after document edits", () => {
    const uri = "file:///tracked.ts";
    const text = "const value = ;";
    const offset = text.indexOf(";");
    const suggestion: NesTextEdit = {
      uri,
      startOffset: offset,
      endOffset: offset,
      newText: "result",
      kind: "insert",
    };
    const context = {
      activeDocumentUri: uri,
      activeDocumentText: text,
      activeDocumentIsOpen: true,
      activeCursorOffset: offset,
      requestId: "tracked-regular",
      createdAt: 1,
      source: "llm" as const,
      speculative: false,
      userEditSince: NesStringEdit.empty,
    };
    const cache = new NextEditCache(10, {
      absorbSubsequenceTyping: true,
      reverseAgreement: true,
      maxImperfectAgreementLength: 1,
    });
    cache.putStreamedEdit(context, {
      edit: suggestion,
      documentBeforeEdit: text,
      currentTargetDocumentText: text,
      subsequentN: 0,
    });
    const typing = NesStringEdit.single(
      new NesStringReplacement({ start: offset, endOffset: offset }, "r"),
    );
    const current = typing.apply(text);
    cache.handleDocumentEdit(uri, typing, current);

    expect(cache.lookup(uri, current, offset + 1)).toMatchObject({
      rebased: true,
      edit: {
        startOffset: offset,
        endOffset: offset + 1,
        newText: "result",
      },
    });
  });

  it("keeps a changed cross-file target entry exact-only without dropping it", () => {
    const activeUri = "file:///active-consistency.ts";
    const targetUri = "file:///target-consistency.ts";
    const targetText = "const value = 1;";
    const changedTargetText = `// changed\n${targetText}`;
    const targetOffset = targetText.indexOf("1");
    const edit: NesTextEdit = {
      uri: targetUri,
      startOffset: targetOffset,
      endOffset: targetOffset + 1,
      newText: "2",
      kind: "replace",
    };
    const cache = new NextEditCache(10);
    const cached = cache.putStreamedEdit(
      {
        activeDocumentUri: activeUri,
        activeDocumentText: "runTarget();",
        activeDocumentIsOpen: true,
        activeCursorOffset: 3,
        requestId: "changed-cross-target",
        createdAt: 1,
        source: "llm",
        speculative: false,
        userEditSince: NesStringEdit.empty,
      },
      {
        edit,
        documentBeforeEdit: targetText,
        currentTargetDocumentText: changedTargetText,
        subsequentN: 0,
      },
    );

    expect(cached.targetEntry.userEditSince).toBeUndefined();
    expect(cache.lookup(targetUri, changedTargetText, 0)).toBeUndefined();
    expect(cache.lookup(targetUri, targetText, 0)).toMatchObject({
      edit,
      rebased: false,
      entry: cached.targetEntry,
    });
  });

  it("tracks a cross-file target when the request edit maps its base to live text", () => {
    const activeUri = "file:///active-mapped.ts";
    const targetUri = "file:///target-mapped.ts";
    const targetText = "const value = ;";
    const offset = targetText.indexOf(";");
    const userEdit = NesStringEdit.single(
      new NesStringReplacement({ start: offset, endOffset: offset }, "r"),
    );
    const currentTargetText = userEdit.apply(targetText);
    const edit: NesTextEdit = {
      uri: targetUri,
      startOffset: offset,
      endOffset: offset,
      newText: "result",
      kind: "insert",
    };
    const cache = new NextEditCache(10, {
      absorbSubsequenceTyping: true,
      reverseAgreement: true,
      maxImperfectAgreementLength: 1,
    });
    const cached = cache.putStreamedEdit(
      {
        activeDocumentUri: activeUri,
        activeDocumentText: "runTarget();",
        activeDocumentIsOpen: true,
        activeCursorOffset: 3,
        requestId: "mapped-cross-target",
        createdAt: 1,
        source: "llm",
        speculative: false,
        userEditSince: userEdit,
      },
      {
        edit,
        documentBeforeEdit: targetText,
        currentTargetDocumentText: currentTargetText,
        subsequentN: 0,
      },
    );

    expect(cached.targetEntry.userEditSince).toBe(userEdit);
    expect(
      cache.lookup(targetUri, currentTargetText, offset + 1),
    ).toMatchObject({
      rebased: true,
      edit: {
        startOffset: offset,
        endOffset: offset + 1,
        newText: "result",
      },
      entry: cached.targetEntry,
    });
  });

  it("does not recover tracked rebasing after edit consistency is lost", () => {
    const uri = "file:///inconsistent.ts";
    const text = "const value = 1;";
    const entry = cacheEntry(
      text,
      [
        {
          uri,
          startOffset: text.indexOf("1"),
          endOffset: text.indexOf("1") + 1,
          newText: "2",
          kind: "replace",
        },
      ],
      {
        documentUri: uri,
        userEditSince: NesStringEdit.empty,
      },
    );
    const cache = new NextEditCache(10);
    cache.put(entry);
    const reportedEdit = NesStringEdit.single(
      new NesStringReplacement({ start: 0, endOffset: 0 }, "// "),
    );
    cache.handleDocumentEdit(uri, reportedEdit, "inconsistent live text");
    expect(entry.userEditSince).toBeUndefined();

    const laterEdit = NesStringEdit.single(
      new NesStringReplacement({ start: 0, endOffset: 0 }, "!"),
    );
    cache.handleDocumentEdit(uri, laterEdit, "!inconsistent live text");
    expect(entry.userEditSince).toBeUndefined();
    expect(cache.lookup(uri, "!inconsistent live text", 0)).toBeUndefined();
  });

  it.each([
    {
      label: "speculative global zero",
      speculative: true,
      subsequentN: 0,
      withUserEdit: false,
    },
    {
      label: "regular global one",
      speculative: false,
      subsequentN: 1,
      withUserEdit: true,
    },
    {
      label: "inconsistent regular global zero",
      speculative: false,
      subsequentN: 0,
      withUserEdit: false,
    },
  ])(
    "keeps $label entries exact-only after document edits",
    ({ speculative, subsequentN, withUserEdit }) => {
      const uri = "file:///exact-only.ts";
      const text = "const value = ;";
      const offset = text.indexOf(";");
      const cache = new NextEditCache(10, {
        absorbSubsequenceTyping: true,
        reverseAgreement: true,
        maxImperfectAgreementLength: 1,
      });
      cache.putStreamedEdit(
        {
          activeDocumentUri: uri,
          activeDocumentText: text,
          activeDocumentIsOpen: true,
          firstEditWindow: { startOffset: 0, endOffset: text.length },
          activeCursorOffset: offset,
          requestId: `exact-${subsequentN}`,
          createdAt: 1,
          source: "llm",
          speculative,
          ...(withUserEdit ? { userEditSince: NesStringEdit.empty } : {}),
        },
        {
          edit: {
            uri,
            startOffset: offset,
            endOffset: offset,
            newText: "result",
            kind: "insert",
          },
          documentBeforeEdit: text,
          currentTargetDocumentText: text,
          subsequentN,
        },
      );
      const typing = NesStringEdit.single(
        new NesStringReplacement({ start: offset, endOffset: offset }, "r"),
      );
      const current = typing.apply(text);
      cache.handleDocumentEdit(uri, typing, current);

      expect(cache.lookup(uri, current, offset + 1)).toBeUndefined();
    },
  );

  it("keeps the active cross-file alias exact-only after active edits", () => {
    const activeUri = "file:///active-alias.ts";
    const activeText = "runTarget();";
    const targetUri = "file:///alias-target.ts";
    const targetText = "const target = 1;";
    const cache = new NextEditCache(10);
    cache.putStreamedEdit(
      {
        activeDocumentUri: activeUri,
        activeDocumentText: activeText,
        activeDocumentIsOpen: true,
        firstEditWindow: { startOffset: 0, endOffset: activeText.length },
        activeCursorOffset: 3,
        requestId: "active-alias",
        createdAt: 1,
        source: "llm",
        speculative: false,
        userEditSince: NesStringEdit.empty,
      },
      {
        edit: {
          uri: targetUri,
          startOffset: targetText.indexOf("1"),
          endOffset: targetText.indexOf("1") + 1,
          newText: "2",
          kind: "replace",
        },
        documentBeforeEdit: targetText,
        currentTargetDocumentText: targetText,
        subsequentN: 0,
      },
    );
    const typing = NesStringEdit.single(
      new NesStringReplacement(
        { start: activeText.length, endOffset: activeText.length },
        " ",
      ),
    );
    const current = typing.apply(activeText);
    cache.handleDocumentEdit(activeUri, typing, current);

    expect(
      cache.lookup(activeUri, current, 3, (uri) =>
        uri === targetUri ? targetText : undefined,
      ),
    ).toBeUndefined();
  });

  it("does not rebase a cached edit across an unrelated strict document change", () => {
    const cache = new NextEditCache(5);
    const text = "const value = 1;\nconsole.log(value);";
    cache.put(
      cacheEntry(text, [
        {
          uri: "file:///a.ts",
          startOffset: text.indexOf("1"),
          endOffset: text.indexOf("1") + 1,
          newText: "2",
          kind: "replace",
        },
      ]),
    );
    const prefix = "// note\n";
    const current = `${prefix}${text}`;
    const lookup = cache.lookup(
      "file:///a.ts",
      current,
      prefix.length + text.indexOf("1"),
    );
    expect(lookup).toBeUndefined();
  });

  it("rebases a cached edit while the user types through the suggestion", () => {
    const cache = new NextEditCache(5, {
      absorbSubsequenceTyping: true,
      reverseAgreement: true,
      maxImperfectAgreementLength: 1,
    });
    const text = "const value = ;";
    const offset = text.indexOf(";");
    cache.put(
      cacheEntry(
        text,
        [
          {
            uri: "file:///a.ts",
            startOffset: offset,
            endOffset: offset,
            newText: "result",
            kind: "insert",
          },
        ],
        { userEditSince: NesStringEdit.empty },
      ),
    );
    const typing = NesStringEdit.single(
      new NesStringReplacement({ start: offset, endOffset: offset }, "r"),
    );
    const current = typing.apply(text);
    cache.handleDocumentEdit("file:///a.ts", typing, current);
    const lookup = cache.lookup("file:///a.ts", current, offset + 1);
    expect(lookup).toMatchObject({
      rebased: true,
      edit: {
        startOffset: offset,
        endOffset: offset + 1,
        newText: "result",
      },
    });
  });

  it("keeps post-edit coordinates for a subsequent cache entry", () => {
    const cache = new NextEditCache(5);
    const text = "one\ntwo\nthree";
    cache.put(
      cacheEntry(text, [
        {
          uri: "file:///a.ts",
          startOffset: 0,
          endOffset: 3,
          newText: "first",
          kind: "replace",
        },
        {
          uri: "file:///a.ts",
          startOffset: 6,
          endOffset: 9,
          newText: "second",
          kind: "replace",
        },
      ]),
    );
    const subsequent = cache.createSubsequent("request-1");
    expect(subsequent).toMatchObject({
      documentText: "first\ntwo\nthree",
      subsequentN: 1,
    });
    expect(subsequent?.edits[0]).toMatchObject({
      startOffset: 6,
      endOffset: 9,
      newText: "second",
    });
  });

  it("keeps no-suggestion entries exact and window-scoped", () => {
    const cache = new NextEditCache(5);
    const text = "one\ntwo\nthree";
    cache.put(
      cacheEntry(text, [], {
        editWindow: { startOffset: 4, endOffset: 7 },
      }),
    );
    expect(cache.lookup("file:///a.ts", text, 5)).toMatchObject({
      noSuggestions: true,
    });
    expect(cache.lookup("file:///a.ts", text, 0)).toBeUndefined();
    expect(cache.lookup("file:///a.ts", `${text}!`, 5)).toBeUndefined();
  });

  it("marks an exact entry rejected when the cursor moves farther away", () => {
    const text = "zero\none\ntwo\nthree";
    const entry = cacheEntry(
      text,
      [
        {
          uri: "file:///a.ts",
          startOffset: text.indexOf("one"),
          endOffset: text.indexOf("one") + 3,
          newText: "first",
          kind: "replace",
        },
      ],
      {
        cursorOffset: text.indexOf("one"),
        editWindow: { startOffset: 0, endOffset: text.length },
      },
    );
    const cache = new NextEditCache(
      5,
      {
        absorbSubsequenceTyping: false,
        reverseAgreement: true,
        maxImperfectAgreementLength: 1,
      },
      true,
    );
    cache.put(entry);
    expect(cache.lookup("file:///a.ts", text, text.length)?.entry).toBe(entry);
    expect(entry.rejected).toBe(true);
  });

  it("records cursor-distance rejection without rejecting request siblings", () => {
    const text = "zero\none\ntwo\nthree";
    const first = cacheEntry(
      text,
      [
        {
          uri: "file:///a.ts",
          startOffset: text.indexOf("one"),
          endOffset: text.indexOf("one") + 3,
          newText: "first",
          kind: "replace",
        },
      ],
      {
        requestId: "cursor-distance-request",
        cursorOffset: text.indexOf("one"),
      },
    );
    const sibling = cacheEntry(
      "sibling",
      [
        {
          uri: "file:///a.ts",
          startOffset: 7,
          endOffset: 7,
          newText: " next",
          kind: "insert",
        },
      ],
      { requestId: "cursor-distance-request", subsequentN: 1 },
    );
    const cache = new NextEditCache(
      5,
      {
        absorbSubsequenceTyping: false,
        reverseAgreement: true,
        maxImperfectAgreementLength: 1,
      },
      true,
    );
    cache.put(first);
    cache.put(sibling);

    expect(cache.lookup("file:///a.ts", text, text.length)?.entry).toBe(first);
    expect(first.rejected).toBe(true);
    cache.recordPersistentRejection(
      first.documentUri,
      first.documentText,
      first.edits[0],
    );

    expect(sibling.rejected).toBe(false);
    expect(
      cache.isPersistentlyRejected(
        first.documentUri,
        first.documentText,
        first.edits[0],
      ),
    ).toBe(true);
  });

  it("tries the original cursor window after the primary window is outside", () => {
    const text = "foo();";
    const offset = 3;
    const cache = new NextEditCache(5, {
      absorbSubsequenceTyping: false,
      reverseAgreement: true,
      maxImperfectAgreementLength: 1,
    });
    cache.put(
      cacheEntry(
        text,
        [
          {
            uri: "file:///a.ts",
            startOffset: offset,
            endOffset: offset,
            newText: "abcdef",
            kind: "insert",
          },
        ],
        {
          editWindow: { startOffset: 0, endOffset: 1 },
          originalEditWindow: { startOffset: offset, endOffset: offset },
          userEditSince: NesStringEdit.empty,
        },
      ),
    );
    const typing = NesStringEdit.single(
      new NesStringReplacement({ start: offset, endOffset: offset }, "abc"),
    );
    const current = typing.apply(text);
    cache.handleDocumentEdit("file:///a.ts", typing, current);
    expect(cache.lookup("file:///a.ts", current, 6)).toMatchObject({
      rebased: true,
      edit: { startOffset: 3, endOffset: 6, newText: "abcdef" },
    });
  });

  it("does not try the original window after a primary-window rebase failure", () => {
    const text = "foo();";
    const entry = cacheEntry(
      text,
      [
        {
          uri: "file:///a.ts",
          startOffset: 3,
          endOffset: 3,
          newText: "abcdef",
          kind: "insert",
        },
      ],
      {
        editWindow: { startOffset: 0, endOffset: text.length },
        originalEditWindow: { startOffset: 0, endOffset: text.length },
        userEditSince: NesStringEdit.empty,
      },
    );
    const cache = new NextEditCache(5);
    cache.put(entry);
    const typing = NesStringEdit.single(
      new NesStringReplacement({ start: 3, endOffset: 3 }, "x"),
    );
    const current = typing.apply(text);
    cache.handleDocumentEdit("file:///a.ts", typing, current);
    expect(cache.lookup("file:///a.ts", current, 4)).toBeUndefined();
    expect(entry.rebaseFailed).toBe(true);
  });

  it("returns a later cached edit after the first was fully typed through", () => {
    const text = "foo___bar";
    const cache = new NextEditCache(5, {
      absorbSubsequenceTyping: false,
      reverseAgreement: true,
      maxImperfectAgreementLength: 1,
    });
    cache.put(
      cacheEntry(
        text,
        [
          {
            uri: "file:///a.ts",
            startOffset: 3,
            endOffset: 3,
            newText: "abc",
            kind: "insert",
          },
          {
            uri: "file:///a.ts",
            startOffset: 9,
            endOffset: 9,
            newText: "X",
            kind: "insert",
          },
        ],
        { userEditSince: NesStringEdit.empty },
      ),
    );
    const typing = NesStringEdit.single(
      new NesStringReplacement({ start: 3, endOffset: 3 }, "abc"),
    );
    const current = typing.apply(text);
    cache.handleDocumentEdit("file:///a.ts", typing, current);
    expect(cache.lookup("file:///a.ts", current, 6)).toMatchObject({
      rebased: true,
      edit: { startOffset: 9, endOffset: 9, newText: "X" },
    });
  });

  it("creates a subsequent entry when a streamed edit arrives after acceptance", () => {
    const cache = new NextEditCache(5);
    const text = "one\ntwo\nthree";
    const first: NesTextEdit = {
      uri: "file:///a.ts",
      startOffset: 0,
      endOffset: 3,
      newText: "first",
      kind: "replace",
    };
    const entry = cacheEntry(text, [first], { speculative: true });
    cache.put(entry);
    expect(cache.markAccepted(entry)).toBeUndefined();
    cache.appendEdit(entry, {
      uri: "file:///a.ts",
      startOffset: 6,
      endOffset: 9,
      newText: "second",
      kind: "replace",
    });
    const nextText = applyEdits(text, [first]);
    expect(cache.lookup("file:///a.ts", nextText, 5)).toMatchObject({
      subsequent: true,
      speculative: true,
      edit: { startOffset: 6, endOffset: 9, newText: "second" },
    });
  });

  it("retains shared exact entries but drops rebase tracking on close", () => {
    const uri = "file:///a.ts";
    const text = "const value = 1;";
    const edit: NesTextEdit = {
      uri,
      startOffset: text.indexOf("1"),
      endOffset: text.indexOf("1") + 1,
      newText: "2",
      kind: "replace",
    };
    const entry = cacheEntry(text, [edit], {
      documentUri: uri,
      userEditSince: NesStringEdit.empty,
    });
    const cache = new NextEditCache(5);
    cache.put(entry);

    cache.removeDocument(uri);

    expect(cache.size).toBe(1);
    expect(cache.lookup(uri, text, 0)).toMatchObject({
      entry,
      edit,
      rebased: false,
    });

    const prefix = "// reopened\n";
    const typing = NesStringEdit.single(
      new NesStringReplacement({ start: 0, endOffset: 0 }, prefix),
    );
    const current = typing.apply(text);
    cache.handleDocumentEdit(uri, typing, current);
    expect(cache.lookup(uri, current, prefix.length)).toBeUndefined();
  });

  it("retains an exact rejected entry but resets document rejection tracking on close", () => {
    const uri = "file:///a.ts";
    const text = "const value = 1;";
    const edit: NesTextEdit = {
      uri,
      startOffset: text.indexOf("1"),
      endOffset: text.indexOf("1") + 1,
      newText: "2",
      kind: "replace",
    };
    const cache = new NextEditCache(5);
    const rejectedEntry = cacheEntry(text, [edit], {
      documentUri: uri,
      requestId: "rejected-before-close",
    });
    cache.put(rejectedEntry);
    cache.markRejected(rejectedEntry.requestId, edit, text, rejectedEntry);
    expect(cache.isPersistentlyRejected(uri, text, edit)).toBe(true);

    cache.removeDocument(uri);

    expect(cache.lookup(uri, text, 0)).toMatchObject({
      entry: { rejected: true },
      edit,
    });
    expect(cache.isPersistentlyRejected(uri, text, edit)).toBe(false);
    cache.recordPersistentRejection(uri, text, edit);
    expect(cache.isPersistentlyRejected(uri, text, edit)).toBe(true);

    const collectorOnlyCache = new NextEditCache(5);
    collectorOnlyCache.recordPersistentRejection(uri, text, edit);
    collectorOnlyCache.removeDocument(uri);
    expect(collectorOnlyCache.isRejected(uri, text, edit)).toBe(false);
  });

  it("evicts least-recently inserted entries without clearing exact entries on close", () => {
    const cache = new NextEditCache(2);
    for (let index = 0; index < 3; index += 1) {
      cache.put(
        cacheEntry(`text-${index}`, [], {
          requestId: `request-${index}`,
          documentUri: index === 2 ? "file:///b.ts" : "file:///a.ts",
        }),
      );
    }
    expect(cache.size).toBe(2);
    expect(cache.lookup("file:///a.ts", "text-0", 1)).toBeUndefined();
    cache.removeDocument("file:///a.ts");
    expect(cache.size).toBe(2);
    expect(cache.lookup("file:///a.ts", "text-1", 1)).toBeDefined();
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
