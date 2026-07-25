import * as vscode from 'vscode';
import type { ProviderConfig } from '../types';
import type { ProviderCompletionPersistenceHints } from '../config-store';
import {
  AuthProvider,
  AuthProviderContext,
  AuthErrorType,
} from './auth-provider';
import {
  AuthConfig,
  AuthCredential,
  AuthMethod,
  AuthRuntimeConfig,
} from './types';
import { createAuthProvider } from './create-auth-provider';
import type { EventedUriHandler } from '../uri-handler';
import type { SecretStore } from '../secret';
import { authLog } from '../logger';
import { mainInstance } from '../main-instance';
import { MainInstanceError } from '../main-instance/errors';
import { normalizeAuthForProvider } from './definitions';
import {
  assertValidInlineSessionAuthToken,
  computeStaticAuthFingerprint,
  isSessionAuthConfig,
  isSessionAuthMethod,
  isValidAuthBindingId,
  parseAuthContext,
  stripSessionAuthState,
} from './local-auth-state';
import {
  LocalAuthStateConflictError,
  type LocalAuthCommitGuard,
  type LocalAuthStateChange,
  type LocalAuthStateChangeReason,
} from '../secret';
import {
  captureProviderSourceGuard,
  isProviderSourceGuardCurrent,
  type ProviderSourceGuard,
} from './provider-source-guard';
/*
 * Local provider writes emit through SecretStore before the provider updates
 * its in-memory config. Track the exact expected revision so that event is not
 * mistaken for an external account switch.
 */
type LocalPersistRevision = { cacheKeyValue: string; revision: number };

const AUTH_STATE_CHANGED_EVENT = 'auth.state.changed';

/**
 * Stored error information for a provider
 */
export interface AuthErrorInfo {
  error: Error;
  errorType: AuthErrorType;
}

export interface AuthManagerConfigStore {
  getProvider(name: string): ProviderConfig | undefined;
  upsertProvider(provider: ProviderConfig): Promise<void>;
  upsertProviderIfUnchanged(
    provider: ProviderConfig,
    hints: ProviderCompletionPersistenceHints,
    isSourceCurrent: () => boolean,
  ): Promise<boolean>;
}

export interface PreparedProviderPersistence {
  provider: ProviderConfig;
  commit(): void;
  rollback(): Promise<void>;
}

/**
 * Authentication manager - unified management for all provider authentication states
 */
export class AuthManager implements vscode.Disposable {
  private readonly providers = new Map<string, AuthProvider>();
  private readonly providerConfigSignatures = new Map<string, string>();
  private readonly cacheOwners = new Map<
    string,
    { providerName: string; method: AuthMethod }
  >();
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
  private lastKnownRole: 'leader' | 'follower';
  /** Stores the last error for each provider (for silent error handling) */
  private readonly lastErrors = new Map<string, AuthErrorInfo>();
  private readonly lastAuthStateRevisions = new Map<string, number>();
  private readonly localPersistRevisions = new Map<string, number>();
  private leaderAuthReady: boolean;
  private disposed = false;

  private readonly _onAuthRequired = new vscode.EventEmitter<string>();
  private readonly _onDidChangeAuthState =
    new vscode.EventEmitter<LocalAuthStateChange>();
  /**
   * @deprecated This event is no longer fired for passive refresh failures.
   * Use getLastError() to check for errors when actively requesting credentials.
   */
  readonly onAuthRequired = this._onAuthRequired.event;
  readonly onDidChangeAuthState = this._onDidChangeAuthState.event;

  constructor(
    private readonly configStore: AuthManagerConfigStore,
    private readonly secretStore: SecretStore,
    private readonly uriHandler?: EventedUriHandler,
    leaderAuthReady = true,
  ) {
    this.leaderAuthReady = leaderAuthReady;
    this.disposables.push(this._onAuthRequired, this._onDidChangeAuthState);
    this.lastKnownRole = mainInstance.isLeader() ? 'leader' : 'follower';

    this.disposables.push(
      this.secretStore.onDidChangeLocalAuthState((change) => {
        this.emitAuthStateChange(change);
        if (this.isLeader()) {
          mainInstance.broadcast(AUTH_STATE_CHANGED_EVENT, change);
        }
      }),
      mainInstance.onDidReceiveEvent(({ event, payload }) => {
        if (event !== AUTH_STATE_CHANGED_EVENT) return;
        const change = parseLocalAuthStateChange(payload);
        if (!change) return;
        void this.secretStore
          .reloadLocalAuthState(change.bindingId)
          .then(() => this.emitAuthStateChange(change));
      }),
      mainInstance.onDidChangeRole(({ role }) => {
        const previousRole = this.lastKnownRole;
        this.lastKnownRole = role;
        authLog.verbose(
          'main-instance',
          `AuthManager observed role change: ${previousRole} -> ${role}`,
        );
        if (role !== 'leader') {
          this.leaderAuthReady = false;
          authLog.verbose(
            'main-instance',
            'Cancelling scheduled auth refreshes after leader demotion',
          );
          this.cancelAllScheduledRefresh();
          return;
        }
        if (previousRole !== 'leader' && !this.leaderAuthReady) {
          authLog.verbose(
            'main-instance',
            'Deferring scheduled auth refreshes until leader migration completes',
          );
        }
      }),
    );
  }

