import { getBaseModelId } from '../model-id-utils';
import { AnthropicProvider } from './anthropic/client';
import { GoogleAIStudioProvider } from './google/client';
import { ProviderDefinition } from './interface';
import { OllamaProvider } from './ollama/client';
import { OpenAIChatCompletionProvider } from './openai/chat-completion-client';
import { OpenAIResponsesProvider } from './openai/responses-client';
import { Feature } from './types';
import { matchProvider, matchModelFamily } from './utils';

export type ProviderType =
  | 'anthropic'
  | 'google-ai-studio'
  | 'openai-chat-completion'
  | 'openai-responses'
  | 'ollama';

export const PROVIDER_TYPES: Record<ProviderType, ProviderDefinition> = {
  anthropic: {
    type: 'anthropic',
    label: 'Anthropic Messages API',
    description: '/v1/messages',
    supportMimics: ['claude-code'],
    class: AnthropicProvider,
  },
  'google-ai-studio': {
    type: 'google-ai-studio',
    label: 'Google AI Studio (Gemini API)',
    description: '/v1beta/models:generateContent',
    supportMimics: [],
    class: GoogleAIStudioProvider,
  },
  'openai-chat-completion': {
    type: 'openai-chat-completion',
    label: 'OpenAI Chat Completion API',
    description: '/v1/chat/completions',
    supportMimics: [],
    class: OpenAIChatCompletionProvider,
  },
  'openai-responses': {
    type: 'openai-responses',
    label: 'OpenAI Responses API',
    description: '/v1/responses',
    supportMimics: [],
    class: OpenAIResponsesProvider,
  },
  ollama: {
    type: 'ollama',
    label: 'Ollama Chat API',
    description: '/api/chat',
    supportMimics: [],
    class: OllamaProvider,
  },
};

/**
 * Valid provider types
 */
export const PROVIDER_KEYS = Object.keys(PROVIDER_TYPES) as ProviderType[];

/**
 * Provider mimic options
 */
export type Mimic = 'claude-code';

export const MIMIC_LABELS: Record<Mimic, string> = {
  'claude-code': 'Claude Code',
};

