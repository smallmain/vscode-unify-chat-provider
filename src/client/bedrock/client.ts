import * as vscode from 'vscode';
import { createSimpleHttpLogger } from '../../logger';
import type { ProviderHttpLogger, ProviderUsage, RequestLogger } from '../../logger';
import { ApiProvider } from '../interface';
import {
  DEFAULT_NORMAL_TIMEOUT_CONFIG,
  FetchMode,
  resolveContextCacheConfig,
  resolveChatNetwork,
} from '../../utils';
import { ModelConfig, PerformanceTrace, ProviderConfig } from '../../types';
import {
  buildBaseUrl,
  createCustomFetch,
  createFirstTokenRecorder,
  estimateTokenCount as sharedEstimateTokenCount,
  getToken,
  processUsage as sharedProcessUsage,
  resolveBedrockServiceTier,
} from '../utils';
import type { AuthTokenInfo } from '../../auth/types';
import { createVersionedModelId, getBaseModelId, parseModelIdParts } from '../../model-id-utils';
import { parseEventStreamFrames } from './event-stream-parser';
import {
  bedrockConversePreferenceCache,
  type BedrockConversePreference,
} from './converse-preference-cache';
import { bedrockModelLimitCache } from './model-limit-cache';
import type {
  BedrockMessage,
  BedrockContentBlock,
  BedrockSystemBlock,
  BedrockSystemContentBlock,
  BedrockToolConfig,
  BedrockToolSpec,
  BedrockConverseStreamRequest,
  BedrockModelSummary,
  BedrockInferenceProfile,
  BedrockUsage,
  ToolCallBuffer,
} from './types';

/**
 * Extract the AWS region from a Bedrock base URL.
 */
function extractRegionFromUrl(baseUrl: string): string | undefined {
  const match = baseUrl.match(
    /bedrock-runtime\.([a-z]{2}-[a-z]+-\d+)\.amazonaws\.com/,
  );
  return match?.[1];
}

/**
 * Get the provider name from a Bedrock model ID.
 */
function getProviderFromModelId(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return '';
  }

  // ARN examples:
  // - arn:aws:bedrock:...:foundation-model/anthropic.claude-...
  // - arn:aws:bedrock:...:inference-profile/global.anthropic.claude-...
  const normalized = trimmed.startsWith('arn:')
    ? (trimmed.match(/\/([^/]+)$/)?.[1] ?? trimmed)
    : trimmed;

  const profilePrefixMatch = normalized.match(/^(global|[a-z]{2})\.(.+)$/i);
  const withoutProfilePrefix = profilePrefixMatch
    ? profilePrefixMatch[2]
    : normalized;

  const parts = withoutProfilePrefix.split('.');
  return parts[0] ?? '';
}

