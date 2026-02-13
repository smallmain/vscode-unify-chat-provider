import type { ModelConfig, ProviderConfig } from '../types';
import type { ProviderPattern } from '../client/types';
import { matchProvider } from '../client/utils';

/**
 * Well-known models configuration
 */
const _WELL_KNOWN_MODELS = [
  {
    id: 'doubao-seed-1-8-251228',
    overrides: ['doubao-seed-1.8'],
    name: 'Doubao Seed 1.8',
    maxInputTokens: 256000,
    maxOutputTokens: 32000,
    stream: true,
    thinking: {
      type: 'enabled',
      effort: 'high',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'doubao-seed-code-preview-251028',
    overrides: [
      'doubao-seed-code',
      'doubao-seed-code-preview',
      'doubao-seed-code-preview-latest',
    ],
    name: 'Doubao Seed Code Preview',
    maxInputTokens: 256000,
    maxOutputTokens: 32000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'doubao-seed-1-6-lite-251015',
    overrides: ['doubao-seed-1.6-lite'],
    name: 'Doubao Seed 1.6 Lite',
    maxInputTokens: 256000,
    maxOutputTokens: 32000,
    stream: true,
    thinking: {
      type: 'auto',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'doubao-seed-1-6-flash-250828',
    overrides: ['doubao-seed-1.6-flash'],
    name: 'Doubao Seed 1.6 Flash',
    maxInputTokens: 256000,
    maxOutputTokens: 32000,
    stream: true,
    thinking: {
      type: 'auto',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'doubao-seed-1-6-vision-250815',
    overrides: ['doubao-seed-1.6-vision'],
    name: 'Doubao Seed 1.6 Vision',
    maxInputTokens: 256000,
    maxOutputTokens: 32000,
    stream: true,
    thinking: {
      type: 'auto',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'doubao-seed-1-6-251015',
    overrides: ['doubao-seed-1.6'],
    name: 'Doubao Seed 1.6',
    maxInputTokens: 256000,
    maxOutputTokens: 32000,
    stream: true,
    thinking: {
      type: 'auto',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'doubao-seed-1-6-250615',
    overrides: ['doubao-seed-1.6'],
    name: 'Doubao Seed 1.6',
    maxInputTokens: 256000,
    maxOutputTokens: 32000,
    stream: true,
    thinking: {
      type: 'auto',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'doubao-seed-1-6-flash-250615',
    overrides: ['doubao-seed-1.6-flash'],
    name: 'Doubao Seed 1.6 Flash',
    maxInputTokens: 256000,
    maxOutputTokens: 32000,
    stream: true,
    thinking: {
      type: 'auto',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'doubao-1-5-pro-32k-250115',
    overrides: ['doubao-1.5-pro-32k'],
    name: 'Doubao 1.5 Pro 32k',
    maxInputTokens: 128000,
    maxOutputTokens: 16000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'doubao-1-5-pro-32k-character-250228',
    overrides: ['doubao-1.5-pro-32k-character'],
    name: 'Doubao 1.5 Pro 32k Character',
    maxInputTokens: 32000,
    maxOutputTokens: 12000,
    stream: true,
    capabilities: {
      toolCalling: false,
      imageInput: false,
    },
  },
  {
    id: 'doubao-1-5-pro-32k-character-250715',
    overrides: ['doubao-1.5-pro-32k-character'],
    name: 'Doubao 1.5 Pro 32k Character',
    maxInputTokens: 32000,
    maxOutputTokens: 12000,
    stream: true,
    capabilities: {
      toolCalling: false,
      imageInput: false,
    },
  },
  {
    id: 'doubao-1-5-lite-32k-250115',
    overrides: ['doubao-1.5-lite-32k'],
    name: 'Doubao 1.5 Lite 32k',
    maxInputTokens: 32000,
    maxOutputTokens: 12000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'doubao-lite-32k-character-250228',
    overrides: ['doubao-lite-32k-character'],
    name: 'Doubao Lite 32k Character',
    maxInputTokens: 32000,
    maxOutputTokens: 4000,
    stream: true,
    capabilities: {
      toolCalling: false,
      imageInput: false,
    },
  },
  {
    id: 'claude-opus-4-6',
    overrides: ['claude-opus-4.6', 'claude-opus-4-6-thinking'],
    name: 'Claude Opus 4.6',
    maxInputTokens: 200000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'auto',
      effort: 'xhigh',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'claude-opus-4-5',
    overrides: ['claude-opus-4.5', 'claude-opus-4-5-thinking'],
    name: 'Claude Opus 4.5',
    maxInputTokens: 200000,
    maxOutputTokens: 64000,
    stream: true,
    thinking: {
      type: 'enabled',
      budgetTokens: 32000,
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'claude-sonnet-4-5',
    overrides: ['claude-sonnet-4.5', 'claude-sonnet-4-5-thinking'],
    name: 'Claude Sonnet 4.5',
    maxInputTokens: 200000,
    maxOutputTokens: 64000,
    stream: true,
    thinking: {
      type: 'enabled',
      budgetTokens: 16000,
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'claude-haiku-4-5',
    overrides: ['claude-haiku-4.5'],
    name: 'Claude Haiku 4.5',
    maxInputTokens: 200000,
    maxOutputTokens: 64000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'claude-opus-4-1',
    overrides: ['claude-opus-4.1'],
    name: 'Claude Opus 4.1',
    maxInputTokens: 200000,
    maxOutputTokens: 32000,
    stream: true,
    thinking: {
      type: 'enabled',
      budgetTokens: 10000,
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'claude-sonnet-4',
    name: 'Claude Sonnet 4',
    maxInputTokens: 200000,
    maxOutputTokens: 64000,
    stream: true,
    thinking: {
      type: 'enabled',
      budgetTokens: 10000,
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'claude-3-7-sonnet',
    overrides: ['claude-3.7-sonnet'],
    name: 'Claude Sonnet 3.7',
    maxInputTokens: 200000,
    maxOutputTokens: 64000,
    stream: true,
    thinking: {
      type: 'enabled',
      budgetTokens: 10000,
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'claude-opus-4',
    name: 'Claude Opus 4',
    maxInputTokens: 200000,
    maxOutputTokens: 32000,
    stream: true,
    thinking: {
      type: 'enabled',
      budgetTokens: 10000,
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'claude-3-5-sonnet',
    overrides: ['claude-3.5-sonnet'],
    name: 'Claude Sonnet 3.5',
    maxInputTokens: 200000,
    maxOutputTokens: 8192,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'claude-3-5-haiku',
    overrides: ['claude-3.5-haiku'],
    name: 'Claude Haiku 3.5',
    maxInputTokens: 200000,
    maxOutputTokens: 8000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'claude-3-haiku',
    name: 'Claude Haiku 3',
    maxInputTokens: 200000,
    maxOutputTokens: 4000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'claude-3-opus',
    name: 'Claude Opus 3',
    maxInputTokens: 200000,
    maxOutputTokens: 4096,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-5.3-codex',
    name: 'GPT-5.3-Codex',
    maxInputTokens: 400000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
      effort: 'xhigh',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-5.2-codex',
    name: 'GPT-5.2-Codex',
    maxInputTokens: 400000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
      effort: 'xhigh',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-5.2',
    name: 'GPT-5.2',
    maxInputTokens: 400000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
      effort: 'xhigh',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-5.2-pro',
    name: 'GPT-5.2 pro',
    maxInputTokens: 400000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
      effort: 'xhigh',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-5.2-chat-latest',
    name: 'GPT-5.2 Chat',
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-5.1',
    name: 'GPT-5.1',
    maxInputTokens: 400000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
      effort: 'high',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-5',
    name: 'GPT-5',
    maxInputTokens: 400000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
      effort: 'high',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-5-mini',
    name: 'GPT-5 mini',
    maxInputTokens: 400000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-5-nano',
    name: 'GPT-5 nano',
    maxInputTokens: 400000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-5.1-codex',
    name: 'GPT-5.1-Codex',
    maxInputTokens: 400000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
      effort: 'high',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-5.1-codex-max',
    name: 'GPT-5.1-Codex-Max',
    maxInputTokens: 400000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
      effort: 'xhigh',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-5-codex',
    name: 'GPT-5-Codex',
    maxInputTokens: 400000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
      effort: 'high',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-5.1-codex-mini',
    name: 'GPT-5.1-Codex-mini',
    maxInputTokens: 400000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-5-pro',
    name: 'GPT-5 pro',
    maxInputTokens: 400000,
    maxOutputTokens: 272000,
    stream: true,
    thinking: {
      type: 'enabled',
      effort: 'high',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-5.1-chat-latest',
    name: 'GPT-5.1 Chat',
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-5-chat-latest',
    name: 'GPT-5 Chat',
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-4o-mini',
    name: 'GPT-4o mini',
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-4.1',
    name: 'GPT-4.1',
    maxInputTokens: 1047576,
    maxOutputTokens: 32768,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-4.1-mini',
    name: 'GPT-4.1 mini',
    maxInputTokens: 1047576,
    maxOutputTokens: 32768,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-4.1-nano',
    name: 'GPT-4.1 nano',
    maxInputTokens: 1047576,
    maxOutputTokens: 32768,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-oss-120b',
    overrides: [
      'gpt-oss:120b',
      'openai/gpt-oss-120b',
      {
        matchers: ['api.cerebras.ai'],
        config: {
          maxOutputTokens: 40000,
        },
      },
    ],
    name: 'GPT-OSS 120B',
    maxInputTokens: 131072,
    maxOutputTokens: 131072,
    stream: true,
    thinking: {
      type: 'enabled',
      effort: 'high',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'gpt-oss-20b',
    overrides: ['gpt-oss:20b', 'gpt-oss:latest', 'openai/gpt-oss-20b'],
    name: 'GPT-OSS 20B',
    maxInputTokens: 131072,
    maxOutputTokens: 131072,
    stream: true,
    thinking: {
      type: 'enabled',
      effort: 'high',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'codex-mini-latest',
    name: 'Codex mini',
    maxInputTokens: 200000,
    maxOutputTokens: 100000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'o1',
    name: 'o1',
    maxInputTokens: 200000,
    maxOutputTokens: 100000,
    stream: true,
    thinking: {
      type: 'enabled',
      effort: 'high',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'o1-pro',
    name: 'o1 pro',
    maxInputTokens: 200000,
    maxOutputTokens: 100000,
    stream: false,
    thinking: {
      type: 'enabled',
      effort: 'high',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'o1-mini',
    name: 'o1 mini',
    maxInputTokens: 128000,
    maxOutputTokens: 65536,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: false,
      imageInput: false,
    },
  },
  {
    id: 'o1-preview',
    name: 'o1 preview',
    maxInputTokens: 128000,
    maxOutputTokens: 32768,
    stream: true,
    thinking: {
      type: 'enabled',
      effort: 'high',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'o3',
    name: 'o3',
    maxInputTokens: 200000,
    maxOutputTokens: 100000,
    stream: true,
    thinking: {
      type: 'enabled',
      effort: 'high',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'o3-mini',
    name: 'o3 mini',
    maxInputTokens: 200000,
    maxOutputTokens: 100000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'o3-pro',
    name: 'o3 pro',
    maxInputTokens: 200000,
    maxOutputTokens: 100000,
    stream: false,
    thinking: {
      type: 'enabled',
      effort: 'high',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'o3-deep-research',
    name: 'o3 Deep Research',
    maxInputTokens: 200000,
    maxOutputTokens: 100000,
    stream: true,
    thinking: {
      type: 'enabled',
      effort: 'high',
    },
    capabilities: {
      toolCalling: false,
      imageInput: true,
    },
  },
  {
    id: 'o4-mini',
    name: 'o4 mini',
    maxInputTokens: 200000,
    maxOutputTokens: 100000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'o4-mini-deep-research',
    name: 'o4 mini Deep Research',
    maxInputTokens: 200000,
    maxOutputTokens: 100000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: false,
      imageInput: true,
    },
  },
  {
    id: 'gpt-4o-search-preview',
    name: 'GPT-4o Search Preview',
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
    stream: true,
    capabilities: {
      toolCalling: false,
      imageInput: false,
    },
  },
  {
    id: 'gpt-4o-mini-search-preview',
    name: 'GPT-4o mini Search Preview',
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
    stream: true,
    capabilities: {
      toolCalling: false,
      imageInput: false,
    },
  },
  {
    id: 'computer-use-preview',
    name: 'Computer Use Preview',
    maxInputTokens: 8192,
    maxOutputTokens: 1024,
    stream: false,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-4.5-preview',
    name: 'GPT-4.5 Preview',
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-4-turbo',
    name: 'GPT-4 Turbo',
    maxInputTokens: 128000,
    maxOutputTokens: 4096,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gpt-4-turbo-preview',
    name: 'GPT-4 Turbo Preview',
    maxInputTokens: 128000,
    maxOutputTokens: 4096,
    stream: false,
    capabilities: {
      toolCalling: false,
      imageInput: false,
    },
  },
  {
    id: 'gpt-4',
    name: 'GPT-4',
    maxInputTokens: 8192,
    maxOutputTokens: 8192,
    stream: true,
    capabilities: {
      toolCalling: false,
      imageInput: false,
    },
  },
  {
    id: 'gpt-3.5-turbo',
    name: 'GPT-3.5 Turbo',
    maxInputTokens: 16385,
    maxOutputTokens: 4096,
    stream: false,
    capabilities: {
      toolCalling: false,
      imageInput: false,
    },
  },
  {
    id: 'gpt-3.5-turbo-instruct',
    name: 'GPT-3.5 Turbo Instruct',
    maxInputTokens: 4096,
    maxOutputTokens: 4096,
    stream: false,
    capabilities: {
      toolCalling: false,
      imageInput: false,
    },
  },
  {
    id: 'babbage-002',
    name: 'babbage-002',
    maxOutputTokens: 16384,
    stream: false,
    capabilities: {
      toolCalling: false,
      imageInput: false,
    },
  },
  {
    id: 'davinci-002',
    name: 'davinci-002',
    maxOutputTokens: 16384,
    stream: false,
    capabilities: {
      toolCalling: false,
      imageInput: false,
    },
  },
  {
    id: 'MiniMax-M2.5',
    overrides: [
      'minimax-m2.5-free',
      'minimaxai/minimax-m2.5',
      {
        matchers: [
          'dashscope.aliyuncs.com',
          'dashscope-intl.aliyuncs.com',
          'api-inference.modelscope.cn',
        ],
        config: {
          maxOutputTokens: 32768,
        },
      },
    ],
    name: 'MiniMax-M2.5',
    maxInputTokens: 204800,
    maxOutputTokens: 102400,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    temperature: 1.0,
  },
  {
    id: 'MiniMax-M2.5-lightning',
    name: 'MiniMax-M2.5-Lightning',
    maxInputTokens: 204800,
    maxOutputTokens: 102400,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    temperature: 1.0,
  },
  {
    id: 'MiniMax-M2.1',
    overrides: [
      'minimax-m2.1-free',
      'minimaxai/minimax-m2.1',
      {
        matchers: [
          'dashscope.aliyuncs.com',
          'dashscope-intl.aliyuncs.com',
          'api-inference.modelscope.cn',
        ],
        config: {
          maxOutputTokens: 32768,
        },
      },
    ],
    name: 'MiniMax-M2.1',
    maxInputTokens: 204800,
    maxOutputTokens: 102400,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    temperature: 1.0,
  },
  {
    id: 'MiniMax-M2.1-lightning',
    name: 'MiniMax-M2.1-Lightning',
    maxInputTokens: 204800,
    maxOutputTokens: 102400,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    temperature: 1.0,
  },
  {
    id: 'MiniMax-M2',
    overrides: [
      'minimaxai/minimax-m2',
      {
        matchers: [
          'dashscope.aliyuncs.com',
          'dashscope-intl.aliyuncs.com',
          'api-inference.modelscope.cn',
        ],
        config: {
          maxOutputTokens: 32768,
        },
      },
    ],
    name: 'MiniMax-M2',
    maxInputTokens: 204800,
    maxOutputTokens: 102400,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    temperature: 1.0,
  },
  {
    id: 'deepseek-chat',
    name: 'DeepSeek Chat',
    maxInputTokens: 128000,
    maxOutputTokens: 8000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    temperature: 1.0,
  },
  {
    id: 'deepseek-reasoner',
    name: 'DeepSeek Reasoner',
    maxInputTokens: 128000,
    maxOutputTokens: 64000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    temperature: 1.0,
  },
  {
    id: 'deepseek-v3.2',
    overrides: ['ark-code-latest', 'deepseek-ai/deepseek-v3.2'],
    name: 'DeepSeek V3.2',
    maxInputTokens: 128000,
    maxOutputTokens: 8000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    temperature: 1.0,
  },
  {
    id: 'deepseek-v3.2-exp',
    name: 'DeepSeek V3.2 Exp',
    maxInputTokens: 128000,
    maxOutputTokens: 8000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    temperature: 1.0,
  },
  {
    id: 'deepseek-v3.2-speciale',
    name: 'DeepSeek V3.2 Speciale',
    maxInputTokens: 128000,
    maxOutputTokens: 8000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    temperature: 1.0,
  },
  {
    id: 'deepseek-v3.1',
    overrides: ['deepseek-ai/deepseek-v3.1'],
    name: 'DeepSeek V3.1',
    maxInputTokens: 128000,
    maxOutputTokens: 8000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    temperature: 1.0,
  },
  {
    id: 'deepseek-v3.1-terminus',
    overrides: ['deepseek-ai/deepseek-v3.1-terminus'],
    name: 'DeepSeek V3.1 Terminus',
    maxInputTokens: 128000,
    maxOutputTokens: 8000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    temperature: 1.0,
  },
  {
    id: 'deepseek-v3',
    name: 'DeepSeek V3',
    maxInputTokens: 128000,
    maxOutputTokens: 8000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    temperature: 1.0,
  },
  {
    id: 'deepseek-v3-0324',
    name: 'DeepSeek V3 (0324)',
    maxInputTokens: 128000,
    maxOutputTokens: 8000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    temperature: 1.0,
  },
  {
    id: 'deepseek-r1',
    overrides: ['deepseek-ai/deepseek-r1'],
    name: 'DeepSeek R1',
    maxInputTokens: 128000,
    maxOutputTokens: 32768,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    temperature: 0.6,
  },
  {
    id: 'deepseek-r1-0528',
    overrides: ['deepseek-ai/deepseek-r1-0528'],
    name: 'DeepSeek R1 (0528)',
    maxInputTokens: 128000,
    maxOutputTokens: 32768,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    temperature: 0.6,
  },
  {
    id: 'deepseek-v2',
    name: 'DeepSeek V2',
    maxInputTokens: 128000,
    maxOutputTokens: 8000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    temperature: 1.0,
  },
  {
    id: 'deepseek-v2.5',
    name: 'DeepSeek V2.5',
    maxInputTokens: 128000,
    maxOutputTokens: 8000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    temperature: 1.0,
  },
  {
    id: 'deepseek-coder',
    name: 'DeepSeek Coder',
    maxInputTokens: 16384,
    maxOutputTokens: 4096,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    temperature: 1.0,
  },
  {
    id: 'deepseek-coder-v2',
    name: 'DeepSeek Coder V2',
    maxInputTokens: 128000,
    maxOutputTokens: 8000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    temperature: 1.0,
  },
  {
    id: 'deepseek-math-v2',
    name: 'DeepSeek Math V2',
    maxInputTokens: 4096,
    maxOutputTokens: 4096,
    stream: true,
    capabilities: {
      toolCalling: false,
      imageInput: false,
    },
    temperature: 0.0,
  },
  {
    id: 'deepseek-vl',
    name: 'DeepSeek VL',
    maxInputTokens: 4096,
    maxOutputTokens: 4096,
    stream: true,
    capabilities: {
      toolCalling: false,
      imageInput: true,
    },
    temperature: 1.0,
  },
  {
    id: 'deepseek-vl2',
    name: 'DeepSeek VL2',
    maxInputTokens: 4096,
    maxOutputTokens: 4096,
    stream: true,
    capabilities: {
      toolCalling: false,
      imageInput: true,
    },
    temperature: 1.0,
  },
  {
    id: 'kimi-k2.5',
    overrides: [
      'kimi-k2.5-free',
      {
        matchers: ['integrate.api.nvidia.com'],
        config: {
          id: 'moonshotai/kimi-k2.5',
        },
      },
      {
        matchers: [
          'ark.cn-beijing.volces.com',
          'ark.ap-southeast.bytepluses.com',
          'dashscope.aliyuncs.com',
          'dashscope-intl.aliyuncs.com',
          'api-inference.modelscope.cn',
        ],
        config: {
          maxOutputTokens: 32768,
        },
      },
    ],
    name: 'Kimi K2.5',
    maxInputTokens: 262144,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'kimi-k2-thinking',
    overrides: [
      'moonshotai/kimi-k2-thinking',
      {
        matchers: [
          'ark.cn-beijing.volces.com',
          'ark.ap-southeast.bytepluses.com',
          'dashscope.aliyuncs.com',
          'dashscope-intl.aliyuncs.com',
          'api-inference.modelscope.cn',
        ],
        config: {
          maxOutputTokens: 32768,
        },
      },
    ],
    name: 'Kimi K2 Thinking',
    maxInputTokens: 256000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    temperature: 1.0,
  },
  {
    id: 'kimi-k2-thinking-turbo',
    name: 'Kimi K2 Thinking Turbo',
    maxInputTokens: 256000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    temperature: 1.0,
  },
  {
    id: 'kimi-k2-0905-preview',
    overrides: [
      'kimi-k2',
      'moonshotai/kimi-k2-instruct',
      'moonshotai/kimi-k2-instruct-0905',
    ],
    name: 'Kimi K2 0905 Preview',
    maxInputTokens: 256000,
    maxOutputTokens: 128000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    temperature: 0.6,
  },
  {
    id: 'kimi-k2-0711-preview',
    name: 'Kimi K2 0711 Preview',
    maxInputTokens: 128000,
    maxOutputTokens: 64000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    temperature: 0.6,
  },
  {
    id: 'kimi-k2-turbo-preview',
    name: 'Kimi K2 Turbo Preview',
    maxInputTokens: 256000,
    maxOutputTokens: 128000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    temperature: 0.6,
  },
  {
    id: 'kimi-for-coding',
    name: 'Kimi For Coding',
    maxInputTokens: 262144,
    maxOutputTokens: 32768,
    stream: true,
    thinking: {
      type: 'enabled',
      effort: 'medium',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    temperature: 0.6,
  },
  {
    id: 'qwen3-max-2026-01-23',
    name: 'Qwen3-Max-Thinking',
    maxInputTokens: 252000,
    maxOutputTokens: 32000,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'qwen3-max',
    name: 'Qwen3-Max',
    maxInputTokens: 262144,
    maxOutputTokens: 65536,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'qwen-plus',
    name: 'Qwen-Plus',
    maxInputTokens: 1000000,
    maxOutputTokens: 32768,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'qwen-flash',
    name: 'Qwen-Flash',
    maxInputTokens: 1000000,
    maxOutputTokens: 32768,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'qwen-turbo',
    name: 'Qwen-Turbo',
    maxInputTokens: 131072,
    maxOutputTokens: 8192,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'qwen-max',
    name: 'Qwen-Max',
    maxInputTokens: 32768,
    maxOutputTokens: 8192,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'qwen3-coder-next',
    name: 'Qwen3-Coder-Next',
    maxInputTokens: 262144,
    maxOutputTokens: 65536,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'qwen3-coder-plus',
    name: 'Qwen3-Coder-Plus',
    maxInputTokens: 1000000,
    maxOutputTokens: 65536,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'qwen3-coder-flash',
    name: 'Qwen3-Coder-Flash',
    maxInputTokens: 1000000,
    maxOutputTokens: 65536,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'qwq-plus',
    name: 'QwQ-Plus',
    maxInputTokens: 131072,
    maxOutputTokens: 8192,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'qvq-max',
    name: 'QVQ-Max',
    maxInputTokens: 131072,
    maxOutputTokens: 8192,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: false,
      imageInput: true,
    },
  },
  {
    id: 'qwen3-vl-plus',
    name: 'Qwen3-VL-Plus',
    maxInputTokens: 262144,
    maxOutputTokens: 32768,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'qwen3-vl-flash',
    name: 'Qwen3-VL-Flash',
    maxInputTokens: 262144,
    maxOutputTokens: 32768,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'qwen3-vl-32b-instruct',
    name: 'Qwen3-VL-32B-Instruct',
    maxInputTokens: 131072,
    maxOutputTokens: 32768,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'qwen-vl-ocr',
    name: 'Qwen-VL-OCR',
    maxInputTokens: 34096,
    maxOutputTokens: 4096,
    stream: true,
    capabilities: {
      toolCalling: false,
      imageInput: true,
    },
  },
  {
    id: 'qwen-vl-max',
    name: 'Qwen-VL-Max',
    maxInputTokens: 131072,
    maxOutputTokens: 32768,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'qwen-vl-plus',
    name: 'Qwen-VL-Plus',
    maxInputTokens: 131072,
    maxOutputTokens: 8192,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'qwen-plus-character-ja',
    name: 'Qwen-Plus Character (JA)',
    maxInputTokens: 8192,
    maxOutputTokens: 512,
    stream: true,
    capabilities: {
      toolCalling: false,
      imageInput: false,
    },
  },
  {
    id: 'qwen3-max-preview',
    name: 'Qwen3-Max Preview',
    maxInputTokens: 81920,
    maxOutputTokens: 65536,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'qwen-long-latest',
    name: 'Qwen-Long',
    maxInputTokens: 10000000,
    maxOutputTokens: 8192,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'qwen-doc-turbo',
    name: 'Qwen-Doc-Turbo',
    maxInputTokens: 131072,
    maxOutputTokens: 8192,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'qwen-deep-research',
    name: 'Qwen Deep Research',
    maxInputTokens: 1000000,
    maxOutputTokens: 32768,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'qwen-math-plus',
    name: 'Qwen-Math-Plus',
    maxInputTokens: 4096,
    maxOutputTokens: 3072,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'qwen-math-turbo',
    name: 'Qwen-Math-Turbo',
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'qvq-plus',
    name: 'QVQ-Plus',
    maxInputTokens: 131072,
    maxOutputTokens: 8192,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: false,
      imageInput: true,
    },
  },
  {
    id: 'qwen-coder-plus',
    name: 'Qwen-Coder-Plus',
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'qwen-coder-turbo',
    name: 'Qwen-Coder-Turbo',
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'qwq-32b',
    overrides: ['qwq:32b', 'qwq:latest', 'qwen/qwq-32b'],
    name: 'QwQ 32B',
    maxInputTokens: 131072,
    maxOutputTokens: 8192,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'qwq-32b-preview',
    name: 'QwQ 32B Preview',
    maxInputTokens: 32768,
    maxOutputTokens: 16384,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'qvq-72b-preview',
    name: 'QVQ 72B Preview',
    maxInputTokens: 32768,
    maxOutputTokens: 16384,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: false,
      imageInput: true,
    },
  },
  {
    id: 'llama-3.1-8b',
    overrides: [
      'llama3.1-8b',
      {
        matchers: ['api.cerebras.ai'],
        config: {
          maxInputTokens: 32000,
          maxOutputTokens: 8000,
        },
      },
    ],
    name: 'Llama 3.1 8B',
    maxInputTokens: 128000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'llama-3.1-70b',
    overrides: ['llama3.1-70b'],
    name: 'Llama 3.1 70B',
    maxInputTokens: 128000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'llama-3.1-405b',
    overrides: ['llama3.1-405b'],
    name: 'Llama 3.1 405B',
    maxInputTokens: 128000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'llama-3.3-70b',
    overrides: ['llama3.3-70b'],
    name: 'Llama 3.3 70B',
    maxInputTokens: 128000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'qwen1.5-7b-chat',
    overrides: ['qwen:7b'],
    name: 'Qwen1.5 7B Chat',
    stream: true,
  },
  {
    id: 'qwen1.5-14b-chat',
    overrides: ['qwen:14b'],
    name: 'Qwen1.5 14B Chat',
    stream: true,
  },
  {
    id: 'qwen1.5-32b-chat',
    overrides: ['qwen:32b'],
    name: 'Qwen1.5 32B Chat',
    stream: true,
  },
  {
    id: 'qwen1.5-72b-chat',
    overrides: ['qwen:72b'],
    name: 'Qwen1.5 72B Chat',
    stream: true,
  },
  {
    id: 'qwen1.5-110b-chat',
    overrides: ['qwen:110b'],
    name: 'Qwen1.5 110B Chat',
    stream: true,
  },
  {
    id: 'qwen2-7b-instruct',
    overrides: ['qwen2:7b', 'qwen/qwen2-7b-instruct'],
    name: 'Qwen2 7B Instruct',
    stream: true,
  },
  {
    id: 'qwen2-72b-instruct',
    overrides: ['qwen2:72b'],
    name: 'Qwen2 72B Instruct',
    stream: true,
  },
  {
    id: 'qwen2-57b-a14b-instruct',
    name: 'Qwen2 57B A14B Instruct',
    stream: true,
  },
  {
    id: 'qwen2-vl-72b-instruct',
    overrides: ['qwen2-vl:72b'],
    name: 'Qwen2-VL 72B Instruct',
    stream: true,
    capabilities: {
      toolCalling: false,
      imageInput: true,
    },
  },
  {
    id: 'qwen2.5-0.5b-instruct',
    overrides: ['qwen2.5:0.5b'],
    name: 'Qwen2.5 0.5B Instruct',
    stream: true,
  },
  {
    id: 'qwen2.5-1.5b-instruct',
    overrides: ['qwen2.5:1.5b'],
    name: 'Qwen2.5 1.5B Instruct',
    stream: true,
  },
  {
    id: 'qwen2.5-3b-instruct',
    overrides: ['qwen2.5:3b'],
    name: 'Qwen2.5 3B Instruct',
    stream: true,
  },
  {
    id: 'qwen2.5-7b-instruct',
    overrides: ['qwen2.5:7b', 'qwen2.5:latest', 'qwen/qwen2.5-7b-instruct'],
    name: 'Qwen2.5 7B Instruct',
    stream: true,
  },
  {
    id: 'qwen2.5-7b-instruct-1m',
    name: 'Qwen2.5 7B Instruct (1M)',
    maxInputTokens: 1000000,
    stream: true,
  },
  {
    id: 'qwen2.5-14b-instruct',
    overrides: ['qwen2.5:14b'],
    name: 'Qwen2.5 14B Instruct',
    stream: true,
  },
  {
    id: 'qwen2.5-14b-instruct-1m',
    name: 'Qwen2.5 14B Instruct (1M)',
    maxInputTokens: 1000000,
    stream: true,
  },
  {
    id: 'qwen2.5-32b-instruct',
    overrides: ['qwen2.5:32b'],
    name: 'Qwen2.5 32B Instruct',
    stream: true,
  },
  {
    id: 'qwen2.5-72b-instruct',
    overrides: ['qwen2.5:72b'],
    name: 'Qwen2.5 72B Instruct',
    stream: true,
  },
  {
    id: 'qwen2.5-coder-0.5b-instruct',
    overrides: ['qwen2.5-coder:0.5b'],
    name: 'Qwen2.5 Coder 0.5B Instruct',
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'qwen2.5-coder-1.5b-instruct',
    overrides: ['qwen2.5-coder:1.5b'],
    name: 'Qwen2.5 Coder 1.5B Instruct',
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'qwen2.5-coder-3b-instruct',
    overrides: ['qwen2.5-coder:3b'],
    name: 'Qwen2.5 Coder 3B Instruct',
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'qwen2.5-coder-7b-instruct',
    overrides: ['qwen2.5-coder:7b', 'qwen/qwen2.5-coder-7b-instruct'],
    name: 'Qwen2.5 Coder 7B Instruct',
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'qwen2.5-coder-14b-instruct',
    overrides: ['qwen2.5-coder:14b'],
    name: 'Qwen2.5 Coder 14B Instruct',
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'qwen2.5-coder-32b-instruct',
    overrides: ['qwen2.5-coder:32b', 'qwen/qwen2.5-coder-32b-instruct'],
    name: 'Qwen2.5 Coder 32B Instruct',
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'qwen2.5-math-1.5b-instruct',
    name: 'Qwen2.5 Math 1.5B Instruct',
    stream: true,
  },
  {
    id: 'qwen2.5-math-7b-instruct',
    name: 'Qwen2.5 Math 7B Instruct',
    stream: true,
  },
  {
    id: 'qwen2.5-math-72b-instruct',
    name: 'Qwen2.5 Math 72B Instruct',
    stream: true,
  },
  {
    id: 'qwen2.5-vl-3b-instruct',
    overrides: ['qwen2.5vl:3b', 'qwen2.5-vl:3b'],
    name: 'Qwen2.5-VL 3B Instruct',
    stream: true,
    capabilities: {
      toolCalling: false,
      imageInput: true,
    },
  },
  {
    id: 'qwen2.5-vl-7b-instruct',
    overrides: ['qwen2.5vl:7b', 'qwen2.5-vl:7b'],
    name: 'Qwen2.5-VL 7B Instruct',
    stream: true,
    capabilities: {
      toolCalling: false,
      imageInput: true,
    },
  },
  {
    id: 'qwen2.5-vl-32b-instruct',
    overrides: ['qwen2.5vl:32b', 'qwen2.5-vl:32b'],
    name: 'Qwen2.5-VL 32B Instruct',
    stream: true,
    capabilities: {
      toolCalling: false,
      imageInput: true,
    },
  },
  {
    id: 'qwen3-0.6b',
    overrides: ['qwen3:0.6b'],
    name: 'Qwen3 0.6B',
    maxInputTokens: 30720,
    stream: true,
    thinking: {
      type: 'enabled',
    },
  },
  {
    id: 'qwen3-1.7b',
    overrides: ['qwen3:1.7b'],
    name: 'Qwen3 1.7B',
    maxInputTokens: 32768,
    stream: true,
    thinking: {
      type: 'enabled',
    },
  },
  {
    id: 'qwen3-4b',
    overrides: ['qwen3:4b'],
    name: 'Qwen3 4B',
    maxInputTokens: 129024,
    stream: true,
    thinking: {
      type: 'enabled',
    },
  },
  {
    id: 'qwen3-8b',
    overrides: ['qwen3:8b', 'qwen3:latest'],
    name: 'Qwen3 8B',
    maxInputTokens: 129024,
    stream: true,
    thinking: {
      type: 'enabled',
    },
  },
  {
    id: 'qwen3-14b',
    overrides: ['qwen3:14b'],
    name: 'Qwen3 14B',
    maxInputTokens: 129024,
    stream: true,
    thinking: {
      type: 'enabled',
    },
  },
  {
    id: 'qwen3-32b',
    overrides: ['qwen3:32b', 'qwen-3-32b'],
    name: 'Qwen3 32B',
    maxInputTokens: 129024,
    stream: true,
    thinking: {
      type: 'enabled',
    },
  },
  {
    id: 'qwen3-30b-a3b',
    overrides: ['qwen3:30b'],
    name: 'Qwen3 30B A3B',
    maxInputTokens: 129024,
    stream: true,
    thinking: {
      type: 'enabled',
    },
  },
  {
    id: 'qwen3-235b-a22b',
    overrides: ['qwen3:235b', 'qwen/qwen3-235b-a22b'],
    name: 'Qwen3 235B A22B',
    maxInputTokens: 129024,
    stream: true,
    thinking: {
      type: 'enabled',
    },
  },
  {
    id: 'qwen3-next-80b-a3b-thinking',
    overrides: ['qwen/qwen3-next-80b-a3b-thinking'],
    name: 'Qwen3 Next 80B A3B Thinking',
    maxInputTokens: 131072,
    maxOutputTokens: 32768,
    stream: true,
    thinking: {
      type: 'enabled',
    },
  },
  {
    id: 'qwen3-next-80b-a3b-instruct',
    overrides: ['qwen3-next:80b', 'qwen/qwen3-next-80b-a3b-instruct'],
    name: 'Qwen3 Next 80B A3B Instruct',
    maxInputTokens: 129024,
    stream: true,
  },
  {
    id: 'qwen3-235b-a22b-thinking-2507',
    name: 'Qwen3 235B A22B Thinking 2507',
    maxInputTokens: 126976,
    maxOutputTokens: 32768,
    stream: true,
    thinking: {
      type: 'enabled',
    },
  },
  {
    id: 'qwen3-235b-a22b-instruct-2507',
    overrides: [
      'qwen-3-235b-a22b-instruct-2507',
      {
        matchers: ['api.cerebras.ai'],
        config: {
          maxInputTokens: 131000,
          maxOutputTokens: 40000,
        },
      },
    ],
    name: 'Qwen3 235B A22B Instruct 2507',
    maxInputTokens: 129024,
    stream: true,
  },
  {
    id: 'qwen3-30b-a3b-thinking-2507',
    name: 'Qwen3 30B A3B Thinking 2507',
    maxInputTokens: 126976,
    maxOutputTokens: 32768,
    stream: true,
    thinking: {
      type: 'enabled',
    },
  },
  {
    id: 'qwen3-30b-a3b-instruct-2507',
    name: 'Qwen3 30B A3B Instruct 2507',
    maxInputTokens: 129024,
    stream: true,
  },
  {
    id: 'qwen3-coder-480b-a35b-instruct',
    overrides: [
      'qwen3-coder:480b',
      'qwen3-coder',
      'qwen/qwen3-coder-480b-a35b-instruct',
    ],
    name: 'Qwen3 Coder 480B A35B Instruct',
    maxInputTokens: 262144,
    maxOutputTokens: 65536,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'qwen3-coder-30b-a3b-instruct',
    overrides: ['qwen3-coder:30b', 'qwen3-coder:latest'],
    name: 'Qwen3 Coder 30B A3B Instruct',
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'qwen3-vl-235b-a22b-thinking',
    name: 'Qwen3-VL 235B A22B Thinking',
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'qwen3-vl-235b-a22b-instruct',
    overrides: ['qwen3-vl:235b'],
    name: 'Qwen3-VL 235B A22B Instruct',
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'qwen3-vl-32b-thinking',
    overrides: ['qwen3-vl:32b'],
    name: 'Qwen3-VL 32B Thinking',
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'qwen3-vl-30b-a3b-thinking',
    name: 'Qwen3-VL 30B A3B Thinking',
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'qwen3-vl-30b-a3b-instruct',
    overrides: ['qwen3-vl:30b'],
    name: 'Qwen3-VL 30B A3B Instruct',
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'qwen3-vl-8b-thinking',
    name: 'Qwen3-VL 8B Thinking',
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'qwen3-vl-8b-instruct',
    overrides: ['qwen3-vl:8b', 'qwen3-vl:latest'],
    name: 'Qwen3-VL 8B Instruct',
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'qwen3-omni-flash',
    name: 'Qwen3-Omni-Flash',
    maxInputTokens: 65536,
    maxOutputTokens: 16384,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: false,
      imageInput: true,
    },
  },
  {
    id: 'qwen3-omni-flash-realtime',
    name: 'Qwen3-Omni-Flash-Realtime',
    maxInputTokens: 65536,
    maxOutputTokens: 8192,
    stream: true,
    capabilities: {
      toolCalling: false,
      imageInput: true,
    },
  },
  {
    id: 'qwen3-omni-30b-a3b-captioner',
    name: 'Qwen3-Omni 30B A3B Captioner',
    maxOutputTokens: 32768,
    stream: true,
    capabilities: {
      toolCalling: false,
      imageInput: false,
    },
  },
  {
    id: 'qwen2.5-omni-7b',
    name: 'Qwen2.5-Omni-7B',
    maxInputTokens: 32768,
    maxOutputTokens: 2048,
    stream: true,
    capabilities: {
      toolCalling: false,
      imageInput: true,
    },
  },
  {
    id: 'qwen-omni-turbo',
    name: 'Qwen-Omni-Turbo',
    maxInputTokens: 32768,
    maxOutputTokens: 2048,
    stream: true,
    capabilities: {
      toolCalling: false,
      imageInput: true,
    },
  },
  {
    id: 'qwen-omni-turbo-realtime',
    name: 'Qwen-Omni-Turbo-Realtime',
    maxInputTokens: 32768,
    maxOutputTokens: 2048,
    stream: true,
    capabilities: {
      toolCalling: false,
      imageInput: true,
    },
  },
  {
    id: 'mimo-v2-flash',
    name: 'MiMo V2 Flash',
    maxInputTokens: 256000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'glm-5',
    overrides: ['z-ai/glm5'],
    name: 'GLM-5',
    maxInputTokens: 200000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'glm-5-code',
    name: 'GLM-5-Code',
    maxInputTokens: 200000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'glm-4.7',
    overrides: [
      'z-ai/glm4.7',
      'glm-4.7-free',
      {
        matchers: ['api.cerebras.ai'],
        config: {
          id: 'zai-glm-4.7',
          maxInputTokens: 131000,
          maxOutputTokens: 40000,
        },
      },
    ],
    name: 'GLM-4.7',
    maxInputTokens: 200000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'glm-4.7-flash',
    name: 'GLM-4.7-Flash',
    maxInputTokens: 200000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'glm-4.7-flashx',
    name: 'GLM-4.7-FlashX',
    maxInputTokens: 200000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'glm-4.6',
    name: 'GLM-4.6',
    maxInputTokens: 200000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'glm-4.5',
    name: 'GLM-4.5',
    maxInputTokens: 128000,
    maxOutputTokens: 96000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'glm-4.5-x',
    name: 'GLM-4.5-X',
    maxInputTokens: 128000,
    maxOutputTokens: 96000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'glm-4.5-air',
    name: 'GLM-4.5-Air',
    maxInputTokens: 128000,
    maxOutputTokens: 96000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'glm-4.5-airx',
    name: 'GLM-4.5-AirX',
    maxInputTokens: 128000,
    maxOutputTokens: 96000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'glm-4-plus',
    name: 'GLM-4-Plus',
    maxInputTokens: 128000,
    maxOutputTokens: 4096,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'glm-4-air-250414',
    overrides: ['glm-4-air'],
    name: 'GLM-4-Air-250414',
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'glm-4-long',
    name: 'GLM-4-Long',
    maxInputTokens: 1000000,
    maxOutputTokens: 4096,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'glm-4-airx',
    name: 'GLM-4-AirX',
    maxInputTokens: 8192,
    maxOutputTokens: 4096,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'glm-4-flashx-250414',
    overrides: ['glm-4-flashx'],
    name: 'GLM-4-FlashX-250414',
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'glm-4.5-flash',
    name: 'GLM-4.5-Flash',
    maxInputTokens: 128000,
    maxOutputTokens: 96000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'glm-4-flash-250414',
    overrides: ['glm-4-flash'],
    name: 'GLM-4-Flash-250414',
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'glm-4.6v',
    name: 'GLM-4.6V',
    maxInputTokens: 128000,
    maxOutputTokens: 32768,
    stream: true,
    thinking: {
      type: 'enabled',
      budgetTokens: 8192,
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'glm-4.5v',
    name: 'GLM-4.5V',
    maxInputTokens: 64000,
    maxOutputTokens: 16384,
    stream: true,
    thinking: {
      type: 'enabled',
      budgetTokens: 8192,
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'glm-4.1v-thinking-flashx',
    name: 'GLM-4.1V-Thinking-FlashX',
    maxInputTokens: 64000,
    maxOutputTokens: 16384,
    stream: true,
    thinking: {
      type: 'enabled',
      budgetTokens: 8192,
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'glm-4.6v-flash',
    name: 'GLM-4.6V-Flash',
    maxInputTokens: 128000,
    maxOutputTokens: 32768,
    stream: true,
    thinking: {
      type: 'enabled',
      budgetTokens: 16384,
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'glm-4.1v-thinking-flash',
    name: 'GLM-4.1V-Thinking-Flash',
    maxInputTokens: 64000,
    maxOutputTokens: 16384,
    stream: true,
    thinking: {
      type: 'enabled',
      budgetTokens: 8192,
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'codegeex-4',
    name: 'CodeGeeX-4',
    maxInputTokens: 128000,
    maxOutputTokens: 32768,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'big-pickle',
    name: 'Big Pickle',
    maxInputTokens: 200000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'grok-4-1-fast-reasoning',
    name: 'Grok 4.1 Fast (Reasoning)',
    maxInputTokens: 2000000,
    maxOutputTokens: 1000000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'grok-4-1-fast-non-reasoning',
    name: 'Grok 4.1 Fast (Non-Reasoning)',
    maxInputTokens: 2000000,
    maxOutputTokens: 1000000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'grok-code-fast-1',
    overrides: ['grok-code'],
    name: 'Grok Code Fast 1',
    maxInputTokens: 256000,
    maxOutputTokens: 128000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'grok-4',
    name: 'Grok 4',
    maxInputTokens: 256000,
    maxOutputTokens: 128000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'grok-4-fast-reasoning',
    name: 'Grok 4 Fast (Reasoning)',
    maxInputTokens: 2000000,
    maxOutputTokens: 1000000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'grok-4-fast-non-reasoning',
    name: 'Grok 4 Fast (Non-Reasoning)',
    maxInputTokens: 2000000,
    maxOutputTokens: 1000000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'grok-3',
    name: 'Grok 3',
    maxInputTokens: 131072,
    maxOutputTokens: 65536,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'grok-3-mini',
    name: 'Grok 3 Mini',
    maxInputTokens: 131072,
    maxOutputTokens: 65536,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'grok-2-vision',
    name: 'Grok 2 Vision',
    maxInputTokens: 32768,
    maxOutputTokens: 16384,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gemini-3-pro-preview',
    overrides: ['gemini-3-pro'],
    name: 'Gemini 3 Pro Preview',
    maxInputTokens: 1048576,
    maxOutputTokens: 65536,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gemini-3-flash-preview',
    overrides: ['gemini-3-flash'],
    name: 'Gemini 3 Flash Preview',
    maxInputTokens: 1048576,
    maxOutputTokens: 65536,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    maxInputTokens: 1048576,
    maxOutputTokens: 65536,
    stream: true,
    thinking: {
      type: 'auto',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    maxInputTokens: 1048576,
    maxOutputTokens: 65536,
    stream: true,
    thinking: {
      type: 'auto',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gemini-2.5-flash-lite',
    name: 'Gemini 2.5 Flash-Lite',
    maxInputTokens: 1048576,
    maxOutputTokens: 65536,
    stream: true,
    thinking: {
      type: 'auto',
    },
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gemini-2.0-flash',
    overrides: ['gemini-2.0-flash-001', 'gemini-2.0-flash-exp'],
    name: 'Gemini 2.0 Flash',
    maxInputTokens: 1048576,
    maxOutputTokens: 8192,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'gemini-2.0-flash-lite',
    overrides: ['gemini-2.0-flash-lite-001'],
    name: 'Gemini 2.0 Flash-Lite',
    maxInputTokens: 1048576,
    maxOutputTokens: 8192,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'hunyuan-2.0-thinking-20251109',
    overrides: ['hunyuan-2.0-think'],
    name: 'HY 2.0 Think',
    maxInputTokens: 128000,
    maxOutputTokens: 64000,
    stream: true,
    capabilities: {
      toolCalling: false,
      imageInput: false,
    },
  },
  {
    id: 'hunyuan-2.0-instruct-20251111',
    overrides: ['hunyuan-2.0-instruct'],
    name: 'HY 2.0 Instruct',
    maxInputTokens: 128000,
    maxOutputTokens: 16000,
    stream: true,
    capabilities: {
      toolCalling: false,
      imageInput: false,
    },
  },
  {
    id: 'hunyuan-vision-1.5-instruct',
    name: 'HY Vision 1.5 Instruct',
    maxInputTokens: 24000,
    maxOutputTokens: 16000,
    stream: true,
    capabilities: {
      toolCalling: false,
      imageInput: true,
    },
  },
  {
    id: 'LongCat-Flash-Chat',
    name: 'LongCat Flash Chat',
    maxInputTokens: 256000,
    maxOutputTokens: 128000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'LongCat-Flash-Thinking',
    name: 'LongCat Flash Thinking',
    maxInputTokens: 256000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
      budgetTokens: 64000,
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'LongCat-Flash-Thinking-2601',
    name: 'LongCat Flash Thinking 2601',
    maxInputTokens: 256000,
    maxOutputTokens: 128000,
    stream: true,
    thinking: {
      type: 'enabled',
      budgetTokens: 64000,
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'LongCat-Flash-Lite',
    name: 'LongCat Flash Lite',
    maxInputTokens: 320000,
    maxOutputTokens: 128000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'kat-coder-pro-v1',
    name: 'KAT-Coder-Pro V1',
    maxInputTokens: 256000,
    maxOutputTokens: 32000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'kat-coder-exp-72b-1010',
    name: 'KAT-Coder-Exp-72B-1010',
    maxInputTokens: 128000,
    maxOutputTokens: 32000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'kat-coder-air-v1',
    name: 'KAT-Coder-Air V1',
    maxInputTokens: 128000,
    maxOutputTokens: 32000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'step-1-8k',
    name: 'Step 1 8k',
    maxInputTokens: 8000,
    maxOutputTokens: 8000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'step-1-32k',
    name: 'Step 1 32k',
    maxInputTokens: 32000,
    maxOutputTokens: 32000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'step-1-128k',
    name: 'Step 1 128k',
    maxInputTokens: 128000,
    maxOutputTokens: 128000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'step-1-256k',
    name: 'Step 1 256k',
    maxInputTokens: 256000,
    maxOutputTokens: 256000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'step-2-16k',
    name: 'Step 2 16k',
    maxInputTokens: 16000,
    maxOutputTokens: 16000,
    stream: true,
    capabilities: {
      toolCalling: false,
      imageInput: false,
    },
  },
  {
    id: 'step-2-16k-exp',
    name: 'Step 2 16k Exp',
    maxInputTokens: 16000,
    maxOutputTokens: 16000,
    stream: true,
    capabilities: {
      toolCalling: false,
      imageInput: false,
    },
  },
  {
    id: 'step-2-mini',
    name: 'Step 2 Mini',
    maxInputTokens: 32000,
    maxOutputTokens: 32000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'step-1o-turbo-vision',
    name: 'Step 1o Turbo Vision',
    maxInputTokens: 32000,
    maxOutputTokens: 32000,
    stream: true,
    capabilities: {
      toolCalling: false,
      imageInput: true,
    },
  },
  {
    id: 'step-1o-vision-32k',
    name: 'Step 1o Vision 32k',
    maxInputTokens: 32000,
    maxOutputTokens: 32000,
    stream: true,
    capabilities: {
      toolCalling: false,
      imageInput: true,
    },
  },
  {
    id: 'step-1v-8k',
    name: 'Step 1v 8k',
    maxInputTokens: 8000,
    maxOutputTokens: 8000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'step-1v-32k',
    name: 'Step 1v 32k',
    maxInputTokens: 32000,
    maxOutputTokens: 32000,
    stream: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'step-3',
    name: 'Step 3',
    maxInputTokens: 65536,
    maxOutputTokens: undefined,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: false,
      imageInput: true,
    },
    extraBody: {
      reasoning_format: 'general',
    },
  },
  {
    id: 'step-3.5-flash',
    name: 'Step 3.5 Flash',
    maxInputTokens: 256000,
    maxOutputTokens: undefined,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
    extraBody: {
      reasoning_format: 'general',
    },
  },
  {
    id: 'step-r1-v-mini',
    name: 'Step R1 V Mini',
    maxInputTokens: 100000,
    maxOutputTokens: undefined,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    capabilities: {
      toolCalling: false,
      imageInput: true,
    },
    extraBody: {
      reasoning_format: 'general',
    },
  },
] as const satisfies readonly WellKnownModelConfig[];
export const WELL_KNOWN_MODELS: readonly WellKnownModelConfig[] =
  _WELL_KNOWN_MODELS;

type WellKnownModelPrimaryId = (typeof _WELL_KNOWN_MODELS)[number]['id'];
type OverrideToAltId<O> = O extends string
  ? O
  : O extends { config: { id: infer Id } }
    ? Id extends string
      ? Id
      : never
    : never;

type WellKnownModelOverrideId =
  (typeof _WELL_KNOWN_MODELS)[number] extends infer M
    ? M extends { overrides: readonly (infer O)[] }
      ? OverrideToAltId<O>
      : never
    : never;

export type WellKnownModelId =
  | WellKnownModelPrimaryId
  | WellKnownModelOverrideId;

/**
 * Well-known model configuration with additional matching options
 */
interface WellKnownModelConfig extends ModelConfig {
  /**
   * Overrides:
   * - `string`: alternative model id (alias) for matching
   * - `{ matchers, config }`: provider-specific override (first match wins)
   */
  overrides?: readonly (WellKnownModelOverride | string)[];
}

type WellKnownModelOverrideChecker = (provider: ProviderConfig) => boolean;

interface WellKnownModelOverride {
  /** Provider matchers - any match triggers this override */
  matchers: (ProviderPattern | WellKnownModelOverrideChecker)[];
  /** Override configuration fields (including id) */
  config: Partial<ModelConfig>;
}

/**
 * Get all alternative IDs (including `overrides` string entries and `override.config.id`).
 */
export function getAlternativeIds(model: WellKnownModelConfig): string[] {
  if (!model.overrides) return [];

  const ids: string[] = [];
  for (const override of model.overrides) {
    if (typeof override === 'string') {
      ids.push(override);
      continue;
    }

    const overrideId = override.config.id;
    if (typeof overrideId === 'string' && overrideId.trim()) {
      ids.push(overrideId);
    }
  }
  return ids;
}

function getProviderOverrides(
  model: WellKnownModelConfig,
): WellKnownModelOverride[] {
  if (!model.overrides) return [];
  return model.overrides.filter(
    (o): o is WellKnownModelOverride => typeof o !== 'string',
  );
}

function findMatchingOverride(
  overrides: WellKnownModelOverride[],
  provider: ProviderConfig,
): WellKnownModelOverride | undefined {
  return overrides.find((override) =>
    override.matchers.some((matcher) => {
      if (typeof matcher === 'function') {
        return matcher(provider);
      }
      return matchProvider(provider.baseUrl, matcher);
    }),
  );
}

/**
 * Check if two IDs match using includes-based comparison
 * Returns the matched ID length if matched, 0 otherwise
 */
function getMatchScore(apiModelId: string, knownId: string): number {
  const lowerApi = apiModelId.toLowerCase();
  const lowerKnown = knownId.toLowerCase();

  // Exact match gets highest score
  if (lowerApi === lowerKnown) {
    return Infinity;
  }

  // Check if one includes the other
  if (lowerApi.includes(lowerKnown) || lowerKnown.includes(lowerApi)) {
    // Score based on the length of the matched known ID
    // Longer matches are more specific and should be preferred
    return knownId.length;
  }

  return 0;
}

/**
 * Get all IDs to match against for a model (primary ID + alternative IDs from overrides)
 */
function getAllMatchableIds(model: WellKnownModelConfig): string[] {
  const ids = [model.id];
  ids.push(...getAlternativeIds(model));
  return ids;
}

/**
 * Calculate the best match score for a model against an API model ID
 * Considers both primary ID and override-based alternative IDs
 */
function calculateBestMatchScore(
  apiModelId: string,
  model: WellKnownModelConfig,
): number {
  const allIds = getAllMatchableIds(model);
  let bestScore = 0;

  for (const id of allIds) {
    const score = getMatchScore(apiModelId, id);
    if (score > bestScore) {
      bestScore = score;
    }
  }

  return bestScore;
}

/**
 * Find the best matching well-known model for a given API model ID
 * Uses includes-based filtering and selects the most similar match
 * Supports matching against both primary ID and override-based alternative IDs
 */
export function findBestMatchingWellKnownModel(
  apiModelId: string,
): WellKnownModelConfig | undefined {
  // Filter models that have at least one matching ID
  const candidates = WELL_KNOWN_MODELS.filter(
    (model) => calculateBestMatchScore(apiModelId, model) > 0,
  );

  if (candidates.length === 0) {
    return undefined;
  }

  // Find the most similar match (highest score)
  let bestMatch = candidates[0];
  let bestScore = calculateBestMatchScore(apiModelId, bestMatch);

  for (let i = 1; i < candidates.length; i++) {
    const score = calculateBestMatchScore(apiModelId, candidates[i]);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = candidates[i];
    }
  }

  return bestMatch;
}

/**
 * Merge API model with well-known model configuration
 * API model fields take precedence over well-known fields
 */
export function mergeWithWellKnownModel(
  apiModel: ModelConfig,
  provider?: ProviderConfig,
): ModelConfig {
  const wellKnown = findBestMatchingWellKnownModel(apiModel.id);

  const defaultCapabilities = { capabilities: { toolCalling: true } };

  if (!wellKnown) {
    return Object.assign(defaultCapabilities, apiModel);
  }

  const { overrides: _overrides, ...wellKnownBase } = wellKnown;
  let baseConfig: ModelConfig = { ...wellKnownBase };

  if (provider && _overrides) {
    const providerOverrides = getProviderOverrides(wellKnown);
    const matchedOverride = findMatchingOverride(providerOverrides, provider);
    if (matchedOverride) {
      baseConfig = { ...baseConfig, ...matchedOverride.config };
    }
  }

  return Object.assign(defaultCapabilities, baseConfig, apiModel);
}

/**
 * Merge API model with well-known model configuration
 * API model fields take precedence over well-known fields
 */
export function mergeWithWellKnownModels(
  apiModels: ModelConfig[],
  provider?: ProviderConfig,
): ModelConfig[] {
  return apiModels.map((model) => mergeWithWellKnownModel(model, provider));
}

export function normalizeWellKnownConfigs(
  models: readonly WellKnownModelConfig[],
  declaredIds?: Map<string, string>,
  provider?: ProviderConfig,
): ModelConfig[] {
  return models.map(({ overrides, ...config }) => {
    let finalConfig: ModelConfig = { ...config };
    let finalId = config.id;

    if (provider && overrides) {
      const providerOverrides = getProviderOverrides({ ...config, overrides });
      const matchedOverride = findMatchingOverride(providerOverrides, provider);

      if (matchedOverride) {
        finalConfig = { ...finalConfig, ...matchedOverride.config };
        if (matchedOverride.config.id) {
          finalId = matchedOverride.config.id;
        }
      }
    }

    const declaredId = declaredIds?.get(config.id);
    if (declaredId) {
      finalId = declaredId;
    }

    return { ...finalConfig, id: finalId };
  });
}
