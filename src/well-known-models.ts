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
    id: 'MiniMax-M2',
    name: 'MiniMax-M2',
    maxInputTokens: 204800,
    maxOutputTokens: 102400,
    stream: true,
    thinking: {
      type: 'enabled',
    },
    interleavedThinking: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
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
    interleavedThinking: true,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
];
