import { ProviderConfig, ModelConfig } from '../types';
import {
  WellKnownModelId,
  WELL_KNOWN_MODELS,
  normalizeWellKnownConfigs,
} from './models';

export const WELL_KNOWN_PROVIDERS: ProviderConfig[] = [
  {
    name: 'Open AI',
    type: 'openai-responses',
    baseUrl: 'https://api.openai.com',
    models: wellKnowns(
      'gpt-5.2',
      'gpt-5.1',
      'gpt-5',
      'gpt-5-mini',
      'gpt-5.2-pro',
      'gpt-5-nano',
      'gpt-4.1',
    ),
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
    name: 'Hugging Face (Inference Providers)',
    type: 'openai-chat-completion',
    baseUrl: 'https://router.huggingface.co/v1',
    models: [],
  },
  {
    name: 'Alibaba Cloud Model Studio (China)',
    type: 'openai-chat-completion',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: wellKnowns(
      'qwen3-max',
      'qwen-plus',
      'qwen3-coder-plus',
      'qwen3-coder-flash',
    ),
  },
  {
    name: 'Alibaba Cloud Model Studio (International)',
    type: 'openai-chat-completion',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    models: wellKnowns(
      'qwen3-max',
      'qwen-plus',
      'qwen3-coder-plus',
      'qwen3-coder-flash',
    ),
  },
  {
    name: 'Model Scope (API-Inference)',
    type: 'openai-chat-completion',
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    models: [],
  },
  {
    name: 'Volcano Engine',
    type: 'openai-responses',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: wellKnowns(
      'doubao-seed-1-8-251215',
      'doubao-seed-code-preview-251028',
      'doubao-seed-1-6-lite-251015',
      'doubao-seed-1-6-flash-250828',
      'doubao-seed-1-6-vision-250815',
    ),
  },
  {
    name: 'Byte Plus',
    type: 'openai-responses',
    baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
    models: wellKnowns(
      'doubao-seed-1-8-251215',
      'doubao-seed-code-preview-251028',
      'doubao-seed-1-6-lite-251015',
      'doubao-seed-1-6-flash-250828',
      'doubao-seed-1-6-vision-250815',
    ),
  },
  {
    name: 'Tencent Cloud (China)',
    type: 'openai-chat-completion',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    models: wellKnowns(
      'hunyuan-2.0-thinking-20251109',
      'hunyuan-2.0-instruct-20251111',
      'hunyuan-vision-1.5-instruct',
    ),
  },
  {
    name: 'DeepSeek',
    type: 'openai-chat-completion',
    baseUrl: 'https://api.deepseek.com',
    models: wellKnowns('deepseek-chat', 'deepseek-reasoner'),
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
    baseUrl: 'http://localhost:11434/api',
    models: [],
    autoFetchOfficialModels: true,
  },
  {
    name: 'Ollama Cloud',
    type: 'ollama',
    baseUrl: 'https://ollama.com/api',
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
  {
    name: 'Moonshot AI (China)',
    type: 'openai-chat-completion',
    baseUrl: 'https://api.moonshot.cn',
    models: wellKnowns(
      'kimi-k2-thinking',
      'kimi-k2-thinking-turbo',
      'kimi-k2-0905-preview',
      'kimi-k2-turbo-preview',
    ),
  },
  {
    name: 'Moonshot AI (International)',
    type: 'openai-chat-completion',
    baseUrl: 'https://api.moonshot.ai',
    models: wellKnowns(
      'kimi-k2-thinking',
      'kimi-k2-thinking-turbo',
      'kimi-k2-0905-preview',
      'kimi-k2-turbo-preview',
    ),
  },
  {
    name: 'Moonshot AI (Coding Plan)',
    type: 'anthropic',
    baseUrl: 'https://api.kimi.com/coding',
    models: wellKnowns('kimi-for-coding'),
  },
];

function wellKnowns(...ids: WellKnownModelId[]): ModelConfig[] {
  const idSet = new Set<string>(ids);
  return normalizeWellKnownConfigs(
    WELL_KNOWN_MODELS.filter((m) => {
      if (idSet.has(m.id)) {
        return true;
      }
      return m.alternativeIds?.some((altId) => idSet.has(altId)) ?? false;
    }),
  );
}
