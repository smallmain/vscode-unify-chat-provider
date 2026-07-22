import type * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';
import {
  CharacterGhostTextTokenizer,
  DEFAULT_GHOST_TEXT_BEHAVIOR,
  FimGhostTextModelBoundary,
  GhostTextCompletionCache,
  GhostTextCurrentCompletion,
  GhostTextPromptFactory,
  O200kGhostTextTokenizer,
  RecordingCompletionModel,
  buildGhostTextNetworkStrategy,
  determineGhostTextMultilineStrategy,
  ghostTextTrimmerLookahead,
  resolveGhostTextBlockMode,
  shouldRequestMultiline,
  splitGhostTextCompletion,
  trimMultilineCompletion,
  createFimGhostTextEngine,
  type GhostTextPrompt,
  type GhostTextRequest,
  type RecordedFimResult,
} from '../support/ghost-text';

function createToken(cancelled = false): vscode.CancellationToken {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: () => ({ dispose() {} }),
  };
}

function createCancellationSource(): {
  token: vscode.CancellationToken;
  cancel(): void;
} {
  let cancelled = false;
  const listeners = new Set<() => void>();
  return {
    token: {
      get isCancellationRequested(): boolean {
        return cancelled;
      },
      onCancellationRequested: (listener, thisArgs, disposables) => {
        const callback = (): void => listener.call(thisArgs, undefined);
        const disposable: vscode.Disposable = {
          dispose: () => listeners.delete(callback),
        };
        listeners.add(callback);
        disposables?.push(disposable);
        return disposable;
      },
    },
    cancel(): void {
      cancelled = true;
      for (const listener of listeners) {
        listener();
      }
      listeners.clear();
    },
  };
}

function sequenceIds(): () => string {
  let next = 0;
  return () => `id-${++next}`;
}

function request(
  text = 'const value = ',
  trigger: 'automatic' | 'invoke' = 'automatic',
): GhostTextRequest {
  return {
    document: {
      uri: 'file:///workspace/file.ts',
      filePath: 'src/file.ts',
      languageId: 'typescript',
      text,
      version: 1,
    },
    position: { line: 0, character: text.length },
    trigger,
    multiline: 'single',
  };
}

class Deferred<T> {
  readonly promise: Promise<T>;
  private resolvePromise?: (value: T) => void;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  resolve(value: T): void {
    this.resolvePromise?.(value);
  }
}

const basePrompt: GhostTextPrompt = {
  prefix: 'const value = ',
  suffix: ';',
  contextFiles: [{ path: 'context.ts', content: 'export const x = 1;' }],
  prefixTokens: 4,
  suffixTokens: 1,
  trailingWhitespace: '',
  selectedCompletionLineLengthIncrease: 0,
  virtualDocumentText: 'const value = ;',
  virtualCursorOffset: 14,
};

