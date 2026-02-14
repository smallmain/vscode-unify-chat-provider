import * as vscode from 'vscode';
import type { ConfigStore } from '../config-store';
import {
  AuthProvider,
  AuthProviderContext,
  AuthErrorType,
} from './auth-provider';
import { AuthConfig, AuthCredential, AuthMethod } from './types';
import { createAuthProvider } from './create-auth-provider';
import type { EventedUriHandler } from '../uri-handler';
import type { SecretStore } from '../secret';
import { authLog } from '../logger';

/**
 * Stored error information for a provider
 */
export interface AuthErrorInfo {
  error: Error;
  errorType: AuthErrorType;
}

/**
 * Authentication manager - unified management for all provider authentication states
 */
export class AuthManager implements vscode.Disposable {
  private readonly providers = new Map<string, AuthProvider>();
  private readonly providerConfigSignatures = new Map<string, string>();
  private readonly providerStatusSubscriptions = new Map<
    string,
    vscode.Disposable
  >();
  private readonly refreshTimers = new Map<string, NodeJS.Timeout>();
  private readonly refreshInFlight = new Set<string>();
  private readonly refreshGeneration = new Map<string, number>();
  private readonly credentialInFlight = new Map<
    string,
    Promise<AuthCredential | undefined>
  >();
  private readonly disposables: vscode.Disposable[] = [];
  /** Stores the last error for each provider (for silent error handling) */
  private readonly lastErrors = new Map<string, AuthErrorInfo>();

  private readonly _onAuthRequired = new vscode.EventEmitter<string>();
  /**
   * @deprecated This event is no longer fired for passive refresh failures.
   * Use getLastError() to check for errors when actively requesting credentials.
   */
  readonly onAuthRequired = this._onAuthRequired.event;

  constructor(
    private readonly configStore: ConfigStore,
    private readonly secretStore: SecretStore,
    private readonly uriHandler?: EventedUriHandler,
  ) {
    this.disposables.push(this._onAuthRequired);
  }

  private resolveCurrentAuth(providerName: string): AuthConfig | undefined {
    return this.configStore.getProvider(providerName)?.auth;
  }

  /**
   * Create AuthProviderContext for a provider
   */
  private createContext(providerName: string): AuthProviderContext {
    return {
      providerId: providerName,
      providerLabel: providerName,
      secretStore: this.secretStore,
      uriHandler: this.uriHandler,
      persistAuthConfig: async (auth) => {
        const provider = this.configStore.getProvider(providerName);
        if (!provider) {
          return;
        }
        await this.configStore.upsertProvider({ ...provider, auth });
      },
    };
  }

  private clearOtherMethods(
    providerName: string,
    keepMethod: AuthMethod,
  ): void {
    for (const key of Array.from(this.providers.keys())) {
      const parsed = parseCacheKey(key);
      if (!parsed) {
        continue;
      }
      if (parsed.providerName !== providerName) {
        continue;
      }
      if (parsed.method === keepMethod) {
        continue;
      }
      this.disposeProviderByCacheKey(key);
    }
  }

  private disposeProviderByCacheKey(cacheKeyValue: string): void {
    this.bumpRefreshGeneration(cacheKeyValue);

    const subscription = this.providerStatusSubscriptions.get(cacheKeyValue);
    if (subscription) {
      subscription.dispose();
      this.providerStatusSubscriptions.delete(cacheKeyValue);
    }

    const provider = this.providers.get(cacheKeyValue);
    if (provider) {
      provider.dispose?.();
      this.providers.delete(cacheKeyValue);
    }

    this.cancelRefreshByCacheKey(cacheKeyValue);
    this.lastErrors.delete(cacheKeyValue);
    this.providerConfigSignatures.delete(cacheKeyValue);

    if (!this.refreshInFlight.has(cacheKeyValue)) {
      this.refreshGeneration.delete(cacheKeyValue);
    }
  }

  private getRefreshGeneration(cacheKeyValue: string): number {
    return this.refreshGeneration.get(cacheKeyValue) ?? 0;
  }

