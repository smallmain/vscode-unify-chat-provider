import type { ModelConfig, ProviderConfig } from '../types';
import { mergeWithWellKnownModels } from './models';

type OpenCodeService = 'zen' | 'go';

export type OpenCodeModelProtocol =
  | 'chat-completions'
  | 'responses'
  | 'messages'
  | 'google';

const PROVIDER_PROTOCOLS: Partial<
  Record<ProviderConfig['type'], OpenCodeModelProtocol>
> = {
  'openai-chat-completion': 'chat-completions',
  'openai-responses': 'responses',
  anthropic: 'messages',
  'google-ai-studio': 'google',
};

function getOpenCodeService(baseUrl: string): OpenCodeService | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }

  if (url.hostname.toLowerCase() !== 'opencode.ai') {
    return undefined;
  }

  const path = url.pathname.toLowerCase().replace(/\/+$/, '');
  if (path === '/zen/go' || path.startsWith('/zen/go/')) {
    return 'go';
  }
  if (path === '/zen' || path.startsWith('/zen/')) {
    return 'zen';
  }
  return undefined;
}

function classifyOpenCodeModel(
  modelId: string,
  service: OpenCodeService,
): OpenCodeModelProtocol {
  const id = modelId.trim().toLowerCase();

  if (/^(?:gpt|grok|muse)-/.test(id)) {
    return 'responses';
  }
  if (/^(?:claude|qwen)/.test(id)) {
    return 'messages';
  }
  if (service === 'go' && id.startsWith('minimax-')) {
    return 'messages';
  }
  if (service === 'zen' && id.startsWith('gemini-')) {
    return 'google';
  }
  return 'chat-completions';
}

function addFreeTierLabel(model: ModelConfig): ModelConfig {
  if (!model.id.toLowerCase().endsWith('-free') || !model.name) {
    return model;
  }

  const name = model.name.trim();
  if (!name || /\bfree\b/i.test(name)) {
    return model;
  }
  return { ...model, name: `${name} (Free)` };
}

/**
 * OpenCode exposes one combined `/models` catalog for all wire protocols.
 * Select the models compatible with the configured provider before enriching
 * them with the shared well-known metadata.
 */
export function prepareOfficialModels(
  rawModels: ModelConfig[],
  provider: ProviderConfig,
): ModelConfig[] {
  const service = getOpenCodeService(provider.baseUrl);
  const providerProtocol = PROVIDER_PROTOCOLS[provider.type];
  const selectedModels =
    service && providerProtocol
      ? rawModels.filter(
          (model) =>
            classifyOpenCodeModel(model.id, service) === providerProtocol,
        )
      : rawModels;
  const mergedModels = mergeWithWellKnownModels(selectedModels, provider);

  return service ? mergedModels.map(addFreeTierLabel) : mergedModels;
}
