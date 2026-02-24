import { ApiProvider } from '../interface';
import { OpenAIChatCompletionProvider } from '../openai/chat-completion-client';

/**
 * Kilo Code Provider
 *
 * Uses the Kilo Gateway API which is OpenAI-compatible.
 * Extends OpenAIChatCompletionProvider for type safety.
 * @see https://kilo.ai/docs/gateway/api-reference
 */
export class KiloCodeProvider
  extends OpenAIChatCompletionProvider
  implements ApiProvider
{
  constructor(protected readonly config: import('../../types').ProviderConfig) {
    super(config);
  }

  protected resolveBaseUrl(
    config: import('../../types').ProviderConfig,
  ): string {
    // Kilo Gateway API base URL - no /v1 suffix needed as it's already at /api/gateway
    return config.baseUrl;
  }
}
