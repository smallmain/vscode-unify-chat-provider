export interface MistralContentProgress {
  type: 'thinking' | 'text';
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Convert Mistral's structured assistant content into ordered display progress.
 * The caller retains the original array separately for multi-turn replay.
 */
export function parseMistralContentChunks(
  content: unknown,
): MistralContentProgress[] | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }

  const progress: MistralContentProgress[] = [];
  for (const chunk of content) {
    if (!isRecord(chunk)) {
      continue;
    }

    if (chunk['type'] === 'text' && typeof chunk['text'] === 'string') {
      progress.push({ type: 'text', text: chunk['text'] });
      continue;
    }

    if (chunk['type'] !== 'thinking' || !Array.isArray(chunk['thinking'])) {
      continue;
    }

    for (const thinkingChunk of chunk['thinking']) {
      if (
        isRecord(thinkingChunk) &&
        thinkingChunk['type'] === 'text' &&
        typeof thinkingChunk['text'] === 'string'
      ) {
        progress.push({ type: 'thinking', text: thinkingChunk['text'] });
      }
    }
  }

  return progress;
}

/**
 * Append one structured streaming delta without coercing either array to text.
 */
export function appendMistralContentChunks(
  previousContent: unknown,
  deltaContent: unknown,
): unknown[] | undefined {
  if (!Array.isArray(deltaContent)) {
    return undefined;
  }

  return Array.isArray(previousContent)
    ? [...previousContent, ...deltaContent]
    : [...deltaContent];
}
