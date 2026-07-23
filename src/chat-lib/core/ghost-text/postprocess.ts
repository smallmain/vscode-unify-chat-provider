import type {
  GhostTextBehavior,
  GhostTextCompletionItem,
  GhostTextFormattingOptions,
  GhostTextModelChoice,
  GhostTextPosition,
  GhostTextPrompt,
  GhostTextRequest,
  GhostTextResultSource,
  GhostTextTokenizer,
} from './types';
import {
  lineBoundsAtOffset,
  offsetAt,
  positionAt,
} from './prompt';
import {
  forceSingleLine,
  trimMultilineCompletion,
  type GhostTextMultilineStrategy,
} from './multiline';

export interface ProcessedGhostTextChoice {
  choice: GhostTextModelChoice;
  completionText: string;
  displayText: string;
  displayNeedsWhitespaceOffset: boolean;
  suffixCoverage: number;
}

export function determineInlineSuggestionPosition(
  textAfterCursor: string,
): boolean | undefined {
  const isMiddleOfLine = textAfterCursor.trim().length !== 0;
  const validMiddleOfLine = /^\s*[)>}\]"'`]*\s*[:{;,]?\s*$/.test(
    textAfterCursor.trim(),
  );
  return isMiddleOfLine && !validMiddleOfLine
    ? undefined
    : isMiddleOfLine && validMiddleOfLine;
}

export async function processGhostTextChoice(
  request: GhostTextRequest,
  prompt: GhostTextPrompt,
  choice: GhostTextModelChoice,
  multiline: boolean,
  afterAcceptedCompletion: boolean,
  behavior: GhostTextBehavior,
  tokenizer: GhostTextTokenizer,
  multilineStrategy?: GhostTextMultilineStrategy,
): Promise<ProcessedGhostTextChoice | undefined> {
  let completionText = choice.completionText.trimEnd();
  if (!completionText) {
    return undefined;
  }
  completionText = multiline
    ? await trimMultilineCompletion(
        completionText,
        request.document.languageId,
        behavior,
        afterAcceptedCompletion,
        prompt.virtualDocumentText,
        prompt.virtualCursorOffset,
        multilineStrategy,
      )
    : forceSingleLine(completionText);
  if (!completionText) {
    return undefined;
  }
  if (isRepetitive(tokenizer.tokenizeStrings(completionText))) {
    return undefined;
  }

  const cursorPosition = positionAt(
    prompt.virtualDocumentText,
    prompt.virtualCursorOffset,
  );
  if (
    matchesNextNonEmptyLine(
      prompt.virtualDocumentText,
      cursorPosition.line,
      completionText,
      !multiline,
    )
  ) {
    return undefined;
  }
  completionText = snipDuplicateClosingLines(
    prompt.virtualDocumentText,
    cursorPosition.line,
    completionText,
    blockCloseToken(request.document.languageId),
  );
  if (!completionText) {
    return undefined;
  }

  const line = lineBoundsAtOffset(
    prompt.virtualDocumentText,
    prompt.virtualCursorOffset,
  );
  const afterCursor = line.text.slice(prompt.virtualCursorOffset - line.start);
  const suffixCoverage = suffixCoverageLength(afterCursor, completionText);
  const adjusted = adjustLeadingWhitespace(
    choice.choiceIndex,
    completionText,
    prompt.trailingWhitespace,
  );
  const normalized = normalizeIndentCharacter(
    request.formattingOptions,
    adjusted,
    line.text.trim().length === 0,
  );
  return {
    choice: { ...choice, completionText },
    completionText: normalized.completionText,
    displayText: normalized.displayText,
    displayNeedsWhitespaceOffset: normalized.displayNeedsWhitespaceOffset,
    suffixCoverage,
  };
}

