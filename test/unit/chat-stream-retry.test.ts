import { InternalServerError } from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

vi.mock('../../src/i18n', () => ({
  t: (message: string, ...args: readonly unknown[]) =>
    message.replace(/\{(\d+)\}/g, (placeholder, index: string) => {
      const value = args[Number(index)];
      return value === undefined ? placeholder : String(value);
    }),
}));

vi.mock('../../src/official-models-manager', () => ({
  officialModelsManager: {},
}));

import {
  isRetryableStreamReadError,
  RetryableStreamReadError,
  shouldRetryStreamReadError,
  withIdleTimeout,
} from '../../src/utils';

class CodedError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

function pendingStream(): AsyncIterable<number> {
  const iterator: AsyncIterator<number> = {
    next: () => new Promise<IteratorResult<number>>(() => undefined),
    return: async () => ({ done: true, value: undefined }),
  };
  return {
    [Symbol.asyncIterator]: () => iterator,
  };
}

function throwingStream(error: unknown): AsyncIterable<number> {
  const iterator: AsyncIterator<number> = {
    next: async () => {
      throw error;
    },
    return: async () => ({ done: true, value: undefined }),
  };
  return {
    [Symbol.asyncIterator]: () => iterator,
  };
}

async function consume(source: AsyncIterable<unknown>): Promise<void> {
  for await (const value of source) {
    void value;
  }
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected promise to reject');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('chat stream retry classification', () => {
  it('marks response idle timeouts as retryable stream-read errors', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const rejection = captureError(
      consume(withIdleTimeout(pendingStream(), 100, undefined, onTimeout)),
    );

    await vi.advanceTimersByTimeAsync(100);
    const error = await rejection;

    expect(error).toBeInstanceOf(RetryableStreamReadError);
    if (!(error instanceof RetryableStreamReadError)) {
      throw new Error('Expected RetryableStreamReadError');
    }
    expect(error.name).toBe('TimeoutError');
    expect(error.message).toBe(
      'Response timeout: No data received for 100ms',
    );
    expect(error.cause).toMatchObject({
      name: 'TimeoutError',
      message: 'Response timeout: No data received for 100ms',
    });
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it.each([
    'UND_ERR_SOCKET',
    'UND_ERR_BODY_TIMEOUT',
    'ECONNRESET',
    'ETIMEDOUT',
  ])('marks body-read network error %s as retryable', async (code) => {
    const sourceError = new CodedError('stream failed', code);
    const error = await captureError(
      consume(withIdleTimeout(throwingStream(sourceError), 100)),
    );

    expect(error).toBeInstanceOf(RetryableStreamReadError);
    expect(isRetryableStreamReadError(error)).toBe(true);
  });

  it('recognizes a terminated wrapper with a socket cause', async () => {
    const socketError = new CodedError(
      'other side closed',
      'UND_ERR_SOCKET',
    );
    const terminatedError = new TypeError('terminated', {
      cause: socketError,
    });
    const error = await captureError(
      consume(withIdleTimeout(throwingStream(terminatedError), 100)),
    );

    expect(error).toBeInstanceOf(RetryableStreamReadError);
    if (!(error instanceof RetryableStreamReadError)) {
      throw new Error('Expected RetryableStreamReadError');
    }
    expect(error.cause).toBe(socketError);
  });

  it('still recognizes stream_read_error codes on Error instances', () => {
    expect(
      isRetryableStreamReadError(
        new CodedError('provider stream failed', 'stream_read_error'),
      ),
    ).toBe(true);
  });

  it('still recognizes upstream_http2_stream_error codes on Error instances', () => {
    expect(
      isRetryableStreamReadError(
        new CodedError(
          'provider stream failed',
          'upstream_http2_stream_error',
        ),
      ),
    ).toBe(true);
  });

  it.each([
    {
      name: 'a nested upstream error payload with a retryable code',
      payload: {
        error: {
          code: 'upstream_http2_stream_error',
          message: 'upstream http2 stream error',
        },
      },
    },
    {
      name: 'a nested upstream error payload without a code',
      payload: {
        error: { message: 'upstream stream returned an error payload' },
      },
    },
    {
      name: 'a nested upstream error payload closed before response.completed',
      payload: {
        error: {
          message:
            'stream disconnected before completion: stream closed before response.completed',
        },
      },
    },
    {
      name: 'the reported upstream gateway payload with an upstream_error type',
      payload: {
        error: {
          message: 'Upstream service temporarily unavailable, please retry later',
          type: 'upstream_error',
        },
        sequence_number: 8,
      },
    },
    {
      name: 'an Error instance carrying the gateway message',
      payload: new Error(
        'Upstream service temporarily unavailable, please retry later',
      ),
    },
    {
      name: 'the gateway message in mixed case (matched after lowercasing)',
      payload: {
        error: {
          message: 'Upstream Service TEMPORARILY Unavailable, please retry later',
        },
      },
    },
    {
      name: 'an upstream_error type despite a non-transient message',
      payload: {
        error: { message: 'upstream service unavailable', type: 'upstream_error' },
      },
    },
    {
      name: 'an upstream_error type with an unrelated message',
      payload: { error: { message: 'anything', type: 'upstream_error' } },
    },
    {
      name: 'a top-level upstream_error type (SDK error mirror)',
      payload: { type: 'upstream_error' },
    },
  ])('recognizes $name as retryable', ({ payload }) => {
    expect(isRetryableStreamReadError(payload)).toBe(true);
  });

  it('retries a 502 gateway error surfaced by the SDK once the fetch retry budget is exhausted (stream-layer retry intentionally stacks on the transport-layer budget)', () => {
    const error = new InternalServerError(
      502,
      {
        message: 'Upstream service temporarily unavailable, please retry later',
        type: 'upstream_error',
      },
      undefined,
      new Headers(),
    );

    expect(isRetryableStreamReadError(error)).toBe(true);
  });

  it('does not match stream error codes that only differ in case', () => {
    expect(
      isRetryableStreamReadError(
        new CodedError('provider stream failed', 'Upstream_Http2_Stream_Error'),
      ),
    ).toBe(false);
  });

  it('does not match a truncated message without the response.completed phrase', () => {
    expect(
      isRetryableStreamReadError({
        error: { message: 'stream disconnected before completion' },
      }),
    ).toBe(false);
  });

  it.each([
    {
      name: 'a bare temporarily unavailable message without the upstream service prefix',
      payload: { error: { message: 'temporarily unavailable' } },
    },
    {
      name: 'a reordered upstream temporarily unavailable message',
      payload: { error: { message: 'upstream temporarily unavailable' } },
    },
    {
      name: 'a truncated upstream service message',
      payload: { error: { message: 'upstream service temporarily' } },
    },
    {
      name: 'an upstream_error type that only differs in case',
      payload: { error: { type: 'Upstream_Error' } },
    },
  ])('does not match $name as retryable', ({ payload }) => {
    expect(isRetryableStreamReadError(payload)).toBe(false);
  });

  it('does not treat an unmarked fetch-stage network error as a stream error', () => {
    expect(
      isRetryableStreamReadError(
        new CodedError('connection failed', 'UND_ERR_SOCKET'),
      ),
    ).toBe(false);
  });

  it('does not mark parser or business errors as transport failures', async () => {
    const sourceError = new Error('invalid response payload');
    const error = await captureError(
      consume(withIdleTimeout(throwingStream(sourceError), 100)),
    );

    expect(error).toBe(sourceError);
    expect(isRetryableStreamReadError(error)).toBe(false);
  });

  it('does not retry an unmarked abort error', () => {
    const abortError = new Error('stream_read_error after abort');
    abortError.name = 'AbortError';

    expect(isRetryableStreamReadError(abortError)).toBe(false);
  });
});

