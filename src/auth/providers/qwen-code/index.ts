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
import type { AuthCredential, OAuth2TokenData, QwenCodeAuthConfig } from '../../types';
import { authLog } from '../../../logger';
import { generatePKCE } from '../../../utils';

const QWEN_OAUTH_DEVICE_CODE_ENDPOINT =
  'https://chat.qwen.ai/api/v1/oauth2/device/code';
const QWEN_OAUTH_TOKEN_ENDPOINT = 'https://chat.qwen.ai/api/v1/oauth2/token';
const QWEN_OAUTH_CLIENT_ID = 'f0304373b74a44d2b584a3fb70ca9e56';
const QWEN_OAUTH_SCOPE = 'openid profile email model.completion';
const QWEN_OAUTH_DEVICE_GRANT_TYPE =
  'urn:ietf:params:oauth:grant-type:device_code';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pickString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function pickNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

type QwenDeviceCodeResponse = {
  verificationUri: string;
  verificationUriComplete?: string;
  userCode: string;
  deviceCode: string;
  intervalSeconds: number;
  expiresInSeconds: number;
  codeVerifier: string;
};

async function requestDeviceCode(): Promise<QwenDeviceCodeResponse> {
  const pkce = generatePKCE(43);

  const params = new URLSearchParams({
    client_id: QWEN_OAUTH_CLIENT_ID,
    scope: QWEN_OAUTH_SCOPE,
    code_challenge: pkce.challenge,
    code_challenge_method: pkce.method,
  });

  const response = await fetch(QWEN_OAUTH_DEVICE_CODE_ENDPOINT, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      t(
        'Device authorization failed (HTTP {0}): {1}',
        `${response.status}`,
        text,
      ),
    );
  }

  const data: unknown = await response.json();
  if (!isRecord(data)) {
    throw new Error(t('Unexpected device code response'));
  }

  const verificationUri = pickString(data, 'verification_uri');
  const verificationUriComplete = pickString(data, 'verification_uri_complete');
  const userCode = pickString(data, 'user_code');
  const deviceCode = pickString(data, 'device_code');

  const expiresInSeconds = pickNumber(data, 'expires_in') ?? 600;
  const intervalSeconds = pickNumber(data, 'interval') ?? 5;

  if (!verificationUri || !userCode || !deviceCode) {
    throw new Error(t('Unexpected device code response'));
  }

  return {
    verificationUri,
    verificationUriComplete,
    userCode,
    deviceCode,
    intervalSeconds,
    expiresInSeconds,
    codeVerifier: pkce.verifier,
  };
}

type QwenOAuthTokenResponse = {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresInSeconds?: number;
  resourceUrl?: string;
};

type PollTokenResult =
  | { kind: 'success'; token: QwenOAuthTokenResponse }
  | { kind: 'authorization_pending' }
  | { kind: 'slow_down' }
  | { kind: 'failed'; error: string };

