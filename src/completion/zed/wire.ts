import type {
  EditAlgorithmDiagnostic,
  EditHistoryEntry,
} from '../model/requests';
import type {
  ZedActiveBufferDiagnostic,
  ZedBufferChangeEvent,
  ZedRelatedFile,
} from '../../client/zed/types';
import { utf16OffsetToUtf8ByteOffset } from '../edit/utf8';

function fallbackDiff(entry: EditHistoryEntry): string {
  const oldLines = entry.oldText.split('\n');
  const newLines = entry.newText.split('\n');
  return [
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
    '',
  ].join('\n');
}

export function toZedBufferChangeEvent(
  entry: EditHistoryEntry,
  fallbackPath: string,
  isInOpenSourceRepo: boolean,
): ZedBufferChangeEvent {
  const path = entry.path ?? fallbackPath;
  const oldRange = entry.oldRange ?? {
    startOffset: 0,
    endOffset: entry.oldText.length,
  };
  const newRange = entry.newRange ?? {
    startOffset: 0,
    endOffset: entry.newText.length,
  };
  return {
    event: 'BufferChange',
    path,
    old_path: path,
    diff: entry.diff ?? fallbackDiff(entry),
    old_range: {
      start: utf16OffsetToUtf8ByteOffset(entry.oldText, oldRange.startOffset),
      end: utf16OffsetToUtf8ByteOffset(entry.oldText, oldRange.endOffset),
    },
    new_range: {
      start: utf16OffsetToUtf8ByteOffset(entry.newText, newRange.startOffset),
      end: utf16OffsetToUtf8ByteOffset(entry.newText, newRange.endOffset),
    },
    predicted: entry.predicted === true,
    in_open_source_repo: isInOpenSourceRepo,
  };
}

export function toZedDiagnostic(
  diagnostic: EditAlgorithmDiagnostic,
): ZedActiveBufferDiagnostic {
  return {
    severity: diagnostic.severity ?? null,
    message: diagnostic.message,
    snippet: diagnostic.snippet,
    snippet_buffer_row_range: {
      start: diagnostic.snippetStartRow,
      end: diagnostic.snippetEndRow,
    },
    diagnostic_range_in_snippet: {
      start: diagnostic.diagnosticStartByte,
      end: diagnostic.diagnosticEndByte,
    },
  };
}

export function toZedRelatedFile(
  path: string,
  text: string,
  contextSource: 'current_file' | 'edit_history' | 'lsp',
  isInOpenSourceRepo: boolean,
  order = 0,
  rowStart = 0,
  rowEnd = Math.max(0, text.split('\n').length - 1),
  maxRow = Math.max(0, text.split('\n').length - 1),
): ZedRelatedFile {
  return {
    path,
    max_row: maxRow,
    excerpts: [
      {
        row_range: { start: rowStart, end: rowEnd },
        text,
        order,
        context_source: contextSource,
      },
    ],
    in_open_source_repo: isInOpenSourceRepo,
  };
}
