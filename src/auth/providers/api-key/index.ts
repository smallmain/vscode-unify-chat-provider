import * as vscode from 'vscode';
import { showInput } from '../../../ui/component';
import {
  AuthProvider,
  AuthProviderContext,
  AuthProviderDefinition,
  AuthConfigureResult,
  AuthStatusChange,
  AuthStatusViewItem,
  AuthUiStatusSnapshot,
} from '../../auth-provider';
import { ApiKeyAuthConfig, AuthCredential } from '../../types';
import { t } from '../../../i18n';
import {
  createSecretRef,
  isSecretRef,
  type SecretStore,
} from '../../../secret';

/**
 * API Key authentication provider implementation
 */
export class ApiKeyAuthProvider implements AuthProvider {
  static redactForExport(auth: ApiKeyAuthConfig): ApiKeyAuthConfig {
    return { ...auth, apiKey: undefined };
  }

  static async resolveForExport(
    auth: ApiKeyAuthConfig,
    secretStore: SecretStore,
  ): Promise<ApiKeyAuthConfig> {
    const status = await secretStore.getApiKeyStatus(auth.apiKey);
    if (status.kind === 'unset') {
      return { ...auth, apiKey: undefined };
    }
    if (status.kind === 'plain' || status.kind === 'secret') {
      return { ...auth, apiKey: status.apiKey };
    }
    throw new Error('Missing API key secret');
  }

  static async normalizeOnImport(
    auth: ApiKeyAuthConfig,
    options: {
      secretStore: SecretStore;
      storeSecretsInSettings: boolean;
      existing?: ApiKeyAuthConfig;
    },
  ): Promise<ApiKeyAuthConfig> {
    const status = await options.secretStore.getApiKeyStatus(auth.apiKey);

    if (options.storeSecretsInSettings) {
      if (status.kind === 'unset') {
        return { ...auth, apiKey: undefined };
      }
      if (status.kind === 'plain') {
        return { ...auth, apiKey: status.apiKey };
      }
      if (status.kind === 'secret') {
        return { ...auth, apiKey: status.apiKey };
      }
      return { ...auth, apiKey: status.ref };
    }

    if (status.kind === 'unset') {
      return { ...auth, apiKey: undefined };
    }

    if (status.kind === 'plain') {
      const existingRef =
        options.existing?.apiKey && isSecretRef(options.existing.apiKey)
          ? options.existing.apiKey
          : undefined;
      const ref = existingRef ?? createSecretRef();
      await options.secretStore.setApiKey(ref, status.apiKey);
      return { ...auth, apiKey: ref };
    }

    return { ...auth, apiKey: status.ref };
  }

  static async prepareForDuplicate(
    auth: ApiKeyAuthConfig,
    options: { secretStore: SecretStore; storeSecretsInSettings: boolean },
  ): Promise<ApiKeyAuthConfig> {
    const status = await options.secretStore.getApiKeyStatus(auth.apiKey);

    if (status.kind === 'unset' || status.kind === 'missing-secret') {
      throw new Error('Missing API key secret');
    }

    const apiKey = status.apiKey;

    if (options.storeSecretsInSettings) {
      return { ...auth, apiKey };
    }

    const ref = createSecretRef();
    await options.secretStore.setApiKey(ref, apiKey);
    return { ...auth, apiKey: ref };
  }

  getConfig(): ApiKeyAuthConfig {
    return {
      method: 'api-key',
      label: this.config?.label,
      description: this.config?.description,
      apiKey: this.config?.apiKey,
    };
  }

  async getSummaryDetail(): Promise<string | undefined> {
    const status = await this.context.secretStore.getApiKeyStatus(
      this.config?.apiKey,
    );

    switch (status.kind) {
      case 'unset':
        return t('Not configured');
      case 'plain':
        return t('Stored in settings.json');
      case 'secret':
        return t('Stored in Secret Storage');
      case 'missing-secret':
        return t('Missing, please re-enter.');
    }
  }

  async getStatusSnapshot(): Promise<AuthUiStatusSnapshot> {
    const status = await this.context.secretStore.getApiKeyStatus(
      this.config?.apiKey,
    );

    switch (status.kind) {
      case 'unset':
        return { kind: 'not-authorized' };
      case 'plain':
        return { kind: 'valid' };
      case 'secret':
        return { kind: 'valid' };
      case 'missing-secret':
        return { kind: 'missing-secret', message: t('Missing API key secret') };
    }
  }

