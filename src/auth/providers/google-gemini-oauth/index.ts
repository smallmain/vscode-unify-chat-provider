/**
 * Gemini CLI OAuth authentication provider.
 *
 * This provider implements OAuth 2.0 authentication using the official
 * Gemini CLI credentials, independent of the Antigravity OAuth provider.
 */

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
import type {
  AuthCredential,
  GeminiCliOAuthConfig,
  OAuth2TokenData,
} from '../../types';
import {
  GeminiCliTokenRefreshError,
  exchangeGeminiCli,
  fetchGeminiCliAccountInfo,
  refreshGeminiCliAccessToken,
} from './oauth-client';
import { performGeminiCliAuthorization } from './screens/authorize-screen';
import { authLog } from '../../../logger';

function toPersistableConfig(
  config: GeminiCliOAuthConfig | undefined,
): GeminiCliOAuthConfig {
  return {
    method: 'google-gemini-oauth',
    label: config?.label,
    description: config?.description,
    identityId: config?.identityId,
    token: config?.token,
    managedProjectId: config?.managedProjectId,
    tier: config?.tier,
    tierId: config?.tierId,
    email: config?.email,
  };
}

export class GeminiCliOAuthProvider implements AuthProvider {
  static supportsSensitiveDataInSettings(_auth: GeminiCliOAuthConfig): boolean {
    return false;
  }

  static redactForExport(auth: GeminiCliOAuthConfig): GeminiCliOAuthConfig {
    return { ...toPersistableConfig(auth), token: undefined };
  }

  static async resolveForExport(
    auth: GeminiCliOAuthConfig,
    secretStore: SecretStore,
  ): Promise<GeminiCliOAuthConfig> {
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
    auth: GeminiCliOAuthConfig,
    options: {
      secretStore: SecretStore;
      storeSecretsInSettings: boolean;
      existing?: GeminiCliOAuthConfig;
    },
  ): Promise<GeminiCliOAuthConfig> {
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
    auth: GeminiCliOAuthConfig,
    options: { secretStore: SecretStore; storeSecretsInSettings: boolean },
  ): Promise<GeminiCliOAuthConfig> {
    const cleared: GeminiCliOAuthConfig = {
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
    auth: GeminiCliOAuthConfig,
    secretStore: SecretStore,
  ): Promise<void> {
    const tokenRaw = auth.token?.trim();
    if (tokenRaw && isSecretRef(tokenRaw)) {
      await secretStore.deleteOAuth2Token(tokenRaw);
    }
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

  private readonly _onDidChangeStatus =
    new vscode.EventEmitter<AuthStatusChange>();
  readonly onDidChangeStatus = this._onDidChangeStatus.event;

  constructor(
    private readonly context: AuthProviderContext,
    private config?: GeminiCliOAuthConfig,
  ) {}

  get definition(): AuthProviderDefinition {
    return {
      id: 'google-gemini-oauth',
      label: this.config?.label ?? 'Google Gemini CLI',
      description:
        this.config?.description ??
        t('Authenticate with Google OAuth for Gemini CLI'),
    };
  }

  getConfig(): GeminiCliOAuthConfig | undefined {
    return this.config;
  }

  private async persistConfig(next: GeminiCliOAuthConfig): Promise<void> {
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

    return GeminiCliOAuthProvider.parseTokenData(raw);
  }

  async getStatusSnapshot(): Promise<AuthUiStatusSnapshot> {
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
      `${this.context.providerId}:google-gemini-oauth`,
      'Getting credential',
    );
    const token = await this.resolveTokenData();
    if (!token) {
      authLog.verbose(
        `${this.context.providerId}:google-gemini-oauth`,
        'No token data available',
      );
      return undefined;
    }

    const bufferMs = this.getExpiryBufferMs();
    if (this.context.secretStore.isOAuth2TokenExpired(token, bufferMs)) {
      authLog.verbose(
        `${this.context.providerId}:google-gemini-oauth`,
        'Token expired or about to expire, attempting refresh',
      );
      const refreshed = await this.refresh();
      if (!refreshed) {
        authLog.verbose(
          `${this.context.providerId}:google-gemini-oauth`,
          'Token refresh failed, firing expired status',
        );
        this._onDidChangeStatus.fire({ status: 'expired' });
        return undefined;
      }

      const newToken = await this.resolveTokenData();
      if (!newToken) {
        authLog.verbose(
          `${this.context.providerId}:google-gemini-oauth`,
          'Failed to resolve new token after refresh',
        );
        this._onDidChangeStatus.fire({ status: 'expired' });
        return undefined;
      }

      authLog.verbose(
        `${this.context.providerId}:google-gemini-oauth`,
        'Token refreshed successfully',
      );
      return {
        value: newToken.accessToken,
        tokenType: newToken.tokenType,
        expiresAt: newToken.expiresAt,
      };
    }

    authLog.verbose(
      `${this.context.providerId}:google-gemini-oauth`,
      `Credential obtained (expires: ${token.expiresAt ? new Date(token.expiresAt).toISOString() : 'never'})`,
    );
    return {
      value: token.accessToken,
      tokenType: token.tokenType,
      expiresAt: token.expiresAt,
    };
  }

  getExpiryBufferMs(): number {
    return 5 * 60 * 1000;
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
    authLog.verbose(
      `${this.context.providerId}:google-gemini-oauth`,
      'Starting Gemini CLI OAuth configuration',
    );

    authLog.verbose(
      `${this.context.providerId}:google-gemini-oauth`,
      'Initiating authorization',
    );
    const callbackResult = await performGeminiCliAuthorization(
      async (redirectUri) => {
        const authorization = await import('./oauth-client').then((m) =>
          m.authorizeGeminiCli({ redirectUri }),
        );
        return authorization.url;
      },
    );
    if (!callbackResult) {
      authLog.verbose(
        `${this.context.providerId}:google-gemini-oauth`,
        'Authorization cancelled by user',
      );
      return {
        success: false,
        error: t('Authorization failed or was cancelled'),
      };
    }

    if (callbackResult.type === 'error') {
      authLog.error(
        `${this.context.providerId}:google-gemini-oauth`,
        `Authorization callback error: ${callbackResult.error}`,
      );
      return {
        success: false,
        error: t('Authorization failed: {0}', callbackResult.error),
      };
    }

    authLog.verbose(
      `${this.context.providerId}:google-gemini-oauth`,
      'Exchanging authorization code for tokens',
    );
    const exchanged = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: t('Exchanging code for token...'),
        cancellable: false,
      },
      async () => {
        return await exchangeGeminiCli({
          code: callbackResult.code,
          state: callbackResult.state,
        });
      },
    );

