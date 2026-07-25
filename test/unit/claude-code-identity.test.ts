import { describe, expect, it } from 'vitest';
import { deriveClaudeCodeIdentitySeed } from '../../src/client/anthropic/claude-code-identity';
import type { AuthTokenInfo } from '../../src/auth/types';

describe('Claude Code identity seed', () => {
  it('uses the local Claude OAuth session identity', () => {
    const credential: AuthTokenInfo = {
      kind: 'token',
      token: 'oauth-token',
      authContext: {
        method: 'claude-code',
        bindingId: 'binding',
        sessionId: 'session',
        revision: 1,
      },
    };

    expect(
      deriveClaudeCodeIdentitySeed(
        {
          method: 'claude-code',
          bindingId: '00000000-0000-4000-8000-000000000101',
        },
        credential,
      ),
    ).toBe('session');
  });

  it('preserves the configured API key identity behavior', () => {
    expect(
      deriveClaudeCodeIdentitySeed(
        { method: 'api-key', apiKey: '  $UCPSECRET:configured-ref$  ' },
        { kind: 'token', token: 'resolved-api-key' },
      ),
    ).toBe('$UCPSECRET:configured-ref$');
    expect(
      deriveClaudeCodeIdentitySeed(
        { method: 'api-key', apiKey: 'plain-api-key' },
        undefined,
      ),
    ).toBe('plain-api-key');
  });

  it('does not reuse a credential for the wrong authentication method', () => {
    expect(
      deriveClaudeCodeIdentitySeed(
        {
          method: 'claude-code',
          bindingId: '00000000-0000-4000-8000-000000000101',
        },
        {
          kind: 'token',
          token: 'oauth-token',
          authContext: {
            method: 'openai-codex',
            bindingId: '00000000-0000-4000-8000-000000000102',
            sessionId: 'wrong-session',
            revision: 1,
          },
        },
      ),
    ).toBeNull();
    expect(
      deriveClaudeCodeIdentitySeed(
        { method: 'none' },
        { kind: 'token', token: 'unexpected-token' },
      ),
    ).toBeNull();
  });
});
