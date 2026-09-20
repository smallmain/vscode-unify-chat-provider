import { createHash, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { getBaseModelId } from '../../model-id-utils';
import type { ChatRequestTrace, ModelConfig, ProviderConfig } from '../../types';

const SESSION_HEADER = 'x-opencode-session';
// A request trace survives retries and transport changes, but is never persisted.
const requestSessions = new WeakMap<ChatRequestTrace, Map<string, string>>();

function isOpenCodeApi(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'opencode.ai' &&
      (url.pathname === '/zen' || url.pathname.startsWith('/zen/'))
    );
  } catch {
    return false;
  }
}

export function deriveOpenCodeSessionId(
  modelId: string,
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): string {
  for (const message of messages) {
    if (message.role !== vscode.LanguageModelChatMessageRole.User) continue;
    const anchor = message.content
      .map((part) =>
        part instanceof vscode.LanguageModelTextPart ? part.value : '',
      )
      .join('');
    if (!anchor.trim()) continue;

    // Follow opencode-go-copilot#119: model ID + first user text, formatted
    // as a UUID. This is a history-based routing hint, not a unique chat ID.
    const hex = createHash('sha256')
      .update(modelId)
      .update(anchor)
      .digest('hex')
      .slice(0, 32);
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join('-');
  }
  return randomUUID();
}

function configuredSessionHeaderKey(
  headers: Record<string, string> | undefined,
): string | undefined {
  return Object.keys(headers ?? {})
    .reverse()
    .find((key) =>
      key.toLowerCase() === SESSION_HEADER && headers?.[key]?.trim(),
    );
}

export function applyOpenCodeSessionHeader(
  headers: Record<string, string | null>,
  provider: ProviderConfig,
  model: ModelConfig,
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  requestTrace: ChatRequestTrace,
): void {
  if (!isOpenCodeApi(provider.baseUrl)) return;

  const configuredKey = configuredSessionHeaderKey(model.extraHeaders)
    ?? configuredSessionHeaderKey(provider.extraHeaders);
  const configuredValue = configuredKey
    ? headers[configuredKey]?.trim()
    : undefined;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === SESSION_HEADER) delete headers[key];
  }
  if (configuredValue) {
    headers[SESSION_HEADER] = configuredValue;
    return;
  }

  let sessions = requestSessions.get(requestTrace);
  if (!sessions) {
    sessions = new Map();
    requestSessions.set(requestTrace, sessions);
  }
  const modelId = getBaseModelId(model.id);
  let sessionId = sessions.get(modelId);
  if (!sessionId) {
    sessionId = deriveOpenCodeSessionId(modelId, messages);
    sessions.set(modelId, sessionId);
  }
  headers[SESSION_HEADER] = sessionId;
}
