import type { AuthMethod } from '../auth';
import type { ProviderConfig, ModelConfig } from '../types';
import type { WellKnownAuthPresetId } from './auths';
import {
  WellKnownModelId,
  WELL_KNOWN_MODELS,
  normalizeWellKnownConfigs,
} from './models';

export type WellKnownProviderConfig = Omit<ProviderConfig, 'auth'> & {
  authTypes?: WellKnownAuthTypeId[];
};

export type WellKnownAuthTypeId = AuthMethod | WellKnownAuthPresetId;

export const WELL_KNOWN_PROVIDERS: WellKnownProviderConfig[] = [
  {
    name: 'Open AI',
    type: 'openai-responses',
    baseUrl: 'https://api.openai.com',
    authTypes: ['api-key'],
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
    name: 'OpenAI CodeX (ChatGPT Plus/Pro)',
    type: 'openai-codex',
    baseUrl: 'https://chatgpt.com/backend-api/codex/responses',
    authTypes: ['openai-codex'],
    models: wellKnowns(
      'gpt-5.1-codex-max',
      'gpt-5.1-codex-mini',
      'gpt-5.2',
      'gpt-5.2-codex',
    ),
  },
  {
    name: 'Google AI Studio',
    type: 'google-ai-studio',
    baseUrl: 'https://generativelanguage.googleapis.com',
    authTypes: ['api-key'],
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
    name: 'Google Antigravity',
    type: 'google-antigravity',
    baseUrl: 'https://daily-cloudcode-pa.sandbox.googleapis.com',
    authTypes: ['antigravity-oauth'],
    models: wellKnowns(
      'gemini-3-pro',
      'gemini-3-flash',
      'claude-sonnet-4-5',
      'claude-opus-4-5',
    ),
  },
  {
    name: 'Google Gemini CLI',
    type: 'google-gemini-cli',
    baseUrl: 'https://cloudcode-pa.googleapis.com',
    authTypes: ['antigravity-oauth'],
    models: wellKnowns(
      'gemini-3-pro-preview',
      'gemini-3-flash-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
    ),
  },
  {
    name: 'Google Vertex AI',
    type: 'google-vertex-ai',
    baseUrl:
      'https://<location>-aiplatform.googleapis.com/v1/projects/<project>/locations/<location>',
    authTypes: ['google-vertex-ai-auth'],
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
    authTypes: ['api-key'],
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
    authTypes: ['api-key'],
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
    authTypes: ['api-key'],
    models: [],
  },
  {
    name: 'OpenRouter',
    type: 'openai-chat-completion',
    baseUrl: 'https://openrouter.ai/api/v1',
    authTypes: ['api-key'],
    models: [],
  },
  {
    name: 'Cerebras',
    type: 'openai-chat-completion',
    baseUrl: 'https://api.cerebras.ai',
    authTypes: ['api-key'],
    extraBody: {
      reasoning_format: 'parsed',
    },
    models: [
      // TODO
    ],
  },
  {
    name: 'OpenCode Zen (OpenAI Chat Completion)',
    type: 'openai-chat-completion',
    baseUrl: 'https://opencode.ai/zen',
    authTypes: ['api-key'],
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
    authTypes: ['api-key'],
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
    authTypes: ['api-key'],
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
    authTypes: ['api-key'],
    models: wellKnowns('gemini-3-pro', 'gemini-3-flash'),
  },
  {
    name: 'Nvidia',
    type: 'openai-chat-completion',
    baseUrl: 'https://integrate.api.nvidia.com',
    authTypes: ['api-key'],
    models: [],
  },
  {
    name: 'Alibaba Cloud Model Studio (China)',
    type: 'openai-chat-completion',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    authTypes: ['api-key'],
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
    authTypes: ['api-key'],
    models: wellKnowns('qwen3-coder-plus'),
  },
  {
    name: 'Alibaba Cloud Model Studio (International)',
    type: 'openai-chat-completion',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    authTypes: ['api-key'],
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
    authTypes: ['api-key'],
    models: [],
  },
  {
    name: 'Volcano Engine',
    type: 'openai-responses',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    authTypes: ['api-key'],
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
    authTypes: ['api-key'],
    models: wellKnowns('doubao-seed-code-preview-latest', 'ark-code-latest'),
  },
  {
    name: 'Byte Plus',
    type: 'openai-responses',
    baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
    authTypes: ['api-key'],
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
    authTypes: ['api-key'],
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
    authTypes: ['api-key'],
    models: wellKnowns('deepseek-chat', 'deepseek-reasoner'),
  },
  {
    name: 'Xiaomi MIMO',
    type: 'openai-chat-completion',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    authTypes: ['api-key'],
    models: wellKnowns('mimo-v2-flash'),
  },
  {
    name: 'Ollama Local',
    type: 'ollama',
    baseUrl: 'http://localhost:11434/api',
    authTypes: ['none'],
    models: [],
    autoFetchOfficialModels: true,
  },
  {
    name: 'Ollama Cloud',
    type: 'ollama',
    baseUrl: 'https://ollama.com/api',
    authTypes: ['api-key'],
    models: [],
  },
  {
    name: 'ZhiPu AI',
    type: 'openai-chat-completion',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    authTypes: ['api-key'],
    models: wellKnowns(
      'glm-4.7',
      'glm-4.6v',
      'glm-4.7-flashx',
      'glm-4.7-flash',
      'codegeex-4',
    ),
  },
  {
    name: 'ZhiPu AI (Coding Plan)',
    type: 'openai-chat-completion',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    authTypes: ['api-key'],
    models: wellKnowns('glm-4.7', 'glm-4.6', 'glm-4.7-flashx', 'glm-4.7-flash'),
  },
  {
    name: 'Z.AI',
    type: 'openai-chat-completion',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    authTypes: ['api-key'],
    models: wellKnowns(
      'glm-4.7',
      'glm-4.6v',
      'glm-4.7-flashx',
      'glm-4.7-flash',
      'codegeex-4',
    ),
  },
  {
    name: 'Z.AI (Coding Plan)',
    type: 'openai-chat-completion',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    authTypes: ['api-key'],
    models: wellKnowns('glm-4.7', 'glm-4.6', 'glm-4.7-flashx', 'glm-4.7-flash'),
  },
  {
    name: 'MiniMax (China)',
    type: 'anthropic',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    authTypes: ['api-key'],
    models: wellKnowns('MiniMax-M2.1', 'MiniMax-M2.1-lightning'),
  },
  {
    name: 'MiniMax (International)',
    type: 'anthropic',
    baseUrl: 'https://api.minimax.io/anthropic',
    authTypes: ['api-key'],
    models: wellKnowns('MiniMax-M2.1', 'MiniMax-M2.1-lightning'),
  },
  {
    name: 'LongCat',
    type: 'anthropic',
    baseUrl: 'https://api.longcat.chat/anthropic',
    authTypes: ['api-key'],
    models: wellKnowns(
      'LongCat-Flash-Chat',
      'LongCat-Flash-Thinking',
      'LongCat-Flash-Thinking-2601',
    ),
  },
  {
    name: 'Moonshot AI (China)',
    type: 'openai-chat-completion',
    baseUrl: 'https://api.moonshot.cn',
    authTypes: ['api-key'],
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
    authTypes: ['api-key'],
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
    authTypes: ['api-key'],
    models: wellKnowns('kimi-for-coding'),
  },
  {
    name: 'StreamLake Vanchin (China)',
    type: 'openai-chat-completion',
    baseUrl: 'https://wanqing.streamlakeapi.com/api/gateway/v1/endpoints',
    authTypes: ['api-key'],
    models: wellKnowns(
      'kat-coder-pro-v1',
      'kat-coder-exp-72b-1010',
      'kat-coder-air-v1',
    ),
  },
  {
    name: 'StreamLake Vanchin (China, Coding Plan)',
    type: 'anthropic',
    baseUrl:
      'https://wanqing.streamlakeapi.com/api/gateway/coding/kat-coder-pro-v1/claude-code-proxy',
    authTypes: ['api-key'],
    models: wellKnowns('kat-coder-pro-v1'),
  },
  {
    name: 'StreamLake Vanchin (International)',
    type: 'openai-chat-completion',
    baseUrl: 'https://vanchin.streamlake.ai/api/gateway/v1/endpoints',
    authTypes: ['api-key'],
    models: wellKnowns(
      'kat-coder-pro-v1',
      'kat-coder-exp-72b-1010',
      'kat-coder-air-v1',
    ),
  },
  {
    name: 'StreamLake Vanchin (International, Coding Plan)',
    type: 'anthropic',
    baseUrl:
      'https://vanchin.streamlake.ai/api/gateway/coding/kat-coder-pro-v1/claude-code-proxy',
    authTypes: ['api-key'],
    models: wellKnowns('kat-coder-pro-v1'),
  },
];

function wellKnowns(...ids: WellKnownModelId[]): ModelConfig[] {
  const idSet = new Set<string>(ids);
  const declaredIds = new Map<string, string>();
  const matched = WELL_KNOWN_MODELS.filter((m) => {
    if (idSet.has(m.id)) {
      return true;
    }
    const matchedAltId = m.alternativeIds?.find((altId) => idSet.has(altId));
    if (matchedAltId) {
      declaredIds.set(m.id, matchedAltId);
      return true;
    }
    return false;
  });
  return normalizeWellKnownConfigs(matched, declaredIds);
}
