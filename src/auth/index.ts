// Types
export * from './types';
export * from './definitions';

// Auth provider interface and types
export type {
  AuthProvider,
  AuthProviderContext,
  AuthProviderDefinition,
  AuthConfigureResult,
  AuthStatusChange,
  AuthErrorType,
  AuthStatusViewItem,
  AuthStatusViewActionKind,
  AuthUiStatusSnapshot,
} from './auth-provider';

// Provider factory
export {
  createAuthProvider,
  createAuthProviderForMethod,
} from './create-auth-provider';

// Manager
export { AuthManager } from './auth-manager';
export type { AuthErrorInfo } from './auth-manager';
