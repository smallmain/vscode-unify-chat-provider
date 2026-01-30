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
  protected readonly codeAssistEndpointFallbacks = CODE_ASSIST_ENDPOINT_FALLBACKS;

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
    modelIdLower: string,
    isClaudeModel: boolean,
  ): boolean {
    return isClaudeModel || modelIdLower.includes('gemini-3-pro-high');
  }

  override async getAvailableModels(
    _credential: AuthTokenInfo,
  ): Promise<ModelConfig[]> {
    this.validateAuth();
    return [
      { id: 'gemini-3-pro' },
      { id: 'gemini-3-flash' },
      { id: 'claude-sonnet-4-5' },
      { id: 'claude-opus-4-5' },
    ];
  }
}
