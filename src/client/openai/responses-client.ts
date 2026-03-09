import {
  LanguageModelChatRequestMessage,
  ProvideLanguageModelChatResponseOptions,
  CancellationToken,
} from 'vscode';
import { createSimpleHttpLogger } from '../../logger';
import type { ProviderHttpLogger, RequestLogger } from '../../logger';
import { ThinkingBlockMetadata } from '../types';
import { FeatureId } from '../definitions';
import { ApiProvider } from '../interface';
import OpenAI from 'openai';
import type { AuthTokenInfo } from '../../auth/types';
import {
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
  sanitizeMessagesForModelSwitch,
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
import { randomUUID } from 'crypto';
import { ProviderConfig, ModelConfig, PerformanceTrace } from '../../types';

const VOLC_CONTEXT_CACHE_MAX_TTL_SECONDS = 604_800;
const PREVIOUS_RESPONSE_ID_ERROR_CODES = new Set<string>([
  'invalid_previous_response_id',
]);

type ConvertedMessagesResult = {
  input: ResponseInput;
  sessionId: string;
  previousResponseId?: string;
  inputAfterPreviousResponse?: ResponseInputItem[];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

export class OpenAIResponsesProvider implements ApiProvider {
  protected readonly baseUrl: string;

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

    const requestTimeoutMs = stream
      ? effectiveTimeout.connection
      : effectiveTimeout.response;

    const token = getToken(credential);

    return new OpenAI({
      apiKey: token ?? '',
      baseURL: this.baseUrl,
      maxRetries: 0,
      fetch: createCustomFetch({
        connectionTimeoutMs: requestTimeoutMs,
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
  ): ConvertedMessagesResult {
    let firstSessionId: string | null = null;
    let latestResponseId: string | undefined;
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

    for (const msg of messages) {
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
                  outItemsAfterLatestResponse = [];
                } else {
                  latestResponseId = undefined;
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
    }
    return result;
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
      parameters: (tool.inputSchema as Record<string, unknown>) ?? {
        type: 'object',
        properties: {},
        required: [],
      },
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
        return {
          thinking: { type: thinking.type },
          // Defaults to 'medium' effort
          reasoning: { effort: thinking.effort ?? 'medium' },
        };
      }
    } else {
      if (thinking.type === 'disabled') {
        return {
          reasoning: { effort: 'none' },
        };
      } else {
        return {
          // Defaults to 'medium' effort
          reasoning: { effort: thinking.effort ?? 'medium' },
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

  private resolveResponseContinuation(
    baseBody: ResponseCreateParamsBase,
    previousResponseId: string | undefined,
    inputAfterPreviousResponse: ResponseInputItem[] | undefined,
  ): ResponseContinuation | undefined {
    if (
      typeof previousResponseId !== 'string' ||
      !previousResponseId.trim() ||
      inputAfterPreviousResponse === undefined ||
      inputAfterPreviousResponse.length === 0
    ) {
      return undefined;
    }

    const body = baseBody as OpenAIResponsesRequestBody;
    if (body.store === false) {
      return undefined;
    }
    if (body.conversation !== undefined && body.conversation !== null) {
      return undefined;
    }

    return {
      previousResponseId: previousResponseId.trim(),
      inputAfterPreviousResponse,
    };
  }

  private buildRequestBodyForAttempt(
    baseBody: ResponseCreateParamsBase,
    fullInput: OpenAIResponsesRequestBody['input'],
    continuation: ResponseContinuation | undefined,
    useContinuation: boolean,
    stream: boolean,
  ): ResponseCreateParamsBase {
    const body: OpenAIResponsesRequestBody = {
      ...(baseBody as OpenAIResponsesRequestBody),
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

  private shouldIncludeResponseIdInMarker(
    baseBody: ResponseCreateParamsBase,
  ): boolean {
    return baseBody.store !== false;
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

    return (
      details.source === 'stream' &&
      this.isPreviousResponseIdTextMatch(details.message)
    );
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
    const sanitizedMessages = sanitizeMessagesForModelSwitch(messages, {
      modelId: encodedModelId,
      expectedIdentity,
    });

    const {
      input: convertedMessages,
      sessionId,
      previousResponseId,
      inputAfterPreviousResponse,
    } = this.convertMessages(
      encodedModelId,
      sanitizedMessages,
      expectedIdentity,
    );
    const tools = this.convertTools(options.tools);
    const toolChoice = this.convertToolChoice(options.toolMode, tools);
    const streamEnabled = model.stream ?? true;
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

    const baseBody: ResponseCreateParamsBase = {
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

    const includeResponseIdInMarker =
      this.shouldIncludeResponseIdInMarker(baseBody);
    const continuation = this.resolveResponseContinuation(
      baseBody,
      previousResponseId,
      inputAfterPreviousResponse,
    );
    const fullInput = baseBody.input;

    const headers = this.buildHeaders(
      sessionId,
      credential,
      model,
      sanitizedMessages,
    );

    const client = this.createClient(
      logger,
      streamEnabled,
      credential,
      abortController.signal,
    );

    performanceTrace.ttf = Date.now() - performanceTrace.tts;

    try {
      let shouldUseContinuation = continuation !== undefined;

      while (true) {
        performanceTrace.ttf = Date.now() - performanceTrace.tts;
        const requestBody = this.buildRequestBodyForAttempt(
          baseBody,
          fullInput,
          continuation,
          shouldUseContinuation,
          streamEnabled,
        );
        let emittedPartCount = 0;

        try {
          if (streamEnabled) {
            const responseTimeoutMs = resolveChatNetwork(this.config).timeout
              .response;

            const stream = await client.responses.create(
              { ...requestBody, stream: true },
              {
                headers,
                signal: abortController.signal,
              },
            );
            const timedStream = withIdleTimeout(
              stream,
              responseTimeoutMs,
              abortController.signal,
            );
            for await (const part of this.parseMessageStream(
              timedStream,
              sessionId,
              token,
              logger,
              performanceTrace,
              expectedIdentity,
              includeResponseIdInMarker,
            )) {
              emittedPartCount++;
              yield part;
            }
          } else {
            const data = await client.responses.create(
              { ...requestBody, stream: false },
              {
                headers,
                signal: abortController.signal,
              },
            );
            for await (const part of this.parseMessage(
              data,
              sessionId,
              performanceTrace,
              logger,
              expectedIdentity,
              includeResponseIdInMarker,
            )) {
              emittedPartCount++;
              yield part;
            }
          }
          break;
        } catch (error) {
          if (
            !shouldUseContinuation ||
            emittedPartCount > 0 ||
            !this.shouldRetryWithoutPreviousResponseId(error)
          ) {
            throw error;
          }

          logger.verbose(
            'Provider rejected previous_response_id; retrying without previous_response_id.',
          );
          shouldUseContinuation = false;
        }
      }
    } finally {
      cancellationListener.dispose();
    }
  }

  private async *parseMessage(
    message: OpenAIResponse,
    sessionId: string,
    performanceTrace: PerformanceTrace,
    logger: RequestLogger,
    expectedIdentity: string,
    includeResponseIdInMarker: boolean,
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

    logger.providerResponseChunk(JSON.stringify(message));

    performanceTrace.ttft =
      Date.now() - (performanceTrace.tts + performanceTrace.ttf);

    yield* this.extractThinkingParts(
      message.output.filter((v) => v.type === 'reasoning'),
    );

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

  private *extractThinkingParts(
    reasonings: (ResponseReasoningItem | string)[],
    emitMode: 'full' | 'metadata-only' | 'content-only' = 'full',
    metadata?: ThinkingBlockMetadata,
  ): Generator<vscode.LanguageModelThinkingPart> {
    if (emitMode !== 'content-only' && metadata == null) {
      metadata = {};
    }

    const emitText = function* (
      text: string,
    ): Generator<vscode.LanguageModelThinkingPart> {
      if (!text) return;
      if (emitMode !== 'metadata-only') {
        yield new vscode.LanguageModelThinkingPart(text);
      }
      if (metadata) {
        metadata._completeThinking = (metadata._completeThinking || '') + text;
      }
    };

    for (const reasoning of reasonings) {
      if (typeof reasoning === 'string') {
        yield* emitText(reasoning);
        continue;
      }

      for (const part of reasoning.summary) {
        if (part.type === 'summary_text') {
          yield* emitText(part.text);
        }
      }

      for (const part of reasoning.content ?? []) {
        if (part.type === 'reasoning_text') {
          yield* emitText(part.text);
        }
      }

      if (reasoning.encrypted_content) {
        if (emitMode !== 'metadata-only') {
          yield new vscode.LanguageModelThinkingPart('Encrypted thinking...');
        }
        if (metadata) {
          metadata.redactedData = reasoning.encrypted_content;
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

  private async *parseMessageStream(
    stream: AsyncIterable<ResponseStreamEvent>,
    sessionId: string,
    token: vscode.CancellationToken,
    logger: RequestLogger,
    performanceTrace: PerformanceTrace,
    expectedIdentity: string,
    includeResponseIdInMarker: boolean,
  ): AsyncGenerator<vscode.LanguageModelResponsePart2> {
    let usage: ResponseUsage | undefined;

    const recordFirstToken = createFirstTokenRecorder(performanceTrace);

    for await (const event of stream) {
      if (token.isCancellationRequested) {
        break;
      }

      logger.providerResponseChunk(JSON.stringify(event));

      recordFirstToken();

      switch (event.type) {
        case 'response.output_item.added':
          if (event.item.type === 'reasoning' && event.item.encrypted_content) {
            yield* this.extractThinkingParts([event.item], 'content-only');
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
            yield* this.extractThinkingParts([event.delta], 'content-only');
          }
          break;

        case 'response.reasoning_summary_text.delta':
          if (event.delta) {
            yield* this.extractThinkingParts([event.delta], 'content-only');
          }
          break;

        case 'response.output_item.done': {
          const item = event.item;
          if (item.type === 'function_call') {
            yield new vscode.LanguageModelToolCallPart(
              item.call_id,
              item.name,
              this.parseArguments(item.arguments),
            );
          }
          break;
        }

        case 'response.completed': {
          const response = event.response;
          usage = response.usage ?? undefined;

          yield* this.extractThinkingParts(
            response.output.filter((v) => v.type === 'reasoning'),
            'metadata-only',
          );

          const markerData: OpenAIResponsesMarkerData = {
            data: response.output,
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

        case 'error':
          throw new OpenAIResponsesRequestError(
            `OpenAI API Error: ${event.message}${
              event.code ? ` (${event.code})` : ''
            }`,
            { source: 'stream', code: event.code ?? undefined },
          );

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
        result.push({ id: model.id });
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
