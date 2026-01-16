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
      'gpt-oss-120b',
      'gpt-oss-20b',
    ),
  },
  {
    name: 'Google AI Studio',
    type: 'google-ai-studio',
    baseUrl: 'https://generativelanguage.googleapis.com',
    models: wellKnowns(
      'gemini-3-pro-preview',
      'gemini-3-flash-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
    ),
  },
  {
    name: 'Google Vertex AI',
    type: 'google-vertex-ai',
    baseUrl:
      'https://<location>-aiplatform.googleapis.com/v1/projects/<project>/locations/<location>',
    models: wellKnowns(
      'gemini-3-pro-preview',
      'gemini-3-flash-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
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
    name: 'xAI',
    type: 'openai-responses',
    baseUrl: 'https://api.x.ai',
    models: wellKnowns(
      'grok-4',
      'grok-4-1-fast-reasoning',
      'grok-4-1-fast-non-reasoning',
      'grok-code-fast-1',
    ),
  },
  {
    name: 'Hugging Face (Inference Providers)',
    type: 'openai-chat-completion',
    baseUrl: 'https://router.huggingface.co/v1',
    models: [],
  },
  {
    name: 'OpenRouter',
    type: 'openai-chat-completion',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [],
  },
  {
    name: 'OpenCode Zen (OpenAI Chat Completion)',
    type: 'openai-chat-completion',
    baseUrl: 'https://opencode.ai/zen',
    models: wellKnowns(
      'glm-4.6',
      'glm-4.7-free',
      'kimi-k2',
      'kimi-k2-thinking',
      'qwen3-coder',
      'grok-code',
      'big-pickle',
    ),
  },
  {
    name: 'OpenCode Zen (OpenAI Responses)',
    type: 'openai-responses',
    baseUrl: 'https://opencode.ai/zen',
    models: wellKnowns(
      'gpt-5.2',
      'gpt-5.2-codex',
      'gpt-5.1',
      'gpt-5.1-codex',
      'gpt-5.1-codex-max',
      'gpt-5.1-codex-mini',
      'gpt-5',
      'gpt-5-codex',
      'gpt-5-nano',
    ),
  },
  {
    name: 'OpenCode Zen (Anthropic Messages)',
    type: 'anthropic',
    baseUrl: 'https://opencode.ai/zen',
    models: wellKnowns(
      'claude-opus-4-5',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
      'claude-sonnet-4',
      'claude-3-5-haiku',
      'minimax-m2.1-free',
    ),
  },
  {
    name: 'OpenCode Zen (Gemini)',
    type: 'google-ai-studio',
    baseUrl: 'https://opencode.ai/zen',
    models: wellKnowns('gemini-3-pro', 'gemini-3-flash'),
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
    name: 'Alibaba Cloud Model Studio (Coding Plan)',
    type: 'anthropic',
    baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    models: wellKnowns('qwen3-coder-plus'),
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
      'doubao-seed-1-8-251228',
      'doubao-seed-code-preview-251028',
      'doubao-seed-1-6-lite-251015',
      'doubao-seed-1-6-flash-250828',
      'doubao-seed-1-6-vision-250815',
    ),
  },
  {
    name: 'Volcano Engine (Coding Plan)',
    type: 'openai-responses',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    models: wellKnowns('doubao-seed-code-preview-latest', 'ark-code-latest'),
  },
  {
    name: 'Byte Plus',
    type: 'openai-responses',
    baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
    models: wellKnowns(
      'doubao-seed-1-8-251228',
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
