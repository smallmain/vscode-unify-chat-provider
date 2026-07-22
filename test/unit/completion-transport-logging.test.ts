import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => {
  const output = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    verbose: false,
    output,
    createOutputChannel: vi.fn(() => output),
  };
});

vi.mock('vscode', () => ({
  window: { createOutputChannel: mock.createOutputChannel },
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, fallback: unknown) =>
        mock.verbose === undefined ? fallback : mock.verbose,
    }),
  },
  l10n: { t: (message: string) => message },
  EventEmitter: class EventEmitter {},
}));

import {
  createCompletionRequestLogger,
  type CompletionRequestLogContext,
} from '../../src/completion/api/logging';

const context: CompletionRequestLogContext = {
  transport: 'native',
  requestKind: 'fim',
  model: 'provider/model',
};

function messages(method: 'info' | 'warn' | 'error'): string[] {
  return mock.output[method].mock.calls.map((call) => String(call[0]));
}

describe('CompletionRequestLogger', () => {
  beforeEach(() => {
    mock.verbose = false;
    mock.createOutputChannel.mockClear();
    for (const method of ['info', 'warn', 'error'] as const) {
      mock.output[method].mockClear();
    }
  });

  it('does not create a logger or output channel when verbose is disabled', () => {
    expect(createCompletionRequestLogger(context)).toBeUndefined();
    expect(mock.createOutputChannel).not.toHaveBeenCalled();
  });

  it('uses a dedicated channel and distinct request IDs', () => {
    mock.verbose = true;

    const first = createCompletionRequestLogger(context);
    const second = createCompletionRequestLogger(context);

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first?.requestId).toMatch(/^completion-\d+$/);
    expect(second?.requestId).toMatch(/^completion-\d+$/);
    expect(second?.requestId).not.toBe(first?.requestId);
    expect(mock.createOutputChannel).toHaveBeenCalledTimes(1);
    expect(mock.createOutputChannel).toHaveBeenCalledWith(
      'Unify Chat Provider: Completion',
      { log: true },
    );
  });

  it('logs full payloads while redacting credential fields safely', () => {
    mock.verbose = true;
    const logger = createCompletionRequestLogger(context);
    if (!logger) throw new Error('Expected verbose completion logger.');
    const circular: Record<string, unknown> = {
      source: 'const completePayload = true;',
      max_tokens: 64,
      api_key: 'body-secret',
    };
    circular.self = circular;
    let getterReads = 0;
    Object.defineProperty(circular, 'computed', {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return 'must-not-be-read';
      },
    });

    logger.providerRequest({
      endpoint:
        'https://url-user:url-password@example.test/v1/completions?api_key=query-secret&mode=debug',
      method: 'POST',
      headers: {
        Authorization: 'Bearer header-secret',
        'X-Auth-Token': 'custom-header-secret',
        'Ocp-Apim-Subscription-Key': 'subscription-secret',
        'X-Custom-Authorization': 'Bearer scheme-header-secret',
        'X-Debug': 'kept',
      },
      body: circular,
    });
    logger.rawHttpResponseBody(
      JSON.stringify({
        text: "full response\nconst api_key = 'literal';",
        access_token: 'response-secret',
      }),
    );
    logger.rawHttpResponseBody(
      'api_key=plain-response-secret Authorization: Bearer bearer-secret',
    );

    const output = messages('info').join('\n');
    expect(output).toContain('const completePayload = true;');
    expect(output).toContain('full response');
    expect(output).toContain("const api_key = 'literal';");
    expect(output).toContain('"max_tokens": 64');
    expect(output).toContain('"X-Debug": "kept"');
    expect(output).toContain('[Circular]');
    expect(output).toContain('[Getter]');
    expect(getterReads).toBe(0);
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain('query-secret');
    expect(output).not.toContain('mode=debug');
    expect(output).not.toContain('url-user');
    expect(output).not.toContain('url-password');
    expect(output).not.toContain('header-secret');
    expect(output).not.toContain('custom-header-secret');
    expect(output).not.toContain('subscription-secret');
    expect(output).not.toContain('scheme-header-secret');
    expect(output).not.toContain('body-secret');
    expect(output).not.toContain('response-secret');
    expect(output).not.toContain('plain-response-secret');
    expect(output).not.toContain('bearer-secret');
  });

  it('records LanguageModelChat payloads and only one terminal outcome', () => {
    mock.verbose = true;
    const logger = createCompletionRequestLogger({
      transport: 'compatible',
      requestKind: 'copilot-replica-nes',
      model: 'vendor/model',
    });
    if (!logger) throw new Error('Expected verbose completion logger.');

    logger.languageModelRequest(
      [{ role: 1, content: 'full prompt' }],
      { modelOptions: { max_tokens: 80 } },
    );
    logger.languageModelResponseChunk('first chunk');
    logger.complete();
    logger.cancelled();
    logger.error(new Error('ignored after completion'));

    const info = messages('info');
    expect(info.join('\n')).toContain('LanguageModelChat.sendRequest');
    expect(info.join('\n')).toContain('full prompt');
    expect(info.join('\n')).toContain('first chunk');
    expect(
      info.filter((message) => /Request (completed|cancelled)/.test(message)),
    ).toHaveLength(1);
    expect(messages('error')).toHaveLength(0);
  });

  it('logs retry payloads and only one error terminal', () => {
    mock.verbose = true;
    const logger = createCompletionRequestLogger(context);
    if (!logger) throw new Error('Expected verbose completion logger.');

    logger.retry(
      1,
      2,
      429,
      100,
      JSON.stringify({ error: 'rate limited', client_secret: 'retry-secret' }),
    );
    logger.retry(
      2,
      2,
      0,
      100,
      undefined,
      'network failed for https://user:pass@example.test?sig=detail-secret',
    );
    const cause = Object.assign(
      new Error(
        `upstream failed: ${JSON.stringify({
          client_secret: 'cause-secret"escaped-tail',
        })}`,
      ),
      { code: 'UND_ERR_SOCKET' },
    );
    const error = Object.assign(
      new Error(
        'Completion request failed with HTTP 400: {"client_secret":"terminal-secret"}',
        { cause },
      ),
      { code: 'completion-http-error' },
    );
    logger.error(error);
    logger.complete();
    logger.error(new Error('duplicate'));

    expect(messages('warn').join('\n')).toContain('rate limited');
    expect(messages('warn').join('\n')).not.toContain('retry-secret');
    expect(messages('warn').join('\n')).not.toContain('detail-secret');
    expect(messages('warn').join('\n')).not.toContain('user:pass');
    expect(messages('error').join('\n')).toContain('completion-http-error');
    expect(messages('error').join('\n')).toContain('UND_ERR_SOCKET');
    expect(messages('error').join('\n')).not.toContain('terminal-secret');
    expect(messages('error').join('\n')).not.toContain('cause-secret');
    expect(messages('error').join('\n')).not.toContain('escaped-tail');
    expect(
      messages('error').filter((message) => message.includes('Request failed')),
    ).toHaveLength(1);
  });
});
