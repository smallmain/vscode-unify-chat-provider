import * as vscode from 'vscode';
import { t } from '../../i18n';
import { createSimpleHttpLogger } from '../../logger';
import { getToken } from '../../client/utils';
import { fetchWithRetry, normalizeBaseUrlInput } from '../../utils';
import { createSecretRef, isSecretRef, type SecretStore } from '../../secret';
import { pickQuickItem, showInput } from '../../ui/component';
import type {
  BalanceConfig,
  BalanceProviderState,
  BalanceRefreshInput,
  BalanceRefreshResult,
  BalanceStatusViewItem,
  BalanceUiStatusSnapshot,
} from '../types';
import { isNewAPIBalanceConfig } from '../types';
import type {
  BalanceConfigureResult,
  BalanceProvider,
  BalanceProviderContext,
  BalanceProviderDefinition,
} from '../balance-provider';

type NewApiMode = 'api-key-only' | 'with-user';

type NewApiModePickItem = vscode.QuickPickItem & {
  modeValue?: NewApiMode;
};

type ParsedBalance = {
  summary: string;
  details: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pickBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function pickNumberLike(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function formatNumber(value: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatSigned(value: number): string {
  return value < 0 ? `-${formatNumber(Math.abs(value))}` : formatNumber(value);
}

function extractPayload(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const wrapped = value['data'];
  if (isRecord(wrapped)) {
    return wrapped;
  }
  return value;
}

function toMessage(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const message = value['message'];
  return typeof message === 'string' && message.trim()
    ? message.trim()
    : undefined;
}

function isSuccessfulCode(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value === 0;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) {
      return undefined;
    }
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return numeric === 0;
    }
    if (trimmed === 'true' || trimmed === 'ok' || trimmed === '0') {
      return true;
    }
    if (trimmed === 'false') {
      return false;
    }
  }

  return undefined;
}

function parseEnvelope(value: unknown): {
  payload: Record<string, unknown> | undefined;
  message: string | undefined;
  success: boolean | undefined;
} {
  const payload = extractPayload(value);
  const message = toMessage(value);

  if (!isRecord(value)) {
    return { payload, message, success: undefined };
  }

  const success = isSuccessfulCode(value['code']);
  return { payload, message, success };
}

export class NewAPIBalanceProvider implements BalanceProvider {
  static supportsSensitiveDataInSettings(_config: BalanceConfig): boolean {
    return true;
  }

  static redactForExport(config: BalanceConfig): BalanceConfig {
    if (!isNewAPIBalanceConfig(config)) {
      return { method: 'newapi' };
    }
    return {
      ...config,
      systemToken: undefined,
    };
  }

  static async resolveForExport(
    config: BalanceConfig,
    secretStore: SecretStore,
  ): Promise<BalanceConfig> {
    if (!isNewAPIBalanceConfig(config)) {
      return { method: 'newapi' };
    }

    const status = await secretStore.getApiKeyStatus(config.systemToken);
    if (status.kind === 'unset') {
      return { ...config, systemToken: undefined };
    }
    if (status.kind === 'plain' || status.kind === 'secret') {
      return { ...config, systemToken: status.apiKey };
    }

    throw new Error('Missing system token secret');
  }

  static async normalizeOnImport(
    config: BalanceConfig,
    options: {
      secretStore: SecretStore;
      storeSecretsInSettings: boolean;
      existing?: BalanceConfig;
    },
  ): Promise<BalanceConfig> {
    if (!isNewAPIBalanceConfig(config)) {
      return { method: 'newapi' };
    }

    const status = await options.secretStore.getApiKeyStatus(
      config.systemToken,
    );

    if (options.storeSecretsInSettings) {
      if (status.kind === 'unset') {
        return { ...config, systemToken: undefined };
      }
      if (status.kind === 'plain' || status.kind === 'secret') {
        return { ...config, systemToken: status.apiKey };
      }
      return { ...config, systemToken: status.ref };
    }

    if (status.kind === 'unset') {
      return { ...config, systemToken: undefined };
    }

    if (status.kind === 'plain') {
      const existingConfig = options.existing;
      const existingToken =
        existingConfig && isNewAPIBalanceConfig(existingConfig)
          ? existingConfig.systemToken
          : undefined;

      const existingRef =
        existingToken && isSecretRef(existingToken) ? existingToken : undefined;

      const ref = existingRef ?? createSecretRef();
      await options.secretStore.setApiKey(ref, status.apiKey);
      return { ...config, systemToken: ref };
    }

    return { ...config, systemToken: status.ref };
  }

