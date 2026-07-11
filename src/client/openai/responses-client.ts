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
  isRawBaseUrlEnabled,
  isUsageMarker,
  normalizeImageMimeType,
  resolveContextCacheConfig,
  resolveChatNetwork,
  resolveSdkTotalTimeoutMs,
  sanitizeMessagesForModelSwitchDetailed,
  tryNormalizeCopilotUsage,
  withIdleTimeout,
} from '../../utils';
import {
  buildBaseUrl,
  createCustomFetch,
  createFirstTokenRecorder,
  createCopilotUsage,
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
  ResponseCompactionItemParam,
  ResponseCompactParams,
  ResponseCreateParamsBase,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponsesClientEvent,
  ResponseComputerToolCallOutputItem,
  ResponseFunctionCallOutputItem,
  ResponseFunctionToolCall,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseReasoningItem,
  ResponseStreamEvent,
  ResponseUsage,
  ToolChoiceFunction,
  ToolChoiceOptions,
} from 'openai/resources/responses/responses';
import type {
  BetaResponse as OpenAIBetaResponse,
  BetaResponseInputItem,
  BetaResponseOutputItem,
  BetaResponseStreamEvent,
  BetaResponsesClientEvent,
  ResponseCreateParamsBase as BetaResponseCreateParamsBase,
  ResponseCreateParamsNonStreaming as BetaResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming as BetaResponseCreateParamsStreaming,
} from 'openai/resources/beta/responses/responses';
import { getBaseModelId } from '../../model-id-utils';
import { createHash, randomUUID } from 'crypto';
import {
  ChatRequestTrace,
  CopilotUsage,
  ProviderConfig,
  ModelConfig,
} from '../../types';
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
const RESPONSES_CONTEXT_COMPACTION_FALLBACK_THRESHOLD = 50_000;
const RESPONSES_COMPACTION_THRESHOLD_RATIO = 0.9;
const RESPONSES_CONTEXT_MANAGEMENT_EXCLUDED_BASE_MODELS = new Set([
  'gpt-5',
  'gpt-5.1',
  'gpt-5.2',
]);
const RESPONSES_COMPACTION_NOTICE = '[Remote compaction has been triggered.]';
const RESPONSES_MULTI_AGENT_BETA = 'responses_multi_agent=v1';

type ResolvedTransportMode = 'sse' | 'auto' | 'websocket';

type ConvertedMessagesResult = {
  input: OpenAIResponsesInput;
  sessionId: string;
  previousResponseId?: string;
  inputAfterPreviousResponse?: OpenAIResponsesInputItem[];
  previousResponseBoundaryIndex?: number;
  previousResponseInputBoundaryIndex?: number;
  previousResponseUsage?: CopilotUsage;
};

type ResponseContinuation = {
  previousResponseId: string;
  inputAfterPreviousResponse: OpenAIResponsesInputItem[];
};

type ResponseMultiAgentInputItem = Extract<
  BetaResponseInputItem,
  {
    type: 'agent_message' | 'multi_agent_call' | 'multi_agent_call_output';
  }
>;
type ResponseMultiAgentOutputItem = Extract<
  BetaResponseOutputItem,
  {
    type: 'agent_message' | 'multi_agent_call' | 'multi_agent_call_output';
  }
>;
type ResponseAgentAttributedInputItem = Extract<
  BetaResponseInputItem,
  { type: 'compaction' | 'additional_tools' }
>;
type ResponseAgentAttributedOutputItem = Extract<
  BetaResponseOutputItem,
  { type: 'compaction' | 'additional_tools' }
>;

type OpenAIResponsesInputItem =
  | ResponseInputItem
  | ResponseMultiAgentInputItem
  | ResponseAgentAttributedInputItem;
type OpenAIResponsesInput =
  | string
  | OpenAIResponsesInputItem[];
type OpenAIResponsesOutputItem =
  | ResponseOutputItem
  | ResponseMultiAgentOutputItem
  | ResponseAgentAttributedOutputItem;
type OpenAIResponsesResponse = OpenAIResponse | OpenAIBetaResponse;
export type OpenAIResponsesClientEvent =
  | ResponsesClientEvent
  | BetaResponsesClientEvent;
export type OpenAIResponsesStreamEvent =
  | ResponseStreamEvent
  | BetaResponseStreamEvent;

export type OpenAIResponsesRequestBody = Omit<
  ResponseCreateParamsBase,
  'conversation' | 'input' | 'tool_choice'
> & {
  betas?: BetaResponseCreateParamsBase['betas'];
  conversation?: BetaResponseCreateParamsBase['conversation'];
  input?: OpenAIResponsesInput;
  max_tool_calls?: BetaResponseCreateParamsBase['max_tool_calls'];
  multi_agent?: BetaResponseCreateParamsBase['multi_agent'];
  previous_response_id?: string;
  tool_choice?: ToolChoiceOptions | ToolChoiceFunction;
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
  requestTrace: ChatRequestTrace;
  expectedIdentity: string;
  credential: AuthTokenInfo;
  imageGenerationOutputMimeType: string;
  multiAgentEnabled: boolean;
};

type ResponseThinkingContentType = 'encrypted' | 'summary' | 'content';

type ResponseThinkingOutputState = {
  lastType?: ResponseThinkingContentType;
};

type ResponseImageGenerationCall = Extract<
  OpenAIResponsesOutputItem,
  { type: 'image_generation_call' }
>;

type ResponsesApiTool = NonNullable<ResponseCreateParamsBase['tools']>[number];

type ResponseImageGenerationTool = Extract<
  ResponsesApiTool,
  { type: 'image_generation' }
>;

type ResponseOutputItemForInput = Extract<ResponseOutputItem, ResponseInputItem>;
type ResponseAdditionalToolsInputItem = Extract<
  OpenAIResponsesInputItem,
  { type: 'additional_tools' }
>;

type ResponseAgentMessageOutputItem = Extract<
  ResponseMultiAgentOutputItem,
  { type: 'agent_message' }
>;

type ResponseAgentMessageInputItem = Extract<
  BetaResponseInputItem,
  { type: 'agent_message' }
>;

