import type { AuthTokenInfo } from '../../auth/types';
import type { ModelConfig } from '../../types';
import {
  GEMINI_CLI_API_HEADERS,
  GEMINI_CLI_ENDPOINT_FALLBACKS,
} from '../../auth/providers/google-gemini-oauth/constants';
import {
  type Gemini3ThinkingLevel,
  GoogleCodeAssistProvider,
} from './code-assist-client';

const GEMINI_3_TIER_SUFFIX = /-(minimal|low|medium|high)$/i;

export class GoogleGeminiCLIProvider extends GoogleCodeAssistProvider {
  protected readonly codeAssistName = 'Gemini CLI';
  protected readonly codeAssistHeaders = GEMINI_CLI_API_HEADERS;
  protected readonly codeAssistHeaderStyle = 'gemini-cli';
  protected readonly codeAssistEndpointFallbacks = GEMINI_CLI_ENDPOINT_FALLBACKS;

  /**
   * Override to support google-gemini-oauth authentication method.
   */
  protected override validateAuth(): void {
    const authMethod = this.config.auth?.method;
    if (authMethod !== 'google-gemini-oauth') {
      throw new Error(
        `Google ${this.codeAssistName} provider requires auth method "google-gemini-oauth".`,
      );
    }
  }

  protected override resolveProjectId(): string {
    const auth = this.config.auth;
    if (auth?.method === 'google-gemini-oauth') {
      const managedProjectId = auth.managedProjectId?.trim();
      if (managedProjectId) {
        return managedProjectId;
      }
    }
    // Do not fallback to default ID, return empty string to trigger validation error later
    return '';
  }

  protected resolveModelForRequest(
    modelId: string,
    preferredGemini3ThinkingLevel?: Gemini3ThinkingLevel,
    _thinkingEnabled?: boolean,
  ): {
    requestModelId: string;
    gemini3ThinkingLevel?: Gemini3ThinkingLevel;
  } {
    const trimmed = modelId.trim();
    const modelLower = trimmed.toLowerCase();

    if (modelLower.includes('claude')) {
      throw new Error(
        'Gemini CLI provider does not support Claude models. Use Google Antigravity provider instead.',
      );
    }

    const isGemini3 = modelLower.includes('gemini-3');
    if (!isGemini3) {
      return { requestModelId: trimmed };
    }

    const tierMatch = trimmed.match(GEMINI_3_TIER_SUFFIX);
    let tier: Gemini3ThinkingLevel | undefined;
    let withoutTier = trimmed;
    if (tierMatch && typeof tierMatch[1] === 'string') {
      const candidate = tierMatch[1].toLowerCase();
      if (
        candidate === 'minimal' ||
        candidate === 'low' ||
        candidate === 'medium' ||
        candidate === 'high'
      ) {
        tier = candidate;
        withoutTier = trimmed.slice(0, trimmed.length - tierMatch[0].length);
      }
    }

    const withPreview = withoutTier.toLowerCase().endsWith('-preview')
      ? withoutTier
      : `${withoutTier}-preview`;

    const effectiveLevel: Gemini3ThinkingLevel =
      preferredGemini3ThinkingLevel ?? tier ?? 'low';

    return { requestModelId: withPreview, gemini3ThinkingLevel: effectiveLevel };
  }

  override async getAvailableModels(
    _credential: AuthTokenInfo,
  ): Promise<ModelConfig[]> {
    this.validateAuth();
    return [
      { id: 'gemini-3-pro-preview' },
      { id: 'gemini-3-flash-preview' },
      { id: 'gemini-2.5-pro' },
      { id: 'gemini-2.5-flash' },
      { id: 'gemini-2.0-flash' },
    ];
  }
}
