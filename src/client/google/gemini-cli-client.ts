import type { AuthTokenInfo, AuthTokenRefresh } from '../../auth/types';
import type { ChatRequestTrace, ModelConfig, ProviderConfig } from '../../types';
import {
  GEMINI_CLI_API_HEADERS,
  GEMINI_CLI_ENDPOINT_FALLBACKS,
} from '../../auth/providers/google-gemini-oauth/constants';
import * as vscode from 'vscode';
import type { RequestLogger } from '../../logger';
import { GoogleAIStudioProvider } from './ai-studio-client';
import { getToken, getTokenType } from '../utils';
import {
  type Gemini3ThinkingLevel,
  GoogleCodeAssistProvider,
} from './code-assist-client';

const GEMINI_3_TIER_SUFFIX = /-(minimal|low|medium|high)$/i;
const GEMINI_3_PREVIEW_SUFFIX = /-preview(?:-customtools)?$/i;
const GEMINI_CLI_AI_STUDIO_BASE_URL =
  'https://generativelanguage.googleapis.com';

class GeminiCliAIStudioProvider extends GoogleAIStudioProvider {
  protected override buildHeaders(
    credential?: AuthTokenInfo,
    modelConfig?: ModelConfig,
  ): Record<string, string> {
    const headers = super.buildHeaders(credential, modelConfig);
    const token = getToken(credential);
    if (token) {
      const tokenType = getTokenType(credential) ?? 'Bearer';
      headers['Authorization'] = `${tokenType} ${token}`;
    }
    return headers;
  }
}

export class GoogleGeminiCLIProvider extends GoogleCodeAssistProvider {
  protected readonly codeAssistName = 'Gemini CLI';
  protected readonly codeAssistHeaders = GEMINI_CLI_API_HEADERS;
  protected readonly codeAssistHeaderStyle = 'gemini-cli';
  protected readonly codeAssistEndpointFallbacks =
    GEMINI_CLI_ENDPOINT_FALLBACKS;
  private readonly aiStudioDelegate = new GeminiCliAIStudioProvider({
    ...this.config,
    type: 'google-ai-studio',
    baseUrl: GEMINI_CLI_AI_STUDIO_BASE_URL,
  } satisfies ProviderConfig);

  private useAIStudioEndpoint(): boolean {
    return this.config.auth?.method === 'google-gemini-oauth'
      ? this.config.auth.oauthType === 'ai_studio'
      : false;
  }

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

  protected override resolveProjectId(credential: AuthTokenInfo): string {
    if (this.useAIStudioEndpoint()) {
      return '';
    }
    const context =
      credential.kind === 'token' ? credential.authContext : undefined;
    if (context?.method === 'google-gemini-oauth') {
      const managedProjectId = context.managedProjectId?.trim();
      if (managedProjectId) {
        return managedProjectId;
      }
      const projectId = context.projectId?.trim();
      if (projectId) {
        return projectId;
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

    const withPreview = GEMINI_3_PREVIEW_SUFFIX.test(withoutTier)
      ? withoutTier
      : `${withoutTier}-preview`;
    // Sync rule: preserve customtools IDs like "*-preview-customtools";
    // never append an extra "-preview" for them.

    const effectiveLevel: Gemini3ThinkingLevel =
      preferredGemini3ThinkingLevel ?? tier ?? 'low';

    return {
      requestModelId: withPreview,
      gemini3ThinkingLevel: effectiveLevel,
    };
  }

  override async *streamChat(
    encodedModelId: string,
    model: ModelConfig,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    requestTrace: ChatRequestTrace,
    token: vscode.CancellationToken,
    logger: RequestLogger,
    credential: AuthTokenInfo,
  ): AsyncGenerator<vscode.LanguageModelResponsePart2> {
    if (this.useAIStudioEndpoint()) {
      yield* this.aiStudioDelegate.streamChat(
        encodedModelId,
        model,
        messages,
        options,
        requestTrace,
        token,
        logger,
        credential,
      );
      return;
    }

    yield* super.streamChat(
      encodedModelId,
      model,
      messages,
      options,
      requestTrace,
      token,
      logger,
      credential,
    );
  }

  override async getAvailableModels(
    credential: AuthTokenInfo,
    refreshCredential?: AuthTokenRefresh,
    signal?: AbortSignal,
  ): Promise<ModelConfig[]> {
    this.validateAuth();
    if (this.useAIStudioEndpoint()) {
      return this.aiStudioDelegate.getAvailableModels(
        credential,
        refreshCredential,
        signal,
      );
    }
    // Sync rule: this list should match local canonical model IDs for Gemini CLI.
    // Do NOT import Antigravity-prefixed or proxy-specific resolver aliases.
    return [
      { id: 'gemini-2.5-pro' },
      { id: 'gemini-2.5-flash' },
      { id: 'gemini-2.5-flash-lite' },
      { id: 'gemini-3-pro-preview' },
      { id: 'gemini-3.1-pro-preview' },
      { id: 'gemini-3-flash-preview' },
      { id: 'gemini-3.1-flash-lite-preview' },
      { id: 'gemini-3.5-flash' },
    ];
  }
}
