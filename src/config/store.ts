import * as vscode from 'vscode';
import {
  ExtensionConfiguration,
  ProviderConfig,
  ModelConfig,
  ProviderType,
} from '../types';

/**
 * Valid provider types
 */
const VALID_PROVIDER_TYPES: ProviderType[] = ['anthropic'];

const CONFIG_NAMESPACE = 'unifyChatProvider';

/**
 * Manages extension configuration stored in VS Code workspace settings
 */
export class ConfigStore {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private _disposable: vscode.Disposable;

  constructor() {
    this._disposable = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(CONFIG_NAMESPACE)) {
        this._onDidChange.fire();
      }
    });
  }

  /**
   * Get all configured endpoints
   */
  get endpoints(): ProviderConfig[] {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    const rawEndpoints = config.get<unknown[]>('endpoints', []);

    return rawEndpoints
      .map((raw) => this.normalizeProviderConfig(raw))
      .filter((p): p is ProviderConfig => p !== null);
  }

  /**
   * Get the full extension configuration
   */
  get configuration(): ExtensionConfiguration {
    return {
      endpoints: this.endpoints,
    };
  }

  /**
   * Normalize raw configuration to ProviderConfig
   */
  private normalizeProviderConfig(raw: unknown): ProviderConfig | null {
    if (!raw || typeof raw !== 'object') {
      return null;
    }

    const obj = raw as Record<string, unknown>;

    if (typeof obj.name !== 'string' || !obj.name) {
      return null;
    }

    if (typeof obj.baseUrl !== 'string' || !obj.baseUrl) {
      return null;
    }

    if (!Array.isArray(obj.models) || obj.models.length === 0) {
      return null;
    }

    const models: ModelConfig[] = obj.models
      .map((m: unknown) => this.normalizeModelConfig(m))
      .filter((m): m is ModelConfig => m !== null);

    if (models.length === 0) {
      return null;
    }

    // Parse and validate type
    if (
      typeof obj.type !== 'string' ||
      !VALID_PROVIDER_TYPES.includes(obj.type as ProviderType)
    ) {
      return null;
    }
    const type = obj.type as ProviderType;

    return {
      type: type as ProviderType,
      name: obj.name,
      baseUrl: obj.baseUrl,
      apiKey: typeof obj.apiKey === 'string' ? obj.apiKey : undefined,
      models,
    };
  }

  /**
   * Normalize model configuration (supports both string and object format)
   */
  private normalizeModelConfig(raw: unknown): ModelConfig | null {
    if (typeof raw === 'string' && raw) {
      return { id: raw };
    }

    if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      if (typeof obj.id === 'string' && obj.id) {
        return {
          id: obj.id,
          name: typeof obj.name === 'string' ? obj.name : undefined,
          maxInputTokens:
            typeof obj.maxInputTokens === 'number'
              ? obj.maxInputTokens
              : undefined,
          maxOutputTokens:
            typeof obj.maxOutputTokens === 'number'
              ? obj.maxOutputTokens
              : undefined,
        };
      }
    }

    return null;
  }

  /**
   * Get a specific provider by name
   */
  getProvider(name: string): ProviderConfig | undefined {
    return this.endpoints.find((p) => p.name === name);
  }

  /**
   * Save endpoints to configuration
   * Respects the user's existing configuration level
   */
  async setEndpoints(endpoints: ProviderConfig[]): Promise<void> {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    const inspection = config.inspect<ProviderConfig[]>('endpoints');

    // Determine which configuration level to update based on where the value exists
    let target: vscode.ConfigurationTarget;
    if (inspection?.workspaceFolderValue !== undefined) {
      target = vscode.ConfigurationTarget.WorkspaceFolder;
    } else if (inspection?.workspaceValue !== undefined) {
      target = vscode.ConfigurationTarget.Workspace;
    } else if (inspection?.globalValue !== undefined) {
      target = vscode.ConfigurationTarget.Global;
    } else {
      // Default to Global when no existing configuration
      target = vscode.ConfigurationTarget.Global;
    }

    await config.update('endpoints', endpoints, target);
  }

  /**
   * Add or update a provider
   */
  async upsertProvider(provider: ProviderConfig): Promise<void> {
    const endpoints = this.endpoints.filter((p) => p.name !== provider.name);
    endpoints.push(provider);
    await this.setEndpoints(endpoints);
  }

  /**
   * Remove a provider by name
   */
  async removeProvider(name: string): Promise<void> {
    const endpoints = this.endpoints.filter((p) => p.name !== name);
    await this.setEndpoints(endpoints);
  }

  dispose(): void {
    this._disposable.dispose();
    this._onDidChange.dispose();
  }
}