describe('FimGhostTextModelBoundary', () => {
  it('maps the split prompt and preserves request metadata', async () => {
    const model = new RecordingCompletionModel(() => ({
      text: 'answer',
      finishReason: 'stop',
      usage: { output: 1 },
    }));
    const boundary = new FimGhostTextModelBoundary(model, sequenceIds());

    const choices = await boundary.complete(
      {
        requestId: 'request-1',
        prompt: basePrompt,
        filePath: 'src/file.ts',
        candidateCount: 1,
        stop: ['\n'],
        maxTokens: 20,
        languageId: 'typescript',
        nextIndent: 2,
        trimByIndentation: true,
        promptTokens: 4,
        suffixTokens: 1,
        codeAnnotations: false,
      },
      createToken(),
    );

    expect(model.requests).toEqual([
      {
        kind: 'copilot-replica/fim',
        targetPath: 'src/file.ts',
        prefix: 'const value = ',
        suffix: ';',
        contexts: [
          { path: 'context.ts', content: 'export const x = 1;' },
        ],
        options: {
          candidateCount: 1,
          stop: ['\n'],
          maxTokens: 20,
        },
        metadata: {
          languageId: 'typescript',
          nextIndent: 2,
          trimByIndentation: true,
          promptTokens: 4,
          suffixTokens: 1,
          codeAnnotations: false,
        },
      },
    ]);
    expect(choices).toEqual([
      {
        choiceIndex: 0,
        completionText: 'answer',
        requestId: 'request-1',
        clientCompletionId: 'id-1',
        finishReason: 'stop',
        usage: { output: 1 },
      },
    ]);
  });

  it('supports embedded multi-choice results without breaking single-text models', async () => {
    const model = new RecordingCompletionModel(() => ({
      text: 'fallback',
      choices: [
        { text: 'first', finishReason: 'stop' },
        { text: 'second' },
        { text: 'third' },
      ],
    }));
    const boundary = new FimGhostTextModelBoundary(model, sequenceIds());
    const choices = await boundary.complete(
      {
        requestId: 'cycling',
        prompt: basePrompt,
        filePath: 'file.ts',
        candidateCount: 3,
        languageId: 'typescript',
        nextIndent: 0,
        trimByIndentation: false,
        promptTokens: 4,
        suffixTokens: 1,
        codeAnnotations: false,
      },
      createToken(),
    );

    expect(choices.map((choice) => choice.completionText)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('classifies cancellation before invoking the model', async () => {
    const model = new RecordingCompletionModel(() => ({ text: 'unused' }));
    const boundary = new FimGhostTextModelBoundary(model, sequenceIds());
    await expect(
      boundary.complete(
        {
          requestId: 'cancelled',
          prompt: basePrompt,
          filePath: 'file.ts',
          candidateCount: 1,
          languageId: 'typescript',
          nextIndent: 0,
          trimByIndentation: false,
          promptTokens: 4,
          suffixTokens: 1,
          codeAnnotations: false,
        },
        createToken(true),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(model.requests).toHaveLength(0);
  });
});

describe('GhostTextPromptFactory', () => {
  it('matches official o200k truncation at retokenized character boundaries', () => {
    const tokenizer = new O200kGhostTextTokenizer();
    expect(
      tokenizer.takeFirst(
        'function calculateResult(inputValue) { return inputValue; }',
        1,
      ).text,
    ).toBe('fun');
    expect(tokenizer.takeLast('abcdefghijklmnopqrstuvwxyz', 1).text).toBe(
      'uvwxyz',
    );
  });

  it('matches the reviewed pinned CompletionsPromptFactory prompt baseline', () => {
    const documentText =
      'export function increment(value: number) {\n  return value\n}\n';
    const factory = new GhostTextPromptFactory(
      {
        ...DEFAULT_GHOST_TEXT_BEHAVIOR,
        maxPromptCompletionTokens: 512,
        maxCompletionTokens: 64,
        suffixPercent: 20,
        minPromptCharacters: 0,
      },
      new CharacterGhostTextTokenizer(),
    );

    const result = factory.build(
      {
        document: {
          uri: 'file:///workspace/src/counter.ts',
          filePath: '/workspace/src/counter.ts',
          relativePath: 'src/counter.ts',
          languageId: 'typescript',
          text: documentText,
          version: 7,
        },
        position: { line: 1, character: 14 },
        trigger: 'automatic',
        context: {
          similarFiles: [
            {
              path: 'src/math.ts',
              content: 'export const STEP = 1;\n',
              score: 1,
            },
          ],
        },
      },
      createToken(),
    );

    expect(result).toEqual({
      type: 'prompt',
      prompt: {
        prefix: 'export function increment(value: number) {\n  return value',
        suffix: '}\n',
        contextFiles: [
          {
            path: '',
            content:
              'Path: src/counter.ts\nCompare this snippet from src/math.ts:\nexport const STEP = 1;',
          },
        ],
        prefixTokens: 140,
        suffixTokens: 2,
        trailingWhitespace: '',
        selectedCompletionLineLengthIncrease: 0,
        virtualDocumentText: documentText,
        virtualCursorOffset: 57,
      },
    });
  });

  it('preclips long prompt sides with the pinned 4.1 characters-per-token factor', () => {
    class RecordingTokenizer extends CharacterGhostTextTokenizer {
      readonly encodedLengths: number[] = [];

      override encode(text: string): readonly number[] {
        this.encodedLengths.push(text.length);
        return super.encode(text);
      }
    }
    const tokenizer = new RecordingTokenizer();
    const factory = new GhostTextPromptFactory(
      {
        ...DEFAULT_GHOST_TEXT_BEHAVIOR,
        maxPromptCompletionTokens: 100,
        maxCompletionTokens: 20,
        suffixPercent: 0,
        minPromptCharacters: 0,
      },
      tokenizer,
    );
    const text = 'x'.repeat(1_000);

    const result = factory.build(
      {
        ...request(text),
        position: { line: 0, character: text.length },
      },
      createToken(),
    );

    expect(result.type).toBe('prompt');
    expect(Math.max(...tokenizer.encodedLengths)).toBe(328);
  });

  it('applies selectedCompletionInfo and emits stable and recent context groups', () => {
    const factory = new GhostTextPromptFactory(
      {
        upstreamCommit: 'fc3def6774c76082adf699d366f31a557ce5573f',
        maxPromptCompletionTokens: 1024,
        maxCompletionTokens: 64,
        suffixPercent: 15,
        suffixMatchThreshold: 10,
        minPromptCharacters: 10,
        numberOfSnippets: 4,
        maximumSimilarFiles: 20,
        maximumCharactersPerSimilarFile: 10_000,
        similarFileWindowLines: 60,
        cacheSize: 100,
        asyncCompletionTimeoutMs: 200,
        completionDelayMs: 200,
        cyclingCandidateCount: 3,
        blockMode: 'parsing',
        modelAlwaysTerminatesSingleline: false,
        singleLineUnlessAccepted: false,
        maxMultilineTokens: 200,
        multilineAfterAcceptLines: 1,
      },
      new CharacterGhostTextTokenizer(),
    );
    const result = factory.build(
      {
        document: {
          uri: 'file:///workspace/file.ts',
          filePath: 'src/file.ts',
          languageId: 'typescript',
          text: 'const obj = fo\nnext();',
          version: 1,
        },
        position: { line: 0, character: 14 },
        trigger: 'automatic',
        selectedCompletionInfo: { text: 'foo', range: { start: 12, end: 14 } },
        context: {
          traits: [{ name: 'framework', value: 'vitest' }],
          diagnostics: [
            {
              path: 'src/file.ts',
              line: 0,
              character: 6,
              severity: 'error',
              source: 'ts',
              code: 2322,
              message: 'Type mismatch',
            },
          ],
          codeSnippets: [
            { path: 'src/helper.ts', value: 'export const helper = 1;' },
          ],
          similarFiles: [
            {
              path: 'src/similar.ts',
              content: 'const obj = factory();',
              score: 0.8,
            },
          ],
          recentEdits: [
            {
              uri: 'file:///workspace/src/changed.ts',
              path: 'src/changed.ts',
              summary: '+ export const changed = true;',
            },
          ],
        },
      },
      createToken(),
    );

    expect(result.type).toBe('prompt');
    if (result.type !== 'prompt') {
      return;
    }
    expect(result.prompt.prefix).toBe('const obj = foo');
    expect(result.prompt.suffix).toBe('next();');
    expect(result.prompt.selectedCompletionLineLengthIncrease).toBe(1);
    expect(result.prompt.contextFiles).toHaveLength(2);
    expect(result.prompt.contextFiles.map((file) => file.path)).toEqual([
      '',
      '',
    ]);
    expect(result.prompt.contextFiles[0].content).toContain(
      'Language: typescript',
    );
    expect(result.prompt.contextFiles[0].content).toContain(
      'framework: vitest',
    );
    expect(result.prompt.contextFiles[0].content).toContain(
      '1:7 - error TS2322: Type mismatch',
    );
    expect(result.prompt.contextFiles[0].content).toContain(
      'Compare this snippet from src/helper.ts:',
    );
    expect(result.prompt.contextFiles[1].content).toContain(
      'Do not suggest code that has been deleted.',
    );
  });

  it('matches official path and language marker selection', () => {
    const markerFor = (
      document: GhostTextRequest['document'],
    ): string | undefined => {
      const factory = new GhostTextPromptFactory(
        {
          ...DEFAULT_GHOST_TEXT_BEHAVIOR,
          minPromptCharacters: 0,
          suffixPercent: 0,
        },
        new CharacterGhostTextTokenizer(),
      );
      const result = factory.build(
        {
          document,
          position: { line: 0, character: document.text.length },
          trigger: 'automatic',
        },
        createToken(),
      );
      expect(result.type).toBe('prompt');
      return result.type === 'prompt'
        ? result.prompt.contextFiles[0]?.content
        : undefined;
    };
    const base = {
      uri: 'untitled:marker',
      filePath: '/workspace/src/file.ts',
      languageId: 'typescript',
      text: 'const value = 1;',
      version: 1,
    };

    expect(markerFor({ ...base, relativePath: 'src/file.ts' })).toBe(
      'Path: src/file.ts',
    );
    expect(
      markerFor({ ...base, relativePath: 'src/file.ts', notebook: true }),
    ).toBe('Language: typescript');
    expect(markerFor(base)).toBe('Language: typescript');
    expect(
      markerFor({
        ...base,
        languageId: 'python',
        text: '#!/usr/bin/env python3',
      }),
    ).toBeUndefined();
    expect(
      markerFor({ ...base, languageId: 'html', text: '<!DOCTYPE html>' }),
    ).toBeUndefined();
    expect(markerFor({ ...base, languageId: 'php' })).toBeUndefined();
    expect(markerFor({ ...base, languageId: 'plaintext' })).toBeUndefined();
  });

  it('enforces the suffix allocation and weighted token budget', () => {
    const factory = new GhostTextPromptFactory(
      {
        upstreamCommit: 'fc3def6774c76082adf699d366f31a557ce5573f',
        maxPromptCompletionTokens: 80,
        maxCompletionTokens: 20,
        suffixPercent: 15,
        suffixMatchThreshold: 10,
        minPromptCharacters: 10,
        numberOfSnippets: 4,
        maximumSimilarFiles: 20,
        maximumCharactersPerSimilarFile: 10_000,
        similarFileWindowLines: 60,
        cacheSize: 100,
        asyncCompletionTimeoutMs: 200,
        completionDelayMs: 200,
        cyclingCandidateCount: 3,
        blockMode: 'parsing',
        modelAlwaysTerminatesSingleline: false,
        singleLineUnlessAccepted: false,
        maxMultilineTokens: 200,
        multilineAfterAcceptLines: 1,
      },
      new CharacterGhostTextTokenizer(),
    );
    const result = factory.build(
      {
        ...request('012345678901234567890123456789\nafter line'),
        position: { line: 0, character: 30 },
        context: {
          traits: [
            { name: 'low-priority', value: 'x'.repeat(80) },
          ],
        },
      },
      createToken(),
    );

    expect(result.type).toBe('prompt');
    if (result.type !== 'prompt') {
      return;
    }
    expect(result.prompt.prefixTokens + result.prompt.suffixTokens).toBeLessThanOrEqual(
      60,
    );
    expect(result.prompt.prefix).toContain('0123456789');
    expect(result.prompt.suffix.length).toBeLessThanOrEqual(10);
    expect(
      result.prompt.contextFiles.every(
        (file) => !file.content.includes('low-priority'),
      ),
    ).toBe(true);
  });

  it('elides traits as independent leaf blocks under a tight budget', () => {
    const submitted: Array<{
      readonly itemId: string;
      readonly expectedTokens: number;
      readonly actualTokens: number;
    }> = [];
    const factory = new GhostTextPromptFactory(
      {
        ...DEFAULT_GHOST_TEXT_BEHAVIOR,
        maxPromptCompletionTokens: 50,
        maxCompletionTokens: 20,
        minPromptCharacters: 0,
      },
      new CharacterGhostTextTokenizer(),
    );
    const result = factory.build(
      {
        document: {
          uri: 'untitled:traits.php',
          filePath: '',
          languageId: 'php',
          text: '012345678901234\n',
          version: 1,
        },
        position: { line: 1, character: 0 },
        trigger: 'automatic',
        multiline: 'single',
        context: {
          traits: [
            {
              name: 'one',
              value: '1111',
              contextProviderSource: {
                providerId: 'provider',
                itemId: 'one',
                itemType: 'Trait',
              },
            },
            {
              name: 'two',
              value: '2222',
              contextProviderSource: {
                providerId: 'provider',
                itemId: 'two',
                itemType: 'Trait',
              },
            },
            {
              name: 'three',
              value: '3333',
              contextProviderSource: {
                providerId: 'provider',
                itemId: 'three',
                itemType: 'Trait',
              },
            },
          ],
          contextProviderFeedback: {
            completionId: 'tight-traits',
            submit: (matchers) => {
              submitted.push(
                ...matchers.map((matcher) => ({
                  itemId: matcher.source.itemId,
                  expectedTokens: matcher.expectedTokens,
                  actualTokens: matcher.actualTokens,
                })),
              );
            },
          },
        },
      },
      createToken(),
    );

    expect(result.type).toBe('prompt');
    if (result.type !== 'prompt') {
      return;
    }
    expect(result.prompt.contextFiles).toEqual([
      { path: '', content: 'three: 3333' },
    ]);
    expect(submitted).toEqual([
      { itemId: 'one', expectedTokens: 10, actualTokens: 0 },
      { itemId: 'two', expectedTokens: 10, actualTokens: 0 },
      { itemId: 'three', expectedTokens: 12, actualTokens: 12 },
    ]);
  });

  it('reverses equal-importance code snippet groups like the official component', () => {
    const factory = new GhostTextPromptFactory(
      {
        ...DEFAULT_GHOST_TEXT_BEHAVIOR,
        minPromptCharacters: 0,
      },
      new CharacterGhostTextTokenizer(),
    );
    const result = factory.build(
      {
        ...request('const value = '),
        context: {
          codeSnippets: [
            { path: 'first.ts', value: 'first();', importance: 1 },
            { path: 'second.ts', value: 'second();', importance: 1 },
          ],
        },
      },
      createToken(),
    );

    expect(result.type).toBe('prompt');
    if (result.type !== 'prompt') {
      return;
    }
    const context = result.prompt.contextFiles[0]?.content ?? '';
    expect(context.indexOf('second.ts')).toBeLessThan(context.indexOf('first.ts'));
  });

  it('reports grouped snippet and diagnostic usage at the official item source granularity', () => {
    const submitted: Array<{
      readonly itemId: string;
      readonly expectedTokens: number;
      readonly actualTokens: number;
    }> = [];
    const source = (
      itemId: string,
      itemType: 'CodeSnippet' | 'DiagnosticBag',
    ) => ({ providerId: 'provider', itemId, itemType }) as const;
    const factory = new GhostTextPromptFactory(
      {
        ...DEFAULT_GHOST_TEXT_BEHAVIOR,
        maxPromptCompletionTokens: 512,
        maxCompletionTokens: 20,
        minPromptCharacters: 0,
        suffixPercent: 0,
      },
      new CharacterGhostTextTokenizer(),
    );
    const result = factory.build(
      {
        ...request('const value = '),
        context: {
          codeSnippets: [
            {
              path: 'shared.ts',
              value: 'first();',
              contextProviderSource: source('snippet-one', 'CodeSnippet'),
            },
            {
              path: 'shared.ts',
              value: 'second();',
              contextProviderSource: source('snippet-two', 'CodeSnippet'),
            },
          ],
          diagnostics: [
            {
              path: 'shared.ts',
              line: 0,
              character: 0,
              message: 'first diagnostic',
              severity: 'error',
              contextProviderSource: source('bag-one', 'DiagnosticBag'),
            },
            {
              path: 'shared.ts',
              line: 1,
              character: 0,
              message: 'second diagnostic',
              severity: 'warning',
              contextProviderSource: source('bag-two', 'DiagnosticBag'),
            },
          ],
          contextProviderFeedback: {
            completionId: 'grouped-context',
            submit: (matchers) => {
              submitted.push(
                ...matchers.map((matcher) => ({
                  itemId: matcher.source.itemId,
                  expectedTokens: matcher.expectedTokens,
                  actualTokens: matcher.actualTokens,
                })),
              );
            },
          },
        },
      },
      createToken(),
    );

    expect(result.type).toBe('prompt');
    if (result.type !== 'prompt') return;
    expect(submitted.map((entry) => entry.itemId)).toEqual([
      'bag-two',
      'bag-one',
      'snippet-one',
      'snippet-two',
    ]);
    expect(
      submitted.every(
        (entry) => entry.expectedTokens === entry.actualTokens,
      ),
    ).toBe(true);
    const context = result.prompt.contextFiles[0]?.content ?? '';
    expect(context.match(/diagnostics from shared\.ts:/g)).toHaveLength(2);
    expect(context.match(/Compare these snippets from shared\.ts:/g)).toHaveLength(1);
  });

  it('matches the reviewed production split-context shared-budget baseline', () => {
    const prefix = 'P'.repeat(500);
    const suffix = 'S'.repeat(100);
    const factory = new GhostTextPromptFactory(
      {
        ...DEFAULT_GHOST_TEXT_BEHAVIOR,
        maxPromptCompletionTokens: 1_000,
        maxCompletionTokens: 0,
        minPromptCharacters: 0,
      },
      new CharacterGhostTextTokenizer(),
    );
    const result = factory.build(
      {
        ...request(`${prefix}\n${suffix}`),
        position: { line: 0, character: prefix.length },
        context: {
          codeSnippets: [{ path: 'p', value: 'X'.repeat(320) }],
          recentEdits: [{ uri: 'file:///e', path: 'e', summary: '+' }],
        },
      },
      createToken(),
    );

    expect(result.type).toBe('prompt');
    if (result.type !== 'prompt') {
      return;
    }
    expect(result.prompt).toMatchObject({
      prefix,
      suffix,
      prefixTokens: 627,
      suffixTokens: 100,
      contextFiles: [
        {
          path: '',
          content: 'Language: typescript',
        },
        {
          path: '',
          content: [
            'These are recently edited files. Do not suggest code that has been deleted.',
            'File: e',
            '+',
            'End of recent edits',
          ].join('\n'),
        },
      ],
    });
    expect(
      result.prompt.prefixTokens + result.prompt.suffixTokens,
    ).toBe(727);
  });

  it('reuses a sufficiently similar cached suffix', () => {
    const factory = new GhostTextPromptFactory(
      {
        upstreamCommit: 'fc3def6774c76082adf699d366f31a557ce5573f',
        maxPromptCompletionTokens: 256,
        maxCompletionTokens: 64,
        suffixPercent: 15,
        suffixMatchThreshold: 10,
        minPromptCharacters: 10,
        numberOfSnippets: 4,
        maximumSimilarFiles: 20,
        maximumCharactersPerSimilarFile: 10_000,
        similarFileWindowLines: 60,
        cacheSize: 100,
        asyncCompletionTimeoutMs: 200,
        completionDelayMs: 200,
        cyclingCandidateCount: 3,
        blockMode: 'parsing',
        modelAlwaysTerminatesSingleline: false,
        singleLineUnlessAccepted: false,
        maxMultilineTokens: 200,
        multilineAfterAcceptLines: 1,
      },
      new CharacterGhostTextTokenizer(),
    );
    const firstSuffix = 'alpha beta gamma delta epsilon';
    const first = factory.build(
      {
        ...request(`const value = \n${firstSuffix}`),
        position: { line: 0, character: 14 },
      },
      createToken(),
    );
    const second = factory.build(
      {
        ...request('const value = \nalpha beta gamma delta epsilox'),
        position: { line: 0, character: 14 },
      },
      createToken(),
    );
    expect(first.type === 'prompt' && first.prompt.suffix).toBe(firstSuffix);
    expect(second.type === 'prompt' && second.prompt.suffix).toBe(firstSuffix);
  });

  it('rejects ignored, too-short, invalid and cancelled prompts', () => {
    const behavior = {
      upstreamCommit: 'fc3def6774c76082adf699d366f31a557ce5573f' as const,
      maxPromptCompletionTokens: 64,
      maxCompletionTokens: 16,
      suffixPercent: 15,
      suffixMatchThreshold: 10,
      minPromptCharacters: 10,
      numberOfSnippets: 4,
      maximumSimilarFiles: 20,
      maximumCharactersPerSimilarFile: 10_000,
      similarFileWindowLines: 60,
      cacheSize: 100,
      asyncCompletionTimeoutMs: 200,
      completionDelayMs: 200,
      cyclingCandidateCount: 3,
      blockMode: 'parsing' as const,
      modelAlwaysTerminatesSingleline: false,
      singleLineUnlessAccepted: false,
      maxMultilineTokens: 200,
      multilineAfterAcceptLines: 1,
    };
    const factory = new GhostTextPromptFactory(
      behavior,
      new CharacterGhostTextTokenizer(),
    );
    expect(
      factory.build(
        { ...request(), context: { ignored: true } },
        createToken(),
      ).type,
    ).toBe('content-excluded');
    expect(factory.build(request('tiny'), createToken()).type).toBe(
      'context-too-short',
    );
    expect(
      factory.build(
        { ...request(), position: { line: 4, character: 0 } },
        createToken(),
      ).type,
    ).toBe('invalid-position');
    expect(factory.build(request(), createToken(true)).type).toBe('cancelled');
  });
});

describe('GhostTextEngine state and post-processing', () => {
  it('counts cache capacity by prefix node rather than suffix content', () => {
    const cache = new GhostTextCompletionCache(100);
    for (let index = 0; index < 101; index++) {
      cache.append('const value = ', `; // suffix-${index}`, {
        choiceIndex: index,
        completionText: `answer-${index}`,
        requestId: `request-${index}`,
        clientCompletionId: `completion-${index}`,
      });
    }

    expect(cache.size).toBe(1);
    expect(
      cache.findAll('const value = ', '; // suffix-0')[0]?.completionText,
    ).toBe('answer-0');
  });

  it('touches prefix nodes before suffix filtering for LRU eviction', () => {
    const cache = new GhostTextCompletionCache(2);
    const choice = (id: string) => ({
      choiceIndex: 0,
      completionText: id,
      requestId: `request-${id}`,
      clientCompletionId: `completion-${id}`,
    });
    cache.append('alpha', 'suffix-a', choice('answer-a'));
    cache.append('beta', 'suffix-b', choice('answer-b'));

    expect(cache.findAll('alpha-more', 'different-suffix')).toEqual([]);
    cache.append('gamma', 'suffix-c', choice('answer-c'));

    expect(cache.findAll('beta', 'suffix-b')).toEqual([]);
    expect(cache.findAll('alpha', 'suffix-a')).toHaveLength(1);
  });

  it('resolves the official per-language block modes', () => {
    expect(
      ['typescript', 'python', 'ruby', 'plaintext'].map((languageId) =>
        resolveGhostTextBlockMode(DEFAULT_GHOST_TEXT_BEHAVIOR, languageId),
      ),
    ).toEqual([
      'more-multiline',
      'parsing-and-server',
      'parsing',
      'server',
    ]);
  });

  it('keeps accepted MoreMultiline requests on the block-trimmer strategy', async () => {
    const base = request('const value = ');
    const automatic = {
      ...base,
      multiline: 'auto' as const,
    };
    const strategy = await determineGhostTextMultilineStrategy(
      automatic,
      basePrompt,
      DEFAULT_GHOST_TEXT_BEHAVIOR,
      true,
    );
    expect(strategy).toEqual({
      requestMultiline: true,
      blockMode: 'more-multiline',
      afterAcceptFallback: false,
      blockPosition: 'non-block',
    });
    expect(
      buildGhostTextNetworkStrategy(
        automatic,
        basePrompt,
        DEFAULT_GHOST_TEXT_BEHAVIOR,
        true,
        true,
        strategy,
      ),
    ).toMatchObject({
      blockMode: 'more-multiline',
      afterAcceptFallback: false,
      maxTokens: 200,
    });
    expect(
      buildGhostTextNetworkStrategy(
        automatic,
        basePrompt,
        DEFAULT_GHOST_TEXT_BEHAVIOR,
        true,
        true,
        strategy,
      ).stop,
    ).toBeUndefined();
  });

  it('splits progressive reveal choices and records exact prefix additions', async () => {
    const input = {
      languageId: 'typescript',
      prefix: 'const prefix = ',
      completion: 'first();\nsecond();\nthird();',
    };
    const segments = await splitGhostTextCompletion(
      input.prefix,
      input.completion,
      input.languageId,
      ghostTextTrimmerLookahead('mid-block'),
      async (_languageId, _prefix, completion) => {
        const newline = completion.indexOf('\n');
        return newline < 0 ? undefined : newline + 1;
      },
    );

    expect(ghostTextTrimmerLookahead('empty-block')).toBe(9);
    expect(ghostTextTrimmerLookahead('block-end')).toBe(9);
    expect(ghostTextTrimmerLookahead('mid-block')).toBe(3);
    expect(segments).toEqual([
      {
        prefixAddition: '',
        completionText: 'first();\n',
        hasMore: true,
      },
      {
        prefixAddition: 'first();\n',
        completionText: 'second();',
        generatedChoiceIndex: 1,
        hasMore: true,
      },
      {
        prefixAddition: 'first();\nsecond();\n',
        completionText: 'third();',
        generatedChoiceIndex: 2,
        hasMore: false,
      },
    ]);
  });

  it('uses the bounded accept fallback for server-mode languages', async () => {
    const base = request('value');
    const automatic = {
      ...base,
      document: { ...base.document, languageId: 'plaintext' },
      multiline: 'auto' as const,
    };
    const strategy = await determineGhostTextMultilineStrategy(
      automatic,
      { ...basePrompt, virtualDocumentText: 'value', virtualCursorOffset: 5 },
      DEFAULT_GHOST_TEXT_BEHAVIOR,
      true,
    );
    expect(strategy).toEqual({
      requestMultiline: true,
      blockMode: 'parsing',
      afterAcceptFallback: true,
    });
    expect(
      buildGhostTextNetworkStrategy(
        automatic,
        basePrompt,
        DEFAULT_GHOST_TEXT_BEHAVIOR,
        true,
        true,
        strategy,
      ),
    ).toMatchObject({
      stop: ['\n\n'],
      maxTokens: 20,
      trimByIndentation: false,
    });
  });

  it('uses official parsers for nested TypeScript, Python, and Go blocks', async () => {
    const cases = [
      {
        languageId: 'typescript',
        prefix: 'function outer() {\n  if (ready) {\n    ',
        completion: 'work();\n  }\n  after();\n}\noutside();',
        expected: 'work();\n  }',
      },
      {
        languageId: 'python',
        prefix: 'def outer():\n    if ready:\n        ',
        completion: 'work()\n    after()\noutside()',
        expected: 'work()',
      },
      {
        languageId: 'go',
        prefix: 'func outer() {\n\tif ready {\n\t\t',
        completion: 'work()\n\t}\n\tafter()\n}\noutside()',
        expected: 'work()\n\t}',
      },
    ] as const;

    for (const value of cases) {
      await expect(
        trimMultilineCompletion(
          value.completion,
          value.languageId,
          DEFAULT_GHOST_TEXT_BEHAVIOR,
          false,
          value.prefix,
          value.prefix.length,
        ),
      ).resolves.toBe(value.expected);
    }
  });

  it('does not treat braces inside a mid-line string as an empty block', async () => {
    const text = 'const value = "{";';
    const cursorOffset = text.indexOf(';');
    const prompt: GhostTextPrompt = {
      prefix: text.slice(0, cursorOffset),
      suffix: text.slice(cursorOffset),
      contextFiles: [],
      prefixTokens: cursorOffset,
      suffixTokens: text.length - cursorOffset,
      trailingWhitespace: '',
      selectedCompletionLineLengthIncrease: 0,
      virtualDocumentText: text,
      virtualCursorOffset: cursorOffset,
    };
    const value: GhostTextRequest = {
      ...request(text),
      position: { line: 0, character: cursorOffset },
      multiline: 'auto',
    };

    await expect(
      shouldRequestMultiline(
        value,
        prompt,
        DEFAULT_GHOST_TEXT_BEHAVIOR,
        false,
      ),
    ).resolves.toBe(false);
  });

  it('leaves unsupported-language multiline output untrimmed', async () => {
    const completion = 'first line\nsecond line\nthird line';
    await expect(
      trimMultilineCompletion(
        completion,
        'plaintext',
        DEFAULT_GHOST_TEXT_BEHAVIOR,
        false,
        'prefix',
        6,
      ),
    ).resolves.toBe(completion);
  });

  it('requires the first current choice to match typing-as-suggested', () => {
    const current = new GhostTextCurrentCompletion();
    current.set(
      'const value = ',
      '',
      [
        {
          choiceIndex: 0,
          completionText: 'alpha',
          requestId: 'request',
          clientCompletionId: 'first',
        },
        {
          choiceIndex: 1,
          completionText: 'beta',
          requestId: 'request',
          clientCompletionId: 'second',
        },
      ],
      false,
    );

    expect(current.forTyping('const value = b', '')).toBeUndefined();
    expect(current.forTyping('const value = a', '')?.[0].completionText).toBe(
      'lpha',
    );
  });

  it('uses network, cache, then typing-as-suggested without extra calls', async () => {
    const model = new RecordingCompletionModel(() => ({
      text: '42',
      finishReason: 'stop',
    }));
    const engine = createFimGhostTextEngine(model, {
      tokenizer: new CharacterGhostTextTokenizer(),
      idFactory: sequenceIds(),
      behavior: { completionDelayMs: 0 },
    });

    const first = await engine.provide(request(), createToken());
    expect(first.type).toBe('success');
    if (first.type !== 'success') {
      return;
    }
    expect(first.list.source).toBe('async');
    expect(first.list.items[0]).toMatchObject({
      insertText: 'const value = 42',
      displayText: '42',
    });

    const other = await engine.provide(request('const other = '), createToken());
    expect(other.type).toBe('success');

    const cached = await engine.provide(request(), createToken());
    expect(cached.type === 'success' && cached.list.source).toBe('cache');

    const typed = await engine.provide(
      request('const value = 4'),
      createToken(),
    );
    expect(typed.type).toBe('success');
    if (typed.type === 'success') {
      expect(typed.list.source).toBe('typing-as-suggested');
      expect(typed.list.items[0].displayText).toBe('2');
      expect(typed.list.items[0].insertText).toBe('const value = 42');
    }
    expect(model.requests).toHaveLength(2);
  });

  it('never falls back to a document file path for the model target path', async () => {
    const model = new RecordingCompletionModel(() => ({ text: 'answer' }));
    const engine = createFimGhostTextEngine(model, {
      tokenizer: new CharacterGhostTextTokenizer(),
      idFactory: sequenceIds(),
      behavior: { completionDelayMs: 0 },
    });
    const baseRequest = request();
    const outside: GhostTextRequest = {
      ...baseRequest,
      document: {
        ...baseRequest.document,
        filePath: '/outside/private/external.ts',
      },
    };

    await engine.provide(outside, createToken());

    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]).not.toHaveProperty('targetPath');
  });

  it('reuses an in-flight request and cancels the superseded caller', async () => {
    const deferred = new Deferred<RecordedFimResult>();
    const model = new RecordingCompletionModel(() => deferred.promise);
    const engine = createFimGhostTextEngine(model, {
      tokenizer: new CharacterGhostTextTokenizer(),
      idFactory: sequenceIds(),
      behavior: { completionDelayMs: 0, asyncCompletionTimeoutMs: 1_000 },
    });

    const firstPromise = engine.provide(request(), createToken());
    await Promise.resolve();
    const secondPromise = engine.provide(request(), createToken());
    deferred.resolve({ text: 'shared' });

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first.type).toBe('cancelled');
    expect(second.type).toBe('success');
    if (second.type === 'success') {
      expect(second.list.source).toBe('async');
      expect(second.list.items[0].displayText).toBe('shared');
    }
    expect(model.requests).toHaveLength(1);
  });

  it('requests three unique candidates for cycling in one model call', async () => {
    const model = new RecordingCompletionModel(
      (_call, requestValue) => ({
        text: 'one',
        choices: ['one', 'two', 'three']
          .slice(0, requestValue.options.candidateCount)
          .map((text) => ({ text })),
      }),
    );
    const engine = createFimGhostTextEngine(model, {
      tokenizer: new CharacterGhostTextTokenizer(),
      idFactory: sequenceIds(),
      behavior: { completionDelayMs: 0 },
    });
    const result = await engine.provide(request('const value = ', 'invoke'), createToken());

    expect(result.type).toBe('success');
    if (result.type === 'success') {
      expect(result.list.source).toBe('cycling');
      expect(result.list.items.map((item) => item.displayText)).toEqual([
        'one',
        'two',
        'three',
      ]);
    }
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0].options.candidateCount).toBe(3);
    expect(model.requests[0].options.stop).toBeUndefined();
  });

  it('uses one fallback candidate for single-result adapters', async () => {
    const model = new RecordingCompletionModel(() => ({ text: 'only' }));
    const engine = createFimGhostTextEngine(model, {
      tokenizer: new CharacterGhostTextTokenizer(),
      idFactory: sequenceIds(),
      behavior: { completionDelayMs: 0 },
    });

    const result = await engine.provide(
      request('const value = ', 'invoke'),
      createToken(),
    );

    expect(result.type).toBe('success');
    if (result.type === 'success') {
      expect(result.list.items.map((item) => item.displayText)).toEqual(['only']);
    }
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0].options.candidateCount).toBe(3);
  });

  it('uses one candidate for the default Copilot-compatible request', async () => {
    const model = new RecordingCompletionModel(() => ({ text: 'only' }));
    const engine = createFimGhostTextEngine(model, {
      tokenizer: new CharacterGhostTextTokenizer(),
      idFactory: sequenceIds(),
      behavior: { completionDelayMs: 0, cyclingCandidateCount: 1 },
    });

    const result = await engine.provide(
      request('const value = ', 'invoke'),
      createToken(),
    );

    expect(result.type).toBe('success');
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0].options.candidateCount).toBe(1);
  });

  it('starts one speculative request when the first item is shown', async () => {
    const model = new RecordingCompletionModel((call) => ({
      text: call === 0 ? '42' : ';',
      finishReason: 'stop',
    }));
    const engine = createFimGhostTextEngine(model, {
      tokenizer: new CharacterGhostTextTokenizer(),
      idFactory: sequenceIds(),
      behavior: { completionDelayMs: 0 },
    });
    const result = await engine.provide(request(), createToken());
    expect(result.type).toBe('success');
    if (result.type !== 'success') {
      return;
    }
    expect(engine.getDebugState().speculativeEntries).toBe(1);
    const itemId = result.list.items[0].id;
    engine.handleDidShowCompletionItem(itemId);
    engine.handleDidShowCompletionItem(itemId);
    await vi.waitFor(() => expect(model.requests).toHaveLength(2));
    expect(engine.getDebugState().speculativeEntries).toBe(0);
  });

  it('applies the pinned completion delay except for typing and cycling', async () => {
    const sleeps: number[] = [];
    const model = new RecordingCompletionModel((call) => ({
      text: call === 0 ? '42' : `choice-${call}`,
    }));
    const engine = createFimGhostTextEngine(model, {
      tokenizer: new CharacterGhostTextTokenizer(),
      idFactory: sequenceIds(),
      clock: {
        now: () => 0,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
      },
    });
    await engine.provide(request(), createToken());
    await engine.provide(request('const value = 4'), createToken());

    const cyclingModel = new RecordingCompletionModel((call) => ({
      text: `cycle-${call}`,
    }));
    const cyclingEngine = createFimGhostTextEngine(cyclingModel, {
      tokenizer: new CharacterGhostTextTokenizer(),
      idFactory: sequenceIds(),
      clock: {
        now: () => 0,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
      },
    });
    await cyclingEngine.provide(request('const cycle = ', 'invoke'), createToken());
    expect(sleeps).toEqual([200]);
  });

  it('filters invalid middle-of-line and duplicate next-line suggestions', async () => {
    const invalidModel = new RecordingCompletionModel(() => ({
      text: 'unused',
    }));
    const invalidEngine = createFimGhostTextEngine(invalidModel, {
      tokenizer: new CharacterGhostTextTokenizer(),
      idFactory: sequenceIds(),
      behavior: { completionDelayMs: 0 },
    });
    const invalid = await invalidEngine.provide(
      {
        ...request('const value = existing'),
        position: { line: 0, character: 14 },
      },
      createToken(),
    );
    expect(invalid.type).toBe('empty');
    expect(invalidModel.requests).toHaveLength(0);

    const duplicateModel = new RecordingCompletionModel(() => ({
      text: '  return 1;',
    }));
    const duplicateEngine = createFimGhostTextEngine(duplicateModel, {
      tokenizer: new CharacterGhostTextTokenizer(),
      idFactory: sequenceIds(),
      behavior: { completionDelayMs: 0 },
    });
    const duplicate = await duplicateEngine.provide(
      {
        document: {
          uri: 'file:///workspace/file.ts',
          filePath: 'src/file.ts',
          languageId: 'typescript',
          text: 'function f() {\n\n  return 1;\n}',
          version: 1,
        },
        position: { line: 1, character: 0 },
        trigger: 'automatic',
        multiline: 'single',
      },
      createToken(),
    );
    expect(duplicate.type).toBe('empty');
  });

  it('normalizes indentation and trims forced single-line output', async () => {
    const model = new RecordingCompletionModel(() => ({
      text: '\tvalue\n\tignored',
    }));
    const engine = createFimGhostTextEngine(model, {
      tokenizer: new CharacterGhostTextTokenizer(),
      idFactory: sequenceIds(),
      behavior: { completionDelayMs: 0 },
    });
    const result = await engine.provide(
      {
        document: {
          uri: 'file:///workspace/file.ts',
          filePath: 'src/file.ts',
          languageId: 'typescript',
          text: 'function f() {\n',
          version: 1,
        },
        position: { line: 1, character: 0 },
        trigger: 'automatic',
        multiline: 'single',
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      },
      createToken(),
    );
    expect(result.type).toBe('success');
    if (result.type === 'success') {
      expect(result.list.items[0].displayText).toBe('  value');
      expect(result.list.items[0].insertText).toBe('  value');
    }
    expect(model.requests[0]).toMatchObject({
      metadata: {
        languageId: 'typescript',
        nextIndent: 0,
        trimByIndentation: false,
        codeAnnotations: false,
      },
    });
  });

  it('stores the server-equivalent single-line result in cache', async () => {
    const model = new RecordingCompletionModel(() => ({
      text: 'first line\nsecond line',
    }));
    const engine = createFimGhostTextEngine(model, {
      tokenizer: new CharacterGhostTextTokenizer(),
      idFactory: sequenceIds(),
      behavior: { completionDelayMs: 0 },
    });
    const first = await engine.provide(
      { ...request(), multiline: 'single' },
      createToken(),
    );
    expect(first.type).toBe('success');
    if (first.type === 'success') {
      expect(first.list.items[0].displayText).toBe('first line');
    }

    const cached = await engine.provide(
      { ...request(), multiline: 'multi' },
      createToken(),
    );
    expect(cached.type).toBe('success');
    if (cached.type === 'success') {
      expect(cached.list.items[0].displayText).toBe('first line');
      expect(cached.list.items[0].displayText).not.toContain('second line');
    }
    expect(model.requests).toHaveLength(1);
  });

  it('serves the next progressive reveal segment from prefix cache', async () => {
    const model = new RecordingCompletionModel(() => ({
      text: [
        '  const a = 1;',
        '  const b = 2;',
        '  if (a) {',
        '    work();',
        '  }',
        '  done();',
        '}',
        'next();',
      ].join('\n'),
      finishReason: 'stop',
    }));
    const engine = createFimGhostTextEngine(model, {
      tokenizer: new CharacterGhostTextTokenizer(),
      idFactory: sequenceIds(),
      behavior: { completionDelayMs: 0 },
    });
    const text = 'function f() {\n';
    const first = await engine.provide(
      {
        ...request(text),
        position: { line: 1, character: 0 },
        multiline: 'multi',
      },
      createToken(),
    );
    expect(first.type).toBe('success');
    if (first.type !== 'success') {
      return;
    }

    const acceptedText = text + first.list.items[0].insertText;
    const next = await engine.provide(
      {
        ...request(acceptedText),
        position: { line: 2, character: '  const b = 2;'.length },
        multiline: 'multi',
      },
      createToken(),
    );

    expect(next.type).toBe('success');
    if (next.type === 'success') {
      expect(next.list.source).toBe('cache');
      expect(next.list.items[0].displayText).toContain('if (a)');
      expect(next.list.items[0].metadata.generatedChoiceIndex).toBe(1);
    }
    expect(model.requests).toHaveLength(1);
  });

  it('maps selected completion ranges and middle-of-line suffix coverage', async () => {
    const selectedModel = new RecordingCompletionModel(() => ({ text: '()' }));
    const selectedEngine = createFimGhostTextEngine(selectedModel, {
      tokenizer: new CharacterGhostTextTokenizer(),
      idFactory: sequenceIds(),
      behavior: { completionDelayMs: 0 },
    });
    const selectedText = 'const value = fo;';
    const selected = await selectedEngine.provide(
      {
        ...request(selectedText),
        position: { line: 0, character: selectedText.indexOf(';') },
        selectedCompletionInfo: {
          text: 'foo',
          range: {
            start: selectedText.indexOf('fo'),
            end: selectedText.indexOf(';'),
          },
        },
      },
      createToken(),
    );
    expect(selected.type).toBe('success');
    if (selected.type === 'success') {
      expect(selected.list.items[0].range).toEqual({
        start: { line: 0, character: 0 },
        end: { line: 0, character: selectedText.indexOf(';') },
      });
      expect(selected.list.items[0].insertText).toBe('const value = foo()');
    }

    const suffixModel = new RecordingCompletionModel(() => ({
      text: 'value);',
    }));
    const suffixEngine = createFimGhostTextEngine(suffixModel, {
      tokenizer: new CharacterGhostTextTokenizer(),
      idFactory: sequenceIds(),
      behavior: { completionDelayMs: 0 },
    });
    const suffixText = 'const call();';
    const suffixCursor = suffixText.indexOf('(') + 1;
    const suffix = await suffixEngine.provide(
      {
        ...request(suffixText),
        position: { line: 0, character: suffixCursor },
      },
      createToken(),
    );
    expect(suffix.type).toBe('success');
    if (suffix.type === 'success') {
      expect(suffix.list.items[0].metadata.suffixCoverage).toBe(2);
      expect(suffix.list.items[0].range.end.character).toBe(suffixCursor + 2);
      expect(suffix.list.items[0].insertText).toBe('const call(value);');
    }
  });

  it('trims multiline output at the parser-completed block and filters repetition', async () => {
    const multilineModel = new RecordingCompletionModel(() => ({
      text: 'doWork();\n}\nnextStatement();',
    }));
    const multilineEngine = createFimGhostTextEngine(multilineModel, {
      tokenizer: new CharacterGhostTextTokenizer(),
      idFactory: sequenceIds(),
      behavior: { completionDelayMs: 0 },
    });
    const multiline = await multilineEngine.provide(
      {
        document: {
          uri: 'file:///workspace/file.ts',
          filePath: 'src/file.ts',
          languageId: 'typescript',
          text: 'if (ready) {\n  ',
          version: 1,
        },
        position: { line: 1, character: 2 },
        trigger: 'automatic',
        multiline: 'multi',
      },
      createToken(),
    );
    expect(multiline.type).toBe('success');
    if (multiline.type === 'success') {
      expect(multiline.list.items[0].insertText).toBe('doWork();\n}');
    }

    const repetitiveModel = new RecordingCompletionModel(() => ({
      text: 'xxxxxxxxxx',
    }));
    const repetitiveEngine = createFimGhostTextEngine(repetitiveModel, {
      tokenizer: new CharacterGhostTextTokenizer(),
      idFactory: sequenceIds(),
      behavior: { completionDelayMs: 0 },
    });
    const repetitive = await repetitiveEngine.provide(request(), createToken());
    expect(repetitive.type).toBe('empty');
  });

  it('invalidates caches and classifies model cancellation and errors', async () => {
    const model = new RecordingCompletionModel(() => ({ text: '42' }));
    const engine = createFimGhostTextEngine(model, {
      tokenizer: new CharacterGhostTextTokenizer(),
      idFactory: sequenceIds(),
      behavior: { completionDelayMs: 0 },
    });
    await engine.provide(request(), createToken());
    engine.invalidate();
    await engine.provide(request(), createToken());
    expect(model.requests).toHaveLength(2);

    const deferred = new Deferred<RecordedFimResult>();
    const cancellableModel = new RecordingCompletionModel(
      () => deferred.promise,
    );
    const cancellableEngine = createFimGhostTextEngine(cancellableModel, {
      tokenizer: new CharacterGhostTextTokenizer(),
      idFactory: sequenceIds(),
      behavior: { completionDelayMs: 0 },
    });
    const source = createCancellationSource();
    const pending = cancellableEngine.provide(request(), source.token);
    await Promise.resolve();
    source.cancel();
    deferred.resolve({ text: 'late' });
    expect((await pending).type).toBe('cancelled');

    const failingModel = new RecordingCompletionModel(() => {
      throw new Error('transport failed');
    });
    const failingEngine = createFimGhostTextEngine(failingModel, {
      tokenizer: new CharacterGhostTextTokenizer(),
      idFactory: sequenceIds(),
      behavior: { completionDelayMs: 0 },
    });
    const failed = await failingEngine.provide(request(), createToken());
    expect(failed).toMatchObject({
      type: 'failed',
      reason: 'FIM model request failed',
      error: { message: 'transport failed' },
    });
  });

  it('propagates caller cancellation and starts a fresh transport next time', async () => {
    const deferred = new Deferred<RecordedFimResult>();
    let modelToken: vscode.CancellationToken | undefined;
    let calls = 0;
    const model = new RecordingCompletionModel((_call, _value, token) => {
      calls++;
      modelToken = token;
      return deferred.promise;
    });
    const engine = createFimGhostTextEngine(model, {
      tokenizer: new CharacterGhostTextTokenizer(),
      idFactory: sequenceIds(),
      behavior: {
        completionDelayMs: 0,
        asyncCompletionTimeoutMs: 1_000,
      },
    });
    const caller = createCancellationSource();
    const cancelled = engine.provide(request(), caller.token);
    await vi.waitFor(() => expect(modelToken).toBeDefined());

    caller.cancel();
    await expect(cancelled).resolves.toMatchObject({ type: 'cancelled' });
    expect(modelToken?.isCancellationRequested).toBe(true);

    deferred.resolve({ text: '42' });
    await vi.waitFor(() =>
      expect(engine.getDebugState().inFlightEntries).toBe(0),
    );
    const compatible = engine.provide(request(), createToken());
    await expect(compatible).resolves.toMatchObject({ type: 'success' });
    expect(calls).toBe(2);
  });

  it('keeps only the newest 100 queued speculative callbacks', async () => {
    let calls = 0;
    const model = new RecordingCompletionModel(() => ({
      text: `answer-${calls++}`,
    }));
    const engine = createFimGhostTextEngine(model, {
      tokenizer: new CharacterGhostTextTokenizer(),
      idFactory: sequenceIds(),
      behavior: { completionDelayMs: 0 },
    });
    let firstItemId = '';
    let newestItemId = '';
    for (let index = 0; index < 101; index++) {
      const result = await engine.provide(
        request(`const value${index} = `),
        createToken(),
      );
      expect(result.type).toBe('success');
      if (result.type !== 'success') {
        continue;
      }
      firstItemId ||= result.list.items[0].id;
      newestItemId = result.list.items[0].id;
    }
    expect(engine.getDebugState().speculativeEntries).toBe(100);
    expect(model.requests).toHaveLength(101);

    engine.handleDidShowCompletionItem(firstItemId);
    await Promise.resolve();
    expect(model.requests).toHaveLength(101);

    engine.handleDidShowCompletionItem(newestItemId);
    await vi.waitFor(() => expect(model.requests).toHaveLength(102));
  });

  it('cancels owned active requests on invalidate and ignores late results', async () => {
    const deferred = new Deferred<RecordedFimResult>();
    let receivedToken: vscode.CancellationToken | undefined;
    let calls = 0;
    const model = new RecordingCompletionModel((_call, _value, token) => {
      receivedToken = token;
      calls++;
      return calls === 1
        ? deferred.promise
        : Promise.resolve({ text: 'fresh' });
    });
    const engine = createFimGhostTextEngine(model, {
      tokenizer: new CharacterGhostTextTokenizer(),
      idFactory: sequenceIds(),
      behavior: { completionDelayMs: 0 },
    });
    const pending = engine.provide(request(), createToken());
    await vi.waitFor(() => expect(receivedToken).toBeDefined());

    engine.invalidate();
    expect(receivedToken?.isCancellationRequested).toBe(true);
    deferred.resolve({ text: 'late' });
    expect((await pending).type).toBe('cancelled');
    expect(engine.getDebugState()).toMatchObject({
      cacheEntries: 0,
      inFlightEntries: 0,
    });

    const fresh = await engine.provide(request(), createToken());
    expect(fresh.type).toBe('success');
    expect(calls).toBe(2);
  });

  it('cancels pending async requests that no longer match the latest prefix', async () => {
    let calls = 0;
    let firstToken: vscode.CancellationToken | undefined;
    const model = new RecordingCompletionModel((_call, _value, token) => {
      calls++;
      if (calls > 1) {
        return Promise.resolve({ text: '99' });
      }
      firstToken = token;
      return new Promise<RecordedFimResult>((_resolve, reject) => {
        token.onCancellationRequested(() => {
          const error = new Error('cancelled');
          error.name = 'AbortError';
          reject(error);
        });
      });
    });
    const engine = createFimGhostTextEngine(model, {
      tokenizer: new CharacterGhostTextTokenizer(),
      idFactory: sequenceIds(),
      behavior: { completionDelayMs: 0 },
    });

    const stale = engine.provide(request('const value = '), createToken());
    await vi.waitFor(() => expect(firstToken).toBeDefined());
    const fresh = await engine.provide(request('const other = '), createToken());

    expect(firstToken?.isCancellationRequested).toBe(true);
    expect(calls).toBe(2);
    expect((await stale).type).toBe('cancelled');
    expect(fresh.type).toBe('success');
    expect(engine.getDebugState().inFlightEntries).toBe(0);
  });

  it('cancels owned active requests on dispose and never publishes late results', async () => {
    const deferred = new Deferred<RecordedFimResult>();
    let receivedToken: vscode.CancellationToken | undefined;
    const model = new RecordingCompletionModel((_call, _value, token) => {
      receivedToken = token;
      return deferred.promise;
    });
    const engine = createFimGhostTextEngine(model, {
      tokenizer: new CharacterGhostTextTokenizer(),
      idFactory: sequenceIds(),
      behavior: { completionDelayMs: 0 },
    });
    const pending = engine.provide(request(), createToken());
    await vi.waitFor(() => expect(receivedToken).toBeDefined());

    engine.dispose();
    expect(receivedToken?.isCancellationRequested).toBe(true);
    deferred.resolve({ text: 'late' });
    expect((await pending).type).toBe('cancelled');
    expect(engine.getDebugState()).toMatchObject({
      cacheEntries: 0,
      inFlightEntries: 0,
      speculativeEntries: 0,
    });
  });
});

