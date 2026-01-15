import {
  LanguageModelChatRequestMessage,
  ProvideLanguageModelChatResponseOptions,
  CancellationToken,
} from 'vscode';
import { createSimpleHttpLogger } from '../../logger';
import type { ProviderHttpLogger, RequestLogger } from '../../logger';
import { ApiProvider } from '../interface';
import { ProviderConfig, ModelConfig, PerformanceTrace } from '../../types';
import type { AuthTokenInfo } from '../../auth/types';
import OpenAI from 'openai';
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
import {
  buildBaseUrl,
  createCustomFetch,
  createFirstTokenRecorder,
  estimateTokenCount as sharedEstimateTokenCount,
  getToken,
  getTokenType,
  isFeatureSupported,
  mergeHeaders,
  parseToolArguments,
  processUsage as sharedProcessUsage,
} from '../utils';
import * as vscode from 'vscode';
import {
  ChatCompletion,
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionContentPartText,
  ChatCompletionCreateParamsBase,
  ChatCompletionFunctionTool,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionSystemMessageParam,
  ChatCompletionToolChoiceOption,
  ChatCompletionToolMessageParam,
  ChatCompletionUserMessageParam,
  OpenRouterReasoningDetail,
} from 'openai/resources/chat/completions';
import { FunctionParameters } from 'openai/resources/shared';
import { getBaseModelId } from '../../model-id-utils';
import { CompletionUsage } from 'openai/resources/completions';
import { ChatCompletionSnapshot } from 'openai/lib/ChatCompletionStream';
import { ThinkingBlockMetadata } from '../types';
import { FeatureId } from '../definitions';

export class OpenAIChatCompletionProvider implements ApiProvider {
  private readonly baseUrl: string;

  constructor(private readonly config: ProviderConfig) {
    this.baseUrl = buildBaseUrl(config.baseUrl, {
      ensureSuffix: '/v1',
      skipSuffixIfMatch: /\/v\d+$/,
    });
  }