    if (exchanged.type === 'failed') {
      authLog.error(
        `${this.context.providerId}:google-gemini-oauth`,
        `Token exchange failed: ${exchanged.error}`,
      );
      return {
        success: false,
        error: t('Authorization failed: {0}', exchanged.error),
      };
    }

    authLog.verbose(
      `${this.context.providerId}:google-gemini-oauth`,
      'Token exchange successful, fetching account info',
    );

    // Fetch account info to get tier and managed project
    const accountInfo = await fetchGeminiCliAccountInfo(exchanged.accessToken);

    authLog.verbose(
      `${this.context.providerId}:google-gemini-oauth`,
      'Storing tokens',
    );
    const tokenRef = createSecretRef();
    await this.context.secretStore.setOAuth2Token(tokenRef, {
      accessToken: exchanged.accessToken,
      refreshToken: exchanged.refreshToken,
      tokenType: 'Bearer',
      expiresAt: exchanged.expiresAt,
    });

    const nextConfig: GeminiCliOAuthConfig = {
      method: 'google-gemini-oauth',
      label: this.config?.label,
      description: this.config?.description,
      identityId: randomUUID(),
      token: tokenRef,
      managedProjectId: accountInfo.managedProjectId,
      tier: accountInfo.tier,
      tierId: accountInfo.tierId,
      email: exchanged.email,
    };

    await this.persistConfig(nextConfig);
    this._onDidChangeStatus.fire({ status: 'valid' });