export enum FeatureId {
  /**
   * @see https://www.volcengine.com/docs/82379/1569618?lang=zh
   */
  AutoThinking = 'auto-thinking',
  /**
   * Only sends the thought content after the user's last message.
   * @see https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
   * @see https://platform.claude.com/docs/en/build-with-claude/extended-thinking
   */
  ConciseReasoning = 'concise-reasoning',
  /**
   * @see https://platform.claude.com/docs/en/build-with-claude/extended-thinking#interleaved-thinking
   */
  AnthropicInterleavedThinking = 'anthropic_interleaved-thinking',
  /**
   * @see https://docs.anthropic.com/en/docs/build-with-claude/tool-use/web-search-tool
   */
  AnthropicWebSearch = 'anthropic_web-search',
  /**
   * @see https://docs.anthropic.com/en/docs/build-with-claude/tool-use/memory-tool
   */
  AnthropicMemoryTool = 'anthropic_memory-tool',
  /**
   * Fine-grained tool streaming for tool_use parameters.
   *
   * @see https://docs.anthropic.com/en/docs/build-with-claude/tool-use
   */
  AnthropicFineGrainedToolStreaming = 'anthropic_fine-grained-tool-streaming',
  /**
   * @see https://community.openai.com/t/developer-role-not-accepted-for-o1-o1-mini-o3-mini/1110750/7
   */
  OpenAIOnlyMaxCompletionTokens = 'openai_only-max-completion-tokens',
  /**
   * Some OpenAI-compatible providers only accept `max_tokens` and will reject `max_completion_tokens`.
   */
  OpenAIOnlyMaxTokens = 'openai_only-max-tokens',
  /**
   * @see https://openrouter.ai/docs/guides/best-practices/prompt-caching
   */
  OpenAICacheControl = 'openai_cache-control',
  /**
   * @see https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
   */
  OpenAIUseReasoningParam = 'openai_use-reasoning-param',
  /**
   * @see https://platform.xiaomimimo.com/#/docs/api/text-generation/openai-api
   * @see https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
   */
  OpenAIUseThinkingParam = 'openai_use-thinking-param',
  /**
   * Using both the unofficial `thinking` and the `reasoning` fields in the OpenAI Responses API.
   *
   * @see https://www.volcengine.com/docs/82379/1569618?lang=zh
   */
  OpenAIUseThinkingParam2 = 'openai_use-thinking-param-2',
  /**
   * Use `top_k` parameter in OpenAI-compatible Chat Completion APIs.
   *
   * @see https://modelstudio.console.alibabacloud.com/?tab=api#/api/?type=model&url=2712576
   */
  OpenAIUseTopK = 'openai_use-top-k',
  /**
   * Use `max_input_tokens` parameter in OpenAI-compatible Chat Completion APIs.
   *
   * @see https://modelstudio.console.alibabacloud.com/?tab=api#/api/?type=model&url=2712576
   */
  OpenAIUseMaxInputTokens = 'openai_use-max-input-tokens',
  /**
   * Use `enable_thinking` parameter in OpenAI-compatible Chat Completion APIs.
   *
   * @see https://modelstudio.console.alibabacloud.com/?tab=api#/api/?type=model&url=2712576
   */
  OpenAIUseThinkingParam3 = 'openai_use-thinking-param-3',
  /**
   * Use `thinking_budget` parameter in OpenAI-compatible Chat Completion APIs.
   *
   * @see https://modelstudio.console.alibabacloud.com/?tab=api#/api/?type=model&url=2712576
   */
  OpenAIUseThinkingBudgetParam = 'openai_use-thinking-budget-param',
  /**
   * Thinking reasoning content to be included in the response.
   *
   * @see https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
   * @see https://platform.moonshot.cn/docs/guide/use-kimi-k2-thinking-model
   * @see https://docs.bigmodel.cn/cn/guide/develop/openai/introduction
   */
  OpenAIUseReasoningContent = 'openai_use-reasoning-content',
  /**
   * Structured reasoning blocks.
   *
   * @see https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#preserving-reasoning-blocks
   */
  OpenAIUseReasoningDetails = 'openai_use-reasoning-details',
  /**
   * @see https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode
   */
  OpenAIUseClearThinking = 'openai_use-clear-thinking',
  /**
   * @see https://ai.google.dev/gemini-api/docs/thinking?hl=zh-cn#levels-budgets
   */
  GeminiUseThinkingLevel = 'gemini_use-thinking-level',
}