  private bumpRefreshGeneration(cacheKeyValue: string): void {
    const next = this.getRefreshGeneration(cacheKeyValue) + 1;
    this.refreshGeneration.set(cacheKeyValue, next);
  }

  private getProviderWithAuth(
    providerName: string,
    auth: AuthConfig,
  ): AuthProvider | undefined {
    if (auth.method === 'none') {
      authLog.verbose(
        `${providerName}:none`,
        'Skipping provider with no auth method',
      );
      return undefined;
    }

    this.clearOtherMethods(providerName, auth.method);

    const cacheKeyValue = cacheKey(providerName, auth.method);
    const signature = stableStringify(auth);

    const existing = this.providers.get(cacheKeyValue);
    const existingSignature = this.providerConfigSignatures.get(cacheKeyValue);
    if (existing && existingSignature !== signature) {
      authLog.verbose(
        `${providerName}:${auth.method}`,
        'Config changed, recreating provider',
      );
      this.disposeProviderByCacheKey(cacheKeyValue);
    }

    let provider = this.providers.get(cacheKeyValue);

    if (!provider) {
      authLog.verbose(
        `${providerName}:${auth.method}`,
        'Creating new auth provider',
      );
      const context = this.createContext(providerName);
      const created = createAuthProvider(context, auth);
      if (created) {
        const providerInstance = created;
        provider = providerInstance;
        this.providers.set(cacheKeyValue, providerInstance);
        this.providerConfigSignatures.set(cacheKeyValue, signature);
        authLog.verbose(
          `${providerName}:${auth.method}`,
          'Auth provider created successfully',
        );

        // Subscribe to status changes
        const subscription = providerInstance.onDidChangeStatus((change) => {
          if (this.providers.get(cacheKeyValue) !== providerInstance) {
            return;
          }

          authLog.verbose(
            `${providerName}:${auth.method}`,
            `Status changed to: ${change.status}`,
          );

          if (change.status === 'expired' || change.status === 'error') {
            // Store error silently instead of firing event
            const errorInfo: AuthErrorInfo = {
              error: change.error ?? new Error('Authentication expired'),
              errorType: change.errorType ?? 'unknown_error',
            };
            this.lastErrors.set(cacheKeyValue, errorInfo);
            authLog.error(
              `${providerName}:${auth.method}`,
              `Auth ${change.status}: ${errorInfo.error.message}`,
            );
            this.cancelRefreshByCacheKey(cacheKeyValue);
            return;
          }

          if (change.status === 'valid') {
            // Clear any stored error on success
            this.lastErrors.delete(cacheKeyValue);
            this.scheduleRefreshFromProvider(
              cacheKeyValue,
              providerName,
              providerInstance,
            );
          }

          if (change.status === 'revoked') {
            this.lastErrors.delete(cacheKeyValue);
          }
        });
        this.providerStatusSubscriptions.set(cacheKeyValue, subscription);
      } else {
        authLog.error(
          `${providerName}:${auth.method}`,
          'Failed to create auth provider',
        );
      }
    }

    return provider;
  }

  /**
   * Get or create AuthProvider instance for a provider
   */
  getProvider(providerName: string): AuthProvider | undefined {
    const auth = this.resolveCurrentAuth(providerName);
    if (!auth || auth.method === 'none') {
      authLog.verbose(
        `${providerName}:none`,
        'Skipping provider with no auth method',
      );
      return undefined;
    }
    return this.getProviderWithAuth(providerName, auth);
  }

