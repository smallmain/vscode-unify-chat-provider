import type { AuthTokenInfo } from '../../auth/types';
import type { ModelConfig } from '../../types';
import {
  CODE_ASSIST_ENDPOINT_FALLBACKS,
  CODE_ASSIST_HEADERS,
} from '../../auth/providers/antigravity-oauth/constants';
import {
  type Gemini3ThinkingLevel,
  GoogleCodeAssistProvider,
  resolveAntigravityModelForRequest,
} from './code-assist-client';

export class GoogleAntigravityProvider extends GoogleCodeAssistProvider {
  protected readonly codeAssistName = 'Antigravity';
  protected readonly codeAssistHeaders = CODE_ASSIST_HEADERS;
  protected readonly codeAssistHeaderStyle = 'antigravity';
  protected readonly codeAssistEndpointFallbacks =
    CODE_ASSIST_ENDPOINT_FALLBACKS;

  protected resolveModelForRequest(
    modelId: string,
    preferredGemini3ThinkingLevel?: Gemini3ThinkingLevel,
    thinkingEnabled?: boolean,
  ): {
    requestModelId: string;
    gemini3ThinkingLevel?: Gemini3ThinkingLevel;
  } {
    return resolveAntigravityModelForRequest(
      modelId,
      preferredGemini3ThinkingLevel,
      thinkingEnabled,
    );
  }

  protected override shouldInjectAntigravitySystemInstruction(
    _modelIdLower: string,
    _isClaudeModel: boolean,
  ): boolean {
    return true;
  }

  override async getAvailableModels(
    _credential: AuthTokenInfo,
  ): Promise<ModelConfig[]> {
    this.validateAuth();
    // Sync rule: keep canonical model IDs used by this project config.
    // Do NOT copy reference project's "antigravity-*" prefixed IDs directly.
    return [
      { id: 'gemini-2.5-flash' },
      { id: 'gemini-2.5-flash-lite' },
      { id: 'gemini-3.1-pro' },
      { id: 'gemini-3.1-flash-lite-preview' },
      { id: 'gemini-3-pro' },
      { id: 'gemini-3-flash' },
      { id: 'claude-sonnet-4-6' },
      { id: 'claude-opus-4-6' },
    ];
  }
}