    vscode.window.showInformationMessage(t('Authorization successful!'));
    authLog.verbose(
      `${this.context.providerId}:google-gemini-oauth`,
      `Configuration successful (email: ${exchanged.email}, tier: ${accountInfo.tier})`,
    );
    return { success: true, config: nextConfig };
  }

  async refresh(): Promise<boolean> {
    authLog.verbose(
      `${this.context.providerId}:google-gemini-oauth`,
      'Starting token refresh',
    );
    const token = await this.resolveTokenData();
    const existingRefreshToken = token?.refreshToken;
    if (!existingRefreshToken) {
      authLog.error(
        `${this.context.providerId}:google-gemini-oauth`,
        'No refresh token available',
      );
      return false;
    }

    authLog.verbose(
      `${this.context.providerId}:google-gemini-oauth`,
      'Calling refresh API',
    );
    let refreshed: {
      accessToken: string;
      expiresAt?: number;
      tokenType?: string;
      refreshToken?: string;
    } | null;
    try {
      refreshed = await refreshGeminiCliAccessToken({
        refreshToken: existingRefreshToken,
      });
    } catch (error) {
      if (
        error instanceof GeminiCliTokenRefreshError &&
        error.code === 'invalid_grant'
      ) {
        authLog.warn(
          `${this.context.providerId}:google-gemini-oauth`,
          'Refresh token was revoked (invalid_grant); reauthentication required',
        );
        await this.revoke();
        this._onDidChangeStatus.fire({ status: 'revoked' });
        vscode.window.showWarningMessage(
          t('Google revoked your refresh token. Please sign in again.'),
        );
        return false;
      }

      authLog.error(
        `${this.context.providerId}:google-gemini-oauth`,
        'Refresh API threw an error',
        error,
      );
      this._onDidChangeStatus.fire({
        status: 'error',
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return false;
    }

    if (!refreshed) {
      authLog.error(
        `${this.context.providerId}:google-gemini-oauth`,
        'Refresh API returned null',
      );
      this._onDidChangeStatus.fire({
        status: 'error',
        error: new Error('Refresh failed'),
      });
      return false;
    }

    const raw = this.config?.token?.trim();
    if (!raw) {
      authLog.error(
        `${this.context.providerId}:google-gemini-oauth`,
        'No token reference in config',
      );
      return false;
    }

    const nextToken: OAuth2TokenData = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? existingRefreshToken,
      tokenType: refreshed.tokenType ?? 'Bearer',
      expiresAt: refreshed.expiresAt,
    };

    if (isSecretRef(raw)) {
      authLog.verbose(
        `${this.context.providerId}:google-gemini-oauth`,
        'Storing refreshed token in secret storage',
      );
      await this.context.secretStore.setOAuth2Token(raw, nextToken);
    } else {
      authLog.verbose(
        `${this.context.providerId}:google-gemini-oauth`,
        'Storing refreshed token in config',
      );
      await this.persistConfig({
        ...toPersistableConfig(this.config),
        token: JSON.stringify(nextToken),
      });
    }

    // Optionally refresh account info if we don't have tier info
    const shouldRefreshAccountInfo =
      !this.config?.tier ||
      !this.config?.tierId ||
      !this.config?.managedProjectId?.trim();

    if (shouldRefreshAccountInfo) {
      authLog.verbose(
        `${this.context.providerId}:google-gemini-oauth`,
        'Refreshing account info (managedProjectId/tier)',
      );

      const accountInfo = await fetchGeminiCliAccountInfo(refreshed.accessToken);
      const updates: Partial<GeminiCliOAuthConfig> = {};

      if (
        !this.config?.managedProjectId?.trim() &&
        accountInfo.managedProjectId?.trim()
      ) {
        updates.managedProjectId = accountInfo.managedProjectId.trim();
      }

      if (!this.config?.tier || this.config.tier !== accountInfo.tier) {
        updates.tier = accountInfo.tier;
      }

      if (!this.config?.tierId || this.config.tierId !== accountInfo.tierId) {
        updates.tierId = accountInfo.tierId;
      }

      if (Object.keys(updates).length > 0) {
        await this.persistConfig({
          ...toPersistableConfig(this.config),
          ...updates,
        });
      }
    }

    this._onDidChangeStatus.fire({ status: 'valid' });
    authLog.verbose(
      `${this.context.providerId}:google-gemini-oauth`,
      'Token refresh successful',
    );
    return true;
  }

  async revoke(): Promise<void> {
    authLog.verbose(
      `${this.context.providerId}:google-gemini-oauth`,
      'Revoking tokens',
    );
    if (!this.config) {
      authLog.verbose(
        `${this.context.providerId}:google-gemini-oauth`,
        'No config to revoke',
      );
      return;
    }

    const tokenRaw = this.config.token?.trim();
    if (tokenRaw && isSecretRef(tokenRaw)) {
      authLog.verbose(
        `${this.context.providerId}:google-gemini-oauth`,
        'Deleting token from secret storage',
      );
      await this.context.secretStore.deleteOAuth2Token(tokenRaw);
    }

    await this.persistConfig({
      ...toPersistableConfig(this.config),
      token: undefined,
      email: undefined,
      tier: undefined,
      tierId: undefined,
      managedProjectId: undefined,
    });

    this._onDidChangeStatus.fire({ status: 'revoked' });
    authLog.verbose(
      `${this.context.providerId}:google-gemini-oauth`,
      'Tokens revoked successfully',
    );
  }

  dispose(): void {
    this._onDidChangeStatus.dispose();
  }
}
