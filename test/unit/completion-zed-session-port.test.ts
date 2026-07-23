import type * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ZedPredictEditsRequestOptions,
  ZedPredictEditsV3Response,
} from '../../src/client/zed/types';
import type { AuthTokenInfo } from '../../src/auth/types';

const BINDING_ID = '00000000-0000-4000-8000-000000000101';
const SESSION_ID = '00000000-0000-4000-8000-000000000102';

function zedContext(
  organizationId: string,
  options: { dataCollection?: boolean; dataCollectionAllowed?: boolean } = {},
) {
  return {
    method: 'zed' as const,
    bindingId: BINDING_ID,
    sessionId: SESSION_ID,
    revision: 1,
    organizationId,
    dataCollection: options.dataCollection === true,
    dataCollectionAllowed: options.dataCollectionAllowed !== false,
  };
}

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
  assertZedProviderAuth: (
    provider: { auth?: { method?: string } },
    credential: AuthTokenInfo,
  ) => {
    const authContext =
      credential.kind === 'token' ? credential.authContext : undefined;
    if (provider.auth?.method !== 'zed' || authContext?.method !== 'zed') {
      throw new Error('Zed authentication is required.');
    }
    return authContext.organizationId;
  },
  requireZedAuthContext: (
    _provider: unknown,
    credential: AuthTokenInfo,
  ) =>
    credential.kind === 'token' && credential.authContext?.method === 'zed'
      ? credential.authContext
      : (() => {
          throw new Error('Zed authentication is required.');
        })(),
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
  createZedLlmTokenSource: (
    credential: AuthTokenInfo,
    refreshCredential: unknown,
  ) => {
    state.createTokenSource(credential, refreshCredential);
    return state.tokens;
  },
}));

