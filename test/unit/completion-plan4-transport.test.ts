import type * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  Disposable: class Disposable {
    dispose(): void {}
  },
  EventEmitter: class EventEmitter {
    readonly event = (): { dispose(): void } => ({ dispose() {} });
    dispose(): void {}
  },
  LanguageModelChatMessage: class LanguageModelChatMessage {},
  LanguageModelChatMessageRole: { User: 1, Assistant: 2, System: 3 },
  ThemeIcon: class ThemeIcon {},
  env: { language: 'en' },
  extensions: { getExtension: () => undefined },
  l10n: { t: (message: string) => message },
  workspace: {
    getConfiguration: () => ({ get: () => undefined }),
  },
  window: {
    createOutputChannel: () => ({
      info(): void {},
      warn(): void {},
      error(): void {},
    }),
  },
}));

import type { ModelConfig, ProviderConfig } from '../../src/types';
import {
  buildMercuryEditRequestBody,
  parseMercuryEditResponse,
} from '../../src/completion/api/inception-edit-provider';
import {
  buildCodestralRequestBody,
  parseCodestralResponse,
} from '../../src/completion/api/mistral-fim-provider';
import { buildOllamaZetaRequestBody } from '../../src/completion/api/ollama-generate-provider';
import { buildOpenAIZetaRequestBody } from '../../src/completion/api/openai-completions-provider';
import {
  buildZedV3RequestBody,
  buildZedV4RequestBody,
  clearZedRequestBackoffForTests,
  ZED_PREDICT_EDITS_PROVIDER_DEFINITION,
} from '../../src/completion/api/zed-predict-edits-provider';
import { clearCompletionConcurrencyForTests } from '../../src/completion/api/concurrency';
import { configureZedCompletionSessionPort } from '../../src/completion/zed/session-port';
import {
  clearZedFeedbackForTests,
  zedFeedbackTesting,
} from '../../src/completion/zed/feedback';
import type {
  MercuryEditCompletionRequest,
  Zeta3InternalCompletionRequest,
  ZetaCompletionRequest,
} from '../../src/completion/model/requests';
import type { ZetaPrompt } from '../../src/completion/template/zeta';

function provider(
  type: ProviderConfig['type'],
  model: ModelConfig,
  extraBody: Record<string, unknown>,
): ProviderConfig {
  return {
    type,
    name: `${type}-test`,
    baseUrl: 'https://example.test/v1',
    models: [model],
    extraBody,
  };
}

const document = {
  uri: 'file:///workspace/main.ts',
  path: 'src/main.ts',
  languageId: 'typescript',
  version: 1,
  text: 'const value = 1;\n',
  cursorOffset: 14,
};

function cancellationToken(): vscode.CancellationToken {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => undefined }),
  };
}

afterEach(() => {
  clearZedRequestBackoffForTests();
  clearCompletionConcurrencyForTests();
  clearZedFeedbackForTests();
  vi.useRealTimers();
});

