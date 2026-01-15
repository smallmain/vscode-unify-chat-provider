import * as vscode from 'vscode';
import {
  ContentUnion,
  FunctionCallingConfigMode,
  GoogleGenAI,
  ThinkingLevel,
  type Content,
  type FunctionCallingConfig,
  type FunctionDeclaration,
  type GenerateContentConfig,
  type GenerateContentResponse,
  type HttpOptions,
  type Part,
  type Tool,
} from '@google/genai';
import { createSimpleHttpLogger } from '../../logger';
import type { RequestLogger } from '../../logger';
import { ApiProvider } from '../interface';
import { ModelConfig, PerformanceTrace, ProviderConfig } from '../../types';
import type { AuthTokenInfo } from '../../auth/types';
import { withGoogleFetchLogger } from './fetch-logger';
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
import { ThinkingBlockMetadata } from '../types';
import {
  createFirstTokenRecorder,
  estimateTokenCount as sharedEstimateTokenCount,
  getToken,
  mergeHeaders,
  processUsage as sharedProcessUsage,
  isFeatureSupported,
} from '../utils';
import { randomUUID } from 'node:crypto';
import { FeatureId } from '../definitions';

const TOOL_CALL_ID_PREFIX = 'google-tool:';

export class GoogleAIStudioProvider implements ApiProvider {
  protected readonly baseUrl: string;
  protected readonly apiVersion: string;

  constructor(protected readonly config: ProviderConfig) {
    const normalized = new URL(this.config.baseUrl);
    normalized.search = '';
    normalized.hash = '';
    normalized.pathname = normalized.pathname.replace(/\/+$/, '');

    const match = normalized.pathname.match(/\/(v\d+(?:beta)?)$/i);
    this.apiVersion = match?.[1] ?? 'v1beta';
    if (match) {
      normalized.pathname = normalized.pathname.replace(
        new RegExp(`${match[0]}$`),
        '',
      );
    }
    this.baseUrl = normalized.toString().replace(/\/+$/, '');
  }

  protected buildHeaders(
    credential?: AuthTokenInfo,
    modelConfig?: ModelConfig,
  ): Record<string, string> {
    const credentialValue = getToken(credential);

    return mergeHeaders(
      credentialValue,
      this.config.extraHeaders,
      modelConfig?.extraHeaders,
    );
  }

  protected buildExtraBody(modelConfig?: ModelConfig): Record<string, unknown> {
    return {
      ...(this.config.extraBody ?? {}),
      ...(modelConfig?.extraBody ?? {}),
    };
  }

  protected createClient(
    modelConfig: ModelConfig | undefined,
    streamEnabled: boolean,
    credential?: AuthTokenInfo,
  ): GoogleGenAI {
    const requestTimeoutMs = streamEnabled
      ? this.config.timeout?.connection ?? DEFAULT_TIMEOUT_CONFIG.connection
      : this.config.timeout?.response ?? DEFAULT_TIMEOUT_CONFIG.response;

    const credentialValue = getToken(credential);

    const httpOptions: HttpOptions = {
      baseUrl: this.baseUrl,
      headers: this.buildHeaders(credential, modelConfig),
      timeout: requestTimeoutMs,
      extraBody: this.buildExtraBody(modelConfig),
    };

    return new GoogleGenAI({
      apiKey: credentialValue,
      apiVersion: this.apiVersion,
      httpOptions,
    });
  }