  private buildHeaders(
    credential?: AuthTokenInfo,
    modelConfig?: ModelConfig,
  ): Record<string, string> {
    const token = getToken(credential);
    const headers = mergeHeaders(token, this.config.extraHeaders, modelConfig?.extraHeaders);

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
  private createClient(
    logger: ProviderHttpLogger | undefined,
    stream: boolean,
    credential?: AuthTokenInfo,
  ): OpenAI {
    const requestTimeoutMs = stream
      ? this.config.timeout?.connection ?? DEFAULT_TIMEOUT_CONFIG.connection
      : this.config.timeout?.response ?? DEFAULT_TIMEOUT_CONFIG.response;

    const token = getToken(credential);

    return new OpenAI({
      apiKey: token ?? '',
      baseURL: this.baseUrl,
      maxRetries: 0,
      fetch: createCustomFetch({
        connectionTimeoutMs: requestTimeoutMs,
        logger,
      }),
    });
  }

  private convertMessages(
    encodedModelId: string,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    shouldApplyCacheControl: boolean,
    reasoningType: 'content' | 'details' | 'none',
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
            const parts = this.convertPart(msg.role, part) as
              | ChatCompletionSystemMessageParam
              | undefined;
            if (parts) outMessages.push(parts);
          }
          break;

        case vscode.LanguageModelChatMessageRole.User:
          for (const part of msg.content) {
            const parts = this.convertPart(msg.role, part) as
              | ChatCompletionUserMessageParam
              | ChatCompletionToolMessageParam
              | undefined;
            if (parts) outMessages.push(parts);
          }
          break;

        case vscode.LanguageModelChatMessageRole.Assistant:
          const rawPart = msg.content.find(
            (v) => v instanceof vscode.LanguageModelDataPart,
          ) as vscode.LanguageModelDataPart | undefined;
          if (rawPart) {
            try {
              const raw = decodeStatefulMarkerPart<ChatCompletionMessage>(
                encodedModelId,
                rawPart,
              );
              const message: ChatCompletionAssistantMessageParam = {
                role: 'assistant',
                content: undefined,
                tool_calls: undefined,
              };
              rawMap.set(message, raw);
              outMessages.push(message);
            } catch (error) {}
          } else {
            for (const part of msg.content) {
              const parts = this.convertPart(msg.role, part, reasoningType) as
                | ChatCompletionAssistantMessageParam
                | undefined;
              if (parts) outMessages.push(parts);
            }
          }
          break;

        default:
          throw new Error(`Unsupported message role for provider: ${msg.role}`);
      }
    }

    // use raw messages, for details, see parseMessage's NOTE comments.
    for (const [param, raw] of rawMap) {
      const index = outMessages.indexOf(param);
      outMessages[index] = raw;
    }

    // TODO 将连续的不同种类的 Assistant 消息尽量合并为一条消息（比如 content, reasoning_content, tool_calls 可以合并，但是 content, content 则不可以合并，(content and reasoning_content), tool_calls 可以合并）

    // add a cache breakpoint at the end.
    if (shouldApplyCacheControl) {
      this.applyCacheControl(outMessages);
    }

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
    role: vscode.LanguageModelChatMessageRole | 'from_tool_result',
    part: vscode.LanguageModelInputPart | unknown,
    reasoningType: 'content' | 'details' | 'none' = 'none',
  ):
    | ChatCompletionToolMessageParam
    | ChatCompletionUserMessageParam
    | ChatCompletionSystemMessageParam
    | ChatCompletionAssistantMessageParam
    | ChatCompletionContentPartText[]
    | undefined {
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
        const content: ChatCompletionContentPartText[] = [
          { type: 'text', text: part.value },
        ];
        return role === 'from_tool_result'
          ? content
          : {
              role: roleStr,
              content: [{ type: 'text', text: part.value }],
            };
      } else {
        return undefined;
      }
    } else if (part instanceof vscode.LanguageModelThinkingPart) {
      if (role !== vscode.LanguageModelChatMessageRole.Assistant) {
        throw new Error('Thinking parts can only appear in assistant messages');
      }
      const metadata = part.metadata as ThinkingBlockMetadata | undefined;
      const contents =
        typeof part.value === 'string' ? [part.value] : part.value;
      if (reasoningType === 'content') {
        // content type doesn't support encrypted thinking and signature.
        return {
          role: 'assistant',
          reasoning_content: contents.join(''),
        };
      } else if (reasoningType === 'details') {
        if (metadata?.redactedData) {
          // from VSCode.
          return {
            role: 'assistant',
            reasoning_details: [
              {
                type: 'reasoning.encrypted',
                index: 0,
                data: metadata.redactedData,
              },
            ],
          };
        } else if (metadata?._completeThinking) {
          // from VSCode.
          return {
            role: 'assistant',
            reasoning_details: [
              {
                type: 'reasoning.text',
                index: 0,
                text: metadata._completeThinking,
                signature: metadata.signature,
              },
            ],
          };
        } else {
          return {
            role: 'assistant',
            reasoning_details: contents.map((v, i) => ({
              type: 'reasoning.text',
              index: i,
              text: v,
            })),
          };
        }
      } else {
        return undefined;
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
          role === 'from_tool_result'
        ) {
          throw new Error(
            'Image parts can not appear in system, assistant, or tool_result messages',
          );
        }
        const mimeType = normalizeImageMimeType(part.mimeType);
        if (!mimeType) {
          throw new Error(
            `Unsupported image mime type for provider: ${part.mimeType}`,
          );
        }
        return {
          role: 'user',
          content: [
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
        role: 'assistant',
        tool_calls: [
          {
            id: part.callId,
            type: 'function',
            function: {
              name: part.name,
              arguments: this.stringifyArguments(part.input),
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
        .map(
          (v) =>
            this.convertPart('from_tool_result', v) as
              | ChatCompletionContentPartText[]
              | undefined,
        )
        .filter((v) => v !== undefined)
        .flat();
      return {
        role: 'tool',
        content:
          content.length > 1
            ? content
            : content.length > 0
            ? content[0].text
            : '',
        tool_call_id: part.callId,
      };
    } else {
      throw new Error(`Unsupported ${role} message part type encountered`);
    }
  }

  private convertTools(
    tools: readonly vscode.LanguageModelChatTool[] | undefined,
    shouldApplyCacheControl: boolean,
  ): ChatCompletionFunctionTool[] | undefined {
    if (!tools || tools.length === 0) {
      return undefined;
    }

    const result = tools.map(
      (tool) =>
        ({
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
        } as ChatCompletionFunctionTool),
    );

    // Add cache control to last tool to prevent reuse across requests
    if (shouldApplyCacheControl) {
      if (result.length > 0) {
        result.at(-1)!.cache_control = { type: 'ephemeral' };
      }
    }

    return result;
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

  private buildReasoningParams(
    model: ModelConfig,
    type:
      | 'reasoning'
      | 'thinking'
      | 'official'
      | 'enable_thinking'
      | 'enable_thinking_with_budget',
  ): Partial<ChatCompletionCreateParamsBase> {
    const thinking = model.thinking;
    if (!thinking) {
      return {};
    }

    if (thinking.type === 'disabled') {
      return type === 'reasoning'
        ? { reasoning: { enabled: false } }
        : type === 'thinking'
        ? { thinking: { type: 'disabled' } }
        : type === 'enable_thinking' || type === 'enable_thinking_with_budget'
        ? { enable_thinking: false }
        : { reasoning_effort: 'none' };
    }

    if (thinking.budgetTokens !== undefined) {
      return type === 'reasoning'
        ? {
            reasoning: {
              max_tokens: this.normalizeReasoningMaxTokens(
                thinking.budgetTokens,
                model.maxOutputTokens,
              ),
            },
          }
        : type === 'thinking'
        ? { thinking: { type: 'enabled' } }
        : type === 'enable_thinking_with_budget'
        ? {
            enable_thinking: true,
            thinking_budget: thinking.budgetTokens,
          }
        : type === 'enable_thinking'
        ? { enable_thinking: true }
        : // Defaults to 'medium' effort if budget is set
          { reasoning_effort: 'medium' };
    }

    if (thinking.effort !== undefined) {
      return type === 'reasoning'
        ? { reasoning: { effort: thinking.effort } }
        : type === 'thinking'
        ? { thinking: { type: 'enabled' } }
        : type === 'enable_thinking' || type === 'enable_thinking_with_budget'
        ? { enable_thinking: true }
        : { reasoning_effort: thinking.effort };
    }

    return type === 'reasoning'
      ? { reasoning: { enabled: true } }
      : type === 'thinking'
      ? { thinking: { type: 'enabled' } }
      : type === 'enable_thinking' || type === 'enable_thinking_with_budget'
      ? { enable_thinking: true }
      : // Defaults to 'medium' effort if not set effort or budget
        { reasoning_effort: 'medium' };
  }

  private normalizeReasoningMaxTokens(
    maxReasoningTokens: number,
    maxOutputTokens: number | undefined,
  ): number {
    if (maxOutputTokens === undefined || maxOutputTokens <= 1) {
      return maxReasoningTokens;
    }
    return Math.min(maxReasoningTokens, maxOutputTokens - 1);
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

    const shouldApplyCacheControl = isFeatureSupported(
      FeatureId.OpenAICacheControl,
      this.config,
      model,
    );
    const useReasoningParam = isFeatureSupported(
      FeatureId.OpenAIUseReasoningParam,
      this.config,
      model,
    );
    const useThinkingParam = isFeatureSupported(
      FeatureId.OpenAIUseThinkingParam,
      this.config,
      model,
    );
    const useTopK = isFeatureSupported(
      FeatureId.OpenAIUseTopK,
      this.config,
      model,
    );
    const useMaxInputTokens = isFeatureSupported(
      FeatureId.OpenAIUseMaxInputTokens,
      this.config,
      model,
    );
    const useThinkingParam3 = isFeatureSupported(
      FeatureId.OpenAIUseThinkingParam3,
      this.config,
      model,
    );
    const useThinkingBudgetParam = isFeatureSupported(
      FeatureId.OpenAIUseThinkingBudgetParam,
      this.config,
      model,
    );
    const useReasoningDetails = isFeatureSupported(
      FeatureId.OpenAIUseReasoningDetails,
      this.config,
      model,
    );
    const useReasoningContent = isFeatureSupported(
      FeatureId.OpenAIUseReasoningContent,
      this.config,
      model,
    );
    const useClearThinking = isFeatureSupported(
      FeatureId.OpenAIUseClearThinking,
      this.config,
      model,
    );
    const useOnlyMaxCompletionTokens = isFeatureSupported(
      FeatureId.OpenAIOnlyMaxCompletionTokens,
      this.config,
      model,
    );
    const useOnlyMaxTokens = isFeatureSupported(
      FeatureId.OpenAIOnlyMaxTokens,
      this.config,
      model,
    );

    const thinkingParamType:
      | 'reasoning'
      | 'thinking'
      | 'official'
      | 'enable_thinking'
      | 'enable_thinking_with_budget' = useReasoningParam
      ? 'reasoning'
      : useThinkingParam
      ? 'thinking'
      : useThinkingParam3
      ? useThinkingBudgetParam
        ? 'enable_thinking_with_budget'
        : 'enable_thinking'
      : 'official';
    const reasoningType: 'content' | 'details' | 'none' = useReasoningDetails
      ? 'details'
      : useReasoningContent
      ? 'content'
      : 'none';

    const convertedMessages = this.convertMessages(
      encodedModelId,
      messages,
      shouldApplyCacheControl,
      reasoningType,
    );
    const tools = this.convertTools(options.tools, shouldApplyCacheControl);
    const toolChoice = this.convertToolChoice(options.toolMode, tools);
    const streamEnabled = model.stream ?? true;

    const headers = this.buildHeaders(credential, model);

    const baseBody: ChatCompletionCreateParamsBase = {
      model: getBaseModelId(model.id),
      messages: convertedMessages,
      ...this.buildReasoningParams(model, thinkingParamType),
      ...(useTopK && model.topK !== undefined ? { top_k: model.topK } : {}),
      ...(useClearThinking ? { clear_thinking: false } : {}),
      ...(useMaxInputTokens && model.maxInputTokens !== undefined
        ? { max_input_tokens: model.maxInputTokens }
        : {}),
      ...(model.maxOutputTokens !== undefined
        ? useOnlyMaxCompletionTokens
          ? { max_completion_tokens: model.maxOutputTokens }
          : useOnlyMaxTokens
          ? { max_tokens: model.maxOutputTokens }
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

    const client = this.createClient(logger, streamEnabled, credential);

    performanceTrace.ttf = Date.now() - performanceTrace.tts;

    try {
      if (streamEnabled) {
        const responseTimeoutMs =
          this.config.timeout?.response ?? DEFAULT_TIMEOUT_CONFIG.response;

        const stream = await client.chat.completions.create(
          { ...baseBody, stream: true },
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
        yield* this.parseMessageStream(
          timedStream,
          token,
          logger,
          performanceTrace,
        );
      } else {
        const data = await client.chat.completions.create(
          { ...baseBody, stream: false },
          {
            headers,
            signal: abortController.signal,
          },
        );
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
    return parseToolArguments(call.function.arguments);
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
            yield new vscode.LanguageModelThinkingPart('Encrypted thinking...');
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
    stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
    token: vscode.CancellationToken,
    logger: RequestLogger,
    performanceTrace: PerformanceTrace,
  ): AsyncGenerator<vscode.LanguageModelResponsePart2> {
    let snapshot: ChatCompletionSnapshot | undefined;
    let usage: CompletionUsage | null | undefined;

    const recordFirstToken = createFirstTokenRecorder(performanceTrace);

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
            const old = details[delta.index];
            if (!old) {
              details[delta.index] = delta;
              continue;
            }
            switch (old.type) {
              case 'reasoning.text':
                const cur = delta as typeof old;
                old.text += cur.text;
                if (cur.signature) old.signature = cur.signature;
                break;

              case 'reasoning.summary':
                {
                  const cur = delta as typeof old;
                  old.summary += cur.summary;
                }
                break;

              case 'reasoning.encrypted':
                {
                  const cur = delta as typeof old;
                  old.data += cur.data;
                }
                break;

              default:
                throw new Error(
                  `Unsupported reasoning detail type: ${
                    (old as OpenRouterReasoningDetail).type
                  }`,
                );
            }
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
    sharedProcessUsage(
      usage.completion_tokens,
      performanceTrace,
      logger,
      usage as unknown as Record<string, unknown>,
    );
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
      const client = this.createClient(logger, false, credential);
      const page = await client.models.list({
        headers: this.buildHeaders(credential),
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
