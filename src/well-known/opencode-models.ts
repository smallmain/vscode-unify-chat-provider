import type { ModelConfig, ProviderConfig } from '../types';
import { mergeWithWellKnownModels } from './models';

type OpenCodeService = 'zen' | 'go';

export type OpenCodeModelProtocol =
  | 'chat-completions'
  | 'responses'
  | 'messages'
  | 'google';

type ProtocolSet = readonly OpenCodeModelProtocol[];

/**
 * Revision of the models.dev-backed protocol table below. The table was
 * verified on 2026-08-23 and includes the 2026-08-16 Go Qwen correction.
 */
export const OPENCODE_PROTOCOL_RULES_REVISION = 20260823;

const CHAT_COMPLETIONS = ['chat-completions'] as const;
const RESPONSES = ['responses'] as const;
const MESSAGES = ['messages'] as const;
const GOOGLE = ['google'] as const;
const CHAT_COMPLETIONS_AND_MESSAGES = [
  'chat-completions',
  'messages',
] as const;

const PROVIDER_PROTOCOLS: Partial<
  Record<ProviderConfig['type'], OpenCodeModelProtocol>
> = {
  'openai-chat-completion': 'chat-completions',
  'openai-responses': 'responses',
  anthropic: 'messages',
  'google-ai-studio': 'google',
};

/*
 * OpenCode's provider-level runtime is OpenAI-compatible. Only exact model
 * overrides from models.dev belong here. Do not infer protocol from a model
 * family: Go Qwen models demonstrate that the same family can use different
 * protocols across services and releases.
 */
const ZEN_PROTOCOL_OVERRIDES: ReadonlyMap<string, ProtocolSet> = new Map<
  string,
  ProtocolSet
>([
  ['gpt-5-nano', RESPONSES],
  ['gpt-5.5-pro', RESPONSES],
  ['gpt-5.6-sol', RESPONSES],
  ['grok-4.6', RESPONSES],
  ['gpt-5.4-pro', RESPONSES],
  ['grok-4.5', RESPONSES],
  ['gpt-5', RESPONSES],
  ['gpt-5.1-codex-mini', RESPONSES],
  ['gpt-5-codex', RESPONSES],
  ['gpt-5.6-luna', RESPONSES],
  ['gpt-5.3-codex', RESPONSES],
  ['gpt-5.3-codex-spark', RESPONSES],
  ['muse-spark-1.2-contributor-free', RESPONSES],
  ['gpt-5.2', RESPONSES],
  ['gpt-5.4-mini', RESPONSES],
  ['muse-spark-1.2', RESPONSES],
  ['gpt-5.5', RESPONSES],
  ['gpt-5.2-codex', RESPONSES],
  ['gpt-5.6-terra', RESPONSES],
  ['gpt-5.4', RESPONSES],
  ['gpt-5.1-codex-max', RESPONSES],
  ['gpt-5.1-codex', RESPONSES],
  ['grok-build-0.1', RESPONSES],
  ['gpt-5.4-nano', RESPONSES],
  ['gpt-5.1', RESPONSES],
  ['claude-opus-4-7', MESSAGES],
  ['minimax-m3-free', MESSAGES],
  ['claude-opus-4-8', MESSAGES],
  ['claude-opus-4-1', MESSAGES],
  ['claude-sonnet-5', MESSAGES],
  ['qwen3.5-plus', MESSAGES],
  ['claude-3-5-haiku', MESSAGES],
  ['claude-sonnet-4', MESSAGES],
  ['claude-opus-4-5', MESSAGES],
  ['claude-sonnet-4-6', MESSAGES],
  ['minimax-m2.5-free', MESSAGES],
  ['claude-sonnet-4-5', MESSAGES],
  ['qwen3.6-plus-free', MESSAGES],
  ['minimax-m2.1-free', MESSAGES],
  ['qwen3.6-plus', MESSAGES],
  ['claude-fable-5', MESSAGES],
  ['claude-haiku-4-5', MESSAGES],
  ['claude-opus-4-6', MESSAGES],
  ['claude-opus-5', MESSAGES],
  ['gemini-3-pro', GOOGLE],
  ['gemini-3.5-flash-lite', GOOGLE],
  ['gemini-3.1-pro', GOOGLE],
  ['gemini-3.5-flash', GOOGLE],
  ['gemini-3.6-flash', GOOGLE],
  ['gemini-3-flash', GOOGLE],
  ['gemini-3.7-flash', GOOGLE],
]);

const GO_PROTOCOL_OVERRIDES: ReadonlyMap<string, ProtocolSet> = new Map<
  string,
  ProtocolSet
>([
  ['grok-4.5', RESPONSES],
  ['gpt-5.6-luna', RESPONSES],
  ['muse-spark-1.2-contributor', RESPONSES],
  ['minimax-m3', MESSAGES],
  ['minimax-m2.7', MESSAGES],
  ['minimax-m2.5', MESSAGES],
  ['qwen3.5-plus', CHAT_COMPLETIONS_AND_MESSAGES],
  ['qwen3.6-plus', CHAT_COMPLETIONS_AND_MESSAGES],
  ['qwen3.7-max', CHAT_COMPLETIONS_AND_MESSAGES],
  ['qwen3.7-plus', CHAT_COMPLETIONS_AND_MESSAGES],
  ['qwen3.8-max', CHAT_COMPLETIONS_AND_MESSAGES],
]);

const PROTOCOL_OVERRIDES: Readonly<
  Record<OpenCodeService, ReadonlyMap<string, ProtocolSet>>
> = {
  zen: ZEN_PROTOCOL_OVERRIDES,
  go: GO_PROTOCOL_OVERRIDES,
};

export function getOpenCodeService(
  baseUrl: string,
): OpenCodeService | undefined {
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

function getOpenCodeModelProtocols(
  modelId: string,
  service: OpenCodeService,
): ProtocolSet {
  const id = modelId.trim().toLowerCase();
  return PROTOCOL_OVERRIDES[service].get(id) ?? CHAT_COMPLETIONS;
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
      ? rawModels.filter((model) =>
          getOpenCodeModelProtocols(model.id, service).includes(
            providerProtocol,
          ),
        )
      : rawModels;
  const mergedModels = mergeWithWellKnownModels(selectedModels, provider);

  return service ? mergedModels.map(addFreeTierLabel) : mergedModels;
}
