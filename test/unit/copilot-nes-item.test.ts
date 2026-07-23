import type * as vscode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  documents: [] as vscode.TextDocument[],
  inline: undefined as
    { readonly range: vscode.Range; readonly newText: string } | undefined,
}));

vi.mock("vscode", () => {
  class Position {
    constructor(
      readonly line: number,
      readonly character: number,
    ) {}
  }

  class Range {
    constructor(
      readonly start: Position,
      readonly end: Position,
    ) {}
  }

  class Uri {
    static parse(value: string): Uri {
      return new Uri(value);
    }

    readonly scheme: string;

    constructor(private readonly value: string) {
      this.scheme = value.slice(0, value.indexOf(":"));
    }

    toString(): string {
      return this.value;
    }
  }

  class InlineCompletionItem {
    uri?: Uri;
    isInlineEdit?: boolean;
    showInlineEditMenu?: boolean;
    correlationId?: string;
    jumpToPosition?: Position;
    showRange?: Range;
    displayLocation?: vscode.InlineCompletionDisplayLocation;
    command?: vscode.Command;

    constructor(
      readonly insertText: string,
      readonly range?: Range,
    ) {}
  }

  return {
    Position,
    Range,
    Uri,
    InlineCompletionItem,
    InlineCompletionDisplayLocationKind: { Code: 1, Label: 2 },
    workspace: {
      get textDocuments() {
        return mock.documents;
      },
    },
  };
});

vi.mock(
  "../../src/chat-lib/upstream/extension/inlineEdits/vscode-node/isInlineSuggestion",
  () => ({ toInlineSuggestion: () => mock.inline }),
);

import * as vscodeApi from "vscode";
import {
  COPILOT_BEHAVIOR_CONFIG,
  type CopilotBehaviorConfig,
} from "../../src/chat-lib/core/behavior-config";
import type { NesCacheEntry } from "../../src/chat-lib/core/nes/cache";
import type { CompletionAlgorithmInput } from "../../src/completion/types";
import { convertNesSuggestionToItem } from "../../src/completion/copilot/nes-item";
import type { NesBranchSuggestion } from "../../src/completion/copilot/nes-provider";
import {
  isPresentableNesSuggestion,
  shouldCaptureNesSuggestion,
  shouldEnforceRoutedNesCacheDelay,
} from "../../src/completion/copilot/runtime-routing";

function document(
  uri: string,
  text: string,
  languageId = "typescript",
): vscode.TextDocument {
  const parsed = vscodeApi.Uri.parse(uri);
  const positionAt = (offset: number): vscode.Position => {
    const lines = text.slice(0, offset).split("\n");
    return new vscodeApi.Position(lines.length - 1, lines.at(-1)?.length ?? 0);
  };
  return {
    uri: parsed,
    languageId,
    version: 1,
    isClosed: false,
    getText: () => text,
    positionAt,
  } as vscode.TextDocument;
}

function input(target: vscode.TextDocument): CompletionAlgorithmInput {
  return {
    document: target,
    position: new vscodeApi.Position(0, 3),
    context: {
      requestUuid: "request-1",
      requestIssuedDateTime: 0,
    } as vscode.InlineCompletionContext,
  };
}

function suggestion(
  edit: NesBranchSuggestion["edit"],
  overrides: Partial<NesBranchSuggestion> = {},
): NesBranchSuggestion {
  return {
    branch: "nes",
    source: "llm",
    requestId: "request-1",
    sourceRequestId: "request-1",
    ...(edit ? { edit } : {}),
    fromCache: false,
    rebased: false,
    subsequent: false,
    speculative: false,
    sourceIsSpeculative: false,
    createdAt: 0,
    ...overrides,
  };
}

function behavior(
  nextEdit: Partial<CopilotBehaviorConfig["nextEdit"]> = {},
): CopilotBehaviorConfig {
  return {
    ...COPILOT_BEHAVIOR_CONFIG,
    nextEdit: { ...COPILOT_BEHAVIOR_CONFIG.nextEdit, ...nextEdit },
  };
}

const options = {
  enableFIM: false,
  enableNES: true,
  n: 1,
  includeInlineCompletions: false,
  includeInlineEdits: true,
};

beforeEach(() => {
  mock.documents = [];
  mock.inline = undefined;
});

