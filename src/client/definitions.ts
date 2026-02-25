import { getBaseModelId } from '../model-id-utils';
import { t } from '../i18n';
import { AnthropicProvider } from './anthropic/client';
import { AnthropicClaudeCodeProvider } from './anthropic/claude-code-client';
import { GoogleAIStudioProvider } from './google/ai-studio-client';
import { GoogleAntigravityProvider } from './google/antigravity-client';
import { GoogleGeminiCLIProvider } from './google/gemini-cli-client';
import { VertexAIProvider } from './google/vertex-ai-client';
import { ProviderDefinition } from './interface';
import { GitHubCopilotProvider } from './github-copilot/client';
import { IFlowCLIProvider } from './iflow/client';
import { OllamaProvider } from './ollama/client';
import { OpenAIChatCompletionProvider } from './openai/chat-completion-client';
import { OpenAICodexProvider } from './openai/codex-client';
import { OpenAIResponsesProvider } from './openai/responses-client';
import { QwenCodeProvider } from './qwen/qwen-code-client';
import { Feature } from './types';
import { matchProvider, matchModelFamily } from './utils';

export type ProviderType =
  | 'anthropic'
  | 'claude-code'
  | 'google-ai-studio'
  | 'google-vertex-ai'
  | 'google-antigravity'
  | 'google-gemini-cli'
  | 'github-copilot'
  | 'openai-chat-completion'
  | 'iflow-cli'
  | 'qwen-code'
  | 'openai-codex'
  | 'openai-responses'
  | 'ollama';

