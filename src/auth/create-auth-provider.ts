import type { AuthProvider, AuthProviderContext } from './auth-provider';
import type { AuthConfig, AuthMethod } from './types';
import { getAuthMethodCtor } from './definitions';

export function createAuthProvider(
  context: AuthProviderContext,
  config: AuthConfig,
): AuthProvider | null {
  const ctor = getAuthMethodCtor(config.method);
  if (!ctor) {
    return null;
  }
  return new ctor(context, config);
}

export function createAuthProviderForMethod(
  context: AuthProviderContext,
  method: AuthMethod,
  config?: AuthConfig,
): AuthProvider | null {
  const ctor = getAuthMethodCtor(method);
  if (!ctor) {
    return null;
  }

  if (method === 'none') {
    return null;
  }
  return new ctor(context, config?.method === method ? config : undefined);
}
