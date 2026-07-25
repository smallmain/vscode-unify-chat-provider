import type { MercuryEditCompletionRequest } from '../model/requests';
import {
  computeDocumentLegacyRanges,
  excerptByteRangeToDocumentUtf16Range,
} from '../edit/ranges';
import { utf8ByteOffsetToUtf16Offset } from '../edit/utf8';

export interface MercuryPrompt {
  readonly prompt: string;
  readonly editableStart: number;
  readonly editableEnd: number;
}

function delimited(start: string, content: string, end: string): string {
  return `${start}\n${content}\n${end}\n`;
}

function eventText(
  entry: MercuryEditCompletionRequest['editHistory'][number],
  fallbackPath: string,
): string {
  const path = entry.path ?? fallbackPath;
  return `${entry.predicted ? '// User accepted prediction:\n' : ''}--- a/${path}\n+++ b/${path}\n${entry.diff ?? ''}`;
}

export function buildMercuryPrompt(
  request: MercuryEditCompletionRequest,
): MercuryPrompt {
  const { document } = request;
  const selection = computeDocumentLegacyRanges(document);
  const editableByteRange = selection.ranges.editable350;
  const editableInExcerpt = {
    start: utf8ByteOffsetToUtf16Offset(
      selection.excerpt.text,
      editableByteRange.start,
    ),
    end: utf8ByteOffsetToUtf16Offset(
      selection.excerpt.text,
      editableByteRange.end,
    ),
  };
  const editableInDocument = excerptByteRangeToDocumentUtf16Range(
    selection,
    editableByteRange,
  );
  if (
    editableInExcerpt.start === undefined ||
    editableInExcerpt.end === undefined ||
    !editableInDocument
  ) {
    throw new Error('Mercury context contains an invalid UTF-8 range.');
  }
  const snippets = request.contexts
    .filter(
      (context) => {
        const sameFile =
          context.uri === document.uri ||
          (context.path !== undefined && context.path === document.path);
        if (!sameFile || context.range === undefined) return true;
        return !(
          context.range.startOffset >= selection.excerpt.utf16Range.start &&
          context.range.endOffset <= selection.excerpt.utf16Range.end
        );
      },
    )
    .map((context) =>
      delimited(
        '<|recently_viewed_code_snippet|>',
        `code_snippet_file_path: ${context.path ?? 'context'}\n${context.content}`,
        '<|/recently_viewed_code_snippet|>',
      ),
    )
    .join('');
  const editable = selection.excerpt.text.slice(
    editableInExcerpt.start,
    editableInExcerpt.end,
  );
  const cursorInExcerpt = utf8ByteOffsetToUtf16Offset(
    selection.excerpt.text,
    selection.excerpt.cursorByteOffset,
  );
  if (cursorInExcerpt === undefined) {
    throw new Error('Mercury cursor contains an invalid UTF-8 offset.');
  }
  const cursorInEditable = cursorInExcerpt - editableInExcerpt.start;
  const currentContent =
    `current_file_path: ${document.path ?? 'untitled'}\n` +
    selection.excerpt.text.slice(0, editableInExcerpt.start) +
    delimited(
      '<|code_to_edit|>',
      `${editable.slice(0, cursorInEditable)}<|cursor|>${editable.slice(cursorInEditable)}`,
      '<|/code_to_edit|>',
    ) +
    selection.excerpt.text.slice(editableInExcerpt.end);
  const history = request.editHistory
    .slice(-10)
    .map((entry) => eventText(entry, document.path ?? 'untitled'))
    .join('');
  return {
    prompt: [
      delimited(
        '<|recently_viewed_code_snippets|>',
        snippets,
        '<|/recently_viewed_code_snippets|>',
      ),
      delimited(
        '<|current_file_content|>',
        currentContent,
        '<|/current_file_content|>',
      ),
      delimited(
        '<|edit_diff_history|>',
        history,
        '<|/edit_diff_history|>',
      ),
    ].join(''),
    editableStart: editableInDocument.start,
    editableEnd: editableInDocument.end,
  };
}
