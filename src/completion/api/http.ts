import type * as vscode from 'vscode';
import type { AuthTokenInfo } from '../../auth/types';
import {
  createCustomFetch,
  getToken,
  getTokenType,
  mergeHeaders,
} from '../../client/utils';
import type { ModelConfig, ProviderConfig } from '../../types';
import { resolveChatNetwork } from '../../utils';
import {
  CompletionRuntimeError,
  toCompletionRequestError,
  withCompletionRequestErrorBoundary,
} from '../model/errors';
import type { CompletionRequestKind } from '../model/requests';
import {
  createCompletionRequestLogger,
  type CompletionRequestLogger,
} from './logging';
import type { NativeCompletionApiContext } from './provider';

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const normalized = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === normalized);
}

function buildHeaders(
  provider: ProviderConfig,
  model: ModelConfig,
  credential: AuthTokenInfo,
): Record<string, string> {
  const token = getToken(credential);
  const headers = mergeHeaders(
    token,
    provider.extraHeaders,
    model.extraHeaders,
  );
  if (!hasHeader(headers, 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) {
    headers.Authorization = `${getTokenType(credential) ?? 'Bearer'} ${token}`;
  }
  return headers;
}

export async function postCompletionJson(
  url: string,
  body: Record<string, unknown>,
  provider: ProviderConfig,
  model: ModelConfig,
  credential: AuthTokenInfo,
  token: vscode.CancellationToken,
  logger?: CompletionRequestLogger,
): Promise<unknown> {
  const abortController = new AbortController();
  const cancellationSubscription = token.onCancellationRequested(() => {
    abortController.abort();
  });
  if (token.isCancellationRequested) {
    abortController.abort();
  }

  const network = resolveChatNetwork(provider);
  const request = createCustomFetch({
    connectionTimeoutMs: network.timeout.connection,
    responseTimeoutMs: network.timeout.response,
    retryConfig: network.retry,
    proxy: network.proxy,
    type: 'chat',
    abortSignal: abortController.signal,
    logger,
  });

  try {
    const response = await request(url, {
      method: 'POST',
      headers: buildHeaders(provider, model, credential),
      body: JSON.stringify(body),
      signal: abortController.signal,
    });
    let responseBody: string;
    try {
      responseBody = await response.text();
    } catch (error) {
      if (response.ok) {
        throw new CompletionRuntimeError(
          'completion-invalid-response',
          'Completion request returned invalid JSON.',
          error,
        );
      }
      throw error;
    }
    logger?.rawHttpResponseBody(responseBody);
    if (!response.ok) {
      const detail = responseBody.slice(0, 2_000);
      throw new CompletionRuntimeError(
        'completion-http-error',
        `Completion request failed with HTTP ${response.status}${
          detail ? `: ${detail}` : ''
        }`,
      );
    }
    try {
      const payload: unknown = JSON.parse(responseBody);
      return payload;
    } catch (error) {
      throw new CompletionRuntimeError(
        'completion-invalid-response',
        'Completion request returned invalid JSON.',
        error,
      );
    }
  } catch (error) {
    throw toCompletionRequestError(error, token);
  } finally {
    cancellationSubscription.dispose();
  }
}

export async function runNativeCompletionOperation<T>(
  context: NativeCompletionApiContext,
  requestKind: CompletionRequestKind,
  token: vscode.CancellationToken,
  operation: (logger: CompletionRequestLogger | undefined) => Promise<T>,
): Promise<T> {
  const logger = createCompletionRequestLogger({
    transport: 'native',
    requestKind,
    model: `${context.provider.name}/${context.model.id}`,
  });
  try {
    const result = await withCompletionRequestErrorBoundary(token, () =>
      operation(logger),
    );
    if (token.isCancellationRequested) {
      logger?.cancelled();
    } else {
      logger?.complete();
    }
    return result;
  } catch (error) {
    if (token.isCancellationRequested) {
      logger?.cancelled();
    } else {
      logger?.error(error);
    }
    throw error;
  }
}
