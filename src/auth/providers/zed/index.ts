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
  ZedAuthContext,
} from '../../types';
import { isSessionSecretRef } from '../../../secret/constants';
import type {
  LocalAuthCommitGuard,
  SecretStore,
} from '../../../secret/secret-store';
import {
  parseZedCredential,
  serializeZedCredential,
} from '../../../client/zed/codecs';
import { ZedCloudError } from '../../../client/zed/cloud-client';
import { ZedCloudClient } from '../../../client/zed/cloud-client';
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
    bindingId: config?.bindingId ?? randomUUID(),
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

function withoutSessionState(config: ZedAuthConfig): ZedAuthConfig {
  return {
    method: 'zed',
    bindingId: config.bindingId,
    label: config.label,
    description: config.description,
    baseUrl: config.baseUrl?.trim() || undefined,
    identityId: undefined,
    token: undefined,
    organizationId: undefined,
    dataCollection: false,
    dataCollectionAllowed: false,
    email: undefined,
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
      bindingId: auth?.bindingId ?? randomUUID(),
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
    const data = isSessionSecretRef(raw)
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
    const normalized: ZedAuthConfig = {
      ...persistableConfig(auth),
      identityId: raw
        ? !isSessionSecretRef(raw)
          ? randomUUID()
          : auth.identityId ?? options.existing?.identityId ?? randomUUID()
        : auth.identityId,
    };
    if (!raw) return withoutSessionState(normalized);
    if (isSessionSecretRef(raw)) return normalized;

    const tokenData = parseTokenData(raw);
    if (!tokenData) return withoutSessionState(normalized);
    const credential = parseZedCredential(tokenData.accessToken);
    const user = await new ZedCloudClient(
      resolveAuthBaseUrl(normalized),
    ).getAuthenticatedUser(
      credential,
      await getZedSystemId(options.secretStore),
    );
    const requestedOrganization = user.organizations.find(
      (organization) => organization.id === auth.organizationId,
    );
    const fallbackOrganization =
      user.organizations.find(
        (organization) => organization.id === user.defaultOrganizationId,
      ) ?? user.organizations[0];
    const organization = requestedOrganization ?? fallbackOrganization;
    if (!organization) {
      throw new Error('The Zed account does not belong to an organization.');
    }
    const canInheritExportedContext = requestedOrganization !== undefined;
    const dataCollectionAllowed =
      organization.editPrediction.isFeedbackEnabled === true;
    const validated: ZedAuthConfig = {
      ...normalized,
      organizationId: organization.id,
      dataCollectionAllowed,
      dataCollection:
        canInheritExportedContext &&
        dataCollectionAllowed &&
        auth.dataCollection === true,
      email: user.email,
    };
    const existingRef =
      options.existing?.token && isSessionSecretRef(options.existing.token)
        ? options.existing.token
        : undefined;
    const tokenRef =
      existingRef ?? options.secretStore.createTransientOAuth2TokenRef();
    await options.secretStore.setOAuth2Token(tokenRef, tokenData);
    return { ...validated, token: tokenRef };
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
    if (raw && isSessionSecretRef(raw)) await secretStore.deleteOAuth2Token(raw);
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

  private async persistConfig(
    config: ZedAuthConfig,
    guard = this.context.captureAuthCommitGuard?.(),
  ): Promise<void> {
    await this.context.persistAuthConfig?.(config, guard);
    this.config = config;
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

  private authContextForSnapshot(
    config: ZedAuthConfig,
    snapshot: ZedAccountSnapshot,
  ): ZedAuthContext | undefined {
    if (!this.context.providerType || !this.context.baseUrl) return undefined;
    const stored = this.context.secretStore.getAuthContextForCredential(
      {
        providerName: this.context.providerId,
        providerType: this.context.providerType,
        baseUrl: this.context.baseUrl,
        useRawBaseUrl: this.context.useRawBaseUrl,
      },
      config,
    );
    if (
      stored?.method !== 'zed' ||
      !config.identityId ||
      stored.sessionId !== config.identityId
    ) {
      return undefined;
    }
    const dataCollectionAllowed =
      snapshot.organization.editPrediction.isFeedbackEnabled === true;
    return {
      ...stored,
      organizationId: snapshot.organization.id,
      dataCollectionAllowed,
      dataCollection:
        dataCollectionAllowed && config.dataCollection === true,
      email: snapshot.user.email,
    };
  }

  private async requireSession(): Promise<ZedAuthSessionCache> {
    const session = await this.getSession();
    if (!session) throw new Error('Zed authentication is required.');
    return session;
  }

  private async syncAccountConfig(
    snapshot: ZedAccountSnapshot,
    forceResetDataCollection = false,
    guard = this.context.captureAuthCommitGuard?.(),
  ): Promise<{
    config: ZedAuthConfig;
    guard: LocalAuthCommitGuard | undefined;
  }> {
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
      await this.persistConfig(next, guard);
      return {
        config: next,
        guard: this.context.captureAuthCommitGuard?.(),
      };
    }
    return { config: next, guard };
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
  }, guard = this.context.captureAuthCommitGuard?.()): Promise<void> {
    const oldTokenRef = this.config?.token?.trim();
    const next: ZedAuthConfig = {
      method: 'zed',
      bindingId: this.config?.bindingId ?? randomUUID(),
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
    await this.persistConfig(next, guard);
    if (oldTokenRef && isSessionSecretRef(oldTokenRef)) {
      await this.context.secretStore.discardOAuth2TokenRef(oldTokenRef);
    }
    this.sessionCache?.clear();
    this.sessionCache = undefined;
    this.emitter.fire({
      status: options.status,
      error: options.error,
      errorType: options.error ? 'auth_error' : undefined,
    });
  }

  private async handleCredentialError(
    error: unknown,
    guard = this.context.captureAuthCommitGuard?.(),
  ): Promise<'revoked' | 'error'> {
    const resolved = toError(error);
    if (resolved instanceof ZedCloudError && resolved.status === 401) {
      await this.clearAuthData({ status: 'revoked', error: resolved }, guard);
      return 'revoked';
    }
    this.fireError(resolved);
    return 'error';
  }

  async getCredential(): Promise<AuthCredential | undefined> {
    let commitGuard = this.context.captureAuthCommitGuard?.();
    try {
      const session = await this.getSession();
      if (!session) return undefined;
      const account = await session.ensureAccount(this.config?.organizationId);
      const synced = await this.syncAccountConfig(account, false, commitGuard);
      commitGuard = synced.guard;
      const value = await session.getLlmToken(account.organization.id);
      const authContext = this.authContextForSnapshot(synced.config, account);
      if (
        this.context.providerType &&
        this.context.baseUrl &&
        !authContext
      ) {
        return undefined;
      }
      return {
        value,
        tokenType: 'Bearer',
        ...(authContext ? { authContext } : {}),
      };
    } catch (error) {
      if ((await this.handleCredentialError(error, commitGuard)) === 'revoked') {
        return undefined;
      }
      throw error;
    }
  }

  async refresh(): Promise<boolean> {
    let commitGuard = this.context.captureAuthCommitGuard?.();
    try {
      const session = await this.getSession();
      if (!session) return false;
      const account = await session.ensureAccount(this.config?.organizationId, {
        force: true,
      });
      const synced = await this.syncAccountConfig(account, false, commitGuard);
      commitGuard = synced.guard;
      await session.refreshLlmToken(account.organization.id);
      this.emitter.fire({ status: 'valid' });
      return true;
    } catch (error) {
      await this.handleCredentialError(error, commitGuard);
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
    const commitGuard = this.context.captureAuthCommitGuard?.();
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
      commitGuard,
    );
    this.emitter.fire({ status: 'valid' });
  }

  private async toggleDataCollection(): Promise<void> {
    const commitGuard = this.context.captureAuthCommitGuard?.();
    const session = await this.requireSession();
    const account = await session.ensureAccount(this.config?.organizationId);
    const synced = await this.syncAccountConfig(account, false, commitGuard);
    const current = synced.config;
    if (current.dataCollectionAllowed !== true) return;
    await this.persistConfig(
      {
        ...current,
        dataCollection: current.dataCollection !== true,
      },
      synced.guard,
    );
    this.emitter.fire({ status: 'valid' });
  }

  async getStatusViewItems(): Promise<AuthStatusViewItem[]> {
    const commitGuard = this.context.captureAuthCommitGuard?.();
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
      await this.syncAccountConfig(account, false, commitGuard);
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
    const commitGuard = this.context.captureAuthCommitGuard?.();
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
      const tokenRef =
        this.context.secretStore.createTransientOAuth2TokenRef();
      await this.context.secretStore.setOAuth2Token(tokenRef, {
        accessToken: serializedCredential,
        tokenType: 'Zed',
      });

      const next: ZedAuthConfig = {
        method: 'zed',
        bindingId: this.config?.bindingId ?? randomUUID(),
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
      await this.persistConfig(next, commitGuard);
      this.sessionCache?.clear();
      this.sessionCache = temporarySession;
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
    const commitGuard = this.context.captureAuthCommitGuard?.();
    await this.clearAuthData({ status: 'revoked' }, commitGuard);
  }

  dispose(): void {
    this.sessionCache?.clear();
    this.sessionCache = undefined;
    this.emitter.dispose();
  }
}
