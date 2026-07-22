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
import { OllamaProvider } from './ollama/client';
import { OpenAIChatCompletionProvider } from './openai/chat-completion-client';
import { OpenAICodexProvider } from './openai/codex-client';
import { OpenAIResponsesProvider } from './openai/responses-client';
import { XaiGrokBuildProvider } from './xai/grok-build-client';
import { ZedProvider } from './zed/provider';
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
  | 'zed'
  | 'openai-chat-completion'
  | 'openai-codex'
  | 'xai-grok-build'
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
  zed: {
    type: 'zed',
    label: t('Zed'),
    description: '/completions',
    category: 'Experimental',
    class: ZedProvider,
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
  'openai-codex': {
    type: 'openai-codex',
    label: t('OpenAI Codex'),
    description: '/backend-api/codex/responses',
    category: 'Experimental',
    class: OpenAICodexProvider,
  },
  'xai-grok-build': {
    type: 'xai-grok-build',
    label: t('xAI Grok Build'),
    description: '/v1/responses',
    category: 'Experimental',
    class: XaiGrokBuildProvider,
  },
};

/**
 * Valid provider types
 */
export const PROVIDER_KEYS = Object.keys(PROVIDER_TYPES) as ProviderType[];

function isBaiduQianfanModel(
  model: { id: string; family?: string },
  provider: { baseUrl: string },
  modelIds: readonly string[],
): boolean {
  if (!matchProvider(provider.baseUrl, 'qianfan.baidubce.com')) {
    return false;
  }

  const baseModelId = getBaseModelId(model.id).toLowerCase();
  return modelIds.some((modelId) => modelId.toLowerCase() === baseModelId);
}

function getModelFamily(model: { id: string; family?: string }): string {
  return model.family ?? getBaseModelId(model.id);
}

function modelFamilyIncludes(
  model: { id: string; family?: string },
  expected: string,
): boolean {
  return getModelFamily(model).toLowerCase().includes(expected.toLowerCase());
}

