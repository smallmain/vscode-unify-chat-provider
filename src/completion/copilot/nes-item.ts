import * as vscode from "vscode";
import type { CopilotBehaviorConfig } from "../../chat-lib/core/behavior-config";
import { toInlineSuggestion } from "../../chat-lib/upstream/extension/inlineEdits/vscode-node/isInlineSuggestion";
import type { CompletionAlgorithmInput } from "../types";
import { isCopilotLanguageEnabled } from "./fim-runtime-utils";
import type { NesBranchSuggestion } from "./nes-provider";
import type { CopilotReplicaAlgorithmOptions } from "./options";

export interface ConvertedNesItem {
  readonly item: vscode.InlineCompletionItem;
  readonly renderedInline: boolean;
}

export function convertNesSuggestionToItem(
  input: CompletionAlgorithmInput,
  suggestion: NesBranchSuggestion,
  options: CopilotReplicaAlgorithmOptions,
  behavior: CopilotBehaviorConfig,
  serveAsCompletionsProvider = false,
): ConvertedNesItem | undefined {
  const edit = suggestion.edit;
  if (!edit && suggestion.cursorJump?.fallbackOnly) {
    if (serveAsCompletionsProvider) {
      return undefined;
    }
    const item = new vscode.InlineCompletionItem("");
    Reflect.set(item, "insertText", undefined);
    const targetUri = vscode.Uri.parse(suggestion.cursorJump.targetUri);
    const targetPosition = new vscode.Position(
      suggestion.cursorJump.lineNumber,
      0,
    );
    item.uri = targetUri;
    item.jumpToPosition = targetPosition;
    item.correlationId = `${suggestion.requestId}:cursor-jump`;
    return { item, renderedInline: false };
  }
  if (!edit || edit.kind === "cursorJump") {
    return undefined;
  }
  if (
    input.document.uri.scheme === "vscode-notebook-cell" &&
    edit.newText.includes("%% vscode.cell [id=")
  ) {
    return undefined;
  }
  const target =
    edit.uri === input.document.uri.toString()
      ? input.document
      : vscode.workspace.textDocuments.find(
          (document) => document.uri.toString() === edit.uri,
        );
  if (!target) {
    return undefined;
  }
  if (
    target !== input.document &&
    !isCopilotLanguageEnabled(
      target.languageId,
      options.inlineEditsEnabledLanguages,
    )
  ) {
    return undefined;
  }
  const includeInlineCompletions = options.includeInlineCompletions ?? true;
  const includeInlineEdits = options.includeInlineEdits ?? true;
  const range = new vscode.Range(
    target.positionAt(edit.startOffset),
    target.positionAt(edit.endOffset),
  );
  const inline =
    includeInlineCompletions && target === input.document
      ? toInlineSuggestion(
          input.position,
          input.document,
          range,
          edit.newText,
          behavior.nextEdit.inlineCompletionsAdvanced,
        )
      : undefined;
  if (!inline && !includeInlineEdits) {
    return undefined;
  }
  if (
    behavior.nextEdit.mimicGhostTextBehavior &&
    !inline &&
    suggestion.cacheEntry?.wasRenderedAsInlineSuggestion
  ) {
    return undefined;
  }

  const isDifferentNotebookCell =
    target !== input.document && target.uri.scheme === "vscode-notebook-cell";
  const navigateToDifferentNotebookCell =
    isDifferentNotebookCell && behavior.nextEdit.useAlternativeNotebookFormat;
  const itemRange = navigateToDifferentNotebookCell
    ? new vscode.Range(input.position, input.position)
    : (inline?.range ?? range);
  const item = new vscode.InlineCompletionItem(
    inline?.newText ?? edit.newText,
    itemRange,
  );
  if (target !== input.document && !navigateToDifferentNotebookCell) {
    item.uri = target.uri;
  }
  item.isInlineEdit = !inline;
  item.showInlineEditMenu = inline
    ? !(options.modelUnification ?? false)
    : true;
  item.correlationId = suggestion.cursorJump
    ? `${suggestion.requestId}:cursor-jump`
    : suggestion.requestId;
  if (navigateToDifferentNotebookCell) {
    const title = "Go To Inline Suggestion";
    item.showRange = itemRange;
    item.displayLocation = {
      range: itemRange,
      label: title,
      kind: vscode.InlineCompletionDisplayLocationKind.Label,
    };
    item.command = {
      command: "vscode.open",
      title,
      arguments: [
        target.uri,
        {
          preserveFocus: false,
          selection: new vscode.Range(range.start, range.start),
        } satisfies vscode.TextDocumentShowOptions,
      ],
    };
  } else if (suggestion.diagnosticsSuggestion?.displayLocation) {
    const displayLocation = suggestion.diagnosticsSuggestion.displayLocation;
    item.displayLocation = {
      range: displayLocation.range,
      label: displayLocation.label,
      kind: vscode.InlineCompletionDisplayLocationKind.Code,
    };
    if (suggestion.command) {
      item.command = suggestion.command;
    }
  } else if (suggestion.command) {
    item.command = suggestion.command;
  }
  return { item, renderedInline: inline !== undefined };
}
