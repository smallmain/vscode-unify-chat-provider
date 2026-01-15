import * as vscode from 'vscode';
import { AuthConfig, AuthCredential } from './types';
import type { EventedUriHandler } from '../uri-handler';
import type { SecretStore } from '../secret';

/**
 * Authentication provider definition - used for registration and display
 */
export interface AuthProviderDefinition {
  /** Unique identifier */
  readonly id: string;
  /** Display label */
  readonly label: string;
  /** Description */
  readonly description?: string;
}

/**
 * Configuration result returned by AuthProvider.configure()
 */
export interface AuthConfigureResult {
  /** Whether configuration was successful */
  success: boolean;
  /** The resulting AuthConfig (to be saved to ProviderConfig) */
  config?: AuthConfig;
  /** Error message if failed */
  error?: string;
}

/**
 * Error type for authentication errors
 */
export type AuthErrorType = 'auth_error' | 'transient_error' | 'unknown_error';

/**
 * Authentication status change event
 */
export interface AuthStatusChange {
  status: 'valid' | 'expired' | 'revoked' | 'error';
  error?: Error;
  /** Error type for UI to decide whether to show retry option */
  errorType?: AuthErrorType;
}

/**
 * Context passed to AuthProvider during creation
 */
export interface AuthProviderContext {
  /** Stable unique identifier for this provider auth (used for caching + storage keys) */
  providerId: string;
  /** Display name for UI prompts */
  providerLabel: string;
  /** SecretStore instance */
  secretStore: SecretStore;
  /** URI handler for OAuth callbacks */
  uriHandler?: EventedUriHandler;
  persistAuthConfig?: (auth: AuthConfig) => Promise<void>;
}

export type AuthUiStatusSnapshot =
  | { kind: 'not-configured' }
  | { kind: 'not-authorized' }
  | { kind: 'missing-secret'; message?: string }
  | { kind: 'error'; message?: string }
  | { kind: 'expired'; refreshable: boolean; expiresAt?: number }
  | { kind: 'valid'; expiresAt?: number };

export type AuthStatusViewActionKind = 'inline' | 'close';

export type AuthStatusViewItem = vscode.QuickPickItem & {
  action?: {
    kind: AuthStatusViewActionKind;
    run: () => Promise<void>;
  };
};

/**
 * Authentication provider interface - abstraction layer for all auth methods.
 * UI and service layers work through this interface without knowing implementation details.
 */
export interface AuthProvider {
  /** Provider definition information */
  readonly definition: AuthProviderDefinition;

  getConfig(): AuthConfig | undefined;

  getSummaryDetail?(): Promise<string | undefined>;

  getStatusSnapshot?(): Promise<AuthUiStatusSnapshot>;

  getStatusViewItems?(): Promise<AuthStatusViewItem[]>;

  /**
   * Get valid authentication credential.
   * @returns Credential (e.g., access token / API Key), or undefined if not authenticated
   */
  getCredential(): Promise<AuthCredential | undefined>;

  /**
   * Buffer time (ms) before `expiresAt` when the credential should be treated as
   * expiring and refreshed proactively.
   */
  getExpiryBufferMs(): number;

  /**
   * Check if current authentication is valid.
   */
  isValid(): Promise<boolean>;

  /**
   * Configure authentication - Provider handles its own UI and flow.
   * UI layer calls this method without knowing the specific configuration process.
   * @returns Configuration result including the final AuthConfig data
   */
  configure(): Promise<AuthConfigureResult>;

  /**
   * Refresh authentication (if supported).
   * @returns Whether refresh was successful
   */
  refresh?(): Promise<boolean>;

  /**
   * Revoke/clear authentication.
   */
  revoke(): Promise<void>;

  /**
   * Subscribe to authentication status changes.
   */
  onDidChangeStatus: vscode.Event<AuthStatusChange>;

  /**
   * Dispose of resources.
   */
  dispose?(): void;
}
