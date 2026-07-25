import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CHAT_CLIENTS = [
  'src/client/openai/chat-completion-client.ts',
  'src/client/openai/responses-client.ts',
  'src/client/ollama/client.ts',
] as const;

const FORBIDDEN_COMPLETION_BRIDGE_TOKENS = [
  'INTERNAL_COMPLETION_MARKER',
  'createInternalCompletionModelOptions',
  'readInternalCompletionModelOptions',
  'CompletionRequestLogger',
  'createCompletionRequestLogger',
  'Unify Chat Provider: Completion',
  'enforceOpenAIChatCompletionBodyInvariants',
  'enforceOpenAIResponsesCompletionBodyInvariants',
  'enforceOllamaChatCompletionBodyInvariants',
] as const;

describe('Completion Chat Provider ownership boundary', () => {
  it.each(CHAT_CLIENTS)('%s has no Completion bridge or logging hook', (path) => {
    const source = readFileSync(resolve(process.cwd(), path), 'utf8');

    expect(source).not.toMatch(/from ['"][^'"]*\/completion\//);
    for (const token of FORBIDDEN_COMPLETION_BRIDGE_TOKENS) {
      expect(source).not.toContain(token);
    }
  });

  it('keeps Completion request-body policy out of src/client', () => {
    expect(
      existsSync(
        resolve(process.cwd(), 'src/client/completion-model-options.ts'),
      ),
    ).toBe(false);
    expect(
      existsSync(
        resolve(process.cwd(), 'src/client/request-body-invariants.ts'),
      ),
    ).toBe(false);
  });
});
