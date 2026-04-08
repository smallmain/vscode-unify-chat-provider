import {
  LanguageModelChatRequestMessage,
  ProvideLanguageModelChatResponseOptions,
  CancellationToken,
} from 'vscode';
import { createSimpleHttpLogger } from '../../logger';
import type { ProviderHttpLogger, RequestLogger } from '../../logger';
import {
  ENCRYPTED_THINKING_PLACEHOLDER,
  ThinkingBlockMetadata,
} from '../types';
import { FeatureId } from '../definitions';
import { ApiProvider } from '../interface';
import OpenAI from 'openai';
import type { AuthTokenInfo } from '../../auth/types';
import {
  createImageDataPartFromBase64,
  decodeStatefulMarkerPart,
  createStatefulMarkerIdentity,
  DEFAULT_NORMAL_TIMEOUT_CONFIG,
  encodeStatefulMarkerPart,
  FetchMode,
  isCacheControlMarker,
  isImageMarker,
  isInternalMarker,
  normalizeImageMimeType,
  resolveContextCacheConfig,
  resolveChatNetwork,
  resolveOpenAISdkTimeoutMs,
  sanitizeMessagesForModelSwitchDetailed,
  withIdleTimeout,
} from '../../utils';
import {
  buildBaseUrl,
  createCustomFetch,
  createFirstTokenRecorder,
  estimateTokenCount as sharedEstimateTokenCount,
  getToken,
  getTokenType,
  getUnifiedUserAgent,
  isFeatureSupported,
  mergeHeaders,
  normalizeToolInputSchema,
  parseToolArguments,
  processUsage as sharedProcessUsage,
  resolveOpenAIServiceTier,
  setUserAgentHeader,
} from '../utils';
import * as vscode from 'vscode';
import {
  EasyInputMessage,
  FunctionTool,
  Response as OpenAIResponse,
  ResponseCreateParamsBase,
  ResponsesClientEvent,
  ResponseFunctionCallOutputItem,
  ResponseFunctionToolCall,
  ResponseInput,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseReasoningItem,
  ResponseStreamEvent,
  ResponseUsage,
  ToolChoiceFunction,
  ToolChoiceOptions,
} from 'openai/resources/responses/responses';
import { getBaseModelId } from '../../model-id-utils';
import { createHash, randomUUID } from 'crypto';
import { ProviderConfig, ModelConfig, PerformanceTrace } from '../../types';
import {
  WebSocketSessionError,
  WebSocketSessionRequest,
  type WebSocketSessionTransport,
  webSocketSessionManager,
} from '../websocket-session-manager';
import { OpenAIResponsesWebSocketTransport } from './responses-websocket-transport';

const VOLC_CONTEXT_CACHE_MAX_TTL_SECONDS = 604_800;
const PREVIOUS_RESPONSE_ID_ERROR_CODES = new Set<string>([
  'invalid_previous_response_id',
  'previous_response_not_found',
]);
const WEBSOCKET_CONNECTION_LIMIT_ERROR_CODE =
  'websocket_connection_limit_reached';

type ResolvedTransportMode = 'sse' | 'auto' | 'websocket';

type ConvertedMessagesResult = {
  input: ResponseInput;
  sessionId: string;
  previousResponseId?: string;
  inputAfterPreviousResponse?: ResponseInputItem[];
  previousResponseBoundaryIndex?: number;
};

type ResponseContinuation = {
  previousResponseId: string;
  inputAfterPreviousResponse: ResponseInputItem[];
};

type OpenAIResponsesRequestBody = ResponseCreateParamsBase & {
  conversation?: unknown;
  previous_response_id?: string;
};

type ExtractedResponseError = {
  message: string;
  source: 'generic' | 'sdk' | 'stream';
  status?: number;
  code?: string;
  type?: string;
  param?: string;
};

type OpenAIResponsesRequestContext = {
  sessionId: string;
  streamEnabled: boolean;
  baseBody: OpenAIResponsesRequestBody;
  fullInput: OpenAIResponsesRequestBody['input'];
  headers: Record<string, string>;
  abortController: AbortController;
  token: CancellationToken;
  logger: RequestLogger;
  performanceTrace: PerformanceTrace;
  expectedIdentity: string;
  credential: AuthTokenInfo;
  imageGenerationOutputMimeType: string;
};

type ResponseThinkingContentType = 'encrypted' | 'summary' | 'content';

type ResponseThinkingOutputState = {
  lastType?: ResponseThinkingContentType;
};

type ResponseImageGenerationCall = Extract<
  ResponseOutputItem,
  { type: 'image_generation_call' }
>;

type ResponsesApiTool = NonNullable<ResponseCreateParamsBase['tools']>[number];

type ResponseImageGenerationTool = Extract<
  ResponsesApiTool,
  { type: 'image_generation' }
>;

type OpenAIResponsesHttpRequestContext = OpenAIResponsesRequestContext & {
  continuation: ResponseContinuation | undefined;
  includeResponseIdInMarker: boolean;
};

