import type { MessageCreateParamsStreaming } from '@anthropic-ai/sdk/resources/beta/messages';

type BindingRequest = Omit<MessageCreateParamsStreaming, 'stream' | 'thinking'> & {
  thinking?: MessageCreateParamsStreaming['thinking'] & {
    block_binding?: { prefix_mismatch_behavior?: 'error' | 'drop_block' };
  };
};

export function applyThinkingBlockBinding(request: BindingRequest): boolean {
  const thinking = request.thinking ?? { type: 'adaptive' };
  if (thinking.type !== 'adaptive') return false;
  const hasThinking = request.messages.some((message) =>
    Array.isArray(message.content) && message.content.some((block) =>
      block.type === 'thinking' || block.type === 'redacted_thinking',
    ),
  );
  if (!hasThinking) return false;

  // Claude verifies thinking against the entire earlier system/tools prefix.
  // Dynamic tools and edited instructions can invalidate otherwise intact blocks.
  request.thinking = {
    ...thinking,
    block_binding: {
      prefix_mismatch_behavior: 'drop_block',
      ...thinking.block_binding,
    },
  };
  request.betas = [...new Set([
    ...(request.betas ?? []),
    'thinking-binding-controls-2026-08-01',
  ])];
  return true;
}