  private isLeader(): boolean {
    return mainInstance.isLeader() && this.leaderAuthReady;
  }

  setLeaderAuthReady(ready: boolean): void {
    if (!mainInstance.isLeader()) {
      this.leaderAuthReady = false;
      return;
    }
    if (this.leaderAuthReady === ready) return;
    this.leaderAuthReady = ready;
    if (ready) {
      authLog.verbose(
        'main-instance',
        'Restoring scheduled auth refreshes after leader migration',
      );
      this.restoreScheduledRefreshesFromCachedProviders();
    } else {
      this.cancelAllScheduledRefresh();
    }
  }

  private emitAuthStateChange(change: LocalAuthStateChange): void {
    const envelope = this.secretStore.getLocalAuthEnvelope(change.bindingId);
    if (
      envelope?.revision !== change.revision ||
      !envelope.snapshots.some((snapshot) => snapshot.method === change.method)
    ) {
      return;
    }
    const previous = this.lastAuthStateRevisions.get(change.bindingId) ?? -1;
    if (change.revision === previous) return;
    this.lastAuthStateRevisions.set(change.bindingId, change.revision);
    const cacheKeyValue = `binding:${change.bindingId}:${change.method}`;
    const localPersistRevision = localPersistRevisionKey({
      cacheKeyValue,
      revision: change.revision,
    });
    if (
      change.reason !== 'refresh' &&
      change.reason !== 'migration' &&
      !this.localPersistRevisions.has(localPersistRevision)
    ) {
      this.disposeProviderByCacheKey(cacheKeyValue);
    }
    this._onDidChangeAuthState.fire(change);
  }

  private cancelAllScheduledRefresh(): void {
    for (const timer of this.refreshTimers.values()) {
      clearTimeout(timer);
    }
    this.refreshTimers.clear();
    this.refreshInFlight.clear();
  }

  private restoreScheduledRefreshesFromCachedProviders(): void {
    if (!this.isLeader()) {
      return;
    }

    const providerNames = new Set<string>();
    for (const owner of this.cacheOwners.values()) {
      providerNames.add(owner.providerName);
    }

    for (const providerName of providerNames) {
      const auth = this.resolveCurrentAuth(providerName);
      if (!auth || auth.method === 'none') {
        this.clearProvider(providerName);
        continue;
      }

      const provider = this.getProviderWithAuth(providerName, auth);
      if (!provider) {
        continue;
      }

      this.scheduleRefreshFromProvider(
        authCacheKey(providerName, auth),
        providerName,
        provider,
      );
    }
  }

  private resolveCurrentAuth(
    providerName: string,
  ): AuthRuntimeConfig | undefined {
    const provider = this.configStore.getProvider(providerName);
    if (!provider) return undefined;
    const normalized = normalizeAuthForProvider(provider.auth, {
      providerType: provider.type,
      baseUrl: provider.baseUrl,
    });
    return normalized && isSessionAuthConfig(normalized)
      ? this.secretStore.hydrateSessionAuth(
          {
            providerName: provider.name,
            providerType: provider.type,
            baseUrl: provider.baseUrl,
            useRawBaseUrl: provider.useRawBaseUrl,
          },
          normalized,
        )
      : normalized;
  }

  private clearProviderErrors(providerName: string): void {
    for (const key of Array.from(this.lastErrors.keys())) {
      if (this.cacheOwners.get(key)?.providerName === providerName) {
        this.lastErrors.delete(key);
      }
    }
  }

  private isPersistContextCurrent(options: {
    cacheKeyValue: string;
    expectedGeneration: number;
  }): boolean {
    return (
      !this.disposed &&
      this.getRefreshGeneration(options.cacheKeyValue) ===
        options.expectedGeneration
    );
  }

