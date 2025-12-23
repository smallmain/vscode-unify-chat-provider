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
  {
    name: 'ZhiPu AI',
    type: 'openai-chat-completion',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: wellKnowns('glm-4.7', 'glm-4.6v', 'glm-4.5-air', 'codegeex-4'),
  },
  {
    name: 'ZhiPu AI (Coding Plan)',
    type: 'openai-chat-completion',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    models: wellKnowns('glm-4.7', 'glm-4.6', 'glm-4.5-air'),
  },
  {
    name: 'Z.AI',
    type: 'openai-chat-completion',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    models: wellKnowns('glm-4.7', 'glm-4.6v', 'glm-4.5-air', 'codegeex-4'),
  },
  {
    name: 'Z.AI (Coding Plan)',
    type: 'openai-chat-completion',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    models: wellKnowns('glm-4.7', 'glm-4.6', 'glm-4.5-air'),
  },
  {
    name: 'MiniMax (China)',
    type: 'anthropic',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    models: wellKnowns('MiniMax-M2.1', 'MiniMax-M2.1-lightning'),
  },
  {
    name: 'MiniMax (International)',
    type: 'anthropic',
    baseUrl: 'https://api.minimax.io/anthropic',
    models: wellKnowns('MiniMax-M2.1', 'MiniMax-M2.1-lightning'),
  },
];

function wellKnowns(...ids: WellKnownModelId[]): ModelConfig[] {
  return WELL_KNOWN_MODELS.filter((m) =>
    ids.includes(m.id as WellKnownModelId),
  ).map((m) => ({
    ...m,
  }));
}
