import { ModelConfig } from './client/interface';

/**
 * Well-known models configuration
 */
export const WELL_KNOWN_MODELS: ModelConfig[] = [
  {
    id: 'claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5',
    maxInputTokens: 200000,
    maxOutputTokens: 64000,
    stream: true,
    thinking: {
      type: 'enabled',
      budgetTokens: 16000,
    },
    interleavedThinking: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'claude-haiku-4-5',
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
    id: 'claude-opus-4-5',
    name: 'Claude Opus 4.5',
    maxInputTokens: 200000,
    maxOutputTokens: 64000,
    stream: true,
    thinking: {
      type: 'enabled',
      budgetTokens: 32000,
    },
    interleavedThinking: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'claude-opus-4-1',
    name: 'Claude Opus 4.1',
    maxInputTokens: 200000,
    maxOutputTokens: 32000,
    stream: true,
    thinking: {
      type: 'enabled',
      budgetTokens: 10000,
    },
    interleavedThinking: true,
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
    interleavedThinking: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'claude-3-7-sonnet',
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
    interleavedThinking: true,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'claude-3-5-haiku',
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
    id: 'gpt-5.1',
    name: 'GPT-5.1',
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
    id: 'gpt-5',
    name: 'GPT-5',
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
    name: 'GPT-5.1 Codex',
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
    id: 'gpt-5.1-codex-max',
    name: 'GPT-5.1-Codex-Max',
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
    id: 'gpt-5-codex',
    name: 'GPT-5-Codex',
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
    id: 'gpt-5.1-codex-mini',
    name: 'GPT-5.1 Codex mini',
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
    id: 'MiniMax-M2',
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
    id: 'MiniMax-M2-Stable',
    name: 'MiniMax-M2-Stable',
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
  },
  {
    id: 'kimi-k2-thinking',
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
];
