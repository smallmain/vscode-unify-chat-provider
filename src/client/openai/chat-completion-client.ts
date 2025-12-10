import OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionContentPartImage,
  ChatCompletionContentPartText,
  ChatCompletionFunctionTool,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionToolChoiceOption,
  ChatCompletionCreateParamsBase,
} from 'openai/resources/chat/completions';
import * as vscode from 'vscode';
import {
  logResponseChunk,
  logResponseComplete,
  logResponseError,
  startRequestLog,
  logInfo,
} from '../../logger';
import type { CompletionUsage } from 'openai/resources/completions';
import { PerformanceTrace, CustomDataPartMimeTypes } from '../../types';
import { normalizeBaseUrlInput } from '../../utils';
import { ApiProvider, ModelConfig, ProviderConfig } from '../interface';
import { FeatureId, isFeatureSupported } from '../../features';
import { WELL_KNOWN_MODELS } from '../../well-known-models';

type OpenAIContentPart =
  | ChatCompletionContentPartText
  | ChatCompletionContentPartImage;
type OpenAITextContentPart = ChatCompletionContentPartText;

type ToolCallState = {
  id?: string;
  name?: string;
  args: string;
};

type MessageContent = vscode.LanguageModelChatRequestMessage['content'][number];
type ToolResultContent = vscode.LanguageModelToolResultPart['content'][number];

export class OpenAIChatCompletionProvider implements ApiProvider {
  private readonly client: OpenAI;
  private readonly baseUrl: string;
  private readonly endpoint: string;

