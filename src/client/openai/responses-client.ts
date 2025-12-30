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
  isFeatureSupported,
  mergeHeaders,
  parseToolArguments,
  processUsage as sharedProcessUsage,
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
  ResponseReasoningItem,
  ResponseStreamEvent,
  ResponseUsage,
  ToolChoiceFunction,
  ToolChoiceOptions,
} from 'openai/resources/responses/responses';
import { getBaseModelId } from '../../model-id-utils';
import { randomUUID } from 'crypto';
import { ProviderConfig, ModelConfig, PerformanceTrace } from '../../types';

export class OpenAIResponsesProvider implements ApiProvider {
  private readonly baseUrl: string;

  constructor(private readonly config: ProviderConfig) {
    this.baseUrl = buildBaseUrl(config.baseUrl, {
      ensureSuffix: '/v1',
      skipSuffixIfMatch: /\/v\d+$/,
    });
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
   * Create an OpenAI client with custom fetch for retry support.
   * A new client is created per request to enable per-request logging.
   */
  private createClient(
    logger: ProviderHttpLogger | undefined,
    stream: boolean,
  ): OpenAI {
    const requestTimeoutMs = stream
      ? this.config.timeout?.connection ?? DEFAULT_TIMEOUT_CONFIG.connection
      : this.config.timeout?.response ?? DEFAULT_TIMEOUT_CONFIG.response;

    return new OpenAI({
      apiKey: this.config.apiKey,
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
  ): ResponseInput {
    const outItems: ResponseInputItem[] = [];
    const rawMap = new Map<ResponseInputItem, ResponseInputItem[]>();

    for (const msg of messages) {
      switch (msg.role) {
        case vscode.LanguageModelChatMessageRole.System:
          for (const part of msg.content) {
            const parts = this.convertPart(msg.role, part) as
              | EasyInputMessage
              | undefined;
            if (parts) outItems.push(parts);
          }
          break;

        case vscode.LanguageModelChatMessageRole.User:
          for (const part of msg.content) {
            const parts = this.convertPart(msg.role, part) as
              | EasyInputMessage
              | ResponseInputItem.FunctionCallOutput
              | undefined;
            if (parts) outItems.push(parts);
          }
          break;

        case vscode.LanguageModelChatMessageRole.Assistant:
          {
            const rawPart = msg.content.find(
              (v) => v instanceof vscode.LanguageModelDataPart,
            ) as vscode.LanguageModelDataPart | undefined;
            if (rawPart) {
              try {
                const raw = decodeStatefulMarkerPart<ResponseInputItem[]>(
                  encodedModelId,
                  rawPart,
                );
                const item: EasyInputMessage = {
                  role: 'assistant',
                  content: '',
                  type: 'message',
                };
                rawMap.set(item, raw);
                outItems.push(item);
                break;
              } catch (error) {}
            } else {
              for (const part of msg.content) {
                const parts = this.convertPart(msg.role, part) as
                  | EasyInputMessage
                  | ResponseFunctionToolCall
                  | ResponseReasoningItem
                  | undefined;
                if (parts) outItems.push(parts);
              }
            }
          }
          break;

        default:
          throw new Error(`Unsupported message role for provider: ${msg.role}`);
      }
    }

    // use raw messages, for details, see parseMessage's NOTE comments.
    for (const [param, raw] of rawMap) {
      const index = outItems.indexOf(param);
      if (index === -1) continue;
      outItems.splice(index, 1, ...raw);
    }

    return outItems;
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

    const roleStr: 'assistant' | 'system' | 'user' =
      role === vscode.LanguageModelChatMessageRole.Assistant
        ? 'assistant'
        : role === vscode.LanguageModelChatMessageRole.System
        ? 'system'
        : 'user';

    if (part instanceof vscode.LanguageModelTextPart) {
      if (part.value.trim()) {
        const content = { type: 'input_text', text: part.value } as const;
        return role === 'from_tool_result'
          ? [content]
          : {
              type: 'message',
              role: roleStr,
              content: [content],
            };
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
              type: 'message',
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

    return undefined;
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
    const useThinkingParam2 = isFeatureSupported(
      FeatureId.OpenAIUseThinkingParam2,
      this.config,
      model,
    );

    const baseBody: ResponseCreateParamsBase = {
      model: getBaseModelId(model.id),
      input: convertedMessages,
      ...this.buildReasoningParams(model, useThinkingParam2),
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
      include: ['reasoning.encrypted_content'],
    };

    Object.assign(baseBody, this.config.extraBody, model.extraBody);

    const headers = this.buildHeaders(model);

    const client = this.createClient(logger, streamEnabled);

    performanceTrace.ttf = Date.now() - performanceTrace.tts;

    try {
      if (streamEnabled) {
        const responseTimeoutMs =
          this.config.timeout?.response ?? DEFAULT_TIMEOUT_CONFIG.response;

        const stream = await client.responses.create(
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
        const data = await client.responses.create(
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
    message: OpenAIResponse,
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

    yield encodeStatefulMarkerPart<ResponseInputItem[]>(message.output);

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
    token: vscode.CancellationToken,
    logger: RequestLogger,
    performanceTrace: PerformanceTrace,
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

          yield encodeStatefulMarkerPart<ResponseInputItem[]>(response.output);
          break;
        }

        case 'response.failed':
          throw new Error(
            `OpenAI Response Failed: ${
              event.response.error
                ? `${event.response.error.message}(${event.response.error.code})`
                : 'unknown error'
            }`,
          );

        case 'response.incomplete':
          throw new Error(
            `OpenAI Response Incomplete: ${
              event.response.incomplete_details?.reason || 'unknown reason'
            }`,
          );

        case 'error':
          throw new Error(
            `OpenAI API Error: ${event.message}${
              event.code ? ` (${event.code})` : ''
            }`,
          );

        default:
          break;
      }
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
    sharedProcessUsage(
      usage.output_tokens,
      performanceTrace,
      logger,
      usage as unknown as Record<string, unknown>,
    );
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
    try {
      const result: ModelConfig[] = [];
      const client = this.createClient(logger, false);
      const page = await client.models.list({ headers: this.buildHeaders() });
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