  async syncPersistedAuthConfig(
    providerName: string,
    auth: AuthRuntimeConfig,
    options: {
      reloadLocalState?: boolean;
      guard?: LocalAuthCommitGuard;
      sourceGuard?: ProviderSourceGuard;
    } = {},
  ): Promise<AuthConfig> {
    if (this.disposed) {
      throw new MainInstanceError('CANCELLED', 'Authentication manager disposed');
    }
    return await mainInstance.runLeaderMutation(async () =>
      this.syncPersistedAuthConfigWithinLeaderMutation(
        providerName,
        auth,
        options,
      ),
    );
  }

  private async syncPersistedAuthConfigWithinLeaderMutation(
    providerName: string,
    auth: AuthRuntimeConfig,
    options: {
      reloadLocalState?: boolean;
      guard?: LocalAuthCommitGuard;
      sourceGuard?: ProviderSourceGuard;
    },
  ): Promise<AuthConfig> {
    if (isSessionAuthConfig(auth)) {
      this.assertProviderSourceCurrent(options.sourceGuard);
    }
    let provider = this.configStore.getProvider(providerName);
    if (!provider) {
      return isSessionAuthConfig(auth) ? stripSessionAuthState(auth) : auth;
    }

    let persistedAuth: AuthConfig = isSessionAuthConfig(auth)
      ? stripSessionAuthState(auth)
      : auth;
    if (isSessionAuthConfig(auth)) {
      assertValidInlineSessionAuthToken(auth);
      if (options.reloadLocalState) {
        await this.secretStore.reloadLocalAuthState(auth.bindingId);
      }
      const descriptor = {
        providerName: provider.name,
        providerType: provider.type,
        baseUrl: provider.baseUrl,
        useRawBaseUrl: provider.useRawBaseUrl,
      };
      const transaction = await this.secretStore.prepareSessionAuthTransaction(
        descriptor,
        auth,
        {
          reason: auth.token ? 'context' : 'logout',
          emptyToken: 'clear',
          binding: 'existing-or-random',
          guard: options.guard,
          assertSourceCurrent: () =>
            this.assertProviderSourceCurrent(options.sourceGuard),
        },
      );
      persistedAuth = transaction.auth;

      try {
        this.assertProviderSourceCurrent(options.sourceGuard);
        provider = this.configStore.getProvider(providerName);
        if (!provider) throw new LocalAuthStateConflictError();
        const changed =
          stableStringify(provider.auth) !== stableStringify(persistedAuth);
        if (changed) {
          const updated = await this.configStore.upsertProviderIfUnchanged(
            { ...provider, auth: persistedAuth },
            {},
            () => this.hasCurrentProviderSource(options.sourceGuard),
          );
          if (!updated) throw new LocalAuthStateConflictError();
        }
        transaction.commit();
      } catch (error) {
        await transaction.rollback();
        throw error;
      }
    } else if (
      stableStringify(provider.auth) !== stableStringify(persistedAuth)
    ) {
      await this.configStore.upsertProvider({ ...provider, auth: persistedAuth });
    }

    this.clearProviderErrors(providerName);
    return persistedAuth;
  }

  private assertProviderSourceCurrent(
    guard: ProviderSourceGuard | undefined,
  ): void {
    if (!this.hasCurrentProviderSource(guard)) {
      throw new LocalAuthStateConflictError();
    }
  }

  private hasCurrentProviderSource(
    guard: ProviderSourceGuard | undefined,
  ): boolean {
    return (
      guard !== undefined &&
      isProviderSourceGuardCurrent(guard, (providerName) =>
        this.configStore.getProvider(providerName),
      )
    );
  }