function normalizeProviderName(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function appendUint8Array(
  existing: Uint8Array<ArrayBufferLike>,
  chunk: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  if (existing.length === 0) {
    return Uint8Array.from(chunk);
  }
  if (chunk.length === 0) {
    return existing;
  }

  const combined = new Uint8Array(existing.length + chunk.length);
  combined.set(existing);
  combined.set(chunk, existing.length);
  return combined;
}

function supportsConverseProvider(model: BedrockModelSummary): boolean {
  const provider = normalizeProviderName(model.providerName);
  const modelId = model.modelId.toLowerCase();

  // Explicitly hide providers/models that are known to fail for this chat path.
  // This avoids over-filtering (which previously hid valid Qwen models).
  if (/writer/.test(provider) || /(^|\.)writer\./.test(modelId)) {
    return false;
  }

  if (
    /twelve\s*labs|twelvelabs/.test(provider) ||
    /(^|\.)twelvelabs\./.test(modelId)
  ) {
    return false;
  }

  return true;
}

function supportsToolChoice(modelId: string): boolean {
  const provider = getProviderFromModelId(modelId);
  return provider === 'anthropic' || provider === 'amazon';
}

function getToolResultFormat(modelId: string): 'text' | 'json' {
  const provider = getProviderFromModelId(modelId);
  return provider === 'mistral' ? 'json' : 'text';
}

function supportsPromptCaching(modelId: string): boolean {
  // Bedrock prompt caching is currently primarily available for Anthropic Claude models.
  return getProviderFromModelId(modelId) === 'anthropic';
}

function supportsOnDemandInvocation(model: BedrockModelSummary): boolean {
  if (!model.inferenceTypesSupported || model.inferenceTypesSupported.length === 0) {
    // Older API responses may omit this field; keep model to avoid false negatives.
    return true;
  }
  return model.inferenceTypesSupported.some(
    (type) => type.toUpperCase() === 'ON_DEMAND',
  );
}

function supportsTextConversation(model: BedrockModelSummary): boolean {
  const inputHasText = model.inputModalities.includes('TEXT');
  const outputHasText = model.outputModalities.includes('TEXT');
  return inputHasText && outputHasText;
}

function isToolContentBlock(block: BedrockContentBlock): boolean {
  return 'toolUse' in block || 'toolResult' in block;
}

function stripToolSectionsFromText(text: string): string {
  return text
    .replace(/<toolUseInstructions>[\s\S]*?<\/toolUseInstructions>/gi, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return true;
      }
      return !/\btool\b|\btools\b/i.test(trimmed);
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isKnownNoToolModel(modelId: string): boolean {
  return (
    /(^|\.)deepseek\.r1(?:[.-]|$)/i.test(modelId) ||
    /(^|\.)meta\.llama3/i.test(modelId)
  );
}

function isKnownNoSystemModel(modelId: string): boolean {
  return /(^|\.)mistral\.mixtral/i.test(modelId);
}

/** Models that reject temperature / topP / topK in inferenceConfig. */
function isKnownNoSamplingParamsModel(modelId: string): boolean {
  // claude-opus-4-7 deprecated sampling params
  return /claude-opus-4-7/i.test(modelId);
}

function isChatCapableModel(model: BedrockModelSummary): boolean {
  const lifecycleStatus = model.modelLifecycle?.status?.toUpperCase();
  const isLegacy = lifecycleStatus === 'LEGACY';

  return (
    !isLegacy &&
    supportsConverseProvider(model) &&
    model.responseStreamingSupported &&
    supportsTextConversation(model)
  );
}

function isEligibleFoundationModel(model: BedrockModelSummary): boolean {
  return isChatCapableModel(model) && supportsOnDemandInvocation(model);
}

function parseContextWindowSuffix(modelId: string): string | undefined {
  const version = parseModelIdParts(modelId).version;
  if (version && /^\d+[kKmM]$/.test(version)) {
    return version.toLowerCase();
  }
  const match = modelId.match(/:(\d+[kKmM])$/);
  if (!match) {
    return undefined;
  }
  return match[1].toLowerCase();
}

function parseContextWindowValue(modelId: string): number | undefined {
  const suffix = parseContextWindowSuffix(modelId);
  if (!suffix) {
    return undefined;
  }

  const unit = suffix.at(-1);
  const raw = Number(suffix.slice(0, -1));
  if (!Number.isFinite(raw)) {
    return undefined;
  }
  if (unit === 'k') {
    return raw * 1_000;
  }
  if (unit === 'm') {
    return raw * 1_000_000;
  }
  return undefined;
}

function parseProfileLabel(modelId: string): string | undefined {
  const globalMatch = modelId.match(/^global\./i);
  if (globalMatch) {
    return 'Global profile';
  }

  const match = modelId.match(/^([a-z]{2})\./i);
  if (!match) {
    return undefined;
  }
  return `${match[1].toUpperCase()} profile`;
}

function removeGeoProfilePrefix(modelId: string): string {
  return modelId.replace(/^(global\.|[a-z]{2}\.)/i, '');
}

function removeContextSuffix(modelId: string): string {
  const { baseId, version } = parseModelIdParts(modelId);
  if (version && /^\d+[kKmM]$/.test(version)) {
    return baseId;
  }
  return modelId.replace(/:(\d+[kKmM])$/, '');
}

function formatContextWindowSuffixForLabel(
  contextSuffix: string | undefined,
): string | undefined {
  if (!contextSuffix) {
    return undefined;
  }
  return contextSuffix.toUpperCase();
}

function supportsAnthropicContextWindowSplit(modelId: string): boolean {
  const baseModelId = removeGeoProfilePrefix(removeContextSuffix(getBaseModelId(modelId)));
  return (
    baseModelId === 'anthropic.claude-opus-4-7' ||
    baseModelId === 'anthropic.claude-opus-4-6' ||
    baseModelId === 'anthropic.claude-opus-4-5' ||
    baseModelId === 'anthropic.claude-sonnet-4-6' ||
    baseModelId === 'anthropic.claude-sonnet-4-5'
  );
}

function expandContextWindowVariants(model: ModelConfig): ModelConfig[] {
  if (!supportsAnthropicContextWindowSplit(model.id)) {
    return [model];
  }

  const baseModelId = getBaseModelId(model.id);

  return [
    {
      ...model,
      id: createVersionedModelId(baseModelId, '200k'),
      maxInputTokens: 200_000,
    },
    {
      ...model,
      id: createVersionedModelId(baseModelId, '1m'),
      maxInputTokens: 1_000_000,
    },
  ];
}

function compactModelIdForLabel(modelId: string): string {
  const noGeo = removeGeoProfilePrefix(modelId);
  const segments = noGeo.split('.');
  if (segments.length <= 1) {
    return modelId;
  }
  return segments.slice(1).join('.');
}

function buildModelDisplayName(
  model: ModelConfig,
  duplicateName: boolean,
): string {
  const normalizedBaseName = (model.name?.trim() || model.id)
    .replace(/^GLOBAL\b/i, 'Global')
    .replace(/\bTweleveLabs\b/gi, 'TwelveLabs');
  const baseName = normalizedBaseName;
  const details: string[] = [];

  const profileLabel = parseProfileLabel(model.id);
  if (profileLabel) {
    // Avoid redundancy like "Global ... (Global profile)" or "US ... (US profile)".
    const isGlobal = profileLabel === 'Global profile';
    const regionCode = !isGlobal
      ? model.id.match(/^([a-z]{2})\./i)?.[1]?.toUpperCase()
      : undefined;

    const isRedundant = isGlobal
      ? baseName.toLowerCase().includes('global')
      : !!(regionCode && baseName.toUpperCase().includes(regionCode));

    if (!isRedundant) {
      details.push(profileLabel);
    }
  }

  const contextSuffix = parseContextWindowSuffix(model.id);
  if (contextSuffix) {
    details.push(formatContextWindowSuffixForLabel(contextSuffix) ?? contextSuffix);
  }

  if (duplicateName && details.length === 0) {
    details.push(compactModelIdForLabel(model.id));
  }

  if (details.length === 0) {
    return baseName;
  }
  return `${baseName} (${details.join(' · ')})`;
}

function getProfileSortRank(modelId: string): number {
  if (!parseProfileLabel(modelId)) {
    return 0;
  }
  if (/^global\./i.test(modelId)) {
    return 1;
  }
  return 2;
}

function normalizeAndSortModelList(models: ModelConfig[]): ModelConfig[] {
  const nameCounts = new Map<string, number>();

  for (const model of models) {
    const name = model.name?.trim();
    if (!name) {
      continue;
    }
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }

  const normalized = models.map((model) => {
    const name = model.name?.trim();
    const duplicateName = !!name && (nameCounts.get(name) ?? 0) > 1;
    return {
      ...model,
      name: buildModelDisplayName(model, duplicateName),
    };
  });

  normalized.sort((a, b) => {
    const aFamily = removeContextSuffix(removeGeoProfilePrefix(a.id));
    const bFamily = removeContextSuffix(removeGeoProfilePrefix(b.id));
    const familyCompare = aFamily.localeCompare(bFamily);
    if (familyCompare !== 0) {
      return familyCompare;
    }

    const aProfileRank = getProfileSortRank(a.id);
    const bProfileRank = getProfileSortRank(b.id);
    if (aProfileRank !== bProfileRank) {
      return aProfileRank - bProfileRank;
    }

    const aContext = parseContextWindowValue(a.id) ?? -1;
    const bContext = parseContextWindowValue(b.id) ?? -1;
    if (aContext !== bContext) {
      return bContext - aContext;
    }

    return a.id.localeCompare(b.id);
  });

  return normalized;
}

export class BedrockProvider implements ApiProvider {
  private readonly baseUrl: string;

  constructor(protected readonly config: ProviderConfig) {
    this.baseUrl = buildBaseUrl(config.baseUrl, { stripPattern: /\/v1$/i });
  }

  private resolveNonStreamingPreference(
    modelId: string,
  ): BedrockConversePreference | undefined {
    return bedrockConversePreferenceCache.get(this.config, modelId);
  }

  private shouldUseNonStreamingFirst(modelId: string, hasTools: boolean): boolean {
    const preference = this.resolveNonStreamingPreference(modelId);
    if (preference === 'always') {
      return true;
    }
    return preference === 'when-tools' && hasTools;
  }

  private rememberNonStreamingPreference(
    modelId: string,
    preference: BedrockConversePreference,
  ): void {
    bedrockConversePreferenceCache.set(this.config, modelId, preference);
  }

  private buildRequestBodyWithoutTools(
    requestBody: BedrockConverseStreamRequest,
  ): BedrockConverseStreamRequest {
    const sanitizedMessages = requestBody.messages
      .map((message) => ({
        ...message,
        content: message.content.filter((block) => !isToolContentBlock(block)),
      }))
      .filter((message) => message.content.length > 0);

    const sanitizedRequestBody: BedrockConverseStreamRequest = {
      ...requestBody,
      messages: sanitizedMessages,
    };

    if (requestBody.system) {
      sanitizedRequestBody.system = requestBody.system
        .map((block) => {
          if (!('text' in block)) {
            return block;
          }

          const sanitizedText = stripToolSectionsFromText(block.text);
          if (!sanitizedText) {
            return undefined;
          }

          return { text: sanitizedText };
        })
        .filter(
          (
            block,
          ): block is Exclude<
            BedrockSystemContentBlock,
            undefined
          > => block !== undefined,
        );
    }

    delete sanitizedRequestBody.toolConfig;
    return sanitizedRequestBody;
  }

  private buildRequestBodyWithoutSystem(
    requestBody: BedrockConverseStreamRequest,
  ): BedrockConverseStreamRequest {
    const sanitizedRequestBody: BedrockConverseStreamRequest = { ...requestBody };
    delete sanitizedRequestBody.system;
    return sanitizedRequestBody;
  }

  private getRegion(): string {
    const region = extractRegionFromUrl(this.config.baseUrl);
    if (!region) {
      throw new Error(
        `Cannot extract AWS region from Bedrock base URL: ${this.config.baseUrl}. ` +
          `Expected format: https://bedrock-runtime.<region>.amazonaws.com`,
      );
    }
    return region;
  }

  private buildAuthHeaders(credential: AuthTokenInfo): Record<string, string> {
    const token = getToken(credential);
    if (!token) {
      throw new Error('Bedrock API key is required');
    }
    return { Authorization: `Bearer ${token}` };
  }

  private convertMessages(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    modelId: string,
  ): { messages: BedrockMessage[]; system: BedrockSystemContentBlock[] } {
    const bedrockMessages: BedrockMessage[] = [];
    const systemBlocks: BedrockSystemContentBlock[] = [];
    const toolResultFormat = getToolResultFormat(modelId);
    let pendingToolResults: BedrockContentBlock[] = [];

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const textParts: string[] = [];
      const imageBlocks: BedrockContentBlock[] = [];
      const toolCalls: BedrockContentBlock[] = [];
      const toolResults: BedrockContentBlock[] = [];

      for (const part of m.content ?? []) {
        if (part instanceof vscode.LanguageModelTextPart) {
          if (
            m.role === vscode.LanguageModelChatMessageRole.User ||
            m.role === vscode.LanguageModelChatMessageRole.Assistant
          ) {
            textParts.push(part.value);
          } else {
            systemBlocks.push({ text: part.value } satisfies BedrockSystemBlock);
          }
        } else if (
          typeof part === 'object' &&
          part !== null &&
          'mimeType' in part &&
          (part as vscode.LanguageModelDataPart).mimeType?.startsWith('image/')
        ) {
          const dataPart = part as vscode.LanguageModelDataPart;
          const format = dataPart.mimeType.replace('image/', '') as
            | 'png'
            | 'jpeg'
            | 'gif'
            | 'webp';
          if (['png', 'jpeg', 'gif', 'webp'].includes(format)) {
            const base64 = Buffer.from(dataPart.data).toString('base64');
            imageBlocks.push({ image: { format, source: { bytes: base64 } } });
          }
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push({
            toolUse: {
              toolUseId:
                part.callId ||
                `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              name: part.name,
              input: (part.input as Record<string, unknown>) ?? {},
            },
          });
        } else if (
          typeof part === 'object' &&
          part !== null &&
          'callId' in part &&
          'content' in part
        ) {
          const resultPart = part as {
            callId: string;
            content: ReadonlyArray<{ value: string }>;
          };
          const resultText = resultPart.content
            .map((c) => c.value ?? '')
            .join('');
          let content: Array<
            { text: string } | { json: Record<string, unknown> }
          >;
          if (toolResultFormat === 'json') {
            try {
              content = [{ json: JSON.parse(resultText) }];
            } catch {
              content = [{ text: resultText }];
            }
          } else {
            content = [{ text: resultText }];
          }
          toolResults.push({
            toolResult: { toolUseId: resultPart.callId, content },
          });
        }
      }

      // Emit assistant message with tool calls
      let emittedAssistantToolCall = false;
      if (
        toolCalls.length > 0 &&
        m.role === vscode.LanguageModelChatMessageRole.Assistant
      ) {
        const content: BedrockContentBlock[] = [];
        const combinedText = textParts.join('');
        if (combinedText) content.push({ text: combinedText });
        content.push(...imageBlocks, ...toolCalls);
        bedrockMessages.push({ role: 'assistant', content });
        emittedAssistantToolCall = true;
      }

      // Accumulate tool results
      if (toolResults.length > 0) {
        pendingToolResults.push(...toolResults);
        const nextMessage =
          i + 1 < messages.length ? messages[i + 1] : undefined;
        const nextIsToolResultOnly =
          nextMessage &&
          nextMessage.role === vscode.LanguageModelChatMessageRole.User &&
          nextMessage.content.every(
            (p) =>
              typeof p === 'object' && p !== null && 'callId' in p && 'content' in p,
          );
        if (!nextIsToolResultOnly && pendingToolResults.length > 0) {
          bedrockMessages.push({
            role: 'user',
            content: pendingToolResults,
          });
          pendingToolResults = [];
        }
      }

      // Emit text/image messages
      const text = textParts.join('');
      if (
        (text || imageBlocks.length > 0) &&
        !emittedAssistantToolCall &&
        toolResults.length === 0
      ) {
        const content: BedrockContentBlock[] = [];
        if (
          pendingToolResults.length > 0 &&
          m.role === vscode.LanguageModelChatMessageRole.User
        ) {
          content.push(...pendingToolResults);
          pendingToolResults = [];
        }
        if (text) content.push({ text });
        content.push(...imageBlocks);
        bedrockMessages.push({
          role: m.role === vscode.LanguageModelChatMessageRole.User
            ? 'user'
            : 'assistant',
          content,
        });
      }
    }

    if (pendingToolResults.length > 0) {
      bedrockMessages.push({ role: 'user', content: pendingToolResults });
    }

    this.applyCachePoint(modelId, systemBlocks, bedrockMessages);

    return { messages: bedrockMessages, system: systemBlocks };
  }

  private applyCachePoint(
    modelId: string,
    system: BedrockSystemContentBlock[],
    messages: BedrockMessage[],
  ): void {
    if (!supportsPromptCaching(modelId)) {
      return;
    }

    // Resolve to keep behavior aligned with global context-cache defaults,
    // even though Bedrock cache points currently only support a simple
    // on/off placement strategy.
    resolveContextCacheConfig(this.config.contextCache);

    const cachePoint = { cachePoint: { type: 'default' as const } };

    // Add a cache breakpoint after system prompt.
    if (system.length > 0) {
      system.push(cachePoint);
    }

    // Add a cache breakpoint at the end of the last user message content.
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUser) {
      lastUser.content.push(cachePoint);
    }
  }

  private convertTools(
    options: vscode.ProvideLanguageModelChatResponseOptions,
    modelId: string,
  ): BedrockToolConfig | undefined {
    const tools = options.tools ?? [];
    if (!tools || tools.length === 0) return undefined;

    const toolSpecs: BedrockToolSpec[] = tools
      .filter((t) => t && typeof t === 'object')
      .map((t) => ({
        name: t.name,
        description: typeof t.description === 'string' ? t.description : '',
        inputSchema: {
          json: ((t.inputSchema as Record<string, unknown>) ?? {
            type: 'object',
            properties: {},
          }) as Record<string, unknown>,
        },
      }));

    const toolConfig: BedrockToolConfig = {
      tools: toolSpecs.map((spec) => ({ toolSpec: spec })),
    };

    if (supportsToolChoice(modelId)) {
      const mode = options.toolMode as
        | vscode.LanguageModelChatToolMode
        | undefined;
      if (mode === vscode.LanguageModelChatToolMode.Required) {
        if (tools.length !== 1) {
          throw new Error(
            'LanguageModelChatToolMode.Required is not supported with more than one tool',
          );
        }
        toolConfig.toolChoice = { tool: { name: tools[0].name } };
      } else {
        toolConfig.toolChoice = { auto: {} };
      }
    }

    return toolConfig;
  }

  private async fallbackToNonStreamingConverse(
    url: string,
    headers: Record<string, string>,
    requestBody: BedrockConverseStreamRequest,
    customFetch: ReturnType<typeof createCustomFetch>,
    logger: RequestLogger,
    performanceTrace: PerformanceTrace,
  ): Promise<{
    parts: vscode.LanguageModelResponsePart2[];
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheWriteInputTokens: number;
    };
  }> {
    const nonStreamingUrl = url.replace(/\/converse-stream$/, '/converse');

    const requestHeaders = {
      ...headers,
      Accept: 'application/json',
    };
    let effectiveRequestBody: typeof requestBody = {
      ...requestBody,
      modelId: getBaseModelId(requestBody.modelId),
    };
    let response = await customFetch(nonStreamingUrl, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(effectiveRequestBody),
    });

    if (!response.ok) {
      let errorText = await response.text().catch(() => 'unknown error');

      const requestedMaxTokens = effectiveRequestBody.inferenceConfig?.maxTokens;
      const modelLimit = this.tryExtractModelLimitFromBedrockError(errorText);

      if (
        response.status === 400 &&
        typeof requestedMaxTokens === 'number' &&
        modelLimit !== undefined &&
        requestedMaxTokens > modelLimit
      ) {
        this.rememberModelLimit(requestBody.modelId, modelLimit);
        effectiveRequestBody = {
          ...effectiveRequestBody,
          inferenceConfig: {
            ...effectiveRequestBody.inferenceConfig,
            maxTokens: modelLimit,
          },
        };

        logger.verbose(
          `[Bedrock] Retrying non-streaming /converse with clamped maxTokens=${modelLimit} due to model limit error.`,
        );

        response = await customFetch(nonStreamingUrl, {
          method: 'POST',
          headers: requestHeaders,
          body: JSON.stringify(effectiveRequestBody),
        });

        if (!response.ok) {
          errorText = await response.text().catch(() => 'unknown error');
          throw new Error(`Bedrock API error ${response.status}: ${errorText}`);
        }
      } else {
        throw new Error(`Bedrock API error ${response.status}: ${errorText}`);
      }
    }

    const data = (await response.json()) as {
      message?: string;
      output?: {
        message?: {
          content?: Array<
            | { text?: string }
            | { toolUse?: { toolUseId: string; name: string; input?: object } }
          >;
        };
      };
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadInputTokens?: number;
        cacheWriteInputTokens?: number;
      };
    };

    const responseMessage =
      typeof data.message === 'string' ? data.message : undefined;

    if (responseMessage !== undefined && !data.output) {
      throw new Error(`Bedrock API error ${response.status}: ${JSON.stringify(data)}`);
    }

    return this.buildNonStreamingConverseResult(data, logger);
  }

  private buildNonStreamingConverseResult(
    data: {
      output?: {
        message?: {
          content?: Array<
            | { text?: string }
            | { toolUse?: { toolUseId: string; name: string; input?: object } }
          >;
        };
      };
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadInputTokens?: number;
        cacheWriteInputTokens?: number;
      };
    },
    logger: RequestLogger,
  ): {
    parts: vscode.LanguageModelResponsePart2[];
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheWriteInputTokens: number;
    };
  } {

    const parts: vscode.LanguageModelResponsePart2[] = [];
    const content = data.output?.message?.content ?? [];

    for (const block of content) {
      if ('text' in block && typeof block.text === 'string' && block.text.length) {
        parts.push(new vscode.LanguageModelTextPart(block.text));
      } else if ('toolUse' in block && block.toolUse) {
        parts.push(
          new vscode.LanguageModelToolCallPart(
            block.toolUse.toolUseId,
            block.toolUse.name,
            (block.toolUse.input as Record<string, unknown>) ?? {},
          ),
        );
      }
    }

    logger.verbose('[Bedrock] Fallback to non-streaming /converse succeeded.');

    return {
      parts,
      usage: {
        inputTokens: data.usage?.inputTokens ?? 0,
        outputTokens: data.usage?.outputTokens ?? 0,
        cacheReadInputTokens: data.usage?.cacheReadInputTokens ?? 0,
        cacheWriteInputTokens: data.usage?.cacheWriteInputTokens ?? 0,
      },
    };
  }

  private tryExtractModelLimitFromBedrockError(errorText: string): number | undefined {
    const match = errorText.match(/lower than\s+(\d+)/i);
    if (!match) {
      return undefined;
    }
    const parsed = Number(match[1]);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return undefined;
    }
    return parsed;
  }

  private rememberModelLimit(modelId: string, maxOutputTokens: number): void {
    bedrockModelLimitCache.set(this.config, modelId, maxOutputTokens);
  }

  private buildLoggerUsage(
    inputTokens: number,
    outputTokens: number,
    cacheReadInputTokens: number,
    cacheWriteInputTokens: number,
  ): ProviderUsage {
    return {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: cacheReadInputTokens,
      cache_creation_input_tokens: cacheWriteInputTokens,
    } as ProviderUsage;
  }

  private logUsage(
    logger: RequestLogger,
    performanceTrace: PerformanceTrace,
    usage: BedrockUsage,
  ): void {
    sharedProcessUsage(
      usage.outputTokens,
      performanceTrace,
      logger,
      this.buildLoggerUsage(
        usage.inputTokens ?? 0,
        usage.outputTokens ?? 0,
        usage.cacheReadInputTokens ?? 0,
        usage.cacheWriteInputTokens ?? 0,
      ),
    );
    logger.verbose(`Bedrock usage: ${JSON.stringify(usage)}`);
  }

  private async sendConverseStreamRequest(
    customFetch: ReturnType<typeof createCustomFetch>,
    url: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<Response> {
    return customFetch(url, {
      method: 'POST',
      headers,
      body,
    });
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
    const chatNetwork = resolveChatNetwork(this.config);
    const effectiveTimeout =
      chatNetwork?.timeout ?? DEFAULT_NORMAL_TIMEOUT_CONFIG;

    const modelId = encodedModelId.includes('/')
      ? encodedModelId.split('/').slice(1).join('/')
      : encodedModelId;
    // Strip version suffix added by model cloning (e.g. "claude-sonnet-4-7#1" -> "claude-sonnet-4-7").
    const withoutVersionSuffix = getBaseModelId(modelId);
    const converted = this.convertMessages(messages, withoutVersionSuffix);
    const toolMode = options.toolMode as
      | vscode.LanguageModelChatToolMode
      | undefined;
    const shouldDisableToolsForRequest =
      toolMode !== vscode.LanguageModelChatToolMode.Required &&
      isKnownNoToolModel(withoutVersionSuffix);
    const shouldDisableSystemForRequest = isKnownNoSystemModel(withoutVersionSuffix);

    const toolConfig = !shouldDisableToolsForRequest
      ? this.convertTools(options, modelId)
      : undefined;

    const requestedMaxTokensRaw = (options.modelOptions as Record<string, unknown>)
      ?.max_tokens;
    const requestedMaxTokens =
      typeof requestedMaxTokensRaw === 'number' &&
      Number.isFinite(requestedMaxTokensRaw) &&
      requestedMaxTokensRaw > 0
        ? requestedMaxTokensRaw
        : undefined;
    const configuredMaxOutputTokens =
      typeof model.maxOutputTokens === 'number' &&
      Number.isFinite(model.maxOutputTokens) &&
      model.maxOutputTokens > 0
        ? model.maxOutputTokens
        : undefined;
    const cachedMaxOutputTokens = bedrockModelLimitCache.get(this.config, modelId);

    const maxTokenCandidates = [
      requestedMaxTokens,
      configuredMaxOutputTokens,
      cachedMaxOutputTokens,
    ].filter((value): value is number => value !== undefined);

    const initialMaxTokens =
      maxTokenCandidates.length > 0 ? Math.min(...maxTokenCandidates) : undefined;

    const stripSamplingParams = isKnownNoSamplingParamsModel(modelId);

    const requestBody: BedrockConverseStreamRequest = {
      modelId: withoutVersionSuffix,
      messages: converted.messages,
      inferenceConfig: stripSamplingParams
        ? {}
        : {
            temperature:
              ((options.modelOptions as Record<string, unknown>)
                ?.temperature as number) ?? 0.7,
          },
    };

    if (initialMaxTokens !== undefined) {
      requestBody.inferenceConfig!.maxTokens = initialMaxTokens;
    }

    if (converted.system.length > 0) {
      requestBody.system = converted.system;
    }
    if (toolConfig) {
      requestBody.toolConfig = toolConfig;
    }

    const modelOptions = options.modelOptions as
      | Record<string, unknown>
      | undefined;
    if (modelOptions) {
      if (!stripSamplingParams && typeof modelOptions.top_p === 'number') {
        requestBody.inferenceConfig!.topP = modelOptions.top_p;
      }
      if (
        !stripSamplingParams &&
        typeof modelOptions.top_k === 'number' &&
        modelOptions.top_k >= 0 &&
        modelOptions.top_k <= 500
      ) {
        requestBody.inferenceConfig!.topK = modelOptions.top_k;
      }
      if (typeof modelOptions.stop === 'string') {
        requestBody.inferenceConfig!.stopSequences = [modelOptions.stop];
      } else if (Array.isArray(modelOptions.stop)) {
        requestBody.inferenceConfig!.stopSequences = modelOptions.stop;
      }
    }

    const effectiveRequestBody = shouldDisableToolsForRequest
      ? this.buildRequestBodyWithoutTools(requestBody)
      : shouldDisableSystemForRequest
        ? this.buildRequestBodyWithoutSystem(requestBody)
        : requestBody;

    const url = `${this.baseUrl}/model/${encodeURIComponent(withoutVersionSuffix)}/converse-stream`;
    const authHeaders = this.buildAuthHeaders(credential);
    const extraHeaders = this.config.extraHeaders ?? {};
    const modelExtraHeaders = model.extraHeaders ?? {};
    const serviceTier = resolveBedrockServiceTier(this.config, model);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/vnd.amazon.eventstream',
      ...authHeaders,
      ...extraHeaders,
      ...modelExtraHeaders,
      ...(serviceTier !== undefined ? { 'service_tier': serviceTier } : {}),
    };

    const abortController = new AbortController();
    const cancellationListener = token.onCancellationRequested(() => {
      abortController.abort();
    });

    const customFetch = createCustomFetch({
      connectionTimeoutMs: effectiveTimeout.connection,
      responseTimeoutMs: effectiveTimeout.response,
      logger: logger as unknown as ProviderHttpLogger | undefined,
      retryConfig: chatNetwork?.retry,
      type: 'chat' as FetchMode,
      abortSignal: abortController.signal,
    });

    const recordFirstToken = createFirstTokenRecorder(performanceTrace);
    const bodyString = JSON.stringify(effectiveRequestBody);
    const hasTools =
      !!effectiveRequestBody.toolConfig ||
      effectiveRequestBody.messages.some((message) =>
        message.content.some((block) => isToolContentBlock(block)),
      );
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadInputTokens = 0;
    let cacheWriteInputTokens = 0;

    logger.providerRequest({
      endpoint: url,
      method: 'POST',
      headers,
      body: effectiveRequestBody,
    });

    if (this.shouldUseNonStreamingFirst(modelId, hasTools)) {
      logger.verbose(
        `[Bedrock] Using cached non-streaming preference for model ${modelId}.`,
      );

      const fallback = await this.fallbackToNonStreamingConverse(
        url,
        headers,
        effectiveRequestBody,
        customFetch,
        logger,
        performanceTrace,
      );

      for (const part of fallback.parts) {
        if (part instanceof vscode.LanguageModelTextPart) {
          recordFirstToken();
        }
        yield part;
      }

      inputTokens = fallback.usage.inputTokens;
      outputTokens = fallback.usage.outputTokens;
      cacheReadInputTokens = fallback.usage.cacheReadInputTokens;
      cacheWriteInputTokens = fallback.usage.cacheWriteInputTokens;

      this.logUsage(logger, performanceTrace, fallback.usage);
      cancellationListener.dispose();
      return;
    }

    let response: Response;
    try {
      response = await this.sendConverseStreamRequest(
        customFetch,
        url,
        headers,
        bodyString,
      );
    } catch (error) {
      cancellationListener.dispose();
      throw error;
    }

    if (!response.ok) {
      let errorText = await response.text().catch(() => 'unknown error');

      const modelLimit = this.tryExtractModelLimitFromBedrockError(errorText);
      if (
        response.status === 400 &&
        modelLimit !== undefined &&
        initialMaxTokens !== undefined &&
        initialMaxTokens > modelLimit
      ) {
        this.rememberModelLimit(modelId, modelLimit);
        const retryBody: BedrockConverseStreamRequest = {
          ...effectiveRequestBody,
          inferenceConfig: {
            ...effectiveRequestBody.inferenceConfig,
            maxTokens: modelLimit,
          },
        };
        const retryBodyString = JSON.stringify(retryBody);
        logger.verbose(
          `[Bedrock] Retrying with clamped maxTokens=${modelLimit} due to model limit error.`,
        );
        response = await this.sendConverseStreamRequest(
          customFetch,
          url,
          headers,
          retryBodyString,
        );
        if (response.ok) {
          errorText = '';
        } else {
          errorText = await response.text().catch(() => 'unknown error');
        }
      }

      if (!response.ok) {
        const unsupportedAction =
          response.status === 400 &&
          /doesn't support the model that you provided/i.test(errorText);

        if (unsupportedAction) {
          cancellationListener.dispose();
          throw new Error(
            'Bedrock model is not supported by the Converse API for chat. ' +
              'Please choose another Bedrock chat model and refresh the model list.',
          );
        }

        const toolUseStreamingUnsupported =
          response.status === 400 &&
          /doesn['’]t support tool use in streaming mode/i.test(errorText);
        const isUnsupportedStreaming =
          response.status === 400 &&
          (/unsupported for streaming/i.test(errorText) ||
            toolUseStreamingUnsupported);

        if (isUnsupportedStreaming) {
          this.rememberNonStreamingPreference(
            modelId,
            toolUseStreamingUnsupported ? 'when-tools' : 'always',
          );

          const fallback = await this.fallbackToNonStreamingConverse(
            url,
            headers,
            effectiveRequestBody,
            customFetch,
            logger,
            performanceTrace,
          );

          for (const part of fallback.parts) {
            if (part instanceof vscode.LanguageModelTextPart) {
              recordFirstToken();
            }
            yield part;
          }

          inputTokens = fallback.usage.inputTokens;
          outputTokens = fallback.usage.outputTokens;
          cacheReadInputTokens = fallback.usage.cacheReadInputTokens;
          cacheWriteInputTokens = fallback.usage.cacheWriteInputTokens;

          this.logUsage(logger, performanceTrace, fallback.usage);
          cancellationListener.dispose();
          return;
        }

        const isLegacyDenied = /marked by provider as Legacy/i.test(errorText);
        if (isLegacyDenied) {
          cancellationListener.dispose();
          throw new Error(
            'Bedrock model access denied: this model is marked as Legacy by the provider. ' +
              'Please select a currently active model and refresh the Bedrock model list.',
          );
        }

        cancellationListener.dispose();
        throw new Error(`Bedrock API error ${response.status}: ${errorText}`);
      }
    }

    logger.providerResponseMeta(response);

    const responseBody = response.body;
    if (!responseBody) {
      cancellationListener.dispose();
      throw new Error('No response body from Bedrock');
    }

    const toolBuffers = new Map<number, ToolCallBuffer>();
    const decoder = new TextDecoder();
    let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

    const reader = responseBody.getReader();
    try {
      while (true) {
        if (token.isCancellationRequested) break;

        const { done, value } = await reader.read();
        if (done) break;

        // Append chunk to buffer
        buffer = appendUint8Array(buffer, value);

        // Parse all complete frames
        const { messages: frames, bytesConsumed } =
          parseEventStreamFrames(buffer);
        if (bytesConsumed > 0) {
          buffer = buffer.slice(bytesConsumed);
        }

        for (const frame of frames) {
          const messageType = frame.headers[':message-type'] as string;

          if (messageType === 'exception') {
            const exceptionType = frame.headers[':exception-type'] as string;
            const errorText = decoder.decode(frame.payload);
            let errorMsg: string;
            try {
              errorMsg = JSON.parse(errorText).message ?? errorText;
            } catch {
              errorMsg = errorText;
            }
            throw new Error(`Bedrock ${exceptionType}: ${errorMsg}`);
          }

          if (messageType !== 'event') continue;

          const eventType = frame.headers[':event-type'] as string;

          if (eventType === 'contentBlockStart') {
            const start = JSON.parse(decoder.decode(frame.payload));
            const idx = start.contentBlockIndex ?? 0;
            const toolUse = start.start?.toolUse;
            if (toolUse) {
              toolBuffers.set(idx, {
                id: toolUse.toolUseId ?? '',
                name: toolUse.name ?? '',
                args: '',
              });
            }
          } else if (eventType === 'contentBlockDelta') {
            const delta = JSON.parse(decoder.decode(frame.payload));
            const idx = delta.contentBlockIndex ?? 0;
            const blockDelta = delta.delta;

            if (blockDelta?.text) {
              recordFirstToken();
              yield new vscode.LanguageModelTextPart(blockDelta.text);
            }

            if (blockDelta?.toolUse?.input) {
              const buf = toolBuffers.get(idx);
              if (buf) {
                buf.args += blockDelta.toolUse.input;
              }
            }

            if (blockDelta?.reasoningContent?.text) {
              try {
                const ThinkingPart = (
                  vscode as unknown as Record<
                    string,
                    new (text: string) => vscode.LanguageModelResponsePart2
                  >
                ).LanguageModelThinkingPart;
                if (ThinkingPart) {
                  recordFirstToken();
                  yield new ThinkingPart(blockDelta.reasoningContent.text);
                }
              } catch {
                // LanguageModelThinkingPart not available
              }
            }
          } else if (eventType === 'contentBlockStop') {
            const stop = JSON.parse(decoder.decode(frame.payload));
            const idx = stop.contentBlockIndex ?? 0;
            const toolBuffer = toolBuffers.get(idx);
            if (toolBuffer) {
              yield* this.emitToolCall(toolBuffer);
              toolBuffers.delete(idx);
            }
          } else if (eventType === 'messageStop') {
            for (const [, toolBuffer] of toolBuffers) {
              yield* this.emitToolCall(toolBuffer);
            }
            toolBuffers.clear();
          } else if (eventType === 'metadata') {
            const metadata = JSON.parse(decoder.decode(frame.payload));
            if (metadata.usage) {
              inputTokens = metadata.usage.inputTokens ?? 0;
              outputTokens = metadata.usage.outputTokens ?? 0;
              cacheReadInputTokens = metadata.usage.cacheReadInputTokens ?? 0;
              cacheWriteInputTokens = metadata.usage.cacheWriteInputTokens ?? 0;
            }
          }
        }
      }

      // Process remaining buffer
      if (buffer.length > 0) {
        const { messages: frames } = parseEventStreamFrames(buffer);
        for (const frame of frames) {
          const messageType = frame.headers[':message-type'] as string;
          if (messageType !== 'event') continue;
          const eventType = frame.headers[':event-type'] as string;
          if (eventType === 'contentBlockDelta') {
            const delta = JSON.parse(decoder.decode(frame.payload));
            if (delta.delta?.text) {
              recordFirstToken();
              yield new vscode.LanguageModelTextPart(delta.delta.text);
            }
          }
        }
      }

      const bedrockUsage = {
        inputTokens,
        outputTokens,
        cacheReadInputTokens,
        cacheWriteInputTokens,
      } as BedrockUsage;

      this.logUsage(logger, performanceTrace, bedrockUsage);
    } finally {
      reader.releaseLock();
      cancellationListener.dispose();
    }
  }

  private *emitToolCall(
    toolBuffer: ToolCallBuffer,
  ): Generator<vscode.LanguageModelResponsePart2> {
    let input: Record<string, unknown> = {};
    if (toolBuffer.args) {
      try {
        input = JSON.parse(toolBuffer.args);
      } catch {
        input = {};
      }
    }
    yield new vscode.LanguageModelToolCallPart(
      toolBuffer.id,
      toolBuffer.name,
      input,
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

    const region = this.getRegion();
    const authHeaders = this.buildAuthHeaders(credential);
    const chatNetwork = resolveChatNetwork(this.config);
    const effectiveTimeout =
      chatNetwork?.timeout ?? DEFAULT_NORMAL_TIMEOUT_CONFIG;
    const customFetch = createCustomFetch({
      connectionTimeoutMs: effectiveTimeout.connection,
      responseTimeoutMs: effectiveTimeout.response,
      logger,
      retryConfig: chatNetwork?.retry,
      type: 'normal' as FetchMode,
    });

    try {
      const [models, profiles] = await Promise.all([
        this.fetchFoundationModels(region, authHeaders, customFetch),
        this.fetchInferenceProfiles(region, authHeaders, customFetch),
      ]);

      const chatCapableFoundationByArn = new Map<string, BedrockModelSummary>();
      for (const model of models) {
        if (!isChatCapableModel(model)) {
          continue;
        }
        if (model.modelArn) {
          chatCapableFoundationByArn.set(model.modelArn, model);
        }
      }

      const allModels: ModelConfig[] = [];
      const seenIds = new Set<string>();

      // Add eligible foundation models only (chat/text + stream + on-demand).
      for (const m of models) {
        if (!isEligibleFoundationModel(m)) {
          continue;
        }
        const id = m.modelId;
        if (!seenIds.has(id)) {
          seenIds.add(id);
          allModels.push(...expandContextWindowVariants({
            id,
            name: m.modelName,
            capabilities: {
              imageInput: m.inputModalities.includes('IMAGE'),
            },
          }));
        }
      }

      // Add inference profiles only when they reference at least one eligible
      // underlying chat-capable foundation model (filters out image-only / non-chat profiles).
      // Note: profile targets can be non-ON_DEMAND, so we do not apply on-demand
      // filtering to profile inclusion.
      for (const profile of profiles) {
        if (profile.status !== 'ACTIVE') continue;

        const hasEligibleTargetModel = profile.models?.some((m) => {
          const arn = m.modelArn;
          return !!arn && chatCapableFoundationByArn.has(arn);
        });
        if (!hasEligibleTargetModel) {
          continue;
        }

        const id = profile.inferenceProfileId;
        if (!seenIds.has(id)) {
          seenIds.add(id);
          allModels.push(...expandContextWindowVariants({
            id,
            name: profile.inferenceProfileName,
          }));
        }
      }

      return normalizeAndSortModelList(allModels);
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }

  private async fetchFoundationModels(
    region: string,
    authHeaders: Record<string, string>,
    customFetch: ReturnType<typeof createCustomFetch>,
  ): Promise<BedrockModelSummary[]> {
    const url = `https://bedrock.${region}.amazonaws.com/foundation-models`;
    const response = await customFetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...authHeaders },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error');
      throw new Error(
        `Bedrock model refresh failed for foundation models in region ${region}: ` +
          `HTTP ${response.status} ${errorText}`,
      );
    }

    const data = (await response.json()) as {
      modelSummaries?: BedrockModelSummary[];
    };
    return data.modelSummaries ?? [];
  }

  private async fetchInferenceProfiles(
    region: string,
    authHeaders: Record<string, string>,
    customFetch: ReturnType<typeof createCustomFetch>,
  ): Promise<BedrockInferenceProfile[]> {
    const profiles: BedrockInferenceProfile[] = [];
    let nextToken: string | undefined;

    do {
      const url = new URL(
        `https://bedrock.${region}.amazonaws.com/inference-profiles`,
      );
      if (nextToken) {
        url.searchParams.set('nextToken', nextToken);
      }

      const response = await customFetch(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json', ...authHeaders },
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown error');
        throw new Error(
          `Bedrock model refresh failed for inference profiles in region ${region}: ` +
            `HTTP ${response.status} ${errorText}`,
        );
      }

      const data = (await response.json()) as {
        inferenceProfileSummaries?: BedrockInferenceProfile[];
        nextToken?: string;
      };

      profiles.push(...(data.inferenceProfileSummaries ?? []));
      nextToken =
        typeof data.nextToken === 'string' && data.nextToken.trim().length > 0
          ? data.nextToken
          : undefined;
    } while (nextToken);

    return profiles;
  }
}
