import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type {
  AuthConfigureResult,
  AuthErrorType,
  AuthProvider,
  AuthProviderContext,
  AuthProviderDefinition,
  AuthStatusChange,
  AuthStatusViewItem,
  AuthUiStatusSnapshot,
} from '../../auth-provider';
import type { AuthProviderBindingContext } from '../../definitions';
import type {
  AuthCredential,
  OAuth2TokenData,
  ZedAuthConfig,
} from '../../types';
import { createSecretRef, isSecretRef } from '../../../secret/constants';
import type { SecretStore } from '../../../secret/secret-store';
import {
  parseZedCredential,
  serializeZedCredential,
} from '../../../client/zed/codecs';
import { ZedCloudError } from '../../../client/zed/cloud-client';
import {
  DEFAULT_ZED_WEB_BASE_URL,
  resolveZedBaseUrls,
} from '../../../client/zed/urls';
import { stableStringify } from '../../../config-ops';
import { t } from '../../../i18n';
import { performZedNativeSignIn } from './native-signin';
import {
  getZedSystemId,
  type ZedAccountSnapshot,
  ZedAuthSessionCache,
} from './session-cache';

function persistableConfig(config: ZedAuthConfig | undefined): ZedAuthConfig {
  return {
    method: 'zed',
    label: config?.label,
    description: config?.description,
    baseUrl: config?.baseUrl?.trim() || undefined,
    identityId: config?.identityId,
    token: config?.token,
    organizationId: config?.organizationId,
    dataCollection: config?.dataCollection === true,
    dataCollectionAllowed: config?.dataCollectionAllowed === true,
    email: config?.email,
  };
}

function resolveAuthBaseUrl(config: ZedAuthConfig | undefined): string {
  return config?.baseUrl?.trim() || DEFAULT_ZED_WEB_BASE_URL;
}

function isTokenData(value: unknown): value is OAuth2TokenData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['accessToken'] === 'string' &&
    typeof record['tokenType'] === 'string'
  );
}