  /**
   * Get valid credential for a provider (handles refresh automatically)
   */
  async getCredential(
    providerName: string,
  ): Promise<AuthCredential | undefined> {
    const auth = this.resolveCurrentAuth(providerName);
    if (!auth || auth.method === 'none') {
      authLog.verbose(
        `${providerName}:none`,
        'No auth configured, returning undefined',
      );
      return undefined;
    }

    const provider = this.getProviderWithAuth(providerName, auth);
    if (!provider) {
      authLog.verbose(
        `${providerName}:${auth.method}`,
        'getCredential result: unavailable (provider missing)',
      );
      return undefined;
    }

    const cacheKeyValue = cacheKey(providerName, auth.method);

    const inFlight = this.credentialInFlight.get(cacheKeyValue);
    if (inFlight) {
      const credential = await inFlight;
      authLog.verbose(
        `${providerName}:${auth.method}`,
        `getCredential result: ${
          credential
            ? `ok (expires: ${
                credential.expiresAt
                  ? new Date(credential.expiresAt).toISOString()
                  : 'never'
              })`
            : 'empty'
        }`,
      );
      return credential;
    }

    const promise = this.doGetCredential(
      cacheKeyValue,
      providerName,
      provider,
    ).finally(() => {
      this.credentialInFlight.delete(cacheKeyValue);
    });

    this.credentialInFlight.set(cacheKeyValue, promise);
    const credential = await promise;
    authLog.verbose(
      `${providerName}:${auth.method}`,
      `getCredential result: ${
        credential
          ? `ok (expires: ${
              credential.expiresAt
                ? new Date(credential.expiresAt).toISOString()
                : 'never'
            })`
          : 'empty'
      }`,
    );
    return credential;
  }

  private async doGetCredential(
    cacheKeyValue: string,
    providerName: string,
    provider: AuthProvider,
  ): Promise<AuthCredential | undefined> {
    const credential = await provider.getCredential();

    if (!credential) {
      return undefined;
    }
    this.lastErrors.delete(cacheKeyValue);

    if (credential.expiresAt !== undefined) {
      this.scheduleRefresh(
        cacheKeyValue,
        providerName,
        provider,
        credential.expiresAt,
      );
    } else {
      this.cancelRefresh(providerName);
    }

    return credential;
  }

  private scheduleRefreshFromProvider(
    cacheKeyValue: string,
    providerName: string,
    provider: AuthProvider,
  ): void {
    provider
      .getCredential()
      .then((credential) => {
        if (this.providers.get(cacheKeyValue) !== provider) {
          return;
        }
        if (credential?.expiresAt === undefined) {
          this.cancelRefreshByCacheKey(cacheKeyValue);
          return;
        }
        this.scheduleRefresh(
          cacheKeyValue,
          providerName,
          provider,
          credential.expiresAt,
        );
      })
      .catch(() => {
        if (this.providers.get(cacheKeyValue) !== provider) {
          return;
        }
        this.cancelRefreshByCacheKey(cacheKeyValue);
      });
  }

  private scheduleRefresh(
    cacheKeyValue: string,
    providerName: string,
    provider: AuthProvider,
    expiresAt: number,
    expectedGeneration?: number,
  ): void {
    if (this.providers.get(cacheKeyValue) !== provider) {
      return;
    }

    const expected =
      expectedGeneration ?? this.getRefreshGeneration(cacheKeyValue);
    if (this.getRefreshGeneration(cacheKeyValue) !== expected) {
      return;
    }

    const parsed = parseCacheKey(cacheKeyValue);
    const method = parsed?.method ?? 'unknown';

    if (!provider.refresh) {
      authLog.verbose(
        `${providerName}:${method}`,
        'Provider does not support refresh',
      );
      this.cancelRefreshByCacheKey(cacheKeyValue);
      return;
    }

    const bufferMs = provider.getExpiryBufferMs();
    const refreshAt = expiresAt - bufferMs;
    const delay = Math.max(0, refreshAt - Date.now());

    this.cancelRefreshByCacheKey(cacheKeyValue);

    authLog.verbose(
      `${providerName}:${method}`,
      `Scheduling refresh in ${Math.round(delay / 1000)}s (buffer: ${bufferMs}ms)`,
    );

    const generationAtSchedule = expected;

    const timer = setTimeout(async () => {
      this.refreshTimers.delete(cacheKeyValue);
      if (this.getRefreshGeneration(cacheKeyValue) !== generationAtSchedule) {
        return;
      }
      if (this.providers.get(cacheKeyValue) !== provider) {
        return;
      }
      await this.performRefresh(
        cacheKeyValue,
        providerName,
        provider,
        generationAtSchedule,
      );
    }, delay);

    this.refreshTimers.set(cacheKeyValue, timer);
  }

