import {
  LanguageModelChatRequestMessage,
  ProvideLanguageModelChatResponseOptions,
  CancellationToken,
} from 'vscode';
import * as vscode from 'vscode';
import { createSimpleHttpLogger } from '../../logger';
import type { ProviderHttpLogger, RequestLogger } from '../../logger';
import { ApiProvider } from '../interface';
import { ModelConfig, PerformanceTrace, ProviderConfig } from '../../types';
import { Ollama } from 'ollama';
import type {
  AbortableAsyncIterator,
  ChatRequest,
  ChatResponse,
  Message,
  ToolCall,
  Tool,
} from 'ollama';
import {
  decodeStatefulMarkerPart,
  DEFAULT_TIMEOUT_CONFIG,
  encodeStatefulMarkerPart,
  isCacheControlMarker,
  isImageMarker,
  isInternalMarker,
  normalizeImageMimeType,
  withIdleTimeout,
} from '../../utils';
import { getBaseModelId } from '../../model-id-utils';
import { randomUUID } from 'crypto';
import { ThinkingBlockMetadata } from '../types';
import {
  buildBaseUrl,
  createCustomFetch,
  createFirstTokenRecorder,
  estimateTokenCount as sharedEstimateTokenCount,
  mergeHeaders,
  processUsage as sharedProcessUsage,
} from '../utils';

const TOOL_CALL_ID_PREFIX = 'ollama-tool:';

export class OllamaProvider implements ApiProvider {
  private readonly baseUrl: string;

  constructor(private readonly config: ProviderConfig) {
    this.baseUrl = buildBaseUrl(config.baseUrl, { stripPattern: /\/api$/i });
  }

  private buildHeaders(modelConfig?: ModelConfig): Record<string, string> {
    const headers = mergeHeaders(
      this.config.apiKey,
      this.config.extraHeaders,
      modelConfig?.extraHeaders,
    );

    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    return headers;
  }

  /**
   * Create an Ollama client with custom fetch for retry support.
   * A new client is created per request to enable per-request logging.
   */
  private createClient(
    headers?: Record<string, string>,
    logger?: ProviderHttpLogger,
    stream?: boolean,
  ): Ollama {
    const streamEnabled = stream ?? true;
    const requestTimeoutMs = streamEnabled
      ? this.config.timeout?.connection ?? DEFAULT_TIMEOUT_CONFIG.connection
      : this.config.timeout?.response ?? DEFAULT_TIMEOUT_CONFIG.response;

    return new Ollama({
      host: this.baseUrl,
      fetch: createCustomFetch({
        connectionTimeoutMs: requestTimeoutMs,
        logger,
      }),
      headers,
    });
  }

  private convertMessages(
    encodedModelId: string,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
  ): Message[] {
    const outMessages: Message[] = [];
    const rawMap = new Map<Message, Message>();

    for (const msg of messages) {
      switch (msg.role) {
        case vscode.LanguageModelChatMessageRole.System:
          for (const part of msg.content) {
            const converted = this.convertPart(msg.role, part);
            if (converted) outMessages.push(converted);
          }
          break;

        case vscode.LanguageModelChatMessageRole.User:
          for (const part of msg.content) {
            const converted = this.convertPart(msg.role, part);
            if (converted) outMessages.push(converted);
          }
          break;

        case vscode.LanguageModelChatMessageRole.Assistant: {
          const rawPart = msg.content.find(
            (v) => v instanceof vscode.LanguageModelDataPart,
          ) as vscode.LanguageModelDataPart | undefined;
          if (rawPart) {
            try {
              const raw = decodeStatefulMarkerPart<Message>(
                encodedModelId,
                rawPart,
              );
              const placeholder: Message = {
                role: 'assistant',
                content: '',
              };
              rawMap.set(placeholder, raw);
              outMessages.push(placeholder);
              break;
            } catch (error) {}
          }
          for (const part of msg.content) {
            const converted = this.convertPart(msg.role, part);
            if (converted) outMessages.push(converted);
          }
          break;
        }

        default:
          throw new Error(`Unsupported message role for provider: ${msg.role}`);
      }
    }

    // use raw messages, for details, see parseMessage's NOTE comments.
    for (const [param, raw] of rawMap) {
      const index = outMessages.indexOf(param);
      if (index === -1) continue;
      outMessages[index] = raw;
    }

    this.mergeToolCalls(outMessages);
    this.reorderToolResults(outMessages);
    this.normalizeToolResultToolIds(outMessages);

    return outMessages;
  }

