export type Gemini3ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

const IMAGE_MODEL_PATTERN = /image|imagen/i;
const GEMINI_3_TIER_SUFFIX = /-(minimal|low|medium|high)$/i;
const GEMINI_3_PRO_PATTERN = /^gemini-3(?:\.\d+)?-pro/i;
const GEMINI_3_1_PRO_PATTERN = /^gemini-3\.1-pro(?:$|-)/i;
const CLAUDE_THINKING_SUFFIX = /-thinking$/i;

const ANTIGRAVITY_GEMINI_3_1_PRO_AGENT_MODEL = 'gemini-pro-agent';
const ANTIGRAVITY_GEMINI_3_1_PRO_LOW_MODEL = 'gemini-3.1-pro-low';

export function isAntigravityImageModel(modelId: string): boolean {
  return IMAGE_MODEL_PATTERN.test(modelId);
}

function parseGemini3TierSuffix(modelId: string): {
  baseModelId: string;
  tier?: Gemini3ThinkingLevel;
} {
  const tierMatch = modelId.match(GEMINI_3_TIER_SUFFIX);
  if (!tierMatch || typeof tierMatch[1] !== 'string') {
    return { baseModelId: modelId };
  }

  const candidate = tierMatch[1].toLowerCase();
  if (
    candidate !== 'minimal' &&
    candidate !== 'low' &&
    candidate !== 'medium' &&
    candidate !== 'high'
  ) {
    return { baseModelId: modelId };
  }

  return {
    baseModelId: modelId.slice(0, modelId.length - tierMatch[0].length),
    tier: candidate,
  };
}

function resolveGemini31ProRoute(
  thinkingLevel: Gemini3ThinkingLevel,
): string {
  // Antigravity's current Pro variants are route IDs, not effort suffixes.
  return thinkingLevel === 'low'
    ? ANTIGRAVITY_GEMINI_3_1_PRO_LOW_MODEL
    : ANTIGRAVITY_GEMINI_3_1_PRO_AGENT_MODEL;
}

export function resolveAntigravityModelForRequest(
  modelId: string,
  preferredGemini3ThinkingLevel?: Gemini3ThinkingLevel,
  _thinkingEnabled?: boolean,
): {
  requestModelId: string;
  gemini3ThinkingLevel?: Gemini3ThinkingLevel;
} {
  const trimmed = modelId.trim();
  const modelLower = trimmed.toLowerCase();

  // Antigravity exposes Claude Opus as a dedicated `-thinking` request model,
  // while Claude Sonnet keeps its canonical model ID.
  if (modelLower.includes('claude')) {
    const baseClaudeModelId = trimmed.replace(CLAUDE_THINKING_SUFFIX, '');
    const isOpus = baseClaudeModelId.toLowerCase().includes('opus');
    const requestModelId = isOpus
      ? `${baseClaudeModelId}-thinking`
      : baseClaudeModelId;
    return { requestModelId };
  }

  const isGemini3 = modelLower.includes('gemini-3');
  if (!isGemini3) {
    return { requestModelId: trimmed };
  }

  const isGemini3Pro = GEMINI_3_PRO_PATTERN.test(modelLower);
  if (isGemini3Pro) {
    const { baseModelId, tier } = parseGemini3TierSuffix(trimmed);
    const effectiveLevel: Gemini3ThinkingLevel =
      preferredGemini3ThinkingLevel ?? tier ?? 'high';

    if (isAntigravityImageModel(baseModelId)) {
      return {
        requestModelId: baseModelId,
        gemini3ThinkingLevel: effectiveLevel,
      };
    }

    const requestModelId = GEMINI_3_1_PRO_PATTERN.test(baseModelId)
      ? resolveGemini31ProRoute(effectiveLevel)
      : `${baseModelId}-${effectiveLevel}`;
    return { requestModelId, gemini3ThinkingLevel: effectiveLevel };
  }

  const effectiveLevel: Gemini3ThinkingLevel =
    preferredGemini3ThinkingLevel ?? 'high';
  return {
    requestModelId: trimmed,
    gemini3ThinkingLevel: effectiveLevel,
  };
}
