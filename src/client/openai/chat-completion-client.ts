import {
  LanguageModelChatRequestMessage,
  ProvideLanguageModelChatResponseOptions,
  CancellationToken,
} from 'vscode';
import { RequestLogger } from '../../logger';
import { PerformanceTrace, ThinkingBlockMetadata } from '../../types';
import { ApiProvider, ModelConfig, ProviderConfig } from '../interface';
import OpenAI from 'openai';
import {
  decodeStatefulMarkerPart,
  DEFAULT_RETRY_CONFIG,
  encodeStatefulMarkerPart,
  fetchWithRetry,
  isCacheControlMarker,
  isImageMarker,
  isInternalMarker,
  normalizeBaseUrlInput,
  normalizeImageMimeType,
} from '../../utils';
import { WELL_KNOWN_MODELS } from '../../well-known-models';
import * as vscode from 'vscode';
import {
  ChatCompletion,
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionContentPartText,
  ChatCompletionCreateParamsBase,
  ChatCompletionFunctionTool,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionToolChoiceOption,
  OpenRouterReasoningDetail,
} from 'openai/resources/chat/completions';
import { FunctionParameters } from 'openai/resources/shared';
import { getBaseModelId } from '../../model-id-utils';
import { FeatureId, isFeatureSupported } from '../../features';
import { CompletionUsage } from 'openai/resources/completions';
import { Stream } from 'openai/core/streaming';
import { ChatCompletionSnapshot } from 'openai/lib/ChatCompletionStream';

export class OpenAIChatCompletionProvider implements ApiProvider {
  private readonly baseUrl: string;
  private readonly endpoint: string;

  constructor(private readonly config: ProviderConfig) {
    this.baseUrl = this.buildBaseUrl(config.baseUrl);
    this.endpoint = `${this.baseUrl}/chat/completions`;
  }

  private buildBaseUrl(baseUrl: string): string {
    const normalized = normalizeBaseUrlInput(baseUrl);
    return /\/v\d+$/.test(normalized) ? normalized : `${normalized}/v1`;
  }

  private buildHeaders(modelConfig?: ModelConfig): Record<string, string> {
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };

