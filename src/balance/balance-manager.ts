import * as vscode from 'vscode';
import type { AuthCredential, AuthTokenInfo } from '../auth/types';
import type { AuthManager } from '../auth';
import type { ConfigStore } from '../config-store';
import type { SecretStore } from '../secret';
import type { ProviderConfig } from '../types';
import { stableStringify } from '../config-ops';
import { createBalanceProvider } from './create-balance-provider';
import type { BalanceProviderContext } from './balance-provider';
import type {
  BalanceConfig,
  BalanceMetric,
  BalanceSnapshot,
  BalanceProviderState,
} from './types';
import { mainInstance } from '../main-instance';
import { showMainInstanceCompatibilityWarning } from '../main-instance/compatibility';
import {
  isLeaderUnavailableError,
  MainInstanceError,
} from '../main-instance/errors';
import { t } from '../i18n';

const DEFAULT_PERIODIC_REFRESH_MS = 60_000;
const DEFAULT_THROTTLE_WINDOW_MS = 10_000;
const STATE_KEY = 'balanceState';
const STATE_VERSION = 3;
const MANUAL_REFRESH_UNAVAILABLE_MESSAGE =
  'Balance refresh is temporarily unavailable while the main instance is switching. Please try again.';

type PersistedProviderState = {
  snapshot?: BalanceSnapshot;
  lastError?: string;
  lastAttemptAt?: number;
  lastRefreshAt?: number;
};