  /**
   * Cancel scheduled refresh for a provider
   */
  cancelRefresh(providerName: string): void {
    const keys = new Set<string>();

    for (const key of this.providers.keys()) {
      const parsed = parseCacheKey(key);
      if (parsed?.providerName === providerName) {
        keys.add(key);
      }
    }

    for (const key of this.refreshTimers.keys()) {
      const parsed = parseCacheKey(key);
      if (parsed?.providerName === providerName) {
        keys.add(key);
      }
    }

    for (const key of this.refreshInFlight) {
      const parsed = parseCacheKey(key);
      if (parsed?.providerName === providerName) {
        keys.add(key);
      }
    }

    for (const key of keys) {
      this.bumpRefreshGeneration(key);
      this.cancelRefreshByCacheKey(key);
    }
  }

  private cancelRefreshByCacheKey(cacheKeyValue: string): void {
    const timer = this.refreshTimers.get(cacheKeyValue);
    if (timer) {
      clearTimeout(timer);
      this.refreshTimers.delete(cacheKeyValue);
    }
  }

  /**
   * Perform token refresh for a provider (passive, silent on failure)
   */
  private async performRefresh(
    cacheKeyValue: string,
    providerName: string,
    provider: AuthProvider,
    expectedGeneration: number,
  ): Promise<void> {
    const parsed = parseCacheKey(cacheKeyValue);
    const method = parsed?.method ?? 'unknown';

    if (!provider.refresh) {
      return;
    }

    if (this.getRefreshGeneration(cacheKeyValue) !== expectedGeneration) {
      authLog.verbose(
        `${providerName}:${method}`,
        'Refresh cancelled: generation mismatch',
      );
      return;
    }

    if (this.providers.get(cacheKeyValue) !== provider) {
      authLog.verbose(
        `${providerName}:${method}`,
        'Refresh cancelled: provider changed',
      );
      return;
    }

    if (this.refreshInFlight.has(cacheKeyValue)) {
      authLog.verbose(
        `${providerName}:${method}`,
        'Refresh already in flight, skipping',
      );
      return;
    }
    this.refreshInFlight.add(cacheKeyValue);

    authLog.verbose(`${providerName}:${method}`, 'Starting token refresh');

    try {
      const success = await provider.refresh();
      if (!success) {
        // Error is already stored by the status change handler
        authLog.error(
          `${providerName}:${method}`,
          'Token refresh failed (provider returned false)',
        );
        if (this.providers.get(cacheKeyValue) === provider) {
          this.cancelRefreshByCacheKey(cacheKeyValue);
        }
        return;
      }

      if (this.getRefreshGeneration(cacheKeyValue) !== expectedGeneration) {
        return;
      }

      if (this.providers.get(cacheKeyValue) !== provider) {
        return;
      }

      // Clear any stored error on success
      this.lastErrors.delete(cacheKeyValue);
      authLog.verbose(`${providerName}:${method}`, 'Token refresh successful');

      const credential = await provider.getCredential();
      if (this.getRefreshGeneration(cacheKeyValue) !== expectedGeneration) {
        return;
      }
      if (this.providers.get(cacheKeyValue) !== provider) {
        return;
      }

      if (credential?.expiresAt !== undefined) {
        this.scheduleRefresh(
          cacheKeyValue,
          providerName,
          provider,
          credential.expiresAt,
          expectedGeneration,
        );
      } else {
        this.cancelRefreshByCacheKey(cacheKeyValue);
      }
    } catch (error) {
      // Error is already stored by the status change handler
      authLog.error(
        `${providerName}:${method}`,
        'Token refresh failed with exception',
        error,
      );
      if (this.providers.get(cacheKeyValue) === provider) {
        this.cancelRefreshByCacheKey(cacheKeyValue);
      }
    } finally {
      this.refreshInFlight.delete(cacheKeyValue);
    }
  }

