import { ModelConfig } from '../types';

/**
 * Well-known model configuration with additional matching options
 */
interface WellKnownModelConfig extends ModelConfig {
  /** Alternative IDs for matching (e.g., aliases or legacy IDs) */
  alternativeIds?: string[];
}

/**
 * Well-known models configuration
 */
const _WELL_KNOWN_MODELS = [
  {
    id: 'claude-sonnet-4-5',
    alternativeIds: ['claude-sonnet-4.5'],
    name: 'Claude Sonnet 4.5',
    maxInputTokens: 200000,
    maxOutputTokens: 64000,
    stream: true,
    thinking: {
      type: 'enabled',
      budgetTokens: 16000,
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'claude-haiku-4-5',
    alternativeIds: ['claude-haiku-4.5'],
    name: 'Claude Haiku 4.5',
    maxInputTokens: 200000,
    maxOutputTokens: 64000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'claude-opus-4-5',
    alternativeIds: ['claude-opus-4.5'],
    name: 'Claude Opus 4.5',
    maxInputTokens: 200000,
    maxOutputTokens: 64000,
    stream: true,
    thinking: {
      type: 'enabled',
      budgetTokens: 32000,
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'claude-opus-4-1',
    alternativeIds: ['claude-opus-4.1'],
    name: 'Claude Opus 4.1',
    maxInputTokens: 200000,
    maxOutputTokens: 32000,
    stream: true,
    thinking: {
      type: 'enabled',
      budgetTokens: 10000,
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'claude-sonnet-4',
    name: 'Claude Sonnet 4',
    maxInputTokens: 200000,
    maxOutputTokens: 64000,
    stream: true,
    thinking: {
      type: 'enabled',
      budgetTokens: 10000,
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'claude-3-7-sonnet',
    alternativeIds: ['claude-3.7-sonnet'],
    name: 'Claude Sonnet 3.7',
    maxInputTokens: 200000,
    maxOutputTokens: 64000,
    stream: true,
    thinking: {
      type: 'enabled',
      budgetTokens: 10000,
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'claude-opus-4',
    name: 'Claude Opus 4',
    maxInputTokens: 200000,
    maxOutputTokens: 32000,
    stream: true,
    thinking: {
      type: 'enabled',
      budgetTokens: 10000,
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'claude-3-5-haiku',
    alternativeIds: ['claude-3.5-haiku'],
    name: 'Claude Haiku 3.5',
    maxInputTokens: 200000,
    maxOutputTokens: 8000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'claude-3-haiku',
    name: 'Claude Haiku 3',
    maxInputTokens: 200000,
    maxOutputTokens: 4000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-5.2',
    name: 'GPT-5.2',
    maxInputTokens: 400000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-5.2-pro',
    name: 'GPT-5.2 pro',
    maxInputTokens: 400000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
      effort: 'xhigh',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-5.2-chat-latest',
    name: 'GPT-5.2 Chat',
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-5.1',
    name: 'GPT-5.1',
    maxInputTokens: 400000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-5',
    name: 'GPT-5',
    maxInputTokens: 400000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-5-mini',
    name: 'GPT-5 mini',
    maxInputTokens: 400000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-5-nano',
    name: 'GPT-5 nano',
    maxInputTokens: 400000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-5.1-codex',
    name: 'GPT-5.1 Codex',
    maxInputTokens: 400000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-5.1-codex-max',
    name: 'GPT-5.1-Codex-Max',
    maxInputTokens: 400000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-5-codex',
    name: 'GPT-5-Codex',
    maxInputTokens: 400000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-5.1-codex-mini',
    name: 'GPT-5.1 Codex mini',
    maxInputTokens: 400000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-5-pro',
    name: 'GPT-5 pro',
    maxInputTokens: 400000,
    maxOutputTokens: 272000,
    stream: true,
    thinking: {
      type: 'enabled',
      effort: 'high',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-5.1-chat-latest',
    name: 'GPT-5.1 Chat',
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-5-chat-latest',
    name: 'GPT-5 Chat',
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'MiniMax-M2',
    name: 'MiniMax-M2',
    maxInputTokens: 204800,
    maxOutputTokens: 102400,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    temperature: 1.0,
  },
  {
    id: 'MiniMax-M2-Stable',
    name: 'MiniMax-M2-Stable',
    maxInputTokens: 204800,
    maxOutputTokens: 102400,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    temperature: 1.0,
  },
  {
    id: 'deepseek-chat',
    name: 'DeepSeek Chat',
    maxInputTokens: 128000,
    maxOutputTokens: 8000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    temperature: 1.0,
  },
  {
    id: 'deepseek-reasoner',
    name: 'DeepSeek Reasoner',
    maxInputTokens: 128000,
    maxOutputTokens: 64000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    temperature: 1.0,
  },
  {
    id: 'kimi-k2-thinking',
    name: 'Kimi K2 Thinking',
    maxInputTokens: 256000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    temperature: 1.0,
  },
  {
    id: 'kimi-k2-thinking-turbo',
    name: 'Kimi K2 Thinking Turbo',
    maxInputTokens: 256000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    temperature: 1.0,
  },
  {
    id: 'kimi-k2-0905-preview',
    name: 'Kimi K2 0905 Preview',
    maxInputTokens: 256000,
    maxOutputTokens: 128000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    temperature: 0.6,
  },
  {
    id: 'kimi-k2-turbo-preview',
    name: 'Kimi K2 Turbo Preview',
    maxInputTokens: 256000,
    maxOutputTokens: 128000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    temperature: 0.6,
  },
] as const satisfies WellKnownModelConfig[];
export const WELL_KNOWN_MODELS: WellKnownModelConfig[] = _WELL_KNOWN_MODELS;
export type WellKnownModelId = (typeof _WELL_KNOWN_MODELS)[number]['id'];

/**
 * Check if two IDs match using includes-based comparison
 * Returns the matched ID length if matched, 0 otherwise
 */
function getMatchScore(apiModelId: string, knownId: string): number {
  const lowerApi = apiModelId.toLowerCase();
  const lowerKnown = knownId.toLowerCase();

  // Exact match gets highest score
  if (lowerApi === lowerKnown) {
    return Infinity;
  }

  // Check if one includes the other
  if (lowerApi.includes(lowerKnown) || lowerKnown.includes(lowerApi)) {
    // Score based on the length of the matched known ID
    // Longer matches are more specific and should be preferred
    return knownId.length;
  }

  return 0;
}

/**
 * Get all IDs to match against for a model (primary ID + alternativeIds)
 */
function getAllMatchableIds(model: WellKnownModelConfig): string[] {
  const ids = [model.id];
  if (model.alternativeIds) {
    ids.push(...model.alternativeIds);
  }
  return ids;
}

/**
 * Calculate the best match score for a model against an API model ID
 * Considers both primary ID and alternativeIds
 */
function calculateBestMatchScore(
  apiModelId: string,
  model: WellKnownModelConfig,
): number {
  const allIds = getAllMatchableIds(model);
  let bestScore = 0;

  for (const id of allIds) {
    const score = getMatchScore(apiModelId, id);
    if (score > bestScore) {
      bestScore = score;
    }
  }

  return bestScore;
}

/**
 * Find the best matching well-known model for a given API model ID
 * Uses includes-based filtering and selects the most similar match
 * Supports matching against both primary ID and alternativeIds
 */
export function findBestMatchingWellKnownModel(
  apiModelId: string,
): ModelConfig | undefined {
  // Filter models that have at least one matching ID
  const candidates = WELL_KNOWN_MODELS.filter(
    (model) => calculateBestMatchScore(apiModelId, model) > 0,
  );

  if (candidates.length === 0) {
    return undefined;
  }

  // Find the most similar match (highest score)
  let bestMatch = candidates[0];
  let bestScore = calculateBestMatchScore(apiModelId, bestMatch);

  for (let i = 1; i < candidates.length; i++) {
    const score = calculateBestMatchScore(apiModelId, candidates[i]);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = candidates[i];
    }
  }

  return bestMatch;
}

/**
 * Merge API model with well-known model configuration
 * API model fields take precedence over well-known fields
 */
export function mergeWithWellKnownModel(apiModel: ModelConfig): ModelConfig {
  const wellKnown = findBestMatchingWellKnownModel(apiModel.id);
  return Object.assign({}, wellKnown ?? {}, apiModel);
}

/**
 * Merge API model with well-known model configuration
 * API model fields take precedence over well-known fields
 */
export function mergeWithWellKnownModels(
  apiModels: ModelConfig[],
): ModelConfig[] {
  return apiModels.map((model) => mergeWithWellKnownModel(model));
}
