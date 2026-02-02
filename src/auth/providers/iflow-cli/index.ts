import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import {
  AuthConfigureResult,
  AuthProvider,
  AuthProviderContext,
  AuthProviderDefinition,
  AuthStatusChange,
  AuthStatusViewItem,
  AuthUiStatusSnapshot,
} from '../../auth-provider';
import { t } from '../../../i18n';
import {
  createSecretRef,
  isSecretRef,
  type SecretStore,
} from '../../../secret';
import type { AuthCredential, IFlowCliAuthConfig, OAuth2TokenData } from '../../types';
import {
  authorizeIFlow,
  exchangeIFlowCode,
  fetchIFlowUserInfo,
  refreshIFlowToken,
} from './oauth-client';
import { performIFlowAuthorization } from './screens/authorize-screen';
import { authLog } from '../../../logger';

function toPersistableConfig(
  config: IFlowCliAuthConfig | undefined,
): IFlowCliAuthConfig {
  return {
    method: 'iflow-cli',
    label: config?.label,
    description: config?.description,
    identityId: config?.identityId,
    token: config?.token,
    email: config?.email,
  };
}

export class IFlowCliAuthProvider implements AuthProvider {
  static supportsSensitiveDataInSettings(_auth: IFlowCliAuthConfig): boolean {
    return false;
  }

  static redactForExport(auth: IFlowCliAuthConfig): IFlowCliAuthConfig {
    return { ...toPersistableConfig(auth), token: undefined };
  }

  private static isTokenData(value: unknown): value is OAuth2TokenData {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const record = value as Record<string, unknown>;
    return (
      typeof record['accessToken'] === 'string' &&
      record['accessToken'].trim().length > 0 &&
      typeof record['tokenType'] === 'string' &&
      record['tokenType'].trim().length > 0
    );
  }

