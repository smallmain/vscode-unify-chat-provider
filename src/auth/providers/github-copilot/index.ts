import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
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
  isSessionSecretRef,
  type SecretStore,
} from '../../../secret';
import type {
  AuthCredential,
  GitHubCopilotAuthConfig,
  OAuth2TokenData,
} from '../../types';
import { authLog } from '../../../logger';
import { buildOpencodeUserAgent } from '../../../utils';

const COPILOT_GITHUB_OAUTH_CLIENT_ID = 'Ov23li8tweQw6odWQebz';
const COPILOT_GITHUB_OAUTH_SCOPE = 'read:user';
const POLL_SAFETY_BUFFER_MS = 3000;

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

function normalizeEnterpriseDomain(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }

  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    const url = new URL(withProtocol);
    if (!url.hostname) {
      return undefined;
    }
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return undefined;
  }
}

function toPersistableConfig(
  config: GitHubCopilotAuthConfig | undefined,
): GitHubCopilotAuthConfig {
  return {
    method: 'github-copilot',
    bindingId: config?.bindingId ?? randomUUID(),
    label: config?.label,
    description: config?.description,
    identityId: config?.identityId,
    token: config?.token,
    enterpriseUrl: config?.enterpriseUrl,
  };
}

type DeviceCodeResponse = {
  verificationUri: string;
  verificationUriComplete?: string;
  userCode: string;
  deviceCode: string;
  intervalSeconds: number;
  expiresInSeconds?: number;
};

async function requestDeviceCode(domain: string): Promise<DeviceCodeResponse> {
  const url = `https://${domain}/login/device/code`;

  authLog.verbose('github-copilot-auth', `Requesting device code (${url})`);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': buildOpencodeUserAgent(),
    },
    body: JSON.stringify({
      client_id: COPILOT_GITHUB_OAUTH_CLIENT_ID,
      scope: COPILOT_GITHUB_OAUTH_SCOPE,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
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
  const userCode = pickString(data, 'user_code');
  const deviceCode = pickString(data, 'device_code');
  if (!verificationUri || !userCode || !deviceCode) {
    throw new Error(t('Unexpected device code response'));
  }

  const verificationUriComplete = pickString(data, 'verification_uri_complete');

  const intervalSeconds = pickNumber(data, 'interval') ?? 5;
  const expiresInSeconds = pickNumber(data, 'expires_in');

  return {
    verificationUri,
    verificationUriComplete,
    userCode,
    deviceCode,
    intervalSeconds,
    expiresInSeconds,
  };
}

type PollTokenResult =
  | { kind: 'success'; accessToken: string; tokenType?: string }
  | { kind: 'authorization_pending' }
  | { kind: 'slow_down'; intervalSeconds?: number }
  | { kind: 'failed'; error: string };

function cancellationTokenToAbortSignal(
  token: vscode.CancellationToken,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const subscription = token.onCancellationRequested(() => {
    controller.abort();
  });
  if (token.isCancellationRequested) {
    controller.abort();
  }

  return {
    signal: controller.signal,
    dispose: () => subscription.dispose(),
  };
}

function delayUntil(ms: number, token: vscode.CancellationToken): Promise<void> {
  if (token.isCancellationRequested) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      subscription.dispose();
      resolve();
    };
    const subscription = token.onCancellationRequested(finish);
    timeout = setTimeout(finish, ms);
  });
}

async function pollAccessTokenOnce(
  domain: string,
  deviceCode: string,
  signal?: AbortSignal,
): Promise<PollTokenResult> {
  const url = `https://${domain}/login/oauth/access_token`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': buildOpencodeUserAgent(),
    },
    body: JSON.stringify({
      client_id: COPILOT_GITHUB_OAUTH_CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
    signal,
  });

  const data: unknown = await response.json().catch(async () => {
    const text = await response.text().catch(() => '');
    return { error: `HTTP ${response.status}: ${text}` };
  });

  if (!isRecord(data)) {
    return { kind: 'failed', error: t('Unexpected token response') };
  }

  const accessToken = pickString(data, 'access_token');
  if (accessToken) {
    return {
      kind: 'success',
      accessToken,
      tokenType: pickString(data, 'token_type'),
    };
  }

  const error = pickString(data, 'error');
  const errorDescription = pickString(data, 'error_description');
  const intervalSeconds = pickNumber(data, 'interval');

  if (error === 'authorization_pending') {
    return { kind: 'authorization_pending' };
  }

  if (error === 'slow_down') {
    return { kind: 'slow_down', intervalSeconds };
  }

  if (error) {
    return {
      kind: 'failed',
      error: errorDescription ? `${error}: ${errorDescription}` : error,
    };
  }

  return { kind: 'failed', error: t('Unexpected token response') };
}