describe('chat stream retry policy', () => {
  const retryableError = new RetryableStreamReadError(
    new Error('transient stream failure'),
  );

  const gatewayErrorPayload = {
    error: {
      message: 'Upstream service temporarily unavailable, please retry later',
      type: 'upstream_error',
    },
    sequence_number: 8,
  };

  it('retries the reported gateway error payload before the first emitted part', () => {
    expect(
      shouldRetryStreamReadError(gatewayErrorPayload, {
        emittedPartCount: 0,
        cancellationRequested: false,
        retryAttempt: 0,
        maxRetries: 10,
      }),
    ).toBe(true);
  });

  it('does not retry the gateway error payload after a part was emitted', () => {
    expect(
      shouldRetryStreamReadError(gatewayErrorPayload, {
        emittedPartCount: 1,
        cancellationRequested: false,
        retryAttempt: 0,
        maxRetries: 10,
      }),
    ).toBe(false);
  });

  it('retries a marked error before the first emitted part', () => {
    expect(
      shouldRetryStreamReadError(retryableError, {
        emittedPartCount: 0,
        cancellationRequested: false,
        retryAttempt: 0,
        maxRetries: 1,
      }),
    ).toBe(true);
  });

  it.each([
    {
      name: 'a response part was already emitted',
      emittedPartCount: 1,
      cancellationRequested: false,
      retryAttempt: 0,
      maxRetries: 1,
    },
    {
      name: 'the request was cancelled',
      emittedPartCount: 0,
      cancellationRequested: true,
      retryAttempt: 0,
      maxRetries: 1,
    },
    {
      name: 'the retry budget is exhausted',
      emittedPartCount: 0,
      cancellationRequested: false,
      retryAttempt: 1,
      maxRetries: 1,
    },
  ])('does not retry when $name', ({ name: _name, ...state }) => {
    expect(shouldRetryStreamReadError(retryableError, state)).toBe(false);
  });
});