  /**
   * Merge consecutive tool calls in messages into the last message of the run.
   */
  private mergeToolCalls(messages: Message[]): void {
    let runStart = 0;
    while (runStart < messages.length) {
      const role = messages[runStart].role;

      let runEnd = runStart;
      while (
        runEnd + 1 < messages.length &&
        messages[runEnd + 1].role === role
      ) {
        runEnd++;
      }

      const mergedToolCalls: ToolCall[] = [];
      for (let i = runStart; i <= runEnd; i++) {
        const message = messages[i];
        if (message.tool_calls && message.tool_calls.length > 0) {
          mergedToolCalls.push(...message.tool_calls);
          message.tool_calls = undefined;
        }
      }

      if (mergedToolCalls.length > 0) {
        messages[runEnd].tool_calls = mergedToolCalls;
      }

      runStart = runEnd + 1;
    }
  }

  /**
   * Reorder tool result messages based on indices in their call IDs.
   * After reordering, normalize tool result `tool_name` from a call ID back to a tool ID.
   */
  private reorderToolResults(messages: Message[]): void {
    let blockStart = 0;
    while (blockStart < messages.length) {
      if (messages[blockStart].role !== 'tool') {
        blockStart++;
        continue;
      }

      let blockEnd = blockStart;
      while (
        blockEnd + 1 < messages.length &&
        messages[blockEnd + 1].role === 'tool'
      ) {
        blockEnd++;
      }

      const segment = messages.slice(blockStart, blockEnd + 1);
      const decorated = segment.map((message, position) => {
        const parsed =
          message.tool_name != null
            ? this.parseToolCallId(message.tool_name)
            : undefined;
        return { message, position, index: parsed?.index };
      });

      const indices = decorated
        .map((d) => d.index)
        .filter((v): v is number => v !== undefined);

      if (indices.length >= 2 && new Set(indices).size === indices.length) {
        decorated.sort((a, b) => {
          const aIndex = a.index ?? Number.POSITIVE_INFINITY;
          const bIndex = b.index ?? Number.POSITIVE_INFINITY;
          if (aIndex !== bIndex) return aIndex - bIndex;
          return a.position - b.position;
        });

        for (let offset = 0; offset < decorated.length; offset++) {
          messages[blockStart + offset] = decorated[offset].message;
        }
      }

      blockStart = blockEnd + 1;
    }
  }

  /**
   * Normalize tool result `tool_name` from a call ID back to a tool ID.
   */
  private normalizeToolResultToolIds(messages: Message[]): void {
    for (const message of messages) {
      const toolNameOrCallId = message.tool_name;
      if (toolNameOrCallId) {
        message.tool_name =
          this.parseToolCallId(toolNameOrCallId)?.name ?? toolNameOrCallId;
      }
    }
  }