type ResponseMultiAgentCallOutputItem = Extract<
  ResponseMultiAgentOutputItem,
  { type: 'multi_agent_call_output' }
>;

type ResponseMultiAgentCallOutputInputItem = Extract<
  ResponseMultiAgentInputItem,
  { type: 'multi_agent_call_output' }
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

function readResponseInputItemType(
  item: OpenAIResponsesInputItem,
): string | undefined {
  if (!isRecord(item)) {
    return undefined;
  }

  const type = item.type;
  return typeof type === 'string' ? type : undefined;
}

function readResponseInputItemCallId(
  item: OpenAIResponsesInputItem,
): string | undefined {
  if (!isRecord(item)) {
    return undefined;
  }

  const callId = item.call_id;
  return typeof callId === 'string' && callId.trim() ? callId : undefined;
}

function omitFunctionCallsWithoutFollowingOutput(
  input: OpenAIResponsesRequestBody['input'],
): OpenAIResponsesRequestBody['input'] {
  if (!Array.isArray(input)) {
    return input;
  }

  const outputCallIdsAfter = new Set<string>();
  const retainedIndexes = new Set<number>();

  for (let index = input.length - 1; index >= 0; index--) {
    const item = input[index];
    const type = readResponseInputItemType(item);
    const callId = readResponseInputItemCallId(item);

    if (type === 'function_call_output') {
      if (callId) {
        outputCallIdsAfter.add(callId);
      }
      retainedIndexes.add(index);
      continue;
    }

    if (
      type !== 'function_call' ||
      (callId && outputCallIdsAfter.has(callId))
    ) {
      retainedIndexes.add(index);
    }
  }

  return retainedIndexes.size === input.length
    ? input
    : input.filter((_, index) => retainedIndexes.has(index));
}

function isResponseImageGenerationCall(
  item: OpenAIResponsesOutputItem,
): item is ResponseImageGenerationCall {
  return item.type === 'image_generation_call';
}

function normalizeResponseOutputItem(
  item: ResponseOutputItem | BetaResponseOutputItem,
): OpenAIResponsesOutputItem {
  // The beta union mirrors stable output items and adds these three variants.
  switch (item.type) {
    case 'agent_message':
    case 'multi_agent_call':
    case 'multi_agent_call_output':
      return item;
    default:
      return item;
  }
}

function normalizeResponseOutputItems(
  items: readonly (ResponseOutputItem | BetaResponseOutputItem)[],
): OpenAIResponsesOutputItem[] {
  return items.map((item) => normalizeResponseOutputItem(item));
}

function isResponseImageGenerationTool(
  tool: ResponsesApiTool,
): tool is ResponseImageGenerationTool {
  return tool.type === 'image_generation';
}

function isResponseComputerCallOutputItem(
  item: OpenAIResponsesOutputItem,
): item is ResponseComputerToolCallOutputItem {
  return item.type === 'computer_call_output';
}

function isResponseAdditionalToolsItem(
  item: OpenAIResponsesOutputItem,
): item is Extract<ResponseOutputItem, { type: 'additional_tools' }> {
  return item.type === 'additional_tools';
}

function isResponseOutputItemForInput(
  item: OpenAIResponsesOutputItem,
): item is ResponseOutputItemForInput {
  return (
    !isMultiAgentOutputItem(item) &&
    !isResponseComputerCallOutputItem(item) &&
    !isResponseAdditionalToolsItem(item)
  );
}

function normalizeComputerCallOutputStatus(
  status: ResponseComputerToolCallOutputItem['status'],
): NonNullable<ResponseInputItem.ComputerCallOutput['status']> {
  return status === 'failed' ? 'incomplete' : status;
}

function normalizeMarkerOutputItem(
  item: OpenAIResponsesOutputItem,
): OpenAIResponsesInputItem | undefined {
  switch (item.type) {
    case 'compaction': {
      const agentName = readAgentName(item);
      if (agentName !== undefined) {
        const inputItem: Extract<
          ResponseAgentAttributedInputItem,
          { type: 'compaction' }
        > = {
          encrypted_content: item.encrypted_content,
          id: item.id,
          type: item.type,
          agent: { agent_name: agentName },
        };
        return inputItem;
      }

      const inputItem: ResponseCompactionItemParam = {
        encrypted_content: item.encrypted_content,
        id: item.id,
        type: item.type,
      };
      return inputItem;
    }

    case 'computer_call_output':
      return {
        ...item,
        status: normalizeComputerCallOutputStatus(item.status),
      };

    case 'additional_tools':
      {
        const agentName = readAgentName(item);
        if (agentName !== undefined) {
          const inputItem: Extract<
            ResponseAgentAttributedInputItem,
            { type: 'additional_tools' }
          > = {
            id: item.id,
            role: 'developer',
            tools: item.tools,
            type: item.type,
            agent: { agent_name: agentName },
          };
          return inputItem;
        }
      }
      if (item.role === 'developer') {
        const inputItem: ResponseAdditionalToolsInputItem = {
          id: item.id,
          role: item.role,
          tools: item.tools,
          type: item.type,
        };
        return inputItem;
      }
      return undefined;

    case 'agent_message':
      return normalizeAgentMessageInputItem(item);

    case 'multi_agent_call':
      return item;

    case 'multi_agent_call_output':
      return normalizeMultiAgentCallOutputInputItem(item);

    default:
      return isResponseOutputItemForInput(item) ? item : undefined;
  }
}

function normalizeMultiAgentCallOutputInputItem(
  item: ResponseMultiAgentCallOutputItem,
): ResponseMultiAgentCallOutputInputItem {
  return {
    type: 'multi_agent_call_output',
    id: item.id,
    action: item.action,
    call_id: item.call_id,
    output: item.output.map((part) => ({
      type: 'output_text',
      text: part.text,
    })),
    ...(item.agent !== undefined ? { agent: item.agent } : {}),
  };
}

