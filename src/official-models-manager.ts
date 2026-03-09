import * as vscode from 'vscode';
import { ModelConfig, ProviderConfig } from './types';
import { createProvider } from './client/utils';
import { mergeWithWellKnownModels } from './well-known/models';
import { stableStringify } from './config-ops';
import { SecretStore } from './secret';
import { normalizeBaseUrlInput } from './utils';
import { t } from './i18n';
import type { AuthConfig, AuthCredential, AuthTokenInfo } from './auth/types';
import { createAuthProvider, getAuthMethodCtor, type AuthManager } from './auth';
import { mainInstance } from './main-instance';
import {
  isLeaderUnavailableError,
  isVersionIncompatibleError,
  MainInstanceError,
} from './main-instance/errors';
import type { EventedUriHandler } from './uri-handler';
import type { ConfigStore } from './config-store';

/**
 * State for a single provider's official models fetch
 */
export interface OfficialModelsFetchState {
  /** Last successful fetch timestamp (ms) */
  lastFetchTime: number;
  /** Last fetch attempt timestamp (ms), includes both success and failure */
  lastAttemptTime?: number;
  /** Last successfully fetched models */
  models: ModelConfig[];
  /** Hash of the last fetched models for comparison */
  modelsHash: string;
  /** Number of consecutive identical fetches */
  consecutiveIdenticalFetches: number;
  /** Current fetch interval in milliseconds */
  currentIntervalMs: number;
  /** Number of consecutive failed fetch attempts */
  consecutiveErrorFetches?: number;
  /** Current retry interval after errors in milliseconds */
  currentErrorIntervalMs?: number;
  /** Last error message if the last fetch failed */
  lastError?: string;
  /** Timestamp of last error */
  lastErrorTime?: number;
  lastConfigSignature?: FetchConfigSignature;
  /** Whether a fetch is currently in progress */
  isFetching?: boolean;
}

/**
 * Configuration signature for detecting changes that require a refresh
 */
export interface FetchConfigSignature {
  type: string;
  baseUrl: string;
  authMethod: string;
  authHash: string;
  extraHeadersHash: string;
  extraBodyHash: string;
}

/**
 * Draft input for fetching official models.
 * This can be incomplete and is validated inside the manager.
 */
export interface OfficialModelsDraftInput {
  type?: ProviderConfig['type'];
  name?: string;
  baseUrl?: string;
  auth?: AuthConfig;
  extraHeaders?: ProviderConfig['extraHeaders'];
  extraBody?: ProviderConfig['extraBody'];
  timeout?: ProviderConfig['timeout'];
}

/**
 * Draft session state for editing providers (in-memory only)
 */
interface DraftSessionState {
  state: OfficialModelsFetchState;
  /** Config signature when last fetch was started */
  configSignature: FetchConfigSignature;
}

/**
 * Persisted state structure
 */
interface PersistedState {
  [providerName: string]: OfficialModelsFetchState;
}

type ApplyProviderStateSyncResult = {
  applied: boolean;
  state: OfficialModelsFetchState;
};

/**
 * Configuration for the exponential backoff
 */
const FETCH_CONFIG = {
  /** Initial interval between fetches (5 minutes) */
  initialIntervalMs: 5 * 60 * 1000,
  /** Maximum interval between fetches (24 hours) */
  maxIntervalMs: 24 * 60 * 60 * 1000,
  /** Multiplier for interval when identical results are fetched */
  backoffMultiplier: 2,
  /** Number of identical fetches before extending interval */
  identicalFetchesThreshold: 2,
  /** Minimum interval even after reset (1 minute) */
  minIntervalMs: 60 * 1000,
  /** Initial retry interval after an error (1 seconds) */
  errorInitialIntervalMs: 1 * 1000,
  /** Maximum retry interval after errors (1 minutes) */
  errorMaxIntervalMs: 1 * 60 * 1000,
  /** Multiplier for interval when errors continue */
  errorBackoffMultiplier: 2,
};

const STATE_KEY = 'officialModelsState';

const AUTH_REQUIRED_MESSAGE =
  'Authentication required. Please re-authorize in Provider Settings.';

/**
 * Manager for fetching and caching official models from providers
 */
export class OfficialModelsManager {
  private state: PersistedState = {};
  private extensionContext?: vscode.ExtensionContext;
  private configStore?: ConfigStore;
  private secretStore?: SecretStore;
  private authManager?: AuthManager;
  private uriHandler?: EventedUriHandler;
  private fetchInProgress = new Map<string, Promise<ModelConfig[]>>();
  private readonly onDidUpdateEmitter = new vscode.EventEmitter<string>();
  private readonly disposables: vscode.Disposable[] = [];
  private syncRetryTimer?: ReturnType<typeof setTimeout>;
  private providerStateSyncRetryTimer?: ReturnType<typeof setTimeout>;
  private readonly backgroundFetchRetryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly pendingProviderStateSyncs = new Map<
    string,
    OfficialModelsFetchState
  >();

  /** Draft session states (in-memory only, keyed by session ID) */
  private draftSessions = new Map<string, DraftSessionState>();
  /** Fetch in progress for draft sessions */
  private draftFetchInProgress = new Map<string, Promise<ModelConfig[]>>();

  /** Fired when a provider's or draft session's official models are updated */
  readonly onDidUpdate = this.onDidUpdateEmitter.event;

  private isLeader(): boolean {
    return mainInstance.isLeader();
  }