  convertPart(
    role: vscode.LanguageModelChatMessageRole | 'from_tool_result',
    part: vscode.LanguageModelInputPart | unknown,
  ): Message | undefined {
    if (part == null) {
      return undefined;
    }

    const roleStr: 'assistant' | 'system' | 'user' =
      role === vscode.LanguageModelChatMessageRole.Assistant
        ? 'assistant'
        : role === vscode.LanguageModelChatMessageRole.System
        ? 'system'
        : 'user';

    if (part instanceof vscode.LanguageModelTextPart) {
      if (part.value.trim()) {
        return {
          role: roleStr,
          content: part.value,
        };
      }
      return undefined;
    } else if (part instanceof vscode.LanguageModelThinkingPart) {
      if (role !== vscode.LanguageModelChatMessageRole.Assistant) {
        throw new Error('Thinking parts can only appear in assistant messages');
      }
      const metadata = part.metadata as ThinkingBlockMetadata | undefined;
      const values = typeof part.value === 'string' ? [part.value] : part.value;
      return {
        role: 'assistant',
        content: '',
        thinking:
          metadata?.redactedData ??
          metadata?._completeThinking ??
          values.join(''),
      };
    } else if (part instanceof vscode.LanguageModelDataPart) {
      if (isCacheControlMarker(part)) {
        // ignore it, just use the officially recommended caching strategy.
        return undefined;
      } else if (isInternalMarker(part)) {
        return undefined;
      } else if (isImageMarker(part)) {
        if (role === 'from_tool_result') {
          throw new Error('Image parts cannot appear in tool result messages');
        }
        const mimeType = normalizeImageMimeType(part.mimeType);
        if (!mimeType) {
          throw new Error(
            `Unsupported image mime type for provider: ${part.mimeType}`,
          );
        }
        return {
          role: roleStr,
          content: '',
          images: [part.data],
        };
      }
      throw new Error(
        `Unsupported ${role} message LanguageModelDataPart mime type: ${part.mimeType}`,
      );
    } else if (part instanceof vscode.LanguageModelToolCallPart) {
      if (role !== vscode.LanguageModelChatMessageRole.Assistant) {
        throw new Error(
          'Tool call parts can only appear in assistant messages',
        );
      }
      return {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            function: {
              name: part.name,
              arguments: part.input,
            },
          },
        ],
      };
    } else if (
      part instanceof vscode.LanguageModelToolResultPart ||
      part instanceof vscode.LanguageModelToolResultPart2
    ) {
      if (role !== vscode.LanguageModelChatMessageRole.User) {
        throw new Error('Tool result parts can only appear in user messages');
      }
      const content = part.content
        .map((v) => this.convertPart('from_tool_result', v))
        .filter((v) => v !== undefined)
        .map((v) => v.content)
        .join('');
      return {
        role: 'tool',
        content: content || '',
        tool_name: part.callId,
      };
    } else {
      throw new Error(`Unsupported ${role} message part type encountered`);
    }
  }

  private convertTools(
    tools: readonly vscode.LanguageModelChatTool[] | undefined,
  ): Tool[] | undefined {
    if (!tools || tools.length === 0) {
      return undefined;
    }

    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: (tool.inputSchema as Tool['function']['parameters']) ?? {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    }));
  }

  private buildThinkParam(model: ModelConfig): Pick<ChatRequest, 'think'> {
    const thinking = model.thinking;
    if (!thinking) {
      return {};
    }

    if (thinking.type === 'disabled') {
      return { think: false };
    }

    switch (thinking.effort) {
      case 'none':
        return { think: false };
      case 'minimal':
      case 'low':
        return { think: 'low' };
      case 'medium':
        return { think: 'medium' };
      case 'high':
      case 'xhigh':
        return { think: 'high' };
      default:
        return { think: true };
    }
  }

  private buildOptions(model: ModelConfig): ChatRequest['options'] {
    const options: NonNullable<ChatRequest['options']> = {};

    if (model.maxOutputTokens !== undefined) {
      options.num_predict = model.maxOutputTokens;
    }
    if (model.maxInputTokens !== undefined) {
      options.num_ctx = model.maxInputTokens;
    }
    if (model.temperature !== undefined) {
      options.temperature = model.temperature;
    }
    if (model.topP !== undefined) {
      options.top_p = model.topP;
    }
    if (model.topK !== undefined) {
      options.top_k = model.topK;
    }
    if (model.frequencyPenalty !== undefined) {
      options.frequency_penalty = model.frequencyPenalty;
    }
    if (model.presencePenalty !== undefined) {
      options.presence_penalty = model.presencePenalty;
    }

    return Object.keys(options).length > 0 ? options : undefined;
  }

  async *streamChat(
    encodedModelId: string,
    model: ModelConfig,
    messages: readonly LanguageModelChatRequestMessage[],
    options: ProvideLanguageModelChatResponseOptions,
    performanceTrace: PerformanceTrace,
    token: CancellationToken,
    logger: RequestLogger,
  ): AsyncGenerator<vscode.LanguageModelResponsePart2> {
    const headers = this.buildHeaders(model);
    const streamEnabled = model.stream ?? true;
    const client = this.createClient(headers, logger, streamEnabled);
    const abortController = new AbortController();
    let stream: AbortableAsyncIterator<ChatResponse> | undefined;
    const cancellationListener = token.onCancellationRequested(() => {
      abortController.abort();
      if (stream) {
        stream.abort();
      } else {
        client.abort();
      }
    });

    const convertedMessages = this.convertMessages(encodedModelId, messages);
    const tools = this.convertTools(options.tools);
    const requestOptions = this.buildOptions(model);

    const baseBody: ChatRequest = {
      model: getBaseModelId(model.id),
      messages: convertedMessages,
      ...this.buildThinkParam(model),
      ...(requestOptions ? { options: requestOptions } : {}),
      ...(tools ? { tools } : {}),
      stream: streamEnabled,
    };

    Object.assign(baseBody, this.config.extraBody, model.extraBody);

    performanceTrace.ttf = Date.now() - performanceTrace.tts;

    try {
      if (streamEnabled) {
        const responseTimeoutMs =
          this.config.timeout?.response ?? DEFAULT_TIMEOUT_CONFIG.response;

        stream = await client.chat({ ...baseBody, stream: true });
        const timedStream = withIdleTimeout(
          stream,
          responseTimeoutMs,
          abortController.signal,
        );
        yield* this.parseMessageStream(
          timedStream,
          token,
          logger,
          performanceTrace,
        );
      } else {
        const result = await client.chat({ ...baseBody, stream: false });
        yield* this.parseMessage(result, performanceTrace, logger);
      }
    } finally {
      cancellationListener.dispose();
    }
  }

  private async *parseMessage(
    message: ChatResponse,
    performanceTrace: PerformanceTrace,
    logger: RequestLogger,
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

    const raw = message.message;

    yield* this.extractThinkingParts(raw.thinking);

    if (raw.content) {
      yield new vscode.LanguageModelTextPart(raw.content);
    }

    if (raw.tool_calls) {
      for (const [index, call] of raw.tool_calls.entries()) {
        if (!call.function?.name) {
          throw new Error('Ollama tool call missing function name');
        }
        yield new vscode.LanguageModelToolCallPart(
          this.generateToolCallId(call.function.name, index),
          call.function.name,
          call.function.arguments,
        );
      }
    }

    yield encodeStatefulMarkerPart<Message>(raw);

    this.processUsage(
      {
        prompt_eval_count: message.prompt_eval_count,
        eval_count: message.eval_count,
      },
      performanceTrace,
      logger,
    );
  }

  private async *parseMessageStream(
    stream: AsyncIterable<ChatResponse>,
    token: vscode.CancellationToken,
    logger: RequestLogger,
    performanceTrace: PerformanceTrace,
  ): AsyncGenerator<vscode.LanguageModelResponsePart2> {
    let snapshot: Message | undefined;
    let usage:
      | {
          prompt_eval_count: number;
          eval_count: number;
        }
      | undefined;

    const recordFirstToken = createFirstTokenRecorder(performanceTrace);

    for await (const event of stream) {
      if (token.isCancellationRequested) {
        break;
      }

      logger.providerResponseChunk(JSON.stringify(event));

      recordFirstToken();

      snapshot = this.accumulateMessage(snapshot, event);

      const delta = event.message;
      if (delta.thinking) {
        yield new vscode.LanguageModelThinkingPart(delta.thinking);
      }

      if (delta.content) {
        recordFirstToken();
        yield new vscode.LanguageModelTextPart(delta.content);
      }

      if (event.done) {
        usage = {
          prompt_eval_count: event.prompt_eval_count,
          eval_count: event.eval_count,
        };
      }
    }

    if (snapshot) {
      if (snapshot.tool_calls) {
        for (const [index, call] of snapshot.tool_calls.entries()) {
          if (!call.function?.name) {
            throw new Error('Ollama tool call missing function name');
          }
          yield new vscode.LanguageModelToolCallPart(
            this.generateToolCallId(call.function.name, index),
            call.function.name,
            call.function.arguments,
          );
        }
      }

      yield* this.extractThinkingParts(snapshot.thinking, 'metadata-only');
      yield encodeStatefulMarkerPart<Message>(snapshot);
    }

    if (usage) {
      this.processUsage(usage, performanceTrace, logger);
    }
  }

  private accumulateMessage(
    snapshot: Message | undefined,
    event: ChatResponse,
  ): Message {
    const message = event.message;
    const base: Message = snapshot ?? { role: message.role, content: '' };

    if (typeof message.content === 'string') {
      base.content += message.content;
    }

    if (message.thinking) {
      base.thinking = (base.thinking || '') + message.thinking;
    }

    if (message.images) {
      base.images = message.images;
    }

    if (message.tool_calls) {
      base.tool_calls = message.tool_calls;
    }

    if (message.tool_name) {
      base.tool_name = message.tool_name;
    }

    return base;
  }

  private *extractThinkingParts(
    thinkingText: string | undefined,
    emitMode: 'full' | 'metadata-only' | 'content-only' = 'full',
    metadata?: ThinkingBlockMetadata,
  ): Generator<vscode.LanguageModelThinkingPart> {
    if (!thinkingText) {
      return;
    }

    if (emitMode !== 'content-only' && metadata == null) {
      metadata = {};
    }

    if (emitMode !== 'metadata-only') {
      yield new vscode.LanguageModelThinkingPart(thinkingText);
    }

    metadata!._completeThinking =
      (metadata!._completeThinking || '') + thinkingText;

    if (
      emitMode !== 'content-only' &&
      metadata &&
      Object.keys(metadata).length > 0
    ) {
      yield new vscode.LanguageModelThinkingPart('', undefined, metadata);
    }
  }

  private generateToolCallId(name: string, index: number): string {
    return `${TOOL_CALL_ID_PREFIX}${name}:${index}:${randomUUID()}`;
  }

  private parseToolCallId(
    callId: string,
  ): { name: string; index: number; uuid: string } | undefined {
    if (!callId.startsWith(TOOL_CALL_ID_PREFIX)) {
      return undefined;
    }
    const suffix = callId.slice(TOOL_CALL_ID_PREFIX.length);

    const lastColonIndex = suffix.lastIndexOf(':');
    if (lastColonIndex === -1) {
      return undefined;
    }
    const secondLastColonIndex = suffix.lastIndexOf(':', lastColonIndex - 1);
    if (secondLastColonIndex === -1) {
      return undefined;
    }

    const name = suffix.slice(0, secondLastColonIndex);
    const indexStr = suffix.slice(secondLastColonIndex + 1, lastColonIndex);
    const uuid = suffix.slice(lastColonIndex + 1);

    if (!name || !uuid || !/^\d+$/.test(indexStr)) {
      return undefined;
    }

    const index = Number.parseInt(indexStr, 10);
    if (!Number.isSafeInteger(index) || index < 0) {
      return undefined;
    }

    return { name, index, uuid };
  }

  private processUsage(
    usage: { prompt_eval_count: number; eval_count: number },
    performanceTrace: PerformanceTrace,
    logger: RequestLogger,
  ) {
    sharedProcessUsage(usage.eval_count, performanceTrace, logger, {
      prompt_tokens: usage.prompt_eval_count ?? 0,
      completion_tokens: usage.eval_count ?? 0,
      total_tokens: (usage.prompt_eval_count ?? 0) + (usage.eval_count ?? 0),
    });
  }

  estimateTokenCount(text: string): number {
    return sharedEstimateTokenCount(text);
  }

  async getAvailableModels(): Promise<ModelConfig[]> {
    const logger = createSimpleHttpLogger({
      purpose: 'Get Available Models',
      providerName: this.config.name,
      providerType: this.config.type,
    });
    const headers = this.buildHeaders();
    const client = this.createClient(headers, logger);

    try {
      const list = await client.list();
      const result = list.models.map((model) => ({
        id: model.name,
      }));
      return result;
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }
}
