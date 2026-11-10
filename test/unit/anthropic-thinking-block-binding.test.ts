import { describe, expect, it } from 'vitest';
import { applyThinkingBlockBinding } from '../../src/client/anthropic/thinking-block-binding';

type Request = Parameters<typeof applyThinkingBlockBinding>[0];

function request(): Request {
  return {
    model: 'claude-haiku-5-5', max_tokens: 1000,
    thinking: { type: 'adaptive' },
    messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'reasoning', signature: 'signature' }, { type: 'text', text: 'answer' }] }],
  };
}

describe('Anthropic thinking prefix binding', () => {
  it('lets Claude discard invalidated thinking while preserving the original history', () => {
    const body = request();
    const history = structuredClone(body.messages);
    body.betas = ['context-1m-2025-08-07'];
    applyThinkingBlockBinding(body);
    expect(body.thinking).toEqual({ type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
    expect(body.betas).toEqual(['context-1m-2025-08-07', 'thinking-binding-controls-2026-08-01']);
    expect(body.messages).toEqual(history);
    applyThinkingBlockBinding(body);
    expect(body.betas).toHaveLength(2);
  });

  it('supplies adaptive thinking when a supported model relies on its default', () => {
    const body = request();
    delete body.thinking;
    applyThinkingBlockBinding(body);
    expect(body).toMatchObject({ thinking: { type: 'adaptive' } });
  });

  it('respects an explicitly configured error policy', () => {
    const body = request();
    body.thinking = { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'error' } };
    applyThinkingBlockBinding(body);
    expect(body.thinking.block_binding?.prefix_mismatch_behavior).toBe('error');
  });

  it.each([{ type: 'disabled' }, { type: 'enabled', budget_tokens: 1024 }] as const)('does not change $type thinking', (thinking) => {
    const body = { ...request(), thinking };
    const before = structuredClone(body);
    applyThinkingBlockBinding(body);
    expect(body).toEqual(before);
  });

  it('does not add a beta to the first turn or text-only history', () => {
    const body = request();
    body.messages = [{ role: 'user', content: 'hello' }];
    const before = structuredClone(body);
    applyThinkingBlockBinding(body);
    expect(body).toEqual(before);
  });

  it('also handles encrypted thinking blocks', () => {
    const body = request();
    body.messages = [{ role: 'assistant', content: [{ type: 'redacted_thinking', data: 'opaque' }] }];
    applyThinkingBlockBinding(body);
    expect(body.thinking?.block_binding?.prefix_mismatch_behavior).toBe('drop_block');
  });
});