function parseTokenData(raw: string): OAuth2TokenData | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isTokenData(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function classifyError(error: Error): AuthErrorType {
  if (error instanceof ZedCloudError) {
    if (error.status === 401 || error.status === 403) return 'auth_error';
    if (error.status === 429 || (error.status !== undefined && error.status >= 500)) {
      return 'transient_error';
    }
  }
  return error.name === 'AbortError' || error instanceof TypeError
    ? 'transient_error'
    : 'unknown_error';
}

export class ZedAuthProvider implements AuthProvider {
  static normalizeForProvider(
    auth: ZedAuthConfig | undefined,
    context: AuthProviderBindingContext,
  ): ZedAuthConfig {
    const baseUrl =
      context.baseUrl?.trim() ||
      auth?.baseUrl?.trim() ||
      DEFAULT_ZED_WEB_BASE_URL;
    const cleared: ZedAuthConfig = {
      method: 'zed',
      label: auth?.label,
      description: auth?.description,
      baseUrl,
      dataCollection: false,
      dataCollectionAllowed: false,
    };
    if (!auth) return cleared;

    let providerSite: string;
    let authSite: string;
    try {
      providerSite = resolveZedBaseUrls(baseUrl).web;
      authSite = resolveZedBaseUrls(
        auth.baseUrl?.trim() || DEFAULT_ZED_WEB_BASE_URL,
      ).web;
    } catch {
      return cleared;
    }

    const previousAuth =
      context.previousAuth?.method === 'zed'
        ? context.previousAuth
        : undefined;
    const keepsPreviousCredential =
      previousAuth !== undefined &&
      ((!!auth.identityId && auth.identityId === previousAuth.identityId) ||
        (!!auth.token && auth.token === previousAuth.token));
    let previousSite: string | undefined;
    if (context.previousBaseUrl?.trim()) {
      try {
        previousSite = resolveZedBaseUrls(context.previousBaseUrl).web;
      } catch {
        if (keepsPreviousCredential) return cleared;
      }
    }

    if (
      authSite !== providerSite ||
      (keepsPreviousCredential &&
        previousSite !== undefined &&
        previousSite !== providerSite)
    ) {
      return cleared;
    }

    return auth.baseUrl === baseUrl ? auth : { ...auth, baseUrl };
  }

  static supportsSensitiveDataInSettings(_auth: ZedAuthConfig): boolean {
    return false;
  }

  static redactForExport(auth: ZedAuthConfig): ZedAuthConfig {
    return { ...persistableConfig(auth), token: undefined };
  }

  static async resolveForExport(
    auth: ZedAuthConfig,
    secretStore: SecretStore,
  ): Promise<ZedAuthConfig> {
    const tokenData = await this.resolveTokenData(auth, secretStore);
    if (!tokenData) throw new Error('Missing Zed credential.');
    return { ...persistableConfig(auth), token: JSON.stringify(tokenData) };
  }

  private static async resolveTokenData(
    auth: ZedAuthConfig,
    secretStore: SecretStore,
  ): Promise<OAuth2TokenData | undefined> {
    const raw = auth.token?.trim();
    if (!raw) return undefined;
    const data = isSecretRef(raw)
      ? await secretStore.getOAuth2Token(raw)
      : parseTokenData(raw);
    if (!data) return undefined;
    try {
      parseZedCredential(data.accessToken);
      return data;
    } catch {
      return undefined;
    }
  }

  static async normalizeOnImport(
    auth: ZedAuthConfig,
    options: {
      secretStore: SecretStore;
      storeSecretsInSettings: boolean;
      existing?: ZedAuthConfig;
    },
  ): Promise<ZedAuthConfig> {
    const raw = auth.token?.trim();
    const normalized = {
      ...persistableConfig(auth),
      identityId: raw
        ? auth.identityId ?? options.existing?.identityId ?? randomUUID()
        : auth.identityId,
    };
    if (!raw) return { ...normalized, token: undefined };
    if (isSecretRef(raw)) return normalized;

    const tokenData = parseTokenData(raw);
    if (!tokenData) return { ...normalized, token: undefined };
    parseZedCredential(tokenData.accessToken);
    const existingRef =
      options.existing?.token && isSecretRef(options.existing.token)
        ? options.existing.token
        : undefined;
    const tokenRef = existingRef ?? createSecretRef();
    await options.secretStore.setOAuth2Token(tokenRef, tokenData);
    return { ...normalized, token: tokenRef };
  }

  static async prepareForDuplicate(
    auth: ZedAuthConfig,
    _options: {
      secretStore: SecretStore;
      storeSecretsInSettings: boolean;
    },
  ): Promise<ZedAuthConfig> {
    return {
      ...persistableConfig(auth),
      identityId: undefined,
      token: undefined,
      organizationId: undefined,
      dataCollection: false,
      dataCollectionAllowed: false,
      email: undefined,
    };
  }

  static async cleanupOnDiscard(
    auth: ZedAuthConfig,
    secretStore: SecretStore,
  ): Promise<void> {
    const raw = auth.token?.trim();
    if (raw && isSecretRef(raw)) await secretStore.deleteOAuth2Token(raw);
  }

  private readonly emitter = new vscode.EventEmitter<AuthStatusChange>();
  readonly onDidChangeStatus = this.emitter.event;
  private sessionCache?: ZedAuthSessionCache;

  constructor(
    private readonly context: AuthProviderContext,
    private config?: ZedAuthConfig,
  ) {}

  get definition(): AuthProviderDefinition {
    return {
      id: 'zed',
      label: this.config?.label ?? 'Zed',
      description: this.config?.description ?? t('Sign in with a Zed account'),
    };
  }

  getConfig(): ZedAuthConfig | undefined {
    return this.config;
  }

  private async persistConfig(config: ZedAuthConfig): Promise<void> {
    this.config = config;
    await this.context.persistAuthConfig?.(config);
  }

  private async tokenData(): Promise<OAuth2TokenData | undefined> {
    return this.config
      ? ZedAuthProvider.resolveTokenData(this.config, this.context.secretStore)
      : undefined;
  }

  private async getSession(): Promise<ZedAuthSessionCache | undefined> {
    const tokenData = await this.tokenData();
    if (!tokenData) return undefined;
    const credential = parseZedCredential(tokenData.accessToken);
    const baseUrl = resolveAuthBaseUrl(this.config);
    if (!this.sessionCache?.matches(baseUrl, credential)) {
      this.sessionCache?.clear();
      this.sessionCache = new ZedAuthSessionCache(
        baseUrl,
        credential,
        await getZedSystemId(this.context.secretStore),
      );
    }
    return this.sessionCache;
  }

  private async requireSession(): Promise<ZedAuthSessionCache> {
    const session = await this.getSession();
    if (!session) throw new Error('Zed authentication is required.');
    return session;
  }

  private async syncAccountConfig(
    snapshot: ZedAccountSnapshot,
    forceResetDataCollection = false,
  ): Promise<ZedAuthConfig> {
    const current = {
      ...persistableConfig(this.config),
      baseUrl: resolveAuthBaseUrl(this.config),
    };
    const organizationChanged =
      current.organizationId !== snapshot.organization.id;
    const dataCollectionAllowed =
      snapshot.organization.editPrediction.isFeedbackEnabled;
    const next: ZedAuthConfig = {
      ...current,
      organizationId: snapshot.organization.id,
      dataCollectionAllowed,
      dataCollection:
        dataCollectionAllowed &&
        !organizationChanged &&
        !forceResetDataCollection &&
        current.dataCollection === true,
      email: snapshot.user.email,
    };
    if (stableStringify(current) !== stableStringify(next)) {
      await this.persistConfig(next);
    }
    return next;
  }

  private fireError(error: unknown): void {
    const resolved = toError(error);
    this.emitter.fire({
      status: 'error',
      error: resolved,
      errorType: classifyError(resolved),
    });
  }

  private async clearAuthData(options: {
    status: 'revoked';
    error?: Error;
  }): Promise<void> {
    const raw = this.config?.token?.trim();
    if (raw && isSecretRef(raw)) {
      await this.context.secretStore.deleteOAuth2Token(raw);
    }
    this.sessionCache?.clear();
    this.sessionCache = undefined;
    const next: ZedAuthConfig = {
      method: 'zed',
      label: this.config?.label,
      description: this.config?.description,
      baseUrl: this.config?.baseUrl?.trim() || undefined,
      identityId: undefined,
      token: undefined,
      organizationId: undefined,
      dataCollection: false,
      dataCollectionAllowed: false,
      email: undefined,
    };
    await this.persistConfig(next);
    this.emitter.fire({
      status: options.status,
      error: options.error,
      errorType: options.error ? 'auth_error' : undefined,
    });
  }

  private async handleCredentialError(
    error: unknown,
  ): Promise<'revoked' | 'error'> {
    const resolved = toError(error);
    if (resolved instanceof ZedCloudError && resolved.status === 401) {
      await this.clearAuthData({ status: 'revoked', error: resolved });
      return 'revoked';
    }
    this.fireError(resolved);
    return 'error';
  }

  async getCredential(): Promise<AuthCredential | undefined> {
    try {
      const session = await this.getSession();
      if (!session) return undefined;
      const account = await session.ensureAccount(this.config?.organizationId);
      await this.syncAccountConfig(account);
      return {
        value: await session.getLlmToken(account.organization.id),
        tokenType: 'Bearer',
      };
    } catch (error) {
      if ((await this.handleCredentialError(error)) === 'revoked') {
        return undefined;
      }
      throw error;
    }
  }

  async refresh(): Promise<boolean> {
    try {
      const session = await this.getSession();
      if (!session) return false;
      const account = await session.ensureAccount(this.config?.organizationId, {
        force: true,
      });
      await this.syncAccountConfig(account);
      await session.refreshLlmToken(account.organization.id);
      this.emitter.fire({ status: 'valid' });
      return true;
    } catch (error) {
      await this.handleCredentialError(error);
      return false;
    }
  }

  getExpiryBufferMs(): number {
    return 0;
  }

  async isValid(): Promise<boolean> {
    return (await this.tokenData()) !== undefined;
  }

  async getStatusSnapshot(): Promise<AuthUiStatusSnapshot> {
    if (!this.config) return { kind: 'not-configured' };
    return (await this.isValid())
      ? { kind: 'valid' }
      : { kind: 'not-authorized' };
  }

  async getSummaryDetail(): Promise<string | undefined> {
    if (!(await this.isValid())) return t('Not authorized');
    if (this.config?.email) return this.config.email;
    return this.config?.organizationId
      ? t('Organization: {0}', this.config.organizationId)
      : t('Authorized');
  }

  private async chooseOrganization(): Promise<void> {
    const session = await this.requireSession();
    const account = await session.ensureAccount(this.config?.organizationId);
    const selected = await vscode.window.showQuickPick(
      account.user.organizations.map((organization) => ({
        label: organization.name,
        description: organization.isPersonal ? t('Personal') : organization.id,
        organization,
      })),
      {
        title: t('Select Zed organization'),
        placeHolder: t('Organization'),
      },
    );
    if (!selected) return;
    const nextAccount = await session.selectOrganization(
      selected.organization.id,
      this.config?.organizationId,
    );
    await this.syncAccountConfig(
      nextAccount,
      selected.organization.id !== this.config?.organizationId,
    );
    this.emitter.fire({ status: 'valid' });
  }

  private async toggleDataCollection(): Promise<void> {
    const session = await this.requireSession();
    const account = await session.ensureAccount(this.config?.organizationId);
    const current = await this.syncAccountConfig(account);
    if (current.dataCollectionAllowed !== true) return;
    await this.persistConfig({
      ...current,
      dataCollection: current.dataCollection !== true,
    });
    this.emitter.fire({ status: 'valid' });
  }

  async getStatusViewItems(): Promise<AuthStatusViewItem[]> {
    const snapshot = await this.getStatusSnapshot();
    if (snapshot.kind !== 'valid') {
      return [
        {
          label: `$(sign-in) ${t('Sign in to Zed')}`,
          action: { kind: 'close', run: async () => void (await this.configure()) },
        },
      ];
    }

    let organizationLabel =
      this.config?.organizationId ?? t('Select organization');
    let policyAllowsCollection = this.config?.dataCollectionAllowed === true;
    try {
      const session = await this.requireSession();
      const account = await session.ensureAccount(this.config?.organizationId);
      await this.syncAccountConfig(account);
      organizationLabel = account.organization.name;
      policyAllowsCollection =
        account.organization.editPrediction.isFeedbackEnabled;
    } catch {
      // Keep the status screen usable while account endpoints are unavailable.
    }

    return [
      {
        label: `$(organization) ${organizationLabel}`,
        description: t('Zed organization'),
        action: { kind: 'inline', run: () => this.chooseOrganization() },
      },
      {
        label: `$(database) ${t(
          'Data collection: {0}',
          this.config?.dataCollection === true && policyAllowsCollection
            ? t('On')
            : t('Off'),
        )}`,
        description: policyAllowsCollection
          ? t('Edit prediction data collection')
          : t('Disabled by organization policy'),
        ...(policyAllowsCollection
          ? {
              action: {
                kind: 'inline' as const,
                run: () => this.toggleDataCollection(),
              },
            }
          : {}),
      },
      {
        label: `$(sign-in) ${t('Sign in again')}`,
        action: { kind: 'close', run: async () => void (await this.configure()) },
      },
    ];
  }

  async configure(): Promise<AuthConfigureResult> {
    try {
      const baseUrl = resolveAuthBaseUrl(this.config);
      const systemId = await getZedSystemId(this.context.secretStore);
      const credential = await performZedNativeSignIn({ baseUrl, systemId });
      const temporarySession = new ZedAuthSessionCache(
        baseUrl,
        credential,
        systemId,
      );
      const account = await temporarySession.ensureAccount(undefined, {
        force: true,
      });
      const serializedCredential = serializeZedCredential(credential);
      const tokenRef = createSecretRef();
      await this.context.secretStore.setOAuth2Token(tokenRef, {
        accessToken: serializedCredential,
        tokenType: 'Zed',
      });

      const next: ZedAuthConfig = {
        method: 'zed',
        label: this.config?.label,
        description: this.config?.description,
        baseUrl,
        identityId: randomUUID(),
        token: tokenRef,
        organizationId: account.organization.id,
        dataCollection: false,
        dataCollectionAllowed:
          account.organization.editPrediction.isFeedbackEnabled,
        email: account.user.email,
      };
      this.sessionCache?.clear();
      this.sessionCache = temporarySession;
      await this.persistConfig(next);
      this.emitter.fire({ status: 'valid' });
      vscode.window.showInformationMessage(t('Zed authorization successful.'));
      return { success: true, config: next };
    } catch (error) {
      const resolved = toError(error);
      this.fireError(resolved);
      vscode.window.showErrorMessage(
        t('Zed authorization failed: {0}', resolved.message),
      );
      return { success: false, error: resolved.message };
    }
  }

  async revoke(): Promise<void> {
    await this.clearAuthData({ status: 'revoked' });
  }

  dispose(): void {
    this.sessionCache?.clear();
    this.sessionCache = undefined;
    this.emitter.dispose();
  }
}
