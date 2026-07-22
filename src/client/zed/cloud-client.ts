import { randomUUID } from 'node:crypto';
import { constants, zstdCompressSync } from 'node:zlib';
import {
  parseJsonLine,
  parseZedAuthenticatedUser,
  parseZedModelDiscovery,
  parseZedPredictEditsV3Response,
  parseZedPredictEditsV4Response,
} from './codecs';
import type {
  ZedAcceptEditPredictionBody,
  ZedAuthenticatedUser,
  ZedCompletionBody,
  ZedFetch,
  ZedLongLivedCredential,
  ZedModelDiscoveryResult,
  ZedPredictEditsRequestOptions,
  ZedPredictEditsV3Response,
  ZedPredictEditsV4Response,
  ZedRejectEditPredictionsBody,
  ZedSubmitSettledBatchBody,
} from './types';
import { ZED_CLOUD_CLIENT_VERSION } from './types';
import { buildZedUrl, resolveZedBaseUrls } from './urls';

const EXPIRED_TOKEN_HEADER = 'x-zed-expired-token';
const OUTDATED_TOKEN_HEADER = 'x-zed-outdated-token';
const MINIMUM_VERSION_HEADER = 'x-zed-minimum-required-version';

export class ZedCloudError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly responseBody?: string,
  ) {
    super(message);
    this.name = 'ZedCloudError';
  }
}

export interface ZedLlmTokenSource {
  cached(signal?: AbortSignal): Promise<string>;
  refresh(signal?: AbortSignal): Promise<string>;
}

export interface ZedCompletionStreamResponse {
  response: Response;
  includesStatusMessages: boolean;
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] =>
    value
      .split('.')
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0));
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function assertProtocolVersion(response: Response): void {
  const minimum = response.headers.get(MINIMUM_VERSION_HEADER)?.trim();
  if (
    minimum &&
    compareVersions(minimum, ZED_CLOUD_CLIENT_VERSION) > 0
  ) {
    throw new ZedCloudError(
      `Zed Cloud requires protocol version ${minimum}, but this extension implements ${ZED_CLOUD_CLIENT_VERSION}.`,
      response.status,
    );
  }
}

function needsTokenRefresh(response: Response): boolean {
  return (
    response.status === 401 ||
    response.headers.has(EXPIRED_TOKEN_HEADER) ||
    response.headers.has(OUTDATED_TOKEN_HEADER)
  );
}

