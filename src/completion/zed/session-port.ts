import type * as vscode from 'vscode';
import type { AuthTokenInfo } from '../../auth/types';
import type { NativeCompletionApiContext } from '../api/provider';
import type {
  ZedAcceptEditPredictionBody,
  ZedPredictEditsRequestOptions,
  ZedPredictEditsV3Response,
  ZedPredictEditsV4Response,
  ZedRejectEditPredictionsBody,
  ZedSubmitSettledBatchBody,
} from '../../client/zed/types';
import type { ZedDataCollectionPolicy } from './privacy';
import {
  createZedCloudClient,
  createZedLlmTokenSource,
  requireZedAuthContext,
} from '../../client/zed/runtime';
import type { ProviderConfig } from '../../types';
import { resolveZedBaseUrls } from '../../client/zed/urls';
import { computeCompletionRequestTargetSignature } from '../provider-target';

export interface ZedFeedbackTransport {
  accept(body: ZedAcceptEditPredictionBody): Promise<void>;
  reject(body: ZedRejectEditPredictionsBody): Promise<void>;
  settled(body: ZedSubmitSettledBatchBody): Promise<void>;
}

export interface ZedPredictionTransportResult<T> {
  readonly response: T;
  readonly feedback: ZedFeedbackTransport;
  readonly canceledAfterDispatch: boolean;
}

export interface ZedCompletionPolicySnapshot
  extends ZedDataCollectionPolicy {
  readonly backoffKey: string;
}

export interface ZedCompletionRequestSession {
  readonly policy: ZedCompletionPolicySnapshot;
  predictV3(
    body: Record<string, unknown>,
    options: ZedPredictEditsRequestOptions,
    token: vscode.CancellationToken,
  ): Promise<ZedPredictionTransportResult<ZedPredictEditsV3Response>>;
  predictV4(
    body: Record<string, unknown>,
    options: ZedPredictEditsRequestOptions,
    token: vscode.CancellationToken,
  ): Promise<ZedPredictionTransportResult<ZedPredictEditsV4Response>>;
}

export interface ZedCompletionSessionPort {
  openSession(
    context: NativeCompletionApiContext,
    token: vscode.CancellationToken,
  ): Promise<ZedCompletionRequestSession>;
}

function phasedCancellation(token: vscode.CancellationToken): {
  readonly signal: AbortSignal;
  readonly markDispatched: () => void;
  readonly wasCanceledAfterDispatch: () => boolean;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  let dispatched = false;
  let canceledAfterDispatch = false;
  const cancel = (): void => {
    if (dispatched) {
      canceledAfterDispatch = true;
    } else {
      controller.abort();
    }
  };
  const subscription = token.onCancellationRequested(cancel);
  if (token.isCancellationRequested) controller.abort();
  return {
    signal: controller.signal,
    markDispatched: () => {
      dispatched = true;
    },
    wasCanceledAfterDispatch: () => canceledAfterDispatch,
    dispose: () => subscription.dispose(),
  };
}

function throwIfCanceled(
  token: vscode.CancellationToken,
  signal: AbortSignal,
): void {
  if (!token.isCancellationRequested && !signal.aborted) return;
  const error = new Error('The Zed completion request was canceled.');
  error.name = 'AbortError';
  throw error;
}

function providerSnapshotSignature(provider: ProviderConfig): string {
  return computeCompletionRequestTargetSignature(provider, {
    requestTarget: resolveZedBaseUrls(provider.baseUrl).cloud,
    includeCompletionBaseUrls: false,
  });
}

async function resolveProviderCredentialSnapshot(
  context: NativeCompletionApiContext,
  token: vscode.CancellationToken,
  signal: AbortSignal,
): Promise<{ provider: ProviderConfig; credential: AuthTokenInfo }> {
  const expectedSignature = providerSnapshotSignature(context.provider);
  throwIfCanceled(token, signal);
  const before = context.resolveProvider?.() ?? context.provider;
  if (providerSnapshotSignature(before) !== expectedSignature) {
    throw new Error(
      'Authentication configuration changed while the Zed completion request was starting. Please retry.',
    );
  }
  const credential = await context.resolveCredential();
  throwIfCanceled(token, signal);
  const after = context.resolveProvider?.() ?? context.provider;
  if (providerSnapshotSignature(after) !== expectedSignature) {
    throw new Error(
      'Authentication configuration changed while the Zed completion request was starting. Please retry.',
    );
  }
  return { provider: context.provider, credential };
}

