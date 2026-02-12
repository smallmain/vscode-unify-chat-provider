import { createHmac, randomUUID } from 'node:crypto';
import type { LanguageModelChatRequestMessage } from 'vscode';
import type { AuthTokenInfo } from '../../auth/types';
import type { ModelConfig } from '../../types';
import { getToken } from '../utils';
import { OpenAIChatCompletionProvider } from '../openai/chat-completion-client';

const IFLOW_USER_AGENT = 'iFlow-Cli';

export class IFlowCLIProvider extends OpenAIChatCompletionProvider {
  protected override buildHeaders(
    credential?: AuthTokenInfo,
    modelConfig?: ModelConfig,
    messages?: readonly LanguageModelChatRequestMessage[],
  ): Record<string, string> {
    const headers = super.buildHeaders(credential, modelConfig, messages);

    const token = getToken(credential)?.trim();
    if (!token) {
      return headers;
    }

    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'user-agent') {
        delete headers[key];
      }
    }
    headers['User-Agent'] = IFLOW_USER_AGENT;

    const sessionId = `session-${randomUUID()}`;
    const timestamp = Date.now();
    const payload = `${IFLOW_USER_AGENT}:${sessionId}:${timestamp}`;

    headers['session-id'] = sessionId;
    headers['x-iflow-timestamp'] = String(timestamp);
    headers['x-iflow-signature'] = createHmac('sha256', token)
      .update(payload, 'utf8')
      .digest('hex');

    return headers;
  }
}
