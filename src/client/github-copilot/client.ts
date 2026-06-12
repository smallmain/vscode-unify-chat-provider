import type {
  CancellationToken,
  LanguageModelChatRequestMessage,
  LanguageModelResponsePart2,
  ProvideLanguageModelChatResponseOptions,
} from 'vscode';
import * as vscode from 'vscode';
import type { AuthTokenInfo } from '../../auth/types';
import type { RequestLogger } from '../../logger';
import { getBaseModelId } from '../../model-id-utils';
import type {
  ChatRequestTrace,
  ModelConfig,
  ProviderConfig,
  ThinkingEffort,
} from '../../types';
import {
  DEFAULT_NORMAL_TIMEOUT_CONFIG,
  isImageMarker,
  isRawBaseUrlEnabled,
  normalizeRawBaseUrlInput,
  resolveChatNetwork,
} from '../../utils';
import type { ApiProvider } from '../interface';
import { buildBaseUrl, createCustomFetch, getToken } from '../utils';
import { OpenAIChatCompletionProvider } from '../openai/chat-completion-client';
import { OpenAIResponsesProvider } from '../openai/responses-client';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import type { ChatCompletionSnapshot } from 'openai/lib/ChatCompletionStream';
import { buildOpencodeUserAgent } from '../../utils';
import { AnthropicProvider } from '../anthropic/client';
import { createSimpleHttpLogger } from '../../logger';
import {
  adaptiveReasoningEffort,
  reasoningEffort,
} from '../../well-known/preset-templates';

const COPILOT_API_VERSION = '2026-06-01';
const DEFAULT_COPILOT_BASE_URL = 'https://api.githubcopilot.com';
type CopilotEndpoint = 'chat' | 'responses' | 'messages';
const copilotEndpointCache = new Map<string, Map<string, CopilotEndpoint>>();

