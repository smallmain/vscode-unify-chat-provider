import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaImageBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaRawMessageStreamEvent,
  BetaRedactedThinkingBlockParam,
  BetaTextBlockParam,
  BetaThinkingBlockParam,
  BetaToolChoice,
  BetaToolUnion,
  BetaUsage,
  MessageCreateParamsStreaming,
  BetaTool,
} from '@anthropic-ai/sdk/resources/beta/messages';
import { createSimpleHttpLogger } from '../../logger';
import type { ProviderHttpLogger, RequestLogger } from '../../logger';
import { ApiProvider } from '../interface';
import {
  DEFAULT_CHAT_TIMEOUT_CONFIG,
  DEFAULT_NORMAL_TIMEOUT_CONFIG,
  FetchMode,
  isCacheControlMarker,
  isImageMarker,
  isInternalMarker,
  encodeStatefulMarkerPart,
  decodeStatefulMarkerPart,
  normalizeImageMimeType,
  withIdleTimeout,
} from '../../utils';
import { getBaseModelId } from '../../model-id-utils';
import { DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_PROVIDER_TYPE } from '../../defaults';
import { ModelConfig, PerformanceTrace, ProviderConfig } from '../../types';
import { TracksToolInput } from '@anthropic-ai/sdk/lib/BetaMessageStream';
import { ThinkingBlockMetadata } from '../types';
import { FeatureId } from '../definitions';
import {
  buildBaseUrl,
  createCustomFetch,
  createFirstTokenRecorder,
  estimateTokenCount as sharedEstimateTokenCount,
  isFeatureSupported,
  mergeHeaders,
  parseToolArguments,
  processUsage as sharedProcessUsage,
  getToken,
  getUnifiedUserAgent,
  setUserAgentHeader,
} from '../utils';
import type { AuthTokenInfo } from '../../auth/types';

/**
 * Client for Anthropic-compatible APIs
 */
// TODO Citations support
// TODO Context editing support
export class AnthropicProvider implements ApiProvider {
  private readonly baseUrl: string;

  constructor(protected readonly config: ProviderConfig) {
    this.baseUrl = buildBaseUrl(config.baseUrl, { stripPattern: /\/v1$/i });
  }

  private get providerApiType(): string {
    const providerApiType = this.config.type;
    return providerApiType ?? DEFAULT_PROVIDER_TYPE;
  }

  protected toProviderToolName(name: string): string {
    return name;
  }

  protected fromProviderToolName(name: string): string {
    return name;
  }

  /**
   * Create an Anthropic client with custom fetch for retry support.
   * A new client is created per request to enable per-request logging.
   */
  private createClient(
    logger: ProviderHttpLogger | undefined,
    stream: boolean,
    credential?: AuthTokenInfo,
    abortSignal?: AbortSignal,
    mode: FetchMode = 'chat',
  ): Anthropic {
    const fallbackTimeout =
      mode === 'chat'
        ? DEFAULT_CHAT_TIMEOUT_CONFIG
        : DEFAULT_NORMAL_TIMEOUT_CONFIG;

    const requestTimeoutMs = stream
      ? (this.config.timeout?.connection ?? fallbackTimeout.connection)
      : (this.config.timeout?.response ?? fallbackTimeout.response);

    const token = getToken(credential);

    return new Anthropic({
      ...(!this.config.auth || token == null || token === ''
        ? {
            // Explicitly omit auth headers for providers that don't require authentication
            apiKey: '',
            defaultHeaders: {
              'X-Api-Key': null,
              Authorization: null,
            },
          }
        : this.config.auth.method === 'api-key'
          ? { apiKey: token }
          : { authToken: token }),
      baseURL: this.baseUrl,
      maxRetries: 0,
      fetch: createCustomFetch({
        connectionTimeoutMs: requestTimeoutMs,
        logger,
        type: mode,
        abortSignal,
      }),
    });
  }

  /**
   * Build request headers
   */
  protected buildHeaders(
    credential?: AuthTokenInfo,
    modelConfig?: ModelConfig,
    options?: { stream?: boolean },
  ): Record<string, string | null> {
    const token = getToken(credential);

    const headers: Record<string, string | null> = mergeHeaders(
      token,
      this.config.extraHeaders,
      modelConfig?.extraHeaders,
    );

    setUserAgentHeader(headers, getUnifiedUserAgent());

    if (options?.stream) {
      // Reserved for subclasses that want to key off streaming vs non-streaming requests.
    }

    return headers;
  }

