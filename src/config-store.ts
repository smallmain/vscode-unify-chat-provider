import * as vscode from 'vscode';
import {
  mergePartialFromRecordByKeys,
  MODEL_CONFIG_KEYS,
  PROVIDER_CONFIG_KEYS,
  stableStringify,
  withoutKeys,
} from './config-ops';
import {
  isRawBaseUrlEnabled,
  normalizeBaseUrlInput,
  normalizeRawBaseUrlInput,
  normalizeUseRawBaseUrl,
} from './utils';
import { PROVIDER_KEYS, ProviderType } from './client/definitions';
import { getRenamedProviderType } from './secret/migration';
import { normalizePresetTemplates } from './preset-templates';
import { normalizeConfiguredModelCapabilities } from './model-capabilities';
import {
  normalizeCompletionConfig,
  type CompletionConfigNormalizationResult,
} from './completion/model/configuration';
import {
  ContextCacheConfig,
  ModelConfig,
  ProxyConfig,
  ProviderConfig,
  ProxyType,
  ServiceTier,
} from './types';
import {
  isSessionAuthConfig,
  stripSessionAuthState,
} from './auth/local-auth-state';

export const CONFIG_NAMESPACE = 'unifyChatProvider';
const DEFAULT_BALANCE_REFRESH_INTERVAL_MS = 60_000;
const DEFAULT_BALANCE_THROTTLE_WINDOW_MS = 10_000;
const DEFAULT_BALANCE_STATUS_BAR_ICON = '$(credit-card)';
const DEFAULT_DISPLAY_BALANCE_IN_CONFIGURATION = false;
const DEFAULT_MODEL_DISPLAY_NAME_TEMPLATE = '{modelName}{{ ({providerName})}}';
const DEFAULT_PROVIDER_LIST_NEWEST_FIRST = true;
const MIN_BALANCE_REFRESH_INTERVAL_MS = 1_000;
const MIN_BALANCE_THROTTLE_WINDOW_MS = 0;
const DEFAULT_BALANCE_WARNING_ENABLED = true;
const DEFAULT_BALANCE_WARNING_TIME_THRESHOLD_DAYS = 1;
const DEFAULT_BALANCE_WARNING_AMOUNT_THRESHOLD = 1;
const DEFAULT_BALANCE_WARNING_TOKEN_THRESHOLD_MILLIONS = 1;
const MIN_BALANCE_WARNING_TIME_THRESHOLD_DAYS = 0;
const MIN_BALANCE_WARNING_AMOUNT_THRESHOLD = 0;
const MIN_BALANCE_WARNING_TOKEN_THRESHOLD_MILLIONS = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const OBSERVED_CONFIG_KEYS = [
  'endpoints',
  'verbose',
  'modelDisplayNameTemplate',
  'storeApiKeyInSettings',
  'balanceRefreshIntervalMs',
  'balanceThrottleWindowMs',
  'balanceStatusBarIcon',
  'displayBalanceInConfiguration',
  'balanceWarning.enabled',
  'balanceWarning.timeThresholdDays',
  'balanceWarning.amountThreshold',
  'balanceWarning.tokenThresholdMillions',
  'networkSettings',
  'providerList.newestFirst',
] as const;

/** Extension configuration stored in VS Code application-scoped user settings. */
export interface ExtensionConfiguration {
  endpoints: ProviderConfig[];
  modelDisplayNameTemplate: string;
  storeApiKeyInSettings: boolean;
  balanceRefreshIntervalMs: number;
  balanceThrottleWindowMs: number;
  displayBalanceInConfiguration: boolean;
  balanceWarning: BalanceWarningConfiguration;
  verbose: boolean;
}

export interface BalanceWarningConfiguration {
  enabled: boolean;
  /** Threshold in days (supports decimals). */
  timeThresholdDays: number;
  /** Unitless amount threshold (currency ignored). */
  amountThreshold: number;
  /** Token remaining threshold in millions. */
  tokenThresholdMillions: number;
}

export interface ProviderCompletionPersistenceHints {
  readonly originalName?: string;
  readonly modelSourceIds?: Readonly<Record<string, string>>;
}

/** Manages extension configuration stored in VS Code application-scoped user settings. */
export class ConfigStore {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private configurationSignature: string;
  private _disposable: vscode.Disposable;

  constructor() {
    this.configurationSignature = this.computeConfigurationSignature();
    this._disposable = vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(CONFIG_NAMESPACE)) {
        return;
      }

