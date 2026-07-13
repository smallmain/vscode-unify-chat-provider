import OpenAI from 'openai';
import * as vscode from 'vscode';
import type { AuthTokenInfo } from '../../auth/types';
import { isRawBaseUrlEnabled } from '../../utils';
import type { ModelConfig, ProviderConfig } from '../../types';
import { getToken } from '../utils';
import { OpenAIResponsesProvider } from '../openai/responses-client';
import { randomUUID } from 'crypto';
import {
  XAI_CLI_CHAT_PROXY_BASE_URL,
  XAI_DEFAULT_API_BASE_URL,
  XAI_TOKEN_AUTH_HEADER,
  XAI_TOKEN_AUTH_VALUE,
  XAI_CLIENT_VERSION_HEADER,
  XAI_CLIENT_VERSION_VALUE,
  XAI_USER_AGENT,
  XAI_CONV_ID_HEADER,
} from '../../auth/providers/xai-grok-build/constants';

const XAI_GROK_SOURCE = 'vscode-unify-chat-provider';
const XAI_RESPONSES_HTTP_BETA = 'responses=experimental';

function deleteHeaderVariants(
  headers: Record<string, string>,
  name: string,
): void {
  const needle = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === needle) {
      delete headers[key];
    }
  }
}

function readStringHeader(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const needle = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === needle) return v;
  }
  return undefined;
}

function setHeaderIfMissing(
  headers: Record<string, string>,
  name: string,
  value: string,
): void {
  if (readStringHeader(headers, name) === undefined) {
    headers[name] = value;
  }
}

/**
 * XaiGrokBuildProvider — Grok Build (SuperGrok / X Premium+) client.
 *
 * Request construction is aligned with CLIProxyAPI's reference implementation:
 * - OAuth-authenticated HTTP chat goes through `cli-chat-proxy.grok.com/v1`
 * - WebSocket connections use `api.x.ai/v1` (chat-proxy returns 405 for WS upgrades)
 * - Headers match what the Grok CLI sends (X-XAI-Token-Auth, x-grok-client-version, etc.)
 */
export class XaiGrokBuildProvider extends OpenAIResponsesProvider {
  /**
   * Resolve the base URL for HTTP requests.
   *
   * Aligned with CLIProxyAPI's `xaiChatBaseURL`:
   * - OAuth mode (default for this provider): `https://cli-chat-proxy.grok.com/v1`
   * - When raw base URL is enabled, honor the user's explicit setting.
   */
  protected override resolveBaseUrl(config: ProviderConfig): string {
    if (isRawBaseUrlEnabled(config)) {
      return super.resolveBaseUrl(config);
    }
    // OAuth → route through Grok Build's CLI chat-proxy
    if (config.auth?.method === 'xai-grok-oauth') {
      return XAI_CLI_CHAT_PROXY_BASE_URL;
    }
    return XAI_DEFAULT_API_BASE_URL;
  }

  protected override buildHeaders(
    sessionId: string,
    credential?: AuthTokenInfo,
    modelConfig?: ModelConfig,
    _messages?: readonly vscode.LanguageModelChatRequestMessage[],
  ): Record<string, string> {
    const headers = super.buildHeaders(sessionId, credential, modelConfig);

    // Sanitize: remove anything that would leak the oauth token as api-key
    deleteHeaderVariants(headers, 'x-api-key');
    deleteHeaderVariants(headers, 'openai-organization');
    deleteHeaderVariants(headers, 'openai-project');
    deleteHeaderVariants(headers, 'x-stainless-');

    const auth = this.config.auth;
    if (auth?.method === 'xai-grok-oauth') {
      // Ensure pure Bearer auth (the credential value is the oauth access token)
      const token = getToken(credential);
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      // --- CLIProxyAPI-aligned chat-proxy identity headers ---
      // These match applyXAIChatHeaders() in xai_executor.go when using_api=false
      setHeaderIfMissing(headers, XAI_TOKEN_AUTH_HEADER, XAI_TOKEN_AUTH_VALUE);
      setHeaderIfMissing(headers, XAI_CLIENT_VERSION_HEADER, XAI_CLIENT_VERSION_VALUE);
      setHeaderIfMissing(headers, 'User-Agent', XAI_USER_AGENT);
      setHeaderIfMissing(headers, XAI_CONV_ID_HEADER, sessionId);

      // Keep x-grok-source as additional identifier (not in CLIProxyAPI but harmless)
      setHeaderIfMissing(headers, 'x-grok-source', XAI_GROK_SOURCE);
    }

    return headers;
  }

  /**
   * Build WebSocket headers.
   *
   * Aligned with CLIProxyAPI's `applyXAIWebsocketHeaders`:
   * - WebSocket goes to api.x.ai (not cli-chat-proxy), so chat-proxy identity
   *   headers (X-XAI-Token-Auth, x-grok-client-version, User-Agent) are stripped.
   * - Keeps: Authorization, Content-Type, x-grok-conv-id, openai-beta.
   */
  protected override buildWebSocketHeaders(
    sessionId: string,
    credential?: AuthTokenInfo,
    modelConfig?: ModelConfig,
    messages?: readonly vscode.LanguageModelChatRequestMessage[],
  ): Record<string, string> {
    const headers = this.buildHeaders(
      sessionId,
      credential,
      modelConfig,
      messages,
    );

    // Remove headers that are only for chat-proxy HTTP (not WebSocket)
    deleteHeaderVariants(headers, 'x-api-key');
    deleteHeaderVariants(headers, 'openai-beta');
    deleteHeaderVariants(headers, XAI_TOKEN_AUTH_HEADER);
    deleteHeaderVariants(headers, XAI_CLIENT_VERSION_HEADER);
    deleteHeaderVariants(headers, 'x-grok-source');

    setHeaderIfMissing(headers, 'openai-beta', XAI_RESPONSES_HTTP_BETA);

    // Ensure conversation ID is still set for WebSocket (matching applyXAIWebsocketHeaders)
    setHeaderIfMissing(headers, XAI_CONV_ID_HEADER, sessionId);

    return headers;
  }

  /**
   * Resolve WebSocket base URL.
   *
   * Aligned with CLIProxyAPI: WebSocket MUST use api.x.ai — cli-chat-proxy
   * only accepts HTTP POST and returns 405 for WebSocket upgrade requests.
   */
  protected override resolveWebSocketBaseUrl(client: OpenAI): string {
    if (isRawBaseUrlEnabled(this.config)) {
      return client.baseURL;
    }
    // Always use the official API for WebSocket (never cli-chat-proxy)
    return XAI_DEFAULT_API_BASE_URL;
  }

  // IMPORTANT: We intentionally do NOT override createClient().
  // The parent OpenAIResponsesProvider.createClient uses this.baseUrl (resolved
  // by resolveBaseUrl above) and the headers from buildHeaders. This ensures
  // HTTP requests hit cli-chat-proxy and WebSocket connects to api.x.ai.

  protected generateSessionId(): string {
    return randomUUID();
  }
}