function createSnapshotRefresh(
  context: NativeCompletionApiContext,
  provider: ProviderConfig,
): (() => Promise<AuthTokenInfo>) | undefined {
  const refreshCredential = context.refreshCredential;
  if (!refreshCredential) return undefined;
  const expectedSignature = providerSnapshotSignature(provider);
  return async () => {
    const before = context.resolveProvider?.() ?? context.provider;
    if (providerSnapshotSignature(before) !== expectedSignature) {
      throw new Error(
        'Zed authentication configuration changed during the request.',
      );
    }
    const credential = await refreshCredential();
    const after = context.resolveProvider?.() ?? context.provider;
    if (providerSnapshotSignature(after) !== expectedSignature) {
      throw new Error(
        'Zed authentication configuration changed during the request.',
      );
    }
    return credential;
  };
}

async function resolveTransport(
  context: NativeCompletionApiContext,
  token: vscode.CancellationToken,
  signal: AbortSignal,
) {
  const snapshot = await resolveProviderCredentialSnapshot(
    context,
    token,
    signal,
  );
  const resolvedCredential = snapshot.credential;
  const resolvedProvider = snapshot.provider;
  const provider = Object.freeze({
    ...resolvedProvider,
    ...(resolvedProvider.extraHeaders === undefined
      ? {}
      : { extraHeaders: { ...resolvedProvider.extraHeaders } }),
  });
  if (resolvedCredential.kind !== 'token') {
    throw new Error('Zed authentication is required.');
  }
  const authContext = Object.freeze({
    ...requireZedAuthContext(provider, resolvedCredential),
  });
  const credential = Object.freeze({
    ...resolvedCredential,
    authContext,
  });
  const organizationId = authContext.organizationId;
  const tokens = createZedLlmTokenSource(
    credential,
    createSnapshotRefresh(context, provider),
  );
  throwIfCanceled(token, signal);
  const client = createZedCloudClient(provider);
  return { client, tokens, organizationId, authContext };
}

const defaultPort: ZedCompletionSessionPort = {
  async openSession(context, token) {
    const opening = phasedCancellation(token);
    try {
      const resolved = await resolveTransport(
        context,
        token,
        opening.signal,
      );
      throwIfCanceled(token, opening.signal);
      const modelHeaders =
        context.model.extraHeaders === undefined
          ? undefined
          : { ...context.model.extraHeaders };
      const feedback: ZedFeedbackTransport = {
        accept: (body) =>
          resolved.client.accept(resolved.tokens, body, modelHeaders),
        reject: (body) =>
          resolved.client.reject(resolved.tokens, body, modelHeaders),
        settled: (body) =>
          resolved.client.settled(resolved.tokens, body, modelHeaders),
      };
      const dataCollectionAllowed =
        resolved.authContext.dataCollectionAllowed === true;
      const policy: ZedCompletionPolicySnapshot = Object.freeze({
        dataCollectionEnabled:
          resolved.authContext.dataCollection === true &&
          dataCollectionAllowed,
        dataCollectionAllowed,
        backoffKey: `${resolved.authContext.bindingId}:${resolved.authContext.sessionId}:${resolved.organizationId}`,
      });
      const session: ZedCompletionRequestSession = {
        policy,
        async predictV3(body, options, predictionToken) {
          const cancellation = phasedCancellation(predictionToken);
          try {
            throwIfCanceled(predictionToken, cancellation.signal);
            const response = await resolved.client.predictEditsV3(
              resolved.tokens,
              body,
              {
                ...options,
                signal: cancellation.signal,
                extraHeaders: modelHeaders,
                onRequestDispatched: () => {
                  cancellation.markDispatched();
                  options.onRequestDispatched?.();
                },
              },
            );
            return {
              response,
              feedback,
              canceledAfterDispatch: cancellation.wasCanceledAfterDispatch(),
            };
          } finally {
            cancellation.dispose();
          }
        },
        async predictV4(body, options, predictionToken) {
          const cancellation = phasedCancellation(predictionToken);
          try {
            throwIfCanceled(predictionToken, cancellation.signal);
            const response = await resolved.client.predictEditsV4(
              resolved.tokens,
              body,
              {
                ...options,
                signal: cancellation.signal,
                extraHeaders: modelHeaders,
                onRequestDispatched: () => {
                  cancellation.markDispatched();
                  options.onRequestDispatched?.();
                },
              },
            );
            return {
              response,
              feedback,
              canceledAfterDispatch: cancellation.wasCanceledAfterDispatch(),
            };
          } finally {
            cancellation.dispose();
          }
        },
      };
      return Object.freeze(session);
    } finally {
      opening.dispose();
    }
  },
};

let configuredPort: ZedCompletionSessionPort = defaultPort;

export function configureZedCompletionSessionPort(
  port: ZedCompletionSessionPort,
): vscode.Disposable {
  const previous = configuredPort;
  configuredPort = port;
  return { dispose: () => (configuredPort = previous) };
}

export function getZedCompletionSessionPort(): ZedCompletionSessionPort {
  return configuredPort;
}