describe('GhostText lifecycle', () => {
  it('keeps effective item/list state idempotent and ignores stale callbacks', async () => {
    const model = new RecordingCompletionModel(() => ({ text: '42' }));
    const engine = createFimGhostTextEngine(model, {
      tokenizer: new CharacterGhostTextTokenizer(),
      idFactory: sequenceIds(),
      behavior: { completionDelayMs: 0 },
    });
    const result = await engine.provide(request(), createToken());
    expect(result.type).toBe('success');
    if (result.type !== 'success') {
      return;
    }
    const item = result.list.items[0];
    expect(engine.getDebugState()).toMatchObject({
      trackedItemCount: 1,
      trackedListCount: 1,
    });

    engine.handleDidShowCompletionItem(item.id);
    engine.handleDidShowCompletionItem(item.id);
    expect(engine.getDebugState().lastShownItemIds).toEqual([item.id]);

    engine.handleListEndOfLifetime(result.list.id);
    engine.handleListEndOfLifetime(result.list.id);
    expect(engine.getDebugState()).toMatchObject({
      trackedItemCount: 1,
      trackedListCount: 1,
    });

    engine.handleEndOfLifetime(item.id, 'accepted');
    engine.handleEndOfLifetime(item.id, 'discarded');
    expect(engine.getDebugState()).toMatchObject({
      lastShownItemIds: [],
      trackedItemCount: 0,
      trackedListCount: 0,
    });

    engine.handleDidShowCompletionItem(item.id);
    engine.handleListEndOfLifetime(result.list.id);
    expect(engine.getDebugState()).toMatchObject({
      lastShownItemIds: [],
      trackedItemCount: 0,
      trackedListCount: 0,
    });
  });

  it('keeps speculative cancellation independent from the original request token', async () => {
    const speculative = new Deferred<RecordedFimResult>();
    const modelTokens: vscode.CancellationToken[] = [];
    let calls = 0;
    const model = new RecordingCompletionModel((_call, _value, token) => {
      modelTokens.push(token);
      return calls++ === 0
        ? Promise.resolve({ text: '42' })
        : speculative.promise;
    });
    const engine = createFimGhostTextEngine(model, {
      tokenizer: new CharacterGhostTextTokenizer(),
      idFactory: sequenceIds(),
      behavior: { completionDelayMs: 0 },
    });
    const parent = createCancellationSource();
    const result = await engine.provide(request(), parent.token);
    expect(result.type).toBe('success');
    if (result.type !== 'success') {
      return;
    }

    const item = result.list.items[0];
    engine.handleDidShowCompletionItem(item.id);
    await vi.waitFor(() => expect(modelTokens).toHaveLength(2));
    parent.cancel();
    expect(modelTokens[1].isCancellationRequested).toBe(false);

    engine.handleEndOfLifetime(item.id, 'discarded');
    engine.handleListEndOfLifetime(result.list.id);
    expect(modelTokens[1].isCancellationRequested).toBe(false);
    speculative.resolve({ text: 'late speculative' });
    await vi.waitFor(() =>
      expect(engine.getDebugState().speculativeEntries).toBe(0),
    );
    expect(engine.getDebugState().cacheEntries).toBeGreaterThanOrEqual(2);
  });
});
