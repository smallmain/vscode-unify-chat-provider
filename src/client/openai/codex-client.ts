import OpenAI from 'openai';
import * as vscode from 'vscode';
import type { AuthTokenInfo } from '../../auth/types';
import type { ProviderHttpLogger } from '../../logger';
import {
  DEFAULT_NORMAL_TIMEOUT_CONFIG,
  FetchMode,
  resolveChatNetwork,
  resolveOpenAISdkTimeoutMs,
} from '../../utils';
import type { ModelConfig } from '../../types';
import { createCustomFetch, getToken } from '../utils';
import { OpenAIResponsesProvider } from './responses-client';
import { randomUUID } from 'crypto';
import type {
  ResponseCreateParamsBase,
  ResponsesClientEvent,
} from 'openai/resources/responses/responses';

const CODEX_API_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
const CODEX_CLIENT_VERSION = '0.101.0';
const CODEX_USER_AGENT =
  'codex_cli_rs/0.101.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464';
const CODEX_ORIGINATOR = 'codex_cli_rs';
const CODEX_RESPONSES_WEBSOCKET_BETA = 'responses_websockets=2026-02-06';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isResponsesClientEvent(value: unknown): value is ResponsesClientEvent {
  return isRecord(value) && typeof value['type'] === 'string';
}

function deleteHeaderVariants(
  headers: Record<string, string>,
  name: string,
): void {
  const needle = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === needle) {
      delete headers[key];
    }
  }
}

function resolveCodexWebSocketBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');

  for (const suffix of [
    '/responses/v1',
    '/v1/responses',
    '/responses',
    '/v1',
  ]) {
    if (normalized.endsWith(suffix)) {
      return normalized.slice(0, -suffix.length);
    }
  }

  return normalized;
}

function stripInputItemIdsFromWebSocketPayload(
  payload: ResponsesClientEvent,
): ResponsesClientEvent {
  if (payload.type !== 'response.create') {
    return payload;
  }

  const parsed: unknown = JSON.parse(JSON.stringify(payload));
  if (!isRecord(parsed) || parsed['type'] !== 'response.create') {
    return payload;
  }

  const input = parsed['input'];
  if (!Array.isArray(input)) {
    return payload;
  }

  parsed['input'] = input.map((item) => {
    if (!isRecord(item) || !Object.prototype.hasOwnProperty.call(item, 'id')) {
      return item;
    }

    const { id: _id, ...rest } = item;
    return rest;
  });

  return isResponsesClientEvent(parsed) ? parsed : payload;
}

function sanitizeCodexHeaders(headersInit: HeadersInit | undefined): Headers {
  const headers = new Headers(headersInit);
  const toDelete: string[] = [];

  headers.forEach((_value, key) => {
    const lower = key.toLowerCase();
    if (lower.startsWith('x-stainless-')) {
      toDelete.push(key);
      return;
    }
    if (lower === 'openai-organization' || lower === 'openai-project') {
      toDelete.push(key);
    }
  });

  for (const key of toDelete) {
    headers.delete(key);
  }

  return headers;
}

function readStringHeader(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  return getHeaderValue(headers, name);
}

function setHeaderIfMissing(
  headers: Record<string, string>,
  name: string,
  value: string,
): void {
  if (readStringHeader(headers, name) === undefined) {
    headers[name] = value;
  }
}

export class OpenAICodexProvider extends OpenAIResponsesProvider {
  protected override getInputMessageRole(
    role: vscode.LanguageModelChatMessageRole,
  ) {
    if (role === vscode.LanguageModelChatMessageRole.System) {
      return 'developer';
    }
    return super.getInputMessageRole(role);
  }

  protected override buildHeaders(
    sessionId: string,
    credential?: AuthTokenInfo,
    modelConfig?: ModelConfig,
    _messages?: readonly vscode.LanguageModelChatRequestMessage[],
  ): Record<string, string> {
    const headers = super.buildHeaders(sessionId, credential, modelConfig);

    deleteHeaderVariants(headers, 'accept');
    deleteHeaderVariants(headers, 'connection');
    deleteHeaderVariants(headers, 'user-agent');
    deleteHeaderVariants(headers, 'originator');
    deleteHeaderVariants(headers, 'session_id');
    deleteHeaderVariants(headers, 'conversation_id');
    deleteHeaderVariants(headers, 'version');
    deleteHeaderVariants(headers, 'chatgpt-account-id');

    headers['User-Agent'] = CODEX_USER_AGENT;
    headers['Session_id'] = sessionId;
    headers['Version'] = CODEX_CLIENT_VERSION;
    headers['Connection'] = 'Keep-Alive';

    const auth = this.config.auth;
    if (auth?.method === 'openai-codex') {
      headers['Originator'] = CODEX_ORIGINATOR;

      const accountId = auth.accountId?.trim();
      if (accountId) {
        headers['Chatgpt-Account-Id'] = accountId;
      }
    }

    return headers;
  }