  async getStatusViewItems(): Promise<AuthStatusViewItem[]> {
    const detail = await this.getSummaryDetail();
    const snapshot = await this.getStatusSnapshot();

    const description = (() => {
      switch (snapshot.kind) {
        case 'valid':
          return t('Configured');
        case 'missing-secret':
          return t('Missing secret');
        default:
          return t('Not configured');
      }
    })();

    return [
      {
        label: `$(key) ${this.definition.label}`,
        description,
        detail,
        action: {
          kind: 'close',
          run: async () => {
            await this.configure();
          },
        },
      },
    ];
  }

  get definition(): AuthProviderDefinition {
    return {
      id: 'api-key',
      label: this.config?.label ?? 'API Key',
      description:
        this.config?.description ?? t('Authenticate using an API key'),
    };
  }

  private readonly _onDidChangeStatus =
    new vscode.EventEmitter<AuthStatusChange>();
  readonly onDidChangeStatus = this._onDidChangeStatus.event;

  constructor(
    private readonly context: AuthProviderContext,
    private config?: ApiKeyAuthConfig,
  ) {}

  /**
   * Get the API key value (resolves secret reference if needed)
   */
  async getCredential(): Promise<AuthCredential | undefined> {
    const apiKey = this.config?.apiKey;
    if (!apiKey) {
      return undefined;
    }

    // Check if it's a secret reference
    if (isSecretRef(apiKey)) {
      const stored = await this.context.secretStore.getApiKey(apiKey);
      if (!stored) {
        return undefined;
      }
      return { value: stored };
    }

    // Plain text API key
    return { value: apiKey };
  }

  getExpiryBufferMs(): number {
    return 0;
  }

  /**
   * Check if API key is set
   */
  async isValid(): Promise<boolean> {
    const credential = await this.getCredential();
    return !!credential?.value;
  }

  /**
   * Configure API key - shows input box
   */
  async configure(): Promise<AuthConfigureResult> {
    const currentValue = await this.getCredential();

    const apiKey = await showInput({
      title: t('API Key ({0})', this.context.providerLabel),
      prompt: t('Enter the API key for "{0}"', this.context.providerLabel),
      password: true,
      ignoreFocusOut: true,
      value: currentValue?.value,
      placeHolder: t('Your API key'),
    });

    if (apiKey === undefined) {
      // User cancelled
      return { success: false };
    }

    const trimmed = apiKey.trim();
    if (!trimmed) {
      const existingRef = this.config?.apiKey;
      if (existingRef && isSecretRef(existingRef)) {
        await this.context.secretStore.deleteApiKey(existingRef);
      }

      const next: ApiKeyAuthConfig = {
        method: 'api-key',
        label: this.config?.label,
        description: this.config?.description,
        apiKey: undefined,
      };

      this.config = next;
      await this.context.persistAuthConfig?.(next);
      this._onDidChangeStatus.fire({ status: 'revoked' });

      return { success: true, config: next };
    }

    const secretRef = createSecretRef();
    await this.context.secretStore.setApiKey(secretRef, trimmed);

    const next: ApiKeyAuthConfig = {
      method: 'api-key',
      label: this.config?.label,
      description: this.config?.description,
      apiKey: secretRef,
    };

    this.config = next;
    await this.context.persistAuthConfig?.(next);
    this._onDidChangeStatus.fire({ status: 'valid' });

    return { success: true, config: next };
  }

  /**
   * Revoke/clear the API key
   */
  async revoke(): Promise<void> {
    const apiKey = this.config?.apiKey;
    if (apiKey && isSecretRef(apiKey)) {
      await this.context.secretStore.deleteApiKey(apiKey);
    }
    const next: ApiKeyAuthConfig = {
      method: 'api-key',
      label: this.config?.label,
      description: this.config?.description,
      apiKey: undefined,
    };
    this.config = next;
    await this.context.persistAuthConfig?.(next);
    this._onDidChangeStatus.fire({ status: 'revoked' });
  }

  dispose(): void {
    this._onDidChangeStatus.dispose();
  }
}