async function pollTokenOnce(
  deviceCode: string,
  codeVerifier: string,
): Promise<PollTokenResult> {
  const params = new URLSearchParams({
    grant_type: QWEN_OAUTH_DEVICE_GRANT_TYPE,
    client_id: QWEN_OAUTH_CLIENT_ID,
    device_code: deviceCode,
    code_verifier: codeVerifier,
  });

  const response = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  const raw = await response.text().catch(() => '');
  const payload: unknown = (() => {
    if (!raw.trim()) {
      return {};
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  })();

  if (!isRecord(payload)) {
    const msg = typeof payload === 'string' ? payload : raw;
    return {
      kind: 'failed',
      error: t(
        'Unexpected token response (HTTP {0}): {1}',
        `${response.status}`,
        msg,
      ),
    };
  }

  const accessToken = pickString(payload, 'access_token');
  if (accessToken) {
    const tokenType = pickString(payload, 'token_type') ?? 'Bearer';
    const refreshToken = pickString(payload, 'refresh_token');
    const expiresInSeconds = pickNumber(payload, 'expires_in');
    const resourceUrl = pickString(payload, 'resource_url');

    return {
      kind: 'success',
      token: {
        accessToken,
        refreshToken: refreshToken || undefined,
        tokenType,
        expiresInSeconds,
        resourceUrl: resourceUrl || undefined,
      },
    };
  }

  const error = pickString(payload, 'error');
  const errorDescription = pickString(payload, 'error_description');

  if (error === 'authorization_pending') {
    return { kind: 'authorization_pending' };
  }

  if (error === 'slow_down') {
    return { kind: 'slow_down' };
  }

  if (error === 'expired_token') {
    return {
      kind: 'failed',
      error: t('Device code expired. Please try again.'),
    };
  }

  if (error === 'access_denied') {
    return {
      kind: 'failed',
      error: t('Authorization was denied.'),
    };
  }

  if (error) {
    return {
      kind: 'failed',
      error: errorDescription ? `${error}: ${errorDescription}` : error,
    };
  }

  return { kind: 'failed', error: t('Unexpected token response') };
}

type RefreshTokenResult =
  | { kind: 'success'; token: QwenOAuthTokenResponse }
  | { kind: 'failed'; error: string };

async function refreshTokenOnce(refreshToken: string): Promise<RefreshTokenResult> {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: QWEN_OAUTH_CLIENT_ID,
  });

  const response = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  const raw = await response.text().catch(() => '');
  const payload: unknown = (() => {
    if (!raw.trim()) {
      return {};
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  })();

  if (!response.ok) {
    const msg = isRecord(payload)
      ? `${pickString(payload, 'error') ?? 'error'}${pickString(payload, 'error_description') ? `: ${pickString(payload, 'error_description')}` : ''}`
      : typeof payload === 'string'
        ? payload
        : raw;
    return {
      kind: 'failed',
      error: t(
        'Token refresh failed (HTTP {0}): {1}',
        `${response.status}`,
        msg,
      ),
    };
  }

  if (!isRecord(payload)) {
    return {
      kind: 'failed',
      error: t('Unexpected token response'),
    };
  }

  const accessToken = pickString(payload, 'access_token');
  const tokenType = pickString(payload, 'token_type') ?? 'Bearer';
  if (!accessToken) {
    return {
      kind: 'failed',
      error: t('Unexpected token response'),
    };
  }

  const newRefreshToken = pickString(payload, 'refresh_token');
  const expiresInSeconds = pickNumber(payload, 'expires_in');
  const resourceUrl = pickString(payload, 'resource_url');

  return {
    kind: 'success',
    token: {
      accessToken,
      refreshToken: newRefreshToken || undefined,
      tokenType,
      expiresInSeconds,
      resourceUrl: resourceUrl || undefined,
    },
  };
}

function normalizeResourceUrl(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const url = new URL(trimmed);
    return url.hostname || undefined;
  } catch {
    // Likely a hostname (e.g. portal.qwen.ai). Keep as-is.
    return trimmed;
  }
}

function toPersistableConfig(
  config: QwenCodeAuthConfig | undefined,
): QwenCodeAuthConfig {
  return {
    method: 'qwen-code',
    label: config?.label,
    description: config?.description,
    identityId: config?.identityId,
    token: config?.token,
    email: config?.email,
    resourceUrl: config?.resourceUrl,
  };
}

export class QwenCodeAuthProvider implements AuthProvider {
  static supportsSensitiveDataInSettings(_auth: QwenCodeAuthConfig): boolean {
    return false;
  }

  static redactForExport(auth: QwenCodeAuthConfig): QwenCodeAuthConfig {
    return { ...toPersistableConfig(auth), token: undefined };
  }