describe("Copilot NES item conversion", () => {
  it("skips routed cache delay only for a shown same-document suggestion at the same version", () => {
    const shown = {
      documentUri: "file:///workspace/main.ts",
      documentVersion: 7,
      wasShown: true,
    };
    expect(
      shouldEnforceRoutedNesCacheDelay(
        undefined,
        "file:///workspace/main.ts",
        7,
      ),
    ).toBe(true);
    expect(
      shouldEnforceRoutedNesCacheDelay(
        { ...shown, wasShown: false },
        "file:///workspace/main.ts",
        7,
      ),
    ).toBe(true);
    expect(
      shouldEnforceRoutedNesCacheDelay(shown, "file:///workspace/other.ts", 7),
    ).toBe(true);
    expect(
      shouldEnforceRoutedNesCacheDelay(shown, "file:///workspace/main.ts", 8),
    ).toBe(true);
    expect(
      shouldEnforceRoutedNesCacheDelay(shown, "file:///workspace/main.ts", 7),
    ).toBe(false);
  });

  it("captures an omitted item uri only when the underlying edit is same-file", () => {
    expect(
      shouldCaptureNesSuggestion(
        undefined,
        "file:///workspace/main.ts",
        "file:///workspace/main.ts",
      ),
    ).toBe(true);
    expect(
      shouldCaptureNesSuggestion(
        undefined,
        "vscode-notebook-cell:/book#cell-2",
        "vscode-notebook-cell:/book#cell-1",
      ),
    ).toBe(false);
  });

  it("lets the runtime present edit results and pure fallback jumps", () => {
    expect(isPresentableNesSuggestion(true, false)).toBe(true);
    expect(isPresentableNesSuggestion(false, true)).toBe(true);
    expect(isPresentableNesSuggestion(false, false)).toBe(false);
  });

  it("omits uri and showRange for a regular same-file edit", () => {
    const source = document("file:///workspace/main.ts", "const value = 1;");
    mock.documents = [source];
    const converted = convertNesSuggestionToItem(
      input(source),
      suggestion({
        uri: source.uri.toString(),
        startOffset: 6,
        endOffset: 11,
        newText: "result",
        kind: "replace",
      }),
      options,
      behavior(),
    );
    expect(converted?.item).toMatchObject({
      insertText: "result",
      isInlineEdit: true,
      showInlineEditMenu: true,
    });
    expect(converted?.item.uri).toBeUndefined();
    expect(converted?.item.showRange).toBeUndefined();
  });

  it("hides the inline-edit menu for a unified-model insertion", () => {
    const source = document("file:///workspace/main.ts", "const value = 1;");
    mock.documents = [source];
    mock.inline = {
      range: new vscodeApi.Range(input(source).position, input(source).position),
      newText: "result",
    };

    const converted = convertNesSuggestionToItem(
      input(source),
      suggestion({
        uri: source.uri.toString(),
        startOffset: 3,
        endOffset: 3,
        newText: "result",
        kind: "insert",
      }),
      {
        ...options,
        modelUnification: true,
        includeInlineCompletions: true,
      },
      behavior(),
    );

    expect(converted).toMatchObject({
      renderedInline: true,
      item: {
        insertText: "result",
        isInlineEdit: false,
        showInlineEditMenu: false,
      },
    });
  });

  it("sets uri only for a regular cross-file edit", () => {
    const source = document("file:///workspace/main.ts", "const value = 1;");
    const target = document(
      "file:///workspace/other.ts",
      "export const x = 1;",
    );
    mock.documents = [source, target];
    const converted = convertNesSuggestionToItem(
      input(source),
      suggestion({
        uri: target.uri.toString(),
        startOffset: 13,
        endOffset: 14,
        newText: "2",
        kind: "replace",
      }),
      options,
      behavior(),
    );
    expect(converted?.item.uri).toBe(target.uri);
    expect(converted?.item.showRange).toBeUndefined();
  });

  it("creates a pure cross-file cursor jump when opening the target failed", () => {
    const source = document("file:///workspace/main.ts", "const value = 1;");
    mock.documents = [source];
    const converted = convertNesSuggestionToItem(
      input(source),
      suggestion(undefined, {
        cursorJump: {
          kind: "differentFile",
          sourceUri: source.uri.toString(),
          targetUri: "file:///workspace/missing.ts",
          lineNumber: 7,
          fallbackOnly: true,
        },
      }),
      options,
      behavior(),
    );
    expect(converted).toMatchObject({
      renderedInline: false,
      item: {
        insertText: undefined,
        correlationId: "request-1:cursor-jump",
        jumpToPosition: { line: 7, character: 0 },
      },
    });
    expect(converted?.item.uri?.toString()).toBe(
      "file:///workspace/missing.ts",
    );
    expect(converted?.item.command).toBeUndefined();
    expect(converted?.item.range).toBeUndefined();
    expect(converted?.item.isInlineEdit).toBeUndefined();
    expect(converted?.item.showInlineEditMenu).toBeUndefined();
  });

  it("suppresses a pure cursor jump while NES serves as completions", () => {
    const source = document("file:///workspace/main.ts", "const value = 1;");
    mock.documents = [source];
    const converted = convertNesSuggestionToItem(
      input(source),
      suggestion(undefined, {
        cursorJump: {
          kind: "differentFile",
          sourceUri: source.uri.toString(),
          targetUri: "file:///workspace/missing.ts",
          lineNumber: 7,
          fallbackOnly: true,
        },
      }),
      options,
      behavior(),
      true,
    );
    expect(converted).toBeUndefined();
  });

  it("keeps a different notebook cell as a regular cross-document edit by default", () => {
    const source = document(
      "vscode-notebook-cell:/workspace/book.ipynb#cell-1",
      "const value = 1;",
    );
    const target = document(
      "vscode-notebook-cell:/workspace/book.ipynb#cell-2",
      "const target = 1;",
    );
    mock.documents = [source, target];
    const converted = convertNesSuggestionToItem(
      input(source),
      suggestion({
        uri: target.uri.toString(),
        startOffset: 15,
        endOffset: 16,
        newText: "2",
        kind: "replace",
      }),
      options,
      behavior(),
    );

    expect(converted?.item.uri).toBe(target.uri);
    expect(converted?.item.range).toEqual(
      new vscodeApi.Range(target.positionAt(15), target.positionAt(16)),
    );
    expect(converted?.item.showRange).toBeUndefined();
    expect(converted?.item.displayLocation).toBeUndefined();
    expect(converted?.item.command).toBeUndefined();
  });

  it.each([
    {
      label: "file",
      sourceUri: "file:///workspace/main.ts",
      targetUri: "file:///workspace/other.md",
    },
    {
      label: "notebook cell",
      sourceUri: "vscode-notebook-cell:/workspace/book.ipynb#cell-1",
      targetUri: "vscode-notebook-cell:/workspace/book.ipynb#cell-2",
    },
  ])(
    "suppresses a cross-$label edit when its target language is disabled",
    ({ sourceUri, targetUri }) => {
      const source = document(sourceUri, "const value = 1;");
      const target = document(targetUri, "# target", "markdown");
      mock.documents = [source, target];

      expect(
        convertNesSuggestionToItem(
          input(source),
          suggestion({
            uri: target.uri.toString(),
            startOffset: 2,
            endOffset: 8,
            newText: "result",
            kind: "replace",
          }),
          {
            ...options,
            inlineEditsEnabledLanguages: {
              "*": false,
              typescript: true,
            },
          },
          behavior(),
        ),
      ).toBeUndefined();
    },
  );

  it.each([
    {
      label: "file",
      sourceUri: "file:///workspace/main.ts",
      targetUri: "file:///workspace/other.py",
    },
    {
      label: "notebook cell",
      sourceUri: "vscode-notebook-cell:/workspace/book.ipynb#cell-1",
      targetUri: "vscode-notebook-cell:/workspace/book.ipynb#cell-2",
    },
  ])(
    "keeps a cross-$label edit when its target language is enabled",
    ({ sourceUri, targetUri }) => {
      const source = document(sourceUri, "const value = 1;");
      const target = document(targetUri, "value = 1", "python");
      mock.documents = [source, target];

      const converted = convertNesSuggestionToItem(
        input(source),
        suggestion({
          uri: target.uri.toString(),
          startOffset: 8,
          endOffset: 9,
          newText: "2",
          kind: "replace",
        }),
        {
          ...options,
          inlineEditsEnabledLanguages: {
            "*": false,
            typescript: true,
            python: true,
          },
        },
        behavior(),
      );

      expect(converted?.item.uri).toBe(target.uri);
      expect(converted?.item.insertText).toBe("2");
    },
  );

  it("creates the navigation item for a different notebook cell in alternative format", () => {
    const source = document(
      "vscode-notebook-cell:/workspace/book.ipynb#cell-1",
      "const value = 1;",
    );
    const target = document(
      "vscode-notebook-cell:/workspace/book.ipynb#cell-2",
      "const target = 1;",
    );
    mock.documents = [source, target];
    const converted = convertNesSuggestionToItem(
      input(source),
      suggestion({
        uri: target.uri.toString(),
        startOffset: 15,
        endOffset: 16,
        newText: "2",
        kind: "replace",
      }),
      options,
      behavior({ useAlternativeNotebookFormat: true }),
    );
    expect(converted?.item.uri).toBeUndefined();
    expect(converted?.item.range).toEqual(
      new vscodeApi.Range(input(source).position, input(source).position),
    );
    expect(converted?.item.showRange).toEqual(converted?.item.range);
    expect(converted?.item.displayLocation).toMatchObject({
      label: "Go To Inline Suggestion",
      kind: vscodeApi.InlineCompletionDisplayLocationKind.Label,
    });
    expect(converted?.item.command).toMatchObject({
      command: "vscode.open",
      title: "Go To Inline Suggestion",
    });
    expect(converted?.item.command?.arguments?.[0]).toBe(target.uri);
    expect(converted?.item.command?.arguments?.[1]).toMatchObject({
      preserveFocus: false,
    });
  });

  it("preserves diagnostics display locations as Code locations", () => {
    const source = document(
      "file:///workspace/main.ts",
      "const value = missing;",
    );
    mock.documents = [source];
    const displayRange = new vscodeApi.Range(
      new vscodeApi.Position(0, 14),
      new vscodeApi.Position(0, 21),
    );
    const diagnosticsSuggestion = {
      source: "diagnostics" as const,
      kind: "import" as const,
      id: "diagnostic",
      rejectionKey: "missing",
      edit: {
        uri: source.uri.toString(),
        startOffset: 0,
        endOffset: 0,
        newText: "import { missing } from './missing';\n",
        kind: "insert" as const,
      },
      title: "Add import from './missing'",
      sourceDocument: {
        uri: source.uri.toString(),
        version: 1,
        text: source.getText(),
      },
      targetDocument: {
        uri: source.uri.toString(),
        version: 1,
        text: source.getText(),
      },
      importName: "missing",
      diagnostic: {
        uri: source.uri.toString(),
        message: "Cannot find name 'missing'",
        code: "2304",
        start: 14,
        end: 21,
      },
      displayLocation: {
        uri: source.uri.toString(),
        range: displayRange,
        label: "import missing",
      },
    };
    const converted = convertNesSuggestionToItem(
      input(source),
      suggestion(diagnosticsSuggestion.edit, {
        branch: "diagnostics",
        source: "diagnostics",
        diagnosticsSuggestion,
      }),
      options,
      behavior(),
    );
    expect(converted?.item.displayLocation).toEqual({
      range: displayRange,
      label: "import missing",
      kind: vscodeApi.InlineCompletionDisplayLocationKind.Code,
    });
  });

  it("filters notebook markers only for notebook sources and honors mimic mode", () => {
    const file = document("file:///workspace/main.ts", "const value = 1;");
    const notebook = document(
      "vscode-notebook-cell:/workspace/book.ipynb#cell-1",
      "const value = 1;",
    );
    mock.documents = [file, notebook];
    const markerEdit = {
      startOffset: 0,
      endOffset: 0,
      newText: "%% vscode.cell [id=bad]",
      kind: "insert" as const,
    };
    expect(
      convertNesSuggestionToItem(
        input(file),
        suggestion({ ...markerEdit, uri: file.uri.toString() }),
        options,
        behavior(),
      ),
    ).toBeDefined();
    expect(
      convertNesSuggestionToItem(
        input(notebook),
        suggestion({ ...markerEdit, uri: notebook.uri.toString() }),
        options,
        behavior(),
      ),
    ).toBeUndefined();

    const cacheEntry: NesCacheEntry = {
      documentUri: file.uri.toString(),
      documentText: file.getText(),
      editWindow: { startOffset: 0, endOffset: file.getText().length },
      cursorOffset: 3,
      requestId: "request-1",
      createdAt: 0,
      edits: [{ ...markerEdit, uri: file.uri.toString() }],
      source: "llm",
      subsequentN: 0,
      speculative: false,
      rejected: false,
      wasShown: true,
      wasRenderedAsInlineSuggestion: true,
    };
    expect(
      convertNesSuggestionToItem(
        input(file),
        suggestion(
          {
            uri: file.uri.toString(),
            startOffset: 6,
            endOffset: 11,
            newText: "result",
            kind: "replace",
          },
          { cacheEntry },
        ),
        options,
        behavior({ mimicGhostTextBehavior: true }),
      ),
    ).toBeUndefined();

    const unseenLaterEntry: NesCacheEntry = {
      ...cacheEntry,
      documentText: "const result = 1;",
      subsequentN: 1,
      wasShown: false,
      wasRenderedAsInlineSuggestion: false,
    };
    expect(
      convertNesSuggestionToItem(
        input(file),
        suggestion(
          {
            uri: file.uri.toString(),
            startOffset: 6,
            endOffset: 11,
            newText: "result",
            kind: "replace",
          },
          { cacheEntry: unseenLaterEntry },
        ),
        options,
        behavior({ mimicGhostTextBehavior: true }),
      ),
    ).toBeDefined();
  });
});