  async prepareProviderForPersistence(
    provider: ProviderConfig,
    guard?: LocalAuthCommitGuard,
    sourceGuard?: ProviderSourceGuard,
  ): Promise<PreparedProviderPersistence> {
    const auth = provider.auth;
    if (!auth || !isSessionAuthConfig(auth)) {
      return {
        provider,
        commit: () => undefined,
        rollback: async () => undefined,
      };
    }
    assertValidInlineSessionAuthToken(auth);
    this.assertProviderSourceCurrent(sourceGuard);
    const descriptor = {
      providerName: provider.name,
      providerType: provider.type,
      baseUrl: provider.baseUrl,
      useRawBaseUrl: provider.useRawBaseUrl,
    };
    const transaction = await this.secretStore.prepareSessionAuthTransaction(
      descriptor,
      auth,
      {
        reason: 'import',
        emptyToken: 'preserve',
        binding: 'existing-or-random',
        guard,
        assertSourceCurrent: () =>
          this.assertProviderSourceCurrent(sourceGuard),
      },
    );
    try {
      this.assertProviderSourceCurrent(sourceGuard);
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
    return {
      provider: { ...provider, auth: transaction.auth },
      commit: transaction.commit,
      rollback: transaction.rollback,
    };
  }

  private async persistAuthConfig(
    providerName: string,
    auth: AuthRuntimeConfig,
    guard?: LocalAuthCommitGuard,
    sourceGuard?: ProviderSourceGuard,
  ): Promise<void> {
    if (this.isLeader()) {
      await this.syncPersistedAuthConfig(providerName, auth, {
        guard,
        sourceGuard,
      });
      return;
    }

    const configured = this.configStore.getProvider(providerName);
    const descriptor = configured
      ? {
          providerName: configured.name,
          providerType: configured.type,
          baseUrl: configured.baseUrl,
          useRawBaseUrl: configured.useRawBaseUrl,
        }
      : undefined;
    const intent =
      descriptor && isSessionAuthConfig(auth)
        ? await this.secretStore.prepareSessionAuthCommitIntent(descriptor, auth)
        : auth;

    try {
      await mainInstance.runInLeaderWhenAvailable(
        'auth.syncPersistedAuthConfig',
        {
          providerName,
          authConfig: intent,
          ...(guard ? { guard } : {}),
          ...(sourceGuard ? { sourceGuard } : {}),
        },
      );
      if (descriptor && isSessionAuthConfig(auth)) {
        await this.secretStore.reloadLocalAuthState(auth.bindingId);
        this.secretStore.clearPendingSessionAuth(descriptor, auth);
      }
    } catch (error) {
      if (
        error instanceof MainInstanceError &&
        (error.code === 'NO_LEADER' ||
          error.code === 'LEADER_GONE' ||
          error.code === 'INCOMPATIBLE_VERSION')
      ) {
        if (this.isLeader()) {
          await this.syncPersistedAuthConfig(providerName, intent, {
            guard,
            sourceGuard,
          });
          if (descriptor && isSessionAuthConfig(auth)) {
            await this.secretStore.reloadLocalAuthState(auth.bindingId);
            this.secretStore.clearPendingSessionAuth(descriptor, auth);
          }
          return;
        }
        authLog.warn(
          `${providerName}:${auth.method}`,
          `Leader unavailable while committing auth state (${error.code})`,
        );
      }
      throw error;
    }
  }

  private createPersistBoundContext(options: {
    providerName: string;
    providerType: string;
    baseUrl: string;
    useRawBaseUrl?: boolean;
    cacheKeyValue: string;
    expectedGeneration: number;
    auth: AuthRuntimeConfig;
  }): AuthProviderContext {
    let currentAuth = options.auth;
    const descriptor = {
      providerName: options.providerName,
      providerType: options.providerType,
      baseUrl: options.baseUrl,
      useRawBaseUrl: options.useRawBaseUrl,
    };
    let sourceGuard = captureProviderSourceGuard([
      {
        providerName: options.providerName,
        provider: this.configStore.getProvider(options.providerName),
      },
    ]);
    const captureAuthCommitGuard = (): LocalAuthCommitGuard | undefined =>
      isSessionAuthConfig(currentAuth)
        ? this.secretStore.getLocalAuthCommitGuard(descriptor, currentAuth)
        : undefined;
    return {
      providerId: options.providerName,
      providerLabel: options.providerName,
      providerType: options.providerType,
      baseUrl: options.baseUrl,
      useRawBaseUrl: options.useRawBaseUrl,
      secretStore: this.secretStore,
      uriHandler: this.uriHandler,
      captureAuthCommitGuard,
      persistAuthConfig: async (auth, operationGuard) => {
        if (!this.isPersistContextCurrent(options)) {
          throw new LocalAuthStateConflictError();
        }
        const capturedGuard = operationGuard ?? captureAuthCommitGuard();
        const guard = capturedGuard ? { ...capturedGuard } : undefined;
        const localRevision = guard
          ? localPersistRevisionKey({
              cacheKeyValue: options.cacheKeyValue,
              revision: guard.revision + 1,
            })
          : undefined;
        if (localRevision) {
          this.localPersistRevisions.set(
            localRevision,
            (this.localPersistRevisions.get(localRevision) ?? 0) + 1,
          );
        }
        try {
          await this.persistAuthConfig(
            options.providerName,
            auth,
            guard,
            sourceGuard,
          );
        } catch (error) {
          if (isSessionAuthConfig(auth)) {
            this.secretStore.discardPendingSessionAuth(
              {
                providerName: options.providerName,
                providerType: options.providerType,
                baseUrl: options.baseUrl,
                useRawBaseUrl: options.useRawBaseUrl,
              },
              auth,
            );
          }
          throw error;
        } finally {
          if (localRevision) {
            const remaining =
              (this.localPersistRevisions.get(localRevision) ?? 1) - 1;
            if (remaining === 0) this.localPersistRevisions.delete(localRevision);
            else this.localPersistRevisions.set(localRevision, remaining);
          }
        }
        currentAuth = auth;
        const configured = this.configStore.getProvider(options.providerName);
        sourceGuard = captureProviderSourceGuard([
          {
            providerName: options.providerName,
            provider: configured
              ? {
                  ...configured,
                  auth: isSessionAuthConfig(auth)
                    ? stripSessionAuthState(auth)
                    : auth,
                }
              : undefined,
          },
        ]);
      },
    };
  }

  private clearOtherAuthBindings(
    providerName: string,
    keepCacheKey: string,
  ): void {
    for (const key of Array.from(this.providers.keys())) {
      const owner = this.cacheOwners.get(key);
      if (owner?.providerName !== providerName) {
        continue;
      }
      if (key === keepCacheKey) {
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
    this.cacheOwners.delete(cacheKeyValue);

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
    auth: AuthRuntimeConfig,
  ): AuthProvider | undefined {
    if (auth.method === 'none') {
      authLog.verbose(
        `${providerName}:none`,
        'Skipping provider with no auth method',
      );
      return undefined;
    }

    const cacheKeyValue = authCacheKey(providerName, auth);
    this.clearOtherAuthBindings(providerName, cacheKeyValue);
    const configuredProvider = this.configStore.getProvider(providerName);
    const signature = authProviderConfigSignature(configuredProvider, auth);

    const existing = this.providers.get(cacheKeyValue);
    const existingOwner = this.cacheOwners.get(cacheKeyValue);
    const existingSignature = this.providerConfigSignatures.get(cacheKeyValue);
    if (
      existing &&
      (existingSignature !== signature ||
        existingOwner?.providerName !== providerName)
    ) {
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
      const expectedGeneration = this.getRefreshGeneration(cacheKeyValue);
      this.cacheOwners.set(cacheKeyValue, {
        providerName,
        method: auth.method,
      });
      const context = this.createPersistBoundContext({
        providerName,
        providerType: configuredProvider?.type ?? 'unknown',
        baseUrl: configuredProvider?.baseUrl ?? '',
        useRawBaseUrl: configuredProvider?.useRawBaseUrl,
        cacheKeyValue,
        expectedGeneration,
        auth,
      });
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
            const errorInfo: AuthErrorInfo = {
              error:
                change.error ??
                new Error('Authentication was revoked; re-authorization required'),
              errorType: change.errorType ?? 'auth_error',
            };
            this.lastErrors.set(cacheKeyValue, errorInfo);
            authLog.warn(
              `${providerName}:${auth.method}`,
              `Auth revoked: ${errorInfo.error.message}`,
            );
            this.cancelRefreshByCacheKey(cacheKeyValue);
          }
        });
        this.providerStatusSubscriptions.set(cacheKeyValue, subscription);
      } else {
        this.cacheOwners.delete(cacheKeyValue);
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
    reason: 'user' | 'background' = 'user',
    authChangeRetry = 0,
  ): Promise<AuthCredential | undefined> {
    const auth = this.resolveCurrentAuth(providerName);
    if (!auth || auth.method === 'none') {
      authLog.verbose(
        `${providerName}:none`,
        'No auth configured, returning undefined',
      );
      return undefined;
    }
    const requestSignature = authRequestSignature(
      this.configStore.getProvider(providerName),
      auth,
    );

    if (!this.isLeader()) {
      const credential = await this.getCredentialFromLeader(
        providerName,
        auth,
        reason,
      );
      if (
        !this.isCredentialRequestCurrent(
          providerName,
          auth,
          requestSignature,
          credential,
        )
      ) {
        return authChangeRetry < 2
          ? await this.getCredential(
              providerName,
              reason,
              authChangeRetry + 1,
            )
          : undefined;
      }
      return credential;
    }

    const provider = this.getProviderWithAuth(providerName, auth);
    if (!provider) {
      authLog.verbose(
        `${providerName}:${auth.method}`,
        'getCredential result: unavailable (provider missing)',
      );
      return undefined;
    }

    const cacheKeyValue = authCacheKey(providerName, auth);

    const inFlight = this.credentialInFlight.get(cacheKeyValue);
    if (inFlight) {
      const credential = await inFlight;
      if (
        this.providers.get(cacheKeyValue) !== provider ||
        !this.isCredentialRequestCurrent(
          providerName,
          auth,
          requestSignature,
          credential,
        )
      ) {
        return authChangeRetry < 2
          ? await this.getCredential(
              providerName,
              reason,
              authChangeRetry + 1,
            )
          : undefined;
      }
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
    if (
      this.providers.get(cacheKeyValue) !== provider ||
      !this.isCredentialRequestCurrent(
        providerName,
        auth,
        requestSignature,
        credential,
      )
    ) {
      return authChangeRetry < 2
        ? await this.getCredential(
            providerName,
            reason,
            authChangeRetry + 1,
          )
        : undefined;
    }
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

  private isCredentialRequestCurrent(
    providerName: string,
    requestedAuth: AuthRuntimeConfig,
    requestSignature: string,
    credential: AuthCredential | undefined,
  ): boolean {
    const configured = this.configStore.getProvider(providerName);
    const currentAuth = this.resolveCurrentAuth(providerName);
    if (
      !configured ||
      !currentAuth ||
      authRequestSignature(
        configured,
        currentAuth,
      ) !== requestSignature
    ) {
      return false;
    }
    if (!isSessionAuthConfig(requestedAuth)) return true;
    if (!isSessionAuthConfig(currentAuth)) return false;
    const expectedContext = this.secretStore.getLocalAuthContext(
      {
        providerName: configured.name,
        providerType: configured.type,
        baseUrl: configured.baseUrl,
        useRawBaseUrl: configured.useRawBaseUrl,
      },
      currentAuth,
    );
    if (!credential) return expectedContext === undefined;
    return (
      expectedContext !== undefined &&
      credential.authContext !== undefined &&
      stableStringify(credential.authContext) === stableStringify(expectedContext)
    );
  }

  private async getCredentialFromLeader(
    providerName: string,
    auth: AuthRuntimeConfig,
    reason: 'user' | 'background',
  ): Promise<AuthCredential | undefined> {
    const cacheKeyValue = authCacheKey(providerName, auth);

    const inFlight = this.credentialInFlight.get(cacheKeyValue);
    if (inFlight) {
      return await inFlight;
    }

    const promise = (async (): Promise<AuthCredential | undefined> => {
      try {
        const response = await mainInstance.runInLeaderWhenAvailable<unknown>(
          'auth.getCredential',
          { providerName, reason },
        );

        const parsed = this.parseAuthCredentialRpcResponse(
          response,
          'auth.getCredential',
        );

        if (parsed.lastError) {
          this.lastErrors.set(cacheKeyValue, {
            error: new Error(parsed.lastError.message),
            errorType: parsed.lastError.errorType,
          });
        } else {
          this.lastErrors.delete(cacheKeyValue);
        }

        return parsed.credential;
      } catch (error) {
        if (
          error instanceof MainInstanceError &&
          (error.code === 'NO_LEADER' || error.code === 'LEADER_GONE') &&
          this.isLeader()
        ) {
          return await this.getCredentialDirectAsLeader(providerName);
        }
        throw error;
      }
    })().finally(() => {
      this.credentialInFlight.delete(cacheKeyValue);
    });

    this.credentialInFlight.set(cacheKeyValue, promise);
    return await promise;
  }

  private async getCredentialDirectAsLeader(
    providerName: string,
  ): Promise<AuthCredential | undefined> {
    const auth = this.resolveCurrentAuth(providerName);
    if (!auth || auth.method === 'none') {
      return undefined;
    }

    const provider = this.getProviderWithAuth(providerName, auth);
    if (!provider) {
      return undefined;
    }

    const cacheKeyValue = authCacheKey(providerName, auth);
    return await this.doGetCredential(cacheKeyValue, providerName, provider);
  }

  private parseAuthCredentialRpcResponse(
    value: unknown,
    method: string,
  ): {
    credential: AuthCredential | undefined;
    lastError:
      | { message: string; errorType: AuthErrorType }
      | undefined;
  } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new MainInstanceError(
        'BAD_REQUEST',
        `${method}: invalid response`,
      );
    }

    const record = value as Record<string, unknown>;
    const credentialValue = record['credential'];
    const lastErrorValue = record['lastError'];

    const credential = (() => {
      if (!credentialValue) {
        return undefined;
      }
      if (
        typeof credentialValue !== 'object' ||
        Array.isArray(credentialValue)
      ) {
        return undefined;
      }
      const c = credentialValue as Record<string, unknown>;
      const v = c['value'];
      if (typeof v !== 'string' || v.trim() === '') {
        return undefined;
      }
      const tokenType = c['tokenType'];
      const expiresAt = c['expiresAt'];
      const authContextValue = c['authContext'];
      const parsedAuthContext =
        authContextValue === undefined
          ? undefined
          : parseAuthContext(authContextValue);
      if (
        (tokenType !== undefined && typeof tokenType !== 'string') ||
        (expiresAt !== undefined &&
          (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt))) ||
        (authContextValue !== undefined && !parsedAuthContext)
      ) {
        throw new MainInstanceError(
          'BAD_REQUEST',
          `${method}: invalid credential`,
        );
      }
      const authContext = parsedAuthContext ?? undefined;
      return {
        value: v,
        tokenType,
        expiresAt,
        authContext,
      } satisfies AuthCredential;
    })();

    const lastError = (() => {
      if (!lastErrorValue) {
        return undefined;
      }
      if (typeof lastErrorValue !== 'object' || Array.isArray(lastErrorValue)) {
        return undefined;
      }
      const e = lastErrorValue as Record<string, unknown>;
      const message = e['message'];
      const errorType = e['errorType'];
      if (typeof message !== 'string' || message.trim() === '') {
        return undefined;
      }
      const parsedErrorType = parseAuthErrorType(errorType);
      if (!parsedErrorType) {
        return undefined;
      }
      return { message, errorType: parsedErrorType };
    })();

    return { credential, lastError };
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
    if (this.providers.get(cacheKeyValue) !== provider) {
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
      this.cancelRefreshByCacheKey(cacheKeyValue);
    }

    const configured = this.configStore.getProvider(providerName);
    const auth = configured?.auth;
    if (!configured || !auth || !isSessionAuthConfig(auth)) {
      return credential;
    }
    const authContext = this.secretStore.getLocalAuthContext(
      {
        providerName: configured.name,
        providerType: configured.type,
        baseUrl: configured.baseUrl,
        useRawBaseUrl: configured.useRawBaseUrl,
      },
      auth,
    );
    if (!authContext) return undefined;
    if (
      credential.authContext &&
      stableStringify(credential.authContext) !== stableStringify(authContext)
    ) {
      return undefined;
    }
    return { ...credential, authContext };
  }

