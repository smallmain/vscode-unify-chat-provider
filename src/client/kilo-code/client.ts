import { OpenAIChatCompletionProvider } from '../openai/chat-completion-client';
import { buildBaseUrl } from '../utils';

/**
 * Kilo Code Provider
 *
 * Uses the Kilo Gateway API which is OpenAI-compatible.
 * Extends OpenAIChatCompletionProvider for type safety.
 * @see https://kilo.ai/docs/gateway/api-reference
 */
export class KiloCodeProvider extends OpenAIChatCompletionProvider {
  protected override resolveBaseUrl(
    config: import('../../types').ProviderConfig,
  ): string {
    // Kilo Gateway API base URL - no /v1 suffix needed as it's already at /api/gateway
    return buildBaseUrl(config.baseUrl);
  }
}
