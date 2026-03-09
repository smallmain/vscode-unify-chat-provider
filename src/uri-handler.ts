import * as vscode from 'vscode';
import type { ConfigStore } from './config-store';
import type { SecretStore } from './secret';
import {
  isValidHttpUrl,
  fetchConfigFromUrl,
  decodeConfigStringToValue,
  type ConfigValue,
} from './ui/base64-config';
import { runUiStack } from './ui/router/stack-router';
import type { UiContext } from './ui/router/types';
import type { ProviderConfig } from './types';
import {
  isProviderConfigInput,
  normalizeLegacyProviderConfig,
  parseProviderConfigArray,
} from './ui/import-config';
import { t } from './i18n';
import { mainInstance } from './main-instance';
import { MainInstanceError } from './main-instance/errors';

const IMPORT_CONFIG_PATH = '/import-config';
const OAUTH_CALLBACK_PATH = '/oauth/callback';

export interface EventedUriHandler extends vscode.UriHandler {
  readonly onDidReceiveUri: vscode.Event<vscode.Uri>;
  getOAuthRedirectUri(path?: string): string;
}

class UnifiedUriHandler implements EventedUriHandler, vscode.Disposable {
  private readonly importConfigHandler: ImportConfigUriHandler;
  private readonly _onDidReceiveUri = new vscode.EventEmitter<vscode.Uri>();
  private readonly pendingOAuthCallbacks = new Map<string, string>();
  private pendingOAuthFlushTimer?: ReturnType<typeof setTimeout>;
  readonly onDidReceiveUri = this._onDidReceiveUri.event;

  constructor(
    private readonly extensionId: string,
    configStore: ConfigStore,
    secretStore: SecretStore,
  ) {
    this.importConfigHandler = new ImportConfigUriHandler(
      configStore,
      secretStore,
    );
  }

  async handleUri(uri: vscode.Uri): Promise<void> {
    this._onDidReceiveUri.fire(uri);
    const normalizedPath = uri.path.endsWith('/')
      ? uri.path.slice(0, -1)
      : uri.path;
    if (normalizedPath === OAUTH_CALLBACK_PATH) {
      const uriString = uri.toString(true);
      const forwarded = await this.tryForwardOAuthCallback(uriString);
      if (!forwarded) {
        this.pendingOAuthCallbacks.set(uriString, uriString);
        this.schedulePendingOAuthFlush();
      }
    }
    await this.importConfigHandler.handleUri(uri);
  }

  private async tryForwardOAuthCallback(uri: string): Promise<boolean> {
    try {
      await mainInstance.runInLeaderWhenAvailable(
        'oauth.uri.notify',
        { uri },
        { timeoutMs: 500, maxAttempts: 1 },
      );
      return true;
    } catch (error) {
      if (
        error instanceof MainInstanceError &&
        (error.code === 'NOT_IMPLEMENTED' ||
          error.code === 'INCOMPATIBLE_VERSION' ||
          error.code === 'NO_LEADER' ||
          error.code === 'LEADER_GONE')
      ) {
        return error.code === 'INCOMPATIBLE_VERSION';
      }
      // Best-effort: URI forwarding is only required for multi-window OAuth flows.
      return true;
    }
  }

  private schedulePendingOAuthFlush(): void {
    if (
      this.pendingOAuthCallbacks.size === 0 ||
      this.pendingOAuthFlushTimer
    ) {
      return;
    }

    this.pendingOAuthFlushTimer = setTimeout(() => {
      this.pendingOAuthFlushTimer = undefined;
      void this.flushPendingOAuthCallbacks();
    }, 250);
  }

  private async flushPendingOAuthCallbacks(): Promise<void> {
    if (this.pendingOAuthCallbacks.size === 0) {
      return;
    }

    for (const uri of Array.from(this.pendingOAuthCallbacks.keys())) {
      const forwarded = await this.tryForwardOAuthCallback(uri);
      if (forwarded) {
        this.pendingOAuthCallbacks.delete(uri);
      }
    }

    if (this.pendingOAuthCallbacks.size > 0) {
      this.schedulePendingOAuthFlush();
    }
  }

  getOAuthRedirectUri(path = '/oauth/callback'): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${vscode.env.uriScheme}://${this.extensionId}${normalizedPath}`;
  }

  dispose(): void {
    if (this.pendingOAuthFlushTimer) {
      clearTimeout(this.pendingOAuthFlushTimer);
      this.pendingOAuthFlushTimer = undefined;
    }
    this.pendingOAuthCallbacks.clear();
    this._onDidReceiveUri.dispose();
  }
}

