import * as vscode from 'vscode';
import {
  AuthProvider,
  AuthProviderContext,
  AuthProviderDefinition,
  AuthConfigureResult,
  AuthStatusChange,
  AuthErrorType,
  AuthStatusViewItem,
  AuthUiStatusSnapshot,
} from '../../auth-provider';
import { randomUUID } from 'crypto';
import { OAuth2AuthConfig, OAuth2Config, AuthCredential, OAuth2TokenData } from '../../types';
import {
  getClientCredentialsToken,
  refreshToken,
  revokeToken,
} from './oauth2-client';
import { showOAuth2ConfigScreen } from './screens/config-screen';
import { performAuthorization } from './screens/authorize-screen';
import { t } from '../../../i18n';
import { OAuth2Error } from './errors';
import { withRetry, withTimeout } from './retry';
import { createSecretRef, isSecretRef, type SecretStore } from '../../../secret';

/**
 * OAuth 2.0 authentication provider implementation
 */
export class OAuth2AuthProvider implements AuthProvider {
  static redactForExport(auth: OAuth2AuthConfig): OAuth2AuthConfig {
    const oauth = auth.oauth;

    const redactedOAuth: OAuth2Config = (() => {
      if (oauth.grantType === 'authorization_code') {
        return { ...oauth, clientSecret: undefined };
      }
      if (oauth.grantType === 'client_credentials') {
        return { ...oauth, clientSecret: '' };
      }
      return oauth;
    })();

    return { ...auth, token: undefined, oauth: redactedOAuth };
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
    auth: OAuth2AuthConfig,
    secretStore: SecretStore,
  ): Promise<OAuth2AuthConfig> {
    const tokenRaw = auth.token?.trim();
    if (!tokenRaw) {
      throw new Error('Missing OAuth2 token');
    }

    const tokenData = isSecretRef(tokenRaw)
      ? await secretStore.getOAuth2Token(tokenRaw)
      : this.parseTokenData(tokenRaw);

    if (!tokenData) {
      throw new Error('Missing OAuth2 token');
    }

    const oauth = auth.oauth;

    const resolvedOAuth: OAuth2Config = await (async () => {
      if (oauth.grantType === 'authorization_code') {
        const clientSecretRaw = oauth.clientSecret?.trim();
        if (!clientSecretRaw) {
          return { ...oauth, clientSecret: undefined };
        }
        if (isSecretRef(clientSecretRaw)) {
          const stored = await secretStore.getOAuth2ClientSecret(clientSecretRaw);
          if (!stored) {
            throw new Error('Missing OAuth2 client secret');
          }
          return { ...oauth, clientSecret: stored };
        }
        return oauth;
      }

      if (oauth.grantType === 'client_credentials') {
        const clientSecretRaw = oauth.clientSecret.trim();
        if (!clientSecretRaw) {
          throw new Error('Missing OAuth2 client secret');
        }
        if (isSecretRef(clientSecretRaw)) {
          const stored = await secretStore.getOAuth2ClientSecret(clientSecretRaw);
          if (!stored) {
            throw new Error('Missing OAuth2 client secret');
          }
          return { ...oauth, clientSecret: stored };
        }
        return oauth;
      }

      return oauth;
    })();

    return {
      ...auth,
      token: JSON.stringify(tokenData),
      oauth: resolvedOAuth,
    };
  }