      const nextSignature = this.computeConfigurationSignature();
      if (nextSignature === this.configurationSignature) {
        return;
      }

      this.configurationSignature = nextSignature;
      this._onDidChange.fire();
    });
  }

  /**
   * Get all configured endpoints
   */
  get endpoints(): ProviderConfig[] {
    const raw = this.readConfiguredUnknown('endpoints');
    const rawEndpoints = Array.isArray(raw) ? raw : [];

    return rawEndpoints
      .map((raw) => this.normalizeProviderConfig(raw))
      .filter((p): p is ProviderConfig => p !== null);
  }

  /**
   * Raw endpoints value from configuration.
   *
   * This is only intended for startup-time migration of legacy config fields.
   */
  get rawEndpoints(): unknown[] {
    const raw = this.readConfiguredUnknown('endpoints');
    return Array.isArray(raw) ? raw : [];
  }

  /**
   * Whether verbose logging is enabled
   */
  get verbose(): boolean {
    const rawVerbose = this.readConfiguredUnknown('verbose');
    return typeof rawVerbose === 'boolean' ? rawVerbose : false;
  }

  get modelDisplayNameTemplate(): string {
    const raw = this.readConfiguredUnknown('modelDisplayNameTemplate');
    return typeof raw === 'string' ? raw : DEFAULT_MODEL_DISPLAY_NAME_TEMPLATE;
  }

  /**
   * Whether to store API keys in settings.json instead of VS Code Secret Storage.
   */
  get storeApiKeyInSettings(): boolean {
    const raw = this.readConfiguredUnknown('storeApiKeyInSettings');
    return typeof raw === 'boolean' ? raw : false;
  }

  /**
   * Whether the Manage Providers panel lists recently added or modified
   * providers first.
   */
  get providerListNewestFirst(): boolean {
    const raw = this.readConfiguredUnknown('providerList.newestFirst');
    return typeof raw === 'boolean' ? raw : DEFAULT_PROVIDER_LIST_NEWEST_FIRST;
  }

  /**
   * Periodic refresh interval for provider balances (milliseconds).
   */
  get balanceRefreshIntervalMs(): number {
    const raw = this.readConfiguredUnknown('balanceRefreshIntervalMs');
    return this.readIntegerAtLeast(
      raw,
      DEFAULT_BALANCE_REFRESH_INTERVAL_MS,
      MIN_BALANCE_REFRESH_INTERVAL_MS,
    );
  }

  /**
   * Throttle window for provider balance refresh (milliseconds).
   */
  get balanceThrottleWindowMs(): number {
    const raw = this.readConfiguredUnknown('balanceThrottleWindowMs');
    return this.readIntegerAtLeast(
      raw,
      DEFAULT_BALANCE_THROTTLE_WINDOW_MS,
      MIN_BALANCE_THROTTLE_WINDOW_MS,
    );
  }

  get balanceStatusBarIcon(): string {
    const raw = this.readConfiguredUnknown('balanceStatusBarIcon');

    return typeof raw === 'string' ? raw : DEFAULT_BALANCE_STATUS_BAR_ICON;
  }

  get displayBalanceInConfiguration(): boolean {
    const raw = this.readConfiguredUnknown('displayBalanceInConfiguration');
    return typeof raw === 'boolean'
      ? raw
      : DEFAULT_DISPLAY_BALANCE_IN_CONFIGURATION;
  }

  get balanceWarningEnabled(): boolean {
    const raw = this.readConfiguredUnknown('balanceWarning.enabled');
    return typeof raw === 'boolean' ? raw : DEFAULT_BALANCE_WARNING_ENABLED;
  }

  get balanceWarningTimeThresholdDays(): number {
    const raw = this.readConfiguredUnknown('balanceWarning.timeThresholdDays');
    return this.readNumberAtLeast(
      raw,
      DEFAULT_BALANCE_WARNING_TIME_THRESHOLD_DAYS,
      MIN_BALANCE_WARNING_TIME_THRESHOLD_DAYS,
    );
  }

  get balanceWarningAmountThreshold(): number {
    const raw = this.readConfiguredUnknown('balanceWarning.amountThreshold');
    return this.readNumberAtLeast(
      raw,
      DEFAULT_BALANCE_WARNING_AMOUNT_THRESHOLD,
      MIN_BALANCE_WARNING_AMOUNT_THRESHOLD,
    );
  }

  get balanceWarningTokenThresholdMillions(): number {
    const raw = this.readConfiguredUnknown('balanceWarning.tokenThresholdMillions');
    return this.readNumberAtLeast(
      raw,
      DEFAULT_BALANCE_WARNING_TOKEN_THRESHOLD_MILLIONS,
      MIN_BALANCE_WARNING_TOKEN_THRESHOLD_MILLIONS,
    );
  }

  get balanceWarning(): BalanceWarningConfiguration {
    return {
      enabled: this.balanceWarningEnabled,
      timeThresholdDays: this.balanceWarningTimeThresholdDays,
      amountThreshold: this.balanceWarningAmountThreshold,
      tokenThresholdMillions: this.balanceWarningTokenThresholdMillions,
    };
  }

  get networkProxy(): ProxyConfig | undefined {
    const raw = this.readConfiguredUnknown('networkSettings');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return undefined;
    }

    return this.normalizeProxyConfig((raw as Record<string, unknown>)['proxy']);
  }

  /**
   * Get the full extension configuration
   */
  get configuration(): ExtensionConfiguration {
    return {
      endpoints: this.endpoints,
      modelDisplayNameTemplate: this.modelDisplayNameTemplate,
      storeApiKeyInSettings: this.storeApiKeyInSettings,
      balanceRefreshIntervalMs: this.balanceRefreshIntervalMs,
      balanceThrottleWindowMs: this.balanceThrottleWindowMs,
      displayBalanceInConfiguration: this.displayBalanceInConfiguration,
      balanceWarning: this.balanceWarning,
      verbose: this.verbose,
    };
  }

  private computeConfigurationSignature(): string {
    const snapshot: Record<string, unknown> = {};
    for (const key of OBSERVED_CONFIG_KEYS) {
      snapshot[key] = this.readConfiguredUnknown(key);
    }
    return JSON.stringify(snapshot);
  }

  private readConfiguredUnknown(key: string): unknown {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    return config.get<unknown>(key);
  }

  private readIntegerAtLeast(
    value: unknown,
    fallback: number,
    min: number,
  ): number {
    return typeof value === 'number' &&
      Number.isInteger(value) &&
      Number.isFinite(value) &&
      value >= min
      ? value
      : fallback;
  }

  private readNumberAtLeast(
    value: unknown,
    fallback: number,
    min: number,
  ): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= min
      ? value
      : fallback;
  }

  /**
   * Normalize raw configuration to ProviderConfig
   */
  private normalizeProviderConfig(raw: unknown): ProviderConfig | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return null;
    }

    const obj = raw as Record<string, unknown>;

    if (typeof obj.name !== 'string' || !obj.name) {
      return null;
    }

    if (typeof obj.baseUrl !== 'string' || !obj.baseUrl) {
      return null;
    }

    const useRawBaseUrl = normalizeUseRawBaseUrl(obj.useRawBaseUrl);
    let baseUrl: string;
    try {
      baseUrl = isRawBaseUrlEnabled({ useRawBaseUrl })
        ? normalizeRawBaseUrlInput(obj.baseUrl)
        : normalizeBaseUrlInput(obj.baseUrl);
    } catch {
      return null;
    }

    const rawModels = Array.isArray(obj.models) ? obj.models : [];
    const models: ModelConfig[] = rawModels
      .map((m: unknown) => this.normalizeModelConfig(m))
      .filter((m): m is ModelConfig => m !== null);

    // Parse and validate type
    const rawType = obj.type;
    if (typeof rawType !== 'string') {
      return null;
    }
    const renamedType = getRenamedProviderType(rawType) ?? rawType;
    if (!PROVIDER_KEYS.includes(renamedType as ProviderType)) {
      return null;
    }
    const type = renamedType as ProviderType;

    const provider: ProviderConfig = {
      type,
      name: obj.name,
      baseUrl,
      models,
    };

    mergePartialFromRecordByKeys(
      provider,
      obj,
      withoutKeys(PROVIDER_CONFIG_KEYS, [
        'type',
        'name',
        'baseUrl',
        'models',
      ] as const),
    );

    provider.useRawBaseUrl = normalizeUseRawBaseUrl(provider.useRawBaseUrl);
    provider.transport = this.normalizeTransportMode(provider.transport);
    provider.serviceTier = this.normalizeServiceTier(provider.serviceTier);
    provider.extraHeaders = this.normalizeStringRecord(provider.extraHeaders);
    provider.extraBody = this.normalizeObjectRecord(provider.extraBody);
    provider.proxy = this.normalizeProxyConfig(provider.proxy);
    provider.contextCache = this.normalizeContextCacheConfig(
      provider.contextCache,
    );
    const completion = normalizeCompletionConfig(obj.completion);
    if (completion.status === 'valid') {
      provider.completion = completion.value;
    } else {
      delete provider.completion;
    }

    const legacyApiKey = obj.apiKey;
    if (
      provider.auth === undefined &&
      typeof legacyApiKey === 'string' &&
      legacyApiKey.trim()
    ) {
      provider.auth = { method: 'api-key', apiKey: legacyApiKey };
    }

    return provider;
  }

  private normalizeTransportMode(
    raw: unknown,
  ): ProviderConfig['transport'] | undefined {
    return raw === 'auto' || raw === 'sse' || raw === 'websocket'
      ? raw
      : undefined;
  }

  private normalizeServiceTier(raw: unknown): ServiceTier | undefined {
    switch (raw) {
      case 'auto':
      case 'standard':
      case 'flex':
      case 'scale':
      case 'priority':
        return raw;
      default:
        return undefined;
    }
  }

  private normalizeProxyType(raw: unknown): ProxyType | undefined {
    return raw === 'vscode' || raw === 'direct' || raw === 'custom'
      ? raw
      : undefined;
  }

  private normalizeProxyUrl(raw: unknown): string | undefined {
    if (typeof raw !== 'string') {
      return undefined;
    }

    const trimmed = raw.trim();
    if (!trimmed) {
      return undefined;
    }

    try {
      const protocol = new URL(trimmed).protocol.toLowerCase();
      return protocol === 'http:' ||
        protocol === 'https:' ||
        protocol === 'socks:' ||
        protocol === 'socks4:' ||
        protocol === 'socks4a:' ||
        protocol === 'socks5:' ||
        protocol === 'socks5h:'
        ? trimmed
        : undefined;
    } catch {
      return undefined;
    }
  }

  private normalizeProxyConfig(raw: unknown): ProxyConfig | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return undefined;
    }

    const record = raw as Record<string, unknown>;
    const out: ProxyConfig = {};

    const type = this.normalizeProxyType(record['type']);
    if (type !== undefined) {
      out.type = type;
    }

    const url = this.normalizeProxyUrl(record['url']);
    if (url !== undefined) {
      out.url = url;
    }

    const authorization = record['authorization'];
    if (typeof authorization === 'string' && authorization.trim()) {
      out.authorization = authorization.trim();
    }

    const strictSSL = record['strictSSL'];
    if (typeof strictSSL === 'boolean') {
      out.strictSSL = strictSSL;
    }

    const noProxy = record['noProxy'];
    if (Array.isArray(noProxy)) {
      const entries = noProxy
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '');
      if (entries.length > 0) {
        out.noProxy = entries;
      }
    }

    return Object.keys(out).length > 0 ? out : undefined;
  }

  private normalizeContextCacheConfig(
    raw: unknown,
  ): ContextCacheConfig | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return undefined;
    }

    const record = raw as Record<string, unknown>;
    const out: ContextCacheConfig = {};

    const typeValue = record['type'];
    if (typeValue === 'only-free' || typeValue === 'allow-paid') {
      out.type = typeValue;
    }

    const ttlValue = record['ttl'];
    if (
      typeof ttlValue === 'number' &&
      Number.isFinite(ttlValue) &&
      Number.isInteger(ttlValue) &&
      ttlValue > 0
    ) {
      out.ttl = ttlValue;
    }

    if (out.type === undefined && out.ttl === undefined) {
      return undefined;
    }

    return out;
  }

  private normalizeObjectRecord(
    raw: unknown,
  ): Record<string, unknown> | undefined {
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  }

  private normalizeStringRecord(
    raw: unknown,
  ): Record<string, string> | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return undefined;
    }
    const record = raw as Record<string, unknown>;
    const out: Record<string, string> = {};

    for (const [key, value] of Object.entries(record)) {
      if (typeof value !== 'string') {
        return undefined;
      }
      out[key] = value;
    }

    return out;
  }

  /**
   * Normalize model configuration (supports both string and object format)
   */
  private normalizeModelConfig(raw: unknown): ModelConfig | null {
    if (typeof raw === 'string' && raw) {
      return { id: raw };
    }

    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>;
      if (typeof obj.id === 'string' && obj.id) {
        const model: ModelConfig = { id: obj.id };

        mergePartialFromRecordByKeys(
          model,
          obj,
          withoutKeys(MODEL_CONFIG_KEYS, ['id'] as const),
        );

        model.capabilities = normalizeConfiguredModelCapabilities(
          model.capabilities,
        );
        model.serviceTier = this.normalizeServiceTier(model.serviceTier);
        model.extraHeaders = this.normalizeStringRecord(model.extraHeaders);
        model.extraBody = this.normalizeObjectRecord(model.extraBody);
        model.presetTemplates = normalizePresetTemplates(model.presetTemplates);
        const completion = normalizeCompletionConfig(obj.completion);
        if (completion.status === 'valid') {
          model.completion = completion.value;
        } else {
          delete model.completion;
        }

        return model;
      }
    }

    return null;
  }

  /**
   * Get a specific provider by name
   */
  getProvider(name: string): ProviderConfig | undefined {
    return this.endpoints.find((p) => p.name === name);
  }

  getProviderCompletionConfigState(
    name: string,
  ): CompletionConfigNormalizationResult {
    const provider = this.rawEndpoints.find(
      (candidate) => isRecord(candidate) && candidate.name === name,
    );
    return normalizeCompletionConfig(
      isRecord(provider) ? provider.completion : undefined,
    );
  }

  getModelCompletionConfigState(
    providerName: string,
    modelId: string,
  ): CompletionConfigNormalizationResult {
    const provider = this.rawEndpoints.find(
      (candidate) => isRecord(candidate) && candidate.name === providerName,
    );
    const models = isRecord(provider) && Array.isArray(provider.models)
      ? provider.models
      : [];
    const model = models.find(
      (candidate) =>
        isRecord(candidate) && candidate.id === modelId,
    );
    return normalizeCompletionConfig(
      isRecord(model) ? model.completion : undefined,
    );
  }

  /**
   * Save endpoints to configuration
   * Always writes to application-scoped user settings.
   */
  async setEndpoints(
    endpoints: ProviderConfig[],
    completionHints?: ReadonlyMap<string, ProviderCompletionPersistenceHints>,
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    await config.update(
      'endpoints',
      this.prepareEndpointsForPersistence(endpoints, completionHints),
      vscode.ConfigurationTarget.Global,
    );
  }

  private prepareEndpointsForPersistence(
    endpoints: readonly ProviderConfig[],
    completionHints?: ReadonlyMap<string, ProviderCompletionPersistenceHints>,
    current: readonly unknown[] = this.rawEndpoints,
  ): unknown[] {
    const staticEndpoints = endpoints.map((provider) =>
      provider.auth && isSessionAuthConfig(provider.auth)
        ? { ...provider, auth: stripSessionAuthState(provider.auth) }
        : provider,
    );
    return this.preserveUnspecifiedCompletionConfigs(
      staticEndpoints,
      completionHints,
      current,
    );
  }

  private preserveUnspecifiedCompletionConfigs(
    endpoints: readonly ProviderConfig[],
    completionHints?: ReadonlyMap<string, ProviderCompletionPersistenceHints>,
    current: readonly unknown[] = this.rawEndpoints,
  ): unknown[] {
    // Normalized endpoints omit invalid completion values. Treat omission as
    // unchanged; callers can use {} to reset or { templates: [] } to disable.
    return endpoints.map((provider) => {
      const hints = completionHints?.get(provider.name);
      const sourceProviderName = hints?.originalName ?? provider.name;
      const explicitlyConsumedModelIds = new Set(
        Object.values(hints?.modelSourceIds ?? {}),
      );
      const previous = current.find(
        (candidate) =>
          isRecord(candidate) && candidate.name === sourceProviderName,
      );
      const persisted: Record<string, unknown> = { ...provider };
      if (
        !Object.hasOwn(provider, 'completion') &&
        isRecord(previous) &&
        Object.hasOwn(previous, 'completion')
      ) {
        persisted.completion = previous.completion;
      }

      persisted.models = provider.models.map((model) => {
        const hasExplicitSource =
          hints?.modelSourceIds !== undefined &&
          Object.hasOwn(hints.modelSourceIds, model.id);
        const sourceModelId = hasExplicitSource
          ? hints.modelSourceIds?.[model.id]
          : explicitlyConsumedModelIds.has(model.id)
            ? undefined
            : model.id;
        const previousModel =
          sourceModelId !== undefined &&
          isRecord(previous) &&
          Array.isArray(previous.models)
            ? previous.models.find(
                (candidate) =>
                  isRecord(candidate) && candidate.id === sourceModelId,
              )
            : undefined;
        if (
          Object.hasOwn(model, 'completion') ||
          !isRecord(previousModel) ||
          !Object.hasOwn(previousModel, 'completion')
        ) {
          return model;
        }
        return { ...model, completion: previousModel.completion };
      });
      return persisted;
    });
  }

  /**
   * Set whether the Manage Providers panel lists recently added or modified
   * providers first.
   * Always writes to application-scoped user settings.
   */
  async setProviderListNewestFirst(value: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    await config.update(
      'providerList.newestFirst',
      value,
      vscode.ConfigurationTarget.Global,
    );
  }

  /**
   * Save raw endpoints to configuration (used by startup migration).
   */
  async setRawEndpoints(endpoints: unknown[]): Promise<void> {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    await config.update(
      'endpoints',
      endpoints,
      vscode.ConfigurationTarget.Global,
    );
  }

  /**
   * Save startup-migrated endpoints only while the source snapshot is current.
   */
  async setRawEndpointsIfUnchanged(
    expectedSignature: string,
    endpoints: unknown[],
  ): Promise<boolean> {
    if (stableStringify(this.rawEndpoints) !== expectedSignature) return false;

    const intendedSignature = stableStringify(endpoints);
    let currentWriteSignature = intendedSignature;
    let concurrentEndpoints: unknown[] | undefined;
    let observedConcurrentWrite = false;
    const subscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(`${CONFIG_NAMESPACE}.endpoints`)) return;
      const observed = this.rawEndpoints;
      const observedSignature = stableStringify(observed);
      if (
        observedSignature !== currentWriteSignature &&
        observedSignature !== expectedSignature
      ) {
        concurrentEndpoints = observed;
        observedConcurrentWrite = true;
      }
    });

    try {
      await this.setRawEndpoints(endpoints);

      // A Settings Sync update can land after the comparison but before our
      // write. Restore the latest observed snapshot so the migration can retry
      // against it instead of silently replacing it.
      while (concurrentEndpoints) {
        const restore = concurrentEndpoints;
        concurrentEndpoints = undefined;
        currentWriteSignature = stableStringify(restore);
        await this.setRawEndpoints(restore);
      }
      if (observedConcurrentWrite) return false;
      return stableStringify(this.rawEndpoints) === intendedSignature;
    } finally {
      subscription.dispose();
    }
  }

  /**
   * Add or update a provider
   */
  async upsertProvider(
    provider: ProviderConfig,
    hints: ProviderCompletionPersistenceHints = {},
  ): Promise<void> {
    const endpoints = this.endpoints.filter(
      (candidate) =>
        candidate.name !== provider.name &&
        candidate.name !== hints.originalName,
    );
    endpoints.push(provider);
    await this.setEndpoints(
      endpoints,
      new Map([[provider.name, hints]]),
    );
  }

  async upsertProviderIfUnchanged(
    provider: ProviderConfig,
    hints: ProviderCompletionPersistenceHints,
    isSourceCurrent: () => boolean,
  ): Promise<boolean> {
    if (!isSourceCurrent()) return false;
    const currentRaw = this.rawEndpoints;
    const expectedSignature = stableStringify(currentRaw);
    const endpoints = this.endpoints.filter(
      (candidate) =>
        candidate.name !== provider.name &&
        candidate.name !== hints.originalName,
    );
    endpoints.push(provider);
    const intended = this.prepareEndpointsForPersistence(
      endpoints,
      new Map([[provider.name, hints]]),
      currentRaw,
    );
    if (!isSourceCurrent()) return false;
    return await this.setRawEndpointsIfUnchanged(
      expectedSignature,
      intended,
    );
  }

  /**
   * Remove a provider by name
   */
  async removeProvider(name: string): Promise<void> {
    const endpoints = this.endpoints.filter((p) => p.name !== name);
    await this.setEndpoints(endpoints);
  }

  dispose(): void {
    this._disposable.dispose();
    this._onDidChange.dispose();
  }
}