    Object.assign(headers, this.config.extraHeaders, modelConfig?.extraHeaders);

    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    return headers;
  }

  /**
   * Create an OpenAI client with custom fetch for retry support.
   * A new client is created per request to enable per-request logging.
   */
  private createClient(logger?: RequestLogger): OpenAI {
    const customFetch = (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      return fetchWithRetry(url, {
        ...init,
        logger,
        retryConfig: DEFAULT_RETRY_CONFIG,
      });
    };

    return new OpenAI({
      apiKey: this.config.apiKey,
      baseURL: this.baseUrl,
      maxRetries: 0, // Disable SDK's built-in retry - we use our own fetchWithRetry
      fetch: customFetch,
    });
  }

  private convertMessages(
    encodedModelId: string,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
  ): ChatCompletionMessageParam[] {
    const outMessages: ChatCompletionMessageParam[] = [];
    const rawMap = new Map<
      ChatCompletionAssistantMessageParam,
      ChatCompletionMessage
    >();

    for (const msg of messages) {
      switch (msg.role) {
        case vscode.LanguageModelChatMessageRole.System:
          for (const part of msg.content) {
            const parts = this.convertPart(msg.role, part)?.parts as
              | ChatCompletionContentPartText[]
              | undefined;
            if (parts) outMessages.push({ role: 'system', content: parts });
          }
          break;

        case vscode.LanguageModelChatMessageRole.User:
          for (const part of msg.content) {
            const result = this.convertPart(msg.role, part);
            if (result) {
              if (result.isToolResult) {
                outMessages.push({
                  role: 'tool',
                  content: result.parts as ChatCompletionContentPartText[],
                  tool_call_id: result.toolResultId!,
                });
              } else {
                outMessages.push({
                  role: 'user',
                  content: result.parts as ChatCompletionContentPart[],
                });
              }
            }
          }
          break;

        case vscode.LanguageModelChatMessageRole.Assistant:
          const rawPart = msg.content.find(
            (v) => v instanceof vscode.LanguageModelDataPart,
          ) as vscode.LanguageModelDataPart | undefined;
          if (rawPart) {
            try {
              const raw = rawPart
                ? decodeStatefulMarkerPart<ChatCompletionMessage>(
                    encodedModelId,
                    rawPart,
                  )
                : undefined;
              if (raw) {
                const message: ChatCompletionAssistantMessageParam = {
                  role: 'assistant',
                  content: undefined,
                  tool_calls: undefined,
                };
                rawMap.set(message, raw);
                outMessages.push(message);
              }
            } catch (error) {}
          } else {
            for (const part of msg.content) {
              const result = this.convertPart(msg.role, part);
              if (result)
                outMessages.push(
                  result.isToolCall
                    ? {
                        role: 'assistant',
                        tool_calls:
                          result.parts as ChatCompletionMessageToolCall[],
                      }
                    : result.isThinking
                    ? {
                        role: 'assistant',
                        reasoning_content:
                          typeof result.parts === 'string'
                            ? result.parts
                            : (result.parts as ChatCompletionContentPartText[])
                                .map((v) => v.text)
                                .join(''),
                      }
                    : {
                        role: 'assistant',
                        content:
                          result.parts as ChatCompletionContentPartText[],
                      },
                );
            }
          }
          break;

        default:
          throw new Error(
            `Unsupported message role for Anthropic provider: ${msg.role}`,
          );
      }
    }

    // use raw messages, for details, see parseMessage's NOTE comments.
    for (const [param, raw] of rawMap) {
      const index = outMessages.indexOf(param);
      outMessages[index] = raw;
    }

    // TODO 将连续的不同种类的 Assistant 消息尽量合并为一条消息（比如 content, reasoning_content, tool_calls 可以合并，但是 content, content 则不可以合并，(content and reasoning_content), tool_calls 可以合并）

    // add a cache breakpoint at the end.
    this.applyCacheControl(outMessages);

    return outMessages;
  }

  private applyCacheControl(messages: ChatCompletionMessageParam[]): void {
    const lastSystemMessage = messages
      .filter((m) => m.role === 'system')
      .at(-1);
    if (lastSystemMessage && 'content' in lastSystemMessage) {
      this.applyCacheControlToContent(lastSystemMessage);
    }

    const lastUserMessage = messages.filter((m) => m.role === 'user').at(-1);
    if (lastUserMessage && 'content' in lastUserMessage) {
      this.applyCacheControlToContent(lastUserMessage);
    }
  }

  private applyCacheControlToContent(
    message: ChatCompletionMessageParam,
  ): void {
    if (!message.content) return;

    if (typeof message.content === 'string') {
      message.content = [
        {
          type: 'text',
          text: message.content,
          cache_control: { type: 'ephemeral' },
        },
      ];
      return;
    }

    if (Array.isArray(message.content)) {
      const lastTextBlock = [...message.content]
        .reverse()
        .find(
          (part): part is ChatCompletionContentPartText => part.type === 'text',
        );
      if (lastTextBlock) {
        lastTextBlock.cache_control = { type: 'ephemeral' };
      }
    }
  }

  convertPart(
    role: vscode.LanguageModelChatMessageRole | 'tool_result',
    part: vscode.LanguageModelInputPart | unknown,
  ):
    | {
        parts:
          | (ChatCompletionContentPart | ChatCompletionMessageToolCall)[]
          | string;
        isThinking?: boolean;
        isToolCall?: boolean;
        isToolResult?: boolean;
        toolResultId?: string;
      }
    | undefined {
    if (part == null) {
      return undefined;
    }

    if (part instanceof vscode.LanguageModelTextPart) {
      if (part.value.trim()) {
        return { parts: [{ type: 'text', text: part.value }] };
      } else {
        return undefined;
      }
    } else if (part instanceof vscode.LanguageModelThinkingPart) {
      if (role !== vscode.LanguageModelChatMessageRole.Assistant) {
        throw new Error('Thinking parts can only appear in assistant messages');
      }
      const metadata = part.metadata as ThinkingBlockMetadata | undefined;
      if (metadata?.redactedData) {
        // from VSCode.
        return {
          parts: metadata.redactedData,
          isThinking: true,
        };
      } else if (metadata?._completeThinking) {
        // from VSCode.
        return {
          parts: metadata._completeThinking,
          isThinking: true,
        };
      } else {
        return {
          parts:
            typeof part.value === 'string'
              ? part.value
              : part.value.map((v) => ({ type: 'text', text: v })),
          isThinking: true,
        };
      }
    } else if (part instanceof vscode.LanguageModelDataPart) {
      if (isCacheControlMarker(part)) {
        // ignore it, just use the officially recommended caching strategy.
        return undefined;
      } else if (isInternalMarker(part)) {
        return undefined;
      } else if (isImageMarker(part)) {
        if (
          role === vscode.LanguageModelChatMessageRole.Assistant ||
          role === vscode.LanguageModelChatMessageRole.System ||
          role === 'tool_result'
        ) {
          throw new Error(
            'Tool call parts can not appear in system, assistant, or tool_result messages',
          );
        }
        const mimeType = normalizeImageMimeType(part.mimeType);
        if (!mimeType) {
          throw new Error(
            `Unsupported image mime type for provider: ${part.mimeType}`,
          );
        }
        return {
          parts: [
            {
              type: 'image_url',
              image_url: {
                url: `data:${part.mimeType};base64,${Buffer.from(
                  part.data,
                ).toString('base64')}`,
              },
            },
          ],
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
        parts: [
          {
            id: part.callId,
            type: 'function',
            function: {
              name: part.name,
              arguments: this.stringifyArguments(part.input),
            },
          },
        ],
        isToolCall: true,
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
            this.convertPart('tool_result', v)?.parts as
              | ChatCompletionContentPartText[]
              | undefined,
        )
        .filter((v) => v !== undefined)
        .flat();
      return {
        parts:
          content.length > 1
            ? content
            : content.length > 0
            ? content[0].text
            : '',
        isToolResult: true,
        toolResultId: part.callId,
      };
    } else {
      throw new Error(`Unsupported ${role} message part type encountered`);
    }
  }

  private convertTools(
    tools: readonly vscode.LanguageModelChatTool[] | undefined,
  ): ChatCompletionFunctionTool[] | undefined {
    if (!tools || tools.length === 0) {
      return undefined;
    }
    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: (tool.inputSchema ?? {
          type: 'object',
          properties: {},
          required: [],
        }) as FunctionParameters,
      },
    }));
  }

  private convertToolChoice(
    mode: vscode.LanguageModelChatToolMode,
    tools?: ChatCompletionFunctionTool[],
  ): ChatCompletionToolChoiceOption | undefined {
    if (!tools || tools.length === 0) {
      return undefined;
    }
    if (mode === vscode.LanguageModelChatToolMode.Required) {
      if (tools.length === 1) {
        return {
          type: 'function',
          function: { name: tools[0].function.name },
        };
      }
      return 'required';
    }
    return undefined;
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
    const abortController = new AbortController();
    const cancellationListener = token.onCancellationRequested(() => {
      abortController.abort();
    });

    const convertedMessages = this.convertMessages(encodedModelId, messages);
    const tools = this.convertTools(options.tools);
    const toolChoice = this.convertToolChoice(options.toolMode, tools);
    const streamEnabled = model.stream ?? true;

    const baseBody: ChatCompletionCreateParamsBase = {
      model: getBaseModelId(model.id),
      messages: convertedMessages,
      ...(model.thinking?.effort !== undefined
        ? { reasoning_effort: model.thinking.effort }
        : {}),
      ...(model.maxOutputTokens !== undefined
        ? isFeatureSupported(FeatureId.OpenAIOnlyUseMaxCompletionTokens, model)
          ? { max_completion_tokens: model.maxOutputTokens }
          : {
              max_tokens: model.maxOutputTokens,
              max_completion_tokens: model.maxOutputTokens,
            }
        : {}),
      ...(model.temperature !== undefined
        ? { temperature: model.temperature }
        : {}),
      ...(model.topP !== undefined ? { top_p: model.topP } : {}),
      ...(model.frequencyPenalty !== undefined
        ? { frequency_penalty: model.frequencyPenalty }
        : {}),
      ...(model.presencePenalty !== undefined
        ? { presence_penalty: model.presencePenalty }
        : {}),
      ...(model.parallelToolCalling !== undefined
        ? { parallel_tool_calls: model.parallelToolCalling }
        : {}),
      ...(tools !== undefined ? { tools } : {}),
      ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
      stream: streamEnabled,
      ...(streamEnabled ? { stream_options: { include_usage: true } } : {}),
    };

    Object.assign(baseBody, this.config.extraBody, model.extraBody);

    logger.providerRequest({
      provider: this.config.name,
      modelId: model.id,
      endpoint: this.endpoint,
      headers: this.buildHeaders(model),
      body: baseBody,
    });

    const client = this.createClient(logger);

    performanceTrace.ttf = Date.now() - performanceTrace.tts;

    try {
      if (streamEnabled) {
        const { data: stream, response } = await client.chat.completions
          .create(
            { ...baseBody, stream: true },
            {
              signal: abortController.signal,
            },
          )
          .withResponse();
        logger.providerResponseMeta(response);
        yield* this.parseMessageStream(stream, token, logger, performanceTrace);
      } else {
        const { data, response } = await client.chat.completions
          .create(
            { ...baseBody, stream: false },
            {
              signal: abortController.signal,
            },
          )
          .withResponse();
        logger.providerResponseMeta(response);
        yield* this.parseMessage(data, performanceTrace, logger);
      }
    } finally {
      cancellationListener.dispose();
    }
  }

  private async *parseMessage(
    message: ChatCompletion,
    performanceTrace: PerformanceTrace,
    logger: RequestLogger,
  ): AsyncGenerator<vscode.LanguageModelResponsePart2> {
    // NOTE: The current behavior of VSCode is such that all Parts returned here will be
    // aggregated into a single Part during the next request, and only the Thought part
    // will be retained during the tool invocation round; most other types of Parts
    // will be directly ignored, which can prevent us from sending the original data
    // to the model provider and thus compromise full context and prompt caching support.
    // we can only use two approaches simultaneously:
    // 1. use the metadata attribute already in use in vscode-copilot-chat to restore the Thought part,
    // ensuring basic compatibility across different models.
    // 2. always send a StatefulMarker DataPart containing the complete, raw response data, to maximize context restoration.

    logger.providerResponseChunk(JSON.stringify(message));

    performanceTrace.ttft =
      Date.now() - (performanceTrace.tts + performanceTrace.ttf);

    const choice = message.choices[0];
    if (!choice) {
      throw new Error('OpenAI response did not include any choices');
    }

    const raw = choice.message;
    const { content, tool_calls } = raw;

    yield* this.extractThinkingParts(raw);

    if (content) {
      yield new vscode.LanguageModelTextPart(content);
    }

    if (tool_calls) {
      for (const call of tool_calls) {
        if (call.type === 'function') {
          yield new vscode.LanguageModelToolCallPart(
            call.id,
            call.function.name,
            this.parseArguments(call),
          );
        } else {
          throw new Error(`Unsupported tool call type: ${call.type}`);
        }
      }
    }

    yield encodeStatefulMarkerPart<ChatCompletionMessage>(raw);

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

  private parseArguments(
    call: OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall,
  ) {
    let parsedArgs: object = {};
    try {
      const value = JSON.parse(call.function.arguments);
      parsedArgs = typeof value === 'object' && value !== null ? value : {};
    } catch {
      parsedArgs = {};
    }
    return parsedArgs;
  }

  private normalizeThinkingContents(
    message:
      | ChatCompletionMessage
      | ChatCompletionChunk.Choice.Delta
      | ChatCompletionSnapshot.Choice.Message,
  ): OpenRouterReasoningDetail[] | undefined {
    const details = message.reasoning_details;
    if (details && details.length > 0) {
      return details;
    }

    if (message.reasoning_content) {
      return [
        {
          type: 'reasoning.text',
          index: 0,
          text: message.reasoning_content,
        },
      ];
    }

    if (message.reasoning) {
      return [
        {
          type: 'reasoning.text',
          index: 0,
          text: message.reasoning,
        },
      ];
    }

    return undefined;
  }

  private *extractThinkingParts(
    message:
      | ChatCompletionMessage
      | ChatCompletionChunk.Choice.Delta
      | ChatCompletionSnapshot.Choice.Message,
    emitMode: 'full' | 'metadata-only' | 'content-only' = 'full',
    metadata?: ThinkingBlockMetadata,
  ): Generator<vscode.LanguageModelThinkingPart> {
    const contents = this.normalizeThinkingContents(message);

    if (!contents) {
      return undefined;
    }

    if (emitMode !== 'content-only' && metadata == null) {
      metadata = {};
    }

    for (const content of contents) {
      switch (content.type) {
        case 'reasoning.summary':
          if (emitMode !== 'metadata-only') {
            yield new vscode.LanguageModelThinkingPart(content.summary);
          }
          if (metadata) {
            metadata._completeThinking =
              (metadata._completeThinking || '') + content.summary;
          }
          break;

        case 'reasoning.text':
          if (emitMode !== 'metadata-only') {
            yield new vscode.LanguageModelThinkingPart(content.text);
          }
          if (metadata) {
            metadata._completeThinking =
              (metadata._completeThinking || '') + content.text;
            if (content.signature) {
              metadata.signature = content.signature;
            }
          }
          break;

        case 'reasoning.encrypted':
          if (emitMode !== 'metadata-only') {
            yield new vscode.LanguageModelThinkingPart('[Thinking...]');
          }
          if (metadata) {
            metadata.redactedData = content.data;
          }
          break;

        default:
          throw new Error(
            `Unsupported reasoning detail type: ${
              (content as OpenRouterReasoningDetail).type
            }`,
          );
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
    stream: Stream<OpenAI.Chat.Completions.ChatCompletionChunk>,
    token: vscode.CancellationToken,
    logger: RequestLogger,
    performanceTrace: PerformanceTrace,
  ): AsyncGenerator<vscode.LanguageModelResponsePart2> {
    let snapshot: ChatCompletionSnapshot | undefined;
    let usage: CompletionUsage | null | undefined;

    let firstTokenRecorded = false;
    const recordFirstToken = () => {
      if (!firstTokenRecorded) {
        performanceTrace.ttft =
          Date.now() - (performanceTrace.tts + performanceTrace.ttf);
        firstTokenRecorded = true;
      }
    };

    for await (const event of stream) {
      if (token.isCancellationRequested) {
        break;
      }

      logger.providerResponseChunk(JSON.stringify(event));

      snapshot = this.accumulateChatCompletion(snapshot, event);
      if (event.usage) usage = event.usage;

      const choice = event.choices[0];
      if (!choice) {
        continue;
      }

      const { content } = choice.delta;

      recordFirstToken();

      yield* this.extractThinkingParts(choice.delta, 'content-only');

      if (content) {
        yield new vscode.LanguageModelTextPart(content);
      }

      if (choice.finish_reason) {
        const message = snapshot.choices[choice.index].message;

        const {
          content,
          tool_calls,
          refusal,
          reasoning,
          reasoning_content,
          reasoning_details,
        } = message;

        yield* this.extractThinkingParts(message, 'metadata-only');

        if (tool_calls && tool_calls.length > 0) {
          for (const call of tool_calls) {
            if (call.type === 'function') {
              yield new vscode.LanguageModelToolCallPart(
                call.id,
                call.function.name,
                this.parseArguments(call),
              );
            }
          }
        }

        yield encodeStatefulMarkerPart<ChatCompletionMessage>({
          role: 'assistant',
          content: content ?? null,
          refusal: refusal ?? null,
          tool_calls: tool_calls ?? undefined,
          reasoning,
          reasoning_content,
          reasoning_details,
        });
      }
    }

    if (usage) {
      this.processUsage(usage, performanceTrace, logger);
    }
  }

  accumulateChatCompletion(
    snapshot: ChatCompletionSnapshot | undefined,
    chunk: ChatCompletionChunk,
  ): ChatCompletionSnapshot {
    const { choices, ...rest } = chunk;
    if (!snapshot) {
      snapshot = {
        ...rest,
        choices: [],
      };
    } else {
      Object.assign(snapshot, rest);
    }

    for (const {
      delta,
      finish_reason,
      index,
      logprobs = null,
      ...other
    } of chunk.choices) {
      let choice = snapshot.choices[index];
      if (!choice) {
        choice = snapshot.choices[index] = {
          finish_reason,
          index,
          message: {},
          logprobs,
          ...other,
        };
      }

      if (logprobs) {
        if (!choice.logprobs) {
          choice.logprobs = Object.assign({}, logprobs);
        } else {
          const { content, refusal } = logprobs;

          if (content) {
            choice.logprobs.content ??= [];
            choice.logprobs.content.push(...content);
          }

          if (refusal) {
            choice.logprobs.refusal ??= [];
            choice.logprobs.refusal.push(...refusal);
          }
        }
      }

      if (finish_reason) {
        choice.finish_reason = finish_reason;
      }

      Object.assign(choice, other);

      if (!delta) continue; // Shouldn't happen; just in case.

      const {
        content,
        reasoning,
        reasoning_content,
        reasoning_details,
        refusal,
        role,
        tool_calls,
      } = delta;

      if (refusal) {
        choice.message.refusal = (choice.message.refusal || '') + refusal;
      }

      if (role) choice.message.role = role;

      if (content) {
        choice.message.content = (choice.message.content || '') + content;
      }

      if (reasoning_content) {
        choice.message.reasoning_content =
          (choice.message.reasoning_content || '') + reasoning_content;
      }

      if (reasoning) {
        choice.message.reasoning = (choice.message.reasoning || '') + reasoning;
      }

      if (reasoning_details && reasoning_details.length > 0) {
        const details = (choice.message.reasoning_details ??= []);
        for (const delta of reasoning_details) {
          if (delta.index != null) {
            details[delta.index] = delta;
          } else {
            details.push({
              ...delta,
              index: details.length,
            });
          }
        }
      }

      if (tool_calls) {
        if (!choice.message.tool_calls) choice.message.tool_calls = [];

        for (const { index, id, type, function: fn, ...rest } of tool_calls) {
          const tool_call = (choice.message.tool_calls[index] ??=
            {} as ChatCompletionSnapshot.Choice.Message.ToolCall);
          Object.assign(tool_call, rest);
          if (id) tool_call.id = id;
          if (type) tool_call.type = type;
          if (fn) tool_call.function ??= { name: fn.name ?? '', arguments: '' };
          if (fn?.name) tool_call.function!.name = fn.name;
          if (fn?.arguments) {
            tool_call.function!.arguments += fn.arguments;
          }
        }
      }
    }

    return snapshot;
  }

  private processUsage(
    usage: CompletionUsage,
    performanceTrace: PerformanceTrace,
    logger: RequestLogger,
  ) {
    if (usage.completion_tokens) {
      performanceTrace.tps =
        (usage.completion_tokens /
          (Date.now() - (performanceTrace.tts + performanceTrace.ttf))) *
        1000;
    } else {
      performanceTrace.tps = NaN;
    }
    logger.usage(usage);
  }

  estimateTokenCount(text: string): number {
    // Rough estimation: ~4 characters per token for English text
    return Math.ceil(text.length / 4);
  }

  async getAvailableModels(): Promise<ModelConfig[]> {
    const result: ModelConfig[] = [];
    const client = this.createClient();
    const page = await client.models.list();
    for await (const model of page) {
      const wellKnowns = WELL_KNOWN_MODELS.find((v) => v.id === model.id);
      result.push(Object.assign(wellKnowns ?? {}, { id: model.id }));
    }
    return result;
  }
}