  private static isTokenData(value: unknown): value is OAuth2TokenData {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const record = value as Record<string, unknown>;
    const accessToken = record['accessToken'];
    const tokenType = record['tokenType'];
    const refreshToken = record['refreshToken'];
    const expiresAt = record['expiresAt'];
    return (
      typeof accessToken === 'string' &&
      accessToken.trim().length > 0 &&
      typeof tokenType === 'string' &&
      tokenType.trim().length > 0 &&
      (refreshToken === undefined ||
        (typeof refreshToken === 'string' && refreshToken.trim().length > 0)) &&
      (expiresAt === undefined || typeof expiresAt === 'number')
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
    auth: QwenCodeAuthConfig,
    secretStore: SecretStore,
  ): Promise<QwenCodeAuthConfig> {
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
    auth: QwenCodeAuthConfig,
    options: {
      secretStore: SecretStore;
      storeSecretsInSettings: boolean;
      existing?: QwenCodeAuthConfig;
    },
  ): Promise<QwenCodeAuthConfig> {
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
    auth: QwenCodeAuthConfig,
    options: {
      secretStore: SecretStore;
      storeSecretsInSettings: boolean;
    },
  ): Promise<QwenCodeAuthConfig> {
    const cleared: QwenCodeAuthConfig = {
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
    auth: QwenCodeAuthConfig,
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
    private config?: QwenCodeAuthConfig,
  ) {}

  get definition(): AuthProviderDefinition {
    return {
      id: 'qwen-code',
      label: this.config?.label ?? 'Qwen Code',
      description:
        this.config?.description ??
        t('Authenticate using Qwen Code device authorization flow'),
    };
  }

  getConfig(): QwenCodeAuthConfig | undefined {
    return this.config;
  }

  private async persistConfig(next: QwenCodeAuthConfig): Promise<void> {
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

    return QwenCodeAuthProvider.parseTokenData(raw);
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
      `${this.context.providerId}:qwen-code`,
      'Getting credential',
    );

    const token = await this.resolveTokenData();
    if (!token) {
      authLog.verbose(`${this.context.providerId}:qwen-code`, 'No token');
      return undefined;
    }

    const bufferMs = this.getExpiryBufferMs();
    if (this.context.secretStore.isOAuth2TokenExpired(token, bufferMs)) {
      authLog.verbose(
        `${this.context.providerId}:qwen-code`,
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
        tokenType: newToken.tokenType,
        expiresAt: newToken.expiresAt,
      };
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
    authLog.verbose(`${this.context.providerId}:qwen-code`, 'Starting OAuth');

    try {
      const device = await requestDeviceCode();

      await vscode.env.clipboard.writeText(device.userCode);

      const copyAction = t('Copy Code');
      const openAction = t('Open URL');
      const message = t(
        'Enter code {0} at {1}',
        device.userCode,
        device.verificationUri,
      );

      vscode.window
        .showInformationMessage(message, copyAction, openAction)
        .then((action) => {
          if (action === copyAction) {
            vscode.env.clipboard.writeText(device.userCode);
            return;
          }
          if (action === openAction) {
            const url =
              device.verificationUriComplete ?? device.verificationUri;
            vscode.env.openExternal(vscode.Uri.parse(url));
          }
        });

      const url = device.verificationUriComplete ?? device.verificationUri;
      await vscode.env.openExternal(vscode.Uri.parse(url));

      const token = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: t('Waiting for authorization...'),
          cancellable: true,
        },
        async (progress, cancellationToken) => {
          progress.report({
            message: t('Enter code {0} in your browser', device.userCode),
          });

          const expiresAt = Date.now() + device.expiresInSeconds * 1000;
          let intervalMs = device.intervalSeconds * 1000;

          while (Date.now() < expiresAt) {
            if (cancellationToken.isCancellationRequested) {
              return undefined;
            }

            await new Promise((resolve) => setTimeout(resolve, intervalMs));

            if (cancellationToken.isCancellationRequested) {
              return undefined;
            }

            const result = await pollTokenOnce(
              device.deviceCode,
              device.codeVerifier,
            );

            if (result.kind === 'authorization_pending') {
              continue;
            }

            if (result.kind === 'slow_down') {
              intervalMs = Math.min(Math.ceil(intervalMs * 1.5), 10_000);
              continue;
            }

            if (result.kind === 'failed') {
              throw new Error(result.error);
            }

            return result.token;
          }

          throw new Error(t('Device code expired'));
        },
      );

      if (!token) {
        authLog.verbose(`${this.context.providerId}:qwen-code`, 'Authorization cancelled by user');
        return {
          success: false,
          error: t('Authorization failed or was cancelled'),
        };
      }

      const tokenData: OAuth2TokenData = {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        tokenType: token.tokenType,
        expiresAt: token.expiresInSeconds
          ? Date.now() + token.expiresInSeconds * 1000
          : undefined,
      };

      const tokenRef = createSecretRef();
      await this.context.secretStore.setOAuth2Token(tokenRef, tokenData);

      const email = await vscode.window.showInputBox({
        prompt: t('Optional: enter your Qwen email or alias'),
        value: this.config?.email,
        ignoreFocusOut: true,
      });

      const nextConfig: QwenCodeAuthConfig = {
        method: 'qwen-code',
        label: this.config?.label,
        description: this.config?.description,
        identityId: randomUUID(),
        token: tokenRef,
        email: email?.trim() || undefined,
        resourceUrl: token.resourceUrl
          ? normalizeResourceUrl(token.resourceUrl)
          : this.config?.resourceUrl,
      };

      await this.persistConfig(nextConfig);
      this._onDidChangeStatus.fire({ status: 'valid' });

      return { success: true, config: nextConfig };
    } catch (error) {
      const message = (error as Error).message;
      authLog.error(`${this.context.providerId}:qwen-code`, message);
      return { success: false, error: t('Authorization failed: {0}', message) };
    }
  }

