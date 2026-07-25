import type { NesPromptStrategy } from '../../src/chat-lib/core/behavior-config';
import {
  streamOfficialNesResponse,
  type NesEditFilterOptions,
} from '../../src/chat-lib/core/nes/response';
import type {
  NesDocumentContext,
  NesHistoryContext,
  NesParsedResponse,
  NesPromptBuildResult,
} from '../../src/chat-lib/core/nes/types';

export * from '../../src/chat-lib/core/nes/response';

export async function parseOfficialNesResponse(
  chunks: AsyncIterable<string>,
  strategy: NesPromptStrategy,
  prompt: NesPromptBuildResult,
  current: NesDocumentContext,
  related: readonly NesDocumentContext[],
  onEarlyDivergence?: (reason: string) => void,
  filters?: NesEditFilterOptions,
  history: readonly NesHistoryContext[] = [],
): Promise<NesParsedResponse> {
  const iterator = streamOfficialNesResponse(
    chunks,
    strategy,
    prompt,
    current,
    related,
    { filters, history, onEarlyDivergence },
  );
  let next = await iterator.next();
  while (!next.done) {
    next = await iterator.next();
  }
  return next.value;
}

export async function* chunksFromString(
  text: string,
  chunkSizes: readonly number[] = [text.length],
): AsyncIterable<string> {
  let offset = 0;
  for (const size of chunkSizes) {
    if (offset >= text.length) {
      break;
    }
    const chunkSize = Math.max(1, size);
    yield text.slice(offset, offset + chunkSize);
    offset += chunkSize;
  }
  if (offset < text.length) {
    yield text.slice(offset);
  }
}