  private convertTools(
    tools: readonly vscode.LanguageModelChatTool[] | undefined,
  ): Tool[] | undefined {
    if (!tools || tools.length === 0) {
      return undefined;
    }

    const declarations: FunctionDeclaration[] = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parametersJsonSchema: tool.inputSchema ?? {
        type: 'object',
        properties: {},
        required: [],
      },
    }));

    return [{ functionDeclarations: declarations }];
  }

  private buildFunctionCallingConfig(
    mode: vscode.LanguageModelChatToolMode,
    tools: Tool[] | undefined,
  ): FunctionCallingConfig | undefined {
    if (!tools || tools.length === 0) {
      return undefined;
    }

    if (mode !== vscode.LanguageModelChatToolMode.Required) {
      return undefined;
    }

    const allowedFunctionNames = tools
      .flatMap((tool) => tool.functionDeclarations ?? [])
      .map((decl) => decl.name)
      .filter(
        (name): name is string => typeof name === 'string' && name !== '',
      );

    return {
      mode: FunctionCallingConfigMode.ANY,
      ...(allowedFunctionNames.length > 0
        ? { allowedFunctionNames }
        : undefined),
    };
  }

  private buildThinkingConfig(
    model: ModelConfig,
    useThinkingLevel: boolean,
  ): NonNullable<GenerateContentConfig> | undefined {
    const thinking = model.thinking;
    if (!thinking) {
      return undefined;
    }

    if (thinking.type === 'disabled' || thinking.effort === 'none') {
      return {
        thinkingConfig: useThinkingLevel
          ? {
              includeThoughts: false,
              thinkingLevel: ThinkingLevel.MINIMAL,
            }
          : {
              includeThoughts: false,
              thinkingBudget: 0,
            },
      };
    }

    const out: NonNullable<GenerateContentConfig['thinkingConfig']> = {
      includeThoughts: true,
    };

    if (thinking.effort) {
      out.thinkingLevel = this.mapThinkingEffortToLevel(thinking.effort);
    } else {
      // use Default level
    }

    if (thinking.budgetTokens !== undefined) {
      out.thinkingBudget = thinking.budgetTokens;
    } else {
      out.thinkingBudget = -1;
    }

    if (useThinkingLevel) {
      delete out.thinkingBudget;
    } else {
      delete out.thinkingLevel;
    }

    return { thinkingConfig: out };
  }

  private mapThinkingEffortToLevel(
    effort: NonNullable<NonNullable<ModelConfig['thinking']>['effort']>,
  ): ThinkingLevel {
    switch (effort) {
      case 'minimal':
        return ThinkingLevel.MINIMAL;
      case 'low':
        return ThinkingLevel.LOW;
      case 'medium':
        return ThinkingLevel.MEDIUM;
      case 'high':
      case 'xhigh':
        return ThinkingLevel.HIGH;
      case 'none':
        return ThinkingLevel.THINKING_LEVEL_UNSPECIFIED;
    }
  }

  private convertMessages(
    encodedModelId: string,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
  ): { systemInstruction?: ContentUnion; contents: Content[] } {
    const systemParts: Part[] = [];
    let contents: Content[] = [];

    for (const msg of messages) {
      switch (msg.role) {
        case vscode.LanguageModelChatMessageRole.System: {
          for (const part of msg.content) {
            const converted = this.convertPart(msg.role, part);
            if (converted) {
              systemParts.push(converted);
            }
          }
          break;
        }

        case vscode.LanguageModelChatMessageRole.User: {
          const userParts: Part[] = [];
          for (const part of msg.content) {
            const converted = this.convertPart(msg.role, part);
            if (converted) {
              userParts.push(converted);
            }
          }
          if (userParts.length > 0) {
            contents.push({ role: 'user', parts: userParts });
          }
          break;
        }

        case vscode.LanguageModelChatMessageRole.Assistant: {
          const rawPart = msg.content.find(
            (v) => v instanceof vscode.LanguageModelDataPart,
          ) as vscode.LanguageModelDataPart | undefined;
          if (rawPart) {
            try {
              const raw = decodeStatefulMarkerPart<Content[]>(
                encodedModelId,
                rawPart,
              );
              for (const content of raw) {
                contents.push(content);
              }
              break;
            } catch {}
          }

          const modelParts: Part[] = [];
          for (const part of msg.content) {
            const converted = this.convertPart(msg.role, part);
            if (converted) {
              modelParts.push(converted);
            }
          }
          if (modelParts.length > 0) {
            contents.push({ role: 'model', parts: modelParts });
          }
          break;
        }

        default:
          throw new Error(`Unsupported message role for provider: ${msg.role}`);
      }
    }

    const systemInstruction =
      systemParts.length > 0
        ? systemParts.length > 1
          ? systemParts
          : systemParts[0]
        : undefined;

    // from gemini sdk
    contents = this.extractCuratedHistory(contents.slice(0, -1)).concat(
      contents.at(-1)!,
    );

    this.reorderFunctionResponses(contents);
    this.normalizeFunctionResponseIds(contents);

    return {
      systemInstruction,
      contents,
    };
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

  /**
   * Reorder functionResponse parts within user contents based on indices in their call IDs.
   * This ensures tool results are sent in the same order as the original tool calls.
   */
  private reorderFunctionResponses(contents: Content[]): void {
    for (const content of contents) {
      if (content.role !== 'user' || !content.parts) continue;

      const functionResponseParts: Array<{
        part: Part;
        position: number;
        index: number | undefined;
      }> = [];
      const otherParts: Part[] = [];

      for (const [position, part] of content.parts.entries()) {
        if (part.functionResponse?.id) {
          const parsed = this.parseToolCallId(part.functionResponse.id);
          functionResponseParts.push({
            part,
            position,
            index: parsed?.index,
          });
        } else {
          otherParts.push(part);
        }
      }

      if (functionResponseParts.length < 2) continue;

      const indices = functionResponseParts
        .map((d) => d.index)
        .filter((v): v is number => v !== undefined);

      if (indices.length >= 2 && new Set(indices).size === indices.length) {
        functionResponseParts.sort((a, b) => {
          const aIndex = a.index ?? Number.POSITIVE_INFINITY;
          const bIndex = b.index ?? Number.POSITIVE_INFINITY;
          if (aIndex !== bIndex) return aIndex - bIndex;
          return a.position - b.position;
        });
      }

      // Rebuild parts with reordered function responses at the end
      content.parts = [
        ...otherParts,
        ...functionResponseParts.map((d) => d.part),
      ];
    }
  }

  /**
   * Normalize functionResponse IDs from our generated call IDs back to tool names
   * for compatibility with the API (which may expect simple IDs or none at all).
   */
  private normalizeFunctionResponseIds(contents: Content[]): void {
    for (const content of contents) {
      if (!content.parts) continue;

      for (const part of content.parts) {
        if (part.functionResponse?.id) {
          const parsed = this.parseToolCallId(part.functionResponse.id);
          if (parsed) {
            // Clear the generated ID - let API use its own ID matching
            // The name field is already set correctly
            part.functionResponse.id = undefined;
          }
        }
      }
    }
  }

  private isValidContent(content: Content): boolean {
    if (content.parts === undefined || content.parts.length === 0) {
      return false;
    }
    for (const part of content.parts) {
      if (part === undefined || Object.keys(part).length === 0) {
        return false;
      }
    }
    return true;
  }

  /**
   * Extracts the curated (valid) history from a comprehensive history.
   *
   * @remarks
   * The model may sometimes generate invalid or empty contents(e.g., due to safty
   * filters or recitation). Extracting valid turns from the history
   * ensures that subsequent requests could be accpeted by the model.
   */
  private extractCuratedHistory(comprehensiveHistory: Content[]): Content[] {
    if (
      comprehensiveHistory === undefined ||
      comprehensiveHistory.length === 0
    ) {
      return [];
    }
    const curatedHistory: Content[] = [];
    const length = comprehensiveHistory.length;
    let i = 0;
    while (i < length) {
      if (comprehensiveHistory[i].role === 'user') {
        curatedHistory.push(comprehensiveHistory[i]);
        i++;
      } else {
        const modelOutput: Content[] = [];
        let isValid = true;
        while (i < length && comprehensiveHistory[i].role === 'model') {
          modelOutput.push(comprehensiveHistory[i]);
          if (isValid && !this.isValidContent(comprehensiveHistory[i])) {
            isValid = false;
          }
          i++;
        }
        if (isValid) {
          curatedHistory.push(...modelOutput);
        } else {
          // Remove the last user input when model content is invalid.
          curatedHistory.pop();
        }
      }
    }
    return curatedHistory;
  }

  private convertPart(
    role: vscode.LanguageModelChatMessageRole | 'from_tool_result',
    part: vscode.LanguageModelInputPart | unknown,
  ): Part | undefined {
    if (part == null) {
      return undefined;
    }

    if (part instanceof vscode.LanguageModelTextPart) {
      return part.value.trim() ? { text: part.value } : undefined;
    } else if (part instanceof vscode.LanguageModelThinkingPart) {
      if (role !== vscode.LanguageModelChatMessageRole.Assistant) {
        throw new Error('Thinking parts can only appear in assistant messages');
      }

      const metadata = part.metadata as ThinkingBlockMetadata | undefined;
      const signature =
        typeof metadata?.signature === 'string' && metadata.signature !== ''
          ? metadata.signature
          : undefined;

      if (signature) {
        return {
          thought: true,
          text:
            typeof part.value === 'string' ? part.value : part.value.join(''),
          thoughtSignature: signature,
        };
      }

      const thinkingText =
        typeof metadata?._completeThinking === 'string' &&
        metadata._completeThinking.trim()
          ? metadata._completeThinking
          : typeof part.value === 'string'
          ? part.value
          : part.value.join('');

      return thinkingText.trim()
        ? { text: thinkingText, thought: true }
        : undefined;
    } else if (part instanceof vscode.LanguageModelDataPart) {
      if (isCacheControlMarker(part) || isInternalMarker(part)) {
        return undefined;
      }

      if (isImageMarker(part)) {
        if (role !== vscode.LanguageModelChatMessageRole.User) {
          throw new Error(
            'Image parts can only appear in user messages for this provider',
          );
        }
        const mimeType = normalizeImageMimeType(part.mimeType);
        if (!mimeType) {
          throw new Error(`Unsupported image mime type: ${part.mimeType}`);
        }
        return {
          inlineData: {
            mimeType,
            data: Buffer.from(part.data).toString('base64'),
          },
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
        functionCall: {
          id: part.callId,
          name: part.name,
          args: part.input as Record<string, unknown>,
        },
      };
    } else if (
      part instanceof vscode.LanguageModelToolResultPart ||
      part instanceof vscode.LanguageModelToolResultPart2
    ) {
      if (role !== vscode.LanguageModelChatMessageRole.User) {
        throw new Error('Tool result parts can only appear in user messages');
      }

      const parsed = this.parseToolCallId(part.callId);
      if (!parsed) {
        throw new Error(
          `Invalid tool callId '${part.callId}'. Expected format: ${TOOL_CALL_ID_PREFIX}name:index:uuid`,
        );
      }
      const name = parsed.name;

      let content: Part[] | string = part.content
        .map((v) => this.convertPart('from_tool_result', v))
        .filter((v) => v !== undefined)
        .flat();

      if (content.length === 1) {
        const value = content.at(0)!;
        if (Object.keys(value).length === 1 && 'text' in value) {
          content = value.text ?? '';
        }
      }

      // handle Multimodal tool result
      if (typeof content !== 'string') {
        const output: { content: Part[]; images: { $ref: string }[] } = {
          content: [],
          images: [],
        };
        const parts: Part[] = [];

        for (const [i, c] of content.entries()) {
          if (c.inlineData) {
            c.inlineData.displayName = `image_${i + 1}`;
            output.images.push({ $ref: c.inlineData.displayName });
            parts.push(c);
          } else {
            output.content.push(c);
          }
        }

        if (output.images.length > 0) {
          return {
            functionResponse: {
              id: part.callId,
              name,
              response: { output },
              parts,
            },
          };
        }
      }

      return {
        functionResponse: {
          id: part.callId,
          name,
          response: part.isError ? { error: content } : { output: content },
        },
      };
    } else {
      throw new Error(`Unsupported ${role} message part type encountered`);
    }
  }

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

    const useThinkingLevel = isFeatureSupported(
      FeatureId.GeminiUseThinkingLevel,
      this.config,
      model,
    );

    const { systemInstruction, contents } = this.convertMessages(
      encodedModelId,
      messages,
    );
    const tools = this.convertTools(options.tools);
    const functionCallingConfig = this.buildFunctionCallingConfig(
      options.toolMode,
      tools,
    );
    const streamEnabled = model.stream ?? true;

    const generateConfig: GenerateContentConfig = {
      abortSignal: abortController.signal,
      httpOptions: {
        headers: this.buildHeaders(credential, model),
        extraBody: this.buildExtraBody(model),
      },
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(model.temperature !== undefined
        ? { temperature: model.temperature }
        : {}),
      ...(model.topP !== undefined ? { topP: model.topP } : {}),
      ...(model.topK !== undefined ? { topK: model.topK } : {}),
      ...(model.maxOutputTokens !== undefined
        ? { maxOutputTokens: model.maxOutputTokens }
        : {}),
      ...(model.presencePenalty !== undefined
        ? { presencePenalty: model.presencePenalty }
        : {}),
      ...(model.frequencyPenalty !== undefined
        ? { frequencyPenalty: model.frequencyPenalty }
        : {}),
      ...(tools ? { tools } : {}),
      ...(functionCallingConfig
        ? { toolConfig: { functionCallingConfig } }
        : {}),
      ...{ ...this.buildThinkingConfig(model, useThinkingLevel) },
    };

    const client = this.createClient(model, streamEnabled, credential);

    performanceTrace.ttf = Date.now() - performanceTrace.tts;

    try {
      if (streamEnabled) {
        const responseTimeoutMs =
          this.config.timeout?.response ?? DEFAULT_TIMEOUT_CONFIG.response;

        const stream = await withGoogleFetchLogger(logger, async () => {
          return client.models.generateContentStream({
            model: getBaseModelId(model.id),
            contents,
            config: generateConfig,
          });
        });

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
        const data = await withGoogleFetchLogger(logger, async () => {
          return client.models.generateContent({
            model: getBaseModelId(model.id),
            contents,
            config: generateConfig,
          });
        });
        yield* this.parseMessage(data, performanceTrace, logger);
      }
    } finally {
      cancellationListener.dispose();
    }
  }

  private async *parseMessage(
    message: GenerateContentResponse,
    performanceTrace: PerformanceTrace,
    logger: RequestLogger,
  ): AsyncGenerator<vscode.LanguageModelResponsePart2> {
    logger.providerResponseChunk(JSON.stringify(message));

    performanceTrace.ttft =
      Date.now() - (performanceTrace.tts + performanceTrace.ttf);

    const candidate = message.candidates?.[0];
    const content = candidate?.content;

    const parts = content?.parts ?? [];

    const metadata: ThinkingBlockMetadata = {};
    const stateParts: Part[] = [];
    let toolCallIndex = 0;

    for (const part of parts) {
      if (part.text) {
        if (part.thought) {
          const text = part.text;
          if (text) {
            metadata._completeThinking =
              (metadata._completeThinking ?? '') + text;
            yield new vscode.LanguageModelThinkingPart(text);
          }
          stateParts.push(part);
        } else {
          yield new vscode.LanguageModelTextPart(part.text);
          stateParts.push(part);
        }
      } else if (part.functionCall) {
        const name = part.functionCall.name!;
        const args = part.functionCall.args ?? {};
        const callId = this.generateToolCallId(name, toolCallIndex++);
        yield new vscode.LanguageModelToolCallPart(callId, name, args);
        // Preserve original API response in state parts
        stateParts.push(part);
      } else {
        stateParts.push(part);
      }
    }

    if (Object.keys(metadata).length > 0) {
      yield new vscode.LanguageModelThinkingPart('', undefined, metadata);
    }

    yield encodeStatefulMarkerPart<Content[]>(content ? [content] : []);

    if (message.usageMetadata) {
      this.processUsage(message.usageMetadata, performanceTrace, logger);
    }
  }

  private async *parseMessageStream(
    stream: AsyncIterable<GenerateContentResponse>,
    token: vscode.CancellationToken,
    logger: RequestLogger,
    performanceTrace: PerformanceTrace,
  ): AsyncGenerator<vscode.LanguageModelResponsePart2> {
    const recordFirstToken = createFirstTokenRecorder(performanceTrace);

    let _completeThinking = '';
    // NOTE: does not process the signature
    // because according to Gemini's official statement,
    // it is impossible to correctly process the signature.
    let lastUsage: GenerateContentResponse['usageMetadata'] | undefined;
    let toolCallIndex = 0;

    const outputContents: Content[] = [];

    for await (const chunk of stream) {
      if (token.isCancellationRequested) {
        break;
      }

      logger.providerResponseChunk(JSON.stringify(chunk));

      recordFirstToken();

      lastUsage = chunk.usageMetadata ?? lastUsage;

      const content = chunk.candidates?.[0]?.content;

      if (content && this.isValidContent(content)) {
        outputContents.push(content);

        const parts = content.parts!;
        for (const part of parts) {
          if (part.text) {
            if (part.thought) {
              _completeThinking += part.text;
              yield new vscode.LanguageModelThinkingPart(part.text);
            } else {
              yield new vscode.LanguageModelTextPart(part.text);
            }
          }

          if (part.functionCall) {
            const name = part.functionCall.name!;
            const args = part.functionCall.args ?? {};
            const callId = this.generateToolCallId(name, toolCallIndex++);
            yield new vscode.LanguageModelToolCallPart(callId, name, args);
          }
        }
      }
    }

    if (_completeThinking) {
      yield new vscode.LanguageModelThinkingPart('', undefined, {
        _completeThinking,
      });
    }

    // from gemini sdk
    if (
      outputContents.length > 0 &&
      outputContents.every((content) => content.role !== undefined)
    ) {
      yield encodeStatefulMarkerPart<Content[]>(outputContents);
    } else {
      yield encodeStatefulMarkerPart<Content[]>([
        {
          role: 'model',
          parts: [],
        } as Content,
      ]);
    }

    if (lastUsage) {
      this.processUsage(lastUsage, performanceTrace, logger);
    }
  }

  private processUsage(
    usage: NonNullable<GenerateContentResponse['usageMetadata']>,
    performanceTrace: PerformanceTrace,
    logger: RequestLogger,
  ): void {
    sharedProcessUsage(
      usage.candidatesTokenCount,
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
      const client = this.createClient(undefined, false, credential);
      const result: ModelConfig[] = [];
      const pager = await withGoogleFetchLogger(logger, async () => {
        return client.models.list({
          config: {
            httpOptions: {
              headers: this.buildHeaders(credential),
              extraBody: this.buildExtraBody(),
            },
          },
        });
      });
      for await (const model of pager) {
        if (model.name) {
          result.push({ id: model.name });
        }
      }
      return result;
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }
}
