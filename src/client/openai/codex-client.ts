import OpenAI from 'openai';
import * as vscode from 'vscode';
import type { AuthTokenInfo } from '../../auth/types';
import type { ProviderHttpLogger, RequestLogger } from '../../logger';
import {
  DEFAULT_NORMAL_TIMEOUT_CONFIG,
  FetchMode,
  buildOpencodeUserAgent,
  resolveChatNetwork,
} from '../../utils';
import type { ModelConfig, PerformanceTrace } from '../../types';
import { createCustomFetch, getToken } from '../utils';
import { OpenAIResponsesProvider } from './responses-client';
import { randomBytes } from 'crypto';
import { OPENCODE_CODEX_INSTRUCTIONS } from './codex-instructions';
import type { ResponseCreateParamsBase } from 'openai/resources/responses/responses';

const CODEX_API_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
const CODEX_ORIGINATOR = 'opencode';
const OPENCODE_SESSION_ID_PREFIX = 'ses_';
const OPENCODE_SESSION_ID_RANDOM_LENGTH = 14;

let lastOpencodeSessionTimestamp = 0;
let opencodeSessionCounter = 0;

function randomBase62(length: number): string {
  const chars =
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const bytes = randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % 62];
  }
  return result;
}

function createOpencodeSessionId(): string {
  const currentTimestamp = Date.now();
  if (currentTimestamp !== lastOpencodeSessionTimestamp) {
    lastOpencodeSessionTimestamp = currentTimestamp;
    opencodeSessionCounter = 0;
  }
  opencodeSessionCounter += 1;

  const now =
    BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(opencodeSessionCounter);

  const timeBytes = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) {
    timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff));
  }

  return `${OPENCODE_SESSION_ID_PREFIX}${timeBytes.toString('hex')}${randomBase62(
    OPENCODE_SESSION_ID_RANDOM_LENGTH,
  )}`;
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

export class OpenAICodeXProvider extends OpenAIResponsesProvider {
  protected override buildHeaders(
    sessionId: string,
    credential?: AuthTokenInfo,
    modelConfig?: ModelConfig,
  ): Record<string, string> {
    const headers = super.buildHeaders(sessionId, credential, modelConfig);

    headers['Accept'] = '*/*';
    headers['User-Agent'] = buildOpencodeUserAgent();
    headers['originator'] = CODEX_ORIGINATOR;
    headers['session_id'] = sessionId;

    const auth = this.config.auth;
    if (auth?.method === 'openai-codex') {
      const accountId = auth.accountId?.trim();
      if (accountId) {
        headers['ChatGPT-Account-Id'] = accountId;
      }
    }

    return headers;
  }

  protected generateSessionId(): string {
    return createOpencodeSessionId();
  }

  protected override handleRequest(
    sessionId: string,
    baseBody: ResponseCreateParamsBase,
  ): void {
    Object.assign(baseBody, {
      store: false,
      prompt_cache_key: sessionId,
      instructions: OPENCODE_CODEX_INSTRUCTIONS,
    });
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

    const requestTimeoutMs = stream
      ? effectiveTimeout.connection
      : effectiveTimeout.response;

    const token = getToken(credential);

    const baseFetch = createCustomFetch({
      connectionTimeoutMs: requestTimeoutMs,
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
      { id: 'gpt-5.2-codex', maxOutputTokens: undefined },
      { id: 'gpt-5.3-codex', maxOutputTokens: undefined },
      { id: 'gpt-5.1-codex', maxOutputTokens: undefined },
    ];
  }

  override async *streamChat(
    encodedModelId: string,
    model: ModelConfig,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    performanceTrace: PerformanceTrace,
    token: vscode.CancellationToken,
    logger: RequestLogger,
    credential: AuthTokenInfo,
  ): AsyncGenerator<vscode.LanguageModelResponsePart2> {
    const systemTextParts: string[] = [];
    for (const message of messages) {
      if (message.role !== vscode.LanguageModelChatMessageRole.System) {
        continue;
      }
      for (const part of message.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          const text = part.value.trim();
          if (text) {
            systemTextParts.push(text);
          }
        }
      }
    }

    const systemAsUserText =
      systemTextParts.length > 0 ? systemTextParts.join('\n\n') : undefined;

    const codexMessages: vscode.LanguageModelChatRequestMessage[] = messages
      .filter(
        (message) =>
          message.role !== vscode.LanguageModelChatMessageRole.System,
      )
      .slice();

    if (systemAsUserText) {
      codexMessages.unshift({
        role: vscode.LanguageModelChatMessageRole.User,
        name: undefined,
        content: [new vscode.LanguageModelTextPart(systemAsUserText)],
      });
    }

    yield* super.streamChat(
      encodedModelId,
      model,
      codexMessages,
      options,
      performanceTrace,
      token,
      logger,
      credential,
    );
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
