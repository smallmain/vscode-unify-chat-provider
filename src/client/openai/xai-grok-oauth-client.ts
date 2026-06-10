import OpenAI from 'openai';
import * as vscode from 'vscode';
import type { AuthTokenInfo } from '../../auth/types';
import {
  isRawBaseUrlEnabled,
} from '../../utils';
import type { ModelConfig } from '../../types';
import { getToken } from '../utils';
import { OpenAIResponsesProvider } from './responses-client';
import { randomUUID } from 'crypto';

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

export class XaiGrokOAuthProvider extends OpenAIResponsesProvider {
  protected override buildHeaders(
    sessionId: string,
    credential?: AuthTokenInfo,
    modelConfig?: ModelConfig,
    _messages?: readonly vscode.LanguageModelChatRequestMessage[],
  ): Record<string, string> {
    const headers = super.buildHeaders(sessionId, credential, modelConfig);

    // Sanitize like codex + opencode grok plugin: remove anything that would send the oauth token as api-key
    deleteHeaderVariants(headers, 'x-api-key');
    deleteHeaderVariants(headers, 'openai-organization');
    deleteHeaderVariants(headers, 'openai-project');
    deleteHeaderVariants(headers, 'x-stainless-');

    const auth = this.config.auth;
    if (auth?.method === 'xai-grok-oauth') {
      // Ensure pure Bearer (the credential value is the oauth access token)
      const token = getToken(credential);
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      // Add source header similar to opencode plugin
      setHeaderIfMissing(headers, 'x-grok-source', XAI_GROK_SOURCE);
    }

    return headers;
  }

  protected override buildWebSocketHeaders(
    sessionId: string,
    credential?: AuthTokenInfo,
    modelConfig?: ModelConfig,
    messages?: readonly vscode.LanguageModelChatRequestMessage[],
  ): Record<string, string> {
    const headers = this.buildHeaders(sessionId, credential, modelConfig, messages);
    deleteHeaderVariants(headers, 'x-api-key');
    deleteHeaderVariants(headers, 'openai-beta');
    setHeaderIfMissing(headers, 'openai-beta', XAI_RESPONSES_HTTP_BETA);
    return headers;
  }

  // IMPORTANT: We intentionally do NOT override createClient().
  // This class relies on the parent OpenAIResponsesProvider.createClient behavior.
  // Header sanitization (no x-api-key + forced Bearer for OAuth) is handled in buildHeaders above.
  // This makes the dedicated "xAI Grok OAuth" well-known provider behave the same as
  // using the regular xAI well-known + switching its auth to xai-grok-oauth (the combination
  // the user reported as working).

  protected generateSessionId(): string {
    return randomUUID();
  }

  protected override resolveWebSocketBaseUrl(client: OpenAI): string {
    if (isRawBaseUrlEnabled(this.config)) {
      return client.baseURL;
    }
    // xAI uses standard /v1 , no special codex rewrite needed
    return client.baseURL;
  }
}