  constructor(private readonly config: ProviderConfig) {
    this.baseUrl = this.buildBaseUrl(config.baseUrl);
    this.endpoint = `${this.baseUrl}/chat/completions`;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: this.baseUrl,
    });
  }

  private buildBaseUrl(baseUrl: string): string {
    const normalized = normalizeBaseUrlInput(baseUrl);
    return /\/v\d+$/.test(normalized) ? normalized : `${normalized}/v1`;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }
    return headers;
  }

  private stringifyArguments(input: unknown): string {
    try {
      return JSON.stringify(input ?? {});
    } catch {
      return '{}';
    }
  }

  private convertContentParts(
    parts: readonly MessageContent[],
  ): OpenAIContentPart[] {
    const content: OpenAIContentPart[] = [];

    for (const part of parts) {
      if (part instanceof vscode.LanguageModelTextPart) {
        if (part.value.trim()) {
          content.push({ type: 'text', text: part.value });
        }
      } else if (part instanceof vscode.LanguageModelDataPart) {
        if (
          part.mimeType === CustomDataPartMimeTypes.CacheControl ||
          part.mimeType === CustomDataPartMimeTypes.StatefulMarker ||
          part.mimeType === CustomDataPartMimeTypes.ThinkingData
        ) {
          continue;
        }
        if (part.mimeType.startsWith('image/')) {
          const dataString = Buffer.from(part.data).toString('utf-8');
          const isUrl =
            dataString.startsWith('http://') ||
            dataString.startsWith('https://') ||
            dataString.startsWith('data:');
          const url = isUrl
            ? dataString
            : `data:${part.mimeType};base64,${Buffer.from(part.data).toString(
                'base64',
              )}`;
          content.push({ type: 'image_url', image_url: { url } });
        } else if (
          part.mimeType.startsWith('text/') ||
          part.mimeType === 'application/json' ||
          part.mimeType.endsWith('+json')
        ) {
          const text = Buffer.from(part.data).toString('utf-8');
          if (text.trim()) {
            content.push({ type: 'text', text });
          }
        } else {
          throw new Error(
            `Unsupported data part mime type for OpenAI provider: ${part.mimeType}`,
          );
        }
      } else if (
        part instanceof vscode.LanguageModelThinkingPart ||
        part instanceof vscode.LanguageModelToolCallPart ||
        part instanceof vscode.LanguageModelToolResultPart
      ) {
        continue;
      } else {
        throw new Error('Unsupported message part type for OpenAI provider.');
      }
    }

    return content;
  }

  private convertTextContentParts(
    parts: readonly MessageContent[],
  ): OpenAITextContentPart[] {
    const content: OpenAITextContentPart[] = [];

    for (const part of parts) {
      if (part instanceof vscode.LanguageModelTextPart) {
        if (part.value.trim()) {
          content.push({ type: 'text', text: part.value });
        }
      } else if (part instanceof vscode.LanguageModelDataPart) {
        if (
          part.mimeType === CustomDataPartMimeTypes.CacheControl ||
          part.mimeType === CustomDataPartMimeTypes.StatefulMarker ||
          part.mimeType === CustomDataPartMimeTypes.ThinkingData
        ) {
          continue;
        }
        if (
          part.mimeType.startsWith('text/') ||
          part.mimeType === 'application/json' ||
          part.mimeType.endsWith('+json')
        ) {
          const text = Buffer.from(part.data).toString('utf-8');
          if (text.trim()) {
            content.push({ type: 'text', text });
          }
        } else {
          throw new Error(
            `Unsupported data part mime type for text-only conversion in OpenAI provider: ${part.mimeType}`,
          );
        }
      } else if (
        part instanceof vscode.LanguageModelThinkingPart ||
        part instanceof vscode.LanguageModelToolCallPart ||
        part instanceof vscode.LanguageModelToolResultPart
      ) {
        continue;
      } else {
        throw new Error('Unsupported message part type for OpenAI provider.');
      }
    }

    return content;
  }

  private convertAssistantParts(
    parts: readonly MessageContent[],
    includeReasoningContent: boolean,
  ): {
    content: OpenAITextContentPart[];
    toolCalls: ChatCompletionMessageToolCall[];
    reasoningContent?: string;
  } {
    const content: OpenAITextContentPart[] = [];
    const toolCalls: ChatCompletionMessageToolCall[] = [];
    const reasoningParts: string[] = [];

    for (const part of parts) {
      if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push({
          id: part.callId,
          type: 'function',
          function: {
            name: part.name,
            arguments: this.stringifyArguments(part.input),
          },
        });
      } else if (part instanceof vscode.LanguageModelThinkingPart) {
        if (includeReasoningContent) {
          reasoningParts.push(
            ...(Array.isArray(part.value) ? part.value : [part.value]),
          );
        }
        continue;
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        continue;
      } else {
        content.push(...this.convertTextContentParts([part]));
      }
    }

    return {
      content,
      toolCalls,
      reasoningContent:
        reasoningParts.length > 0 ? reasoningParts.join('\n') : undefined,
    };
  }

  private convertUserMessageParts(parts: readonly MessageContent[]): {
    content: OpenAIContentPart[];
    toolResults: ChatCompletionMessageParam[];
  } {
    const content: OpenAIContentPart[] = [];
    const toolResults: ChatCompletionMessageParam[] = [];

    for (const part of parts) {
      if (part instanceof vscode.LanguageModelToolResultPart) {
        const text = this.extractToolResultText(part.content);
        toolResults.push({
          role: 'tool',
          tool_call_id: part.callId,
          content: text,
        });
      } else if (part instanceof vscode.LanguageModelThinkingPart) {
        continue;
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        continue;
      } else {
        content.push(...this.convertContentParts([part]));
      }
    }

    return { content, toolResults };
  }

  private extractToolResultText(content: readonly ToolResultContent[]): string {
    const chunks: string[] = [];
    for (const part of content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        chunks.push(part.value);
      } else if (part instanceof vscode.LanguageModelDataPart) {
        if (
          part.mimeType === CustomDataPartMimeTypes.CacheControl ||
          part.mimeType === CustomDataPartMimeTypes.StatefulMarker ||
          part.mimeType === CustomDataPartMimeTypes.ThinkingData
        ) {
          continue;
        }
        if (
          part.mimeType.startsWith('text/') ||
          part.mimeType === 'application/json' ||
          part.mimeType.endsWith('+json')
        ) {
          chunks.push(Buffer.from(part.data).toString('utf-8'));
        } else {
          throw new Error(
            `Unsupported tool result data part mime type for OpenAI provider: ${part.mimeType}`,
          );
        }
      } else {
        throw new Error(
          'Unsupported tool result part type for OpenAI provider.',
        );
      }
    }
    return chunks.join('\n');
  }

  private convertMessages(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    emitReasoningContent: boolean,
    keepAllReasoningContent: boolean,
  ): ChatCompletionMessageParam[] {
    const result: ChatCompletionMessageParam[] = [];

    const isToolResultUserMessage = (
      msg: vscode.LanguageModelChatRequestMessage,
    ): boolean =>
      msg.role === vscode.LanguageModelChatMessageRole.User &&
      msg.content.some((p) => p instanceof vscode.LanguageModelToolResultPart);

    const lastRealUserIndex = (() => {
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (
          msg.role === vscode.LanguageModelChatMessageRole.User &&
          !isToolResultUserMessage(msg)
        ) {
          return i;
        }
      }
      return -1;
    })();

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === vscode.LanguageModelChatMessageRole.System) {
        const content = this.convertTextContentParts(msg.content);
        if (content.length > 0) {
          result.push({ role: 'system', content });
        }
      } else if (msg.role === vscode.LanguageModelChatMessageRole.User) {
        const { content, toolResults } = this.convertUserMessageParts(
          msg.content,
        );
        if (content.length > 0) {
          result.push({ role: 'user', content });
        }
        if (toolResults.length > 0) {
          result.push(...toolResults);
        }
      } else if (msg.role === vscode.LanguageModelChatMessageRole.Assistant) {
        const nextMessage = messages[i + 1];
        const shouldKeepReasoningContent =
          emitReasoningContent &&
          i > lastRealUserIndex &&
          !!nextMessage &&
          isToolResultUserMessage(nextMessage);
        const { content, toolCalls, reasoningContent } =
          this.convertAssistantParts(
            msg.content,
            shouldKeepReasoningContent || keepAllReasoningContent,
          );
        result.push({
          role: 'assistant',
          content: content.length > 0 ? content : null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
        });
      } else {
        throw new Error(
          `Unsupported chat message role for OpenAI provider: ${msg.role}`,
        );
      }
    }

    return result;
  }

  private convertTools(
    tools: readonly vscode.LanguageModelChatTool[] | undefined,
  ): ChatCompletionFunctionTool[] | undefined {
    if (!tools || tools.length === 0) {
      return undefined;
    }
    return tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: (() => {
          if (tool.inputSchema && typeof tool.inputSchema === 'object') {
            return tool.inputSchema as ChatCompletionFunctionTool['function']['parameters'];
          }
          return {
            type: 'object',
            properties: {},
            required: [],
          } as ChatCompletionFunctionTool['function']['parameters'];
        })(),
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

  private recordFirstToken(
    performanceTrace: PerformanceTrace,
    recorded: { value: boolean },
  ): void {
    if (!recorded.value) {
      recorded.value = true;
      performanceTrace.ttft =
        Date.now() - (performanceTrace.tts + performanceTrace.ttf);
    }
  }

  private parseAndEmitToolCalls(
    toolStates: Map<number, ToolCallState>,
    requestId: string,
    performanceTrace: PerformanceTrace,
    firstTokenRecorded: { value: boolean },
  ): vscode.LanguageModelResponsePart2[] {
    const results: vscode.LanguageModelResponsePart2[] = [];
    for (const [index, state] of toolStates.entries()) {
      if (!state.name) {
        continue;
      }
      try {
        const parsed = JSON.parse(state.args || '{}');
        const parsedObject =
          typeof parsed === 'object' && parsed !== null ? parsed : {};
        this.recordFirstToken(performanceTrace, firstTokenRecorded);
        results.push(
          new vscode.LanguageModelToolCallPart(
            state.id ?? `tool_call_${index}`,
            state.name,
            parsedObject,
          ),
        );
        toolStates.delete(index);
      } catch {
        continue;
      }
    }
    if (results.length > 0) {
      logResponseChunk(
        requestId,
        `Emitting ${results.length} tool call(s) from accumulated arguments`,
      );
    }
    return results;
  }

  private async *handleStream(
    stream: AsyncIterable<ChatCompletionChunk>,
    performanceTrace: PerformanceTrace,
    token: vscode.CancellationToken,
    requestId: string,
    usage: { value?: CompletionUsage },
    emitReasoningContent: boolean,
  ): AsyncGenerator<vscode.LanguageModelResponsePart2> {
    const toolStates = new Map<number, ToolCallState>();
    const firstTokenRecorded = { value: false };

    for await (const chunk of stream) {
      if (token.isCancellationRequested) {
        break;
      }

      logResponseChunk(requestId, JSON.stringify(chunk));
      if (chunk.usage) {
        usage.value = chunk.usage;
      }

      const choice = chunk.choices[0];
      if (!choice) {
        continue;
      }

      if (emitReasoningContent) {
        const reasoningDelta = (choice.delta as any).reasoning_content;
        if (typeof reasoningDelta === 'string' && reasoningDelta) {
          this.recordFirstToken(performanceTrace, firstTokenRecorded);
          yield new vscode.LanguageModelThinkingPart(reasoningDelta);
        }
      }

      const deltaContent = choice.delta.content;
      if (typeof deltaContent === 'string' && deltaContent) {
        this.recordFirstToken(performanceTrace, firstTokenRecorded);
        yield new vscode.LanguageModelTextPart(deltaContent);
      }

      if (choice.delta.tool_calls) {
        for (const call of choice.delta.tool_calls) {
          if (call.type && call.type !== 'function') {
            continue;
          }
          const existing = toolStates.get(call.index) ?? { args: '' };
          if (call.id) existing.id = call.id;
          if (call.function?.name) existing.name = call.function.name;
          if (call.function?.arguments) {
            existing.args += call.function.arguments;
          }
          toolStates.set(call.index, existing);
        }
      }

      if (choice.finish_reason) {
        if (toolStates.size > 0) {
          const emitted = this.parseAndEmitToolCalls(
            toolStates,
            requestId,
            performanceTrace,
            firstTokenRecorded,
          );
          for (const part of emitted) {
            yield part;
          }
        }
      }
    }
  }

  private async *handleNonStream(
    response: ChatCompletion,
    performanceTrace: PerformanceTrace,
    requestId: string,
    usage: { value?: CompletionUsage },
    emitReasoningContent: boolean,
  ): AsyncGenerator<vscode.LanguageModelResponsePart2> {
    logResponseChunk(requestId, JSON.stringify(response));

    if (response.usage) {
      usage.value = response.usage;
    }

    const choice = response.choices[0];
    if (!choice) {
      throw new Error('OpenAI response did not include any choices');
    }

    const firstTokenRecorded = { value: false };

    if (emitReasoningContent) {
      const reasoningContent = (choice.message as any).reasoning_content;
      if (typeof reasoningContent === 'string' && reasoningContent) {
        this.recordFirstToken(performanceTrace, firstTokenRecorded);
        yield new vscode.LanguageModelThinkingPart(reasoningContent);
      }
    }

    const messageContent = choice.message.content;
    if (typeof messageContent === 'string' && messageContent) {
      this.recordFirstToken(performanceTrace, firstTokenRecorded);
      yield new vscode.LanguageModelTextPart(messageContent);
    }

    if (choice.message.tool_calls) {
      for (const call of choice.message.tool_calls) {
        if (call.type !== 'function' || !call.function) {
          continue;
        }
        const args = call.function.arguments ?? '{}';
        let parsed: Record<string, unknown> = {};
        try {
          const value = JSON.parse(args);
          parsed = typeof value === 'object' && value !== null ? value : {};
        } catch {
          parsed = {};
        }
        this.recordFirstToken(performanceTrace, firstTokenRecorded);
        yield new vscode.LanguageModelToolCallPart(
          call.id,
          call.function.name,
          parsed,
        );
      }
    }
  }

  async *streamChat(
    model: ModelConfig,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    performanceTrace: PerformanceTrace,
    token: vscode.CancellationToken,
  ): AsyncGenerator<vscode.LanguageModelResponsePart2> {
    const abortController = new AbortController();
    const cancellationListener = token.onCancellationRequested(() => {
      abortController.abort();
    });

    const emitReasoningContent =
      isFeatureSupported(FeatureId.OpenAIReasoningContent, model) ||
      isFeatureSupported(FeatureId.OpenAIConciseReasoningContent, model);
    const keepAllReasoningContent = isFeatureSupported(
      FeatureId.OpenAIReasoningContent,
      model,
    );

    const convertedMessages = this.convertMessages(
      messages,
      emitReasoningContent,
      keepAllReasoningContent,
    );
    const tools = this.convertTools(options.tools);
    const toolChoice = this.convertToolChoice(options.toolMode, tools);
    const streamEnabled = model.stream ?? true;

    const baseBody: ChatCompletionCreateParamsBase = {
      model: model.id,
      messages: convertedMessages,
      ...(model.thinking?.effort !== undefined
        ? { reasoning_effort: model.thinking.effort as any }
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
    };

    const streamingPayload: ChatCompletionCreateParamsStreaming = {
      ...baseBody,
      stream: true,
      stream_options: { include_usage: true },
    };

    const nonStreamingPayload = { ...baseBody, stream: false as const };

    const requestPayload = streamEnabled
      ? streamingPayload
      : nonStreamingPayload;

    const requestId = startRequestLog({
      provider: this.config.name,
      modelId: model.id,
      endpoint: this.endpoint,
      headers: this.buildHeaders(),
      body: requestPayload,
    });

    const usage: { value?: CompletionUsage } = {};

    try {
      if (streamEnabled) {
        performanceTrace.ttf = Date.now() - performanceTrace.tts;
        const streamResponse = await this.client.chat.completions.create(
          streamingPayload,
          {
            signal: abortController.signal,
          },
        );
        yield* this.handleStream(
          streamResponse as AsyncIterable<ChatCompletionChunk>,
          performanceTrace,
          token,
          requestId,
          usage,
          emitReasoningContent,
        );
      } else {
        performanceTrace.ttf = Date.now() - performanceTrace.tts;
        const response = await this.client.chat.completions.create(
          nonStreamingPayload,
          { signal: abortController.signal },
        );
        yield* this.handleNonStream(
          response,
          performanceTrace,
          requestId,
          usage,
          emitReasoningContent,
        );
      }

      if (usage.value?.completion_tokens) {
        performanceTrace.tps =
          (usage.value.completion_tokens /
            (Date.now() - (performanceTrace.tts + performanceTrace.ttf))) *
          1000;
      } else {
        performanceTrace.tps = NaN;
      }

      if (usage.value) {
        logInfo(`[${requestId}] Usage: ${JSON.stringify(usage.value)}`);
      }

      logResponseComplete(requestId);
    } catch (error) {
      logResponseError(requestId, error);
      throw error;
    } finally {
      cancellationListener.dispose();
    }
  }

  estimateTokenCount(text: string): number {
    return Math.ceil(text.length / 4);
  }

  async getAvailableModels(): Promise<ModelConfig[]> {
    const result: ModelConfig[] = [];
    const page = await this.client.models.list();
    for await (const model of page) {
      const wellKnwonConfig = WELL_KNOWN_MODELS.find((v) => v.id === model.id);
      result.push(Object.assign(wellKnwonConfig ?? {}, { id: model.id }));
    }
    return result;
  }
}