import { getZedCompletionSessionPort } from '../../src/completion/zed/session-port';
import type { NativeCompletionApiContext } from '../../src/completion/api/provider';
import type { ProviderConfig } from '../../src/types';

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
      bindingId: BINDING_ID,
      baseUrl: 'https://zed.dev',
    },
  },
  model: { id: 'zeta-cloud' },
  completion: { transport: 'native', templates: ['zeta2.1'] },
  resolveCredential: async () => ({
    kind: 'token' as const,
    token: 'llm-token',
    authContext: zedContext('org-a'),
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
    const session = await getZedCompletionSessionPort().openSession(
      context,
      controlledToken(),
    );
    expect(session.policy).toEqual({
      dataCollectionEnabled: false,
      dataCollectionAllowed: true,
      backoffKey: `${BINDING_ID}:${SESSION_ID}:org-a`,
    });
  });

  it('uses auth data persisted while resolving the credential', async () => {
    const updatedProvider = { ...context.provider };

    const session = await getZedCompletionSessionPort().openSession(
      {
        ...context,
        resolveProvider: () => updatedProvider,
        resolveCredential: async () => ({
          kind: 'token',
          token: 'llm-token-b',
          authContext: zedContext('org-b', {
            dataCollection: true,
            dataCollectionAllowed: false,
          }),
        }),
      },
      controlledToken(),
    );
    expect(session.policy).toEqual({
      dataCollectionEnabled: false,
      dataCollectionAllowed: false,
      backoffKey: `${BINDING_ID}:${SESSION_ID}:org-b`,
    });
    expect(state.createClient).toHaveBeenCalledWith(updatedProvider);
  });

  it('keeps the original Zed target when unrelated provider fields change', async () => {
    const updatedProvider = {
      ...context.provider,
      models: [{ id: 'unrelated-model' }],
      autoFetchOfficialModels: true,
      extraBody: { arrivedFromSync: true },
    };
    let currentProvider: ProviderConfig = context.provider;

    await getZedCompletionSessionPort().openSession(
      {
        ...context,
        resolveProvider: () => currentProvider,
        resolveCredential: async () => {
          currentProvider = updatedProvider;
          return {
            kind: 'token',
            token: 'llm-token-b',
            authContext: zedContext('org-b'),
          };
        },
      },
      controlledToken(),
    );

    expect(state.createClient).toHaveBeenCalledWith(context.provider);
    expect(state.createClient).not.toHaveBeenCalledWith(updatedProvider);
  });

  it('rejects when the provider target changes during credential lookup', async () => {
    const updatedProvider = {
      ...context.provider,
      baseUrl: 'https://zed-alt.example.test',
      auth: {
        ...context.provider.auth,
        baseUrl: 'https://zed-alt.example.test',
      },
    };
    let currentProvider = context.provider;
    const resolveCredential = vi.fn(async () => {
      currentProvider = updatedProvider;
      return {
        kind: 'token' as const,
        token: 'llm-token-b',
        authContext: zedContext('org-b'),
      };
    });

    await expect(
      getZedCompletionSessionPort().openSession(
        {
          ...context,
          resolveProvider: () => currentProvider,
          resolveCredential,
        },
        controlledToken(),
      ),
    ).rejects.toThrow(
      'Authentication configuration changed while the Zed completion request was starting. Please retry.',
    );

    expect(resolveCredential).toHaveBeenCalledTimes(1);
    expect(state.createClient).not.toHaveBeenCalled();
    expect(state.createTokenSource).not.toHaveBeenCalled();
  });

  it('rejects a delayed token refresh after the provider target changes', async () => {
    let currentProvider = context.provider;
    const refreshCredential = vi.fn(async () => ({
      kind: 'token' as const,
      token: 'refreshed-token',
      authContext: zedContext('org-a'),
    }));
    await getZedCompletionSessionPort().openSession(
      {
        ...context,
        resolveProvider: () => currentProvider,
        refreshCredential,
      },
      controlledToken(),
    );
    const guardedRefresh: unknown =
      state.createTokenSource.mock.calls[0]?.[1];
    if (typeof guardedRefresh !== 'function') {
      throw new Error('Expected a guarded Zed token refresh callback.');
    }

    currentProvider = {
      ...context.provider,
      baseUrl: 'https://zed-alt.example.test',
    };

    await expect(guardedRefresh()).rejects.toThrow(
      'Zed authentication configuration changed during the request.',
    );
    expect(refreshCredential).not.toHaveBeenCalled();
  });

  it('uses one immutable credential, policy, client, and header snapshot', async () => {
    state.predictV3.mockResolvedValue(response);
    const firstAuthContext = zedContext('org-a', { dataCollection: true });
    const firstCredential: AuthTokenInfo = {
      kind: 'token',
      token: 'llm-token-a',
      authContext: firstAuthContext,
    };
    const secondCredential: AuthTokenInfo = {
      kind: 'token',
      token: 'llm-token-b',
      authContext: zedContext('org-b'),
    };
    const resolveCredential = vi
      .fn<() => Promise<AuthTokenInfo>>()
      .mockResolvedValueOnce(firstCredential)
      .mockResolvedValue(secondCredential);
    const refreshCredential = vi.fn(async () => firstCredential);
    const modelHeaders = { 'X-Model-Snapshot': 'first' };
    const session = await getZedCompletionSessionPort().openSession(
      {
        ...context,
        model: { ...context.model, extraHeaders: modelHeaders },
        resolveCredential,
        refreshCredential,
      },
      controlledToken(),
    );

    modelHeaders['X-Model-Snapshot'] = 'second';
    firstAuthContext.organizationId = 'org-mutated';
    await session.predictV3(
      {},
      { trigger: 'buffer_edit' },
      controlledToken(),
    );

    expect(session.policy).toEqual({
      dataCollectionEnabled: true,
      dataCollectionAllowed: true,
      backoffKey: `${BINDING_ID}:${SESSION_ID}:org-a`,
    });
    expect(resolveCredential).toHaveBeenCalledTimes(1);
    expect(state.createClient).toHaveBeenCalledTimes(1);
    expect(state.createTokenSource).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'token',
        token: 'llm-token-a',
        authContext: expect.objectContaining({ organizationId: 'org-a' }),
      }),
      expect.any(Function),
    );
    const guardedRefresh: unknown =
      state.createTokenSource.mock.calls[0]?.[1];
    if (typeof guardedRefresh !== 'function') {
      throw new Error('Expected a guarded Zed token refresh callback.');
    }
    await expect(guardedRefresh()).resolves.toBe(firstCredential);
    expect(refreshCredential).toHaveBeenCalledTimes(1);
    expect(state.predictV3).toHaveBeenCalledWith(
      state.tokens,
      {},
      expect.objectContaining({
        extraHeaders: { 'X-Model-Snapshot': 'first' },
      }),
    );
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
    const session = await getZedCompletionSessionPort().openSession(
      context,
      token,
    );
    const resultPromise = session.predictV3(
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
    const session = await getZedCompletionSessionPort().openSession(
      context,
      controlledToken(),
    );
    const token = controlledToken();
    token.cancel();
    await expect(
      session.predictV3(
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
    const result = getZedCompletionSessionPort().openSession(
      {
        ...context,
        resolveCredential: () => credential.promise,
      },
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
    const session = await getZedCompletionSessionPort().openSession(
      context,
      controlledToken(),
    );
    const result = await session.predictV3(
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