type OpenAIResponsesWebSocketRequestContext = OpenAIResponsesRequestContext & {
  continuation: ResponseContinuation | undefined;
  includeResponseIdInMarker: boolean;
  sessionKey: string;
  hadHotSessionAtStart: boolean;
  webSocketHeaders: Record<string, string>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isResponseImageGenerationCall(
  item: ResponseOutputItem,
): item is ResponseImageGenerationCall {
  return item.type === 'image_generation_call';
}

function isResponseImageGenerationTool(
  tool: ResponsesApiTool,
): tool is ResponseImageGenerationTool {
  return tool.type === 'image_generation';
}

function readStringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readNumberField(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

class OpenAIResponsesRequestError extends Error {
  readonly source: 'stream' | 'generic';
  readonly status?: number;
  readonly code?: string;
  readonly type?: string;
  readonly param?: string;

  constructor(
    message: string,
    options: {
      source?: 'stream' | 'generic';
      status?: number;
      code?: string;
      type?: string;
      param?: string;
    } = {},
  ) {
    super(message);
    this.name = 'OpenAIResponsesRequestError';
    this.source = options.source ?? 'generic';
    this.status = options.status;
    this.code = options.code;
    this.type = options.type;
    this.param = options.param;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

class OpenAIResponsesWebSocketFallbackError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'OpenAIResponsesWebSocketFallbackError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        enumerable: false,
        value: cause,
        writable: true,
      });
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class OpenAIResponsesProvider implements ApiProvider {
  protected readonly baseUrl: string;
  private websocketCapability: 'unknown' | 'supported' | 'unsupported' =
    'unknown';

  constructor(protected readonly config: ProviderConfig) {
    this.baseUrl = this.resolveBaseUrl(config);
  }

  protected resolveBaseUrl(config: ProviderConfig): string {
    return buildBaseUrl(config.baseUrl, {
      ensureSuffix: '/v1',
      skipSuffixIfMatch: /\/v\d+$/,
    });
  }

  protected buildHeaders(
    sessionId: string,
    credential?: AuthTokenInfo,
    modelConfig?: ModelConfig,
    _messages?: readonly LanguageModelChatRequestMessage[],
  ): Record<string, string> {
    const token = getToken(credential);
    const headers = mergeHeaders(
      token,
      this.config.extraHeaders,
      modelConfig?.extraHeaders,
    );

    setUserAgentHeader(headers, getUnifiedUserAgent());

    if (token) {
      const tokenType = getTokenType(credential) ?? 'Bearer';
      headers['Authorization'] = `${tokenType} ${token}`;
    }

    return headers;
  }

  protected buildWebSocketHeaders(
    sessionId: string,
    credential?: AuthTokenInfo,
    modelConfig?: ModelConfig,
    messages?: readonly LanguageModelChatRequestMessage[],
  ): Record<string, string> {
    return this.buildHeaders(sessionId, credential, modelConfig, messages);
  }

  /**
   * Create an OpenAI client with custom fetch for retry support.
   * A new client is created per request to enable per-request logging.
   */
  protected createClient(
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

    return new OpenAI({
      apiKey: token ?? '',
      baseURL: this.baseUrl,
      maxRetries: 0,
      timeout: sdkTimeoutMs,
      fetch: createCustomFetch({
        connectionTimeoutMs: effectiveTimeout.connection,
        responseTimeoutMs: effectiveTimeout.response,
        logger,
        retryConfig: chatNetwork?.retry,
        type: mode,
        abortSignal,
      }),
    });
  }

  protected generateSessionId(): string {
    return randomUUID();
  }

  protected resolveWebSocketBaseUrl(client: OpenAI): string {
    return client.baseURL;
  }

  protected createWebSocketTransport(
    client: OpenAI,
    headers: Record<string, string>,
  ): WebSocketSessionTransport<ResponsesClientEvent, ResponseStreamEvent> {
    const webSocketBaseUrl = this.resolveWebSocketBaseUrl(client);
    const transportClient =
      webSocketBaseUrl === client.baseURL
        ? client
        : new OpenAI({
            apiKey: client.apiKey,
            baseURL: webSocketBaseUrl,
            maxRetries: 0,
            timeout: client.timeout,
          });

    return new OpenAIResponsesWebSocketTransport(transportClient, headers);
  }

  protected transformWebSocketRequestPayload(
    payload: ResponsesClientEvent,
  ): ResponsesClientEvent {
    return payload;
  }

  protected getInputMessageRole(
    role: vscode.LanguageModelChatMessageRole,
  ): EasyInputMessage['role'] {
    switch (role) {
      case vscode.LanguageModelChatMessageRole.Assistant:
        return 'assistant';
      case vscode.LanguageModelChatMessageRole.System:
        return 'system';
      case vscode.LanguageModelChatMessageRole.User:
        return 'user';
      default:
        throw new Error(`Unsupported message role for provider: ${role}`);
    }
  }

  private convertMessages(
    encodedModelId: string,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    expectedIdentity: string,
    messageOriginIndexes?: readonly number[],
  ): ConvertedMessagesResult {
    let firstSessionId: string | null = null;
    let latestResponseId: string | undefined;
    let latestResponseBoundaryIndex: number | undefined;
    let outItemsAfterLatestResponse: ResponseInputItem[] = [];
    const outItems: ResponseInputItem[] = [];
    const rawMap = new Map<
      ResponseInputItem,
      OpenAIResponsesMarkerData['data']
    >();
    const appendOutItem = (item: ResponseInputItem): void => {
      outItems.push(item);
      if (latestResponseId !== undefined) {
        outItemsAfterLatestResponse.push(item);
      }
    };

    for (const [messageIndex, msg] of messages.entries()) {
      switch (msg.role) {
        case vscode.LanguageModelChatMessageRole.System:
          for (const part of msg.content) {
            const parts = this.convertPart(msg.role, part) as
              | EasyInputMessage
              | undefined;
            if (parts) appendOutItem(parts);
          }
          break;

        case vscode.LanguageModelChatMessageRole.User:
          for (const part of msg.content) {
            const parts = this.convertPart(msg.role, part) as
              | EasyInputMessage
              | ResponseInputItem.FunctionCallOutput
              | undefined;
            if (parts) appendOutItem(parts);
          }
          break;

        case vscode.LanguageModelChatMessageRole.Assistant:
          {
            const markerParts = msg.content.filter(
              (v): v is vscode.LanguageModelDataPart =>
                v instanceof vscode.LanguageModelDataPart &&
                isInternalMarker(v),
            );

            if (markerParts.length === 1) {
              try {
                const {
                  data: raw,
                  sessionId,
                  responseId,
                } = decodeStatefulMarkerPart<OpenAIResponsesMarkerData>(
                  expectedIdentity,
                  encodedModelId,
                  markerParts[0],
                );
                if (firstSessionId == null && sessionId) {
                  firstSessionId = sessionId;
                }
                if (typeof responseId === 'string' && responseId.trim()) {
                  latestResponseId = responseId;
                  latestResponseBoundaryIndex =
                    messageOriginIndexes?.[messageIndex] ?? messageIndex;
                  outItemsAfterLatestResponse = [];
                } else {
                  latestResponseId = undefined;
                  latestResponseBoundaryIndex = undefined;
                  outItemsAfterLatestResponse = [];
                }
                const item: EasyInputMessage = {
                  role: 'assistant',
                  content: '',
                };
                rawMap.set(item, raw);
                outItems.push(item);
                break;
              } catch {
                // fall back to best-effort conversion
              }
            }

            for (const part of msg.content) {
              const parts = this.convertPart(msg.role, part) as
                | EasyInputMessage
                | ResponseFunctionToolCall
                | ResponseReasoningItem
                | undefined;
              if (parts) appendOutItem(parts);
            }
          }
          break;

        default:
          throw new Error(`Unsupported message role for provider: ${msg.role}`);
      }
    }

    // Reuse raw response output items from the stateful marker verbatim so assistant
    // metadata such as `phase` survives follow-up requests.
    for (const [param, raw] of rawMap) {
      const index = outItems.indexOf(param);
      if (index === -1) continue;
      outItems.splice(index, 1, ...raw);
    }

    const result: ConvertedMessagesResult = {
      input: outItems,
      sessionId: firstSessionId ?? this.generateSessionId(),
    };
    if (latestResponseId !== undefined) {
      result.previousResponseId = latestResponseId;
      result.inputAfterPreviousResponse = outItemsAfterLatestResponse;
      result.previousResponseBoundaryIndex = latestResponseBoundaryIndex;
    }
    return result;
  }

  private hasSanitizedMessagesAfterBoundary(
    sanitizedMessageIndexes: ReadonlySet<number>,
    boundaryIndex: number | undefined,
  ): boolean {
    if (boundaryIndex === undefined) {
      return false;
    }

    for (const index of sanitizedMessageIndexes) {
      if (index > boundaryIndex) {
        return true;
      }
    }

    return false;
  }

  convertPart(
    role: vscode.LanguageModelChatMessageRole | 'from_tool_result',
    part: vscode.LanguageModelInputPart | unknown,
  ):
    | EasyInputMessage
    | ResponseFunctionToolCall
    | ResponseInputItem.FunctionCallOutput
    | ResponseReasoningItem
    | ResponseFunctionCallOutputItem[]
    | undefined {
    if (part == null) {
      return undefined;
    }

    const roleStr: EasyInputMessage['role'] =
      role === 'from_tool_result' ? 'user' : this.getInputMessageRole(role);

    if (part instanceof vscode.LanguageModelTextPart) {
      if (part.value.trim()) {
        switch (role) {
          case vscode.LanguageModelChatMessageRole.Assistant:
            return {
              role: 'assistant',
              content: [
                {
                  type: 'output_text' as 'input_text',
                  text: part.value,
                },
              ],
            };

          case 'from_tool_result':
            return [
              {
                type: 'input_text',
                text: part.value,
              },
            ];

          default:
            return {
              role: roleStr,
              content: [
                {
                  type: 'input_text',
                  text: part.value,
                },
              ],
            };
        }
      } else {
        return undefined;
      }
    } else if (part instanceof vscode.LanguageModelThinkingPart) {
      if (role !== vscode.LanguageModelChatMessageRole.Assistant) {
        throw new Error('Thinking parts can only appear in assistant messages');
      }
      const metadata = part.metadata as ThinkingBlockMetadata | undefined;
      const id = part.id ?? metadata?.signature ?? `reasoning_${randomUUID()}`;
      const completeThinking = metadata?._completeThinking;
      const contents =
        typeof part.value === 'string' ? [part.value] : part.value;
      if (metadata?.redactedData) {
        return {
          type: 'reasoning',
          id,
          summary: [],
          encrypted_content: metadata.redactedData,
        };
      } else {
        return {
          type: 'reasoning',
          id,
          summary: [],
          content: completeThinking
            ? [
                {
                  type: 'reasoning_text',
                  text: completeThinking,
                },
              ]
            : contents.map((text) => ({
                type: 'reasoning_text',
                text,
              })),
        };
      }
    } else if (part instanceof vscode.LanguageModelDataPart) {
      if (isCacheControlMarker(part)) {
        // ignore it, just use the officially recommended caching strategy.
        return undefined;
      } else if (isInternalMarker(part)) {
        return undefined;
      } else if (isImageMarker(part)) {
        const mimeType = normalizeImageMimeType(part.mimeType);
        if (!mimeType) {
          throw new Error(
            `Unsupported image mime type for provider: ${part.mimeType}`,
          );
        }
        const content = {
          type: 'input_image',
          detail: 'auto',
          image_url: `data:${mimeType};base64,${Buffer.from(part.data).toString(
            'base64',
          )}`,
        } as const;
        return role === 'from_tool_result'
          ? [content]
          : {
              role: roleStr,
              content: [content],
            };
      } else {
        throw new Error(
          `Unsupported ${role} message LanguageModelDataPart mime type: ${part.mimeType}`,
        );
      }
    } else if (part instanceof vscode.LanguageModelToolCallPart) {
      if (role !== vscode.LanguageModelChatMessageRole.Assistant) {
        throw new Error(
          'Tool call parts can only appear in assistant messages',
        );
      }
      return {
        type: 'function_call',
        call_id: part.callId,
        name: part.name,
        arguments: this.stringifyArguments(part.input),
      };
    } else if (
      part instanceof vscode.LanguageModelToolResultPart ||
      part instanceof vscode.LanguageModelToolResultPart2
    ) {
      if (role !== vscode.LanguageModelChatMessageRole.User) {
        throw new Error('Tool result parts can only appear in user messages');
      }
      const content = part.content
        .map(
          (v) =>
            this.convertPart('from_tool_result', v) as
              | ResponseFunctionCallOutputItem[]
              | undefined,
        )
        .filter((v) => v !== undefined)
        .flat();
      return {
        type: 'function_call_output',
        call_id: part.callId,
        output:
          content.length === 1 && content[0].type === 'input_text'
            ? content[0].text
            : content.length > 0
              ? content
              : '',
      };
    } else {
      throw new Error(`Unsupported ${role} message part type encountered`);
    }
  }

  private convertTools(
    tools: readonly vscode.LanguageModelChatTool[] | undefined,
  ): FunctionTool[] | undefined {
    if (!tools || tools.length === 0) {
      return undefined;
    }

    return tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: normalizeToolInputSchema(tool.inputSchema),
      strict: false,
    }));
  }

  private convertToolChoice(
    mode: vscode.LanguageModelChatToolMode,
    tools?: FunctionTool[],
  ): ToolChoiceOptions | ToolChoiceFunction | undefined {
    if (!tools || tools.length === 0) {
      return undefined;
    }

    if (mode === vscode.LanguageModelChatToolMode.Required) {
      if (tools.length === 1) {
        return {
          type: 'function',
          name: tools[0].name,
        };
      }
      return 'required';
    }

    return 'auto';
  }

  private buildReasoningParams(
    model: ModelConfig,
    useThinkingParam2: boolean,
  ): Pick<ResponseCreateParamsBase, 'reasoning' | 'thinking'> {
    const thinking = model.thinking;
    if (!thinking) {
      return {};
    }

    if (useThinkingParam2) {
      if (thinking.type === 'disabled') {
        return {
          thinking: { type: 'disabled' },
        };
      } else {
        const reasoning: NonNullable<ResponseCreateParamsBase['reasoning']> = {
          effort: thinking.effort ?? 'medium',
        };
        if (thinking.summary !== undefined) {
          reasoning.summary = thinking.summary;
        }
        return {
          thinking: { type: thinking.type },
          // Defaults to 'medium' effort
          reasoning,
        };
      }
    } else {
      if (thinking.type === 'disabled') {
        return {
          reasoning: { effort: 'none' },
        };
      } else {
        const reasoning: NonNullable<ResponseCreateParamsBase['reasoning']> = {
          effort: thinking.effort ?? 'medium',
        };
        if (thinking.summary !== undefined) {
          reasoning.summary = thinking.summary;
        }
        return {
          // Defaults to 'medium' effort
          reasoning,
        };
      }
    }
  }

  private resolveExplicitContextCacheTtlSeconds(): number | undefined {
    const ttl = this.config.contextCache?.ttl;
    if (
      typeof ttl !== 'number' ||
      !Number.isFinite(ttl) ||
      !Number.isInteger(ttl) ||
      ttl <= 0
    ) {
      return undefined;
    }
    return ttl;
  }

  private shouldEnableVolcContextCaching(model: ModelConfig): boolean {
    if (
      !isFeatureSupported(
        FeatureId.OpenAIUseVolcContextCaching,
        this.config,
        model,
      )
    ) {
      return false;
    }
    const resolvedCache = resolveContextCacheConfig(this.config.contextCache);
    return resolvedCache.type === 'allow-paid';
  }

  private applyVolcContextCaching(
    model: ModelConfig,
    baseBody: ResponseCreateParamsBase,
  ): boolean {
    if (!this.shouldEnableVolcContextCaching(model)) {
      return false;
    }
    if (baseBody.instructions !== undefined && baseBody.instructions !== null) {
      return false;
    }
    if (baseBody.store === false) {
      return false;
    }

    baseBody.caching = { type: 'enabled' };

    const explicitTtlSeconds = this.resolveExplicitContextCacheTtlSeconds();
    if (explicitTtlSeconds !== undefined) {
      const cappedTtlSeconds = Math.min(
        explicitTtlSeconds,
        VOLC_CONTEXT_CACHE_MAX_TTL_SECONDS,
      );
      baseBody.expire_at = Math.floor(Date.now() / 1000) + cappedTtlSeconds;
    }
    return true;
  }

  protected handleRequest(
    sessionId: string,
    baseBody: ResponseCreateParamsBase,
  ) {}

  private resolveTransportMode(streamEnabled: boolean): ResolvedTransportMode {
    switch (this.config.transport) {
      case 'auto':
        return 'auto';
      case 'websocket':
        return 'websocket';
      case 'sse':
      default:
        return 'sse';
    }
  }

  private createWebSocketSessionKey(
    sessionId: string,
    headers: Record<string, string>,
  ): string {
    const normalizedHeaders = Object.entries(headers)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, value] as const);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(normalizedHeaders))
      .digest('hex');

    return [
      this.config.type,
      this.config.name,
      this.baseUrl,
      fingerprint,
      sessionId,
    ].join('|');
  }

  private resolveResponseContinuation(
    baseBody: OpenAIResponsesRequestBody,
    previousResponseId: string | undefined,
    inputAfterPreviousResponse: ResponseInputItem[] | undefined,
    options: {
      allowStoreFalse?: boolean;
    } = {},
  ): ResponseContinuation | undefined {
    if (
      typeof previousResponseId !== 'string' ||
      !previousResponseId.trim() ||
      inputAfterPreviousResponse === undefined ||
      inputAfterPreviousResponse.length === 0
    ) {
      return undefined;
    }

    if (baseBody.store === false && options.allowStoreFalse !== true) {
      return undefined;
    }
    if (baseBody.conversation !== undefined && baseBody.conversation !== null) {
      return undefined;
    }

    return {
      previousResponseId: previousResponseId.trim(),
      inputAfterPreviousResponse,
    };
  }

  private buildRequestBodyForAttempt(
    baseBody: OpenAIResponsesRequestBody,
    fullInput: OpenAIResponsesRequestBody['input'],
    continuation: ResponseContinuation | undefined,
    useContinuation: boolean,
    stream: boolean,
  ): OpenAIResponsesRequestBody {
    const body: OpenAIResponsesRequestBody = {
      ...baseBody,
      input: fullInput,
      stream,
    };

    delete body.previous_response_id;

    if (useContinuation && continuation) {
      body.previous_response_id = continuation.previousResponseId;
      body.input = continuation.inputAfterPreviousResponse;
    }

    return body;
  }

  private buildWebSocketRequestForAttempt(
    baseBody: OpenAIResponsesRequestBody,
    fullInput: OpenAIResponsesRequestBody['input'],
    continuation: ResponseContinuation | undefined,
    useContinuation: boolean,
  ): ResponsesClientEvent {
    const body: OpenAIResponsesRequestBody = {
      ...baseBody,
      input: fullInput,
    };

    delete body.previous_response_id;
    delete body.stream;

    if (useContinuation && continuation) {
      body.previous_response_id = continuation.previousResponseId;
      body.input = continuation.inputAfterPreviousResponse;
    }

    return {
      type: 'response.create',
      ...body,
    };
  }

  private shouldIncludeResponseIdInMarker(
    baseBody: OpenAIResponsesRequestBody,
    options: {
      allowStoreFalse?: boolean;
    } = {},
  ): boolean {
    return options.allowStoreFalse === true || baseBody.store !== false;
  }

  private shouldMarkWebSocketUnsupported(error: unknown): boolean {
    if (error instanceof WebSocketSessionError) {
      return (
        error.kind === 'unexpected_response' || error.kind === 'protocol_error'
      );
    }

    const details = this.extractResponseError(error);
    const normalizedMessage = details.message.toLowerCase();
    return (
      normalizedMessage.includes('websocket') &&
      (normalizedMessage.includes('unsupported') ||
        normalizedMessage.includes('not support') ||
        normalizedMessage.includes('not supported'))
    );
  }

  private extractResponseError(error: unknown): ExtractedResponseError {
    const fallbackMessage =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : 'Unknown error';

    const initial: ExtractedResponseError =
      error instanceof OpenAIResponsesRequestError
        ? {
            message: error.message,
            source: error.source,
            status: error.status,
            code: error.code,
            type: error.type,
            param: error.param,
          }
        : {
            message: fallbackMessage,
            source: 'generic',
          };

    if (!isRecord(error)) {
      return initial;
    }

    const nested = error['error'];
    const nestedRecord = isRecord(nested) ? nested : undefined;

    const directMessage = readStringField(error, 'message');
    const nestedMessage = nestedRecord
      ? readStringField(nestedRecord, 'message')
      : undefined;
    const directStatus = readNumberField(error, 'status');
    const nestedStatus = nestedRecord
      ? readNumberField(nestedRecord, 'status')
      : undefined;
    const directCode = readStringField(error, 'code');
    const nestedCode = nestedRecord
      ? readStringField(nestedRecord, 'code')
      : undefined;
    const directType = readStringField(error, 'type');
    const nestedType = nestedRecord
      ? readStringField(nestedRecord, 'type')
      : undefined;
    const directParam = readStringField(error, 'param');
    const nestedParam = nestedRecord
      ? readStringField(nestedRecord, 'param')
      : undefined;

    return {
      message: directMessage ?? nestedMessage ?? initial.message,
      source:
        initial.source !== 'generic' ||
        directStatus !== undefined ||
        directCode !== undefined ||
        directType !== undefined ||
        directParam !== undefined ||
        nestedStatus !== undefined ||
        nestedCode !== undefined ||
        nestedType !== undefined ||
        nestedParam !== undefined
          ? initial.source === 'generic'
            ? 'sdk'
            : initial.source
          : initial.source,
      status: initial.status ?? directStatus ?? nestedStatus,
      code: initial.code ?? directCode ?? nestedCode,
      type: initial.type ?? directType ?? nestedType,
      param: initial.param ?? directParam ?? nestedParam,
    };
  }

  private isPreviousResponseIdTextMatch(message: string): boolean {
    const normalized = message.toLowerCase();
    return (
      normalized.includes('previous_response_id') ||
      normalized.includes('previous response id') ||
      normalized.includes('previous-response-id')
    );
  }

  private shouldRetryWithoutPreviousResponseId(error: unknown): boolean {
    const details = this.extractResponseError(error);

    if (details.param === 'previous_response_id') {
      return true;
    }

    if (
      typeof details.code === 'string' &&
      PREVIOUS_RESPONSE_ID_ERROR_CODES.has(details.code)
    ) {
      return true;
    }

    return this.isPreviousResponseIdTextMatch(details.message);
  }

  private describeTransportError(error: unknown): string {
    const parts: string[] = [];

    if (error instanceof WebSocketSessionError) {
      parts.push(`wsKind=${error.kind}`);
      if (error.statusCode !== undefined) {
        parts.push(`status=${error.statusCode}`);
      }
      if (error.closeCode !== undefined) {
        parts.push(`closeCode=${error.closeCode}`);
      }
    }

    const details = this.extractResponseError(error);
    if (details.source !== 'generic') {
      parts.push(`source=${details.source}`);
    }
    if (details.code) {
      parts.push(`code=${details.code}`);
    }
    if (details.status !== undefined) {
      parts.push(`status=${details.status}`);
    }
    if (details.param) {
      parts.push(`param=${details.param}`);
    }
    parts.push(`message=${details.message}`);
    return parts.join(' | ');
  }

  private countInputItems(input: OpenAIResponsesRequestBody['input']): number {
    return Array.isArray(input) ? input.length : 0;
  }

  async *streamChat(
    encodedModelId: string,
    model: ModelConfig,
    messages: readonly LanguageModelChatRequestMessage[],
    options: ProvideLanguageModelChatResponseOptions,
    performanceTrace: PerformanceTrace,
    token: CancellationToken,
    logger: RequestLogger,
    credential: AuthTokenInfo,
  ): AsyncGenerator<vscode.LanguageModelResponsePart2> {
    const abortController = new AbortController();
    const cancellationListener = token.onCancellationRequested(() => {
      abortController.abort();
    });
    if (token.isCancellationRequested) {
      abortController.abort();
      cancellationListener.dispose();
      return;
    }

    const expectedIdentity = createStatefulMarkerIdentity(this.config, model);
    const sanitization = sanitizeMessagesForModelSwitchDetailed(messages, {
      modelId: encodedModelId,
      expectedIdentity,
      imageRetention:
        model.capabilities?.imageInput === true ? 'all' : 'discard',
    });
    const sanitizedMessages = sanitization.messages;

    const {
      input: convertedMessages,
      sessionId,
      previousResponseId,
      inputAfterPreviousResponse,
      previousResponseBoundaryIndex,
    } = this.convertMessages(
      encodedModelId,
      sanitizedMessages,
      expectedIdentity,
      sanitization.messageOriginIndexes,
    );
    const tools = this.convertTools(options.tools);
    const toolChoice = this.convertToolChoice(options.toolMode, tools);
    const streamEnabled = model.stream ?? true;
    const supportsPreviousResponseId =
      this.shouldEnableVolcContextCaching(model) ||
      isFeatureSupported(
        FeatureId.OpenAIUsePreviousResponseId,
        this.config,
        model,
      );
    const useThinkingParam2 = isFeatureSupported(
      FeatureId.OpenAIUseThinkingParam2,
      this.config,
      model,
    );
    const stripIncludeParam = isFeatureSupported(
      FeatureId.OpenAIStripIncludeParam,
      this.config,
      model,
    );
    const serviceTier = resolveOpenAIServiceTier(this.config, model);
    const transportMode = this.resolveTransportMode(streamEnabled);
    const canUsePreviousResponseId =
      previousResponseId !== undefined &&
      !this.hasSanitizedMessagesAfterBoundary(
        sanitization.sanitizedMessageIndexes,
        previousResponseBoundaryIndex,
      );

    const baseBody: OpenAIResponsesRequestBody = {
      model: getBaseModelId(model.id),
      input: convertedMessages,
      ...this.buildReasoningParams(model, useThinkingParam2),
      ...(serviceTier !== undefined ? { service_tier: serviceTier } : {}),
      ...(model.verbosity ? { text: { verbosity: model.verbosity } } : {}),
      ...(model.maxOutputTokens !== undefined
        ? { max_output_tokens: model.maxOutputTokens }
        : {}),
      ...(model.temperature !== undefined
        ? { temperature: model.temperature }
        : {}),
      ...(model.topP !== undefined ? { top_p: model.topP } : {}),
      ...(model.parallelToolCalling !== undefined
        ? { parallel_tool_calls: model.parallelToolCalling }
        : {}),
      ...(tools !== undefined ? { tools } : {}),
      ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
      stream: streamEnabled,
      ...(stripIncludeParam
        ? {}
        : { include: ['reasoning.encrypted_content'] }),
    };

    this.handleRequest(sessionId, baseBody);

    Object.assign(baseBody, this.config.extraBody, model.extraBody);
    this.applyVolcContextCaching(model, baseBody);

    const httpIncludeResponseIdInMarker =
      this.shouldIncludeResponseIdInMarker(baseBody);
    const httpContinuation =
      supportsPreviousResponseId && canUsePreviousResponseId
        ? this.resolveResponseContinuation(
            baseBody,
            previousResponseId,
            inputAfterPreviousResponse,
          )
        : undefined;
    if (
      supportsPreviousResponseId &&
      previousResponseId &&
      !canUsePreviousResponseId
    ) {
      logger.verbose(
        'Skipping previous_response_id because messages after the latest trusted response boundary were sanitized.',
      );
    }
    const fullInput = baseBody.input;

    const headers = this.buildHeaders(
      sessionId,
      credential,
      model,
      sanitizedMessages,
    );
    const webSocketHeaders = this.buildWebSocketHeaders(
      sessionId,
      credential,
      model,
      sanitizedMessages,
    );

    const baseContext: OpenAIResponsesRequestContext = {
      sessionId,
      streamEnabled,
      baseBody,
      fullInput,
      headers,
      abortController,
      token,
      logger,
      performanceTrace,
      expectedIdentity,
      credential,
      imageGenerationOutputMimeType:
        this.resolveImageGenerationOutputMimeType(baseBody.tools),
    };
    const httpContext: OpenAIResponsesHttpRequestContext = {
      ...baseContext,
      continuation: httpContinuation,
      includeResponseIdInMarker: httpIncludeResponseIdInMarker,
    };

    performanceTrace.ttf = Date.now() - performanceTrace.tts;
    logger.verbose(
      `OpenAI Responses transport selected | configured=${this.config.transport ?? 'default'} | effective=${transportMode} | stream=${streamEnabled ? 'true' : 'false'} | session=${sessionId} | previousResponseId=${previousResponseId ? 'present' : 'absent'} | store=${baseBody.store === false ? 'false' : 'default/true'} | websocketCapability=${this.websocketCapability}`,
    );

    try {
      if (transportMode === 'sse') {
        yield* this.streamChatOverHttp(httpContext);
        return;
      }

      if (
        transportMode === 'auto' &&
        this.websocketCapability === 'unsupported'
      ) {
        logger.verbose(
          'OpenAI Responses transport auto skipped WebSocket because this endpoint was previously marked unsupported; using SSE.',
        );
        yield* this.streamChatOverHttp(httpContext);
        return;
      }

      const webSocketSessionKey = this.createWebSocketSessionKey(
        sessionId,
        webSocketHeaders,
      );
      const hasHotWebSocketSession =
        webSocketSessionManager.hasSession(webSocketSessionKey);
      const webSocketContinuation =
        supportsPreviousResponseId && canUsePreviousResponseId
          ? this.resolveResponseContinuation(
              baseBody,
              previousResponseId,
              inputAfterPreviousResponse,
              {
                allowStoreFalse: hasHotWebSocketSession,
              },
            )
          : undefined;
      const webSocketContext: OpenAIResponsesWebSocketRequestContext = {
        ...baseContext,
        continuation: webSocketContinuation,
        includeResponseIdInMarker: this.shouldIncludeResponseIdInMarker(
          baseBody,
          {
            allowStoreFalse: true,
          },
        ),
        sessionKey: webSocketSessionKey,
        hadHotSessionAtStart: hasHotWebSocketSession,
        webSocketHeaders,
      };

      try {
        yield* this.streamChatOverWebSocket(
          webSocketContext,
          transportMode === 'auto',
        );
      } catch (error) {
        if (
          transportMode !== 'auto' ||
          !(error instanceof OpenAIResponsesWebSocketFallbackError)
        ) {
          throw error;
        }

        logger.verbose(
          'Falling back to SSE after failing to establish an OpenAI Responses WebSocket turn.',
        );
        yield* this.streamChatOverHttp(httpContext);
      }
    } finally {
      cancellationListener.dispose();
    }
  }

  private async *streamChatOverHttp(
    context: OpenAIResponsesHttpRequestContext,
  ): AsyncGenerator<vscode.LanguageModelResponsePart2> {
    const client = this.createClient(
      context.logger,
      context.streamEnabled,
      context.credential,
      context.abortController.signal,
    );

    let shouldUseContinuation = context.continuation !== undefined;
    let attempt = 0;

    while (true) {
      attempt += 1;
      context.performanceTrace.ttf = Date.now() - context.performanceTrace.tts;
      const requestBody = this.buildRequestBodyForAttempt(
        context.baseBody,
        context.fullInput,
        context.continuation,
        shouldUseContinuation,
        context.streamEnabled,
      );
      context.logger.verbose(
        `OpenAI Responses HTTP attempt ${attempt} | transport=${context.streamEnabled ? 'sse' : 'http'} | session=${context.sessionId} | continuation=${shouldUseContinuation ? 'previous_response_id' : 'full_input'} | inputItems=${this.countInputItems(requestBody.input)} | store=${requestBody.store === false ? 'false' : 'default/true'}`,
      );
      let emittedPartCount = 0;

      try {
        if (context.streamEnabled) {
          const responseTimeoutMs = resolveChatNetwork(this.config).timeout
            .response;

          const stream = await client.responses.create(
            { ...requestBody, stream: true },
            {
              headers: context.headers,
              signal: context.abortController.signal,
            },
          );
          const timedStream = withIdleTimeout(
            stream,
            responseTimeoutMs,
            context.abortController.signal,
          );
          for await (const part of this.parseMessageStream(
            timedStream,
            context.sessionId,
            context.token,
            context.logger,
            context.performanceTrace,
            context.expectedIdentity,
            context.includeResponseIdInMarker,
            context.streamEnabled ? 'sse' : 'http',
            context.imageGenerationOutputMimeType,
          )) {
            emittedPartCount++;
            yield part;
          }
        } else {
          const data = await client.responses.create(
            { ...requestBody, stream: false },
            {
              headers: context.headers,
              signal: context.abortController.signal,
            },
          );
          for await (const part of this.parseMessage(
            data,
            context.sessionId,
            context.performanceTrace,
            context.logger,
            context.expectedIdentity,
            context.includeResponseIdInMarker,
            'http',
            context.imageGenerationOutputMimeType,
          )) {
            emittedPartCount++;
            yield part;
          }
        }
        return;
      } catch (error) {
        if (
          !shouldUseContinuation ||
          emittedPartCount > 0 ||
          !this.shouldRetryWithoutPreviousResponseId(error)
        ) {
          throw error;
        }

        context.logger.verbose(
          'Provider rejected previous_response_id; retrying without previous_response_id.',
        );
        shouldUseContinuation = false;
      }
    }
  }

  private async *streamChatOverWebSocket(
    context: OpenAIResponsesWebSocketRequestContext,
    allowFallback: boolean,
  ): AsyncGenerator<vscode.LanguageModelResponsePart2> {
    const client = this.createClient(
      context.logger,
      true,
      context.credential,
      undefined,
    );
    const connectionTimeoutMs = resolveChatNetwork(this.config).timeout
      .connection;
    let shouldUseContinuation = context.continuation !== undefined;
    let shouldForceNewConnection = false;
    let retriedForConnectionLimit = false;
    let attempt = 0;

    while (true) {
      attempt += 1;
      context.performanceTrace.ttf = Date.now() - context.performanceTrace.tts;
      let request: WebSocketSessionRequest<ResponseStreamEvent> | undefined;
      let responseEstablished = false;

      try {
        const requestPayload = this.transformWebSocketRequestPayload(
          this.buildWebSocketRequestForAttempt(
            context.baseBody,
            context.fullInput,
            context.continuation,
            shouldUseContinuation,
          ),
        );
        const requestInput =
          requestPayload.type === 'response.create'
            ? requestPayload.input
            : undefined;
        context.logger.verbose(
          `OpenAI Responses WebSocket attempt ${attempt} | mode=${allowFallback ? 'auto' : 'websocket'} | session=${context.sessionId} | baseUrl=${this.resolveWebSocketBaseUrl(client)} | hotSessionAtStart=${context.hadHotSessionAtStart ? 'true' : 'false'} | continuation=${shouldUseContinuation ? 'previous_response_id' : 'full_input'} | forceNewConnection=${shouldForceNewConnection ? 'true' : 'false'} | inputItems=${this.countInputItems(requestInput)} | store=${requestPayload.store === false ? 'false' : 'default/true'}`,
        );
        request = await webSocketSessionManager.createRequest(
          {
            sessionKey: context.sessionKey,
            connectionTimeoutMs,
            createTransport: () =>
              this.createWebSocketTransport(client, context.webSocketHeaders),
          },
          requestPayload,
          {
            signal: context.abortController.signal,
            forceNewConnection: shouldForceNewConnection,
          },
        );
        context.logger.verbose(
          `OpenAI Responses WebSocket connection ready | attempt=${attempt} | session=${context.sessionId} | connection=${request.reusedConnection ? 'reused' : 'new'}`,
        );
        shouldForceNewConnection = false;

        const stream =
          (async function* (): AsyncGenerator<ResponseStreamEvent> {
            for await (const event of request.stream) {
              if (event.type.startsWith('response.')) {
                if (!responseEstablished) {
                  context.logger.verbose(
                    `OpenAI Responses WebSocket response established | attempt=${attempt} | session=${context.sessionId} | firstEvent=${event.type} | connection=${request?.reusedConnection ? 'reused' : 'new'}`,
                  );
                }
                responseEstablished = true;
              }
              yield event;

              if (
                event.type === 'response.completed' ||
                event.type === 'response.failed' ||
                event.type === 'response.incomplete'
              ) {
                return;
              }
            }
          })();

        for await (const part of this.parseMessageStream(
          stream,
          context.sessionId,
          context.token,
          context.logger,
          context.performanceTrace,
          context.expectedIdentity,
          context.includeResponseIdInMarker,
          'websocket',
          context.imageGenerationOutputMimeType,
        )) {
          yield part;
        }

        request.release();
        this.websocketCapability = 'supported';
        context.logger.verbose(
          `OpenAI Responses WebSocket turn completed | attempt=${attempt} | session=${context.sessionId} | connection=${request.reusedConnection ? 'reused' : 'new'}`,
        );
        return;
      } catch (error) {
        request?.release();

        if (
          context.abortController.signal.aborted ||
          (error instanceof WebSocketSessionError &&
            error.kind === 'request_aborted')
        ) {
          throw error;
        }

        if (responseEstablished) {
          this.websocketCapability = 'supported';
          context.logger.verbose(
            `OpenAI Responses WebSocket turn failed after establishment | attempt=${attempt} | session=${context.sessionId} | ${this.describeTransportError(error)}`,
          );
          throw error;
        }

        if (this.shouldMarkWebSocketUnsupported(error)) {
          this.websocketCapability = 'unsupported';
          context.logger.verbose(
            `OpenAI Responses WebSocket endpoint marked unsupported | attempt=${attempt} | session=${context.sessionId} | ${this.describeTransportError(error)}`,
          );
        }

        const details = this.extractResponseError(error);
        context.logger.verbose(
          `OpenAI Responses WebSocket attempt failed before establishment | attempt=${attempt} | session=${context.sessionId} | ${this.describeTransportError(error)}`,
        );
        if (
          shouldUseContinuation &&
          this.shouldRetryWithoutPreviousResponseId(error)
        ) {
          context.logger.verbose(
            `OpenAI Responses WebSocket continuation failed; retrying without previous_response_id | attempt=${attempt} | session=${context.sessionId}.`,
          );
          shouldUseContinuation = false;
          continue;
        }

        if (
          details.code === WEBSOCKET_CONNECTION_LIMIT_ERROR_CODE &&
          !retriedForConnectionLimit
        ) {
          retriedForConnectionLimit = true;
          shouldForceNewConnection = true;
          context.logger.verbose(
            `OpenAI Responses WebSocket hit the connection limit; reconnecting once before continuing | attempt=${attempt} | session=${context.sessionId}.`,
          );
          webSocketSessionManager.closeSession(
            context.sessionKey,
            WEBSOCKET_CONNECTION_LIMIT_ERROR_CODE,
          );
          continue;
        }

        if (allowFallback) {
          context.logger.verbose(
            `OpenAI Responses WebSocket falling back to SSE | attempt=${attempt} | session=${context.sessionId} | ${this.describeTransportError(error)}`,
          );
          throw new OpenAIResponsesWebSocketFallbackError(
            'OpenAI Responses WebSocket turn could not be established.',
            error,
          );
        }

        throw error;
      }
    }
  }

  private async *parseMessage(
    message: OpenAIResponse,
    sessionId: string,
    performanceTrace: PerformanceTrace,
    logger: RequestLogger,
    expectedIdentity: string,
    includeResponseIdInMarker: boolean,
    transportLabel: 'http' | 'sse' | 'websocket',
    imageGenerationOutputMimeType: string,
  ): AsyncGenerator<vscode.LanguageModelResponsePart2> {
    // NOTE: The current behavior of VSCode is such that all Parts returned here will be
    // aggregated into a single Part during the next request, and only the Thinking part
    // will be retained during the tool invocation round; most other types of Parts
    // will be directly ignored, which can prevent us from sending the original data
    // to the model provider and thus compromise full context and prompt caching support.
    // we can only use two approaches simultaneously:
    // 1. use the metadata attribute already in use in vscode-copilot-chat to restore the Thinking part,
    // ensuring basic compatibility across different models.
    // 2. always send a StatefulMarker DataPart containing the complete, raw response data, to maximize context restoration.

    logger.providerResponseChunk(
      `[responses:${transportLabel}] ${JSON.stringify(message)}`,
    );

    performanceTrace.ttft =
      Date.now() - (performanceTrace.tts + performanceTrace.ttf);

    const reasonings = message.output.filter(
      (v): v is ResponseReasoningItem => v.type === 'reasoning',
    );

    yield* this.extractThinkingParts(reasonings);

    for (const item of message.output) {
      switch (item.type) {
        case 'reasoning':
          // hadnle it already.
          break;

        case 'message':
          for (const part of item.content) {
            switch (part.type) {
              case 'output_text':
                if (part.text) {
                  yield new vscode.LanguageModelTextPart(part.text);
                }
                break;
              case 'refusal':
                if (part.refusal) {
                  yield new vscode.LanguageModelTextPart(part.refusal);
                }
                break;
            }
          }
          break;

        case 'function_call':
          yield new vscode.LanguageModelToolCallPart(
            item.call_id,
            item.name,
            this.parseArguments(item.arguments),
          );
          break;

        case 'image_generation_call': {
          const imagePart = this.emitImageGenerationCallPart(
            item,
            imageGenerationOutputMimeType,
          );
          if (imagePart) {
            yield imagePart;
          }
          break;
        }

        default:
          throw new Error(`Unsupported output item type: ${item.type}`);
      }
    }

    const markerData: OpenAIResponsesMarkerData = {
      data: message.output,
      sessionId,
    };
    if (includeResponseIdInMarker) {
      markerData.responseId = message.id;
    }
    yield encodeStatefulMarkerPart<OpenAIResponsesMarkerData>(
      expectedIdentity,
      markerData,
    );

    if (message.usage) {
      this.processUsage(message.usage, performanceTrace, logger);
    }
  }

  private stringifyArguments(input: unknown): string {
    try {
      return JSON.stringify(input ?? {});
    } catch {
      return '{}';
    }
  }

  private parseArguments(argumentsJson: string): object {
    return parseToolArguments(argumentsJson);
  }

  private resolveImageGenerationOutputMimeType(
    tools: ResponseCreateParamsBase['tools'],
  ): string {
    if (!tools) {
      return 'image/png';
    }

    for (const tool of tools) {
      if (!isResponseImageGenerationTool(tool)) {
        continue;
      }

      switch (tool.output_format) {
        case 'jpeg':
          return 'image/jpeg';
        case 'webp':
          return 'image/webp';
        case 'png':
        case undefined:
          return 'image/png';
        default:
          break;
      }
    }

    return 'image/png';
  }

  private emitImageGenerationCallPart(
    item: ResponseImageGenerationCall,
    mimeType: string,
  ): vscode.LanguageModelDataPart | undefined {
    const base64Data =
      typeof item.result === 'string' ? item.result.trim() : '';
    if (!base64Data) {
      return undefined;
    }

    return createImageDataPartFromBase64(base64Data, mimeType, mimeType);
  }

  private *emitThinkingText(
    type: ResponseThinkingContentType,
    text: string,
    emitMode: 'full' | 'metadata-only' | 'content-only',
    metadata: ThinkingBlockMetadata | undefined,
    state: ResponseThinkingOutputState,
  ): Generator<vscode.LanguageModelThinkingPart> {
    if (!text) {
      return;
    }

    const prefix =
      state.lastType !== undefined && state.lastType !== type ? '\n' : '';
    const output =
      prefix + (type === 'encrypted' ? ENCRYPTED_THINKING_PLACEHOLDER : text);

    if (emitMode !== 'metadata-only') {
      yield new vscode.LanguageModelThinkingPart(output);
    }

    if (metadata) {
      if (type === 'encrypted') {
        metadata.redactedData = text;
      } else {
        metadata._completeThinking = (metadata._completeThinking || '') + text;
      }
    }

    state.lastType = type;
  }

  private *extractThinkingParts(
    reasonings: readonly ResponseReasoningItem[],
    emitMode: 'full' | 'metadata-only' | 'content-only' = 'full',
    metadata?: ThinkingBlockMetadata,
    state: ResponseThinkingOutputState = {},
  ): Generator<vscode.LanguageModelThinkingPart> {
    if (emitMode !== 'content-only' && metadata == null) {
      metadata = {};
    }

    for (const reasoning of reasonings) {
      if (reasoning.encrypted_content) {
        yield* this.emitThinkingText(
          'encrypted',
          reasoning.encrypted_content,
          emitMode,
          metadata,
          state,
        );
      }

      for (const part of reasoning.summary) {
        if (part.type === 'summary_text') {
          yield* this.emitThinkingText(
            'summary',
            part.text,
            emitMode,
            metadata,
            state,
          );
        }
      }

      for (const part of reasoning.content ?? []) {
        if (part.type === 'reasoning_text') {
          yield* this.emitThinkingText(
            'content',
            part.text,
            emitMode,
            metadata,
            state,
          );
        }
      }
    }

    if (
      emitMode !== 'content-only' &&
      metadata &&
      Object.keys(metadata).length > 0
    ) {
      yield new vscode.LanguageModelThinkingPart('', undefined, metadata);
    }
  }

  private resolveCompletedStreamOutputItems(
    response: OpenAIResponse,
    addedOutputItems: ReadonlyMap<number, ResponseOutputItem>,
    completedOutputItems: ReadonlyMap<number, ResponseOutputItem>,
    logger: RequestLogger,
  ): ResponseOutputItem[] {
    const responseOutput = response.output.slice();
    if (
      responseOutput.length === 0 &&
      addedOutputItems.size === 0 &&
      completedOutputItems.size === 0
    ) {
      return responseOutput;
    }

    const outputIndexes = new Set<number>();
    for (let index = 0; index < responseOutput.length; index++) {
      outputIndexes.add(index);
    }
    for (const index of addedOutputItems.keys()) {
      outputIndexes.add(index);
    }
    for (const index of completedOutputItems.keys()) {
      outputIndexes.add(index);
    }

    const resolvedOutput = Array.from(outputIndexes)
      .sort((leftIndex, rightIndex) => leftIndex - rightIndex)
      .map(
        (index) =>
          completedOutputItems.get(index) ??
          responseOutput[index] ??
          addedOutputItems.get(index),
      )
      .filter((item): item is ResponseOutputItem => item !== undefined);

    if (
      responseOutput.length !== resolvedOutput.length ||
      (responseOutput.length === 0 && completedOutputItems.size > 0)
    ) {
      logger.verbose(
        `OpenAI Responses stream output differed from response.completed payload; merged ${resolvedOutput.length} output item(s) from stream state and completion payload.`,
      );
    }

    return resolvedOutput;
  }

  private async *parseMessageStream(
    stream: AsyncIterable<ResponseStreamEvent>,
    sessionId: string,
    token: vscode.CancellationToken,
    logger: RequestLogger,
    performanceTrace: PerformanceTrace,
    expectedIdentity: string,
    includeResponseIdInMarker: boolean,
    transportLabel: 'http' | 'sse' | 'websocket',
    imageGenerationOutputMimeType: string,
  ): AsyncGenerator<vscode.LanguageModelResponsePart2> {
    let usage: ResponseUsage | undefined;
    const emittedFunctionCallIds = new Set<string>();
    const addedOutputItems = new Map<number, ResponseOutputItem>();
    const completedOutputItems = new Map<number, ResponseOutputItem>();

    const recordFirstToken = createFirstTokenRecorder(performanceTrace);
    const thinkingOutputState: ResponseThinkingOutputState = {};

    const emitFunctionCallPart = (
      item: ResponseFunctionToolCall,
    ): vscode.LanguageModelToolCallPart | undefined => {
      const callId =
        typeof item.call_id === 'string' && item.call_id
          ? item.call_id
          : undefined;
      const name =
        typeof item.name === 'string' && item.name ? item.name : undefined;

      if (!callId || !name || emittedFunctionCallIds.has(callId)) {
        return undefined;
      }

      emittedFunctionCallIds.add(callId);
      const argumentsJson =
        typeof item.arguments === 'string' ? item.arguments : '{}';
      return new vscode.LanguageModelToolCallPart(
        callId,
        name,
        this.parseArguments(argumentsJson),
      );
    };

    for await (const event of stream) {
      if (token.isCancellationRequested) {
        break;
      }

      logger.providerResponseChunk(
        `[responses:${transportLabel}] ${JSON.stringify(event)}`,
      );

      recordFirstToken();

      switch (event.type) {
        case 'response.output_item.added':
          addedOutputItems.set(event.output_index, event.item);
          if (event.item.type === 'reasoning' && event.item.encrypted_content) {
            yield* this.emitThinkingText(
              'encrypted',
              event.item.encrypted_content,
              'content-only',
              undefined,
              thinkingOutputState,
            );
          }
          break;

        case 'response.output_text.delta':
          if (event.delta) {
            yield new vscode.LanguageModelTextPart(event.delta);
          }
          break;

        case 'response.refusal.delta':
          if (event.delta) {
            yield new vscode.LanguageModelTextPart(event.delta);
          }
          break;

        case 'response.reasoning_text.delta':
          if (event.delta) {
            yield* this.emitThinkingText(
              'content',
              event.delta,
              'content-only',
              undefined,
              thinkingOutputState,
            );
          }
          break;

        case 'response.reasoning_summary_text.delta':
          if (event.delta) {
            yield* this.emitThinkingText(
              'summary',
              event.delta,
              'content-only',
              undefined,
              thinkingOutputState,
            );
          }
          break;

        case 'response.output_item.done': {
          const item = event.item;
          completedOutputItems.set(event.output_index, item);
          if (item.type === 'function_call') {
            const part = emitFunctionCallPart(item);
            if (part) {
              yield part;
            }
          }
          break;
        }

        case 'response.completed': {
          const response = event.response;
          const completedOutput = this.resolveCompletedStreamOutputItems(
            response,
            addedOutputItems,
            completedOutputItems,
            logger,
          );
          usage = response.usage ?? undefined;

          for (const item of completedOutput) {
            if (item.type === 'function_call') {
              const part = emitFunctionCallPart(item);
              if (part) {
                yield part;
              }
              continue;
            }

            if (isResponseImageGenerationCall(item)) {
              const imagePart = this.emitImageGenerationCallPart(
                item,
                imageGenerationOutputMimeType,
              );
              if (imagePart) {
                yield imagePart;
              }
            }
          }
          const reasonings = completedOutput.filter(
            (v): v is ResponseReasoningItem => v.type === 'reasoning',
          );

          yield* this.extractThinkingParts(reasonings, 'metadata-only');

          const markerData: OpenAIResponsesMarkerData = {
            data: completedOutput,
            sessionId,
          };
          if (includeResponseIdInMarker) {
            markerData.responseId = response.id;
          }
          yield encodeStatefulMarkerPart<OpenAIResponsesMarkerData>(
            expectedIdentity,
            markerData,
          );
          break;
        }

        case 'response.failed':
          if (event.response.error) {
            const responseError = this.extractResponseError(
              event.response.error,
            );
            throw new OpenAIResponsesRequestError(
              `OpenAI Response Failed: ${responseError.message}${
                responseError.code ? ` (${responseError.code})` : ''
              }`,
              {
                source: 'stream',
                code: responseError.code,
                type: responseError.type,
                param: responseError.param,
                status: responseError.status,
              },
            );
          }
          throw new OpenAIResponsesRequestError(
            'OpenAI Response Failed: unknown error',
            { source: 'stream' },
          );

        case 'response.incomplete':
          throw new OpenAIResponsesRequestError(
            `OpenAI Response Incomplete: ${
              event.response.incomplete_details?.reason || 'unknown reason'
            }`,
            { source: 'stream' },
          );

        case 'error': {
          const responseError = this.extractResponseError(event);
          throw new OpenAIResponsesRequestError(
            `OpenAI API Error: ${responseError.message}${
              responseError.code ? ` (${responseError.code})` : ''
            }`,
            {
              source: 'stream',
              code: responseError.code,
              type: responseError.type,
              param: responseError.param,
              status: responseError.status,
            },
          );
        }

        default:
          break;
      }
    }

    // Check cancellation before post-loop processing
    if (token.isCancellationRequested) {
      return;
    }

    if (usage) {
      this.processUsage(usage, performanceTrace, logger);
    }
  }

  private processUsage(
    usage: ResponseUsage,
    performanceTrace: PerformanceTrace,
    logger: RequestLogger,
  ) {
    sharedProcessUsage(usage.output_tokens, performanceTrace, logger, usage);
  }

  estimateTokenCount(text: string): number {
    return sharedEstimateTokenCount(text);
  }

  async getAvailableModels(credential: AuthTokenInfo): Promise<ModelConfig[]> {
    const logger = createSimpleHttpLogger({
      purpose: 'Get Available Models',
      providerName: this.config.name,
      providerType: this.config.type,
    });
    try {
      const result: ModelConfig[] = [];
      const client = this.createClient(
        logger,
        false,
        credential,
        undefined,
        'normal',
      );
      const page = await client.models.list({
        headers: this.buildHeaders(this.generateSessionId(), credential),
      });
      for await (const model of page) {
        const name = model.name?.trim();
        result.push({
          id: model.id,
          ...(name ? { name } : {}),
        });
      }
      return result;
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }
}

export type OpenAIResponsesMarkerData = {
  /** Raw `response.output` items, preserved verbatim for follow-up requests. */
  data: ResponseOutputItem[];
  sessionId?: string;
  responseId?: string;
};