type PersistedState = {
  version: number;
  providers: Record<string, PersistedProviderState>;
  lastUsedAt: Record<string, number>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

type RefreshReason =
  | 'periodic'
  | 'post-request-immediate'
  | 'post-request-trailing'
  | 'manual'
  | 'ui';

export class BalanceManager implements vscode.Disposable {
  private configStore?: ConfigStore;
  private secretStore?: SecretStore;
  private authManager?: AuthManager;
  private extensionContext?: vscode.ExtensionContext;

  private readonly states = new Map<string, BalanceProviderState>();
  private readonly lastUsedAt = new Map<string, number>();
  private readonly configSignatures = new Map<string, string>();
  private readonly refreshInFlight = new Map<string, Promise<void>>();
  private readonly trailingTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly postRequestRefreshRetryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private periodicTimer?: ReturnType<typeof setInterval>;
  private syncRetryTimer?: ReturnType<typeof setTimeout>;
  private persistChain: Promise<void> = Promise.resolve();

  private readonly disposables: vscode.Disposable[] = [];
  private readonly onDidUpdateEmitter = new vscode.EventEmitter<string>();

  readonly onDidUpdate = this.onDidUpdateEmitter.event;

  private isLeader(): boolean {
    return mainInstance.isLeader();
  }

  private notifyUpdated(providerName: string): void {
    this.onDidUpdateEmitter.fire(providerName);
    this.queuePersistState();
    this.broadcastUpdate(providerName);
  }

  private broadcastUpdate(providerName: string): void {
    if (!this.isLeader()) {
      return;
    }

    const state = this.states.get(providerName);
    const lastUsedAt = this.lastUsedAt.get(providerName);
    mainInstance.broadcast('balance.updated', {
      providerName,
      state: state ?? null,
      lastUsedAt: lastUsedAt ?? null,
    });
  }

  private applyLeaderUpdate(payload: unknown): void {
    if (this.isLeader()) {
      return;
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return;
    }
    const record = payload as Record<string, unknown>;
    const providerName = record['providerName'];
    if (typeof providerName !== 'string' || providerName.trim() === '') {
      return;
    }

    const stateValue = record['state'];
    if (stateValue === null) {
      this.states.delete(providerName);
    } else if (stateValue && typeof stateValue === 'object' && !Array.isArray(stateValue)) {
      this.states.set(providerName, stateValue as BalanceProviderState);
    }

    const lastUsedAtValue = record['lastUsedAt'];
    if (typeof lastUsedAtValue === 'number' && Number.isFinite(lastUsedAtValue) && lastUsedAtValue >= 0) {
      this.lastUsedAt.set(providerName, lastUsedAtValue);
    } else if (lastUsedAtValue === null) {
      this.lastUsedAt.delete(providerName);
    }

    this.onDidUpdateEmitter.fire(providerName);
  }

  getSnapshotForFollowers(): {
    providers: Record<string, BalanceProviderState>;
    lastUsedAt: Record<string, number>;
  } {
    const providers: Record<string, BalanceProviderState> = {};
    for (const [providerName, state] of this.states) {
      providers[providerName] = { ...state };
    }

    const lastUsedAt: Record<string, number> = {};
    for (const [providerName, timestamp] of this.lastUsedAt) {
      if (
        typeof timestamp === 'number' &&
        Number.isFinite(timestamp) &&
        timestamp >= 0
      ) {
        lastUsedAt[providerName] = timestamp;
      }
    }

    return { providers, lastUsedAt };
  }

  private applySnapshotFromLeader(snapshot: unknown): void {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      return;
    }
    const record = snapshot as Record<string, unknown>;
    const providersValue = record['providers'];
    const lastUsedAtValue = record['lastUsedAt'];

    if (!providersValue || typeof providersValue !== 'object' || Array.isArray(providersValue)) {
      return;
    }
    if (!lastUsedAtValue || typeof lastUsedAtValue !== 'object' || Array.isArray(lastUsedAtValue)) {
      return;
    }

    const providersRecord = providersValue as Record<string, unknown>;
    const lastUsedAtRecord = lastUsedAtValue as Record<string, unknown>;
    const updatedProviderNames = new Set<string>();

    for (const providerName of this.states.keys()) {
      updatedProviderNames.add(providerName);
    }
    for (const providerName of this.lastUsedAt.keys()) {
      updatedProviderNames.add(providerName);
    }

    this.states.clear();
    this.lastUsedAt.clear();

    for (const [providerName, rawState] of Object.entries(providersRecord)) {
      if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState)) {
        continue;
      }
      const state = rawState as BalanceProviderState;
      this.states.set(providerName, { ...state });
      updatedProviderNames.add(providerName);
    }

    for (const [providerName, rawTimestamp] of Object.entries(lastUsedAtRecord)) {
      if (typeof rawTimestamp !== 'number' || !Number.isFinite(rawTimestamp) || rawTimestamp < 0) {
        continue;
      }
      this.lastUsedAt.set(providerName, rawTimestamp);
      updatedProviderNames.add(providerName);
    }

    for (const providerName of updatedProviderNames) {
      this.onDidUpdateEmitter.fire(providerName);
    }
  }

  private async syncFromLeader(): Promise<void> {
    if (this.isLeader()) {
      return;
    }

    try {
      const snapshot = await mainInstance.runInLeaderWhenAvailable<unknown>(
        'balance.getSnapshot',
        {},
      );
      this.applySnapshotFromLeader(snapshot);
    } catch (error) {
      if (
        (error instanceof MainInstanceError &&
          error.code === 'NOT_IMPLEMENTED') ||
        isLeaderUnavailableError(error)
      ) {
        this.scheduleSyncRetry();
      }
    }
  }

  private scheduleSyncRetry(): void {
    if (this.isLeader() || this.syncRetryTimer) {
      return;
    }
    this.syncRetryTimer = setTimeout(() => {
      this.syncRetryTimer = undefined;
      void this.syncFromLeader();
    }, 250);
  }

  private clearPostRequestRefreshRetry(providerName: string): void {
    const timer = this.postRequestRefreshRetryTimers.get(providerName);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.postRequestRefreshRetryTimers.delete(providerName);
  }

  private schedulePostRequestRefreshRetry(
    providerName: string,
    outcome: 'success' | 'error',
  ): void {
    this.clearPostRequestRefreshRetry(providerName);
    const timer = setTimeout(() => {
      this.postRequestRefreshRetryTimers.delete(providerName);
      this.notifyChatRequestFinished(providerName, outcome);
    }, 250);
    this.postRequestRefreshRetryTimers.set(providerName, timer);
  }

  private cancelAllTrailingTimers(): void {
    for (const timer of this.trailingTimers.values()) {
      clearTimeout(timer);
    }
    this.trailingTimers.clear();
  }

  private restorePendingTrailingRefreshes(): void {
    if (!this.isLeader()) {
      this.cancelAllTrailingTimers();
      return;
    }

    this.cancelAllTrailingTimers();
    for (const [providerName, state] of this.states) {
      if (!state.pendingTrailing) {
        continue;
      }
      const dueAt =
        (state.lastRequestEndAt ?? Date.now()) + this.getThrottleWindowMs();
      if (dueAt <= Date.now()) {
        void this.flushTrailingRefresh(providerName);
        continue;
      }
      this.scheduleTrailingTimer(providerName, dueAt);
    }
  }

  async initialize(options: {
    configStore: ConfigStore;
    secretStore: SecretStore;
    authManager?: AuthManager;
    extensionContext: vscode.ExtensionContext;
  }): Promise<void> {
    this.disposeRuntime();

    this.configStore = options.configStore;
    this.secretStore = options.secretStore;
    this.authManager = options.authManager;
    this.extensionContext = options.extensionContext;

    await this.loadState();

    this.disposables.push(
      options.configStore.onDidChange(() => {
        this.reconcileStates();
        this.startPeriodicRefresh();
      }),
    );

    this.disposables.push(
      mainInstance.onDidReceiveEvent(({ event, payload }) => {
        if (event === 'balance.updated') {
          this.applyLeaderUpdate(payload);
        }
      }),
    );

    this.disposables.push(
      mainInstance.onDidChangeRole(({ role }) => {
        this.startPeriodicRefresh();
        if (role === 'leader') {
          this.restorePendingTrailingRefreshes();
          return;
        }
        this.cancelAllTrailingTimers();
        void this.syncFromLeader();
      }),
    );

    this.reconcileStates();
    this.startPeriodicRefresh();
    this.restorePendingTrailingRefreshes();

    void this.syncFromLeader();
  }

  getProviderState(providerName: string): BalanceProviderState | undefined {
    return this.states.get(providerName);
  }

  getProviderLastUsedAt(providerName: string): number | undefined {
    return this.lastUsedAt.get(providerName);
  }

  notifyChatRequestStarted(providerName: string): void {
    if (!this.configStore?.getProvider(providerName)) {
      return;
    }

    this.lastUsedAt.set(providerName, Date.now());
    this.notifyUpdated(providerName);

    if (!this.isLeader()) {
      void mainInstance
        .runInLeaderWhenAvailable('balance.notifyChatRequestStarted', {
          providerName,
        })
        .catch(() => {
          // Best-effort.
        });
    }
  }

  notifyChatRequestFinished(
    providerName: string,
    outcome: 'success' | 'error' | 'cancelled',
  ): void {
    if (outcome === 'cancelled') {
      return;
    }

    if (!this.isLeader()) {
      void mainInstance
        .runInLeaderWhenAvailable('balance.notifyChatRequestFinished', {
          providerName,
          outcome,
        })
        .then(() => {
          this.clearPostRequestRefreshRetry(providerName);
        })
        .catch((error) => {
          if (!isLeaderUnavailableError(error)) {
            return;
          }
          if (this.isLeader()) {
            this.clearPostRequestRefreshRetry(providerName);
            this.scheduleRefresh(providerName, {
              reason: 'post-request-immediate',
              allowTrailing: true,
            });
            return;
          }
          this.schedulePostRequestRefreshRetry(providerName, outcome);
        });
      return;
    }

    this.clearPostRequestRefreshRetry(providerName);
    this.scheduleRefresh(providerName, {
      reason: 'post-request-immediate',
      allowTrailing: true,
    });
  }

  requestRefresh(providerName: string, reason: RefreshReason = 'manual'): void {
    if (reason === 'manual') {
      void this.forceRefresh(providerName).catch((error) => {
        void showMainInstanceCompatibilityWarning(error).then((handled) => {
          if (handled) {
            return;
          }
          if (isLeaderUnavailableError(error)) {
            vscode.window.showErrorMessage(
              t(MANUAL_REFRESH_UNAVAILABLE_MESSAGE),
            );
            return;
          }

          const message = error instanceof Error ? error.message : String(error);
          vscode.window.showErrorMessage(
            t('Failed to refresh balance for "{0}": {1}', providerName, message),
          );
        });
      });
      return;
    }

    if (!this.isLeader()) {
      void mainInstance
        .runInLeaderWhenAvailable('balance.requestRefresh', {
          providerName,
          reason,
        })
        .catch(() => {
          // Best-effort.
        });
      return;
    }

    this.scheduleRefresh(providerName, {
      reason,
      allowTrailing: false,
      force: false,
    });
  }

  async forceRefresh(providerName: string): Promise<void> {
    if (!this.isLeader()) {
      await mainInstance.runInLeaderWhenAvailable('balance.forceRefresh', {
        providerName,
      });
      return;
    }

    const provider = this.configStore?.getProvider(providerName);
    if (!provider || !this.hasConfiguredBalanceProvider(provider)) {
      return;
    }

    await this.refreshProvider(provider, 'manual', true);
  }

  async forceRefreshAll(providers?: ProviderConfig[]): Promise<number> {
    if (!this.isLeader()) {
      const result = await mainInstance.runInLeaderWhenAvailable<unknown>(
        'balance.forceRefreshAll',
        providers && providers.length > 0
          ? {
              providerNames: providers.map(
                (provider) => provider.name,
              ),
            }
          : {},
      );
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new Error('Invalid balance.forceRefreshAll response');
      }
      const record = result as Record<string, unknown>;
      const count = record['count'];
      return typeof count === 'number' && Number.isFinite(count) ? count : 0;
    }

    const currentProviders = providers ?? this.configStore?.endpoints ?? [];
    const targets = currentProviders.filter((provider) =>
      this.hasConfiguredBalanceProvider(provider),
    );

    await Promise.all(
      targets.map((provider) => this.refreshProvider(provider, 'manual', true)),
    );

    return targets.length;
  }

  private scheduleRefresh(
    providerName: string,
    options: { reason: RefreshReason; allowTrailing: boolean; force?: boolean },
  ): void {
    const provider = this.configStore?.getProvider(providerName);
    if (!provider || !this.hasConfiguredBalanceProvider(provider)) {
      this.clearProviderState(providerName);
      return;
    }

    if (options.force) {
      void this.refreshProvider(provider, options.reason, true);
      return;
    }

    const state = this.ensureState(providerName);
    const now = Date.now();
    const hasInFlight = this.refreshInFlight.has(providerName);
    const withinThrottleWindow = this.isWithinThrottleWindow(state, now);

    if (!withinThrottleWindow && !hasInFlight) {
      void this.refreshProvider(provider, options.reason, false);
      return;
    }

    if (!options.allowTrailing) {
      return;
    }

    state.pendingTrailing = true;
    state.lastRequestEndAt = now;
    this.scheduleTrailingTimer(providerName, now + this.getThrottleWindowMs());
    this.notifyUpdated(providerName);
  }

  private scheduleTrailingTimer(providerName: string, dueAt: number): void {
    const existingTimer = this.trailingTimers.get(providerName);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const delayMs = Math.max(0, dueAt - Date.now());
    const timer = setTimeout(() => {
      this.trailingTimers.delete(providerName);
      void this.flushTrailingRefresh(providerName);
    }, delayMs);

    this.trailingTimers.set(providerName, timer);
  }

  private async flushTrailingRefresh(providerName: string): Promise<void> {
    const state = this.states.get(providerName);
    if (!state?.pendingTrailing) {
      return;
    }

    if (this.refreshInFlight.has(providerName)) {
      return;
    }

    const provider = this.configStore?.getProvider(providerName);
    if (!provider || !this.hasConfiguredBalanceProvider(provider)) {
      state.pendingTrailing = false;
      state.lastRequestEndAt = undefined;
      this.notifyUpdated(providerName);
      return;
    }

    state.pendingTrailing = false;
    state.lastRequestEndAt = undefined;
    this.notifyUpdated(providerName);

    await this.refreshProvider(provider, 'post-request-trailing', true);
  }

  private async refreshProvider(
    provider: ProviderConfig,
    reason: RefreshReason,
    force: boolean,
  ): Promise<void> {
    if (!this.hasConfiguredBalanceProvider(provider)) {
      return;
    }

    const existing = this.refreshInFlight.get(provider.name);
    if (existing) {
      return existing;
    }

    const state = this.ensureState(provider.name);
    const now = Date.now();

    if (!force && this.isWithinThrottleWindow(state, now)) {
      return;
    }

    const refreshPromise = this.doRefresh(provider, reason).finally(() => {
      this.refreshInFlight.delete(provider.name);
      this.scheduleTrailingAfterRefresh(provider.name);
    });

    this.refreshInFlight.set(provider.name, refreshPromise);
    return refreshPromise;
  }

  private scheduleTrailingAfterRefresh(providerName: string): void {
    const state = this.states.get(providerName);
    if (!state?.pendingTrailing) {
      return;
    }

    const dueAt =
      (state.lastRequestEndAt ?? Date.now()) + this.getThrottleWindowMs();

    if (dueAt <= Date.now()) {
      void this.flushTrailingRefresh(providerName);
      return;
    }

    this.scheduleTrailingTimer(providerName, dueAt);
  }

  private async doRefresh(
    provider: ProviderConfig,
    _reason: RefreshReason,
  ): Promise<void> {
    const balanceProvider = this.createProvider(provider);
    const state = this.ensureState(provider.name);

    state.isRefreshing = true;
    state.lastAttemptAt = Date.now();
    this.notifyUpdated(provider.name);

    if (!balanceProvider) {
      state.isRefreshing = false;
      state.lastError = 'Balance provider is not available.';
      this.notifyUpdated(provider.name);
      return;
    }

    try {
      const credential = await this.resolveCredential(provider);
      const result = await balanceProvider.refresh({
        provider,
        credential,
      });

      if (result.success && result.snapshot) {
        state.snapshot = result.snapshot;
        state.lastError = undefined;
        state.lastRefreshAt = Date.now();
      } else {
        state.lastError = result.error ?? 'Balance refresh failed.';
      }
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      state.isRefreshing = false;
      this.notifyUpdated(provider.name);
      balanceProvider.dispose?.();
    }
  }

  private async resolveCredential(
    provider: ProviderConfig,
  ): Promise<AuthTokenInfo | undefined> {
    const auth = provider.auth;
    if (!auth || auth.method === 'none') {
      return { kind: 'none' };
    }

    if (!this.authManager) {
      return undefined;
    }

    const credential = await this.authManager.getCredential(
      provider.name,
      'background',
    );
    return this.toAuthTokenInfo(credential);
  }

  private toAuthTokenInfo(
    credential: AuthCredential | undefined,
  ): AuthTokenInfo {
    if (!credential?.value) {
      return { kind: 'none' };
    }

    return {
      kind: 'token',
      token: credential.value,
      tokenType: credential.tokenType,
      expiresAt: credential.expiresAt,
    };
  }

  private createProvider(provider: ProviderConfig) {
    if (!this.secretStore || !this.configStore) {
      return null;
    }

    const config = provider.balanceProvider;
    if (!config || config.method === 'none') {
      return null;
    }

    const context = this.createContext(provider.name);
    return createBalanceProvider(context, config);
  }

  private createContext(providerName: string): BalanceProviderContext {
    return {
      providerId: providerName,
      providerLabel: providerName,
      secretStore: this.secretStore!,
      authManager: this.authManager,
      storeSecretsInSettings: this.configStore?.storeApiKeyInSettings,
      persistBalanceConfig: async (balanceProvider: BalanceConfig) => {
        const provider = this.configStore?.getProvider(providerName);
        if (!provider || !this.configStore) {
          return;
        }
        await this.configStore.upsertProvider({
          ...provider,
          balanceProvider,
        });
      },
    };
  }

  private ensureState(providerName: string): BalanceProviderState {
    let state = this.states.get(providerName);
    if (!state) {
      state = {
        isRefreshing: false,
        pendingTrailing: false,
      };
      this.states.set(providerName, state);
    }
    return state;
  }

  private isWithinThrottleWindow(
    state: BalanceProviderState,
    now: number,
  ): boolean {
    return (
      state.lastAttemptAt !== undefined &&
      now - state.lastAttemptAt < this.getThrottleWindowMs()
    );
  }

  private getPeriodicRefreshMs(): number {
    return (
      this.configStore?.balanceRefreshIntervalMs ?? DEFAULT_PERIODIC_REFRESH_MS
    );
  }

  private getThrottleWindowMs(): number {
    return (
      this.configStore?.balanceThrottleWindowMs ?? DEFAULT_THROTTLE_WINDOW_MS
    );
  }

  private hasConfiguredBalanceProvider(provider: ProviderConfig): boolean {
    return (
      !!provider.balanceProvider && provider.balanceProvider.method !== 'none'
    );
  }

  private getProviderConfigSignature(provider: ProviderConfig): string {
    return stableStringify({
      type: provider.type,
      baseUrl: provider.baseUrl,
      auth: provider.auth,
      balanceProvider: provider.balanceProvider,
    });
  }

  private startPeriodicRefresh(): void {
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = undefined;
    }

    if (!this.isLeader()) {
      return;
    }

    this.periodicTimer = setInterval(() => {
      void this.runPeriodicRefresh();
    }, this.getPeriodicRefreshMs());
  }

  private async runPeriodicRefresh(): Promise<void> {
    const providers = this.configStore?.endpoints ?? [];

    await Promise.all(
      providers
        .filter((provider) => this.hasConfiguredBalanceProvider(provider))
        .map((provider) => this.refreshProvider(provider, 'periodic', false)),
    );
  }

  private reconcileStates(): void {
    const providers = this.configStore?.endpoints ?? [];
    const knownNames = new Set(providers.map((provider) => provider.name));
    let prunedLastUsedAt = false;
    for (const providerName of this.lastUsedAt.keys()) {
      if (!knownNames.has(providerName)) {
        this.lastUsedAt.delete(providerName);
        prunedLastUsedAt = true;
      }
    }
    if (prunedLastUsedAt) {
      this.queuePersistState();
    }

    const activeProviders = providers.filter((provider) =>
      this.hasConfiguredBalanceProvider(provider),
    );
    const activeNames = new Set(
      activeProviders.map((provider) => provider.name),
    );
    const nextSignatures = new Map(
      activeProviders.map((provider) => [
        provider.name,
        this.getProviderConfigSignature(provider),
      ]),
    );

    for (const [providerName, currentSignature] of this.configSignatures) {
      const nextSignature = nextSignatures.get(providerName);
      if (!nextSignature || nextSignature !== currentSignature) {
        this.clearProviderState(providerName);
      }
    }

    for (const providerName of Array.from(this.states.keys())) {
      if (activeNames.has(providerName)) {
        continue;
      }
      this.clearProviderState(providerName);
    }

    this.configSignatures.clear();
    for (const [providerName, signature] of nextSignatures) {
      this.configSignatures.set(providerName, signature);
    }

    if (this.isLeader()) {
      for (const provider of activeProviders) {
        const state = this.states.get(provider.name);
        if (this.shouldRefreshOnReconcile(state)) {
          void this.refreshProvider(provider, 'ui', false);
        }
      }
    }
  }

  private shouldRefreshOnReconcile(
    state: BalanceProviderState | undefined,
  ): boolean {
    if (state?.isRefreshing) {
      return false;
    }

    const lastCheckpoint =
      state?.lastAttemptAt ??
      state?.lastRefreshAt ??
      state?.snapshot?.updatedAt;

    if (lastCheckpoint === undefined) {
      return true;
    }

    return Date.now() - lastCheckpoint >= this.getPeriodicRefreshMs();
  }

  private clearProviderState(providerName: string): void {
    this.states.delete(providerName);
    this.configSignatures.delete(providerName);

    const trailingTimer = this.trailingTimers.get(providerName);
    if (trailingTimer) {
      clearTimeout(trailingTimer);
      this.trailingTimers.delete(providerName);
    }

    this.notifyUpdated(providerName);
  }

  private async loadState(): Promise<void> {
    if (!this.extensionContext) {
      return;
    }

    const persisted =
      this.extensionContext.globalState.get<PersistedState>(STATE_KEY);

    if (
      !persisted ||
      persisted.version !== STATE_VERSION ||
      !isRecord(persisted.providers) ||
      !isRecord(persisted.lastUsedAt)
    ) {
      return;
    }

    for (const [providerName, rawState] of Object.entries(
      persisted.providers,
    )) {
      const state = this.toRuntimeState(rawState);
      if (state) {
        this.states.set(providerName, state);
      }
    }

    for (const [providerName, timestamp] of Object.entries(
      persisted.lastUsedAt,
    )) {
      if (
        typeof timestamp === 'number' &&
        Number.isFinite(timestamp) &&
        timestamp >= 0
      ) {
        this.lastUsedAt.set(providerName, timestamp);
      }
    }
  }

  private toRuntimeState(rawState: unknown): BalanceProviderState | undefined {
    if (!isRecord(rawState)) {
      return undefined;
    }

    const snapshot = this.toSnapshot(rawState.snapshot);
    const lastError = this.toString(rawState.lastError);
    const lastAttemptAt = this.toTimestamp(rawState.lastAttemptAt);
    const lastRefreshAt = this.toTimestamp(rawState.lastRefreshAt);

    if (
      !snapshot &&
      lastError === undefined &&
      lastAttemptAt === undefined &&
      lastRefreshAt === undefined
    ) {
      return undefined;
    }

    return {
      isRefreshing: false,
      pendingTrailing: false,
      snapshot,
      lastError,
      lastAttemptAt,
      lastRefreshAt,
    };
  }

  private toSnapshot(rawSnapshot: unknown): BalanceSnapshot | undefined {
    if (!isRecord(rawSnapshot)) {
      return undefined;
    }

    const updatedAt = this.toTimestamp(rawSnapshot.updatedAt);
    const items = this.toMetrics(rawSnapshot.items);
    if (updatedAt === undefined || items === undefined) {
      return undefined;
    }

    return {
      updatedAt,
      items,
    };
  }

  private toMetrics(rawItems: unknown): BalanceMetric[] | undefined {
    if (!Array.isArray(rawItems)) {
      return undefined;
    }

    const items: BalanceMetric[] = [];
    for (const raw of rawItems) {
      const item = this.toMetric(raw);
      if (item) {
        items.push(item);
      }
    }
    return items;
  }

  private toMetric(raw: unknown): BalanceMetric | undefined {
    if (!isRecord(raw)) {
      return undefined;
    }

    const id = this.toString(raw.id)?.trim();
    const period = this.toPeriod(raw.period);
    const type = this.toMetricType(raw.type);
    if (!id || !period || !type) {
      return undefined;
    }

    const primary = this.toBoolean(raw.primary);
    const scope = this.toString(raw.scope)?.trim();
    const label = this.toString(raw.label)?.trim();
    const periodLabel = this.toString(raw.periodLabel)?.trim();

    const base = {
      id,
      type,
      period,
      ...(scope ? { scope } : {}),
      ...(label ? { label } : {}),
      ...(periodLabel ? { periodLabel } : {}),
      ...(primary !== undefined ? { primary } : {}),
    };

    if (type === 'amount') {
      const direction = this.toAmountDirection(raw.direction);
      const value = this.toFiniteNumber(raw.value);
      const currencySymbol = this.toString(raw.currencySymbol)?.trim();
      if (!direction || value === undefined) {
        return undefined;
      }

      return {
        ...base,
        type,
        direction,
        value,
        ...(currencySymbol ? { currencySymbol } : {}),
      };
    }

    if (type === 'token') {
      const used = this.toFiniteNumber(raw.used);
      const limit = this.toFiniteNumber(raw.limit);
      const remaining = this.toFiniteNumber(raw.remaining);
      if (used === undefined && limit === undefined && remaining === undefined) {
        return undefined;
      }

      return {
        ...base,
        type,
        ...(used !== undefined ? { used } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(remaining !== undefined ? { remaining } : {}),
      };
    }

    if (type === 'percent') {
      const value = this.toFiniteNumber(raw.value);
      const basis = this.toPercentBasis(raw.basis);
      if (value === undefined) {
        return undefined;
      }

      return {
        ...base,
        type,
        value,
        ...(basis ? { basis } : {}),
      };
    }

    if (type === 'time') {
      const kind = this.toTimeKind(raw.kind);
      const value = this.toString(raw.value)?.trim();
      const timestampMs = this.toTimestamp(raw.timestampMs);
      if (!kind || !value) {
        return undefined;
      }

      return {
        ...base,
        type,
        kind,
        value,
        ...(timestampMs !== undefined ? { timestampMs } : {}),
      };
    }

    const value = this.toStatusValue(raw.value);
    const message = this.toString(raw.message)?.trim();
    if (!value) {
      return undefined;
    }

    return {
      ...base,
      type,
      value,
      ...(message ? { message } : {}),
    };
  }

  private toMetricType(value: unknown): BalanceMetric['type'] | undefined {
    return value === 'amount' ||
      value === 'token' ||
      value === 'percent' ||
      value === 'time' ||
      value === 'status'
      ? value
      : undefined;
  }

  private toPeriod(value: unknown): BalanceMetric['period'] | undefined {
    return value === 'current' ||
      value === 'day' ||
      value === 'week' ||
      value === 'month' ||
      value === 'total' ||
      value === 'custom'
      ? value
      : undefined;
  }

  private toTimeKind(value: unknown): 'expiresAt' | 'resetAt' | undefined {
    return value === 'expiresAt' || value === 'resetAt' ? value : undefined;
  }

  private toAmountDirection(
    value: unknown,
  ): 'remaining' | 'used' | 'limit' | undefined {
    return value === 'remaining' || value === 'used' || value === 'limit'
      ? value
      : undefined;
  }

  private toPercentBasis(value: unknown): 'remaining' | 'used' | undefined {
    return value === 'remaining' || value === 'used' ? value : undefined;
  }

  private toStatusValue(
    value: unknown,
  ): 'ok' | 'unlimited' | 'exhausted' | 'error' | 'unavailable' | undefined {
    return value === 'ok' ||
      value === 'unlimited' ||
      value === 'exhausted' ||
      value === 'error' ||
      value === 'unavailable'
      ? value
      : undefined;
  }

  private toString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }

  private toBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
  }

  private toTimestamp(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : undefined;
  }

  private toFiniteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value)
      ? value
      : undefined;
  }

  private queuePersistState(): void {
    if (!this.extensionContext || !this.isLeader()) {
      return;
    }

    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(() => this.saveState())
      .catch((error) => {
        console.error(
          '[unify-chat-provider] Failed to persist balance state.',
          error,
        );
      });
  }

  private async saveState(): Promise<void> {
    if (!this.extensionContext) {
      return;
    }

    const providers: Record<string, PersistedProviderState> = {};
    for (const [providerName, state] of this.states) {
      const snapshot = state.snapshot;
      const hasData =
        !!snapshot ||
        state.lastError !== undefined ||
        state.lastAttemptAt !== undefined ||
        state.lastRefreshAt !== undefined;
      if (!hasData) {
        continue;
      }

      providers[providerName] = {
        snapshot,
        lastError: state.lastError,
        lastAttemptAt: state.lastAttemptAt,
        lastRefreshAt: state.lastRefreshAt,
      };
    }

    const lastUsedAt: Record<string, number> = {};
    for (const [providerName, timestamp] of this.lastUsedAt) {
      if (
        typeof timestamp === 'number' &&
        Number.isFinite(timestamp) &&
        timestamp >= 0
      ) {
        lastUsedAt[providerName] = timestamp;
      }
    }

    await this.extensionContext.globalState.update(STATE_KEY, {
      version: STATE_VERSION,
      providers,
      lastUsedAt,
    } satisfies PersistedState);
  }

  private disposeRuntime(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }

    for (const timer of this.trailingTimers.values()) {
      clearTimeout(timer);
    }
    this.trailingTimers.clear();
    for (const timer of this.postRequestRefreshRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.postRequestRefreshRetryTimers.clear();

    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = undefined;
    }

    if (this.syncRetryTimer) {
      clearTimeout(this.syncRetryTimer);
      this.syncRetryTimer = undefined;
    }

    this.configSignatures.clear();
    this.states.clear();
    this.refreshInFlight.clear();
    this.lastUsedAt.clear();
    this.persistChain = Promise.resolve();
  }

  dispose(): void {
    this.disposeRuntime();
    this.onDidUpdateEmitter.dispose();
  }
}

export const balanceManager = new BalanceManager();