  private resolveConfiguredProvider(providerName: string): ProviderConfig | undefined {
    return this.configStore?.getProvider(providerName);
  }

  private getStateCheckpoint(state: OfficialModelsFetchState | undefined): number {
    if (!state) {
      return 0;
    }
    return state.lastAttemptTime ?? state.lastErrorTime ?? state.lastFetchTime;
  }

  private shouldPreferProviderState(
    current: OfficialModelsFetchState | undefined,
    incoming: OfficialModelsFetchState,
  ): boolean {
    if (!current) {
      return true;
    }

    const currentCheckpoint = this.getStateCheckpoint(current);
    const incomingCheckpoint = this.getStateCheckpoint(incoming);
    if (incomingCheckpoint !== currentCheckpoint) {
      return incomingCheckpoint > currentCheckpoint;
    }

    const currentFetchTime = current.lastFetchTime ?? 0;
    const incomingFetchTime = incoming.lastFetchTime ?? 0;
    if (incomingFetchTime !== currentFetchTime) {
      return incomingFetchTime > currentFetchTime;
    }

    if (current.modelsHash !== incoming.modelsHash) {
      return incoming.modelsHash.trim() !== '' && current.modelsHash.trim() === '';
    }

    if (!current.lastConfigSignature && incoming.lastConfigSignature) {
      return true;
    }

    if (
      current.lastConfigSignature &&
      incoming.lastConfigSignature &&
      !this.signaturesEqual(current.lastConfigSignature, incoming.lastConfigSignature)
    ) {
      return true;
    }

    return false;
  }

  private async recoverAfterLeaderPromotion(): Promise<void> {
    if (!this.isLeader()) {
      return;
    }

    const updatedProviderNames: string[] = [];
    for (const [providerName, state] of Object.entries(this.state)) {
      if (!state?.isFetching) {
        continue;
      }
      state.isFetching = false;
      state.lastAttemptTime = 0;
      updatedProviderNames.push(providerName);
    }

    if (updatedProviderNames.length === 0) {
      return;
    }

    await this.saveState();
    for (const providerName of updatedProviderNames) {
      this.onDidUpdateEmitter.fire(providerName);
      this.broadcastProviderUpdate(providerName);
    }
  }

  private scheduleRecoveryAfterLeaderPromotion(): void {
    void this
      .recoverAfterLeaderPromotion()
      .then(() => this.flushPendingProviderStateSyncs())
      .catch((error) => {
        console.error(
          '[unify-chat-provider] Failed to recover official-model state after leader promotion.',
          error,
        );
      });
  }

  getSnapshotForFollowers(): PersistedState {
    return { ...this.state };
  }

  private async commitProviderState(
    providerName: string,
    state: OfficialModelsFetchState,
  ): Promise<void> {
    this.state[providerName] = { ...state };
    await this.saveState();
    this.onDidUpdateEmitter.fire(providerName);
    this.broadcastProviderUpdate(providerName);
  }

  private applyAuthoritativeProviderState(
    providerName: string,
    state: OfficialModelsFetchState,
  ): void {
    const previous = this.state[providerName];
    const changed =
      !previous || stableStringify(previous) !== stableStringify(state);
    this.state[providerName] = { ...state };
    if (changed) {
      this.onDidUpdateEmitter.fire(providerName);
    }
  }

  private async commitLocalProviderStateAndQueueSync(
    providerName: string,
    state: OfficialModelsFetchState,
  ): Promise<void> {
    await this.commitProviderState(providerName, state);

    if (this.isLeader()) {
      this.pendingProviderStateSyncs.delete(providerName);
      return;
    }

    this.pendingProviderStateSyncs.set(providerName, { ...state });
    this.schedulePendingProviderStateSyncRetry();
  }

  async applyProviderStateFromSync(
    providerName: string,
    state: OfficialModelsFetchState,
  ): Promise<ApplyProviderStateSyncResult> {
    const current = this.state[providerName];
    if (!this.shouldPreferProviderState(current, state)) {
      return {
        applied: false,
        state: current ? { ...current } : { ...state },
      };
    }
    await this.commitProviderState(providerName, state);
    return { applied: true, state: { ...state } };
  }

