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
  normalizeLegacyApiKeyProviderConfig,
  parseProviderConfigArray,
} from './ui/import-config';
import { t } from './i18n';

const IMPORT_CONFIG_PATH = '/import-config';

export interface EventedUriHandler extends vscode.UriHandler {
  readonly onDidReceiveUri: vscode.Event<vscode.Uri>;
  getOAuthRedirectUri(path?: string): string;
}

class UnifiedUriHandler implements EventedUriHandler, vscode.Disposable {
  private readonly importConfigHandler: ImportConfigUriHandler;
  private readonly _onDidReceiveUri = new vscode.EventEmitter<vscode.Uri>();
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
    await this.importConfigHandler.handleUri(uri);
  }

  getOAuthRedirectUri(path = '/oauth/callback'): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${vscode.env.uriScheme}://${this.extensionId}${normalizedPath}`;
  }

  dispose(): void {
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
        normalizeLegacyApiKeyProviderConfig(applyOverrides(config, overrides)),
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

    const mergedConfig = normalizeLegacyApiKeyProviderConfig(
      applyOverrides(configValue as Partial<ProviderConfig>, overrides),
    );

    await runUiStack(ctx, {
      kind: 'providerForm',
      initialConfig: mergedConfig,
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