  static async prepareForDuplicate(
    config: BalanceConfig,
    options: { secretStore: SecretStore; storeSecretsInSettings: boolean },
  ): Promise<BalanceConfig> {
    if (!isNewAPIBalanceConfig(config)) {
      return { method: 'newapi' };
    }

    const status = await options.secretStore.getApiKeyStatus(
      config.systemToken,
    );
    if (status.kind === 'unset') {
      return { ...config, systemToken: undefined };
    }

    if (status.kind === 'missing-secret') {
      throw new Error('Missing system token secret');
    }

    const systemToken = status.apiKey;

    if (options.storeSecretsInSettings) {
      return { ...config, systemToken };
    }

    const ref = createSecretRef();
    await options.secretStore.setApiKey(ref, systemToken);
    return { ...config, systemToken: ref };
  }

  static async cleanupOnDiscard(
    config: BalanceConfig,
    secretStore: SecretStore,
  ): Promise<void> {
    if (!isNewAPIBalanceConfig(config)) {
      return;
    }
    const token = config.systemToken;
    if (token && isSecretRef(token)) {
      await secretStore.deleteApiKey(token);
    }
  }

  get definition(): BalanceProviderDefinition {
    return {
      id: 'newapi',
      label: t('New API Balance'),
      description: t('Monitor API key and optional user balance for New API'),
    };
  }

  private config: BalanceConfig;

  constructor(
    private readonly context: BalanceProviderContext,
    config?: BalanceConfig,
  ) {
    this.config = isNewAPIBalanceConfig(config) ? config : { method: 'newapi' };
  }

  getConfig(): BalanceConfig | undefined {
    return this.config;
  }

  async getFieldDetail(
    state: BalanceProviderState | undefined,
  ): Promise<string | undefined> {
    if (state?.snapshot?.summary) {
      return state.snapshot.summary;
    }
    if (state?.lastError) {
      return t('Error: {0}', state.lastError);
    }

    if (isNewAPIBalanceConfig(this.config) && this.config.userId?.trim()) {
      return t('Configured (API key + user balance)');
    }

    return t('Configured (API key balance only)');
  }

  async getStatusSnapshot(
    state: BalanceProviderState | undefined,
  ): Promise<BalanceUiStatusSnapshot> {
    if (state?.isRefreshing) {
      return { kind: 'loading' };
    }
    if (state?.lastError) {
      return { kind: 'error', message: state.lastError };
    }
    if (state?.snapshot) {
      return {
        kind: 'valid',
        updatedAt: state.snapshot.updatedAt,
        summary: state.snapshot.summary,
      };
    }
    return { kind: 'not-configured' };
  }

  async getStatusViewItems(options: {
    state: BalanceProviderState | undefined;
    refresh: () => Promise<void>;
  }): Promise<BalanceStatusViewItem[]> {
    const state = options.state;
    const snapshot = state?.snapshot;
    const hasUserConfig =
      isNewAPIBalanceConfig(this.config) &&
      !!this.config.userId?.trim() &&
      !!this.config.systemToken?.trim();

    const items: BalanceStatusViewItem[] = [
      {
        label: `$(pulse) ${this.definition.label}`,
        description: state?.isRefreshing
          ? t('Refreshing...')
          : snapshot
            ? t(
                'Last updated: {0}',
                new Date(snapshot.updatedAt).toLocaleTimeString(),
              )
            : state?.lastError
              ? t('Error')
              : t('No data'),
        detail:
          snapshot?.details.join(' | ') ||
          state?.lastError ||
          t('Not refreshed yet'),
      },
      {
        label: `$(account) ${t('User balance')}`,
        description: hasUserConfig
          ? t('Enabled')
          : t('Disabled (API key balance only)'),
      },
      {
        label: `$(refresh) ${t('Refresh now')}`,
        description: t('Fetch latest balance info'),
        action: {
          kind: 'inline',
          run: async () => {
            await options.refresh();
          },
        },
      },
    ];

    return items;
  }

