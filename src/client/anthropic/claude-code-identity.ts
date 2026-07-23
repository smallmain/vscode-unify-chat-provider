import type { AuthConfig, AuthTokenInfo } from '../../auth/types';

export function deriveClaudeCodeIdentitySeed(
  auth: AuthConfig | undefined,
  credential: AuthTokenInfo | undefined,
): string | null {
  if (!auth || auth.method === 'none') {
    return null;
  }

  if (auth.method === 'api-key') {
    return auth.apiKey?.trim() || null;
  }

  if (
    credential?.kind === 'token' &&
    credential.authContext?.method === auth.method
  ) {
    return credential.authContext.sessionId.trim() || null;
  }

  return null;
}