function normalizeAgentMessageInputItem(
  item: ResponseAgentMessageOutputItem,
): ResponseAgentMessageInputItem {
  const content: ResponseAgentMessageInputItem['content'] = [];
  for (const part of item.content) {
    switch (part.type) {
      case 'input_text':
      case 'input_image':
      case 'encrypted_content':
        content.push(part);
        break;
      case 'output_text':
      case 'text':
      case 'summary_text':
      case 'reasoning_text':
        content.push({ type: 'input_text', text: part.text });
        break;
      case 'refusal':
        content.push({ type: 'input_text', text: part.refusal });
        break;
      case 'computer_screenshot':
        content.push({
          type: 'input_image',
          detail: part.detail,
          file_id: part.file_id,
          image_url: part.image_url,
        });
        break;
      case 'input_file':
        break;
    }
  }

  return {
    type: 'agent_message',
    id: item.id,
    author: item.author,
    recipient: item.recipient,
    content,
    ...(item.agent !== undefined ? { agent: item.agent } : {}),
  };
}

function normalizeMarkerOutputItems(
  items: readonly OpenAIResponsesOutputItem[],
): OpenAIResponsesInputItem[] {
  return items.flatMap((item) => {
    const normalizedItem = normalizeMarkerOutputItem(item);
    return normalizedItem === undefined ? [] : [normalizedItem];
  });
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

function isMultiAgentOutputItem(
  item: OpenAIResponsesOutputItem,
): item is ResponseMultiAgentOutputItem {
  return (
    item.type === 'multi_agent_call' ||
    item.type === 'multi_agent_call_output' ||
    item.type === 'agent_message'
  );
}

function isStandardResponseInputItem(
  item: OpenAIResponsesInputItem,
): item is ResponseInputItem {
  const type = readResponseInputItemType(item);
  return (
    type !== 'multi_agent_call' &&
    type !== 'multi_agent_call_output' &&
    type !== 'agent_message'
  );
}

function readAgentName(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const agent = value['agent'];
  return isRecord(agent) ? readStringField(agent, 'agent_name') : undefined;
}

function isRootAgentOutput(value: unknown): boolean {
  const agentName = readAgentName(value);
  return agentName === undefined || agentName === '/root';
}

function describeMultiAgentAction(value: unknown): string {
  if (!isRecord(value)) {
    return 'performing a multi-agent action';
  }

  switch (readStringField(value, 'action')) {
    case 'spawn_agent':
      return 'starting a subagent';
    case 'interrupt_agent':
      return 'interrupting an agent';
    case 'list_agents':
      return 'checking agent status';
    case 'send_message':
      return 'sending a message';
    case 'followup_task':
      return 'assigning follow-up work';
    case 'wait_agent':
      return 'waiting for agents';
    default:
      return 'performing a multi-agent action';
  }
}

function formatMultiAgentOutputItem(
  item: ResponseMultiAgentOutputItem,
): string {
  if (item.type === 'agent_message') {
    const author = item.author.trim() || '/root';
    const recipient = item.recipient.trim() || 'an agent';
    return `[Agent ${author} sent a message to ${recipient}.]`;
  }

  const agentName = readAgentName(item) ?? '/root';
  const action = describeMultiAgentAction(item);
  return item.type === 'multi_agent_call'
    ? `[Agent ${agentName} is ${action}.]`
    : `[Agent ${agentName} finished ${action}.]`;
}

function createResponsesMarkerIdentity(
  config: ProviderConfig,
  model: ModelConfig,
  multiAgentEnabled: boolean,
): string {
  const baseIdentity = createStatefulMarkerIdentity(config, model);
  return multiAgentEnabled
    ? `${baseIdentity}|responses_multi_agent=true`
    : baseIdentity;
}

function updateResponsesMultiAgentBetaHeader(
  headers: Record<string, string>,
  enabled: boolean,
): void {
  const values: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'openai-beta') {
      continue;
    }
    delete headers[key];
    values.push(...value.split(',').map((part) => part.trim()));
  }

  const retainedValues = values.filter(
    (value) =>
      value.length > 0 &&
      value.toLowerCase() !== RESPONSES_MULTI_AGENT_BETA,
  );
  if (enabled) {
    retainedValues.push(RESPONSES_MULTI_AGENT_BETA);
  }
  if (retainedValues.length > 0) {
    headers['OpenAI-Beta'] = Array.from(new Set(retainedValues)).join(', ');
  }
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
      useRawBaseUrl: isRawBaseUrlEnabled(config),
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
    const proxy = chatNetwork?.proxy ?? resolveChatNetwork(this.config).proxy;
    const effectiveTimeout =
      chatNetwork?.timeout ?? DEFAULT_NORMAL_TIMEOUT_CONFIG;

    const sdkTimeoutMs = resolveSdkTotalTimeoutMs(effectiveTimeout, stream);

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
        proxy,
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
    multiAgentEnabled: boolean,
  ): WebSocketSessionTransport<
    OpenAIResponsesClientEvent,
    OpenAIResponsesStreamEvent
  > {
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

    return new OpenAIResponsesWebSocketTransport(
      transportClient,
      headers,
      multiAgentEnabled,
    );
  }

  protected transformWebSocketRequestPayload(
    payload: OpenAIResponsesClientEvent,
  ): OpenAIResponsesClientEvent {
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
    let latestResponseBoundaryItem: EasyInputMessage | undefined;
    let latestResponseInputBoundaryIndex: number | undefined;
    let latestResponseUsage: CopilotUsage | undefined;
    let outItemsAfterLatestResponse: OpenAIResponsesInputItem[] = [];
    const outItems: OpenAIResponsesInputItem[] = [];
    const rawMap = new Map<
      OpenAIResponsesInputItem,
      OpenAIResponsesMarkerData['data']
    >();
    const appendOutItem = (item: OpenAIResponsesInputItem): void => {
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
                  usage,
                } = decodeStatefulMarkerPart<OpenAIResponsesMarkerData>(
                  expectedIdentity,
                  encodedModelId,
                  markerParts[0],
                );
                if (firstSessionId == null && sessionId) {
                  firstSessionId = sessionId;
                }
                const item: EasyInputMessage = {
                  role: 'assistant',
                  content: '',
                };
                if (typeof responseId === 'string' && responseId.trim()) {
                  latestResponseId = responseId;
                  latestResponseBoundaryIndex =
                    messageOriginIndexes?.[messageIndex] ?? messageIndex;
                  latestResponseBoundaryItem = item;
                  latestResponseUsage = tryNormalizeCopilotUsage(usage);
                  outItemsAfterLatestResponse = [];
                } else {
                  latestResponseId = undefined;
                  latestResponseBoundaryIndex = undefined;
                  latestResponseBoundaryItem = undefined;
                  latestResponseInputBoundaryIndex = undefined;
                  latestResponseUsage = undefined;
                  outItemsAfterLatestResponse = [];
                }
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
      const normalizedRaw = normalizeMarkerOutputItems(raw);
      outItems.splice(index, 1, ...normalizedRaw);
      if (param === latestResponseBoundaryItem) {
        latestResponseInputBoundaryIndex = index + normalizedRaw.length;
      }
    }

    const result: ConvertedMessagesResult = {
      input: outItems,
      sessionId: firstSessionId ?? this.generateSessionId(),
    };
    if (latestResponseId !== undefined) {
      result.previousResponseId = latestResponseId;
      result.inputAfterPreviousResponse = outItemsAfterLatestResponse;
      result.previousResponseBoundaryIndex = latestResponseBoundaryIndex;
      result.previousResponseInputBoundaryIndex =
        latestResponseInputBoundaryIndex;
      result.previousResponseUsage = latestResponseUsage;
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
      } else if (isInternalMarker(part) || isUsageMarker(part)) {
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
          effort: this.normalizeReasoningEffortForOpenAi(model),
        };
        if (thinking.summary !== undefined && thinking.summary !== 'none') {
          reasoning.summary = thinking.summary;
        }
        if (thinking.mode !== undefined) {
          reasoning.mode = thinking.mode;
        }
        if (thinking.context !== undefined) {
          reasoning.context = thinking.context;
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
          effort: this.normalizeReasoningEffortForOpenAi(model),
        };
        if (thinking.summary !== undefined && thinking.summary !== 'none') {
          reasoning.summary = thinking.summary;
        }
        if (thinking.mode !== undefined) {
          reasoning.mode = thinking.mode;
        }
        if (thinking.context !== undefined) {
          reasoning.context = thinking.context;
        }
        return {
          // Defaults to 'medium' effort
          reasoning,
        };
      }
    }
  }

  private normalizeReasoningEffortForOpenAi(
    model: ModelConfig,
  ): 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
    const effort = model.thinking?.effort;
    if (effort === undefined) {
      return 'medium';
    }
    if (effort !== 'max') {
      return effort;
    }

    const baseModelId = getBaseModelId(model.id).toLowerCase();
    const family = model.family?.trim().toLowerCase();
    return /^gpt-5\.6(?:-|$)/.test(baseModelId) ||
      (family !== undefined && /^gpt-5\.6(?:-|$)/.test(family))
      ? 'max'
      : 'xhigh';
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

  protected shouldEnableResponsesContextManagement(
    model: ModelConfig,
  ): boolean {
    if (!this.isResponsesContextManagementModelSupported(model)) {
      return false;
    }

    return isFeatureSupported(
      FeatureId.OpenAIUseResponsesContextManagement,
      this.config,
      model,
    );
  }

  protected isResponsesContextManagementModelSupported(
    model: ModelConfig,
  ): boolean {
    const baseModelId = getBaseModelId(model.id).toLowerCase();
    return !RESPONSES_CONTEXT_MANAGEMENT_EXCLUDED_BASE_MODELS.has(baseModelId);
  }

  private resolveResponsesContextCompactionThreshold(
    model: ModelConfig,
  ): number | undefined {
    if (!this.shouldEnableResponsesContextManagement(model)) {
      return undefined;
    }

    if (
      typeof model.maxInputTokens === 'number' &&
      Number.isFinite(model.maxInputTokens) &&
      model.maxInputTokens > 0
    ) {
      return Math.floor(
        model.maxInputTokens * RESPONSES_COMPACTION_THRESHOLD_RATIO,
      );
    }

    return RESPONSES_CONTEXT_COMPACTION_FALLBACK_THRESHOLD;
  }

  private applyResponsesContextManagement(
    model: ModelConfig,
    baseBody: OpenAIResponsesRequestBody,
  ): boolean {
    if (baseBody.context_management !== undefined) {
      return false;
    }

    const compactThreshold =
      this.resolveResponsesContextCompactionThreshold(model);
    if (compactThreshold === undefined) {
      return false;
    }

    baseBody.context_management = [
      {
        type: 'compaction',
        compact_threshold: compactThreshold,
      },
    ];
    return true;
  }

  private isContextManagementExplicitlyConfigured(model: ModelConfig): boolean {
    return (
      Object.prototype.hasOwnProperty.call(
        this.config.extraBody ?? {},
        'context_management',
      ) ||
      Object.prototype.hasOwnProperty.call(
        model.extraBody ?? {},
        'context_management',
      )
    );
  }

  private shouldEnablePromptCacheKey(model: ModelConfig): boolean {
    return isFeatureSupported(
      FeatureId.OpenAIUsePromptCacheKey,
      this.config,
      model,
    );
  }

  private resolvePromptCacheKey(sessionId: string): string {
    return `ucp-${sessionId}`;
  }

  private applyPromptCacheKey(
    model: ModelConfig,
    sessionId: string,
    baseBody: OpenAIResponsesRequestBody,
  ): boolean {
    if (!this.shouldEnablePromptCacheKey(model)) {
      return false;
    }
    if (
      baseBody.prompt_cache_key !== undefined &&
      baseBody.prompt_cache_key !== null
    ) {
      return false;
    }

    baseBody.prompt_cache_key = this.resolvePromptCacheKey(sessionId);
    return true;
  }

  private shouldEnableStandaloneResponsesCompaction(
    model: ModelConfig,
  ): boolean {
    return isFeatureSupported(
      FeatureId.OpenAIUseStandaloneResponsesCompaction,
      this.config,
      model,
    );
  }

  private applyResponsesMultiAgentConfig(
    model: ModelConfig,
    baseBody: OpenAIResponsesRequestBody,
    logger: RequestLogger,
  ): void {
    const config = model['multi-agent'];
    if (config?.enabled !== true) {
      delete baseBody.multi_agent;
      return;
    }

    const maxConcurrentSubagents =
      typeof config.maxConcurrentSubagents === 'number' &&
      Number.isFinite(config.maxConcurrentSubagents) &&
      Number.isInteger(config.maxConcurrentSubagents) &&
      config.maxConcurrentSubagents > 0
        ? config.maxConcurrentSubagents
        : undefined;

    baseBody.multi_agent = {
      enabled: true,
      ...(maxConcurrentSubagents !== undefined
        ? { max_concurrent_subagents: maxConcurrentSubagents }
        : {}),
    };

    const reasoning = baseBody.reasoning;
    const removedReasoningSummary =
      isRecord(reasoning) &&
      Object.prototype.hasOwnProperty.call(reasoning, 'summary');
    if (isRecord(reasoning)) {
      const { summary: _summary, ...reasoningWithoutSummary } = reasoning;
      baseBody.reasoning = reasoningWithoutSummary;
    }
    const removedMaxToolCalls = Object.prototype.hasOwnProperty.call(
      baseBody,
      'max_tool_calls',
    );
    delete baseBody.max_tool_calls;

    logger.verbose(
      `OpenAI Responses multi-agent enabled | model=${getBaseModelId(model.id)} | maxConcurrentSubagents=${maxConcurrentSubagents ?? 'default'} | removedReasoningSummary=${removedReasoningSummary ? 'true' : 'false'} | removedMaxToolCalls=${removedMaxToolCalls ? 'true' : 'false'} | contextManagement=${baseBody.context_management === undefined ? 'absent' : 'preserved'}`,
    );
  }

  private applyDisabledResponsesReasoningConfig(
    model: ModelConfig,
    baseBody: OpenAIResponsesRequestBody,
    useThinkingParam2: boolean,
  ): void {
    if (model.thinking?.type !== 'disabled' || useThinkingParam2) {
      return;
    }

    baseBody.reasoning = { effort: 'none' };
    delete baseBody.thinking;
  }

  private resolveStandaloneResponsesCompactionThreshold(
    model: ModelConfig,
  ): number | undefined {
    if (!this.shouldEnableStandaloneResponsesCompaction(model)) {
      return undefined;
    }

    if (
      typeof model.maxInputTokens === 'number' &&
      Number.isFinite(model.maxInputTokens) &&
      model.maxInputTokens > 0
    ) {
      return Math.floor(
        model.maxInputTokens * RESPONSES_COMPACTION_THRESHOLD_RATIO,
      );
    }

    return RESPONSES_CONTEXT_COMPACTION_FALLBACK_THRESHOLD;
  }

  private estimateResponsesInputTokens(
    input: OpenAIResponsesRequestBody['input'],
  ): number | undefined {
    if (input === undefined || input === null) {
      return undefined;
    }

    if (typeof input === 'string') {
      return sharedEstimateTokenCount(input);
    }

    const serialized = JSON.stringify(input);
    return serialized === undefined
      ? undefined
      : sharedEstimateTokenCount(serialized);
  }

  private estimateStandaloneCompactionInputTokens(
    input: OpenAIResponsesInputItem[],
    previousResponseInputBoundaryIndex: number,
    previousResponseUsage: CopilotUsage | undefined,
  ): number | undefined {
    if (previousResponseUsage !== undefined) {
      const suffixTokens = this.estimateResponsesInputTokens(
        input.slice(previousResponseInputBoundaryIndex),
      );
      if (suffixTokens !== undefined) {
        return previousResponseUsage.total_tokens + suffixTokens;
      }
    }

    return this.estimateResponsesInputTokens(input);
  }

  private resolveCompactionServiceTier(
    serviceTier: ResponseCreateParamsBase['service_tier'],
  ): ResponseCompactParams['service_tier'] | undefined {
    switch (serviceTier) {
      case 'auto':
      case 'default':
      case 'flex':
      case 'priority':
        return serviceTier;
      default:
        return undefined;
    }
  }

  private buildStandaloneResponsesCompactionBody(
    model: ModelConfig,
    baseBody: OpenAIResponsesRequestBody,
    input: ResponseInputItem[],
  ): ResponseCompactParams {
    const compactBody: ResponseCompactParams = {
      model: getBaseModelId(model.id),
      input,
    };

    if (baseBody.instructions !== undefined) {
      compactBody.instructions = baseBody.instructions;
    }
    if (baseBody.prompt_cache_key !== undefined) {
      compactBody.prompt_cache_key = baseBody.prompt_cache_key;
    }
    if (baseBody.prompt_cache_retention !== undefined) {
      compactBody.prompt_cache_retention = baseBody.prompt_cache_retention;
    }

    const serviceTier = this.resolveCompactionServiceTier(
      baseBody.service_tier,
    );
    if (serviceTier !== undefined) {
      compactBody.service_tier = serviceTier;
    }

    return compactBody;
  }

  private async applyStandaloneResponsesCompaction(
    client: OpenAI,
    model: ModelConfig,
    baseBody: OpenAIResponsesRequestBody,
    previousResponseInputBoundaryIndex: number | undefined,
    previousResponseUsage: CopilotUsage | undefined,
    headers: Record<string, string>,
    logger: RequestLogger,
    abortSignal: AbortSignal,
  ): Promise<boolean> {
    const compactThreshold =
      this.resolveStandaloneResponsesCompactionThreshold(model);
    if (compactThreshold === undefined) {
      return false;
    }
    if (baseBody.conversation !== undefined && baseBody.conversation !== null) {
      return false;
    }
    if (
      baseBody.previous_response_id !== undefined &&
      baseBody.previous_response_id !== null
    ) {
      return false;
    }

    const input = baseBody.input;
    if (!Array.isArray(input)) {
      return false;
    }
    if (!input.every(isStandardResponseInputItem)) {
      return false;
    }
    const standardInput = input.filter(isStandardResponseInputItem);
    if (
      previousResponseInputBoundaryIndex === undefined ||
      previousResponseInputBoundaryIndex <= 0 ||
      previousResponseInputBoundaryIndex >= standardInput.length
    ) {
      return false;
    }

    const estimatedTokens = this.estimateStandaloneCompactionInputTokens(
      standardInput,
      previousResponseInputBoundaryIndex,
      previousResponseUsage,
    );
    if (
      estimatedTokens === undefined ||
      estimatedTokens < compactThreshold
    ) {
      return false;
    }

    const compactInput = standardInput.slice(
      0,
      previousResponseInputBoundaryIndex,
    );
    const suffixInput = standardInput.slice(
      previousResponseInputBoundaryIndex,
    );
    const compactBody = this.buildStandaloneResponsesCompactionBody(
      model,
      baseBody,
      compactInput,
    );

    logger.verbose(
      `OpenAI Responses standalone compaction starting | model=${getBaseModelId(model.id)} | estimatedInputTokens=${estimatedTokens} | threshold=${compactThreshold} | compactItems=${compactInput.length} | suffixItems=${suffixInput.length}`,
    );

    const compacted = await client.responses.compact(compactBody, {
      headers,
      signal: abortSignal,
    });
    if (compacted.output.length === 0) {
      logger.verbose(
        `OpenAI Responses standalone compaction returned no output | id=${compacted.id}`,
      );
      return false;
    }

    const nextInput = [
      ...normalizeMarkerOutputItems(compacted.output),
      ...suffixInput,
    ];
    baseBody.input = nextInput;
    logger.verbose(
      `OpenAI Responses standalone compaction completed | id=${compacted.id} | compactedItems=${compacted.output.length} | nextInputItems=${nextInput.length}`,
    );
    return true;
  }

  private applyVolcContextCaching(
    model: ModelConfig,
    baseBody: OpenAIResponsesRequestBody,
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
    baseBody: OpenAIResponsesRequestBody,
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
    inputAfterPreviousResponse: OpenAIResponsesInputItem[] | undefined,
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

    body.input = omitFunctionCallsWithoutFollowingOutput(body.input);

    return body;
  }

  private buildWebSocketRequestForAttempt(
    baseBody: OpenAIResponsesRequestBody,
    fullInput: OpenAIResponsesRequestBody['input'],
    continuation: ResponseContinuation | undefined,
    useContinuation: boolean,
  ): OpenAIResponsesClientEvent {
    const body: OpenAIResponsesRequestBody = {
      ...baseBody,
      input: fullInput,
    };

    delete body.previous_response_id;
    delete body.stream;
    delete body.betas;

    if (useContinuation && continuation) {
      body.previous_response_id = continuation.previousResponseId;
      body.input = continuation.inputAfterPreviousResponse;
    }

    body.input = omitFunctionCallsWithoutFollowingOutput(body.input);

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
    requestTrace: ChatRequestTrace,
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

    const multiAgentEnabled = model['multi-agent']?.enabled === true;
    const expectedIdentity = createResponsesMarkerIdentity(
      this.config,
      model,
      multiAgentEnabled,
    );
    const sanitization = sanitizeMessagesForModelSwitchDetailed(messages, {
      modelId: encodedModelId,
      expectedIdentity,
      imageRetention:
        model.capabilities?.imageInput === true ? 'user-only' : 'discard',
    });
    const sanitizedMessages = sanitization.messages;

    const {
      input: convertedMessages,
      sessionId,
      previousResponseId,
      inputAfterPreviousResponse,
      previousResponseBoundaryIndex,
      previousResponseInputBoundaryIndex,
      previousResponseUsage,
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
    let canUsePreviousResponseId =
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

    const appliedResponsesContextManagement =
      this.applyResponsesContextManagement(model, baseBody);
    this.applyPromptCacheKey(model, sessionId, baseBody);
    this.handleRequest(sessionId, baseBody);

    Object.assign(baseBody, this.config.extraBody, model.extraBody);
    this.applyVolcContextCaching(model, baseBody);
    this.applyDisabledResponsesReasoningConfig(
      model,
      baseBody,
      useThinkingParam2,
    );
    this.applyResponsesMultiAgentConfig(model, baseBody, logger);

    const headers = this.buildHeaders(
      sessionId,
      credential,
      model,
      sanitizedMessages,
    );
    updateResponsesMultiAgentBetaHeader(headers, multiAgentEnabled);
    let usedStandaloneResponsesCompaction = false;
    if (!multiAgentEnabled) {
      const standaloneCompactionClient = this.createClient(
        logger,
        false,
        credential,
        abortController.signal,
      );
      usedStandaloneResponsesCompaction =
        await this.applyStandaloneResponsesCompaction(
          standaloneCompactionClient,
          model,
          baseBody,
          previousResponseInputBoundaryIndex,
          previousResponseUsage,
          headers,
          logger,
          abortController.signal,
        );
    }
    if (usedStandaloneResponsesCompaction) {
      canUsePreviousResponseId = false;
      if (
        appliedResponsesContextManagement &&
        !this.isContextManagementExplicitlyConfigured(model)
      ) {
        delete baseBody.context_management;
      }
    }

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

    const webSocketHeaders = this.buildWebSocketHeaders(
      sessionId,
      credential,
      model,
      sanitizedMessages,
    );
    updateResponsesMultiAgentBetaHeader(
      webSocketHeaders,
      multiAgentEnabled,
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
      requestTrace,
      expectedIdentity,
      credential,
      imageGenerationOutputMimeType: this.resolveImageGenerationOutputMimeType(
        baseBody.tools,
      ),
      multiAgentEnabled,
    };
    const httpContext: OpenAIResponsesHttpRequestContext = {
      ...baseContext,
      continuation: httpContinuation,
      includeResponseIdInMarker: httpIncludeResponseIdInMarker,
    };

    requestTrace.performance.ttf = Date.now() - requestTrace.performance.tts;
    logger.verbose(
      `OpenAI Responses transport selected | configured=${this.config.transport ?? 'default'} | effective=${transportMode} | stream=${streamEnabled ? 'true' : 'false'} | session=${sessionId} | previousResponseId=${previousResponseId ? 'present' : 'absent'} | store=${baseBody.store === false ? 'false' : 'default/true'} | websocketCapability=${this.websocketCapability}`,
    );

    try {
      if (usedStandaloneResponsesCompaction) {
        yield new vscode.LanguageModelTextPart(
          RESPONSES_COMPACTION_NOTICE,
        );
      }

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

  private normalizeStandardRequestInput(
    input: OpenAIResponsesRequestBody['input'],
  ): ResponseCreateParamsBase['input'] {
    if (!Array.isArray(input)) {
      return input;
    }
    return input.filter(isStandardResponseInputItem);
  }

  private buildStandardStreamingRequestBody(
    requestBody: OpenAIResponsesRequestBody,
  ): ResponseCreateParamsStreaming {
    const {
      betas: _betas,
      input,
      multi_agent: _multiAgent,
      ...body
    } = requestBody;
    return {
      ...body,
      input: this.normalizeStandardRequestInput(input),
      stream: true,
    };
  }

  private buildStandardNonStreamingRequestBody(
    requestBody: OpenAIResponsesRequestBody,
  ): ResponseCreateParamsNonStreaming {
    const {
      betas: _betas,
      input,
      multi_agent: _multiAgent,
      ...body
    } = requestBody;
    return {
      ...body,
      input: this.normalizeStandardRequestInput(input),
      stream: false,
    };
  }

  private buildBetaStreamingRequestBody(
    requestBody: OpenAIResponsesRequestBody,
  ): BetaResponseCreateParamsStreaming {
    const { betas: _betas, ...body } = requestBody;
    return { ...body, stream: true };
  }

  private buildBetaNonStreamingRequestBody(
    requestBody: OpenAIResponsesRequestBody,
  ): BetaResponseCreateParamsNonStreaming {
    const { betas: _betas, ...body } = requestBody;
    return { ...body, stream: false };
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
      context.requestTrace.performance.ttf =
        Date.now() - context.requestTrace.performance.tts;
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

          const requestOptions = {
            headers: context.headers,
            signal: context.abortController.signal,
          };
          const stream: AsyncIterable<OpenAIResponsesStreamEvent> = context
            .multiAgentEnabled
            ? await client.beta.responses.create(
                this.buildBetaStreamingRequestBody(requestBody),
                requestOptions,
              )
            : await client.responses.create(
                this.buildStandardStreamingRequestBody(requestBody),
                requestOptions,
              );
          const timedStream = withIdleTimeout(
            stream,
            responseTimeoutMs,
            context.abortController.signal,
            (error) => context.abortController.abort(error),
          );
          for await (const part of this.parseMessageStream(
            timedStream,
            context.sessionId,
            context.token,
            context.logger,
            context.requestTrace,
            context.expectedIdentity,
            context.includeResponseIdInMarker,
            context.streamEnabled ? 'sse' : 'http',
            context.imageGenerationOutputMimeType,
          )) {
            emittedPartCount++;
            yield part;
          }
        } else {
          const requestOptions = {
            headers: context.headers,
            signal: context.abortController.signal,
          };
          const data: OpenAIResponsesResponse = context.multiAgentEnabled
            ? await client.beta.responses.create(
                this.buildBetaNonStreamingRequestBody(requestBody),
                requestOptions,
              )
            : await client.responses.create(
                this.buildStandardNonStreamingRequestBody(requestBody),
                requestOptions,
              );
          for await (const part of this.parseMessage(
            data,
            context.sessionId,
            context.requestTrace,
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
      context.requestTrace.performance.ttf =
        Date.now() - context.requestTrace.performance.tts;
      let request:
        | WebSocketSessionRequest<OpenAIResponsesStreamEvent>
        | undefined;
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
        if (requestPayload.type !== 'response.create') {
          throw new OpenAIResponsesRequestError(
            `Unsupported OpenAI Responses WebSocket request event: ${requestPayload.type}`,
          );
        }
        const requestInput = requestPayload.input;
        context.logger.verbose(
          `OpenAI Responses WebSocket attempt ${attempt} | mode=${allowFallback ? 'auto' : 'websocket'} | session=${context.sessionId} | baseUrl=${this.resolveWebSocketBaseUrl(client)} | hotSessionAtStart=${context.hadHotSessionAtStart ? 'true' : 'false'} | continuation=${shouldUseContinuation ? 'previous_response_id' : 'full_input'} | forceNewConnection=${shouldForceNewConnection ? 'true' : 'false'} | inputItems=${this.countInputItems(requestInput)} | store=${requestPayload.store === false ? 'false' : 'default/true'}`,
        );
        request = await webSocketSessionManager.createRequest(
          {
            sessionKey: context.sessionKey,
            connectionTimeoutMs,
            createTransport: () =>
              this.createWebSocketTransport(
                client,
                context.webSocketHeaders,
                context.multiAgentEnabled,
              ),
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
          (async function* (): AsyncGenerator<OpenAIResponsesStreamEvent> {
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
          context.requestTrace,
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
    message: OpenAIResponsesResponse,
    sessionId: string,
    requestTrace: ChatRequestTrace,
    logger: RequestLogger,
    expectedIdentity: string,
    includeResponseIdInMarker: boolean,
    transportLabel: 'http' | 'sse' | 'websocket',
    imageGenerationOutputMimeType: string,
  ): AsyncGenerator<vscode.LanguageModelResponsePart2> {
    const performanceTrace = requestTrace.performance;
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

    // Mirror the streaming `response.failed` / `response.incomplete`
    // handling so abnormal terminal states surface as errors instead of
    // silently empty/truncated responses.
    if (message.status === 'failed') {
      if (message.error) {
        const responseError = this.extractResponseError(message.error);
        throw new OpenAIResponsesRequestError(
          `OpenAI Response Failed: ${responseError.message}${
            responseError.code ? ` (${responseError.code})` : ''
          }`,
          {
            source: 'generic',
            code: responseError.code,
            type: responseError.type,
            param: responseError.param,
            status: responseError.status,
          },
        );
      }
      throw new OpenAIResponsesRequestError(
        'OpenAI Response Failed: unknown error',
        { source: 'generic' },
      );
    }

    if (message.status === 'incomplete') {
      throw new OpenAIResponsesRequestError(
        `OpenAI Response Incomplete: ${
          message.incomplete_details?.reason || 'unknown reason'
        }`,
        { source: 'generic' },
      );
    }

    const output = normalizeResponseOutputItems(message.output);
    const reasonings = output.filter(
      (v): v is ResponseReasoningItem =>
        v.type === 'reasoning' && isRootAgentOutput(v),
    );

    yield* this.extractThinkingParts(reasonings);

    for (const item of output) {
      switch (item.type) {
        case 'reasoning':
          // hadnle it already.
          break;

        case 'compaction':
          yield new vscode.LanguageModelTextPart(
            RESPONSES_COMPACTION_NOTICE,
          );
          break;

        case 'message':
          if (!isRootAgentOutput(item)) {
            break;
          }
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

        case 'multi_agent_call':
        case 'multi_agent_call_output':
        case 'agent_message':
          yield new vscode.LanguageModelTextPart(
            formatMultiAgentOutputItem(item),
          );
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
      data: output,
      sessionId,
    };
    if (includeResponseIdInMarker) {
      markerData.responseId = message.id;
    }
    if (message.usage) {
      markerData.usage = createCopilotUsage(
        message.usage.input_tokens,
        message.usage.output_tokens,
        message.usage.input_tokens_details.cached_tokens,
      );
    }
    yield encodeStatefulMarkerPart<OpenAIResponsesMarkerData>(
      expectedIdentity,
      markerData,
    );

    if (message.usage) {
      this.processUsage(message.usage, requestTrace, logger);
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
    response: OpenAIResponsesResponse,
    addedOutputItems: ReadonlyMap<number, OpenAIResponsesOutputItem>,
    completedOutputItems: ReadonlyMap<number, OpenAIResponsesOutputItem>,
    logger: RequestLogger,
  ): OpenAIResponsesOutputItem[] {
    const responseOutput = Array.isArray(response.output)
      ? normalizeResponseOutputItems(response.output)
      : [];
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
      .filter(
        (item): item is OpenAIResponsesOutputItem => item !== undefined,
      );

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
    stream: AsyncIterable<OpenAIResponsesStreamEvent>,
    sessionId: string,
    token: vscode.CancellationToken,
    logger: RequestLogger,
    requestTrace: ChatRequestTrace,
    expectedIdentity: string,
    includeResponseIdInMarker: boolean,
    transportLabel: 'http' | 'sse' | 'websocket',
    imageGenerationOutputMimeType: string,
  ): AsyncGenerator<vscode.LanguageModelResponsePart2> {
    const performanceTrace = requestTrace.performance;
    let usage: ResponseUsage | undefined;
    const emittedFunctionCallIds = new Set<string>();
    const addedOutputItems = new Map<number, OpenAIResponsesOutputItem>();
    const completedOutputItems = new Map<
      number,
      OpenAIResponsesOutputItem
    >();
    const emittedMultiAgentItems = new Set<string>();

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

    const emitMultiAgentItemPart = (
      item: OpenAIResponsesOutputItem,
      outputIndex: number,
    ): vscode.LanguageModelTextPart | undefined => {
      if (!isMultiAgentOutputItem(item)) {
        return undefined;
      }

      const key = `${outputIndex}:${item.type}`;
      if (emittedMultiAgentItems.has(key)) {
        return undefined;
      }
      emittedMultiAgentItems.add(key);
      return new vscode.LanguageModelTextPart(
        formatMultiAgentOutputItem(item),
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
          {
            const item = normalizeResponseOutputItem(event.item);
            addedOutputItems.set(event.output_index, item);
            if (item.type === 'multi_agent_call') {
              const part = emitMultiAgentItemPart(item, event.output_index);
              if (part) {
                yield part;
              }
            }
            if (
              item.type === 'reasoning' &&
              item.encrypted_content &&
              isRootAgentOutput(item)
            ) {
              yield* this.emitThinkingText(
                'encrypted',
                item.encrypted_content,
                'content-only',
                undefined,
                thinkingOutputState,
              );
            }
          }
          break;

        case 'response.output_text.delta':
          if (event.delta && isRootAgentOutput(event)) {
            yield new vscode.LanguageModelTextPart(event.delta);
          }
          break;

        case 'response.refusal.delta':
          if (event.delta && isRootAgentOutput(event)) {
            yield new vscode.LanguageModelTextPart(event.delta);
          }
          break;

        case 'response.reasoning_text.delta':
          if (event.delta && isRootAgentOutput(event)) {
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
          if (event.delta && isRootAgentOutput(event)) {
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
          const item = normalizeResponseOutputItem(event.item);
          completedOutputItems.set(event.output_index, item);
          if (item.type === 'function_call') {
            const part = emitFunctionCallPart(item);
            if (part) {
              yield part;
            }
          }
          if (
            item.type === 'multi_agent_call_output' ||
            item.type === 'agent_message'
          ) {
            const part = emitMultiAgentItemPart(item, event.output_index);
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

          for (const [outputIndex, item] of completedOutput.entries()) {
            if (item.type === 'function_call') {
              const part = emitFunctionCallPart(item);
              if (part) {
                yield part;
              }
              continue;
            }

            if (isMultiAgentOutputItem(item)) {
              const part = emitMultiAgentItemPart(item, outputIndex);
              if (part) {
                yield part;
              }
              continue;
            }

            if (item.type === 'compaction') {
              yield new vscode.LanguageModelTextPart(
                RESPONSES_COMPACTION_NOTICE,
              );
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
            (v): v is ResponseReasoningItem =>
              v.type === 'reasoning' && isRootAgentOutput(v),
          );

          yield* this.extractThinkingParts(reasonings, 'metadata-only');

          const markerData: OpenAIResponsesMarkerData = {
            data: completedOutput,
            sessionId,
          };
          if (includeResponseIdInMarker) {
            markerData.responseId = response.id;
          }
          if (response.usage) {
            markerData.usage = createCopilotUsage(
              response.usage.input_tokens,
              response.usage.output_tokens,
              response.usage.input_tokens_details.cached_tokens,
            );
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
      this.processUsage(usage, requestTrace, logger);
    }
  }

  private processUsage(
    usage: ResponseUsage,
    requestTrace: ChatRequestTrace,
    logger: RequestLogger,
  ) {
    const normalizedUsage = createCopilotUsage(
      usage.input_tokens,
      usage.output_tokens,
      usage.input_tokens_details.cached_tokens,
    );
    sharedProcessUsage(requestTrace, logger, normalizedUsage);
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
  data: OpenAIResponsesOutputItem[];
  sessionId?: string;
  responseId?: string;
  usage?: CopilotUsage;
};
