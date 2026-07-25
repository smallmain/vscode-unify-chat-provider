import type { MessageCreateParamsStreaming } from '@anthropic-ai/sdk/resources/beta/messages';
import { describe, expect, it } from 'vitest';
import { serializeClaudeCodeCchInput } from '../../src/client/anthropic/claude-code-cch';

describe('Claude Code 2.1.161 CCH input', () => {
  const requestBase = {
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 4096,
    betas: ['oauth-2025-04-20'],
  } satisfies Omit<MessageCreateParamsStreaming, 'stream'>;

  it('matches the SDK wire body for streaming requests', () => {
    expect(serializeClaudeCodeCchInput(requestBase, true)).toBe(
      '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"hello"}],"max_tokens":4096,"stream":true}',
    );
  });

  it('includes the non-streaming flag in the signed body', () => {
    expect(serializeClaudeCodeCchInput(requestBase, false)).toBe(
      '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"hello"}],"max_tokens":4096,"stream":false}',
    );
  });

  it('does not mutate the request parameters while excluding betas', () => {
    serializeClaudeCodeCchInput(requestBase, true);

    expect(requestBase.betas).toEqual(['oauth-2025-04-20']);
    expect('stream' in requestBase).toBe(false);
  });
});