/**
 * Decode config parameter, supporting JSON, Base64, and URL.
 */
async function decodeConfigParam(
  configParam: string,
): Promise<ConfigValue | undefined> {
  // If it's a URL, fetch and decode
  if (isValidHttpUrl(configParam)) {
    const result = await fetchConfigFromUrl(configParam);
    if (!result.ok) {
      vscode.window.showErrorMessage(
        t('Failed to fetch configuration: {0}', result.error),
      );
      return undefined;
    }
    return decodeConfigStringToValue(result.content, { allowArray: true });
  }

  // Try to decode as JSON or Base64
  return decodeConfigStringToValue(configParam, { allowArray: true });
}

/**
 * Extract override fields from query parameters.
 * All parameters except 'config' are treated as ProviderConfig field overrides.
 */
function extractOverrideFields(
  query: URLSearchParams,
): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};

  for (const [key, value] of query.entries()) {
    if (key === 'config') continue;

    // Try to parse as JSON for complex values
    try {
      overrides[key] = JSON.parse(value);
    } catch {
      // Use as string if not valid JSON
      overrides[key] = value;
    }
  }

  return overrides;
}

/**
 * Apply override fields to a config object.
 */
function applyOverrides<T extends Record<string, unknown>>(
  config: T,
  overrides: Record<string, unknown>,
): T {
  return { ...config, ...overrides };
}

/**
 * URI Handler for importing provider configurations.
 *
 * Supports:
 * - vscode://<publisher>.<extension-name>/import-config?config=<base64-config>
 * - vscode://<publisher>.<extension-name>/import-config?config=<json-config>
 * - vscode://<publisher>.<extension-name>/import-config?config=<url>
 * - vscode://<publisher>.<extension-name>/import-config?config=<config>&apiKey=ABCDE
 */
export class ImportConfigUriHandler implements vscode.UriHandler {
  constructor(
    private readonly configStore: ConfigStore,
    private readonly secretStore: SecretStore,
  ) {}

  async handleUri(uri: vscode.Uri): Promise<void> {
    // Only handle /import-config path
    if (uri.path !== IMPORT_CONFIG_PATH) {
      return;
    }

    const query = new URLSearchParams(uri.query);
    const configParam = query.get('config');

    if (!configParam) {
      vscode.window.showErrorMessage(
        t('Missing "config" parameter in import URI.'),
      );
      return;
    }

    // Show progress while decoding/fetching
    const configValue = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: t('Importing configuration...'),
        cancellable: false,
      },
      () => decodeConfigParam(configParam),
    );

    if (!configValue) {
      vscode.window.showErrorMessage(
        t('Invalid configuration. Must be a valid JSON, Base64-encoded JSON, or URL pointing to a configuration.'),
      );
      return;
    }

    // Extract override fields from query parameters
    const overrides = extractOverrideFields(query);
    const ctx: UiContext = {
      store: this.configStore,
      secretStore: this.secretStore,
    };

    // Handle array of configs
    if (Array.isArray(configValue)) {
      const configs = parseProviderConfigArray(configValue);
      if (!configs) {
        vscode.window.showErrorMessage(t('Invalid provider configuration array.'));
        return;
      }

      // Apply overrides to each config
      const mergedConfigs = configs.map((config) =>
        normalizeLegacyProviderConfig(applyOverrides(config, overrides)),
      );

      await runUiStack(ctx, {
        kind: 'importProviderConfigArray',
        configs: mergedConfigs,
      });
      return;
    }

    // Handle single config
    if (!isProviderConfigInput(configValue)) {
      vscode.window.showErrorMessage(t('Invalid provider configuration.'));
      return;
    }

    const normalizedConfig = normalizeLegacyProviderConfig(
      applyOverrides(configValue as Partial<ProviderConfig>, overrides),
    );

    await runUiStack(ctx, {
      kind: 'providerForm',
      initialConfig: normalizedConfig,
    });
  }
}

/**
 * Register the URI handler for importing configurations.
 */
export function registerUriHandler(
  context: vscode.ExtensionContext,
  configStore: ConfigStore,
  secretStore: SecretStore,
): EventedUriHandler {
  const handler = new UnifiedUriHandler(
    context.extension.id,
    configStore,
    secretStore,
  );
  context.subscriptions.push(handler);
  context.subscriptions.push(vscode.window.registerUriHandler(handler));
  return handler;
}
