import type * as vscode from 'vscode';
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
  assertZedProviderAuth,
  createZedCloudClient,
  createZedLlmTokenSource,
} from '../../client/zed/runtime';
import { createZedProviderIdentity } from '../../client/zed/urls';

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

export interface ZedCompletionSessionPort {
  getPolicySnapshot(
    context: NativeCompletionApiContext,
    token: vscode.CancellationToken,
  ): Promise<ZedCompletionPolicySnapshot>;
  predictV3(
    context: NativeCompletionApiContext,
    body: Record<string, unknown>,
    options: ZedPredictEditsRequestOptions,
    token: vscode.CancellationToken,
  ): Promise<ZedPredictionTransportResult<ZedPredictEditsV3Response>>;
  predictV4(
    context: NativeCompletionApiContext,
    body: Record<string, unknown>,
    options: ZedPredictEditsRequestOptions,
    token: vscode.CancellationToken,
  ): Promise<ZedPredictionTransportResult<ZedPredictEditsV4Response>>;
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

async function resolveTransport(
  context: NativeCompletionApiContext,
  token: vscode.CancellationToken,
  signal: AbortSignal,
) {
  throwIfCanceled(token, signal);
  const credential = await context.resolveCredential();
  throwIfCanceled(token, signal);
  const provider = context.resolveProvider?.() ?? context.provider;
  const organizationId = assertZedProviderAuth(provider);
  const tokens = createZedLlmTokenSource(
    credential,
    context.refreshCredential,
  );
  throwIfCanceled(token, signal);
  const client = createZedCloudClient(provider);
  return { client, tokens, organizationId, provider };
}

async function resolvePredictionSession(
  context: NativeCompletionApiContext,
  token: vscode.CancellationToken,
  signal: AbortSignal,
) {
  const resolved = await resolveTransport(context, token, signal);
  throwIfCanceled(token, signal);
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
  return { ...resolved, feedback };
}

const defaultPort: ZedCompletionSessionPort = {
  async getPolicySnapshot(context, token) {
    const cancellation = phasedCancellation(token);
    try {
      const resolved = await resolveTransport(
        context,
        token,
        cancellation.signal,
      );
      throwIfCanceled(token, cancellation.signal);
      const auth = resolved.provider.auth;
      const dataCollectionAllowed =
        auth?.method === 'zed' && auth.dataCollectionAllowed === true;
      return {
        dataCollectionEnabled:
          auth?.method === 'zed' &&
          auth.dataCollection === true &&
          dataCollectionAllowed,
        dataCollectionAllowed,
        backoffKey: `${createZedProviderIdentity(resolved.provider).key}:${resolved.organizationId}`,
      };
    } finally {
      cancellation.dispose();
    }
  },
  async predictV3(context, body, options, token) {
    const cancellation = phasedCancellation(token);
    try {
      const resolved = await resolvePredictionSession(
        context,
        token,
        cancellation.signal,
      );
      const response = await resolved.client.predictEditsV3(
        resolved.tokens,
        body,
        {
          ...options,
          signal: cancellation.signal,
          extraHeaders: context.model.extraHeaders,
          onRequestDispatched: () => {
            cancellation.markDispatched();
            options.onRequestDispatched?.();
          },
        },
      );
      return {
        response,
        feedback: resolved.feedback,
        canceledAfterDispatch: cancellation.wasCanceledAfterDispatch(),
      };
    } finally {
      cancellation.dispose();
    }
  },
  async predictV4(context, body, options, token) {
    const cancellation = phasedCancellation(token);
    try {
      const resolved = await resolvePredictionSession(
        context,
        token,
        cancellation.signal,
      );
      const response = await resolved.client.predictEditsV4(
        resolved.tokens,
        body,
        {
          ...options,
          signal: cancellation.signal,
          extraHeaders: context.model.extraHeaders,
          onRequestDispatched: () => {
            cancellation.markDispatched();
            options.onRequestDispatched?.();
          },
        },
      );
      return {
        response,
        feedback: resolved.feedback,
        canceledAfterDispatch: cancellation.wasCanceledAfterDispatch(),
      };
    } finally {
      cancellation.dispose();
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