  protected override buildWebSocketHeaders(
    sessionId: string,
    credential?: AuthTokenInfo,
    modelConfig?: ModelConfig,
    messages?: readonly vscode.LanguageModelChatRequestMessage[],
  ): Record<string, string> {
    const headers = this.buildHeaders(
      sessionId,
      credential,
      modelConfig,
      messages,
    );
    setHeaderIfMissing(headers, 'x-codex-beta-features', '');
    setHeaderIfMissing(headers, 'x-codex-turn-state', '');
    setHeaderIfMissing(headers, 'x-codex-turn-metadata', '');
    setHeaderIfMissing(headers, 'x-responsesapi-include-timing-metrics', '');

    const existingBeta = readStringHeader(headers, 'openai-beta');

    deleteHeaderVariants(headers, 'openai-beta');
    headers['OpenAI-Beta'] =
      existingBeta && existingBeta.includes('responses_websockets=')
        ? existingBeta
        : CODEX_RESPONSES_WEBSOCKET_BETA;

    return headers;
  }

  protected generateSessionId(): string {
    return randomUUID();
  }

  protected override resolveWebSocketBaseUrl(client: OpenAI): string {
    return resolveCodexWebSocketBaseUrl(client.baseURL);
  }

  protected override transformWebSocketRequestPayload(
    payload: ResponsesClientEvent,
  ): ResponsesClientEvent {
    return stripInputItemIdsFromWebSocketPayload(payload);
  }

  protected override handleRequest(
    sessionId: string,
    baseBody: ResponseCreateParamsBase,
  ): void {
    super.handleRequest(sessionId, baseBody);
    baseBody.store ??= false;
    baseBody.prompt_cache_key = sessionId;
    baseBody.instructions = '';
  }

  protected override createClient(
    logger: ProviderHttpLogger | undefined,
    stream: boolean,
    credential?: AuthTokenInfo,
    abortSignal?: AbortSignal,
    mode: FetchMode = 'chat',
  ): OpenAI {
    const chatNetwork =
      mode === 'chat' ? resolveChatNetwork(this.config) : undefined;
    const effectiveTimeout =
      chatNetwork?.timeout ?? DEFAULT_NORMAL_TIMEOUT_CONFIG;

    const sdkTimeoutMs = resolveOpenAISdkTimeoutMs(effectiveTimeout, stream);

    const token = getToken(credential);

    const baseFetch = createCustomFetch({
      connectionTimeoutMs: effectiveTimeout.connection,
      responseTimeoutMs: effectiveTimeout.response,
      logger,
      retryConfig: chatNetwork?.retry,
      urlTransformer:
        this.config.auth?.method === 'openai-codex'
          ? rewriteToCodexEndpoint
          : undefined,
      type: mode,
      abortSignal,
    });

    const transformedFetch: typeof fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const nextInit = stripInputItemIds(init);
      if (!nextInit) {
        return baseFetch(input, nextInit);
      }
      return baseFetch(input, {
        ...nextInit,
        headers: sanitizeCodexHeaders(nextInit.headers),
      });
    };

    return new OpenAI({
      apiKey: token ?? '',
      baseURL: this.baseUrl,
      maxRetries: 0,
      timeout: sdkTimeoutMs,
      fetch: transformedFetch,
    });
  }

  override async getAvailableModels(
    _credential: AuthTokenInfo,
  ): Promise<ModelConfig[]> {
    return [
      { id: 'gpt-5.1-codex-max', maxOutputTokens: undefined },
      { id: 'gpt-5.1-codex-mini', maxOutputTokens: undefined },
      { id: 'gpt-5.2', maxOutputTokens: undefined },
      { id: 'gpt-5.4', maxOutputTokens: undefined },
      { id: 'gpt-5.4-mini', maxOutputTokens: undefined },
      { id: 'gpt-5.2-codex', maxOutputTokens: undefined },
      { id: 'gpt-5.3-codex', maxOutputTokens: undefined },
      { id: 'gpt-5.3-codex-spark', maxOutputTokens: undefined },
    ];
  }
}

function rewriteToCodexEndpoint(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }

  const pathname = parsed.pathname;

  if (
    pathname.includes('/backend-api/codex/responses') ||
    pathname.includes('/v1/responses') ||
    pathname.includes('/chat/completions')
  ) {
    return CODEX_API_ENDPOINT;
  }

  return raw;
}

function getHeaderValue(
  headers: HeadersInit | undefined,
  name: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }

  const needle = name.toLowerCase();

  if (headers instanceof Headers) {
    return headers.get(name) ?? headers.get(needle) ?? undefined;
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      if (key.toLowerCase() === needle) {
        return value;
      }
    }
    return undefined;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === needle) {
      return value;
    }
  }

  return undefined;
}

function stripInputItemIds(
  init: RequestInit | undefined,
): RequestInit | undefined {
  if (!init) {
    return init;
  }

  const method = init.method?.toUpperCase() ?? 'GET';
  if (method !== 'POST') {
    return init;
  }

  const body = init.body;
  if (typeof body !== 'string') {
    return init;
  }

  const contentType = getHeaderValue(init.headers, 'content-type') ?? '';
  if (contentType && !contentType.toLowerCase().includes('application/json')) {
    return init;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return init;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return init;
  }

  const record = parsed as Record<string, unknown>;
  const input = record['input'];
  if (!Array.isArray(input)) {
    return init;
  }

  const nextInput = input.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return item;
    }

    const itemRecord = item as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(itemRecord, 'id')) {
      return item;
    }

    const { id: _id, ...rest } = itemRecord;
    return rest;
  });

  return { ...init, body: JSON.stringify({ ...record, input: nextInput }) };
}