type CopilotModelApiItem = {
  model_picker_enabled: boolean;
  id: string;
  name: string;
  version: string;
  supported_endpoints?: string[];
  policy?: {
    state?: string;
  };
  billing?: {
    token_prices?: {
      batch_size: number;
      default: {
        cache_price: number;
        input_price: number;
        output_price: number;
      };
    };
  };
  capabilities: {
    family: string;
    limits?: {
      max_context_window_tokens?: number;
      max_output_tokens?: number;
      max_prompt_tokens?: number;
      vision?: {
        max_prompt_image_size: number;
        max_prompt_images: number;
        supported_media_types: string[];
      };
    };
    supports: {
      adaptive_thinking?: boolean;
      max_thinking_budget?: number;
      min_thinking_budget?: number;
      reasoning_effort?: string[];
      streaming?: boolean;
      structured_outputs?: boolean;
      tool_calls?: boolean;
      vision?: boolean;
    };
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pickString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function pickNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function pickBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function pickStringArray(
  record: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined;
}

function normalizeDomain(input: string): string {
  return input.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

function resolveCopilotApiBaseUrl(config: ProviderConfig): string {
  if (isRawBaseUrlEnabled(config)) {
    return normalizeRawBaseUrlInput(config.baseUrl);
  }

  const normalized = buildBaseUrl(config.baseUrl, { stripPattern: /\/v1$/ });

  const auth = config.auth;
  const enterpriseDomain =
    auth?.method === 'github-copilot' ? auth.enterpriseUrl?.trim() : undefined;

  const baseUrl =
    enterpriseDomain && normalized === DEFAULT_COPILOT_BASE_URL
      ? buildBaseUrl(`https://copilot-api.${normalizeDomain(enterpriseDomain)}`, {
          stripPattern: /\/v1$/,
        })
      : normalized;

  // Auto-switch to the enterprise Copilot base URL when user has configured
  // enterprise auth but still uses the default github.com base URL.
  return baseUrl;
}

function resolveCopilotOpenAiBaseUrl(config: ProviderConfig): string {
  if (isRawBaseUrlEnabled(config)) {
    return normalizeRawBaseUrlInput(config.baseUrl);
  }
  return resolveCopilotApiBaseUrl(config);
}

function resolveCopilotMessagesBaseUrl(config: ProviderConfig): string {
  if (isRawBaseUrlEnabled(config)) {
    return normalizeRawBaseUrlInput(config.baseUrl);
  }
  return buildBaseUrl(resolveCopilotApiBaseUrl(config), {
    ensureSuffix: '/v1',
    skipSuffixIfMatch: /\/v\d+$/,
  });
}

function parseCopilotModelApiItem(raw: unknown): CopilotModelApiItem | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const id = pickString(raw, 'id');
  const name = pickString(raw, 'name');
  const version = pickString(raw, 'version');
  const modelPickerEnabled = pickBoolean(raw, 'model_picker_enabled');
  const capabilitiesRaw = raw['capabilities'];
  if (
    !id ||
    !name ||
    !version ||
    modelPickerEnabled === undefined ||
    !isRecord(capabilitiesRaw)
  ) {
    return undefined;
  }

  const supportsRaw = capabilitiesRaw['supports'];
  if (!isRecord(supportsRaw)) {
    return undefined;
  }

  const limitsRaw = capabilitiesRaw['limits'];
  const visionRaw = isRecord(limitsRaw) ? limitsRaw['vision'] : undefined;
  const policyRaw = raw['policy'];
  const billingRaw = raw['billing'];
  const tokenPricesRaw = isRecord(billingRaw)
    ? billingRaw['token_prices']
    : undefined;
  const defaultPricesRaw = isRecord(tokenPricesRaw)
    ? tokenPricesRaw['default']
    : undefined;

  const limits = isRecord(limitsRaw)
    ? {
        max_context_window_tokens: pickNumber(
          limitsRaw,
          'max_context_window_tokens',
        ),
        max_output_tokens: pickNumber(limitsRaw, 'max_output_tokens'),
        max_prompt_tokens: pickNumber(limitsRaw, 'max_prompt_tokens'),
        ...(isRecord(visionRaw)
          ? {
              vision: {
                max_prompt_image_size:
                  pickNumber(visionRaw, 'max_prompt_image_size') ?? 0,
                max_prompt_images:
                  pickNumber(visionRaw, 'max_prompt_images') ?? 0,
                supported_media_types:
                  pickStringArray(visionRaw, 'supported_media_types') ?? [],
              },
            }
          : {}),
      }
    : undefined;

  return {
    model_picker_enabled: modelPickerEnabled,
    id,
    name,
    version,
    supported_endpoints: pickStringArray(raw, 'supported_endpoints'),
    ...(isRecord(policyRaw)
      ? { policy: { state: pickString(policyRaw, 'state') } }
      : {}),
    ...(isRecord(tokenPricesRaw) && isRecord(defaultPricesRaw)
      ? {
          billing: {
            token_prices: {
              batch_size: pickNumber(tokenPricesRaw, 'batch_size') ?? 1,
              default: {
                cache_price: pickNumber(defaultPricesRaw, 'cache_price') ?? 0,
                input_price: pickNumber(defaultPricesRaw, 'input_price') ?? 0,
                output_price: pickNumber(defaultPricesRaw, 'output_price') ?? 0,
              },
            },
          },
        }
      : {}),
    capabilities: {
      family: pickString(capabilitiesRaw, 'family') ?? id,
      ...(limits ? { limits } : {}),
      supports: {
        adaptive_thinking: pickBoolean(supportsRaw, 'adaptive_thinking'),
        max_thinking_budget: pickNumber(supportsRaw, 'max_thinking_budget'),
        min_thinking_budget: pickNumber(supportsRaw, 'min_thinking_budget'),
        reasoning_effort: pickStringArray(supportsRaw, 'reasoning_effort'),
        streaming: pickBoolean(supportsRaw, 'streaming'),
        structured_outputs: pickBoolean(supportsRaw, 'structured_outputs'),
        tool_calls: pickBoolean(supportsRaw, 'tool_calls'),
        vision: pickBoolean(supportsRaw, 'vision'),
      },
    },
  };
}

function isUsableCopilotModel(item: CopilotModelApiItem): boolean {
  return (
    item.policy?.state !== 'disabled' &&
    item.capabilities.limits?.max_output_tokens !== undefined &&
    item.capabilities.limits.max_prompt_tokens !== undefined &&
    item.capabilities.supports.tool_calls !== undefined
  );
}

function normalizeThinkingEffort(value: string): ThinkingEffort | undefined {
  switch (value) {
    case 'max':
    case 'none':
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return value;
    default:
      return undefined;
  }
}

function normalizeCopilotReasoningEfforts(
  values: readonly string[] | undefined,
): ThinkingEffort[] {
  return (
    values
      ?.map(normalizeThinkingEffort)
      .filter((value): value is ThinkingEffort => value !== undefined) ?? []
  );
}

function resolveCopilotEndpoint(item: CopilotModelApiItem): CopilotEndpoint {
  if (item.supported_endpoints?.includes('/v1/messages')) {
    return 'messages';
  }
  return shouldUseResponsesApi(item.id) ? 'responses' : 'chat';
}

function createCopilotPresetTemplates(
  item: CopilotModelApiItem,
  endpoint: CopilotEndpoint,
): ModelConfig['presetTemplates'] {
  const efforts = normalizeCopilotReasoningEfforts(
    item.capabilities.supports.reasoning_effort,
  );
  if (efforts.length === 0) {
    return undefined;
  }

  return [
    endpoint === 'messages' && item.capabilities.supports.adaptive_thinking
      ? adaptiveReasoningEffort({
          default: efforts.includes('medium') ? 'medium' : efforts[0],
          supported: efforts,
        })
      : reasoningEffort({
          default: efforts.includes('medium') ? 'medium' : efforts[0],
          supported: efforts,
        }),
  ];
}

function createCopilotThinkingConfig(
  item: CopilotModelApiItem,
  endpoint: CopilotEndpoint,
): ModelConfig['thinking'] {
  const efforts = normalizeCopilotReasoningEfforts(
    item.capabilities.supports.reasoning_effort,
  );
  if (efforts.length > 0) {
    return {
      type:
        endpoint === 'messages' && item.capabilities.supports.adaptive_thinking
          ? 'auto'
          : 'enabled',
      effort: efforts.includes('medium') ? 'medium' : efforts[0],
      summary: endpoint === 'messages' ? undefined : 'auto',
    };
  }

  const maxThinkingBudget = item.capabilities.supports.max_thinking_budget;
  if (endpoint === 'messages' && maxThinkingBudget !== undefined) {
    return {
      type: 'enabled',
      budgetTokens: Math.max(1, maxThinkingBudget - 1),
    };
  }

  return undefined;
}

function buildCopilotModelConfig(
  item: CopilotModelApiItem,
): ModelConfig | undefined {
  if (!isUsableCopilotModel(item)) {
    return undefined;
  }

  const endpoint = resolveCopilotEndpoint(item);
  const limits = item.capabilities.limits;
  const supports = item.capabilities.supports;
  const imageInput =
    (supports.vision ?? false) ||
    (limits?.vision?.supported_media_types ?? []).some((mediaType) =>
      mediaType.startsWith('image/'),
    );

  return {
    id: item.id,
    name: item.name,
    family: item.capabilities.family,
    maxInputTokens:
      limits?.max_context_window_tokens ?? limits?.max_prompt_tokens,
    maxOutputTokens: limits?.max_output_tokens,
    capabilities: {
      toolCalling: supports.tool_calls,
      imageInput,
    },
    stream: supports.streaming,
    thinking: createCopilotThinkingConfig(item, endpoint),
    presetTemplates: createCopilotPresetTemplates(item, endpoint),
  };
}

function stripCopilotOpenAiDefaults(
  extraBody: ProviderConfig['extraBody'],
): ProviderConfig['extraBody'] {
  if (!extraBody) {
    return undefined;
  }
  const { store: _store, ...rest } = extraBody;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function rememberCopilotEndpoints(
  providerName: string,
  items: readonly CopilotModelApiItem[],
): void {
  const endpoints = new Map<string, CopilotEndpoint>();
  for (const item of items) {
    endpoints.set(item.id, resolveCopilotEndpoint(item));
  }
  copilotEndpointCache.set(providerName, endpoints);
}

function resolveModelEndpoint(
  providerName: string,
  model: ModelConfig,
): CopilotEndpoint {
  const cached = copilotEndpointCache.get(providerName)?.get(model.id);
  if (cached) {
    return cached;
  }

  if (model.id.includes('claude')) {
    return 'messages';
  }
  return shouldUseResponsesApi(model.id) ? 'responses' : 'chat';
}

function normalizeModelForCopilotRequest(model: ModelConfig): ModelConfig {
  if (!getBaseModelId(model.id).includes('gpt')) {
    return model;
  }
  return { ...model, maxOutputTokens: undefined };
}

function shouldUseResponsesApi(modelId: string): boolean {
  const baseId = getBaseModelId(modelId);
  if (baseId.startsWith('gpt-5-mini')) {
    return false;
  }

  const match = /^gpt-(\d+)(?:[.-]|$)/.exec(baseId);
  if (!match) {
    return false;
  }

  const major = Number(match[1]);
  return Number.isFinite(major) && major >= 5;
}

type CopilotInitiator = 'user' | 'agent';

function normalizeCopilotToolCallIndices(
  chunk: ChatCompletionChunk,
): ChatCompletionChunk {
  let changed = false;

  const choices = chunk.choices.map((choice) => {
    const delta = choice.delta;
    const toolCalls = delta?.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      return choice;
    }

    const indices = toolCalls
      .map((call) => call.index)
      .filter((n): n is number => typeof n === 'number' && Number.isFinite(n));

    if (indices.length === 0) {
      return choice;
    }

    // Copilot streams tool_calls with 1-based indices (starting from 1), and may emit
    // chunks that only contain higher indices (e.g. index=2/3) without repeating index=1.
    // Normalize to 0-based indices so downstream accumulation doesn't produce sparse arrays.
    //
    // Heuristic: if we ever see index=0, assume it's already 0-based and do nothing.
    const hasZero = indices.includes(0);
    if (hasZero) {
      return choice;
    }

    changed = true;

    const normalizedToolCalls = toolCalls.map((call) => ({
      ...call,
      index: call.index > 0 ? call.index - 1 : call.index,
    }));

    return {
      ...choice,
      delta: {
        ...delta,
        tool_calls: normalizedToolCalls,
      },
    };
  });

  return changed ? { ...chunk, choices } : chunk;
}

function isToolResultPart(
  part: unknown,
): part is
  | vscode.LanguageModelToolResultPart
  | vscode.LanguageModelToolResultPart2 {
  return (
    part instanceof vscode.LanguageModelToolResultPart ||
    part instanceof vscode.LanguageModelToolResultPart2
  );
}

function containsImagePart(part: unknown): boolean {
  if (part instanceof vscode.LanguageModelDataPart) {
    return isImageMarker(part);
  }

  if (isToolResultPart(part)) {
    return part.content.some(containsImagePart);
  }

  return false;
}

function hasVisionRequest(
  messages: readonly LanguageModelChatRequestMessage[],
): boolean {
  for (const message of messages) {
    if (message.content.some(containsImagePart)) {
      return true;
    }
  }
  return false;
}

function inferInitiator(
  messages: readonly LanguageModelChatRequestMessage[],
): CopilotInitiator {
  const last = messages.at(-1);
  if (!last) {
    return 'user';
  }

  if (last.role === vscode.LanguageModelChatMessageRole.Assistant) {
    return 'agent';
  }

  if (last.role === vscode.LanguageModelChatMessageRole.User) {
    const hasToolResult = last.content.some(isToolResultPart);
    return hasToolResult ? 'agent' : 'user';
  }

  return 'user';
}

function applyCopilotHeaders(options: {
  headers: Record<string, string | null>;
  credential?: AuthTokenInfo;
  messages?: readonly LanguageModelChatRequestMessage[];
  sessionId?: string;
}): void {
  const headers = options.headers;

  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    if (
      lower === 'x-api-key' ||
      lower === 'authorization' ||
      lower === 'user-agent'
    ) {
      delete headers[key];
    }
  }

  const token =
    options.credential?.kind === 'token' ? options.credential.token : undefined;
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  headers['User-Agent'] = buildOpencodeUserAgent();
  headers['Openai-Intent'] = 'conversation-edits';
  headers['X-GitHub-Api-Version'] = COPILOT_API_VERSION;
  headers['Copilot-Integration-Id'] = 'vscode-chat';

  if (options.sessionId) {
    headers['vscode-sessionid'] = options.sessionId;
  }

  if (options.messages) {
    headers['x-initiator'] = inferInitiator(options.messages);

    if (hasVisionRequest(options.messages)) {
      headers['Copilot-Vision-Request'] = 'true';
    }
  }
}

class GitHubCopilotChatCompletionProvider extends OpenAIChatCompletionProvider {
  protected override resolveBaseUrl(config: ProviderConfig): string {
    return resolveCopilotOpenAiBaseUrl(config);
  }

  override accumulateChatCompletion(
    snapshot: ChatCompletionSnapshot | undefined,
    chunk: ChatCompletionChunk,
  ): ChatCompletionSnapshot {
    return super.accumulateChatCompletion(
      snapshot,
      normalizeCopilotToolCallIndices(chunk),
    );
  }

  protected override buildHeaders(
    credential?: AuthTokenInfo,
    modelConfig?: ModelConfig,
    messages?: readonly LanguageModelChatRequestMessage[],
  ): Record<string, string> {
    const headers = super.buildHeaders(credential, modelConfig, messages);
    applyCopilotHeaders({ headers, credential, messages });
    return headers;
  }
}

class GitHubCopilotResponsesProvider extends OpenAIResponsesProvider {
  protected override resolveBaseUrl(config: ProviderConfig): string {
    return resolveCopilotOpenAiBaseUrl(config);
  }

  protected override buildHeaders(
    sessionId: string,
    credential?: AuthTokenInfo,
    modelConfig?: ModelConfig,
    messages?: readonly LanguageModelChatRequestMessage[],
  ): Record<string, string> {
    const headers = super.buildHeaders(
      sessionId,
      credential,
      modelConfig,
      messages,
    );
    applyCopilotHeaders({ headers, credential, messages, sessionId });
    return headers;
  }
}

class GitHubCopilotMessagesProvider extends AnthropicProvider {
  protected override shouldEnableFineGrainedToolStreaming(_options: {
    model: ModelConfig;
    stream: boolean;
    toolCount: number;
  }): boolean {
    return false;
  }

  protected override buildHeaders(
    credential?: AuthTokenInfo,
    modelConfig?: ModelConfig,
    options?: {
      stream?: boolean;
      messages?: readonly LanguageModelChatRequestMessage[];
    },
  ): Record<string, string | null> {
    const headers = super.buildHeaders(credential, modelConfig, options);
    applyCopilotHeaders({ headers, credential, messages: options?.messages });
    headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14';
    return headers;
  }
}

export class GitHubCopilotProvider implements ApiProvider {
  private readonly providerConfig: ProviderConfig;
  private readonly chatProvider: GitHubCopilotChatCompletionProvider;
  private readonly responsesProvider: GitHubCopilotResponsesProvider;
  private readonly messagesProvider: GitHubCopilotMessagesProvider;

  private assertCopilotAuth(): void {
    if (this.providerConfig.auth?.method !== 'github-copilot') {
      throw new Error(
        'GitHub Copilot provider requires auth method "github-copilot".',
      );
    }
  }

  constructor(config: ProviderConfig) {
    const extraBody = config.extraBody ?? {};
    const hasStore = Object.prototype.hasOwnProperty.call(extraBody, 'store');
    const configWithDefaults: ProviderConfig = hasStore
      ? {
          ...config,
          contextCache: config.contextCache ?? { type: 'allow-paid' },
        }
      : {
          ...config,
          contextCache: config.contextCache ?? { type: 'allow-paid' },
          extraBody: { ...extraBody, store: false },
        };
    this.providerConfig = configWithDefaults;

    this.chatProvider = new GitHubCopilotChatCompletionProvider(
      configWithDefaults,
    );
    this.responsesProvider = new GitHubCopilotResponsesProvider(
      configWithDefaults,
    );
    this.messagesProvider = new GitHubCopilotMessagesProvider({
      ...configWithDefaults,
      baseUrl: resolveCopilotMessagesBaseUrl(configWithDefaults),
      extraBody: stripCopilotOpenAiDefaults(configWithDefaults.extraBody),
    });
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
  ): AsyncGenerator<LanguageModelResponsePart2> {
    this.assertCopilotAuth();
    const endpoint = resolveModelEndpoint(this.providerConfig.name, model);
    const provider =
      endpoint === 'messages'
        ? this.messagesProvider
        : endpoint === 'responses'
          ? this.responsesProvider
          : this.chatProvider;
    const requestModel =
      endpoint === 'messages' ? model : normalizeModelForCopilotRequest(model);

    yield* provider.streamChat(
      encodedModelId,
      requestModel,
      messages,
      options,
      requestTrace,
      token,
      logger,
      credential,
    );
  }

  estimateTokenCount(text: string): number {
    return this.chatProvider.estimateTokenCount(text);
  }

  async getAvailableModels(credential: AuthTokenInfo): Promise<ModelConfig[]> {
    this.assertCopilotAuth();
    const logger = createSimpleHttpLogger({
      purpose: 'Get Available Models',
      providerName: this.providerConfig.name,
      providerType: this.providerConfig.type,
    });
    const chatNetwork = resolveChatNetwork(this.providerConfig);
    const effectiveTimeout =
      chatNetwork.timeout ?? DEFAULT_NORMAL_TIMEOUT_CONFIG;
    const fetchWithNetwork = createCustomFetch({
      connectionTimeoutMs: effectiveTimeout.connection,
      responseTimeoutMs: effectiveTimeout.response,
      logger,
      retryConfig: chatNetwork.retry,
      proxy: chatNetwork.proxy,
      type: 'normal',
    });
    const token = getToken(credential);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': buildOpencodeUserAgent(),
      'X-GitHub-Api-Version': COPILOT_API_VERSION,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };

    try {
      const response = await fetchWithNetwork(
        `${resolveCopilotApiBaseUrl(this.providerConfig)}/models`,
        { headers },
      );
      if (!response.ok) {
        throw new Error(
          `Failed to get available models: HTTP ${response.status}`,
        );
      }

      const raw: unknown = await response.json();
      if (!isRecord(raw) || !Array.isArray(raw['data'])) {
        throw new Error('Failed to get available models: unexpected response');
      }

      const items = raw['data']
        .map(parseCopilotModelApiItem)
        .filter((item): item is CopilotModelApiItem => item !== undefined)
        .filter((item) => item.model_picker_enabled);
      rememberCopilotEndpoints(this.providerConfig.name, items);

      return items
        .map(buildCopilotModelConfig)
        .filter((model): model is ModelConfig => model !== undefined);
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }
}