  private scheduleRefreshFromProvider(
    cacheKeyValue: string,
    providerName: string,
    provider: AuthProvider,
  ): void {
    if (!this.isLeader()) {
      this.cancelRefreshByCacheKey(cacheKeyValue);
      return;
    }
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
    if (!this.isLeader()) {
      this.cancelRefreshByCacheKey(cacheKeyValue);
      return;
    }
    if (this.providers.get(cacheKeyValue) !== provider) {
      return;
    }

    const expected =
      expectedGeneration ?? this.getRefreshGeneration(cacheKeyValue);
    if (this.getRefreshGeneration(cacheKeyValue) !== expected) {
      return;
    }

    const method = this.cacheOwners.get(cacheKeyValue)?.method ?? 'unknown';

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
      if (this.cacheOwners.get(key)?.providerName === providerName) {
        keys.add(key);
      }
    }

    for (const key of this.refreshTimers.keys()) {
      if (this.cacheOwners.get(key)?.providerName === providerName) {
        keys.add(key);
      }
    }

    for (const key of this.refreshInFlight) {
      if (this.cacheOwners.get(key)?.providerName === providerName) {
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
    if (!this.isLeader()) {
      return;
    }
    const method = this.cacheOwners.get(cacheKeyValue)?.method ?? 'unknown';

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
    return this.lastErrors.get(authCacheKey(providerName, auth));
  }

  /**
   * Clear last error for a provider
   */
  clearLastError(providerName: string): void {
    const auth = this.resolveCurrentAuth(providerName);
    if (!auth || auth.method === 'none') {
      return;
    }
    this.lastErrors.delete(authCacheKey(providerName, auth));
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

    if (!this.isLeader()) {
      try {
        return await this.retryRefreshInLeader(providerName, auth);
      } catch (error) {
        if (
          error instanceof MainInstanceError &&
          (error.code === 'NO_LEADER' || error.code === 'LEADER_GONE') &&
          this.isLeader()
        ) {
          return await this.retryRefresh(providerName);
        }
        throw error;
      }
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

    const cacheKeyValue = authCacheKey(providerName, auth);
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

  private async retryRefreshInLeader(
    providerName: string,
    auth: AuthRuntimeConfig,
  ): Promise<boolean> {
    const cacheKeyValue = authCacheKey(providerName, auth);
    const response = await mainInstance.runInLeaderWhenAvailable<unknown>(
      'auth.retryRefresh',
      { providerName },
    );

    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      throw new MainInstanceError(
        'BAD_REQUEST',
        'auth.retryRefresh: invalid response',
      );
    }

    const record = response as Record<string, unknown>;
    const ok = record['ok'];
    const lastErrorValue = record['lastError'];

    if (typeof ok !== 'boolean') {
      throw new MainInstanceError(
        'BAD_REQUEST',
        'auth.retryRefresh: invalid response',
      );
    }

    if (!lastErrorValue) {
      this.lastErrors.delete(cacheKeyValue);
      return ok;
    }

    if (typeof lastErrorValue !== 'object' || Array.isArray(lastErrorValue)) {
      return ok;
    }

    const e = lastErrorValue as Record<string, unknown>;
    const message = e['message'];
    const errorType = e['errorType'];
    const parsedErrorType = parseAuthErrorType(errorType);
    if (typeof message !== 'string' || !parsedErrorType) {
      return ok;
    }

    this.lastErrors.set(cacheKeyValue, {
      error: new Error(message),
      errorType: parsedErrorType,
    });
    return ok;
  }

  /**
   * Clear cached provider instance
   */
  clearProvider(providerName: string): void {
    for (const key of Array.from(this.providers.keys())) {
      if (this.cacheOwners.get(key)?.providerName !== providerName) {
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
    this.cacheOwners.clear();
    this.lastErrors.clear();
    this.refreshGeneration.clear();
    this.localPersistRevisions.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearAll();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}

function localPersistRevisionKey(value: LocalPersistRevision): string {
  return `${value.cacheKeyValue}:${value.revision}`;
}

function parseAuthErrorType(value: unknown): AuthErrorType | undefined {
  switch (value) {
    case 'auth_error':
    case 'transient_error':
    case 'unknown_error':
      return value;
    default:
      return undefined;
  }
}

function authCacheKey(providerName: string, auth: AuthRuntimeConfig): string {
  return isSessionAuthConfig(auth)
    ? `binding:${auth.bindingId}:${auth.method}`
    : `provider:${auth.method}:${providerName}`;
}

function authRequestSignature(
  provider: ProviderConfig | undefined,
  auth: AuthRuntimeConfig,
): string {
  if (!isSessionAuthConfig(auth)) return stableStringify(auth);
  if (!provider) return 'missing-provider';
  return stableStringify({
    method: auth.method,
    bindingId: auth.bindingId,
    staticConfigFingerprint: computeStaticAuthFingerprint(
      {
        providerType: provider.type,
        baseUrl: provider.baseUrl,
        useRawBaseUrl: provider.useRawBaseUrl,
      },
      auth,
    ),
  });
}

function authProviderConfigSignature(
  provider: ProviderConfig | undefined,
  auth: AuthRuntimeConfig,
): string {
  return isSessionAuthConfig(auth)
    ? stableStringify({
        request: authRequestSignature(provider, auth),
        runtime: auth,
      })
    : stableStringify(auth);
}

function parseLocalAuthStateChange(value: unknown): LocalAuthStateChange | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const providerName = record['providerName'];
  const bindingId = record['bindingId'];
  const method = record['method'];
  const revision = record['revision'];
  const reason = record['reason'];
  const validReason: LocalAuthStateChangeReason | undefined = (() => {
    switch (reason) {
      case 'login':
      case 'refresh':
      case 'context':
      case 'logout':
      case 'import':
      case 'migration':
        return reason;
      default:
        return undefined;
    }
  })();
  if (
    typeof providerName !== 'string' ||
    providerName.trim() === '' ||
    !isValidAuthBindingId(bindingId) ||
    !isSessionAuthMethod(method) ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !validReason
  ) {
    return null;
  }
  return { providerName, bindingId, method, revision, reason: validReason };
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
