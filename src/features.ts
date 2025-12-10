import { ModelConfig } from './client/interface';

export enum FeatureId {
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
   * @see https://docs.anthropic.com/en/docs/build-with-claude/tool-use/web-search-tool#citations
   */
  AnthropicCitations = 'anthropic_citations',
  /**
   * @see https://community.openai.com/t/developer-role-not-accepted-for-o1-o1-mini-o3-mini/1110750/7
   */
  OpenAIOnlyUseMaxCompletionTokens = 'openai_only-use-max-completion-tokens',
  /**
   * @see https://platform.moonshot.cn/docs/guide/use-kimi-k2-thinking-model
   */
  OpenAIReasoningContent = 'openai_reasoning-content',
  /**
   * Compared to {@link OpenAIReasoningContent}, this only sends the thought content after the user's last message.
   * @see https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
   */
  OpenAIConciseReasoningContent = 'openai_concise-reasoning-content',
}

export interface Feature {
  /**
   * Supported model familys, use {@link Array.includes} to check if a family is supported.
   */
  supportedFamilys?: string[];

  /**
   * Supported model IDs, use {@link Array.includes} to check if a model is supported.
   */
  supportedModels?: string[];
}

export const FEATURES: Record<FeatureId, Feature> = {
  [FeatureId.AnthropicInterleavedThinking]: {
    supportedFamilys: [
      'claude-sonnet-4-5',
      'claude-sonnet-4',
      'claude-opus-4-5',
      'claude-opus-4-1',
      'claude-opus-4',
    ],
  },
  [FeatureId.AnthropicWebSearch]: {
    supportedFamilys: [
      'claude-sonnet-4-5',
      'claude-sonnet-4',
      'claude-sonnet-3-7',
      'claude-haiku-4-5',
      'claude-haiku-3-5',
      'claude-opus-4-5',
      'claude-opus-4-1',
      'claude-opus-4',
    ],
  },
  [FeatureId.AnthropicMemoryTool]: {
    supportedFamilys: [
      'claude-sonnet-4-5',
      'claude-opus-4-5',
      'claude-opus-4-1',
      'claude-opus-4',
    ],
  },
  [FeatureId.AnthropicCitations]: {
    supportedFamilys: [
      'claude-sonnet-4-5',
      'claude-sonnet-4',
      'claude-sonnet-3-7',
      'claude-haiku-4-5',
      'claude-haiku-3-5',
      'claude-opus-4-5',
      'claude-opus-4-1',
      'claude-opus-4',
    ],
  },
  [FeatureId.OpenAIOnlyUseMaxCompletionTokens]: {
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
    ],
  },
  [FeatureId.OpenAIReasoningContent]: {
    supportedFamilys: ['kimi-k2-thinking', 'kimi-k2-thinking-turbo'],
  },
  [FeatureId.OpenAIConciseReasoningContent]: {
    supportedFamilys: ['deepseek-reasoner'],
  },
};

/**
 * Check if a feature is supported by a specific model.
 * @param featureId The feature ID to check
 * @returns true if the feature is supported by the model
 */
export function isFeatureSupported(
  featureId: FeatureId,
  model: ModelConfig,
): boolean {
  const feature = FEATURES[featureId];
  if (!feature) {
    return false;
  }

  // Check if model ID is explicitly supported
  if (model.id && feature.supportedModels?.includes(model.id)) {
    return true;
  }

  // Check if model family is supported
  if (model.id && feature.supportedFamilys?.includes(model.id)) {
    return true;
  }

  return false;
}
