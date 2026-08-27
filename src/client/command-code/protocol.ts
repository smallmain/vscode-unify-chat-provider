import { getBaseModelId } from '../../model-id-utils';
import type { ModelConfig } from '../../types';

export type CommandCodeProtocol =
  | 'anthropic-messages'
  | 'openai-chat-completions';

function normalizedIdentityTokens(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  // Preserve identity boundaries before case folding, including CamelCase and
  // compact version forms such as ClaudeSonnet and claude3.
  const boundarySeparated = value
    .normalize('NFKC')
    .trim()
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2');
  return boundarySeparated.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function hasAnthropicIdentity(value: string | undefined): boolean {
  return normalizedIdentityTokens(value).some(
    (token) => token === 'anthropic' || token === 'claude',
  );
}

export function resolveCommandCodeProtocol(
  model: Pick<ModelConfig, 'id' | 'family' | 'name'>,
): CommandCodeProtocol {
  const baseId = getBaseModelId(model.id);
  return [baseId, model.family, model.name].some(hasAnthropicIdentity)
    ? 'anthropic-messages'
    : 'openai-chat-completions';
}