export const FEATURES: Record<FeatureId, Feature> = {
  [FeatureId.AutoThinking]: {
    supportedProviders: [
      'ark.cn-beijing.volces.com',
      'ark.ap-southeast.bytepluses.com',
    ],
  },
  [FeatureId.ConciseReasoning]: {
    supportedFamilys: ['deepseek-reasoner'],
  },
  [FeatureId.AnthropicInterleavedThinking]: {
    supportedFamilys: [
      'claude-sonnet-4-5',
      'claude-sonnet-4.5',
      'claude-sonnet-4',
      'claude-opus-4-5',
      'claude-opus-4.5',
      'claude-opus-4-1',
      'claude-opus-4.1',
      'claude-opus-4',
    ],
  },
  [FeatureId.AnthropicWebSearch]: {
    supportedFamilys: [
      'claude-sonnet-4-5',
      'claude-sonnet-4.5',
      'claude-sonnet-4',
      'claude-3-7-sonnet',
      'claude-3.7-sonnet',
      'claude-haiku-4-5',
      'claude-haiku-4.5',
      'claude-3-5-haiku',
      'claude-3.5-haiku',
      'claude-opus-4-5',
      'claude-opus-4.5',
      'claude-opus-4-1',
      'claude-opus-4.1',
      'claude-opus-4',
    ],
  },
  [FeatureId.AnthropicMemoryTool]: {
    supportedFamilys: [
      'claude-sonnet-4-5',
      'claude-sonnet-4.5',
      'claude-opus-4-5',
      'claude-opus-4.5',
      'claude-opus-4-1',
      'claude-opus-4.1',
      'claude-opus-4',
    ],
  },
  [FeatureId.AnthropicFineGrainedToolStreaming]: {
    supportedFamilys: ['claude-'],
  },
  [FeatureId.OpenAIOnlyMaxCompletionTokens]: {
    supportedFamilys: [
      'codex-mini-latest',
      'gpt-5.1',
      'gpt-5.1-codex',
      'gpt-5.1-codex-max',
      'gpt-5.1-codex-mini',
      'gpt-5',
      'gpt-5-codex',
      'gpt-5-mini',
      'gpt-5-nano',
      'gpt-5-pro',
      'o1',
      'o1-mini',
      'o1-preview',
      'o1-pro',
      'o3',
      'o3-deep-research',
      'o3-mini',
      'o3-pro',
      'o4-mini',
      'o4-mini-deep-research',
      'gpt-oss-120b',
      'gpt-oss-20b',
      'mimo-',
    ],
  },
  [FeatureId.OpenAIOnlyMaxTokens]: {
    supportedProviders: ['router.huggingface.co'],
  },
  [FeatureId.OpenAICacheControl]: {
    customCheckers: [
      // Checker for OpenRouter Claude models:
      (model, provider) =>
        matchProvider(provider.baseUrl, 'openrouter.ai') &&
        matchModelFamily(model.family ?? getBaseModelId(model.id), [
          'claude-sonnet-4-5',
          'claude-sonnet-4.5',
          'claude-sonnet-4',
          'claude-3-7-sonnet',
          'claude-3.7-sonnet',
          'claude-haiku-4-5',
          'claude-haiku-4.5',
          'claude-3-5-haiku',
          'claude-3.5-haiku',
          'claude-3-haiku',
          'claude-opus-4-5',
          'claude-opus-4.5',
          'claude-opus-4-1',
          'claude-opus-4.1',
          'claude-opus-4',
        ]),
    ],
  },
  [FeatureId.OpenAIUseReasoningParam]: {
    supportedProviders: ['openrouter.ai'],
  },
  [FeatureId.OpenAIUseReasoningDetails]: {
    supportedProviders: ['openrouter.ai', 'api.minimaxi.com', 'api.minimax.io'],
  },
  [FeatureId.OpenAIUseThinkingParam]: {
    supportedProviders: [
      'api.deepseek.com',
      'api.xiaomimimo.com',
      'open.bigmodel.cn',
      'api.z.ai',
    ],
  },
  [FeatureId.OpenAIUseThinkingParam2]: {
    supportedProviders: [
      'ark.cn-beijing.volces.com',
      'ark.ap-southeast.bytepluses.com',
    ],
  },
  [FeatureId.OpenAIUseTopK]: {
    supportedProviders: [
      'dashscope.aliyuncs.com',
      'dashscope-intl.aliyuncs.com',
      'api-inference.modelscope.cn',
    ],
  },
  [FeatureId.OpenAIUseMaxInputTokens]: {
    supportedProviders: [
      'dashscope.aliyuncs.com',
      'dashscope-intl.aliyuncs.com',
      'api-inference.modelscope.cn',
    ],
  },
  [FeatureId.OpenAIUseThinkingParam3]: {
    supportedProviders: [
      'dashscope.aliyuncs.com',
      'dashscope-intl.aliyuncs.com',
      'api-inference.modelscope.cn',
    ],
  },
  [FeatureId.OpenAIUseThinkingBudgetParam]: {
    supportedProviders: [
      'dashscope-intl.aliyuncs.com',
      'dashscope-intl.aliyuncs.com',
      'api-inference.modelscope.cn',
    ],
  },
  [FeatureId.OpenAIUseReasoningContent]: {
    supportedProviders: [
      'api.deepseek.com',
      'api.xiaomimimo.com',
      'open.bigmodel.cn',
      'api.z.ai',
      'api.moonshot.cn',
      'api.moonshot.ai',
      'api.kimi.com',
      'dashscope-intl.aliyuncs.com',
      'dashscope-intl.aliyuncs.com',
      'api-inference.modelscope.cn',
    ],
  },
  [FeatureId.OpenAIUseClearThinking]: {
    supportedProviders: ['open.bigmodel.cn', 'api.z.ai'],
  },
  [FeatureId.GeminiUseThinkingLevel]: {
    supportedFamilys: ['gemini-3-'],
  },
};