  async configure(): Promise<BalanceConfigureResult> {
    const selected = await pickQuickItem<NewApiModePickItem>({
      title: t('New API Balance Configuration'),
      placeholder: t('Select monitoring scope'),
      ignoreFocusOut: true,
      items: [
        {
          label: t('API key balance only'),
          description: t('No extra configuration required'),
          modeValue: 'api-key-only',
          picked: !isNewAPIBalanceConfig(this.config) || !this.config.userId,
        },
        {
          label: t('API key + user balance'),
          description: t('Requires User ID and System Token'),
          modeValue: 'with-user',
          picked: !!(
            isNewAPIBalanceConfig(this.config) &&
            this.config.userId &&
            this.config.systemToken
          ),
        },
      ],
    });

    const mode = selected?.modeValue;
    if (!mode) {
      return { success: false };
    }

    if (mode === 'api-key-only') {
      await this.cleanupExistingSystemTokenRef();
      const next: BalanceConfig = { method: 'newapi' };
      this.config = next;
      await this.context.persistBalanceConfig?.(next);
      return { success: true, config: next };
    }

    const current = isNewAPIBalanceConfig(this.config)
      ? this.config
      : undefined;

    const userId = await showInput({
      title: t('User ID ({0})', this.context.providerLabel),
      prompt: t('Enter New API user ID (for account balance query)'),
      ignoreFocusOut: true,
      value: current?.userId,
      placeHolder: t('e.g., 5848'),
      validateInput: (value) =>
        value.trim() ? null : t('User ID is required'),
    });

    if (userId === undefined) {
      return { success: false };
    }

    const currentSystemToken = await this.resolveSystemTokenValue();
    const systemToken = await showInput({
      title: t('System Token ({0})', this.context.providerLabel),
      prompt: t('Enter system token (from personal center)'),
      ignoreFocusOut: true,
      value: currentSystemToken,
      password: true,
      placeHolder: t('System token'),
      validateInput: (value) =>
        value.trim() ? null : t('System token is required'),
    });

    if (systemToken === undefined) {
      return { success: false };
    }

    const trimmedUserId = userId.trim();
    const trimmedSystemToken = systemToken.trim();

    if (!trimmedUserId || !trimmedSystemToken) {
      vscode.window.showErrorMessage(
        t('User ID and system token are required.'),
      );
      return { success: false };
    }

    const persistedSystemToken = await this.persistSystemToken(
      trimmedSystemToken,
      current?.systemToken,
    );

    const next: BalanceConfig = {
      method: 'newapi',
      userId: trimmedUserId,
      systemToken: persistedSystemToken,
    };

    this.config = next;
    await this.context.persistBalanceConfig?.(next);
    return { success: true, config: next };
  }

