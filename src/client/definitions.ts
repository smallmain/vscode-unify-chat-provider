import { getBaseModelId } from '../model-id-utils';
import { t } from '../i18n';
import { AnthropicProvider } from './anthropic/client';
import { AnthropicClaudeCodeCloakProvider } from './anthropic/claude-code-cloak-client';
import { GoogleAIStudioProvider } from './google/ai-studio-client';
import { GoogleAntigravityProvider } from './google/antigravity-client';
import { GoogleGeminiCLIProvider } from './google/gemini-cli-client';
import { VertexAIProvider } from './google/vertex-ai-client';
import { ProviderDefinition } from './interface';
import { GitHubCopilotProvider } from './github-copilot/client';
import { OllamaProvider } from './ollama/client';
import { OpenAIChatCompletionProvider } from './openai/chat-completion-client';
import { OpenAICodeXProvider } from './openai/codex-client';
import { OpenAIResponsesProvider } from './openai/responses-client';
import { QwenCodeProvider } from './qwen/qwen-code-client';
import { Feature } from './types';
import { matchProvider, matchModelFamily } from './utils';

export type ProviderType =
  | 'anthropic'
  | 'claude-code-cloak'
  | 'google-ai-studio'
  | 'google-vertex-ai'
  | 'google-antigravity'
  | 'google-gemini-cli'
  | 'github-copilot'
  | 'openai-chat-completion'
  | 'qwen-code'
  | 'openai-codex'
  | 'openai-responses'
  | 'ollama';

export const PROVIDER_TYPES: Record<ProviderType, ProviderDefinition> = {
  anthropic: {
    type: 'anthropic',
    label: t('Anthropic Messages API'),
    description: '/v1/messages',
    class: AnthropicProvider,
  },
  'claude-code-cloak': {
    type: 'claude-code-cloak',
    label: t('Anthropic Claude Code Cloak'),
    description: '/v1/messages',
    class: AnthropicClaudeCodeCloakProvider,
  },
  'google-ai-studio': {
    type: 'google-ai-studio',
    label: t('Google AI Studio (Gemini API)'),
    description: '/v1beta/models:generateContent',
    class: GoogleAIStudioProvider,
  },
  'google-vertex-ai': {
    type: 'google-vertex-ai',
    label: t('Google Vertex AI'),
    description: '/v1beta1/models:generateContent',
    class: VertexAIProvider,
  },
  'google-antigravity': {
    type: 'google-antigravity',
    label: t('Google Antigravity'),
    description: '/v1internal:generateContent',
    class: GoogleAntigravityProvider,
  },
  'google-gemini-cli': {
    type: 'google-gemini-cli',
    label: t('Google Gemini CLI'),
    description: '/v1internal:generateContent',
    class: GoogleGeminiCLIProvider,
  },
  'github-copilot': {
    type: 'github-copilot',
    label: t('GitHub Copilot'),
    description: '/chat/completions, /responses',
    class: GitHubCopilotProvider,
  },
  'openai-chat-completion': {
    type: 'openai-chat-completion',
    label: t('OpenAI Chat Completion API'),
    description: '/v1/chat/completions',
    class: OpenAIChatCompletionProvider,
  },
  'qwen-code': {
    type: 'qwen-code',
    label: t('Qwen Code'),
    description: '/v1/chat/completions',
    class: QwenCodeProvider,
  },
  'openai-codex': {
    type: 'openai-codex',
    label: t('OpenAI CodeX'),
    description: '/backend-api/codex/responses',
    class: OpenAICodeXProvider,
  },
  'openai-responses': {
    type: 'openai-responses',
    label: t('OpenAI Responses API'),
    description: '/v1/responses',
    class: OpenAIResponsesProvider,
  },
  ollama: {
    type: 'ollama',
    label: t('Ollama Chat API'),
    description: '/api/chat',
    class: OllamaProvider,
  },
};

/**
 * Valid provider types
 */
