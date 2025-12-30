import * as vscode from 'vscode';
import { ModelConfig, ProviderConfig } from './types';
import { createProvider } from './client/utils';
import { mergeWithWellKnownModels } from './well-known/models';
import { stableStringify } from './config-ops';
import { ApiKeySecretStore } from './api-key-secret-store';
import { normalizeBaseUrlInput } from './utils';
import { t } from './i18n';

/**
 * State for a single provider's official models fetch
 */
export interface OfficialModelsFetchState {
  /** Last successful fetch timestamp (ms) */
  lastFetchTime: number;
  /** Last successfully fetched models */
  models: ModelConfig[];
  /** Hash of the last fetched models for comparison */
  modelsHash: string;
  /** Number of consecutive identical fetches */
  consecutiveIdenticalFetches: number;
  /** Current fetch interval in milliseconds */
  currentIntervalMs: number;
  /** Last error message if the last fetch failed */
  lastError?: string;
  /** Timestamp of last error */
  lastErrorTime?: number;
  /** Whether a fetch is currently in progress */
  isFetching?: boolean;
}

/**
 * Configuration signature for detecting changes that require a refresh
 */
export interface FetchConfigSignature {
  type: string;
  baseUrl: string;
  apiKeyHash: string;
}

/**
 * Draft input for fetching official models.
 * This can be incomplete and is validated inside the manager.
 */
export interface OfficialModelsDraftInput {
  type?: ProviderConfig['type'];
  name?: string;
  baseUrl?: string;
  apiKey?: string;
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
};

const STATE_KEY = 'officialModelsState';

/**
 * Manager for fetching and caching official models from providers
 */
export class OfficialModelsManager {
  private state: PersistedState = {};
  private extensionContext?: vscode.ExtensionContext;
  private apiKeyStore!: ApiKeySecretStore;
  private fetchInProgress = new Map<string, Promise<ModelConfig[]>>();
  private readonly onDidUpdateEmitter = new vscode.EventEmitter<string>();

  /** Draft session states (in-memory only, keyed by session ID) */
  private draftSessions = new Map<string, DraftSessionState>();
  /** Fetch in progress for draft sessions */
  private draftFetchInProgress = new Map<string, Promise<ModelConfig[]>>();

  /** Fired when a provider's or draft session's official models are updated */
  readonly onDidUpdate = this.onDidUpdateEmitter.event;

  /**
   * Initialize the manager with VS Code extension context
   */
  async initialize(
    context: vscode.ExtensionContext,
    apiKeyStore: ApiKeySecretStore,
  ): Promise<void> {
    this.extensionContext = context;
    this.apiKeyStore = apiKeyStore;
    await this.loadState();
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
    if (!this.extensionContext) return;
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

    const timeSinceLastFetch = Date.now() - state.lastFetchTime;
    return timeSinceLastFetch >= state.currentIntervalMs;
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

    // If a fetch is already in progress for this provider, wait for it
    const inProgress = this.fetchInProgress.get(providerName);
    if (inProgress) {
      return inProgress;
    }

    // Return cached models if not time to fetch yet
    if (!forceFetch && !this.shouldFetch(providerName)) {
      const state = this.state[providerName];
      if (state) {
        return state.models;
      }
    }

    // Start a new fetch
    const fetchPromise = this.doFetch(provider);
    this.fetchInProgress.set(providerName, fetchPromise);

    try {
      return await fetchPromise;
    } finally {
      this.fetchInProgress.delete(providerName);
    }
  }