  async refresh(input: BalanceRefreshInput): Promise<BalanceRefreshResult> {
    const apiKey = getToken(input.credential);
    if (!apiKey) {
      return {
        success: false,
        error: t('API key is required to query New API balance.'),
      };
    }

    const normalizedBaseUrl = normalizeBaseUrlInput(input.provider.baseUrl);
    const logger = createSimpleHttpLogger({
      purpose: 'Balance refresh',
      providerName: input.provider.name,
      providerType: input.provider.type,
    });

    try {
      const keyBalance = await this.fetchApiKeyBalance(
        normalizedBaseUrl,
        apiKey,
        logger,
      );

      let userSummary: string | undefined;
      const userDetails: string[] = [];

      const config = isNewAPIBalanceConfig(this.config)
        ? this.config
        : undefined;
      if (config?.userId?.trim() && config.systemToken?.trim()) {
        const systemToken = await this.resolveSystemTokenValue();

        if (!systemToken) {
          userDetails.push(t('Balance: missing system token secret.'));
        } else {
          try {
            const userBalance = await this.fetchUserBalance(
              normalizedBaseUrl,
              config.userId.trim(),
              systemToken,
              logger,
            );

            if (userBalance.summary) {
              userSummary = userBalance.summary;
            }
            userDetails.push(...userBalance.details);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            userSummary = t('Balance: error');
            userDetails.push(t('Balance error: {0}', message));
          }
        }
      }

      const summaryParts: string[] = [];
      if (userSummary) {
        summaryParts.push(userSummary);
      }
      if (keyBalance.summary) {
        summaryParts.push(keyBalance.summary);
      }

      const details: string[] = [...userDetails, ...keyBalance.details];

      if (summaryParts.length === 0) {
        summaryParts.push(t('No data'));
      }

      if (details.length === 0) {
        details.push(t('No data'));
      }

      return {
        success: true,
        snapshot: {
          summary: summaryParts.join(' | '),
          details,
          updatedAt: Date.now(),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async fetchApiKeyBalance(
    baseUrl: string,
    apiKey: string,
    logger: ReturnType<typeof createSimpleHttpLogger>,
  ): Promise<ParsedBalance> {
    const endpoint = new URL('/api/usage/token', `${baseUrl}/`).toString();

    const response = await fetchWithRetry(endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      logger,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        text.trim() ||
          t(
            'Failed to query API key balance (HTTP {0}).',
            `${response.status}`,
          ),
      );
    }

    const json: unknown = await response.json().catch(() => undefined);
    const envelope = parseEnvelope(json);
    if (envelope.success === false) {
      throw new Error(
        envelope.message ?? t('Unexpected API key balance response.'),
      );
    }

    const payload = envelope.payload;

    if (!payload) {
      throw new Error(t('Unexpected API key balance response.'));
    }

    const unlimited =
      pickBoolean(payload, 'unlimited_quota') ??
      pickBoolean(payload, 'unlimitedQuota') ??
      false;

    const totalAvailable =
      pickNumberLike(payload, 'total_available') ??
      pickNumberLike(payload, 'available') ??
      pickNumberLike(payload, 'balance');

    if (unlimited) {
      return {
        summary: '',
        details: [],
      };
    }

    let summary = t('API Key balance: unavailable');
    if (totalAvailable !== undefined) {
      summary = t('API Key balance: {0}', '$' + formatSigned(totalAvailable));
    }

    const details = [summary];
    return { summary, details };
  }

  private async fetchUserBalance(
    baseUrl: string,
    userId: string,
    systemToken: string,
    logger: ReturnType<typeof createSimpleHttpLogger>,
  ): Promise<ParsedBalance> {
    const endpoint = new URL('/api/user/self', `${baseUrl}/`).toString();

    const response = await fetchWithRetry(endpoint, {
      method: 'GET',
      headers: {
        'New-Api-User': userId,
        Authorization: `Bearer ${systemToken}`,
        Accept: 'application/json',
      },
      logger,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        text.trim() ||
          t('Failed to query user balance (HTTP {0}).', `${response.status}`),
      );
    }

    const json: unknown = await response.json().catch(() => undefined);
    const envelope = parseEnvelope(json);
    if (envelope.success === false) {
      throw new Error(
        envelope.message ?? t('Unexpected user balance response.'),
      );
    }

    const payload = envelope.payload;
    if (!payload) {
      throw new Error(t('Unexpected user balance response.'));
    }

    // New API docs note: actual balance = quota / 500000
    const quota = pickNumberLike(payload, 'quota');
    let summary = t('Balance: unavailable');

    if (quota !== undefined) {
      const actualQuota = quota / 500000;
      summary = t('Balance: {0}', '$' + formatSigned(actualQuota));
    }

    const details = [summary];
    return { summary, details };
  }

  private async resolveSystemTokenValue(): Promise<string | undefined> {
    const config = isNewAPIBalanceConfig(this.config) ? this.config : undefined;
    const raw = config?.systemToken;
    if (!raw) {
      return undefined;
    }

    if (!isSecretRef(raw)) {
      return raw;
    }

    return this.context.secretStore.getApiKey(raw);
  }

  private async cleanupExistingSystemTokenRef(): Promise<void> {
    const config = isNewAPIBalanceConfig(this.config) ? this.config : undefined;
    const token = config?.systemToken;
    if (token && isSecretRef(token)) {
      await this.context.secretStore.deleteApiKey(token);
    }
  }

  private async persistSystemToken(
    value: string,
    existing: string | undefined,
  ): Promise<string> {
    if (this.context.storeSecretsInSettings) {
      if (existing && isSecretRef(existing)) {
        await this.context.secretStore.deleteApiKey(existing);
      }
      return value;
    }

    const ref =
      existing && isSecretRef(existing) ? existing : createSecretRef();
    await this.context.secretStore.setApiKey(ref, value);
    return ref;
  }
}