export function createGhostTextItem(
  id: string,
  listSource: GhostTextResultSource,
  request: GhostTextRequest,
  prompt: GhostTextPrompt,
  processed: ProcessedGhostTextChoice,
): GhostTextCompletionItem | undefined {
  const position = positionAt(
    prompt.virtualDocumentText,
    prompt.virtualCursorOffset,
  );
  const currentLine = lineBoundsAtOffset(
    prompt.virtualDocumentText,
    prompt.virtualCursorOffset,
  );
  let insertText: string;
  if (
    currentLine.text.trim().length === 0 &&
    (processed.displayNeedsWhitespaceOffset ||
      processed.completionText.startsWith(currentLine.text))
  ) {
    insertText = processed.completionText;
  } else {
    insertText =
      prompt.virtualDocumentText.slice(
        currentLine.start,
        prompt.virtualCursorOffset,
      ) + processed.displayText;
  }
  const adjustedEndCharacter = Math.max(
    0,
    position.character +
      processed.suffixCoverage -
      prompt.selectedCompletionLineLengthIncrease,
  );
  const range = {
    start: { line: position.line, character: 0 },
    end: { line: position.line, character: adjustedEndCharacter },
  };

  if (isNoOp(request, range.start, range.end, insertText)) {
    return undefined;
  }
  return {
    id,
    insertText,
    displayText: processed.displayText,
    range,
    metadata: {
      requestId: processed.choice.requestId,
      clientCompletionId: processed.choice.clientCompletionId,
      ...(request.opportunityId ? { opportunityId: request.opportunityId } : {}),
      choiceIndex: processed.choice.choiceIndex,
      ...(processed.choice.generatedChoiceIndex === undefined
        ? {}
        : { generatedChoiceIndex: processed.choice.generatedChoiceIndex }),
      source: listSource,
      isMiddleOfLine:
        determineInlineSuggestionPosition(
          currentLine.text.slice(prompt.virtualCursorOffset - currentLine.start),
        ) === true,
      suffixCoverage: processed.suffixCoverage,
      ...(processed.choice.finishReason === undefined
        ? {}
        : { finishReason: processed.choice.finishReason }),
      ...(processed.choice.usage === undefined
        ? {}
        : { usage: processed.choice.usage }),
    },
  };
}

function isNoOp(
  request: GhostTextRequest,
  start: GhostTextPosition,
  end: GhostTextPosition,
  insertText: string,
): boolean {
  const startOffset = offsetAt(request.document.text, start);
  const endOffset = offsetAt(request.document.text, end);
  return (
    startOffset !== undefined &&
    endOffset !== undefined &&
    request.document.text.slice(startOffset, endOffset) === insertText
  );
}

function suffixCoverageLength(
  textAfterCursor: string,
  completion: string,
): number {
  if (!textAfterCursor) {
    return 0;
  }
  if (completion.includes(textAfterCursor)) {
    return textAfterCursor.length;
  }
  let previousIndex = -1;
  let length = 0;
  for (const character of textAfterCursor) {
    const index = completion.indexOf(character, previousIndex + 1);
    if (index <= previousIndex) {
      break;
    }
    length++;
    previousIndex = index;
  }
  return length;
}

function matchesNextNonEmptyLine(
  document: string,
  currentLine: number,
  completion: string,
  trim: boolean,
): boolean {
  const lines = document.split(/\r?\n/);
  const expected = trim ? completion.trim() : completion;
  for (let line = currentLine + 1; line < lines.length; line++) {
    const actual = trim ? lines[line].trim() : lines[line];
    if (actual === expected) {
      return true;
    }
    if (actual !== '') {
      return false;
    }
  }
  return false;
}

function snipDuplicateClosingLines(
  document: string,
  currentLine: number,
  completion: string,
  closeToken: string,
): string {
  const newline = completion.includes('\r\n') ? '\r\n' : '\n';
  const completionLines = completion.split(newline);
  if (completionLines.length === 1) {
    return completion;
  }
  const documentLines = document.split(/\r?\n/);
  for (let start = 1; start < completionLines.length; start++) {
    let documentOffset = 0;
    let completionOffset = 0;
    let matched = true;
    while (start + completionOffset < completionLines.length) {
      while (
        documentLines[currentLine + 1 + documentOffset]?.trim() === ''
      ) {
        documentOffset++;
      }
      while (completionLines[start + completionOffset]?.trim() === '') {
        completionOffset++;
      }
      const completionIndex = start + completionOffset;
      if (completionIndex >= completionLines.length) {
        break;
      }
      const documentLine = documentLines[currentLine + 1 + documentOffset];
      const completionLine = completionLines[completionIndex];
      const isLast = completionIndex === completionLines.length - 1;
      if (
        !documentLine ||
        !completionLine ||
        (isLast
          ? !(
              documentLine.startsWith(completionLine) ||
              completionLine.startsWith(documentLine)
            )
          : documentLine !== completionLine ||
            completionLine.trim() !== closeToken)
      ) {
        matched = false;
        break;
      }
      documentOffset++;
      completionOffset++;
    }
    if (matched) {
      return completionLines.slice(0, start).join(newline);
    }
  }
  return completion;
}