  /**
   * Actually perform the fetch
   */
  private async doFetch(provider: ProviderConfig): Promise<ModelConfig[]> {
    const providerName = provider.name;

    const configError = this.getProviderConfigError(provider);
    if (configError) {
      const state = this.ensureState(providerName);
      state.lastError = configError;
      state.lastErrorTime = Date.now();
      state.isFetching = false;
      await this.saveState();
      this.onDidUpdateEmitter.fire(providerName);
      return state.models;
    }

    // Set fetching state and notify
    this.ensureState(providerName).isFetching = true;
    this.onDidUpdateEmitter.fire(providerName);

    try {
      const resolvedProvider = await this.resolveProvider(provider);
      const client = createProvider(resolvedProvider);

      if (!client.getAvailableModels) {
        throw new Error(t('Provider does not support fetching available models'));
      }

      const rawModels = await client.getAvailableModels();
      const models = mergeWithWellKnownModels(rawModels);
      const modelsHash = this.hashModels(models);

      const existingState = this.state[providerName];
      const isIdentical = existingState?.modelsHash === modelsHash;

      // Update or create state
      if (existingState) {
        existingState.lastFetchTime = Date.now();
        existingState.models = models;
        existingState.modelsHash = modelsHash;
        existingState.lastError = undefined;
        existingState.lastErrorTime = undefined;
        existingState.isFetching = false;
        this.updateInterval(existingState, isIdentical);
      } else {
        this.state[providerName] = {
          lastFetchTime: Date.now(),
          models,
          modelsHash,
          consecutiveIdenticalFetches: 0,
          currentIntervalMs: FETCH_CONFIG.initialIntervalMs,
          isFetching: false,
        };
      }

      await this.saveState();
      this.onDidUpdateEmitter.fire(providerName);

      return models;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Update error state but keep last successful models
      const existingState = this.state[providerName];
      if (existingState) {
        existingState.lastError = errorMessage;
        existingState.lastErrorTime = Date.now();
        existingState.isFetching = false;
        await this.saveState();
        this.onDidUpdateEmitter.fire(providerName);
        // Return last successful models on error
        return existingState.models;
      }

      // No previous state, create error state with empty models
      this.state[providerName] = {
        lastFetchTime: 0,
        models: [],
        modelsHash: '',
        consecutiveIdenticalFetches: 0,
        currentIntervalMs: FETCH_CONFIG.initialIntervalMs,
        lastError: errorMessage,
        lastErrorTime: Date.now(),
        isFetching: false,
      };
      await this.saveState();
      this.onDidUpdateEmitter.fire(providerName);

      return [];
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

  private computeDraftConfigSignature(
    input: OfficialModelsDraftInput,
  ): FetchConfigSignature {
    return {
      type: input.type ?? '',
      baseUrl: this.normalizeDraftBaseUrlForSignature(input.baseUrl),
      apiKeyHash: this.hashString(input.apiKey?.trim() ?? ''),
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
        message:
          t('Cannot fetch official models: provider configuration is incomplete.'),
      };
    }

    let baseUrl: string;
    try {
      baseUrl = normalizeBaseUrlInput(baseUrlRaw);
    } catch {
      return {
        kind: 'error',
        message:
          t('Cannot fetch official models: please enter a valid API base URL.'),
      };
    }

    const provider: ProviderConfig = {
      type,
      name,
      baseUrl,
      apiKey: input.apiKey?.trim() || undefined,
      models: [],
      extraHeaders: input.extraHeaders,
      extraBody: input.extraBody,
      timeout: input.timeout,
    };

    return { kind: 'ok', provider };
  }

  private async resolveProvider(
    provider: ProviderConfig,
  ): Promise<ProviderConfig> {
    const status = await this.apiKeyStore.getStatus(provider.apiKey);

    if (status.kind === 'unset' || status.kind === 'plain') {
      return provider;
    }

    if (status.kind === 'secret') {
      return { ...provider, apiKey: status.apiKey };
    }

    throw new Error(
      t(
        'API key for provider "{0}" is missing. Please re-enter it and try again.',
        provider.name,
      ),
    );
  }

  /**
   * Ensure a state exists for the provider
   */
  private ensureState(providerName: string): OfficialModelsFetchState {
    if (!this.state[providerName]) {
      this.state[providerName] = {
        lastFetchTime: 0,
        models: [],
        modelsHash: '',
        consecutiveIdenticalFetches: 0,
        currentIntervalMs: FETCH_CONFIG.initialIntervalMs,
      };
    }
    return this.state[providerName];
  }

  /**
   * Force refresh official models for all providers with autoFetchOfficialModels enabled
   */
  async refreshAll(providers: ProviderConfig[]): Promise<void> {
    const enabledProviders = providers.filter((p) => p.autoFetchOfficialModels);

    await Promise.all(
      enabledProviders.map((provider) =>
        this.getOfficialModels(provider, true),
      ),
    );
  }

  /**
   * Force refresh official models for a specific provider
   */
  async refresh(provider: ProviderConfig): Promise<ModelConfig[]> {
    return this.getOfficialModels(provider, true);
  }

  /**
   * Clear state for a provider
   */
  async clearProviderState(providerName: string): Promise<void> {
    delete this.state[providerName];
    await this.saveState();
  }

  /**
   * Compute a configuration signature for change detection
   */
  computeConfigSignature(provider: ProviderConfig): FetchConfigSignature {
    return {
      type: provider.type,
      baseUrl: provider.baseUrl,
      apiKeyHash: this.hashString(provider.apiKey ?? ''),
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
          models: [],
          modelsHash: '',
          consecutiveIdenticalFetches: 0,
          currentIntervalMs: FETCH_CONFIG.initialIntervalMs,
        },
        // Placeholder signature; real signature is set when a fetch is triggered.
        configSignature: { type: '', baseUrl: '', apiKeyHash: '' },
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
    const currentSignature = this.computeConfigSignature(provider);

    // Check if config changed since last fetch
    const configChanged =
      session &&
      !this.signaturesEqual(session.configSignature, currentSignature);

    const forceFetch =
      options?.forceFetch || configChanged || !!session?.state.lastError;

    if (forceFetch || !session) {
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
      a.apiKeyHash === b.apiKeyHash
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
      session.state.lastError = configError;
      session.state.lastErrorTime = Date.now();
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
      const resolvedProvider = await this.resolveProvider(provider);
      const client = createProvider(resolvedProvider);

      if (!client.getAvailableModels) {
        throw new Error(t('Provider does not support fetching available models'));
      }

      const rawModels = await client.getAvailableModels();
      const models = mergeWithWellKnownModels(rawModels);

      session.state.lastFetchTime = Date.now();
      session.state.models = models;
      session.state.modelsHash = this.hashModels(models);
      session.state.lastError = undefined;
      session.state.lastErrorTime = undefined;
      session.state.isFetching = false;

      this.onDidUpdateEmitter.fire(sessionId);
      return models;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      session.state.lastError = errorMessage;
      session.state.lastErrorTime = Date.now();
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
    const signature = this.computeConfigSignature(provider);
    this.fetchForDraft(sessionId, provider, signature);
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

    // Copy draft state to persisted state
    this.state[providerName] = { ...session.state };
    await this.saveState();

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
    this.onDidUpdateEmitter.dispose();
  }
}

// Singleton instance
export const officialModelsManager = new OfficialModelsManager();