  async refresh(): Promise<boolean> {
    authLog.verbose(`${this.context.providerId}:qwen-code`, 'Refreshing token');
    const token = await this.resolveTokenData();
    if (!token?.refreshToken) {
      authLog.error(`${this.context.providerId}:qwen-code`, 'No refresh token');
      return false;
    }

    const refreshed = await refreshTokenOnce(token.refreshToken);
    if (refreshed.kind === 'failed') {
      this._onDidChangeStatus.fire({
        status: 'error',
        error: new Error(refreshed.error),
        errorType: 'transient_error',
      });
      return false;
    }

    const raw = this.config?.token?.trim();
    if (!raw) {
      return false;
    }

    const nextToken: OAuth2TokenData = {
      accessToken: refreshed.token.accessToken,
      refreshToken: refreshed.token.refreshToken ?? token.refreshToken,
      tokenType: refreshed.token.tokenType,
      expiresAt: refreshed.token.expiresInSeconds
        ? Date.now() + refreshed.token.expiresInSeconds * 1000
        : undefined,
    };

    if (isSecretRef(raw)) {
      await this.context.secretStore.setOAuth2Token(raw, nextToken);
    } else {
      await this.persistConfig({
        ...toPersistableConfig(this.config),
        token: JSON.stringify(nextToken),
      });
    }

    const nextResourceUrl = refreshed.token.resourceUrl
      ? normalizeResourceUrl(refreshed.token.resourceUrl)
      : undefined;
    if (nextResourceUrl && nextResourceUrl !== this.config?.resourceUrl) {
      await this.persistConfig({
        ...toPersistableConfig(this.config),
        resourceUrl: nextResourceUrl,
      });
    }

    this._onDidChangeStatus.fire({ status: 'valid' });
    return true;
  }

  async revoke(): Promise<void> {
    authLog.verbose(`${this.context.providerId}:qwen-code`, 'Revoking tokens');
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
      resourceUrl: undefined,
    });

    this._onDidChangeStatus.fire({ status: 'revoked' });
  }

  dispose(): void {
    this._onDidChangeStatus.dispose();
  }
}