export const PROVIDER_KEYS = Object.keys(PROVIDER_TYPES) as ProviderType[];

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
   * Strip `include` from OpenAI Responses API requests.
   *
   * @see https://www.volcengine.com/docs/82379/1569618?lang=zh
   */
  OpenAIStripIncludeParam = 'openai_strip-include-param',
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
   * Some OpenAI-compatible providers return reasoning text in the `reasoning` field.
   *
   * @see https://inference-docs.cerebras.ai/capabilities/reasoning
   */
  OpenAIUseReasoningField = 'openai_use-reasoning-field',
  /**
   * Use `disable_reasoning` parameter in OpenAI-compatible Chat Completion APIs.
   *
   * Some providers implement GLM-style reasoning toggles via a boolean field instead
   * of OpenAI's `reasoning_effort`.
   *
   * @see https://inference-docs.cerebras.ai/capabilities/reasoning
   */
  OpenAIUseDisableReasoningParam = 'openai_use-disable-reasoning-param',
  /**
   * @see https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode
   */
  OpenAIUseClearThinking = 'openai_use-clear-thinking',
  /**
   * Use `reasoning_split` parameter in OpenAI-compatible Chat Completion APIs.
   */
  OpenAIUseReasoningSplitParam = 'openai_use-reasoning-split-param',
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
    supportedProviders: ['api.cerebras.ai'],
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
    supportedProviders: ['router.huggingface.co', 'portal.qwen.ai'],
  },
  [FeatureId.OpenAICacheControl]: {
    customCheckers: [
      // Checker for OpenRouter Claude models:
      (model, provider) =>
        matchProvider(provider.baseUrl, 'openrouter.ai') &&
        matchModelFamily(model.family ?? getBaseModelId(model.id), ['claude-']),
    ],
  },
  [FeatureId.OpenAIUseReasoningParam]: {
    supportedProviders: ['openrouter.ai'],
  },
  [FeatureId.OpenAIUseReasoningDetails]: {
    supportedProviders: ['openrouter.ai', 'api.minimaxi.com', 'api.minimax.io'],
  },
  [FeatureId.OpenAIUseReasoningField]: {
    supportedProviders: ['api.cerebras.ai'],
  },
  [FeatureId.OpenAIUseDisableReasoningParam]: {
    customCheckers: [
      // Checker for Cerebras GLM 4.7 model:
      (model, provider) =>
        matchProvider(provider.baseUrl, 'api.cerebras.ai') &&
        matchModelFamily(model.family ?? getBaseModelId(model.id), [
          'zai-glm-4.7',
        ]),
    ],
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
  [FeatureId.OpenAIStripIncludeParam]: {
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
    customCheckers: [
      (model, provider) =>
        matchProvider(provider.baseUrl, 'apis.iflow.cn') &&
        matchModelFamily(model.family ?? getBaseModelId(model.id), ['glm-']),
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
    customCheckers: [
      // Checker for Cerebras GLM 4.7 model:
      (model, provider) =>
        matchProvider(provider.baseUrl, 'api.cerebras.ai') &&
        matchModelFamily(model.family ?? getBaseModelId(model.id), [
          'zai-glm-4.7',
        ]),
      // Checker for iFlow GLM 4.7 model:
      (model, provider) =>
        matchProvider(provider.baseUrl, 'apis.iflow.cn') &&
        matchModelFamily(model.family ?? getBaseModelId(model.id), ['glm-4.7']),
    ],
  },
  [FeatureId.OpenAIUseReasoningSplitParam]: {
    customCheckers: [
      (model, provider) =>
        matchProvider(provider.baseUrl, 'apis.iflow.cn') &&
        matchModelFamily(model.family ?? getBaseModelId(model.id), [
          'minimax-',
        ]),
    ],
  },
  [FeatureId.GeminiUseThinkingLevel]: {
    supportedFamilys: ['gemini-3-'],
  },
};
