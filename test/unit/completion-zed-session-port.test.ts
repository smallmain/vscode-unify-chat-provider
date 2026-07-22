import type * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ZedPredictEditsRequestOptions,
  ZedPredictEditsV3Response,
} from '../../src/client/zed/types';
import type { AuthTokenInfo } from '../../src/auth/types';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
}

const state = vi.hoisted(() => ({
  createClient: vi.fn(),
  createTokenSource: vi.fn(),
  predictV3: vi.fn(),
  accept: vi.fn(),
  tokens: { cached: vi.fn(), refresh: vi.fn() },
}));

vi.mock('../../src/client/zed/runtime', () => ({
  assertZedProviderAuth: (provider: {
    auth?: { method?: string; organizationId?: string };
  }) => {
    if (provider.auth?.method !== 'zed' || !provider.auth.organizationId) {
      throw new Error('Zed authentication is required.');
    }
    return provider.auth.organizationId;
  },
  createZedCloudClient: (provider: unknown) => {
    state.createClient(provider);
    return {
      predictEditsV3: state.predictV3,
      predictEditsV4: vi.fn(),
      accept: state.accept,
      reject: vi.fn(async () => undefined),
      settled: vi.fn(async () => undefined),
    };
  },
  createZedLlmTokenSource: () => {
    state.createTokenSource();
    return state.tokens;
  },
}));

import { getZedCompletionSessionPort } from '../../src/completion/zed/session-port';
import type { NativeCompletionApiContext } from '../../src/completion/api/provider';
import { createZedProviderIdentity } from '../../src/client/zed/urls';

function controlledToken(): vscode.CancellationToken & { cancel(): void } {
  const listeners = new Set<(event: unknown) => unknown>();
  let cancelled = false;
  return {
    get isCancellationRequested() {
      return cancelled;
    },
    onCancellationRequested(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      for (const listener of [...listeners]) listener(undefined);
    },
  };
}

const context = {
  provider: {
    type: 'zed',
    name: 'zed-test',
    baseUrl: 'https://zed.dev',
    models: [],
    auth: {
      method: 'zed',
      baseUrl: 'https://zed.dev',
      identityId: 'identity',
      organizationId: 'org-a',
      dataCollection: false,
      dataCollectionAllowed: true,
    },
  },
  model: { id: 'zeta-cloud' },
  completion: { transport: 'native', templates: ['zeta2.1'] },
  resolveCredential: async () => ({
    kind: 'token' as const,
    token: 'llm-token',
  }),
} satisfies NativeCompletionApiContext;

const response: ZedPredictEditsV3Response = {
  requestId: 'request-id',
  output: 'output',
  editableRange: { start: 0, end: 1 },
};

beforeEach(() => {
  state.createClient.mockReset();
  state.createTokenSource.mockReset();
  state.predictV3.mockReset();
  state.accept.mockReset();
  state.accept.mockResolvedValue(undefined);
  state.tokens.cached.mockReset();
  state.tokens.refresh.mockReset();
});

describe('Zed Completion session port phased cancellation', () => {
  it('scopes the prediction backoff key to provider identity and organization', async () => {
    await expect(
      getZedCompletionSessionPort().getPolicySnapshot(
        context,
        controlledToken(),
      ),
    ).resolves.toEqual({
      dataCollectionEnabled: false,
      dataCollectionAllowed: true,
      backoffKey: `${createZedProviderIdentity(context.provider).key}:org-a`,
    });
  });

  it('uses auth data persisted while resolving the credential', async () => {
    const updatedProvider = {
      ...context.provider,
      auth: {
        ...context.provider.auth,
        method: 'zed' as const,
        organizationId: 'org-b',
        dataCollection: true,
        dataCollectionAllowed: false,
      },
    };

    await expect(
      getZedCompletionSessionPort().getPolicySnapshot(
        {
          ...context,
          resolveProvider: () => updatedProvider,
        },
        controlledToken(),
      ),
    ).resolves.toEqual({
      dataCollectionEnabled: false,
      dataCollectionAllowed: false,
      backoffKey: `${createZedProviderIdentity(updatedProvider).key}:org-b`,
    });
    expect(state.createClient).toHaveBeenCalledWith(updatedProvider);
  });

  it('does not abort after dispatch and reports cancellation after request ID', async () => {
    const pending = deferred<ZedPredictEditsV3Response>();
    const dispatched = deferred<void>();
    let options: ZedPredictEditsRequestOptions | undefined;
    state.predictV3.mockImplementation(
      async (
        _session: unknown,
        _body: unknown,
        requestOptions: ZedPredictEditsRequestOptions,
      ) => {
        options = requestOptions;
        requestOptions.onRequestDispatched?.();
        dispatched.resolve();
        return await pending.promise;
      },
    );
    const token = controlledToken();
    const resultPromise = getZedCompletionSessionPort().predictV3(
      context,
      {},
      { trigger: 'buffer_edit' },
      token,
    );
    await dispatched.promise;
    token.cancel();
    expect(options?.signal?.aborted).toBe(false);
    pending.resolve(response);

    await expect(resultPromise).resolves.toMatchObject({
      response,
      canceledAfterDispatch: true,
    });
  });

  it('aborts the prediction signal when cancelled before dispatch', async () => {
    state.predictV3.mockImplementation(
      async (
        _session: unknown,
        _body: unknown,
        options: ZedPredictEditsRequestOptions,
      ) => {
        return response;
      },
    );
    const token = controlledToken();
    token.cancel();
    await expect(
      getZedCompletionSessionPort().predictV3(
        context,
        {},
        { trigger: 'buffer_edit' },
        token,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(state.predictV3).not.toHaveBeenCalled();
  });

  it('stops after an in-flight credential lookup is cancelled', async () => {
    const credential = deferred<AuthTokenInfo>();
    const token = controlledToken();
    const result = getZedCompletionSessionPort().predictV3(
      {
        ...context,
        resolveCredential: () => credential.promise,
      },
      {},
      { trigger: 'buffer_edit' },
      token,
    );

    token.cancel();
    credential.resolve({ kind: 'none' });

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(state.createClient).not.toHaveBeenCalled();
    expect(state.createTokenSource).not.toHaveBeenCalled();
    expect(state.predictV3).not.toHaveBeenCalled();
  });

  it('keeps delayed feedback bound to the token source used for prediction', async () => {
    state.predictV3.mockResolvedValue(response);
    const result = await getZedCompletionSessionPort().predictV3(
      context,
      {},
      { trigger: 'buffer_edit' },
      controlledToken(),
    );

    await result.feedback.accept({ request_id: 'request-id' });

    expect(state.accept).toHaveBeenCalledWith(
      state.tokens,
      { request_id: 'request-id' },
      undefined,
    );
  });
});