  private broadcastProviderUpdate(providerName: string): void {
    if (!this.isLeader()) {
      return;
    }
    mainInstance.broadcast('officialModels.updated', {
      providerName,
      state: this.state[providerName] ?? null,
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
      delete this.state[providerName];
    } else if (stateValue && typeof stateValue === 'object' && !Array.isArray(stateValue)) {
      this.state[providerName] = stateValue as OfficialModelsFetchState;
    }

    this.onDidUpdateEmitter.fire(providerName);
  }

  private applySnapshotFromLeader(snapshot: unknown): void {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      return;
    }

    const updatedProviderNames = new Set<string>(Object.keys(this.state));
    const next: PersistedState = {};
    for (const [providerName, raw] of Object.entries(
      snapshot as Record<string, unknown>,
    )) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        continue;
      }
      next[providerName] = raw as OfficialModelsFetchState;
      updatedProviderNames.add(providerName);
    }

    for (const [providerName, state] of Array.from(
      this.pendingProviderStateSyncs.entries(),
    )) {
      const current = next[providerName];
      if (this.shouldPreferProviderState(current, state)) {
        next[providerName] = { ...state };
        updatedProviderNames.add(providerName);
        continue;
      }
      this.pendingProviderStateSyncs.delete(providerName);
    }

    this.state = next;
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
        'officialModels.getSnapshot',
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

  private schedulePendingProviderStateSyncRetry(): void {
    if (
      this.pendingProviderStateSyncs.size === 0 ||
      this.providerStateSyncRetryTimer
    ) {
      return;
    }

    this.providerStateSyncRetryTimer = setTimeout(() => {
      this.providerStateSyncRetryTimer = undefined;
      void this.flushPendingProviderStateSyncs();
    }, 250);
  }

  private async flushPendingProviderStateSyncs(): Promise<void> {
    if (this.pendingProviderStateSyncs.size === 0) {
      return;
    }

    for (const [providerName, state] of Array.from(
      this.pendingProviderStateSyncs.entries(),
    )) {
      try {
        if (this.isLeader()) {
          await this.applyProviderStateFromSync(providerName, state);
        } else {
          const response = await mainInstance.runInLeaderWhenAvailable<unknown>(
            'officialModels.applyProviderState',
            {
              providerName,
              state,
            },
          );
          const result = this.parseApplyProviderStateResponse(
            response,
            'officialModels.applyProviderState',
          );
          this.applyAuthoritativeProviderState(providerName, result.state);
        }
        this.pendingProviderStateSyncs.delete(providerName);
      } catch (error) {
        if (
          (error instanceof MainInstanceError &&
            error.code === 'NOT_IMPLEMENTED') ||
          isLeaderUnavailableError(error) ||
          isVersionIncompatibleError(error)
        ) {
          this.schedulePendingProviderStateSyncRetry();
          return;
        }
        throw error;
      }
    }
  }

  private clearBackgroundFetchRetry(providerName: string): void {
    const timer = this.backgroundFetchRetryTimers.get(providerName);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.backgroundFetchRetryTimers.delete(providerName);
  }

  private scheduleBackgroundFetchRetry(provider: ProviderConfig): void {
    this.clearBackgroundFetchRetry(provider.name);
    const timer = setTimeout(() => {
      this.backgroundFetchRetryTimers.delete(provider.name);
      this.triggerBackgroundFetch(provider);
    }, 250);
    this.backgroundFetchRetryTimers.set(provider.name, timer);
  }

  /**
   * Initialize the manager with VS Code extension context
   */
  async initialize(
    context: vscode.ExtensionContext,
    configStore: ConfigStore,
    secretStore: SecretStore,
    authManager?: AuthManager,
    uriHandler?: EventedUriHandler,
  ): Promise<void> {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    if (this.syncRetryTimer) {
      clearTimeout(this.syncRetryTimer);
      this.syncRetryTimer = undefined;
    }
    if (this.providerStateSyncRetryTimer) {
      clearTimeout(this.providerStateSyncRetryTimer);
      this.providerStateSyncRetryTimer = undefined;
    }
    for (const timer of this.backgroundFetchRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.backgroundFetchRetryTimers.clear();

    this.extensionContext = context;
    this.configStore = configStore;
    this.secretStore = secretStore;
    this.authManager = authManager;
    this.uriHandler = uriHandler;
    await this.loadState();

    this.disposables.push(
      mainInstance.onDidReceiveEvent(({ event, payload }) => {
        if (event === 'officialModels.updated') {
          this.applyLeaderUpdate(payload);
        }
      }),
    );

    this.disposables.push(
      mainInstance.onDidChangeRole(({ role }) => {
        if (role === 'leader') {
          this.scheduleRecoveryAfterLeaderPromotion();
          return;
        }
        void this.syncFromLeader();
      }),
    );

    if (this.isLeader()) {
      this.scheduleRecoveryAfterLeaderPromotion();
    } else {
      void this.syncFromLeader();
    }
  }

  /**
   * Load persisted state from extension globalState
   */
  private async loadState(): Promise<void> {
    if (!this.extensionContext) return;
    const persisted =
      this.extensionContext.globalState.get<PersistedState>(STATE_KEY);
    if (persisted) {
      this.state = persisted;
    }
  }

  /**
   * Save state to extension globalState
   * Note: isFetching is excluded as it's a runtime-only state
   */
  private async saveState(): Promise<void> {
    if (!this.extensionContext || !this.isLeader()) return;
    const stateToSave: PersistedState = {};
    for (const [key, value] of Object.entries(this.state)) {
      const { isFetching: _, ...rest } = value;
      stateToSave[key] = rest as OfficialModelsFetchState;
    }
    await this.extensionContext.globalState.update(STATE_KEY, stateToSave);
  }

  /**
   * Get the current fetch state for a provider
   */
  getProviderState(providerName: string): OfficialModelsFetchState | undefined {
    return this.state[providerName];
  }

  /**
   * Get official models and current fetch state for a provider.
   */
  async getOfficialModelsData(
    provider: ProviderConfig,
    options?: { forceFetch?: boolean },
  ): Promise<{
    models: ModelConfig[];
    state: OfficialModelsFetchState | undefined;
  }> {
    const models = await this.getOfficialModels(
      provider,
      options?.forceFetch ?? false,
    );
    const state = this.getProviderState(provider.name);
    return { models, state };
  }

  /**
   * Check if a fetch is needed for the provider based on the interval
   */
  private shouldFetch(providerName: string): boolean {
    const state = this.state[providerName];
    if (!state) return true;

    return this.shouldFetchByState(state);
  }

  private shouldFetchByState(state: OfficialModelsFetchState): boolean {
    const lastAttempt =
      state.lastAttemptTime ?? state.lastErrorTime ?? state.lastFetchTime;
    if (!lastAttempt) {
      return true;
    }

    const intervalMs =
      state.lastError && state.lastErrorTime
        ? state.currentErrorIntervalMs ?? FETCH_CONFIG.errorInitialIntervalMs
        : state.currentIntervalMs;

    return Date.now() - lastAttempt >= intervalMs;
  }

  private recordSuccess(state: OfficialModelsFetchState, now: number): void {
    state.lastFetchTime = now;
    state.lastAttemptTime = now;
    state.lastError = undefined;
    state.lastErrorTime = undefined;
    state.consecutiveErrorFetches = 0;
    state.currentErrorIntervalMs = FETCH_CONFIG.errorInitialIntervalMs;
  }

  private recordFailure(
    state: OfficialModelsFetchState,
    now: number,
    errorMessage: string,
  ): void {
    state.lastAttemptTime = now;
    state.lastError = errorMessage;
    state.lastErrorTime = now;

    const nextConsecutive = (state.consecutiveErrorFetches ?? 0) + 1;
    state.consecutiveErrorFetches = nextConsecutive;

    const current =
      state.currentErrorIntervalMs ?? FETCH_CONFIG.errorInitialIntervalMs;
    const next =
      nextConsecutive <= 1
        ? current
        : Math.min(
            current * FETCH_CONFIG.errorBackoffMultiplier,
            FETCH_CONFIG.errorMaxIntervalMs,
          );
    state.currentErrorIntervalMs = next;
  }

  /**
   * Calculate hash for model list comparison
   */
  private hashModels(models: ModelConfig[]): string {
    // Sort models by ID for consistent hashing
    const sorted = [...models].sort((a, b) => a.id.localeCompare(b.id));
    return stableStringify(sorted);
  }

  /**
   * Update the fetch interval based on whether the result was identical
   */
  private updateInterval(
    state: OfficialModelsFetchState,
    isIdentical: boolean,
  ): void {
    if (isIdentical) {
      state.consecutiveIdenticalFetches++;
      if (
        state.consecutiveIdenticalFetches >=
        FETCH_CONFIG.identicalFetchesThreshold
      ) {
        // Extend interval using exponential backoff
        state.currentIntervalMs = Math.min(
          state.currentIntervalMs * FETCH_CONFIG.backoffMultiplier,
          FETCH_CONFIG.maxIntervalMs,
        );
      }
    } else {
      // Reset on different results
      state.consecutiveIdenticalFetches = 0;
      state.currentIntervalMs = FETCH_CONFIG.initialIntervalMs;
    }
  }

  /**
   * Fetch official models for a provider
   * Returns cached models if within interval, fetches new ones otherwise
   */
  async getOfficialModels(
    provider: ProviderConfig,
    forceFetch = false,
    throwError = false,
  ): Promise<ModelConfig[]> {
    const providerName = provider.name;
    const activeProvider =
      this.isLeader() ? this.resolveConfiguredProvider(providerName) : provider;
    if (!activeProvider) {
      return [];
    }

    // If a fetch is already in progress for this provider, wait for it
    const inProgress = this.fetchInProgress.get(providerName);
    if (inProgress) {
      return inProgress;
    }

    const existingState = this.state[providerName];
    const currentSignature = await this.computeConfigSignature(activeProvider);

    const configChanged =
      !!existingState &&
      (!existingState.lastConfigSignature ||
        !this.signaturesEqual(
          existingState.lastConfigSignature,
          currentSignature,
        ));

    const shouldForceFetch = forceFetch || configChanged;

    // Return cached models if not time to fetch yet
    if (!shouldForceFetch && !this.shouldFetch(providerName)) {
      if (existingState) {
        return existingState.models;
      }
    }

    if (!this.isLeader()) {
      const fetchPromise = this.fetchFromLeader(provider, shouldForceFetch).catch(
        async (error) => {
          if (isVersionIncompatibleError(error)) {
            if (shouldForceFetch) {
              throw error;
            }
            return existingState?.models ?? [];
          }
          if (
            error instanceof MainInstanceError &&
            (error.code === 'NO_LEADER' || error.code === 'LEADER_GONE')
          ) {
            if (this.isLeader()) {
              const leaderProvider = this.resolveConfiguredProvider(providerName);
              if (!leaderProvider) {
                return [];
              }
              const leaderSignature = await this.computeConfigSignature(
                leaderProvider,
              );
              return await this.doFetch(leaderProvider, leaderSignature);
            }
            return existingState?.models ?? [];
          }
          throw error;
        },
      );
      this.fetchInProgress.set(providerName, fetchPromise);

      try {
        return await fetchPromise;
      } finally {
        this.fetchInProgress.delete(providerName);
      }
    }

    // Start a new fetch
    const fetchPromise = this.doFetch(activeProvider, currentSignature);
    this.fetchInProgress.set(providerName, fetchPromise);

    try {
      return await fetchPromise;
    } finally {
      this.fetchInProgress.delete(providerName);
    }
  }

  private async fetchFromLeader(
    provider: ProviderConfig,
    forceFetch: boolean,
  ): Promise<ModelConfig[]> {
    const response = await mainInstance.runInLeaderWhenAvailable<unknown>(
      'officialModels.getOfficialModels',
      { providerName: provider.name, forceFetch },
    );

    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      throw new MainInstanceError(
        'BAD_REQUEST',
        'officialModels.getOfficialModels: invalid response',
      );
    }

    const record = response as Record<string, unknown>;
    const modelsValue = record['models'];
    const stateValue = record['state'];

    if (!Array.isArray(modelsValue)) {
      throw new MainInstanceError(
        'BAD_REQUEST',
        'officialModels.getOfficialModels: invalid response',
      );
    }

    if (stateValue && typeof stateValue === 'object' && !Array.isArray(stateValue)) {
      this.applyAuthoritativeProviderState(
        provider.name,
        stateValue as OfficialModelsFetchState,
      );
    }

    return modelsValue as ModelConfig[];
  }

  private parseApplyProviderStateResponse(
    value: unknown,
    method: string,
  ): ApplyProviderStateSyncResult {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new MainInstanceError('BAD_REQUEST', `${method}: invalid response`);
    }

    const record = value as Record<string, unknown>;
    const applied = record['applied'];
    const stateValue = record['state'];
    if (typeof applied !== 'boolean') {
      throw new MainInstanceError('BAD_REQUEST', `${method}: invalid response`);
    }
    if (!stateValue || typeof stateValue !== 'object' || Array.isArray(stateValue)) {
      throw new MainInstanceError('BAD_REQUEST', `${method}: invalid response`);
    }

    return {
      applied,
      state: stateValue as OfficialModelsFetchState,
    };
  }

  /**
   * Actually perform the fetch
   */
  private async doFetch(
    provider: ProviderConfig,
    signature: FetchConfigSignature,
  ): Promise<ModelConfig[]> {
    const providerName = provider.name;

    const configError = this.getProviderConfigError(provider);
    if (configError) {
      const state = this.ensureState(providerName);
      this.recordFailure(state, Date.now(), configError);
      state.isFetching = false;
      state.lastConfigSignature = signature;
      await this.saveState();
      this.onDidUpdateEmitter.fire(providerName);
      this.broadcastProviderUpdate(providerName);
      return state.models;
    }

    const state = this.ensureState(providerName);
    state.isFetching = true;
    state.lastConfigSignature = signature;
    this.onDidUpdateEmitter.fire(providerName);
    this.broadcastProviderUpdate(providerName);

    try {
      const credential = await this.resolveCredentialForPersistedProvider(
        provider,
      );
      if (!credential) {
        this.recordFailure(state, Date.now(), AUTH_REQUIRED_MESSAGE);
        state.isFetching = false;
        state.lastConfigSignature = signature;
        await this.saveState();
        this.onDidUpdateEmitter.fire(providerName);
        this.broadcastProviderUpdate(providerName);
        return state.models;
      }

      const client = createProvider(provider);

      if (!client.getAvailableModels) {
        throw new Error(
          t('Provider does not support fetching available models'),
        );
      }

      const rawModels = await client.getAvailableModels(credential);
      const models = mergeWithWellKnownModels(rawModels, provider);
      const modelsHash = this.hashModels(models);

      const isIdentical = state.modelsHash === modelsHash;
      const now = Date.now();

      this.recordSuccess(state, now);
      state.models = models;
      state.modelsHash = modelsHash;
      state.isFetching = false;
      state.lastConfigSignature = signature;
      this.updateInterval(state, isIdentical);

      await this.saveState();
      this.onDidUpdateEmitter.fire(providerName);
      this.broadcastProviderUpdate(providerName);

      return models;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const now = Date.now();

      this.recordFailure(state, now, errorMessage);
      state.isFetching = false;
      state.lastConfigSignature = signature;
      await this.saveState();
      this.onDidUpdateEmitter.fire(providerName);
      this.broadcastProviderUpdate(providerName);
      return state.models;
    }
  }

  private getProviderConfigError(provider: ProviderConfig): string | undefined {
    const missing: string[] = [];

    if (!provider.name.trim()) missing.push(t('Name'));
    if (!provider.type) missing.push(t('API Format'));
    if (!provider.baseUrl.trim()) missing.push(t('API Base URL'));

    if (missing.length === 0) return undefined;
    return this.formatMissingFieldsError(missing);
  }

  private formatMissingFieldsError(missing: string[]): string {
    return t(
      'Cannot fetch official models: please configure the following fields first: {0}',
      missing.join(', '),
    );
  }

  private normalizeDraftBaseUrlForSignature(raw: string | undefined): string {
    const trimmed = raw?.trim() ?? '';
    if (!trimmed) return '';
    try {
      return normalizeBaseUrlInput(trimmed);
    } catch {
      return trimmed;
    }
  }

  private computeAuthHash(auth: AuthConfig | undefined): string {
    if (!auth || auth.method === 'none') {
      return this.hashString('');
    }

    return this.hashString(
      stableStringify(getAuthMethodCtor(auth.method)?.redactForExport(auth)),
    );
  }

  private computeDraftConfigSignature(
    input: OfficialModelsDraftInput,
  ): FetchConfigSignature {
    const auth = input.auth;
    const authMethod = auth?.method ?? 'none';

    const authHash = this.computeAuthHash(auth);

    return {
      type: input.type ?? '',
      baseUrl: this.normalizeDraftBaseUrlForSignature(input.baseUrl),
      authMethod,
      authHash,
      extraHeadersHash: this.hashString(
        stableStringify(input.extraHeaders ?? {}),
      ),
      extraBodyHash: this.hashString(stableStringify(input.extraBody ?? {})),
    };
  }

  private resolveDraftInput(
    input: OfficialModelsDraftInput,
  ):
    | { kind: 'ok'; provider: ProviderConfig }
    | { kind: 'error'; message: string } {
    const missing: string[] = [];

    const name = input.name?.trim() || t('Draft Provider');
    const type = input.type;
    const baseUrlRaw = input.baseUrl?.trim();

    if (!type) missing.push(t('API Format'));
    if (!baseUrlRaw) missing.push(t('API Base URL'));

    if (missing.length > 0) {
      return { kind: 'error', message: this.formatMissingFieldsError(missing) };
    }

    if (!type || !baseUrlRaw) {
      return {
        kind: 'error',
        message: t(
          'Cannot fetch official models: provider configuration is incomplete.',
        ),
      };
    }

    let baseUrl: string;
    try {
      baseUrl = normalizeBaseUrlInput(baseUrlRaw);
    } catch {
      return {
        kind: 'error',
        message: t(
          'Cannot fetch official models: please enter a valid API base URL.',
        ),
      };
    }

    const provider: ProviderConfig = {
      type,
      name,
      baseUrl,
      auth: input.auth,
      models: [],
      extraHeaders: input.extraHeaders,
      extraBody: input.extraBody,
      timeout: input.timeout,
    };

    return { kind: 'ok', provider };
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

  private async resolveCredentialForPersistedProvider(
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

  private async resolveCredentialForDraftProvider(
    provider: ProviderConfig,
  ): Promise<AuthTokenInfo | undefined> {
    const auth = provider.auth;
    if (!auth || auth.method === 'none') {
      return { kind: 'none' };
    }

    if (!this.secretStore) {
      return undefined;
    }

    const authProvider = createAuthProvider(
      {
        providerId: provider.name,
        providerLabel: provider.name,
        secretStore: this.secretStore,
        uriHandler: this.uriHandler,
      },
      auth,
    );

    if (!authProvider) {
      return undefined;
    }

    try {
      const credential = await authProvider.getCredential();
      return this.toAuthTokenInfo(credential);
    } finally {
      authProvider.dispose?.();
    }
  }

  /**
   * Ensure a state exists for the provider
   */
  private ensureState(providerName: string): OfficialModelsFetchState {
    if (!this.state[providerName]) {
      this.state[providerName] = {
        lastFetchTime: 0,
        lastAttemptTime: 0,
        models: [],
        modelsHash: '',
        consecutiveIdenticalFetches: 0,
        currentIntervalMs: FETCH_CONFIG.initialIntervalMs,
        consecutiveErrorFetches: 0,
        currentErrorIntervalMs: FETCH_CONFIG.errorInitialIntervalMs,
      };
    }
    return this.state[providerName];
  }

  /**
   * Force refresh official models for all providers with autoFetchOfficialModels enabled
   */
  async refreshAll(providers?: ProviderConfig[]): Promise<number> {
    if (!this.isLeader()) {
      const response = await mainInstance.runInLeaderWhenAvailable<unknown>(
        'officialModels.refreshAll',
        providers && providers.length > 0
          ? {
              providerNames: providers.map((provider) => provider.name),
            }
          : {},
      );
      if (!response || typeof response !== 'object' || Array.isArray(response)) {
        throw new MainInstanceError(
          'BAD_REQUEST',
          'officialModels.refreshAll: invalid response',
        );
      }
      const count = (response as Record<string, unknown>)['count'];
      if (typeof count !== 'number' || !Number.isFinite(count)) {
        throw new MainInstanceError(
          'BAD_REQUEST',
          'officialModels.refreshAll: invalid response',
        );
      }
      return count;
    }

    const currentProviders = providers ?? this.configStore?.endpoints ?? [];
    const enabledProviders = currentProviders.filter(
      (p) => p.autoFetchOfficialModels,
    );

    await Promise.all(
      enabledProviders.map((provider) =>
        this.getOfficialModels(provider, true),
      ),
    );

    return enabledProviders.length;
  }

  /**
   * Force refresh official models for a specific provider
   */
  async refresh(provider: ProviderConfig): Promise<ModelConfig[]> {
    return this.getOfficialModels(provider, true);
  }

  /**
   * Trigger a background fetch for a provider without blocking.
   * Returns immediately, fetch happens asynchronously.
   * The onDidUpdate event will fire when the fetch completes.
   */
  triggerBackgroundFetch(provider: ProviderConfig): void {
    if (!this.isLeader()) {
      void mainInstance
        .runInLeaderWhenAvailable('officialModels.triggerBackgroundFetch', {
          providerName: provider.name,
        })
        .then(() => {
          this.clearBackgroundFetchRetry(provider.name);
        })
        .catch((error) => {
          if (isLeaderUnavailableError(error)) {
            if (this.isLeader()) {
              void this.getOfficialModels(provider, false);
              return;
            }
            this.scheduleBackgroundFetchRetry(provider);
          }
        });
      return;
    }

    const currentProvider = this.resolveConfiguredProvider(provider.name);
    this.clearBackgroundFetchRetry(provider.name);
    if (!currentProvider) {
      return;
    }
    void this.getOfficialModels(currentProvider, false);
  }

  /**
   * Clear state for a provider
   */
  async clearProviderState(providerName: string): Promise<void> {
    if (!this.isLeader()) {
      await mainInstance.runInLeaderWhenAvailable(
        'officialModels.clearProviderState',
        {
          providerName,
        },
      );
      return;
    }

    delete this.state[providerName];
    await this.saveState();
    this.onDidUpdateEmitter.fire(providerName);
    this.broadcastProviderUpdate(providerName);
  }

  private async computeConfigSignature(
    provider: ProviderConfig,
  ): Promise<FetchConfigSignature> {
    const auth = provider.auth;
    const authMethod = auth?.method ?? 'none';
    const authHash = this.computeAuthHash(auth);

    return {
      type: provider.type,
      baseUrl: provider.baseUrl,
      authMethod,
      authHash,
      extraHeadersHash: this.hashString(
        stableStringify(provider.extraHeaders ?? {}),
      ),
      extraBodyHash: this.hashString(stableStringify(provider.extraBody ?? {})),
    };
  }

  /**
   * Simple hash for strings (for API key comparison without storing actual key)
   */
  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return hash.toString(36);
  }

  /**
   * Get the draft session state for a session ID
   */
  getDraftSessionState(
    sessionId: string,
  ): OfficialModelsFetchState | undefined {
    return this.draftSessions.get(sessionId)?.state;
  }

  /**
   * Set a validation/config error for a draft session without attempting a fetch.
   * This can be used by callers to surface draft validation errors.
   */
  setDraftSessionError(sessionId: string, message: string): void {
    const session = this.ensureDraftSession(sessionId);
    session.state.lastError = message;
    session.state.lastErrorTime = Date.now();
    session.state.isFetching = false;
    this.onDidUpdateEmitter.fire(sessionId);
  }

  /**
   * Ensure a draft session exists.
   */
  private ensureDraftSession(sessionId: string): DraftSessionState {
    let session = this.draftSessions.get(sessionId);
    if (!session) {
      session = {
        state: {
          lastFetchTime: 0,
          lastAttemptTime: 0,
          models: [],
          modelsHash: '',
          consecutiveIdenticalFetches: 0,
          currentIntervalMs: FETCH_CONFIG.initialIntervalMs,
          consecutiveErrorFetches: 0,
          currentErrorIntervalMs: FETCH_CONFIG.errorInitialIntervalMs,
        },
        // Placeholder signature; real signature is set when a fetch is triggered.
        configSignature: {
          type: '',
          baseUrl: '',
          authMethod: 'none',
          authHash: '',
          extraHeadersHash: '',
          extraBodyHash: '',
        },
      };
      this.draftSessions.set(sessionId, session);
    }
    return session;
  }

  /**
   * Get official models for a draft session.
   * Automatically detects config changes and triggers refresh when needed.
   */
  async getOfficialModelsForDraft(
    sessionId: string,
    draftInput: OfficialModelsDraftInput,
    options?: { forceFetch?: boolean },
  ): Promise<{
    models: ModelConfig[];
    state: OfficialModelsFetchState | undefined;
  }> {
    const session = this.draftSessions.get(sessionId);
    const draftSignature = this.computeDraftConfigSignature(draftInput);
    const resolved = this.resolveDraftInput(draftInput);

    if (resolved.kind === 'error') {
      const target = session ?? this.ensureDraftSession(sessionId);
      target.configSignature = draftSignature;
      target.state.lastError = resolved.message;
      target.state.lastErrorTime = Date.now();
      target.state.isFetching = false;
      this.onDidUpdateEmitter.fire(sessionId);
      return { models: target.state.models, state: target.state };
    }

    const provider = resolved.provider;
    const currentSignature = await this.computeConfigSignature(provider);

    // Check if config changed since last fetch
    const configChanged =
      session &&
      !this.signaturesEqual(session.configSignature, currentSignature);

    const shouldFetch =
      options?.forceFetch ||
      configChanged ||
      !session ||
      this.shouldFetchByState(session.state);

    if (shouldFetch) {
      await this.fetchForDraft(sessionId, provider, currentSignature);
    }

    const state = this.getDraftSessionState(sessionId);
    return { models: state?.models ?? [], state };
  }

  /**
   * Check if two config signatures are equal
   */
  private signaturesEqual(
    a: FetchConfigSignature,
    b: FetchConfigSignature,
  ): boolean {
    return (
      a.type === b.type &&
      a.baseUrl === b.baseUrl &&
      a.authMethod === b.authMethod &&
      a.authHash === b.authHash &&
      a.extraHeadersHash === b.extraHeadersHash &&
      a.extraBodyHash === b.extraBodyHash
    );
  }

  /**
   * Fetch models for a draft session
   */
  private async fetchForDraft(
    sessionId: string,
    provider: ProviderConfig,
    signature: FetchConfigSignature,
  ): Promise<ModelConfig[]> {
    // If a fetch is already in progress for this session, wait for it
    const inProgress = this.draftFetchInProgress.get(sessionId);
    if (inProgress) {
      return inProgress;
    }

    const fetchPromise = this.doFetchForDraft(sessionId, provider, signature);
    this.draftFetchInProgress.set(sessionId, fetchPromise);

    try {
      return await fetchPromise;
    } finally {
      this.draftFetchInProgress.delete(sessionId);
    }
  }

  /**
   * Actually perform the fetch for a draft session
   */
  private async doFetchForDraft(
    sessionId: string,
    provider: ProviderConfig,
    signature: FetchConfigSignature,
  ): Promise<ModelConfig[]> {
    // Initialize or get existing session state
    const session = this.ensureDraftSession(sessionId);

    const configError = this.getProviderConfigError(provider);
    if (configError) {
      this.recordFailure(session.state, Date.now(), configError);
      session.state.isFetching = false;
      session.configSignature = signature;
      this.onDidUpdateEmitter.fire(sessionId);
      return session.state.models;
    }

    // Set fetching state and notify
    session.state.isFetching = true;
    session.configSignature = signature;
    this.onDidUpdateEmitter.fire(sessionId);

    try {
      const credential = await this.resolveCredentialForDraftProvider(provider);
      if (!credential) {
        this.recordFailure(session.state, Date.now(), AUTH_REQUIRED_MESSAGE);
        session.state.isFetching = false;
        session.configSignature = signature;
        this.onDidUpdateEmitter.fire(sessionId);
        return session.state.models;
      }

      const client = createProvider(provider);

      if (!client.getAvailableModels) {
        throw new Error(
          t('Provider does not support fetching available models'),
        );
      }

      const rawModels = await client.getAvailableModels(credential);
      const models = mergeWithWellKnownModels(rawModels, provider);
      const now = Date.now();

      session.state.models = models;
      session.state.modelsHash = this.hashModels(models);
      this.recordSuccess(session.state, now);
      session.state.isFetching = false;

      this.onDidUpdateEmitter.fire(sessionId);
      return models;
    } catch (error) {
      if (isLeaderUnavailableError(error)) {
        session.state.isFetching = false;
        this.onDidUpdateEmitter.fire(sessionId);
        return session.state.models;
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.recordFailure(session.state, Date.now(), errorMessage);
      session.state.isFetching = false;

      this.onDidUpdateEmitter.fire(sessionId);
      return session.state.models;
    }
  }

  /**
   * Trigger a refresh for a draft session without blocking
   */
  triggerDraftRefresh(
    sessionId: string,
    draftInput: OfficialModelsDraftInput,
  ): void {
    const session = this.draftSessions.get(sessionId);
    const draftSignature = this.computeDraftConfigSignature(draftInput);
    const resolved = this.resolveDraftInput(draftInput);

    if (resolved.kind === 'error') {
      const target = session ?? this.ensureDraftSession(sessionId);
      target.configSignature = draftSignature;
      target.state.lastError = resolved.message;
      target.state.lastErrorTime = Date.now();
      target.state.isFetching = false;
      this.onDidUpdateEmitter.fire(sessionId);
      return;
    }

    const provider = resolved.provider;
    void (async () => {
      const signature = await this.computeConfigSignature(provider);
      await this.fetchForDraft(sessionId, provider, signature);
    })();
  }

  /**
   * Clear a draft session state
   */
  clearDraftSession(sessionId: string): void {
    this.draftSessions.delete(sessionId);
  }

  /**
   * Load persisted provider state into a draft session.
   * Used when editing an existing provider to preserve cached models.
   */
  loadPersistedStateToDraft(
    sessionId: string,
    providerName: string,
    draftInput: OfficialModelsDraftInput,
  ): boolean {
    const persistedState = this.state[providerName];
    if (!persistedState) return false;

    // Don't overwrite existing draft session
    if (this.draftSessions.has(sessionId)) return false;

    this.draftSessions.set(sessionId, {
      state: { ...persistedState },
      configSignature: this.computeDraftConfigSignature(draftInput),
    });
    return true;
  }

  /**
   * Migrate draft session state to persisted provider state when saving
   */
  async migrateDraftToProvider(
    sessionId: string,
    providerName: string,
  ): Promise<void> {
    const session = this.draftSessions.get(sessionId);
    if (!session) return;

    const nextState: OfficialModelsFetchState = {
      ...session.state,
      isFetching: false,
      lastConfigSignature: session.configSignature,
    };

    if (!this.isLeader()) {
      try {
        const response = await mainInstance.runInLeaderWhenAvailable<unknown>(
          'officialModels.applyProviderState',
          {
            providerName,
            state: nextState,
          },
        );
        const result = this.parseApplyProviderStateResponse(
          response,
          'officialModels.applyProviderState',
        );
        this.pendingProviderStateSyncs.delete(providerName);
        this.applyAuthoritativeProviderState(providerName, result.state);
      } catch (error) {
        if (!isLeaderUnavailableError(error)) {
          throw error;
        }
        if (this.isLeader()) {
          await this.commitProviderState(providerName, nextState);
        } else {
          await this.commitLocalProviderStateAndQueueSync(
            providerName,
            nextState,
          );
        }
      }
    } else {
      this.pendingProviderStateSyncs.delete(providerName);
      await this.commitProviderState(providerName, nextState);
    }

    // Clean up draft session
    this.draftSessions.delete(sessionId);
  }

  /**
   * Get all cached official models for providers
   * Only returns models for providers with autoFetchOfficialModels enabled
   */
  async getAllOfficialModels(
    providers: ProviderConfig[],
  ): Promise<Map<string, ModelConfig[]>> {
    const result = new Map<string, ModelConfig[]>();

    const enabledProviders = providers.filter((p) => p.autoFetchOfficialModels);

    await Promise.all(
      enabledProviders.map(async (provider) => {
        const models = await this.getOfficialModels(provider);
        result.set(provider.name, models);
      }),
    );

    return result;
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    if (this.syncRetryTimer) {
      clearTimeout(this.syncRetryTimer);
      this.syncRetryTimer = undefined;
    }
    if (this.providerStateSyncRetryTimer) {
      clearTimeout(this.providerStateSyncRetryTimer);
      this.providerStateSyncRetryTimer = undefined;
    }
    for (const timer of this.backgroundFetchRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.backgroundFetchRetryTimers.clear();
    this.pendingProviderStateSyncs.clear();
    this.onDidUpdateEmitter.dispose();
  }
}

// Singleton instance
export const officialModelsManager = new OfficialModelsManager();