function blockCloseToken(languageId: string): string {
  const tokens: Readonly<Record<string, string>> = {
    ruby: 'end',
    lua: 'end',
    shellscript: 'fi',
    elixir: 'end',
  };
  return tokens[languageId] ?? '}';
}

interface WhitespaceAdjustedCompletion {
  completionText: string;
  displayText: string;
  displayNeedsWhitespaceOffset: boolean;
}

function adjustLeadingWhitespace(
  _index: number,
  text: string,
  whitespace: string,
): WhitespaceAdjustedCompletion {
  if (!whitespace) {
    return {
      completionText: text,
      displayText: text,
      displayNeedsWhitespaceOffset: false,
    };
  }
  if (text.startsWith(whitespace)) {
    return {
      completionText: text,
      displayText: text.slice(whitespace.length),
      displayNeedsWhitespaceOffset: false,
    };
  }
  const leadingWhitespace = text.slice(0, text.length - text.trimStart().length);
  if (whitespace.startsWith(leadingWhitespace)) {
    return {
      completionText: text,
      displayText: text.trimStart(),
      displayNeedsWhitespaceOffset: true,
    };
  }
  return {
    completionText: text,
    displayText: text,
    displayNeedsWhitespaceOffset: false,
  };
}

function normalizeIndentCharacter(
  options: GhostTextFormattingOptions | undefined,
  completion: WhitespaceAdjustedCompletion,
  isEmptyLine: boolean,
): WhitespaceAdjustedCompletion {
  if (!options || options.insertSpaces === undefined) {
    return completion;
  }
  const indentSize = options.tabSize ?? 4;
  const replaceLeading = (
    value: string,
    pattern: ' ' | '\t',
    replacement: (count: number) => string,
  ): string => {
    const expression = new RegExp(`^(${pattern})+`, 'g');
    return value
      .split('\n')
      .map((line) => {
        const trimmed = line.replace(expression, '');
        return replacement(line.length - trimmed.length) + trimmed;
      })
      .join('\n');
  };

  let completionText = completion.completionText;
  let displayText = completion.displayText;
  if (options.insertSpaces === false) {
    const normalize = (value: string) =>
      replaceLeading(
        value,
        ' ',
        (count) =>
          '\t'.repeat(Math.floor(count / indentSize)) +
          ' '.repeat(count % indentSize),
      );
    completionText = normalize(completionText);
    displayText = normalize(displayText);
  } else {
    const normalize = (value: string) =>
      replaceLeading(value, '\t', (count) => ' '.repeat(count * indentSize));
    completionText = normalize(completionText);
    displayText = normalize(displayText);
    if (isEmptyLine) {
      const roundIndent = (value: string): string => {
        if (!value) {
          return value;
        }
        const firstLine = value.split('\n')[0];
        const spaces = firstLine.length - firstLine.trimStart().length;
        const remainder = spaces % indentSize;
        return remainder === 0 || spaces === 0
          ? value
          : replaceLeading(value, ' ', (count) =>
              ' '.repeat((Math.floor(count / indentSize) + 1) * indentSize),
            );
      };
      completionText = roundIndent(completionText);
      displayText = roundIndent(displayText);
    }
  }
  return { ...completion, completionText, displayText };
}

function isRepetitive(tokens: readonly string[]): boolean {
  const reversed = [...tokens].reverse();
  return (
    containsRepeatedPattern(reversed) ||
    containsRepeatedPattern(
      reversed.filter((token) => token.trim().length > 0),
    )
  );
}

function containsRepeatedPattern<T>(values: readonly T[]): boolean {
  const prefix = kmpPrefix(values);
  const configurations = [
    { maximumSequence: 1, considered: 10 },
    { maximumSequence: 10, considered: 30 },
    { maximumSequence: 20, considered: 45 },
    { maximumSequence: 30, considered: 60 },
  ];
  return configurations.some(({ maximumSequence, considered }) => {
    if (values.length < considered) {
      return false;
    }
    return considered - 1 - prefix[considered - 1] <= maximumSequence;
  });
}

function kmpPrefix<T>(values: readonly T[]): number[] {
  if (values.length === 0) {
    return [];
  }
  const prefix = new Array<number>(values.length).fill(0);
  prefix[0] = -1;
  let candidate = -1;
  for (let index = 1; index < values.length; index++) {
    while (
      candidate >= 0 &&
      values[candidate + 1] !== values[index]
    ) {
      candidate = prefix[candidate];
    }
    if (values[candidate + 1] === values[index]) {
      candidate++;
    }
    prefix[index] = candidate;
  }
  return prefix;
}