async function responseError(response: Response, context: string): Promise<never> {
  const body = await response.text();
  let detail = body;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const message = (parsed as Record<string, unknown>)['message'];
      if (typeof message === 'string' && message.trim()) detail = message;
    }
  } catch {
    // Preserve the original body when it is not JSON.
  }
  throw new ZedCloudError(
    `${context} failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
    response.status,
    body,
  );
}

async function readJsonResponse(
  response: Response,
  context: string,
): Promise<unknown> {
  assertProtocolVersion(response);
  if (!response.ok) return responseError(response, context);
  const body = await response.text();
  if (!body.trim()) return null;
  return parseJsonLine(body, `${context} response`);
}

function accountHeaders(
  credential: ZedLongLivedCredential,
  systemId?: string,
): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: `${credential.userId} ${credential.accessToken}`,
    ...(systemId ? { 'x-zed-system-id': systemId } : {}),
  };
}

function llmHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

function mergeRequestHeaders(
  providerHeaders: Record<string, string> | undefined,
  modelHeaders: Record<string, string> | undefined,
  requiredHeaders: Record<string, string>,
): Record<string, string> {
  const headers = new Headers(providerHeaders);
  for (const [name, value] of Object.entries(modelHeaders ?? {})) {
    headers.set(name, value);
  }
  for (const [name, value] of Object.entries(requiredHeaders)) {
    headers.set(name, value);
  }
  return Object.fromEntries(headers.entries());
}

export class ZedCloudClient {
  private readonly cloudBaseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetcher: ZedFetch = fetch,
    private readonly providerHeaders?: Record<string, string>,
  ) {
    this.cloudBaseUrl = resolveZedBaseUrls(baseUrl).cloud;
  }

  async getAuthenticatedUser(
    credential: ZedLongLivedCredential,
    systemId?: string,
    signal?: AbortSignal,
  ): Promise<ZedAuthenticatedUser> {
    const response = await this.fetcher(
      buildZedUrl(this.cloudBaseUrl, '/client/users/me'),
      {
        method: 'GET',
        signal,
        headers: mergeRequestHeaders(
          this.providerHeaders,
          undefined,
          accountHeaders(credential, systemId),
        ),
      },
    );
    return parseZedAuthenticatedUser(
      await readJsonResponse(response, 'Zed account lookup'),
    );
  }

  async createLlmToken(
    credential: ZedLongLivedCredential,
    organizationId: string,
    systemId?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await this.fetcher(
      buildZedUrl(this.cloudBaseUrl, '/client/llm_tokens'),
      {
        method: 'POST',
        signal,
        headers: mergeRequestHeaders(this.providerHeaders, undefined, {
          ...accountHeaders(credential, systemId),
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ organization_id: organizationId }),
      },
    );
    const raw = await readJsonResponse(response, 'Zed LLM token request');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ZedCloudError('Invalid Zed LLM token response.');
    }
    const token = (raw as Record<string, unknown>)['token'];
    if (typeof token !== 'string' || !token.trim()) {
      throw new ZedCloudError('Invalid Zed LLM token response.');
    }
    return token;
  }

  async updateSystemSettings(
    credential: ZedLongLivedCredential,
    organizationId: string,
    systemId: string,
  ): Promise<void> {
    const response = await this.fetcher(
      buildZedUrl(this.cloudBaseUrl, '/client/system_settings'),
      {
        method: 'PATCH',
        headers: mergeRequestHeaders(this.providerHeaders, undefined, {
          ...accountHeaders(credential, systemId),
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ selected_organization_id: organizationId }),
      },
    );
    await readJsonResponse(response, 'Zed organization selection');
  }

  private async authenticatedLlmRequest(
    tokens: ZedLlmTokenSource,
    build: (token: string) => Promise<Response>,
    signal?: AbortSignal,
  ): Promise<Response> {
    let response = await build(await tokens.cached(signal));
    assertProtocolVersion(response);
    if (!needsTokenRefresh(response)) return response;
    response.body?.cancel().catch(() => {});
    response = await build(await tokens.refresh(signal));
    assertProtocolVersion(response);
    return response;
  }

  async listModels(
    tokens: ZedLlmTokenSource,
    organizationId: string,
    options?: {
      signal?: AbortSignal;
      onUnknownProvider?: (modelId: string, provider: unknown) => void;
    },
  ): Promise<ZedModelDiscoveryResult> {
    const url = buildZedUrl(this.cloudBaseUrl, '/models');
    const response = await this.authenticatedLlmRequest(tokens, async (token) =>
      this.fetcher(url, {
        method: 'GET',
        signal: options?.signal,
        headers: mergeRequestHeaders(this.providerHeaders, undefined, {
          ...llmHeaders(token),
          'x-zed-client-supports-x-ai': 'true',
        }),
      }),
      options?.signal,
    );
    return parseZedModelDiscovery(
      await readJsonResponse(response, 'Zed model discovery'),
      organizationId,
      options?.onUnknownProvider,
    );
  }

  async complete(
    tokens: ZedLlmTokenSource,
    body: ZedCompletionBody,
    signal?: AbortSignal,
    modelHeaders?: Record<string, string>,
  ): Promise<ZedCompletionStreamResponse> {
    const url = buildZedUrl(this.cloudBaseUrl, '/completions');
    const response = await this.authenticatedLlmRequest(tokens, async (token) =>
      this.fetcher(url, {
        method: 'POST',
        signal,
        headers: mergeRequestHeaders(this.providerHeaders, modelHeaders, {
          ...llmHeaders(token),
          'Content-Type': 'application/json',
          'x-zed-version': ZED_CLOUD_CLIENT_VERSION,
          'x-zed-client-supports-status-messages': 'true',
          'x-zed-client-supports-stream-ended-request-completion-status': 'true',
        }),
        body: JSON.stringify(body),
      }),
      signal,
    );
    if (!response.ok) return responseError(response, 'Zed completion');
    return {
      includesStatusMessages: response.headers.has(
        'x-zed-server-supports-status-messages',
      ),
      response,
    };
  }

  private async predictEdits<T>(
    path: '/predict_edits/v3' | '/predict_edits/v4',
    tokens: ZedLlmTokenSource,
    body: Record<string, unknown>,
    options: ZedPredictEditsRequestOptions,
    parse: (raw: unknown) => T,
  ): Promise<T> {
    const compressed = zstdCompressSync(Buffer.from(JSON.stringify(body)), {
      params: { [constants.ZSTD_c_compressionLevel]: 3 },
    });
    const requestId = options.requestId ?? randomUUID();
    const url = buildZedUrl(this.cloudBaseUrl, path);
    let dispatched = false;
    const response = await this.authenticatedLlmRequest(tokens, async (token) =>
      {
        const headers = mergeRequestHeaders(
          this.providerHeaders,
          options.extraHeaders,
          {
            ...llmHeaders(token),
            'Content-Type': 'application/json',
            'Content-Encoding': 'zstd',
            'x-zed-version': ZED_CLOUD_CLIENT_VERSION,
            'X-Zed-Predict-Edits-Mode': 'eager',
            'X-Zed-Predict-Edits-Request-Id': requestId,
            'X-Zed-Predict-Edits-Trigger': options.trigger,
            ...(options.preferredExperiment
              ? {
                  'x-zed-preferred-experiment': options.preferredExperiment,
                }
              : {}),
          },
        );
        options.onRequestPrepared?.({
          endpoint: url,
          method: 'POST',
          headers,
          body,
          requestId,
        });
        if (!dispatched) {
          dispatched = true;
          options.onRequestDispatched?.();
        }
        return this.fetcher(url, {
          method: 'POST',
          signal: options.signal,
          headers,
          body: compressed,
        });
      },
      options.signal,
    );
    return parse(await readJsonResponse(response, `Zed ${path}`));
  }

  predictEditsV3(
    tokens: ZedLlmTokenSource,
    body: Record<string, unknown>,
    options: ZedPredictEditsRequestOptions,
  ): Promise<ZedPredictEditsV3Response> {
    return this.predictEdits(
      '/predict_edits/v3',
      tokens,
      body,
      options,
      parseZedPredictEditsV3Response,
    );
  }

  predictEditsV4(
    tokens: ZedLlmTokenSource,
    body: Record<string, unknown>,
    options: ZedPredictEditsRequestOptions,
  ): Promise<ZedPredictEditsV4Response> {
    return this.predictEdits(
      '/predict_edits/v4',
      tokens,
      body,
      options,
      parseZedPredictEditsV4Response,
    );
  }

  private async sendFeedback(
    path: '/predict_edits/accept' | '/predict_edits/reject',
    tokens: ZedLlmTokenSource,
    body: ZedAcceptEditPredictionBody | ZedRejectEditPredictionsBody,
    modelHeaders?: Record<string, string>,
  ): Promise<void> {
    const response = await this.authenticatedLlmRequest(tokens, async (token) =>
      this.fetcher(buildZedUrl(this.cloudBaseUrl, path), {
        method: 'POST',
        headers: mergeRequestHeaders(this.providerHeaders, modelHeaders, {
          ...llmHeaders(token),
          'Content-Type': 'application/json',
          'x-zed-version': ZED_CLOUD_CLIENT_VERSION,
        }),
        body: JSON.stringify(body),
      }),
    );
    if (!response.ok) await responseError(response, `Zed ${path}`);
    response.body?.cancel().catch(() => {});
  }

  accept(
    tokens: ZedLlmTokenSource,
    body: ZedAcceptEditPredictionBody,
    modelHeaders?: Record<string, string>,
  ): Promise<void> {
    return this.sendFeedback(
      '/predict_edits/accept',
      tokens,
      body,
      modelHeaders,
    );
  }

  reject(
    tokens: ZedLlmTokenSource,
    body: ZedRejectEditPredictionsBody,
    modelHeaders?: Record<string, string>,
  ): Promise<void> {
    return this.sendFeedback(
      '/predict_edits/reject',
      tokens,
      body,
      modelHeaders,
    );
  }

  async settled(
    tokens: ZedLlmTokenSource,
    body: ZedSubmitSettledBatchBody,
    modelHeaders?: Record<string, string>,
  ): Promise<void> {
    const compressed = zstdCompressSync(Buffer.from(JSON.stringify(body)), {
      params: { [constants.ZSTD_c_compressionLevel]: 3 },
    });
    const response = await this.authenticatedLlmRequest(tokens, async (token) =>
      this.fetcher(buildZedUrl(this.cloudBaseUrl, '/predict_edits/settled'), {
        method: 'POST',
        headers: mergeRequestHeaders(this.providerHeaders, modelHeaders, {
          ...llmHeaders(token),
          'Content-Type': 'application/json',
          'Content-Encoding': 'zstd',
          'x-zed-version': ZED_CLOUD_CLIENT_VERSION,
        }),
        body: compressed,
      }),
    );
    if (!response.ok) await responseError(response, 'Zed settled feedback');
    response.body?.cancel().catch(() => {});
  }
}