describe('Plan 4 native completion payloads', () => {
  it('sends only the Inception Edit contract and preserves unfenced responses', () => {
    const model: ModelConfig = {
      id: 'mercury-coder-small-beta#thinking',
      extraBody: {
        custom: 'model',
        stream: true,
        temperature: 0.8,
        max_tokens: 999,
        max_completion_tokens: 999,
      },
    };
    const request: MercuryEditCompletionRequest = {
      kind: 'mercury-edit-2',
      document,
      editHistory: [],
      contexts: [],
    };
    const prompt = { prompt: '<prompt>', editableStart: 2, editableEnd: 8 };
    const body = buildMercuryEditRequestBody(
      provider('openai-chat-completion', model, {
        custom: 'provider',
        messages: ['wrong'],
      }),
      model,
      request,
      prompt,
    );
    expect(body).toEqual({
      custom: 'model',
      model: 'mercury-coder-small-beta',
      messages: [{ role: 'user', content: '<prompt>' }],
    });
    expect(
      parseMercuryEditResponse(
        {
          choices: [
            { message: { content: 'None' }, finish_reason: 'stop' },
          ],
          usage: { total_tokens: 12 },
        },
        request,
        prompt,
      ),
    ).toEqual({
      mode: 'buffered',
      choices: [{ text: 'None', finishReason: 'stop' }],
      usage: { total_tokens: 12 },
      edit: {
        targetUri: document.uri,
        startOffset: 2,
        endOffset: 8,
      },
    });
  });

  it('unwraps the complete Markdown fence from Inception Edit responses', () => {
    const request: MercuryEditCompletionRequest = {
      kind: 'mercury-edit-2',
      document,
      editHistory: [],
      contexts: [],
    };
    const prompt = { prompt: '<prompt>', editableStart: 2, editableEnd: 8 };
    const response = parseMercuryEditResponse(
      {
        choices: [
          {
            message: {
              content:
                '```typescript\r\n\r\nconst value = `tick`;\r\n\r\n``` \r\n',
            },
          },
        ],
      },
      request,
      prompt,
    );

    expect(response.choices[0]?.text).toBe(
      '\r\nconst value = `tick`;\r\n',
    );
  });

  it('does not unwrap incomplete or embedded Mercury response fences', () => {
    const request: MercuryEditCompletionRequest = {
      kind: 'mercury-edit-2',
      document,
      editHistory: [],
      contexts: [],
    };
    const prompt = { prompt: '<prompt>', editableStart: 2, editableEnd: 8 };
    const content = 'prefix\n```typescript\nconst value = 2;\n```';
    const response = parseMercuryEditResponse(
      { choices: [{ message: { content } }] },
      request,
      prompt,
    );

    expect(response.choices[0]?.text).toBe(content);
  });

  it('backs off Cloud predictions for ten seconds without leaking across organizations', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let backoffKey = 'provider-key:org-a';
    const feedback = {
      accept: vi.fn(async () => undefined),
      reject: vi.fn(async () => undefined),
      settled: vi.fn(async () => undefined),
    };
    const timeoutError = Object.assign(new Error('timeout'), { status: 408 });
    const predictV3 = vi
      .fn()
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValue({
        response: {
          requestId: 'request-id',
          output: '',
          editableRange: { start: 0, end: 0 },
        },
        feedback,
        canceledAfterDispatch: false,
      });
    const port = configureZedCompletionSessionPort({
      getPolicySnapshot: async () => ({
        dataCollectionEnabled: false,
        dataCollectionAllowed: false,
        backoffKey,
      }),
      predictV3,
      predictV4: vi.fn(),
    });
    const model: ModelConfig = { id: 'zeta-cloud' };
    const context = {
      provider: provider('zed', model, {}),
      model,
      completion: {
        transport: 'native' as const,
        templates: ['zeta2.1' as const],
      },
      resolveCredential: async () => ({ kind: 'none' as const }),
    };
    const request = {
      kind: 'zeta2.1' as const,
      document,
      trigger: 'buffer_edit' as const,
      editHistory: [],
      contexts: [],
      diagnostics: [],
      options: {},
    };
    const factory =
      ZED_PREDICT_EDITS_PROVIDER_DEFINITION.operationFactories['zeta2.1'];
    expect(factory).toBeDefined();
    if (!factory) return;
    const operation = factory(context);

    await expect(
      operation.execute(request, cancellationToken()),
    ).rejects.toMatchObject({
      code: 'completion-request-failed',
      message: 'timeout',
    });
    await expect(
      operation.execute(request, cancellationToken()),
    ).resolves.toEqual({ mode: 'buffered', choices: [] });
    expect(predictV3).toHaveBeenCalledTimes(1);

    backoffKey = 'provider-key:org-b';
    await expect(
      operation.execute(request, cancellationToken()),
    ).resolves.toMatchObject({ mode: 'buffered', choices: [] });
    expect(predictV3).toHaveBeenCalledTimes(2);

    backoffKey = 'provider-key:org-a';
    await vi.advanceTimersByTimeAsync(9_999);
    await operation.execute(request, cancellationToken());
    expect(predictV3).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await operation.execute(request, cancellationToken());
    expect(predictV3).toHaveBeenCalledTimes(3);
    port.dispose();
  });

  it('handles a header-only Zed v4 patch as an empty prediction', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const feedback = {
      accept: vi.fn(async () => undefined),
      reject: vi.fn(async () => undefined),
      settled: vi.fn(async () => undefined),
    };
    const predictV4 = vi.fn(async () => ({
      response: {
        requestId: 'empty-v4',
        patch: '--- a/index.ts\n+++ b/index.ts\n',
        modelVersion: 'zeta3:test',
      },
      feedback,
      canceledAfterDispatch: false,
    }));
    const port = configureZedCompletionSessionPort({
      getPolicySnapshot: async () => ({
        dataCollectionEnabled: false,
        dataCollectionAllowed: false,
        backoffKey: 'provider-key:org',
      }),
      predictV3: vi.fn(),
      predictV4,
    });
    const model: ModelConfig = { id: 'zeta-cloud' };
    const context = {
      provider: provider('zed', model, {}),
      model,
      completion: {
        transport: 'native' as const,
        templates: ['zeta3-internal' as const],
      },
      resolveCredential: async () => ({ kind: 'none' as const }),
    };
    const request: Zeta3InternalCompletionRequest = {
      kind: 'zeta3-internal',
      document,
      trigger: 'buffer_edit',
      editHistory: [],
      diagnostics: [],
    };
    const factory =
      ZED_PREDICT_EDITS_PROVIDER_DEFINITION.operationFactories[
        'zeta3-internal'
      ];
    expect(factory).toBeDefined();
    if (!factory) return;

    try {
      await expect(
        factory(context).execute(request, cancellationToken()),
      ).resolves.toEqual({ mode: 'buffered', choices: [] });
      expect(predictV4).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(
        zedFeedbackTesting.REJECT_DEBOUNCE_MS,
      );
      expect(feedback.reject).toHaveBeenCalledWith({
        rejections: [
          {
            request_id: 'empty-v4',
            reason: 'empty',
            was_shown: false,
            model_version: 'zeta3:test',
            e2e_latency_ms: 0,
          },
        ],
      });
    } finally {
      port.dispose();
    }
  });

  it('turns an invalid Zed v4 patch into a rejected empty prediction', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const feedback = {
      accept: vi.fn(async () => undefined),
      reject: vi.fn(async () => undefined),
      settled: vi.fn(async () => undefined),
    };
    const port = configureZedCompletionSessionPort({
      getPolicySnapshot: async () => ({
        dataCollectionEnabled: false,
        dataCollectionAllowed: false,
        backoffKey: 'provider-key:invalid-v4',
      }),
      predictV3: vi.fn(),
      predictV4: vi.fn(async () => ({
        response: {
          requestId: 'invalid-v4',
          patch:
            '--- a/../secret.ts\n+++ b/../secret.ts\n@@ -1 +1 @@\n-old\n+new\n',
          modelVersion: 'zeta3:test',
        },
        feedback,
        canceledAfterDispatch: false,
      })),
    });
    const model: ModelConfig = { id: 'zeta-cloud' };
    const context = {
      provider: provider('zed', model, {}),
      model,
      completion: {
        transport: 'native' as const,
        templates: ['zeta3-internal' as const],
      },
      resolveCredential: async () => ({ kind: 'none' as const }),
    };
    const request: Zeta3InternalCompletionRequest = {
      kind: 'zeta3-internal',
      document,
      trigger: 'buffer_edit',
      editHistory: [],
      diagnostics: [],
    };
    const factory =
      ZED_PREDICT_EDITS_PROVIDER_DEFINITION.operationFactories[
        'zeta3-internal'
      ];
    expect(factory).toBeDefined();
    if (!factory) return;

    try {
      await expect(
        factory(context).execute(request, cancellationToken()),
      ).resolves.toEqual({ mode: 'buffered', choices: [] });
      await vi.advanceTimersByTimeAsync(
        zedFeedbackTesting.REJECT_DEBOUNCE_MS,
      );
      expect(feedback.reject).toHaveBeenCalledWith({
        rejections: [
          expect.objectContaining({
            request_id: 'invalid-v4',
            reason: 'patch_apply_failed',
            was_shown: false,
          }),
        ],
      });
    } finally {
      port.dispose();
    }
  });

  it('preserves an empty Zed v3 output when it deletes an editable range', async () => {
    const feedback = {
      accept: vi.fn(async () => undefined),
      reject: vi.fn(async () => undefined),
      settled: vi.fn(async () => undefined),
    };
    const port = configureZedCompletionSessionPort({
      getPolicySnapshot: async () => ({
        dataCollectionEnabled: false,
        dataCollectionAllowed: false,
        backoffKey: 'provider-key:deletion',
      }),
      predictV3: vi.fn(async () => ({
        response: {
          requestId: 'delete-v3',
          output: '',
          editableRange: { start: 0, end: 5 },
        },
        feedback,
        canceledAfterDispatch: false,
      })),
      predictV4: vi.fn(),
    });
    const model: ModelConfig = { id: 'zeta-cloud' };
    const context = {
      provider: provider('zed', model, {}),
      model,
      completion: {
        transport: 'native' as const,
        templates: ['zeta2.1' as const],
      },
      resolveCredential: async () => ({ kind: 'none' as const }),
    };
    const request: ZetaCompletionRequest & { readonly kind: 'zeta2.1' } = {
      kind: 'zeta2.1',
      document,
      trigger: 'buffer_edit',
      editHistory: [],
      contexts: [],
      diagnostics: [],
      options: {},
    };
    const factory =
      ZED_PREDICT_EDITS_PROVIDER_DEFINITION.operationFactories['zeta2.1'];
    expect(factory).toBeDefined();
    if (!factory) return;

    try {
      await expect(
        factory(context).execute(request, cancellationToken()),
      ).resolves.toMatchObject({
        choices: [{ text: '' }],
        edit: { startOffset: 0, endOffset: 5 },
      });
    } finally {
      port.dispose();
    }
  });

  it('sends the bounded Codestral FIM contract and reads message content', () => {
    const model: ModelConfig = {
      id: 'codestral-latest#variant',
      extraBody: {
        custom: true,
        stream: true,
        temperature: 0.3,
        top_p: 0.5,
        max_tokens: 1,
        max_completion_tokens: 2,
      },
    };
    const body = buildCodestralRequestBody(
      provider('openai-chat-completion', model, {
        prompt: 'wrong',
        suffix: 'wrong',
      }),
      model,
      {
        kind: 'codestral',
        prefix: 'before',
        suffix: 'after',
        options: { maxTokens: 150 },
      },
      { prompt: 'bounded-before', suffix: 'bounded-after' },
    );
    expect(body).toEqual({
      custom: true,
      model: 'codestral-latest',
      prompt: 'bounded-before',
      suffix: 'bounded-after',
      stream: false,
      top_p: 1,
      max_tokens: 150,
    });
    expect(
      parseCodestralResponse({
        choices: [
          { message: { content: '```ts\ncode\n```' }, finish_reason: 'stop' },
        ],
      }),
    ).toEqual({
      mode: 'buffered',
      choices: [{ text: '```ts\ncode\n```', finishReason: 'stop' }],
    });
  });

  it('removes sampling overrides from local Zeta request bodies', () => {
    const model: ModelConfig = {
      id: 'zeta-model#variant',
      temperature: 0.9,
      maxOutputTokens: 999,
      extraBody: {
        custom: 'model',
        temperature: 0.8,
        max_tokens: 888,
        n: 4,
        options: {
          temperature: 0.7,
          num_predict: 777,
          stop: ['wrong'],
          keep_alive: '5m',
        },
      },
    };
    const request: ZetaCompletionRequest = {
      kind: 'zeta2.1',
      document,
      trigger: 'explicit',
      editHistory: [],
      contexts: [],
      diagnostics: [],
      options: { maxTokens: 64 },
    };
    const prompt: ZetaPrompt = {
      prompt: '<zeta-prompt>',
      stops: ['<stop>'],
      editableStart: 0,
      editableEnd: document.text.length,
      oldEditable: document.text,
    };
    const openAI = buildOpenAIZetaRequestBody(
      provider('openai-chat-completion', model, {
        temperature: 0.6,
        max_tokens: 666,
        n: 3,
      }),
      model,
      request,
      prompt,
    );
    expect(openAI).toEqual({
      custom: 'model',
      model: 'zeta-model',
      prompt: '<zeta-prompt>',
      max_tokens: 64,
      stop: ['<stop>'],
      stream: false,
    });

    const ollama = buildOllamaZetaRequestBody(
      provider('ollama', model, {}),
      model,
      request,
      prompt,
    );
    expect(ollama).toEqual({
      custom: 'model',
      model: 'zeta-model',
      prompt: '<zeta-prompt>',
      raw: true,
      options: {
        keep_alive: '5m',
        num_predict: 64,
        stop: ['<stop>'],
      },
      stream: false,
    });
  });

  it('serializes distinct Zed v3 and v4 context, syntax, and diagnostic bodies', () => {
    const text = 'alpha α\nfunction test() {\n  return 1;\n}\n';
    const cloudDocument = {
      ...document,
      text,
      cursorOffset: text.indexOf('return'),
      syntaxRanges: [
        { startOffset: 0, endOffset: text.length },
        {
          startOffset: text.indexOf('function'),
          endOffset: text.lastIndexOf('}') + 1,
        },
      ],
    };
    const diagnostic = {
      severity: 1,
      message: 'diagnostic',
      snippet: '  return 1;\n',
      snippetStartRow: 2,
      snippetEndRow: 3,
      diagnosticStartRow: 2,
      diagnosticEndRow: 2,
      diagnosticStartByte: 2,
      diagnosticEndByte: 8,
    };
    const v3Request: ZetaCompletionRequest & { readonly kind: 'zeta2.1' } = {
      kind: 'zeta2.1',
      document: cloudDocument,
      trigger: 'buffer_edit',
      editHistory: [
        { path: 'src/main.ts', oldText: 'return 0', newText: 'return 1' },
      ],
      contexts: [{ path: 'src/helper.ts', content: 'export {};' }],
      diagnostics: [diagnostic],
      options: {},
    };
    const collection = {
      canCollectData: true,
      isInOpenSourceRepo: true,
      repoUrl: 'https://example.test/repo.git',
    };
    const v3 = buildZedV3RequestBody(v3Request, collection);
    expect(v3).toMatchObject({
      cursor_path: 'src/main.ts',
      cursor_excerpt: text,
      cursor_offset_in_excerpt: Buffer.byteLength(
        text.slice(0, cloudDocument.cursorOffset),
      ),
      excerpt_start_row: 0,
      can_collect_data: true,
      in_open_source_repo: true,
      repo_url: collection.repoUrl,
      active_buffer_diagnostics: [
        {
          severity: 2,
          message: 'diagnostic',
          snippet: '  return 1;\n',
          snippet_buffer_row_range: { start: 2, end: 2 },
          diagnostic_range_in_snippet: { start: 2, end: 8 },
        },
      ],
    });
    expect(v3.syntax_ranges).toEqual([
      { start: 0, end: Buffer.byteLength(text) },
      {
        start: Buffer.byteLength(text.slice(0, text.indexOf('function'))),
        end: Buffer.byteLength(text.slice(0, text.lastIndexOf('}') + 1)),
      },
    ]);

    const v4Request: Zeta3InternalCompletionRequest = {
      kind: 'zeta3-internal',
      document: cloudDocument,
      trigger: 'buffer_edit',
      editHistory: v3Request.editHistory,
      diagnostics: [diagnostic],
    };
    const v4 = buildZedV4RequestBody(v4Request, collection);
    expect(v4).not.toHaveProperty('related_files');
    expect(v4).not.toHaveProperty('cursor_excerpt');
    expect(v4).toMatchObject({
      cursor_path: 'src/main.ts',
      can_collect_data: true,
      editable_context: [
        expect.objectContaining({
          path: 'src/main.ts',
          excerpts: [
            expect.objectContaining({ context_source: 'current_file' }),
          ],
        }),
      ],
    });
  });

  it('transforms edit-history excerpts onto the latest cross-file snapshot', () => {
    const helperLines = Array.from(
      { length: 90 },
      (_, index) => `export const line${index} = ${index};`,
    );
    const oldHelper = `${helperLines.join('\n')}\n`;
    helperLines[50] = 'export const TARGET = 50;';
    const editedHelper = `${helperLines.join('\n')}\n`;
    const targetStart = editedHelper.indexOf('TARGET');
    const prefix = Array.from(
      { length: 30 },
      (_, index) => `// inserted ${index}`,
    ).join('\n') + '\n';
    const latestHelper = `${prefix}${editedHelper}`;
    const request: Zeta3InternalCompletionRequest = {
      kind: 'zeta3-internal',
      document,
      trigger: 'buffer_edit',
      editHistory: [
        {
          path: 'src/helper.ts',
          oldText: oldHelper,
          newText: editedHelper,
          newRange: {
            startOffset: targetStart,
            endOffset: targetStart + 'TARGET'.length,
          },
        },
        {
          path: 'src/helper.ts',
          oldText: editedHelper,
          newText: latestHelper,
          newRange: { startOffset: 0, endOffset: prefix.length },
        },
      ],
      diagnostics: [],
    };
    const body = buildZedV4RequestBody(request);
    const context = body.editable_context as Array<{
      path: string;
      excerpts: Array<{
        order: number;
        row_range: { start: number; end: number };
        text: string;
      }>;
    }>;
    const helper = context.find((file) => file.path === 'src/helper.ts');
    const originalEdit = helper?.excerpts.find((excerpt) => excerpt.order === 1);
    expect(originalEdit?.row_range.start).toBe(60);
    expect(originalEdit?.text).toContain('export const TARGET = 50;');
  });

  it('uses Zed row-start endpoints when splitting overlapping history excerpts', () => {
    const lines = Array.from({ length: 100 }, (_, index) => `line ${index}`);
    const original = `${lines.join('\n')}\n`;
    lines[30] = 'FIRST 30';
    const first = `${lines.join('\n')}\n`;
    lines[40] = 'SECOND 40';
    const second = `${lines.join('\n')}\n`;
    const request: Zeta3InternalCompletionRequest = {
      kind: 'zeta3-internal',
      document,
      trigger: 'buffer_edit',
      editHistory: [
        {
          path: 'src/history.ts',
          oldText: original,
          newText: first,
          newRange: {
            startOffset: first.indexOf('FIRST 30'),
            endOffset: first.indexOf('FIRST 30') + 'FIRST 30'.length,
          },
        },
        {
          path: 'src/history.ts',
          oldText: first,
          newText: second,
          newRange: {
            startOffset: second.indexOf('SECOND 40'),
            endOffset: second.indexOf('SECOND 40') + 'SECOND 40'.length,
          },
        },
      ],
      diagnostics: [],
    };
    const body = buildZedV4RequestBody(request);
    const context = body.editable_context as Array<{
      path: string;
      excerpts: Array<{
        order: number;
        row_range: { start: number; end: number };
        text: string;
      }>;
    }>;
    const history = context.find((file) => file.path === 'src/history.ts');
    expect(history?.excerpts).toEqual([
      expect.objectContaining({
        order: 1,
        row_range: { start: 10, end: 51 },
        text: second.split('\n').slice(10, 51).join('\n') + '\n',
      }),
      expect.objectContaining({
        order: 2,
        row_range: { start: 51, end: 61 },
        text: second.split('\n').slice(51, 61).join('\n') + '\n',
      }),
    ]);
  });

  it('snaps edit-history windows to nearby natural block boundaries', () => {
    const lines = Array.from({ length: 70 }, (_, index) => `line ${index}`);
    lines[10] = '}';
    lines[11] = '';
    lines[12] = 'function boundary() {';
    lines[48] = 'const blockEnd = true;';
    lines[49] = '';
    const original = `${lines.join('\n')}\n`;
    lines[30] = 'EDITED 30';
    const edited = `${lines.join('\n')}\n`;
    const editStart = edited.indexOf('EDITED 30');
    const body = buildZedV4RequestBody({
      kind: 'zeta3-internal',
      document,
      trigger: 'buffer_edit',
      editHistory: [
        {
          path: 'src/boundary.ts',
          oldText: original,
          newText: edited,
          newRange: {
            startOffset: editStart,
            endOffset: editStart + 'EDITED 30'.length,
          },
        },
      ],
      diagnostics: [],
    });
    const context = body.editable_context as Array<{
      path: string;
      excerpts: Array<{
        row_range: { start: number; end: number };
        text: string;
      }>;
    }>;
    const excerpt = context.find((file) => file.path === 'src/boundary.ts')
      ?.excerpts[0];
    expect(excerpt?.row_range).toEqual({ start: 12, end: 48 });
    expect(excerpt?.text.startsWith('function boundary() {\n')).toBe(true);
    expect(excerpt?.text.endsWith('const blockEnd = true;')).toBe(true);
  });
});
