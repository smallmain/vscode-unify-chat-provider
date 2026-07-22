import OpenAI from 'openai';
import * as vscode from 'vscode';
import type { AuthTokenInfo } from '../../auth/types';
import type { ProviderHttpLogger } from '../../logger';
import {
  DEFAULT_NORMAL_TIMEOUT_CONFIG,
  FetchMode,
  isRawBaseUrlEnabled,
  resolveChatNetwork,
  resolveSdkTotalTimeoutMs,
} from '../../utils';
import type { ModelConfig } from '../../types';
import { createCustomFetch, getToken } from '../utils';
import {
  OpenAIResponsesProvider,
  type OpenAIResponsesClientEvent,
  type OpenAIResponsesRequestBody,
} from './responses-client';
import { randomUUID } from 'crypto';
import { codexBaseInstructionsForModel } from './codex-instructions';

const CODEX_API_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
// Align with CLIProxyAPI internal/runtime/executor/codex_executor.go defaults.
const CODEX_USER_AGENT =
  'codex-tui/0.135.0 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; 0.135.0)';
const CODEX_ORIGINATOR = 'codex-tui';
// Align with CLIProxyAPI codex_websockets_executor.go.
const CODEX_RESPONSES_WEBSOCKET_BETA = 'responses_websockets=2026-02-06';
const CODEX_COMMON_REQUEST_FIELDS_TO_DELETE = [
  'user',
  'metadata',
  'prompt_cache_retention',
  'safety_identifier',
  'stream_options',
  'max_output_tokens',
  'max_completion_tokens',
  'temperature',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
] as const;
const CODEX_REASONING_SUMMARY_DEFAULTS = {
  maxOutputTokens: undefined,
  thinking: {
    type: 'enabled',
    effort: 'xhigh',
    summary: 'auto',
  },
} satisfies Pick<ModelConfig, 'maxOutputTokens' | 'thinking'>;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isResponsesClientEvent(
  value: unknown,
): value is OpenAIResponsesClientEvent {
  return (
    isRecord(value) &&
    (value['type'] === 'response.create' ||
      value['type'] === 'response.inject')
  );
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

// Temporarily disabled because adding the image generation tool by default can
// fail text-only Codex requests when the account/group lacks image generation.
// See https://github.com/smallmain/vscode-unify-chat-provider/issues/202.
// type CodexResponseTool = NonNullable<ResponseCreateParamsBase['tools']>[number];
// type CodexImageGenerationTool = Extract<
//   CodexResponseTool,
//   { type: 'image_generation' }
// >;
//
// const CODEX_IMAGE_GENERATION_TOOL: CodexImageGenerationTool = {
//   type: 'image_generation',
//   output_format: 'png',
// };
//
// function shouldSkipCodexImageGenerationTool(model: unknown): boolean {
//   return typeof model === 'string' && model.endsWith('spark');
// }
//
// function isImageGenerationTool(tool: CodexResponseTool): boolean {
//   return tool.type === 'image_generation';
// }
//
// function ensureCodexImageGenerationTool(
//   baseBody: ResponseCreateParamsBase,
// ): void {
//   if (shouldSkipCodexImageGenerationTool(baseBody.model)) {
//     return;
//   }
//
//   if (!baseBody.tools) {
//     baseBody.tools = [CODEX_IMAGE_GENERATION_TOOL];
//     return;
//   }
//
//   if (baseBody.tools.some(isImageGenerationTool)) {
//     return;
//   }
//
//   baseBody.tools = [...baseBody.tools, CODEX_IMAGE_GENERATION_TOOL];
// }

function stripInputItemIdsFromRecord(record: object): void {
  const input: unknown = Reflect.get(record, 'input');
  if (!Array.isArray(input)) {
    return;
  }

  Reflect.set(record, 'input', input.map((item) => {
    if (!isRecord(item) || !Object.prototype.hasOwnProperty.call(item, 'id')) {
      return item;
    }

    const { id: _id, ...rest } = item;
    return rest;
  }));
}

function ensureCodexReasoningInclude(record: object): void {
  if (!isRecord(Reflect.get(record, 'reasoning'))) {
    return;
  }

  const include: unknown = Reflect.get(record, 'include');
  if (!Array.isArray(include)) {
    Reflect.set(record, 'include', ['reasoning.encrypted_content']);
    return;
  }

  if (!include.includes('reasoning.encrypted_content')) {
    Reflect.set(record, 'include', [...include, 'reasoning.encrypted_content']);
  }
}

function normalizeCodexRequestRecord(
  record: object,
  options: { deletePreviousResponseId: boolean },
): void {
  for (const field of CODEX_COMMON_REQUEST_FIELDS_TO_DELETE) {
    Reflect.deleteProperty(record, field);
  }

  if (options.deletePreviousResponseId) {
    Reflect.deleteProperty(record, 'previous_response_id');
  }

  const instructions: unknown = Reflect.get(record, 'instructions');
  if (
    instructions === undefined ||
    instructions === null ||
    (typeof instructions === 'string' && instructions.trim() === '')
  ) {
    Reflect.set(
      record,
      'instructions',
      codexBaseInstructionsForModel(Reflect.get(record, 'model')),
    );
  }
  Reflect.set(record, 'store', false);
  if (Reflect.get(record, 'stream') === undefined) {
    Reflect.set(record, 'stream', true);
  }
  ensureCodexReasoningInclude(record);

  stripInputItemIdsFromRecord(record);
}

function normalizeCodexWebSocketPayload(
  payload: OpenAIResponsesClientEvent,
): OpenAIResponsesClientEvent {
  if (payload.type !== 'response.create') {
    return payload;
  }

  const parsed: unknown = JSON.parse(JSON.stringify(payload));
  if (!isRecord(parsed) || parsed['type'] !== 'response.create') {
    return payload;
  }

  normalizeCodexRequestRecord(parsed, { deletePreviousResponseId: false });

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

/**
 * OpenAICodexProvider — ChatGPT Codex backend client.
 *
 * Request construction is aligned with CLIProxyAPI's reference implementation:
 * - HTTP: applyCodexHeadersFromSources in codex_executor.go
 * - WebSocket: applyCodexWebsocketHeaders in codex_websockets_executor.go
 * - OAuth account identity headers only for openai-codex auth
 */
export class OpenAICodexProvider extends OpenAIResponsesProvider {
  protected override shouldEnableResponsesContextManagement(
    model: ModelConfig,
  ): boolean {
    return this.isResponsesContextManagementModelSupported(model);
  }

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

    // Scrub non-Codex / proxy-fingerprint headers before applying CLIProxyAPI defaults.
    deleteHeaderVariants(headers, 'accept');
    deleteHeaderVariants(headers, 'connection');
    deleteHeaderVariants(headers, 'user-agent');
    deleteHeaderVariants(headers, 'originator');
    deleteHeaderVariants(headers, 'session_id');
    deleteHeaderVariants(headers, 'conversation_id');
    deleteHeaderVariants(headers, 'version');
    deleteHeaderVariants(headers, 'chatgpt-account-id');
    deleteHeaderVariants(headers, 'openai-beta');
    deleteHeaderVariants(headers, 'x-codex-turn-metadata');
    deleteHeaderVariants(headers, 'x-client-request-id');

    // CLIProxyAPI defaults: codex-tui UA + Keep-Alive.
    // Version / X-Codex-Turn-Metadata / X-Client-Request-Id are only forwarded
    // when present (EnsureHeader with empty default), so do not invent values.
    headers['User-Agent'] = CODEX_USER_AGENT;
    headers['Connection'] = 'Keep-Alive';

    // CLIProxyAPI sets Session_id when UA contains "Mac OS"; our default UA does.
    // Conversation_id / Session_id also track prompt_cache_key for cache affinity.
    headers['Session_id'] = sessionId;
    headers['Conversation_id'] = sessionId;

    const auth = this.config.auth;
    if (auth?.method === 'openai-codex') {
      // OAuth path: Originator + Chatgpt-Account-Id (not set for API-key auth).
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

    // WebSocket upgrade must not send Connection: Keep-Alive from the HTTP path.
    deleteHeaderVariants(headers, 'connection');
    // Optional Codex desktop headers are only forwarded when present upstream;
    // do not invent empty values (matches CLIProxyAPI EnsureHeader semantics).
    deleteHeaderVariants(headers, 'x-codex-beta-features');
    deleteHeaderVariants(headers, 'x-codex-turn-state');
    deleteHeaderVariants(headers, 'x-codex-turn-metadata');
    deleteHeaderVariants(headers, 'x-client-request-id');
    deleteHeaderVariants(headers, 'x-responsesapi-include-timing-metrics');

    const existingBeta = readStringHeader(headers, 'openai-beta');
    deleteHeaderVariants(headers, 'openai-beta');
    headers['OpenAI-Beta'] =
      existingBeta && existingBeta.includes('responses_websockets=')
        ? existingBeta
        : CODEX_RESPONSES_WEBSOCKET_BETA;

    // Keep User-Agent / Originator / account headers from the HTTP builder.
    return headers;
  }

  protected generateSessionId(): string {
    return randomUUID();
  }

  protected override resolveWebSocketBaseUrl(client: OpenAI): string {
    if (isRawBaseUrlEnabled(this.config)) {
      return client.baseURL;
    }

    return resolveCodexWebSocketBaseUrl(client.baseURL);
  }

  protected override transformWebSocketRequestPayload(
    payload: OpenAIResponsesClientEvent,
  ): OpenAIResponsesClientEvent {
    return normalizeCodexWebSocketPayload(payload);
  }

  protected override handleRequest(
    sessionId: string,
    baseBody: OpenAIResponsesRequestBody,
  ): void {
    // Align body scrubbing with CLIProxyAPI CodexExecutor.Execute:
    // drop previous_response_id / prompt_cache_retention / safety_identifier /
    // stream_options and force store=false + prompt_cache_key for session affinity.
    normalizeCodexRequestRecord(baseBody, {
      deletePreviousResponseId: true,
    });
    Object.assign(baseBody, {
      store: false,
      prompt_cache_key: sessionId,
    });
    delete baseBody.prompt_cache_retention;
    delete baseBody.safety_identifier;
    delete baseBody.stream_options;
    // Temporarily disabled; see https://github.com/smallmain/vscode-unify-chat-provider/issues/202.
    // ensureCodexImageGenerationTool(baseBody);
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
    const proxy = chatNetwork?.proxy ?? resolveChatNetwork(this.config).proxy;
    const effectiveTimeout =
      chatNetwork?.timeout ?? DEFAULT_NORMAL_TIMEOUT_CONFIG;

    const sdkTimeoutMs = resolveSdkTotalTimeoutMs(effectiveTimeout, stream);

    const token = getToken(credential);

    const baseFetch = createCustomFetch({
      connectionTimeoutMs: effectiveTimeout.connection,
      responseTimeoutMs: effectiveTimeout.response,
      logger,
      retryConfig: chatNetwork?.retry,
      proxy,
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
      const nextInit = normalizeCodexHttpRequest(init);
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
      {
        id: 'gpt-5.6-sol',
        maxInputTokens: 372000,
        ...CODEX_REASONING_SUMMARY_DEFAULTS,
      },
      {
        id: 'gpt-5.6-terra',
        maxInputTokens: 372000,
        ...CODEX_REASONING_SUMMARY_DEFAULTS,
      },
      {
        id: 'gpt-5.6-luna',
        maxInputTokens: 372000,
        ...CODEX_REASONING_SUMMARY_DEFAULTS,
      },
      {
        id: 'gpt-5.5',
        maxInputTokens: 272000,
        ...CODEX_REASONING_SUMMARY_DEFAULTS,
      },
      { id: 'gpt-5.4', ...CODEX_REASONING_SUMMARY_DEFAULTS },
      { id: 'gpt-5.2', ...CODEX_REASONING_SUMMARY_DEFAULTS },
      { id: 'gpt-5.4-mini', ...CODEX_REASONING_SUMMARY_DEFAULTS },
      { id: 'gpt-5.3-codex', ...CODEX_REASONING_SUMMARY_DEFAULTS },
      { id: 'gpt-5.3-codex-spark', ...CODEX_REASONING_SUMMARY_DEFAULTS },
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

function normalizeCodexHttpRequest(
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

  if (!isRecord(parsed)) {
    return init;
  }

  normalizeCodexRequestRecord(parsed, { deletePreviousResponseId: true });

  return { ...init, body: JSON.stringify(parsed) };
}