  private static parseTokenData(raw: string): OAuth2TokenData | null {
    try {
      const parsed: unknown = JSON.parse(raw);
      return this.isTokenData(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  static async resolveForExport(
    auth: IFlowCliAuthConfig,
    secretStore: SecretStore,
  ): Promise<IFlowCliAuthConfig> {
    const tokenRaw = auth.token?.trim();
    if (!tokenRaw) {
      throw new Error('Missing token');
    }

    const tokenData = isSecretRef(tokenRaw)
      ? await secretStore.getOAuth2Token(tokenRaw)
      : this.parseTokenData(tokenRaw);

    if (!tokenData) {
      throw new Error('Missing token');
    }

    return { ...toPersistableConfig(auth), token: JSON.stringify(tokenData) };
  }

  static async normalizeOnImport(
    auth: IFlowCliAuthConfig,
    options: {
      secretStore: SecretStore;
      storeSecretsInSettings: boolean;
      existing?: IFlowCliAuthConfig;
    },
  ): Promise<IFlowCliAuthConfig> {
    const secretStore = options.secretStore;

    const normalizeToken = async (): Promise<string | undefined> => {
      const raw = auth.token?.trim();
      if (!raw) {
        return undefined;
      }

      if (options.storeSecretsInSettings) {
        if (!isSecretRef(raw)) {
          return raw;
        }
        const stored = await secretStore.getOAuth2Token(raw);
        return stored ? JSON.stringify(stored) : raw;
      }

      if (isSecretRef(raw)) {
        return raw;
      }

      const tokenData = this.parseTokenData(raw);
      if (!tokenData) {
        return undefined;
      }

      const existingRef =
        options.existing?.token && isSecretRef(options.existing.token)
          ? options.existing.token
          : undefined;

      const ref = existingRef ?? secretStore.createRef();
      await secretStore.setOAuth2Token(ref, tokenData);
      return ref;
    };

    const token = await normalizeToken();
    return { ...toPersistableConfig(auth), token };
  }

  static async prepareForDuplicate(
    auth: IFlowCliAuthConfig,
    options: {
      secretStore: SecretStore;
      storeSecretsInSettings: boolean;
    },
  ): Promise<IFlowCliAuthConfig> {
    const cleared: IFlowCliAuthConfig = {
      ...toPersistableConfig(auth),
      token: undefined,
      identityId: randomUUID(),
    };

    if (!options.storeSecretsInSettings) {
      return cleared;
    }

    return this.normalizeOnImport(cleared, {
      secretStore: options.secretStore,
      storeSecretsInSettings: true,
    });
  }

  static async cleanupOnDiscard(
    auth: IFlowCliAuthConfig,
    secretStore: SecretStore,
  ): Promise<void> {
    const tokenRaw = auth.token?.trim();
    if (tokenRaw && isSecretRef(tokenRaw)) {
      await secretStore.deleteOAuth2Token(tokenRaw);
    }
  }

  private readonly _onDidChangeStatus =
    new vscode.EventEmitter<AuthStatusChange>();
  readonly onDidChangeStatus = this._onDidChangeStatus.event;

  constructor(
    private readonly context: AuthProviderContext,
    private config?: IFlowCliAuthConfig,
  ) {}

  get definition(): AuthProviderDefinition {
    return {
      id: 'iflow-cli',
      label: this.config?.label ?? 'iFlow CLI',
      description:
        this.config?.description ?? t('Authenticate using iFlow OAuth (CLI)'),
    };
  }

  getConfig(): IFlowCliAuthConfig | undefined {
    return this.config;
  }

  private async persistConfig(next: IFlowCliAuthConfig): Promise<void> {
    this.config = next;
    await this.context.persistAuthConfig?.(next);
  }

  private async resolveTokenData(): Promise<OAuth2TokenData | null> {
    const raw = this.config?.token?.trim();
    if (!raw) {
      return null;
    }

    if (isSecretRef(raw)) {
      return this.context.secretStore.getOAuth2Token(raw);
    }

    return IFlowCliAuthProvider.parseTokenData(raw);
  }

  async getStatusSnapshot(): Promise<AuthUiStatusSnapshot> {
    if (!this.config) {
      return { kind: 'not-configured' };
    }

    const token = await this.resolveTokenData();
    if (!token) {
      return { kind: 'not-authorized' };
    }

    const expiresAt = token.expiresAt;
    if (
      expiresAt !== undefined &&
      this.context.secretStore.isOAuth2TokenExpired(token, 0)
    ) {
      const refreshable = !!token.refreshToken;
      return { kind: 'expired', refreshable, expiresAt };
    }

    return { kind: 'valid', expiresAt };
  }

  async getSummaryDetail(): Promise<string | undefined> {
    const snapshot = await this.getStatusSnapshot();
    if (snapshot.kind === 'not-authorized') {
      return t('Not authorized');
    }
    if (snapshot.kind === 'expired') {
      return snapshot.refreshable ? t('Expired (refreshable)') : t('Expired');
    }
    if (snapshot.kind === 'valid') {
      const email = this.config?.email?.trim();
      return email ? email : t('Authorized');
    }
    return undefined;
  }

  async getStatusViewItems(): Promise<AuthStatusViewItem[]> {
    const detail = await this.getSummaryDetail();
    const snapshot = await this.getStatusSnapshot();

    const description = (() => {
      switch (snapshot.kind) {
        case 'valid':
          return t('Authorized');
        case 'expired':
          return snapshot.refreshable
            ? t('Expired (refreshable)')
            : t('Expired');
        case 'not-authorized':
          return t('Not authorized');
        default:
          return t('Not configured');
      }
    })();

    const items: AuthStatusViewItem[] = [
      {
        label: `$(shield) ${t('Authorization status')}`,
        description,
        detail,
      },
    ];

    if (snapshot.kind === 'expired' && snapshot.refreshable) {
      items.push({
        label: `$(refresh) ${t('Refresh token')}`,
        description: t('Refresh access token'),
        action: {
          kind: 'inline',
          run: async () => {
            await this.refresh();
          },
        },
      });
    }

    items.push({
      label: `$(sign-in) ${t('Re-authorize...')}`,
      description: t('Sign in again or switch account'),
      action: {
        kind: 'close',
        run: async () => {
          const result = await this.configure();
          if (!result.success && result.error) {
            vscode.window.showErrorMessage(result.error);
          }
        },
      },
    });

    items.push({
      label: `$(sign-out) ${t('Sign out')}`,
      description: t('Revoke and clear local tokens'),
      action: {
        kind: 'inline',
        run: async () => {
          await this.revoke();
        },
      },
    });

    return items;
  }

  async getCredential(): Promise<AuthCredential | undefined> {
    authLog.verbose(
      `${this.context.providerId}:iflow-cli`,
      'Getting credential',
    );

    const token = await this.resolveTokenData();
    if (!token) {
      authLog.verbose(`${this.context.providerId}:iflow-cli`, 'No token data available');
      return undefined;
    }

    const bufferMs = this.getExpiryBufferMs();
    if (this.context.secretStore.isOAuth2TokenExpired(token, bufferMs)) {
      authLog.verbose(
        `${this.context.providerId}:iflow-cli`,
        'Token expired or about to expire, attempting refresh',
      );
      const refreshed = await this.refresh();
      if (!refreshed) {
        this._onDidChangeStatus.fire({ status: 'expired' });
        return undefined;
      }

      const newToken = await this.resolveTokenData();
      if (!newToken) {
        this._onDidChangeStatus.fire({ status: 'expired' });
        return undefined;
      }

      return {
        value: newToken.accessToken,
        tokenType: 'Bearer',
        expiresAt: newToken.expiresAt,
      };
    }

    return {
      value: token.accessToken,
      tokenType: 'Bearer',
      expiresAt: token.expiresAt,
    };
  }

  getExpiryBufferMs(): number {
    return 24 * 60 * 60 * 1000;
  }

  async isValid(): Promise<boolean> {
    const token = await this.resolveTokenData();
    if (!token) {
      return false;
    }

    if (this.context.secretStore.isOAuth2TokenExpired(token, 0)) {
      return !!token.refreshToken;
    }

    return true;
  }

  async configure(): Promise<AuthConfigureResult> {
    authLog.verbose(`${this.context.providerId}:iflow-cli`, 'Starting iFlow OAuth configuration');
    const authorization = authorizeIFlow();

    const callbackResult = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: t('Waiting for authorization...'),
        cancellable: true,
      },
      async (_progress, token) => {
        return performIFlowAuthorization({
          url: authorization.url,
          expectedState: authorization.state,
          cancellationToken: token,
        });
      },
    );

    if (!callbackResult || callbackResult.type === 'cancel') {
      return {
        success: false,
        error: t('Authorization failed or was cancelled'),
      };
    }

    if (callbackResult.type === 'error') {
      return {
        success: false,
        error: t('Authorization failed: {0}', callbackResult.error),
      };
    }

    const exchanged = await exchangeIFlowCode({
      code: callbackResult.code,
      redirectUri: authorization.redirectUri,
    });

    if (exchanged.type === 'failed') {
      return {
        success: false,
        error: t('Authorization failed: {0}', exchanged.error),
      };
    }

    const userInfo = await fetchIFlowUserInfo({
      accessToken: exchanged.accessToken,
    });

    if (userInfo.type === 'failed') {
      return {
        success: false,
        error: t('Authorization failed: {0}', userInfo.error),
      };
    }

    const tokenRef = createSecretRef();
    await this.context.secretStore.setOAuth2Token(tokenRef, {
      accessToken: userInfo.apiKey,
      refreshToken: exchanged.refreshToken,
      tokenType: 'Bearer',
      expiresAt: exchanged.expiresAt,
    });

    const nextConfig: IFlowCliAuthConfig = {
      method: 'iflow-cli',
      label: this.config?.label,
      description: this.config?.description,
      identityId: randomUUID(),
      token: tokenRef,
      email: userInfo.email,
    };

    await this.persistConfig(nextConfig);
    this._onDidChangeStatus.fire({ status: 'valid' });
    return { success: true, config: nextConfig };
  }

  async refresh(): Promise<boolean> {
    const token = await this.resolveTokenData();
    if (!token?.refreshToken) {
      return false;
    }

    const refreshed = await refreshIFlowToken({ refreshToken: token.refreshToken });
    if (refreshed.type === 'failed') {
      this._onDidChangeStatus.fire({
        status: 'error',
        error: new Error(refreshed.error),
        errorType: 'transient_error',
      });
      return false;
    }

    const userInfo = await fetchIFlowUserInfo({
      accessToken: refreshed.accessToken,
    });
    if (userInfo.type === 'failed') {
      this._onDidChangeStatus.fire({
        status: 'error',
        error: new Error(userInfo.error),
        errorType: 'transient_error',
      });
      return false;
    }

    const raw = this.config?.token?.trim();
    if (!raw) {
      return false;
    }

    const nextToken: OAuth2TokenData = {
      accessToken: userInfo.apiKey,
      refreshToken: refreshed.refreshToken,
      tokenType: 'Bearer',
      expiresAt: refreshed.expiresAt,
    };

    if (isSecretRef(raw)) {
      await this.context.secretStore.setOAuth2Token(raw, nextToken);
    } else {
      await this.persistConfig({
        ...toPersistableConfig(this.config),
        token: JSON.stringify(nextToken),
      });
    }

    const currentEmail = this.config?.email?.trim() || undefined;
    const mergedEmail = userInfo.email ?? currentEmail;
    if (mergedEmail !== currentEmail) {
      await this.persistConfig({ ...toPersistableConfig(this.config), email: mergedEmail });
    }

    this._onDidChangeStatus.fire({ status: 'valid' });
    return true;
  }

  async revoke(): Promise<void> {
    if (!this.config) {
      return;
    }

    const tokenRaw = this.config.token?.trim();
    if (tokenRaw && isSecretRef(tokenRaw)) {
      await this.context.secretStore.deleteOAuth2Token(tokenRaw);
    }

    await this.persistConfig({
      ...toPersistableConfig(this.config),
      token: undefined,
      email: undefined,
    });

    this._onDidChangeStatus.fire({ status: 'revoked' });
  }

  dispose(): void {
    this._onDidChangeStatus.dispose();
  }
}