  static async normalizeOnImport(
    auth: OAuth2AuthConfig,
    options: {
      secretStore: SecretStore;
      storeSecretsInSettings: boolean;
      existing?: OAuth2AuthConfig;
    },
  ): Promise<OAuth2AuthConfig> {
    const secretStore = options.secretStore;

    const normalizeToken = async (): Promise<string | undefined> => {
      const tokenRaw = auth.token?.trim();
      if (!tokenRaw) {
        return undefined;
      }

      if (options.storeSecretsInSettings) {
        if (!isSecretRef(tokenRaw)) {
          return tokenRaw;
        }
        const stored = await secretStore.getOAuth2Token(tokenRaw);
        return stored ? JSON.stringify(stored) : tokenRaw;
      }

      if (isSecretRef(tokenRaw)) {
        return tokenRaw;
      }

      const tokenData = this.parseTokenData(tokenRaw);
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

    const normalizeClientSecret = async (oauth: OAuth2Config): Promise<OAuth2Config> => {
      if (oauth.grantType === 'authorization_code') {
        const raw = oauth.clientSecret?.trim();
        if (!raw) {
          return { ...oauth, clientSecret: undefined };
        }

        if (options.storeSecretsInSettings) {
          if (!isSecretRef(raw)) {
            return oauth;
          }
          const stored = await secretStore.getOAuth2ClientSecret(raw);
          return stored ? { ...oauth, clientSecret: stored } : oauth;
        }

        if (isSecretRef(raw)) {
          return oauth;
        }

        const existingOAuth = options.existing?.oauth;
        const existingRef =
          existingOAuth?.grantType === 'authorization_code' &&
          existingOAuth.clientSecret &&
          isSecretRef(existingOAuth.clientSecret)
            ? existingOAuth.clientSecret
            : undefined;

        const ref = existingRef ?? secretStore.createRef();
        await secretStore.setOAuth2ClientSecret(ref, raw);
        return { ...oauth, clientSecret: ref };
      }

      if (oauth.grantType === 'client_credentials') {
        const raw = oauth.clientSecret.trim();

        if (options.storeSecretsInSettings) {
          if (!isSecretRef(raw)) {
            return oauth;
          }
          const stored = await secretStore.getOAuth2ClientSecret(raw);
          return stored ? { ...oauth, clientSecret: stored } : oauth;
        }

        if (isSecretRef(raw)) {
          return oauth;
        }

        const existingOAuth = options.existing?.oauth;
        const existingRef =
          existingOAuth?.grantType === 'client_credentials' &&
          isSecretRef(existingOAuth.clientSecret)
            ? existingOAuth.clientSecret
            : undefined;

        const ref = existingRef ?? secretStore.createRef();
        await secretStore.setOAuth2ClientSecret(ref, raw);
        return { ...oauth, clientSecret: ref };
      }

      return oauth;
    };

    const token = await normalizeToken();
    const oauth = await normalizeClientSecret(auth.oauth);

    return { ...auth, token, oauth };
  }

  static async prepareForDuplicate(
    auth: OAuth2AuthConfig,
    options: {
      secretStore: SecretStore;
      storeSecretsInSettings: boolean;
    },
  ): Promise<OAuth2AuthConfig> {
    const cleared: OAuth2AuthConfig = { ...auth, token: undefined };
    if (!options.storeSecretsInSettings) {
      return cleared;
    }

    return this.normalizeOnImport(cleared, {
      secretStore: options.secretStore,
      storeSecretsInSettings: true,
    });
  }

  private readonly _onDidChangeStatus =
    new vscode.EventEmitter<AuthStatusChange>();
  readonly onDidChangeStatus = this._onDidChangeStatus.event;

  constructor(
    private readonly context: AuthProviderContext,
    private config?: OAuth2AuthConfig,
  ) {}

  private isTokenData(value: unknown): value is OAuth2TokenData {
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

  private parseTokenData(raw: string): OAuth2TokenData | null {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!this.isTokenData(parsed)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private async resolveTokenData(): Promise<OAuth2TokenData | null> {
    const raw = this.config?.token?.trim();
    if (!raw) {
      return null;
    }

    if (isSecretRef(raw)) {
      return this.context.secretStore.getOAuth2Token(raw);
    }

    return this.parseTokenData(raw);
  }

  private async persistConfig(next: OAuth2AuthConfig): Promise<void> {
    this.config = next;
    await this.context.persistAuthConfig?.(next);
  }

  private async storeTokenData(token: OAuth2TokenData): Promise<void> {
    if (!this.config) {
      return;
    }

    const raw = this.config.token?.trim();

    if (raw && isSecretRef(raw)) {
      await this.context.secretStore.setOAuth2Token(raw, token);
      return;
    }

    await this.persistConfig({ ...this.config, token: JSON.stringify(token) });
  }

  private async clearTokenData(): Promise<void> {
    if (!this.config) {
      return;
    }

    const raw = this.config.token?.trim();
    if (raw && isSecretRef(raw)) {
      await this.context.secretStore.deleteOAuth2Token(raw);
    }

    await this.persistConfig({ ...this.config, token: undefined });
  }

  private async resolveOAuthConfig(): Promise<OAuth2Config | undefined> {
    const oauth = this.config?.oauth;
    if (!oauth) {
      return undefined;
    }

    if (oauth.grantType === 'authorization_code') {
      const secret = oauth.clientSecret?.trim();
      if (secret && isSecretRef(secret)) {
        const stored = await this.context.secretStore.getOAuth2ClientSecret(secret);
        if (!stored) {
          return undefined;
        }
        return { ...oauth, clientSecret: stored };
      }
      return oauth;
    }

    if (oauth.grantType === 'client_credentials') {
      const secret = oauth.clientSecret.trim();
      if (isSecretRef(secret)) {
        const stored = await this.context.secretStore.getOAuth2ClientSecret(secret);
        if (!stored) {
          return undefined;
        }
        return { ...oauth, clientSecret: stored };
      }
      return oauth;
    }

    return oauth;
  }

  get definition(): AuthProviderDefinition {
    return {
      id: 'oauth2',
      label: this.config?.label ?? 'OAuth 2.0',
      description:
        this.config?.description ?? t('Authenticate using OAuth 2.0'),
    };
  }

  getConfig(): OAuth2AuthConfig | undefined {
    return this.config;
  }

  private formatExpiresIn(expiresAt: number): string {
    const remainingMs = expiresAt - Date.now();
    if (remainingMs <= 0) {
      return t('Expired');
    }

    if (remainingMs < 60_000) {
      return t('Expires in {0}s', Math.ceil(remainingMs / 1000));
    }

    if (remainingMs < 3_600_000) {
      return t('Expires in {0}m', Math.ceil(remainingMs / 60_000));
    }

    return t('Expires in {0}h', Math.ceil(remainingMs / 3_600_000));
  }

  async getStatusSnapshot(): Promise<AuthUiStatusSnapshot> {
    if (!this.config?.oauth) {
      return { kind: 'not-configured' };
    }

    const resolvedOAuth = await this.resolveOAuthConfig();
    if (!resolvedOAuth) {
      return { kind: 'missing-secret', message: t('OAuth client secret is missing') };
    }

    const raw = this.config.token?.trim();
    if (!raw) {
      return { kind: 'not-authorized' };
    }

    let token: OAuth2TokenData | null = null;

    if (isSecretRef(raw)) {
      token = await this.context.secretStore.getOAuth2Token(raw);
      if (!token) {
        return { kind: 'missing-secret', message: t('OAuth token is missing') };
      }
    } else {
      token = this.parseTokenData(raw);
      if (!token) {
        return { kind: 'error', message: t('Invalid token data') };
      }
    }

    const expiresAt = token.expiresAt;

    if (expiresAt !== undefined && this.context.secretStore.isOAuth2TokenExpired(token, 0)) {
      return { kind: 'expired', refreshable: this.canRefresh(token), expiresAt };
    }

    return { kind: 'valid', expiresAt };
  }

  async getSummaryDetail(): Promise<string | undefined> {
    const snapshot = await this.getStatusSnapshot();

    switch (snapshot.kind) {
      case 'not-configured':
        return t('Not configured');
      case 'not-authorized':
        return t('Not authorized');
      case 'missing-secret':
        return snapshot.message ?? t('Missing secret');
      case 'error':
        return snapshot.message ?? t('Error');
      case 'expired':
        return snapshot.expiresAt !== undefined
          ? snapshot.refreshable
            ? t('{0} (refreshable)', this.formatExpiresIn(snapshot.expiresAt))
            : this.formatExpiresIn(snapshot.expiresAt)
          : snapshot.refreshable
            ? t('Expired (refreshable)')
            : t('Expired');
      case 'valid':
        return snapshot.expiresAt !== undefined
          ? this.formatExpiresIn(snapshot.expiresAt)
          : t('Authorized');
    }
  }

  async getStatusViewItems(): Promise<AuthStatusViewItem[]> {
    const snapshot = await this.getStatusSnapshot();
    const detail = await this.getSummaryDetail();

    const description = (() => {
      switch (snapshot.kind) {
        case 'valid':
          return t('Authorized');
        case 'expired':
          return snapshot.refreshable ? t('Expired (refreshable)') : t('Expired');
        case 'missing-secret':
          return t('Missing secret');
        case 'not-authorized':
          return t('Not authorized');
        case 'not-configured':
          return t('Not configured');
        case 'error':
          return t('Error');
      }
    })();

    const items: AuthStatusViewItem[] = [
      {
        label: `$(shield) ${t('Authorization status')}`,
        description,
        detail,
        action: (() => {
          const shouldRefresh =
            snapshot.kind === 'valid' ||
            (snapshot.kind === 'expired' && snapshot.refreshable);

          if (shouldRefresh) {
            return {
              kind: 'inline' as const,
              run: async () => {
                const ok = await this.refresh();
                if (!ok) {
                  vscode.window.showErrorMessage(
                    t('Failed to refresh token. Re-authorize may be required.'),
                  );
                }
              },
            };
          }

          return {
            kind: 'close' as const,
            run: async () => {
              const result = await this.configure();
              if (!result.success && result.error) {
                vscode.window.showErrorMessage(result.error);
              }
            },
          };
        })(),
      },
    ];

    if (snapshot.kind === 'valid') {
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
    }

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

  /**
   * Get valid access token (handles refresh automatically)
   */
  async getCredential(): Promise<AuthCredential | undefined> {
    const token = await this.resolveTokenData();
    if (!token) {
      return undefined;
    }

    // Check if token is expired or about to expire
    const bufferMs = this.getExpiryBufferMs();
    if (this.context.secretStore.isOAuth2TokenExpired(token, bufferMs)) {
      try {
        const refreshed = await this.refresh();
        if (refreshed) {
          const newToken = await this.resolveTokenData();
          if (newToken?.accessToken) {
            return {
              value: newToken.accessToken,
              tokenType: newToken.tokenType,
              expiresAt: newToken.expiresAt,
            };
          }
        }
      } catch {
        // handled below
      }

      this._onDidChangeStatus.fire({ status: 'expired' });
      return undefined;
    }

    return {
      value: token.accessToken,
      tokenType: token.tokenType,
      expiresAt: token.expiresAt,
    };
  }

  getExpiryBufferMs(): number {
    return 5 * 60 * 1000;
  }

  /**
   * Check if authentication is valid
   */
  async isValid(): Promise<boolean> {
    const token = await this.resolveTokenData();
    if (!token) {
      return false;
    }

    // Token exists but may be expired
    if (this.context.secretStore.isOAuth2TokenExpired(token, 0)) {
      return this.canRefresh(token);
    }

    return true;
  }

  private canRefresh(token: { refreshToken?: string } | undefined): boolean {
    if (!this.config?.oauth) {
      return false;
    }

    if (this.config.oauth.grantType === 'authorization_code') {
      return !!token?.refreshToken;
    }

    if (this.config.oauth.grantType === 'client_credentials') {
      return true;
    }

    return false;
  }

  /**
   * Configure OAuth 2.0
   */
  async configure(): Promise<AuthConfigureResult> {
    const oauthConfig: OAuth2Config | undefined = await showOAuth2ConfigScreen(
      this.config?.oauth,
    );

    if (!oauthConfig) {
      return { success: false };
    }

    // Perform authorization flow
    const token = await performAuthorization(
      oauthConfig,
      this.context.uriHandler,
    );
    if (!token) {
      return {
        success: false,
        error: t('Authorization failed or was cancelled'),
      };
    }

    const tokenRef = createSecretRef();
    await this.context.secretStore.setOAuth2Token(tokenRef, token);

    let storedOAuthConfig: OAuth2Config = oauthConfig;

    if (oauthConfig.grantType === 'authorization_code') {
      const clientSecret = oauthConfig.clientSecret?.trim() || undefined;
      if (clientSecret) {
        const ref = createSecretRef();
        await this.context.secretStore.setOAuth2ClientSecret(ref, clientSecret);
        storedOAuthConfig = { ...oauthConfig, clientSecret: ref };
      } else {
        storedOAuthConfig = { ...oauthConfig, clientSecret: undefined };
      }
    } else if (oauthConfig.grantType === 'client_credentials') {
      const clientSecret = oauthConfig.clientSecret.trim();
      const ref = createSecretRef();
      await this.context.secretStore.setOAuth2ClientSecret(ref, clientSecret);
      storedOAuthConfig = { ...oauthConfig, clientSecret: ref };
    }

    const nextConfig: OAuth2AuthConfig = {
      method: 'oauth2',
      label: this.config?.label,
      description: this.config?.description,
      identityId: randomUUID(),
      token: tokenRef,
      oauth: storedOAuthConfig,
    };

    await this.persistConfig(nextConfig);
    this._onDidChangeStatus.fire({ status: 'valid' });

    return {
      success: true,
      config: nextConfig,
    };
  }

  /**
   * Refresh the access token with retry and exponential backoff
   */
  async refresh(): Promise<boolean> {
    try {
      const oauth = await this.resolveOAuthConfig();
      if (!oauth) {
        return false;
      }

      const shouldRetry = (error: unknown): boolean => {
        return error instanceof OAuth2Error && error.retryable;
      };

      if (oauth.grantType === 'authorization_code') {
        const token = await this.resolveTokenData();
        if (!token?.refreshToken) {
          return false;
        }
        const storedRefreshToken = token.refreshToken;
        const newToken = await withRetry(
          (signal) => refreshToken(oauth, storedRefreshToken, signal),
          shouldRetry,
        );
        if (!newToken.refreshToken) {
          newToken.refreshToken = storedRefreshToken;
        }
        await this.storeTokenData(newToken);
        this._onDidChangeStatus.fire({ status: 'valid' });
        return true;
      }

      if (oauth.grantType === 'client_credentials') {
        const newToken = await withRetry(
          (signal) => getClientCredentialsToken(oauth, signal),
          shouldRetry,
        );
        await this.storeTokenData(newToken);
        this._onDidChangeStatus.fire({ status: 'valid' });
        return true;
      }

      return false;
    } catch (error) {
      const errorType: AuthErrorType =
        error instanceof OAuth2Error ? error.type : 'unknown_error';
      this._onDidChangeStatus.fire({
        status: 'error',
        error: error as Error,
        errorType,
      });
      return false;
    }
  }

  /**
   * Revoke/clear OAuth tokens
   */
  async revoke(): Promise<void> {
    const token = await this.resolveTokenData();
    const oauth = await this.resolveOAuthConfig();

    if (token && oauth?.revocationUrl) {
      // Best-effort remote revocation before clearing local tokens.
      const attempt = async (
        tokenValue: string,
        hint: 'access_token' | 'refresh_token',
      ): Promise<void> => {
        await withTimeout(
          (signal) => revokeToken(oauth, tokenValue, hint, signal),
          10_000,
        );
      };

      if (token.refreshToken) {
        try {
          await attempt(token.refreshToken, 'refresh_token');
        } catch {
          // ignore
        }
      }

      if (token.accessToken) {
        try {
          await attempt(token.accessToken, 'access_token');
        } catch {
          // ignore
        }
      }
    }

    await this.clearTokenData();
    this._onDidChangeStatus.fire({ status: 'revoked' });
  }

  dispose(): void {
    this._onDidChangeStatus.dispose();
  }
}