export class GitHubCopilotAuthProvider implements AuthProvider {
  static supportsSensitiveDataInSettings(
    _auth: GitHubCopilotAuthConfig,
  ): boolean {
    return false;
  }

  static redactForExport(
    auth: GitHubCopilotAuthConfig,
  ): GitHubCopilotAuthConfig {
    return { ...toPersistableConfig(auth), token: undefined };
  }

  private static isTokenData(value: unknown): value is OAuth2TokenData {
    if (!isRecord(value)) {
      return false;
    }
    const accessToken = value['accessToken'];
    const tokenType = value['tokenType'];
    return (
      typeof accessToken === 'string' &&
      accessToken.trim().length > 0 &&
      typeof tokenType === 'string' &&
      tokenType.trim().length > 0
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
    auth: GitHubCopilotAuthConfig,
    secretStore: SecretStore,
  ): Promise<GitHubCopilotAuthConfig> {
    const tokenRaw = auth.token?.trim();
    if (!tokenRaw) {
      throw new Error('Missing token');
    }

    const tokenData = isSessionSecretRef(tokenRaw)
      ? await secretStore.getOAuth2Token(tokenRaw)
      : this.parseTokenData(tokenRaw);

    if (!tokenData) {
      throw new Error('Missing token');
    }

    return { ...toPersistableConfig(auth), token: JSON.stringify(tokenData) };
  }

  static async normalizeOnImport(
    auth: GitHubCopilotAuthConfig,
    options: {
      secretStore: SecretStore;
      storeSecretsInSettings: boolean;
      existing?: GitHubCopilotAuthConfig;
    },
  ): Promise<GitHubCopilotAuthConfig> {
    const secretStore = options.secretStore;

    const normalizeToken = async (): Promise<string | undefined> => {
      const raw = auth.token?.trim();
      if (!raw) {
        return undefined;
      }

      if (options.storeSecretsInSettings) {
        if (!isSessionSecretRef(raw)) {
          return raw;
        }
        const stored = await secretStore.getOAuth2Token(raw);
        return stored ? JSON.stringify(stored) : raw;
      }

      if (isSessionSecretRef(raw)) {
        return raw;
      }

      const tokenData = this.parseTokenData(raw);
      if (!tokenData) {
        return undefined;
      }

      const existingRef =
        options.existing?.token && isSessionSecretRef(options.existing.token)
          ? options.existing.token
          : undefined;

      const ref =
        existingRef ?? secretStore.createTransientOAuth2TokenRef();
      await secretStore.setOAuth2Token(ref, tokenData);
      return ref;
    };

    const token = await normalizeToken();
    return {
      ...toPersistableConfig(auth),
      identityId:
        auth.token?.trim() && !isSessionSecretRef(auth.token.trim())
          ? randomUUID()
          : auth.identityId,
      token,
    };
  }

  static async prepareForDuplicate(
    auth: GitHubCopilotAuthConfig,
    options: { secretStore: SecretStore; storeSecretsInSettings: boolean },
  ): Promise<GitHubCopilotAuthConfig> {
    const cleared: GitHubCopilotAuthConfig = {
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
    auth: GitHubCopilotAuthConfig,
    secretStore: SecretStore,
  ): Promise<void> {
    const tokenRaw = auth.token?.trim();
    if (tokenRaw && isSessionSecretRef(tokenRaw)) {
      await secretStore.deleteOAuth2Token(tokenRaw);
    }
  }

  private readonly _onDidChangeStatus =
    new vscode.EventEmitter<AuthStatusChange>();
  readonly onDidChangeStatus = this._onDidChangeStatus.event;

  constructor(
    private readonly context: AuthProviderContext,
    private config?: GitHubCopilotAuthConfig,
  ) {}

  get definition(): AuthProviderDefinition {
    return {
      id: 'github-copilot',
      label: this.config?.label ?? 'GitHub Copilot',
      description:
        this.config?.description ??
        t('Authenticate using GitHub device code flow (Copilot token)'),
    };
  }

  getConfig(): GitHubCopilotAuthConfig | undefined {
    return this.config;
  }

  private async persistConfig(
    next: GitHubCopilotAuthConfig,
    guard = this.context.captureAuthCommitGuard?.(),
  ): Promise<void> {
    await this.context.persistAuthConfig?.(next, guard);
    this.config = next;
  }

  private async resolveTokenData(): Promise<OAuth2TokenData | null> {
    const raw = this.config?.token?.trim();
    if (!raw) {
      return null;
    }

    if (isSessionSecretRef(raw)) {
      return this.context.secretStore.getOAuth2Token(raw);
    }

    return GitHubCopilotAuthProvider.parseTokenData(raw);
  }

  async getStatusSnapshot(): Promise<AuthUiStatusSnapshot> {
    if (!this.config) {
      return { kind: 'not-configured' };
    }

    const tokenRaw = this.config.token?.trim();
    if (!tokenRaw) {
      return { kind: 'not-authorized' };
    }

    if (isSessionSecretRef(tokenRaw)) {
      const token = await this.context.secretStore.getOAuth2Token(tokenRaw);
      if (!token) {
        return { kind: 'missing-secret', message: t('Missing stored token') };
      }
    }

    const token = await this.resolveTokenData();
    if (!token) {
      return { kind: 'error', message: t('Invalid token data') };
    }

    return { kind: 'valid', expiresAt: token.expiresAt };
  }

  async getSummaryDetail(): Promise<string | undefined> {
    const snapshot = await this.getStatusSnapshot();
    switch (snapshot.kind) {
      case 'not-authorized':
        return t('Not authorized');
      case 'missing-secret':
        return snapshot.message ?? t('Missing secret');
      case 'error':
        return snapshot.message ?? t('Error');
      case 'valid':
        return this.config?.enterpriseUrl
          ? t('Authorized (Enterprise)')
          : t('Authorized');
      default:
        return undefined;
    }
  }

  async getStatusViewItems(): Promise<AuthStatusViewItem[]> {
    const snapshot = await this.getStatusSnapshot();
    const detail = await this.getSummaryDetail();

    const items: AuthStatusViewItem[] = [
      {
        label: `$(shield) ${t('Authorization status')}`,
        description: detail,
      },
    ];

    items.push({
      label: `$(sign-in) ${t('Authorize...')}`,
      description: t('Sign in to GitHub and authorize Copilot'),
      action: {
        kind: 'close',
        run: async () => {
          await this.configure();
        },
      },
    });

    if (snapshot.kind === 'valid') {
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
    }

    return items;
  }

  async getCredential(): Promise<AuthCredential | undefined> {
    const token = await this.resolveTokenData();
    if (!token?.accessToken) {
      return undefined;
    }
    return {
      value: token.accessToken,
      tokenType: token.tokenType,
      expiresAt: token.expiresAt,
    };
  }

  getExpiryBufferMs(): number {
    return 0;
  }

  async isValid(): Promise<boolean> {
    return (await this.getCredential()) !== undefined;
  }

  async configure(): Promise<AuthConfigureResult> {
    const commitGuard = this.context.captureAuthCommitGuard?.();
    try {
      const picked = await vscode.window.showQuickPick(
        [
          {
            label: t('GitHub.com'),
            description: 'github.com',
            value: { domain: 'github.com' as const },
          },
          {
            label: t('GitHub Enterprise'),
            description: t('Use a GitHub Enterprise domain'),
            value: { domain: 'enterprise' as const },
          },
        ],
        {
          title: t('Select GitHub deployment'),
          ignoreFocusOut: true,
          matchOnDescription: true,
          matchOnDetail: true,
        },
      );

      if (!picked) {
        return { success: false, error: t('Cancelled') };
      }

      const enterpriseUrl =
        picked.value.domain === 'enterprise'
          ? await vscode.window.showInputBox({
              title: t('GitHub Enterprise domain'),
              prompt: t('Enter your GitHub Enterprise domain or URL'),
              ignoreFocusOut: true,
              validateInput: (value) =>
                normalizeEnterpriseDomain(value)
                  ? undefined
                  : t('Please enter a valid domain or URL'),
            })
          : undefined;

      if (picked.value.domain === 'enterprise' && !enterpriseUrl) {
        return { success: false, error: t('Cancelled') };
      }

      const enterpriseDomain = enterpriseUrl
        ? normalizeEnterpriseDomain(enterpriseUrl)
        : undefined;
      if (picked.value.domain === 'enterprise' && !enterpriseDomain) {
        return { success: false, error: t('Invalid enterprise domain') };
      }

      const oauthDomain = enterpriseDomain ?? 'github.com';

      const deviceResponse = await requestDeviceCode(oauthDomain);

      await vscode.env.clipboard.writeText(deviceResponse.userCode);

      const copyAction = t('Copy Code');
      const openAction = t('Open URL');

      const verificationUrl =
        deviceResponse.verificationUriComplete ??
        deviceResponse.verificationUri;

      vscode.window
        .showInformationMessage(
          t(
            'Enter code {0} at {1}',
            deviceResponse.userCode,
            deviceResponse.verificationUri,
          ),
          copyAction,
          openAction,
        )
        .then((action) => {
          if (action === copyAction) {
            vscode.env.clipboard.writeText(deviceResponse.userCode);
          }
          if (action === openAction) {
            vscode.env.openExternal(vscode.Uri.parse(verificationUrl));
          }
        });

      await vscode.env.openExternal(vscode.Uri.parse(verificationUrl));

      const tokenResult = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: t('Waiting for authorization...'),
          cancellable: true,
        },
        async (progress, cancellationToken) => {
          progress.report({
            message: t(
              'Enter code {0} in your browser (copied to clipboard)',
              deviceResponse.userCode,
            ),
          });

          let intervalSeconds = deviceResponse.intervalSeconds;
          const expiresAt =
            deviceResponse.expiresInSeconds !== undefined
              ? Date.now() + deviceResponse.expiresInSeconds * 1000
              : undefined;

          while (
            !cancellationToken.isCancellationRequested &&
            (expiresAt === undefined || Date.now() < expiresAt)
          ) {
            await delayUntil(
              intervalSeconds * 1000 + POLL_SAFETY_BUFFER_MS,
              cancellationToken,
            );
            if (cancellationToken.isCancellationRequested) {
              return undefined;
            }

            const abortLink =
              cancellationTokenToAbortSignal(cancellationToken);
            let result: PollTokenResult;
            try {
              result = await pollAccessTokenOnce(
                oauthDomain,
                deviceResponse.deviceCode,
                abortLink.signal,
              );
            } finally {
              abortLink.dispose();
            }

            if (result.kind === 'success') {
              return result;
            }

            if (result.kind === 'authorization_pending') {
              continue;
            }

            if (result.kind === 'slow_down') {
              if (result.intervalSeconds !== undefined) {
                intervalSeconds = result.intervalSeconds;
              } else {
                intervalSeconds = intervalSeconds + 5;
              }
              continue;
            }

            throw new Error(result.error);
          }

          return undefined;
        },
      );

      if (!tokenResult) {
        return { success: false, error: t('Cancelled') };
      }

      const tokenRef =
        this.context.secretStore.createTransientOAuth2TokenRef();
      const tokenData: OAuth2TokenData = {
        accessToken: tokenResult.accessToken,
        refreshToken: tokenResult.accessToken,
        tokenType: 'Bearer',
        expiresAt: undefined,
      };
      await this.context.secretStore.setOAuth2Token(tokenRef, tokenData);

      const nextConfig: GitHubCopilotAuthConfig = {
        method: 'github-copilot',
        bindingId: this.config?.bindingId ?? randomUUID(),
        label: this.config?.label,
        description: this.config?.description,
        identityId: randomUUID(),
        token: tokenRef,
        enterpriseUrl: enterpriseDomain,
      };

      await this.persistConfig(nextConfig, commitGuard);
      this._onDidChangeStatus.fire({ status: 'valid' });

      vscode.window.showInformationMessage(t('Authorization successful!'));
      return { success: true, config: nextConfig };
    } catch (error) {
      const err =
        error instanceof Error ? error : new Error(String(error ?? ''));
      const message = err.message || t('Unknown error');
      authLog.error('github-copilot-auth', 'Configuration failed', error);
      this._onDidChangeStatus.fire({
        status: 'error',
        error: err,
        errorType: 'unknown_error',
      });
      vscode.window.showErrorMessage(t('Authorization failed: {0}', message));
      return { success: false, error: message };
    }
  }

  async revoke(): Promise<void> {
    const commitGuard = this.context.captureAuthCommitGuard?.();
    const oldTokenRef = this.config?.token?.trim();
    const nextConfig: GitHubCopilotAuthConfig = {
      method: 'github-copilot',
      bindingId: this.config?.bindingId ?? randomUUID(),
      label: this.config?.label,
      description: this.config?.description,
      identityId: this.config?.identityId,
      token: undefined,
      enterpriseUrl: this.config?.enterpriseUrl,
    };

    await this.persistConfig(nextConfig, commitGuard);
    if (oldTokenRef && isSessionSecretRef(oldTokenRef)) {
      await this.context.secretStore.discardOAuth2TokenRef(oldTokenRef);
    }
    this._onDidChangeStatus.fire({ status: 'revoked' });
  }
}