  /**
   * Get last error for a provider (for active error handling in UI)
   */
  getLastError(providerName: string): AuthErrorInfo | undefined {
    const auth = this.resolveCurrentAuth(providerName);
    if (!auth || auth.method === 'none') {
      return undefined;
    }
    return this.lastErrors.get(cacheKey(providerName, auth.method));
  }

  /**
   * Clear last error for a provider
   */
  clearLastError(providerName: string): void {
    const auth = this.resolveCurrentAuth(providerName);
    if (!auth || auth.method === 'none') {
      return;
    }
    this.lastErrors.delete(cacheKey(providerName, auth.method));
  }

  /**
   * Manually trigger a refresh retry (for active user action)
   */
  async retryRefresh(providerName: string): Promise<boolean> {
    const auth = this.resolveCurrentAuth(providerName);
    if (!auth || auth.method === 'none') {
      authLog.verbose(
        `${providerName}:none`,
        'No auth configured, cannot retry refresh',
      );
      return false;
    }

    authLog.verbose(
      `${providerName}:${auth.method}`,
      'Manual refresh retry requested',
    );
    const provider = this.getProviderWithAuth(providerName, auth);
    if (!provider?.refresh) {
      authLog.verbose(
        `${providerName}:${auth.method}`,
        'Provider does not support refresh',
      );
      return false;
    }

    const cacheKeyValue = cacheKey(providerName, auth.method);
    try {
      authLog.verbose(
        `${providerName}:${auth.method}`,
        'Attempting manual refresh',
      );
      const success = await provider.refresh();
      if (success) {
        this.lastErrors.delete(cacheKeyValue);
        authLog.verbose(
          `${providerName}:${auth.method}`,
          'Manual refresh successful',
        );

        // Re-schedule refresh if credential has expiry
        const credential = await provider.getCredential();
        if (credential?.expiresAt !== undefined) {
          this.scheduleRefresh(
            cacheKeyValue,
            providerName,
            provider,
            credential.expiresAt,
          );
        }
      } else {
        authLog.error(
          `${providerName}:${auth.method}`,
          'Manual refresh failed (provider returned false)',
        );
      }
      return success;
    } catch (error) {
      // Error is already stored by the status change handler
      authLog.error(
        `${providerName}:${auth.method}`,
        'Manual refresh failed with exception',
        error,
      );
      return false;
    }
  }

  /**
   * Clear cached provider instance
   */
  clearProvider(providerName: string): void {
    for (const key of Array.from(this.providers.keys())) {
      const parsed = parseCacheKey(key);
      if (parsed?.providerName !== providerName) {
        continue;
      }
      this.disposeProviderByCacheKey(key);
    }
    this.cancelRefresh(providerName);
  }

  /**
   * Clear all cached providers
   */
  clearAll(): void {
    for (const key of Array.from(this.providers.keys())) {
      this.disposeProviderByCacheKey(key);
    }

    for (const timer of this.refreshTimers.values()) {
      clearTimeout(timer);
    }
    this.refreshTimers.clear();

    for (const subscription of this.providerStatusSubscriptions.values()) {
      subscription.dispose();
    }
    this.providerStatusSubscriptions.clear();

    this.providerConfigSignatures.clear();
    this.lastErrors.clear();
    this.refreshGeneration.clear();
  }

  dispose(): void {
    this.clearAll();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}

function cacheKey(providerName: string, method: AuthMethod): string {
  return `${providerName}:${method}`;
}

function parseCacheKey(
  key: string,
): { providerName: string; method: AuthMethod } | null {
  const index = key.lastIndexOf(':');
  if (index <= 0 || index === key.length - 1) {
    return null;
  }

  const providerName = key.slice(0, index);
  const methodRaw = key.slice(index + 1);

  return {
    providerName,
    method: methodRaw as AuthMethod,
  };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortForStableStringify(value));
}

function sortForStableStringify(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForStableStringify);
  }

  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const sorted: Record<string, unknown> = {};
    for (const key of keys) {
      sorted[key] = sortForStableStringify(record[key]);
    }
    return sorted;
  }

  return value;
}