export const PROVIDER_TYPES: Record<ProviderType, ProviderDefinition> = {
  anthropic: {
    type: 'anthropic',
    label: t('Anthropic Messages API'),
    description: '/v1/messages',
    category: 'General',
    class: AnthropicProvider,
  },
  'google-ai-studio': {
    type: 'google-ai-studio',
    label: t('Google AI Studio (Gemini API)'),
    description: '/v1beta/models:generateContent',
    category: 'General',
    class: GoogleAIStudioProvider,
  },
  'google-vertex-ai': {
    type: 'google-vertex-ai',
    label: t('Google Vertex AI'),
    description: '/v1beta1/models:generateContent',
    category: 'General',
    class: VertexAIProvider,
  },
  'openai-chat-completion': {
    type: 'openai-chat-completion',
    label: t('OpenAI Chat Completion API'),
    description: '/v1/chat/completions',
    category: 'General',
    class: OpenAIChatCompletionProvider,
  },
  'openai-responses': {
    type: 'openai-responses',
    label: t('OpenAI Responses API'),
    description: '/v1/responses',
    category: 'General',
    class: OpenAIResponsesProvider,
  },
  ollama: {
    type: 'ollama',
    label: t('Ollama Chat API'),
    description: '/api/chat',
    category: 'General',
    class: OllamaProvider,
  },
  'claude-code': {
    type: 'claude-code',
    label: t('Anthropic Claude Code'),
    description: '/v1/messages',
    category: 'Experimental',
    class: AnthropicClaudeCodeProvider,
  },
  'google-antigravity': {
    type: 'google-antigravity',
    label: t('Google Antigravity'),
    description: '/v1internal:generateContent',
    category: 'Experimental',
    class: GoogleAntigravityProvider,
  },
  'google-gemini-cli': {
    type: 'google-gemini-cli',
    label: t('Google Gemini CLI'),
    description: '/v1internal:generateContent',
    category: 'Experimental',
    class: GoogleGeminiCLIProvider,
  },
  'github-copilot': {
    type: 'github-copilot',
    label: t('GitHub Copilot'),
    description: '/chat/completions, /responses',
    category: 'Experimental',
    class: GitHubCopilotProvider,
  },
  'qwen-code': {
    type: 'qwen-code',
    label: t('Qwen Code'),
    description: '/v1/chat/completions',
    category: 'Experimental',
    class: QwenCodeProvider,
  },
  'openai-codex': {
    type: 'openai-codex',
    label: t('OpenAI Codex'),
    description: '/backend-api/codex/responses',
    category: 'Experimental',
    class: OpenAICodexProvider,
  },
  'iflow-cli': {
    type: 'iflow-cli',
    label: t('iFlow CLI'),
    description: '/v1/chat/completions',
    category: 'Experimental',
    class: IFlowCLIProvider,
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
   * Enable 1M output token context beta for supported Claude models.
   *
   * @see https://docs.anthropic.com/en/docs/about-claude/models
   */
  AnthropicContext1M = 'anthropic_context-1m',
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
   * @see https://www.volcengine.com/docs/82379/1569618?lang=zh
   */
  OpenAIUseThinkingParam = 'openai_use-thinking-param',
  /**
   * Use `reasoning_effort` parameter in OpenAI-compatible Chat Completion APIs.
   *
   * @see https://www.volcengine.com/docs/82379/1569618?lang=zh
   */
  OpenAIUseReasoningEffortParam = 'openai_use-reasoning-effort-param',
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
   * Enable VolcEngine / BytePlus context caching on OpenAI Responses API.
   */
  OpenAIUseVolcContextCaching = 'openai_use-volc-context-caching',
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
   * Use provider base URL as-is for OpenAI-compatible Chat Completion APIs.
   *
   * Useful for gateway-style endpoints whose base path is already fully routed.
   */
  OpenAIUseRawBaseUrl = 'openai_use-raw-base-url',
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
  [FeatureId.AnthropicContext1M]: {
    supportedFamilys: [
      'claude-opus-4-6',
      'claude-opus-4.6',
      'claude-sonnet-4-6',
      'claude-sonnet-4.6',
      'claude-sonnet-4-5',
      'claude-sonnet-4.5',
      'claude-sonnet-4',
    ],
  },
  [FeatureId.OpenAIOnlyMaxCompletionTokens]: {
    supportedProviders: ['api.cerebras.ai', 'opencode.ai'],
    supportedFamilys: [
      'codex-mini-latest',
      'gpt-5.2',
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
    supportedProviders: [
      'ark.cn-beijing.volces.com',
      'ark.ap-southeast.bytepluses.com',
      'router.huggingface.co',
      'portal.qwen.ai',
      'api.siliconflow.cn',
      'api.siliconflow.com',
      'api.stepfun.com',
      'api.stepfun.ai',
    ],
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
    supportedProviders: [
      'api.cerebras.ai',
      'api.stepfun.com',
      'api.stepfun.ai',
    ],
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
      'ark.cn-beijing.volces.com',
      'ark.ap-southeast.bytepluses.com',
      'api.deepseek.com',
      'api.xiaomimimo.com',
      'open.bigmodel.cn',
      'api.z.ai',
    ],
    customCheckers: [
      // Checker for iFlow enable_thinking models:
      (model, provider) => {
        if (!matchProvider(provider.baseUrl, 'apis.iflow.cn')) {
          return false;
        }
        const family = (model.family ?? getBaseModelId(model.id)).toLowerCase();
        return (
          family.startsWith('glm-') ||
          family === 'qwen3-max-preview' ||
          family === 'deepseek-v3.2' ||
          family === 'deepseek-v3.1'
        );
      },
      // Checker for Nvidia GLM models:
      (model, provider) =>
        matchProvider(provider.baseUrl, 'integrate.api.nvidia.com') &&
        matchModelFamily(model.family ?? getBaseModelId(model.id), [
          'z-ai/glm',
        ]),
    ],
  },
  [FeatureId.OpenAIUseThinkingParam2]: {
    supportedProviders: [
      'ark.cn-beijing.volces.com',
      'ark.ap-southeast.bytepluses.com',
    ],
  },
  [FeatureId.OpenAIUseReasoningEffortParam]: {
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
  [FeatureId.OpenAIUseVolcContextCaching]: {
    supportedProviders: [
      'ark.cn-beijing.volces.com/api/v3*',
      'ark.ap-southeast.bytepluses.com/api/v3*',
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
      'api.siliconflow.cn',
      'api.siliconflow.com',
      'api.longcat.chat',
    ],
  },
  [FeatureId.OpenAIUseThinkingBudgetParam]: {
    supportedProviders: [
      'dashscope-intl.aliyuncs.com',
      'dashscope-intl.aliyuncs.com',
      'api-inference.modelscope.cn',
      'api.siliconflow.cn',
      'api.siliconflow.com',
      'api.longcat.chat',
    ],
  },
  [FeatureId.OpenAIUseReasoningContent]: {
    supportedProviders: [
      'ark.cn-beijing.volces.com',
      'ark.ap-southeast.bytepluses.com',
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
      'api.siliconflow.cn',
      'api.siliconflow.com',
      'api.longcat.chat',
    ],
    customCheckers: [
      // Checker for iFlow enable_thinking models:
      (model, provider) => {
        if (!matchProvider(provider.baseUrl, 'apis.iflow.cn')) {
          return false;
        }
        const family = (model.family ?? getBaseModelId(model.id)).toLowerCase();
        return (
          family.startsWith('glm-') ||
          family === 'qwen3-max-preview' ||
          family === 'deepseek-v3.2' ||
          family === 'deepseek-v3.1'
        );
      },
      // Checker for Nvidia GLM models:
      (model, provider) =>
        matchProvider(provider.baseUrl, 'integrate.api.nvidia.com') &&
        matchModelFamily(model.family ?? getBaseModelId(model.id), [
          'z-ai/glm',
        ]),
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
      // Checker for iFlow GLM 4.7 / GLM 5 model:
      (model, provider) =>
        matchProvider(provider.baseUrl, 'apis.iflow.cn') &&
        matchModelFamily(model.family ?? getBaseModelId(model.id), [
          'glm-4.7',
          'glm-5',
        ]),
      // Checker for Nvidia GLM 4.7 model:
      (model, provider) =>
        matchProvider(provider.baseUrl, 'integrate.api.nvidia.com') &&
        matchModelFamily(model.family ?? getBaseModelId(model.id), [
          'z-ai/glm4.7',
        ]),
    ],
  },
  [FeatureId.OpenAIUseReasoningSplitParam]: {
    customCheckers: [
      // Checker for iFlow Minimax models:
      (model, provider) =>
        matchProvider(provider.baseUrl, 'apis.iflow.cn') &&
        matchModelFamily(model.family ?? getBaseModelId(model.id), [
          'minimax-',
        ]),
      // Checker for Nvidia Minimax models:
      (model, provider) =>
        matchProvider(provider.baseUrl, 'integrate.api.nvidia.com') &&
        matchModelFamily(model.family ?? getBaseModelId(model.id), [
          'minimaxai/minimax-',
        ]),
    ],
  },
  [FeatureId.OpenAIUseRawBaseUrl]: {
    supportedProviders: ['api.kilo.ai/api/gateway'],
  },
  [FeatureId.GeminiUseThinkingLevel]: {
    supportedFamilys: ['gemini-3-'],
  },
};