function modelIdentityIncludes(
  model: { id: string; family?: string },
  expected: string,
): boolean {
  const normalizedExpected = expected.toLowerCase();
  return [model.family, getBaseModelId(model.id)].some((value) =>
    value?.toLowerCase().includes(normalizedExpected),
  );
}

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
   * Adaptive thinking is always enabled and cannot be disabled.
   *
   * @see https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking
   */
  AnthropicAlwaysOnAdaptiveThinking = 'anthropic_always-on-adaptive-thinking',
  /**
   * The `xhigh` effort level is currently documented for Claude Opus 4.7.
   *
   * @see https://platform.claude.com/docs/en/build-with-claude/effort
   */
  AnthropicXHighEffort = 'anthropic_xhigh-effort',
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
   * Use OpenRouter Claude adaptive thinking with top-level `verbosity`.
   *
   * @see https://openrouter.ai/docs/cookbook/evaluate-and-optimize/model-migrations/claude-4-7
   */
  OpenRouterUseClaudeAdaptiveVerbosity = 'openrouter_use-claude-adaptive-verbosity',
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
   * Use GLM / DeepSeek V4 style `reasoning_effort` values (`high` / `max`) together
   * with the `thinking` parameter in OpenAI-compatible Chat Completion APIs.
   *
   * @see https://docs.bigmodel.cn/cn/guide/start/migrate-to-glm-new
   * @see https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
   * @see https://api-docs.deepseek.com/zh-cn/
   */
  OpenAIUseDeepSeekReasoningEffortParam = 'openai_use-deepseek-reasoning-effort-param',
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
   * Use `previous_response_id` continuation requests in the OpenAI Responses API.
   *
   * Many OpenAI-compatible providers expose a `/responses` endpoint before they
   * fully support response chaining, so this remains feature-gated.
   *
   * @see https://developers.openai.com/docs/guides/conversation-state
   */
  OpenAIUsePreviousResponseId = 'openai_use-previous-response-id',
  /**
   * Use Responses API remote context compaction.
   *
   * @see https://platform.openai.com/docs/guides/conversation-state#compaction-advanced
   */
  OpenAIUseResponsesContextManagement = 'openai_use-responses-context-management',
  /**
   * Use `prompt_cache_key` on Responses API requests for prompt cache routing.
   *
   * @see https://platform.openai.com/docs/guides/prompt-caching
   * @see https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits
   */
  OpenAIUsePromptCacheKey = 'openai_use-prompt-cache-key',
  /**
   * Use the standalone Responses `/responses/compact` endpoint before a large
   * follow-up request.
   *
   * @see https://developers.openai.com/api/docs/guides/compaction#standalone-compact-endpoint
   * @see https://developers.openai.com/api/reference/resources/responses/methods/compact/
   * @see https://docs.x.ai/developers/advanced-api-usage/context-compaction
   */
  OpenAIUseStandaloneResponsesCompaction = 'openai_use-standalone-responses-compaction',
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
   * Use `thinking_strategy` parameter in OpenAI-compatible Chat Completion APIs.
   *
   * @see https://cloud.baidu.com/doc/qianfan-docs/s/Wm95lyynv
   */
  OpenAIUseThinkingStrategyParam = 'openai_use-thinking-strategy-param',
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
  /**
   * Parse Mistral's structured `content` / `delta.content` chunk arrays
   * (`thinking` / `text`) instead of treating `content` as a plain string, and
   * preserve the original arrays for multi-turn replay.
   *
   * @see https://docs.mistral.ai/
   */
  MistralContentChunks = 'mistral_content-chunks',
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
      'claude-sonnet-5',
      'claude-opus-4-8',
      'claude-opus-4.8',
      'claude-opus-4-7',
      'claude-opus-4.7',
      'claude-opus-4-6',
      'claude-opus-4.6',
      'claude-sonnet-4-6',
      'claude-sonnet-4.6',
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
  [FeatureId.AnthropicAlwaysOnAdaptiveThinking]: {
    supportedFamilys: [
      'claude-fable-5',
      'claude-mythos-5',
      'claude-sonnet-5',
    ],
  },
  [FeatureId.AnthropicXHighEffort]: {
    supportedFamilys: [
      'claude-sonnet-5',
      'claude-opus-4-8',
      'claude-opus-4.8',
      'claude-opus-4-7',
      'claude-opus-4.7',
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
    supportedProviders: [
      'api.cerebras.ai',
      'opencode.ai',
      'api.synthetic.new',
      'api.moonshot.cn',
      'api.moonshot.ai',
      'api.kimi.com',
    ],
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
      'tokenhub.tencentmaas.com',
      'tokenhub-intl.tencentmaas.com',
      'api.lkeap.cloud.tencent.com',
      'router.huggingface.co',
      'qianfan.baidubce.com',
      'portal.qwen.ai',
      'api.siliconflow.cn',
      'api.siliconflow.com',
      'api.stepfun.com',
      'api.stepfun.ai',
      'api.inceptionlabs.ai',
      'api.mistral.ai',
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
  [FeatureId.OpenRouterUseClaudeAdaptiveVerbosity]: {
    customCheckers: [
      (model, provider) =>
        matchProvider(provider.baseUrl, 'openrouter.ai') &&
        [
          'claude-opus-4-8',
          'claude-opus-4.8',
          'claude-4-8-opus',
          'claude-4.8-opus',
          'claude-opus-4-7',
          'claude-opus-4.7',
          'claude-4-7-opus',
          'claude-4.7-opus',
          'claude-opus-4-6',
          'claude-opus-4.6',
          'claude-4-6-opus',
          'claude-4.6-opus',
          'claude-sonnet-4-6',
          'claude-sonnet-4.6',
          'claude-4-6-sonnet',
          'claude-4.6-sonnet',
        ].some((expected) => modelIdentityIncludes(model, expected)),
    ],
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
      'tokenhub.tencentmaas.com',
      'tokenhub-intl.tencentmaas.com',
      'api.lkeap.cloud.tencent.com',
      'api.deepseek.com',
      'api.xiaomimimo.com',
      'open.bigmodel.cn',
      'api.z.ai',
      'api.moonshot.cn',
      'api.moonshot.ai',
    ],
    customCheckers: [
      (model, provider) =>
        isBaiduQianfanModel(model, provider, [
          'deepseek-v3.2',
          'deepseek-v3.1',
          'deepseek-v3.1-250821',
          'kimi-k2.5',
          'glm-5',
          'glm-4.7',
        ]),
      // Checker for Nvidia GLM models:
      (model, provider) =>
        matchProvider(provider.baseUrl, 'integrate.api.nvidia.com') &&
        matchModelFamily(model.family ?? getBaseModelId(model.id), [
          'z-ai/glm',
        ]),
        (model) => modelFamilyIncludes(model, 'deepseek-v4'),
        (model) => modelFamilyIncludes(model, 'glm-5.2'),
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
      'tokenhub.tencentmaas.com',
      'tokenhub-intl.tencentmaas.com',
      'api.lkeap.cloud.tencent.com',
      'api.synthetic.new',
    ],
    customCheckers: [
      (model, provider) =>
        isBaiduQianfanModel(model, provider, ['gpt-oss-120b', 'gpt-oss-20b']),
    ],
  },
  [FeatureId.OpenAIUseDeepSeekReasoningEffortParam]: {
    customCheckers: [
      (model) => modelFamilyIncludes(model, 'glm-5.2'),
      (model) => modelFamilyIncludes(model, 'deepseek-v4'),
    ],
  },
  [FeatureId.OpenAIStripIncludeParam]: {
    supportedProviders: [
      'ark.cn-beijing.volces.com',
      'ark.ap-southeast.bytepluses.com',
    ],
  },
  [FeatureId.OpenAIUsePreviousResponseId]: {
    supportedProviders: ['api.openai.com', 'chatgpt.com'],
  },
  [FeatureId.OpenAIUseResponsesContextManagement]: {
    supportedProviders: ['api.openai.com', 'chatgpt.com'],
  },
  [FeatureId.OpenAIUsePromptCacheKey]: {
    supportedProviders: ['api.openai.com', 'api.x.ai'],
  },
  [FeatureId.OpenAIUseStandaloneResponsesCompaction]: {
    supportedProviders: ['api.openai.com', 'api.x.ai'],
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
      'api.synthetic.new',
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
      'wanqing.streamlakeapi.com',
      'vanchin.streamlake.ai',
    ],
    customCheckers: [
      (model, provider) =>
        isBaiduQianfanModel(model, provider, [
          'qwen3-235b-a22b',
          'qwen3-30b-a3b',
          'qwen3-32b',
          'qwen3-14b',
          'qwen3-8b',
          'qwen3-4b',
          'qwen3-1.7b',
          'qwen3-0.6b',
          'ernie-4.5-turbo-vl-preview',
          'ernie-4.5-turbo-vl-32k-preview',
          'ernie-4.5-vl-28b-a3b',
          'ernie-5.0-thinking-preview',
        ]),
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
    customCheckers: [
      (model, provider) =>
        isBaiduQianfanModel(model, provider, [
          'ernie-5.0-thinking-preview',
          'deepseek-v3.2-think',
          'deepseek-v3.1-250821',
          'deepseek-r1-250528',
          'qwen3-235b-a22b-thinking-2507',
          'qwen3-30b-a3b-thinking-2507',
          'qwen3-235b-a22b',
          'qwen3-30b-a3b',
          'qwen3-32b',
          'qwen3-14b',
          'qwen3-8b',
          'qwen3-4b',
          'qwen3-1.7b',
          'qwen3-0.6b',
        ]),
    ],
  },
  [FeatureId.OpenAIUseThinkingStrategyParam]: {
    supportedProviders: ['qianfan.baidubce.com'],
  },
  [FeatureId.OpenAIUseReasoningContent]: {
    supportedProviders: [
      'ark.cn-beijing.volces.com',
      'ark.ap-southeast.bytepluses.com',
      'tokenhub.tencentmaas.com',
      'tokenhub-intl.tencentmaas.com',
      'api.lkeap.cloud.tencent.com',
      'api.deepseek.com',
      'api.xiaomimimo.com',
      'open.bigmodel.cn',
      'api.z.ai',
      'api.moonshot.cn',
      'api.moonshot.ai',
      'opencode.ai',
      'api.kimi.com',
      'dashscope-intl.aliyuncs.com',
      'dashscope-intl.aliyuncs.com',
      'api-inference.modelscope.cn',
      'api.siliconflow.cn',
      'api.siliconflow.com',
      'api.longcat.chat',
      'api.synthetic.new',
      'qianfan.baidubce.com',
      'integrate.api.nvidia.com',
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
      // Checker for Nvidia Minimax models:
      (model, provider) =>
        matchProvider(provider.baseUrl, 'integrate.api.nvidia.com') &&
        matchModelFamily(model.family ?? getBaseModelId(model.id), [
          'minimaxai/minimax-',
        ]),
    ],
  },
  [FeatureId.GeminiUseThinkingLevel]: {
    supportedFamilys: [
      'gemini-3-',
      'gemma-4-',
      'models/gemini-3-',
      'models/gemma-4-',
    ],
  },
  [FeatureId.MistralContentChunks]: {
    supportedProviders: ['api.mistral.ai'],
  },
};