  protected addAdditionalBetaFeatures(_options: {
    betaFeatures: Set<string>;
    model: ModelConfig;
    stream: boolean;
    hasMemoryTool: boolean;
    fineGrainedToolStreamingEnabled: boolean;
    anthropicInterleavedThinkingEnabled: boolean;
  }): void {}

  protected transformRequestBase(
    requestBase: Omit<MessageCreateParamsStreaming, 'stream'>,
    _options: {
      model: ModelConfig;
      stream: boolean;
      credential?: AuthTokenInfo;
      historyUserId?: string;
      requestState: { userId?: string };
    },
  ): Omit<MessageCreateParamsStreaming, 'stream'> {
    return requestBase;
  }

  /**
   * Convert VS Code messages to Anthropic format
   */
  private convertMessages(
    encodedModelId: string,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
  ): {
    system?: string | BetaTextBlockParam[];
    messages: BetaMessageParam[];
    historyUserId?: string;
  } {
    let system: BetaTextBlockParam[] = [];
    const outMessages: BetaMessageParam[] = [];
    const rawMap = new Map<BetaMessageParam, BetaMessage>();
    let firstHistoryUserId: string | undefined;

    for (const msg of messages) {
      switch (msg.role) {
        case vscode.LanguageModelChatMessageRole.System:
          for (const part of msg.content) {
            const blocks = this.convertPart(msg.role, part) as
              | BetaTextBlockParam[]
              | undefined;
            if (blocks) system.push(...blocks);
          }
          break;

        case vscode.LanguageModelChatMessageRole.User:
          for (const part of msg.content) {
            const blocks = this.convertPart(msg.role, part);
            if (blocks) outMessages.push({ role: 'user', content: blocks });
          }
          break;

        case vscode.LanguageModelChatMessageRole.Assistant:
          const rawPart = msg.content.find(
            (v) => v instanceof vscode.LanguageModelDataPart,
          ) as vscode.LanguageModelDataPart | undefined;
          if (rawPart) {
            try {
              const decoded = decodeStatefulMarkerPart<{
                raw: BetaMessage;
                userId?: string;
              }>(encodedModelId, rawPart);
              const raw = decoded.raw;
              if (firstHistoryUserId == null && decoded.userId) {
                firstHistoryUserId = decoded.userId;
              }
              if (raw) {
                const message: BetaMessageParam = {
                  role: 'assistant',
                  content: '',
                };
                rawMap.set(message, raw);
                outMessages.push(message);
              }
            } catch (error) {}
          } else {
            for (const part of msg.content) {
              const blocks = this.convertPart(msg.role, part);
              if (blocks)
                outMessages.push({ role: 'assistant', content: blocks });
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
      outMessages[index].content = raw.content;
    }

    // add a cache breakpoint at the end.
    this.applyCacheControl(system, outMessages);

    return {
      messages: this.ensureAlternatingRoles(outMessages),
      system: system.length > 0 ? system : undefined,
      historyUserId: firstHistoryUserId,
    };
  }

  private applyCacheControl(
    system: Anthropic.Beta.Messages.BetaTextBlockParam[],
    outMessages: Anthropic.Beta.Messages.BetaMessageParam[],
  ) {
    const lastSystem = system.at(-1);
    if (lastSystem) {
      lastSystem.cache_control = { type: 'ephemeral' };
    }
    const lastUser = outMessages.filter((m) => m.role === 'user').at(-1);
    if (lastUser) {
      const newContents =
        typeof lastUser.content === 'string'
          ? [
              {
                type: 'text',
                text: lastUser.content,
              } satisfies BetaTextBlockParam,
            ]
          : lastUser.content;
      const lastContent = newContents.at(-1);
      if (lastContent && this.isCacheControlApplicableBlock(lastContent)) {
        lastContent.cache_control = { type: 'ephemeral' };
      } else {
        newContents.push({
          type: 'text',
          // Anthropic does not accept empty string text blocks
          text: ' ',
          cache_control: { type: 'ephemeral' },
        } satisfies BetaTextBlockParam);
      }
    }
  }

  private isCacheControlApplicableBlock(
    block: BetaContentBlockParam,
  ): block is Exclude<
    BetaContentBlockParam,
    BetaThinkingBlockParam | BetaRedactedThinkingBlockParam
  > {
    return block.type !== 'thinking' && block.type !== 'redacted_thinking';
  }

  /**
   * Ensure messages alternate between user and assistant roles
   */
  private ensureAlternatingRoles(
    messages: BetaMessageParam[],
  ): BetaMessageParam[] {
    if (messages.length === 0) {
      return [];
    }

    const result: BetaMessageParam[] = [];

    for (const msg of messages) {
      const lastRole =
        result.length > 0 ? result[result.length - 1].role : null;

      if (lastRole === msg.role) {
        // Merge with previous message of same role
        const param = result[result.length - 1];
        const newContent = Array.isArray(param.content)
          ? param.content
          : [
              {
                type: 'text',
                text: param.content,
              } satisfies BetaTextBlockParam,
            ];
        newContent.push(
          ...(Array.isArray(msg.content)
            ? msg.content
            : [
                {
                  type: 'text',
                  text: msg.content,
                } satisfies BetaTextBlockParam,
              ]),
        );
        param.content = newContent;
      } else {
        result.push({
          ...msg,
          content: [
            ...(Array.isArray(msg.content)
              ? msg.content
              : [
                  {
                    type: 'text',
                    text: msg.content,
                  } satisfies BetaTextBlockParam,
                ]),
          ],
        });
      }
    }

    if (result.length > 0 && result[0].role !== 'user') {
      throw new Error(
        'The first message must be from the user role for Anthropic API',
      );
    }

    return result;
  }

  convertPart(
    role: vscode.LanguageModelChatMessageRole | 'tool_result',
    part: vscode.LanguageModelInputPart | unknown,
  ): BetaContentBlockParam[] | undefined {
    if (part == null) {
      return undefined;
    }

    if (part instanceof vscode.LanguageModelTextPart) {
      if (part.value.trim()) {
        return [{ type: 'text', text: part.value }];
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
        return [
          {
            type: 'redacted_thinking',
            data: metadata.redactedData,
          },
        ];
      } else if (metadata?._completeThinking) {
        // from VSCode.
        return [
          {
            type: 'thinking',
            thinking: metadata._completeThinking,
            signature: metadata.signature || '',
          },
        ];
      } else {
        const values =
          typeof part.value === 'string' ? [part.value] : part.value;
        return values.map((v) => ({
          type: 'thinking',
          thinking: v,
          signature: '',
        }));
      }
    } else if (part instanceof vscode.LanguageModelDataPart) {
      if (isCacheControlMarker(part)) {
        // ignore it, just use the officially recommended caching strategy.
        return undefined;
      } else if (isInternalMarker(part)) {
        return undefined;
      } else if (isImageMarker(part)) {
        if (role === vscode.LanguageModelChatMessageRole.System) {
          throw new Error('Image parts can not appear in system messages');
        }
        const mimeType = normalizeImageMimeType(part.mimeType);
        if (!mimeType) {
          throw new Error(
            `Unsupported image mime type for provider: ${part.mimeType}`,
          );
        }
        return [
          {
            type: 'image',
            source: {
              type: 'base64',
              data: Buffer.from(part.data).toString('base64'),
              media_type: mimeType,
            },
          },
        ];
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
      return [
        {
          type: 'tool_use',
          id: part.callId,
          name: this.toProviderToolName(part.name),
          input: part.input,
        },
      ];
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
            this.convertPart('tool_result', v) as
              | (BetaTextBlockParam | BetaImageBlockParam)[]
              | undefined,
        )
        .filter((v) => v !== undefined)
        .flat();
      return [
        {
          type: 'tool_result',
          tool_use_id: part.callId,
          content,
          is_error: part.isError,
        },
      ];
    } else {
      throw new Error(`Unsupported ${role} message part type encountered`);
    }
  }

  /**
   * Convert VS Code tools to Anthropic format.
   *
   * Handles special tools:
   * - Memory tool: Replaces local 'memory' tool with native Anthropic memory tool
   * - Web search: Appends native web search if enabled and no local 'web_search' tool exists
   *
   * @returns Object containing converted tools and flags for enabled native tools
   */
  private convertTools(
    tools: readonly vscode.LanguageModelChatTool[],
    model: ModelConfig,
  ): { tools: BetaToolUnion[]; hasMemoryTool: boolean } {
    const result: BetaToolUnion[] = [];
    let hasMemoryTool = false;
    let hasWebSearchTool = false;

    const memoryToolEnabled = model.memoryTool === true;
    const memoryToolSupported = isFeatureSupported(
      FeatureId.AnthropicMemoryTool,
      this.config,
      model,
    );
    const webSearchSupported = isFeatureSupported(
      FeatureId.AnthropicWebSearch,
      this.config,
      model,
    );

    for (const tool of tools) {
      // Handle native Anthropic memory tool - replaces local memory tool
      if (tool.name === 'memory' && memoryToolEnabled && memoryToolSupported) {
        hasMemoryTool = true;
        result.push({
          type: 'memory_20250818',
          name: 'memory',
        });
        continue;
      }

      if (tool.name === 'web_search') {
        hasWebSearchTool = true;
      }

      const inputSchema = normalizeInputSchema(tool.inputSchema);

      result.push({
        name: this.toProviderToolName(tool.name),
        description: tool.description,
        input_schema: inputSchema,
      });
    }

    // Add web search server tool if enabled, supported, and no local web_search tool exists
    // This is because there is no local web_search tool definition we can replace
    if (model.webSearch?.enabled && webSearchSupported && !hasWebSearchTool) {
      const webSearchTool: BetaToolUnion = {
        type: 'web_search_20250305',
        name: 'web_search',
      };

      if (model.webSearch.maxUses !== undefined) {
        webSearchTool.max_uses = model.webSearch.maxUses;
      }

      // Cannot use both allowed and blocked domains simultaneously
      if (
        model.webSearch.allowedDomains &&
        model.webSearch.allowedDomains.length > 0
      ) {
        webSearchTool.allowed_domains = model.webSearch.allowedDomains;
      } else if (
        model.webSearch.blockedDomains &&
        model.webSearch.blockedDomains.length > 0
      ) {
        webSearchTool.blocked_domains = model.webSearch.blockedDomains;
      }

      if (model.webSearch.userLocation) {
        webSearchTool.user_location = model.webSearch.userLocation;
      }

      result.push(webSearchTool);
    }

    // Add cache control to last tool to prevent reuse across requests
    if (result.length > 0) {
      result.at(-1)!.cache_control = { type: 'ephemeral' };
    }

    return { tools: result, hasMemoryTool };
  }

  private convertToolChoice(
    toolMode: vscode.LanguageModelChatToolMode,
    tools?: BetaToolUnion[],
    thinkingEnabled?: boolean,
  ): BetaToolChoice | undefined {
    // When thinking is enabled, Claude only supports 'auto' and 'none' modes.
    // Using 'any' or 'tool' with thinking enabled will cause an API error.
    if (thinkingEnabled) {
      return { type: 'auto' };
    }

    if (toolMode === vscode.LanguageModelChatToolMode.Required) {
      if (!tools || tools.length === 0) {
        throw new Error(
          'Tool mode is set to Required but no tools are provided',
        );
      }

      if (tools.length === 1) {
        const tool = tools[0];
        if (!('name' in tool)) {
          throw new Error('Selected tool does not have a name');
        }
        return { type: 'tool', name: tool.name };
      } else {
        return { type: 'any' };
      }
    } else {
      return { type: 'auto' };
    }
  }

  private applyParallelToolChoice(
    toolChoice: BetaToolChoice | undefined,
    parallelToolCalling?: boolean,
  ): BetaToolChoice | undefined {
    if (parallelToolCalling === undefined) {
      return toolChoice;
    }

    const base = toolChoice ?? { type: 'auto' as const };
    if (base.type === 'none') {
      return base;
    }
    return {
      ...base,
      disable_parallel_tool_use:
        parallelToolCalling === false ? true : undefined,
    };
  }

  /**
   * Calculate safe thinking budget based on Anthropic API constraints.
   *
   * Constraints:
   * - Minimum value: 1024 tokens
   * - Must be less than max_tokens - 1
   *
   * @param thinkingConfig The thinking configuration from model config
   * @param maxOutputTokens The max_tokens value for the request
   * @returns Safe budget value or undefined if thinking should be disabled
   */
  private normalizeThinkingBudget(
    configValue: number | undefined,
    maxOutputTokens: number,
    anthropicInterleavedThinkingEnabled: boolean,
  ): number {
    if (configValue === undefined) {
      configValue = 0;
    }

    // Normalize minimum value: must be at least 1024
    const normalizedBudget = configValue < 1024 ? 1024 : configValue;

    // Calculate safe value: min of (maxOutputTokens - 1, normalizedBudget)
    return anthropicInterleavedThinkingEnabled
      ? normalizedBudget
      : Math.min(maxOutputTokens - 1, normalizedBudget);
  }

  /**
   * Send a streaming chat request
   */
  async *streamChat(
    encodedModelId: string,
    model: ModelConfig,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    performanceTrace: PerformanceTrace,
    token: vscode.CancellationToken,
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

    const thinkingType = model.thinking?.type;
    const thinkingEnabled =
      thinkingType === 'enabled' || thinkingType === 'auto';
    const hasTools = (options.tools && options.tools.length > 0) ?? false;
    const stream = model.stream ?? true;

    const anthropicInterleavedThinkingEnabled =
      thinkingEnabled &&
      hasTools &&
      isFeatureSupported(
        FeatureId.AnthropicInterleavedThinking,
        this.config,
        model,
      );

    const {
      system,
      messages: anthropicMessages,
      historyUserId,
    } = this.convertMessages(encodedModelId, messages);

    // Convert tools with model config for web search and memory tool support
    // Also add tools if web search is enabled even without explicit tools
    const webSearchEnabled = model.webSearch?.enabled === true;
    const toolsResult =
      hasTools || webSearchEnabled
        ? this.convertTools(options.tools ?? [], model)
        : undefined;

    const tools = toolsResult?.tools;
    const hasMemoryTool = toolsResult?.hasMemoryTool ?? false;

    const fineGrainedToolStreamingEnabled =
      stream === true &&
      (tools?.length ?? 0) > 0 &&
      isFeatureSupported(
        FeatureId.AnthropicFineGrainedToolStreaming,
        this.config,
        model,
      );

    // Build betas array for beta API features
    const betaFeatures = new Set<string>();

    if (anthropicInterleavedThinkingEnabled) {
      betaFeatures.add('interleaved-thinking-2025-05-14');
    }

    // Add context management beta for memory tool
    if (hasMemoryTool) {
      betaFeatures.add('context-management-2025-06-27');
    }

    // Fine-grained tool streaming for Claude models when using tools with streaming.
    if (fineGrainedToolStreamingEnabled) {
      betaFeatures.add('fine-grained-tool-streaming-2025-05-14');
    }

    this.addAdditionalBetaFeatures({
      betaFeatures,
      model,
      stream,
      hasMemoryTool,
      fineGrainedToolStreamingEnabled,
      anthropicInterleavedThinkingEnabled,
    });

    const headers = this.buildHeaders(credential, model, { stream });

    // Pass thinkingEnabled to convertToolChoice to enforce tool_choice restrictions
    const toolChoice = this.applyParallelToolChoice(
      this.convertToolChoice(options.toolMode, tools, thinkingEnabled),
      model.parallelToolCalling,
    );

    try {
      let requestBase: Omit<MessageCreateParamsStreaming, 'stream'> = {
        model: getBaseModelId(model.id),
        messages: anthropicMessages,
        max_tokens: model.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      };

      Object.assign(requestBase, this.config.extraBody, model.extraBody);

      if (system) {
        requestBase.system = system;
      }

      if (tools) {
        requestBase.tools = tools;
      }

      if (toolChoice) {
        requestBase.tool_choice = toolChoice;
      }

      // Apply model configuration overrides
      if (model.temperature !== undefined) {
        // Note: When thinking is enabled, temperature modification is not supported
        // The API will reject non-default temperature values
        requestBase.temperature = model.temperature;
      }
      if (model.topK !== undefined) {
        // Note: When thinking is enabled, top_k modification is not supported
        requestBase.top_k = model.topK;
      }
      if (model.topP !== undefined) {
        // Note: When thinking is enabled, top_p must be between 0.95 and 1
        requestBase.top_p = model.topP;
      }
      if (model.thinking !== undefined) {
        const { type, budgetTokens } = model.thinking;
        if (type === 'enabled' || type === 'auto') {
          // With interleaved thinking, budget_tokens can exceed max_tokens
          // For regular thinking, it must be less than max_tokens
          requestBase.thinking = {
            type: 'enabled',
            budget_tokens: this.normalizeThinkingBudget(
              budgetTokens,
              requestBase.max_tokens,
              anthropicInterleavedThinkingEnabled,
            ),
          };
        }
      }

      if (betaFeatures.size > 0) {
        requestBase.betas = Array.from(betaFeatures);
      }

      const requestState: { userId?: string } = {};
      requestBase = this.transformRequestBase(requestBase, {
        model,
        stream,
        credential,
        historyUserId,
        requestState,
      });

      const client = this.createClient(
        logger,
        stream,
        credential,
        abortController.signal,
      );

      performanceTrace.ttf = Date.now() - performanceTrace.tts;

      if (stream) {
        const sdkStream = await client.beta.messages.create(
          {
            ...requestBase,
            stream: true,
          },
          {
            headers,
            signal: abortController.signal,
          },
        );

        // Wrap stream with idle timeout
        const responseTimeoutMs =
          this.config.timeout?.response ?? DEFAULT_CHAT_TIMEOUT_CONFIG.response;
        const timedStream = withIdleTimeout(
          sdkStream,
          responseTimeoutMs,
          abortController.signal,
        );

        yield* this.parseMessageStream(
          timedStream,
          token,
          logger,
          performanceTrace,
          fineGrainedToolStreamingEnabled,
          requestState,
        );
      } else {
        const result = await client.beta.messages.create(
          {
            ...requestBase,
            stream: false,
          },
          {
            headers,
            signal: abortController.signal,
          },
        );
        yield* this.parseMessage(
          result,
          performanceTrace,
          logger,
          requestState,
        );
      }
    } finally {
      cancellationListener.dispose();
    }
  }

  private async *parseMessage(
    message: Anthropic.Beta.Messages.BetaMessage,
    performanceTrace: PerformanceTrace,
    logger: RequestLogger,
    state: { userId?: string },
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
    const raw: BetaMessage = message;

    logger.providerResponseChunk(JSON.stringify(message));

    performanceTrace.ttft =
      Date.now() - (performanceTrace.tts + performanceTrace.ttf);

    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          yield new vscode.LanguageModelTextPart(block.text);
          break;

        case 'thinking':
          yield new vscode.LanguageModelThinkingPart(
            block.thinking,
            undefined,
            {
              signature: block.signature,
              _completeThinking: block.thinking,
            } satisfies ThinkingBlockMetadata,
          );
          break;

        case 'redacted_thinking':
          yield new vscode.LanguageModelThinkingPart(
            'Encrypted thinking...',
            undefined,
            {
              redactedData: block.data,
            } satisfies ThinkingBlockMetadata,
          );
          break;

        case 'tool_use':
          const input = block.input ?? {};
          yield new vscode.LanguageModelToolCallPart(
            block.id,
            this.fromProviderToolName(block.name),
            input,
          );
          break;

        default:
          throw new Error(`Unsupported message block type: ${block.type}`);
      }
    }
    yield encodeStatefulMarkerPart<{ raw: BetaMessage; userId?: string }>({
      raw,
      userId: state.userId,
    });

    if (message.usage) {
      this.processUsage(message.usage, performanceTrace, logger);
    }
  }

  private async *parseMessageStream(
    stream: AsyncIterable<BetaRawMessageStreamEvent>,
    token: vscode.CancellationToken,
    logger: RequestLogger,
    performanceTrace: PerformanceTrace,
    fineGrainedToolStreamingEnabled: boolean,
    state: { userId?: string },
  ): AsyncGenerator<vscode.LanguageModelResponsePart2> {
    let raw: BetaMessage | undefined;

    const recordFirstToken = createFirstTokenRecorder(performanceTrace);

    for await (const event of stream) {
      if (token.isCancellationRequested) {
        break;
      }

      logger.providerResponseChunk(JSON.stringify(event));

      raw = this.accumulateMessage(raw, event, fineGrainedToolStreamingEnabled);

      switch (event.type) {
        case 'message_start': {
          // do nothing.
          break;
        }

        case 'content_block_start': {
          const block = event.content_block;
          switch (block.type) {
            case 'text':
              yield new vscode.LanguageModelTextPart(block.text);
              break;

            case 'thinking':
              yield new vscode.LanguageModelThinkingPart(block.thinking);
              break;

            case 'redacted_thinking':
              yield new vscode.LanguageModelThinkingPart(
                'Encrypted thinking...',
              );
              break;

            default:
              break;
          }
          break;
        }

        case 'content_block_delta': {
          recordFirstToken();
          const block = event.delta;
          switch (block.type) {
            case 'text_delta':
              yield new vscode.LanguageModelTextPart(block.text);
              break;

            case 'thinking_delta':
              yield new vscode.LanguageModelThinkingPart(block.thinking);
              break;

            default:
              break;
          }
          break;
        }

        case 'content_block_stop': {
          const block = raw.content.at(event.index)!;
          switch (block.type) {
            case 'tool_use':
              yield new vscode.LanguageModelToolCallPart(
                block.id,
                this.fromProviderToolName(block.name),
                block.input as object,
              );
              break;

            case 'thinking':
              yield new vscode.LanguageModelThinkingPart('', undefined, {
                signature: block.signature,
                _completeThinking: block.thinking,
              } satisfies ThinkingBlockMetadata);
              break;

            case 'redacted_thinking':
              yield new vscode.LanguageModelThinkingPart('', undefined, {
                redactedData: block.data,
              } satisfies ThinkingBlockMetadata);
              break;

            default:
              break;
          }

          break;
        }

        case 'message_delta': {
          break;
        }

        case 'message_stop': {
          yield encodeStatefulMarkerPart<{ raw: BetaMessage; userId?: string }>(
            {
              raw,
              userId: state.userId,
            },
          );

          if (raw.usage) {
            this.processUsage(raw.usage, performanceTrace, logger);
          }
          break;
        }

        default: {
          // NOTE: https://platform.claude.com/docs/en/build-with-claude/streaming
          // Event streams may also include any number of ping events.
          // We may occasionally send errors in the event stream.
          if ((event as { type: string }).type === 'error') {
            const error = (
              event as { error?: { type: string; message: string } }
            ).error;
            throw new Error(
              error
                ? `${error.type}: ${error.message}`
                : `Unknown error from stream`,
            );
          }
        }
      }
    }

    // Check cancellation before post-loop processing
    if (token.isCancellationRequested) {
      return;
    }
  }

  private accumulateMessage(
    raw: BetaMessage | undefined,
    event: BetaRawMessageStreamEvent,
    fineGrainedToolStreamingEnabled: boolean,
  ): BetaMessage {
    if (!raw && event.type !== 'message_start') {
      throw new Error(
        `Unexpected event order, got ${event.type} before "message_start"`,
      );
    }

    const snapshot = raw!;

    const JSON_BUF_PROPERTY = '__json_buf';

    type ToolInputJsonBuffer = {
      __json_buf?: string;
    };

    function tracksToolInput(
      content: BetaContentBlock,
    ): content is TracksToolInput {
      return (
        content.type === 'tool_use' ||
        content.type === 'server_tool_use' ||
        content.type === 'mcp_tool_use'
      );
    }

    switch (event.type) {
      case 'message_start':
        return event.message;

      case 'content_block_start':
        snapshot.content[event.index] = event.content_block;
        return snapshot;

      case 'content_block_delta': {
        const snapshotContent = snapshot.content.at(event.index);

        switch (event.delta.type) {
          case 'text_delta': {
            if (snapshotContent?.type === 'text') {
              snapshot.content[event.index] = {
                ...snapshotContent,
                text: (snapshotContent.text || '') + event.delta.text,
              };
            }
            break;
          }

          case 'citations_delta': {
            if (snapshotContent?.type === 'text') {
              snapshot.content[event.index] = {
                ...snapshotContent,
                citations: [
                  ...(snapshotContent.citations ?? []),
                  event.delta.citation,
                ],
              };
            }
            break;
          }

          case 'input_json_delta': {
            if (snapshotContent && tracksToolInput(snapshotContent)) {
              const toolContent = snapshotContent as TracksToolInput &
                ToolInputJsonBuffer;

              // Keep track of the raw JSON string.
              let jsonBuf = toolContent.__json_buf ?? '';
              jsonBuf += event.delta.partial_json;

              const newContent: TracksToolInput & ToolInputJsonBuffer = {
                ...snapshotContent,
              };

              Object.defineProperty(newContent, JSON_BUF_PROPERTY, {
                value: jsonBuf,
                enumerable: false,
                writable: true,
              });

              snapshot.content[event.index] = newContent;
            }
            break;
          }

          case 'thinking_delta': {
            if (snapshotContent?.type === 'thinking') {
              snapshot.content[event.index] = {
                ...snapshotContent,
                thinking: snapshotContent.thinking + event.delta.thinking,
              };
            }
            break;
          }

          case 'signature_delta': {
            if (snapshotContent?.type === 'thinking') {
              snapshot.content[event.index] = {
                ...snapshotContent,
                signature: event.delta.signature,
              };
            }
            break;
          }

          default:
            throw new Error(
              `Unsupported content block delta type: ${event.delta}`,
            );
        }
        return snapshot;
      }

      case 'content_block_stop':
        const snapshotContent = snapshot.content.at(event.index);

        if (snapshotContent && tracksToolInput(snapshotContent)) {
          const toolContent = snapshotContent as TracksToolInput &
            ToolInputJsonBuffer;
          const jsonBuf = toolContent.__json_buf ?? '';
          snapshotContent.input = parseToolArguments(
            jsonBuf,
            fineGrainedToolStreamingEnabled ? 'feedback' : undefined,
          );
        }
        return snapshot;

      case 'message_delta':
        snapshot.container = event.delta.container;
        snapshot.stop_reason = event.delta.stop_reason;
        snapshot.stop_sequence = event.delta.stop_sequence;
        snapshot.usage.output_tokens = event.usage.output_tokens;
        snapshot.context_management = event.context_management;

        if (event.usage.input_tokens != null) {
          snapshot.usage.input_tokens = event.usage.input_tokens;
        }

        if (event.usage.cache_creation_input_tokens != null) {
          snapshot.usage.cache_creation_input_tokens =
            event.usage.cache_creation_input_tokens;
        }

        if (event.usage.cache_read_input_tokens != null) {
          snapshot.usage.cache_read_input_tokens =
            event.usage.cache_read_input_tokens;
        }

        if (event.usage.server_tool_use != null) {
          snapshot.usage.server_tool_use = event.usage.server_tool_use;
        }
        return snapshot;

      case 'message_stop':
        return snapshot;
    }
  }

  private processUsage(
    usage: BetaUsage,
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

  /**
   * Get available models from the Anthropic API
   * Uses the ListModels endpoint with pagination support
   */
  async getAvailableModels(credential: AuthTokenInfo): Promise<ModelConfig[]> {
    const logger = createSimpleHttpLogger({
      purpose: 'Get Available Models',
      providerName: this.config.name,
      actualApiType: this.providerApiType,
    });
    const allModels: ModelConfig[] = [];
    let afterId: string | undefined;

    try {
      const client = this.createClient(
        logger,
        false,
        credential,
        undefined,
        'normal',
      );

      do {
        const page = await client.models.list(
          { after_id: afterId },
          { headers: this.buildHeaders(credential) },
        );

        for (const model of page.data) {
          allModels.push({
            id: model.id,
            name: model.display_name,
          });
        }

        afterId = page.has_more && page.last_id ? page.last_id : undefined;
      } while (afterId);
      return allModels;
    } catch (error) {
      logger.error(error);
      // Re-throw with more context
      if (error instanceof Error) {
        throw new Error(`Failed to get available models: ${error.message}`);
      }
      throw error;
    }
  }
}

function normalizeInputSchema(
  schema: object | undefined,
): BetaTool.InputSchema {
  if (!schema) {
    return {
      type: 'object',
      properties: {},
      required: [],
    };
  }
  return {
    type: 'object',
    properties:
      (schema as { properties?: Record<string, unknown> }).properties ?? {},
    required: (schema as { required?: string[] }).required ?? [],
    $schema: (schema as { $schema?: unknown }).$schema,
  };
}
