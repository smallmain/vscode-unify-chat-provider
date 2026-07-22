import type {
  CodestralCompletionRequest,
  EditAlgorithmDocument,
} from '../model/requests';
import {
  computeDocumentLegacyRanges,
} from '../edit/ranges';
import { utf8ByteOffsetToUtf16Offset } from '../edit/utf8';

export interface CodestralPromptWindow {
  readonly prompt: string;
  readonly suffix: string;
}

export function buildCodestralPromptWindow(
  document: EditAlgorithmDocument,
): CodestralPromptWindow {
  const selection = computeDocumentLegacyRanges(document);
  const context = selection.ranges.editable350Context150;
  const contextStart = utf8ByteOffsetToUtf16Offset(
    selection.excerpt.text,
    context.start,
  );
  const contextEnd = utf8ByteOffsetToUtf16Offset(
    selection.excerpt.text,
    context.end,
  );
  const cursor = utf8ByteOffsetToUtf16Offset(
    selection.excerpt.text,
    selection.excerpt.cursorByteOffset,
  );
  if (contextStart === undefined || contextEnd === undefined || cursor === undefined) {
    return { prompt: '', suffix: '' };
  }
  return {
    prompt: selection.excerpt.text.slice(contextStart, cursor),
    suffix: selection.excerpt.text.slice(cursor, contextEnd),
  };
}

export function codestralWindowFromRequest(
  request: CodestralCompletionRequest,
): CodestralPromptWindow {
  return { prompt: request.prefix, suffix: request.suffix };
}
