import { ProviderConfig, ModelConfig } from '../types';
import { WellKnownModelId, WELL_KNOWN_MODELS } from './models';

export const WELL_KNOWN_PROVIDERS: ProviderConfig[] = [
  {
    name: 'DeepSeek',
    type: 'openai-chat-completion',
    baseUrl: 'https://api.deepseek.com',
    models: wellKnowns('deepseek-chat', 'deepseek-reasoner'),
  },
  {
    name: 'Anthropic',
    type: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    models: wellKnowns(
      'claude-opus-4-5',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
    ),
  },
  {
    name: 'Xiaomi MIMO',
    type: 'openai-chat-completion',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    models: wellKnowns('mimo-v2-flash'),
  },
  {
    name: 'Ollama Local',
    type: 'ollama',
    baseUrl: 'http://localhost:11434',
    models: [],
  },
];

function wellKnowns(...ids: WellKnownModelId[]): ModelConfig[] {
  return WELL_KNOWN_MODELS.filter((m) =>
    ids.includes(m.id as WellKnownModelId),
  ).map((m) => ({
    ...m,
  }));
}
