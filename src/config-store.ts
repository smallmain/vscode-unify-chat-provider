import * as vscode from 'vscode';
import { normalizeBaseUrlInput } from './utils';
import {
  ProviderConfig,
  ModelConfig,
  ModelCapabilities,
} from './client/interface';
import { Mimic, PROVIDER_TYPES, PROVIDERS, ProviderType } from './client';

const CONFIG_NAMESPACE = 'unifyChatProvider';

/**
 * Extension configuration stored in workspace settings
 */
export interface ExtensionConfiguration {
  endpoints: ProviderConfig[];
  verbose: boolean;
}

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
   * Whether verbose logging is enabled
   */
  get verbose(): boolean {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    const rawVerbose = config.get<unknown>('verbose', false);
    return typeof rawVerbose === 'boolean' ? rawVerbose : false;
  }

  /**
   * Get the full extension configuration
   */
  get configuration(): ExtensionConfiguration {
    return {
      endpoints: this.endpoints,
      verbose: this.verbose,
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

    let baseUrl: string;
    try {
      baseUrl = normalizeBaseUrlInput(obj.baseUrl);
    } catch {
      return null;
    }

    const rawModels = Array.isArray(obj.models) ? obj.models : [];
    const models: ModelConfig[] = rawModels
      .map((m: unknown) => this.normalizeModelConfig(m))
      .filter((m): m is ModelConfig => m !== null);

    // Parse and validate type
    if (
      typeof obj.type !== 'string' ||
      !PROVIDER_TYPES.includes(obj.type as ProviderType)
    ) {
      return null;
    }
    const type = obj.type as ProviderType;

    // Validate mimic option (optional, defaults to undefined)
    const supportMimics = PROVIDERS[type].supportMimics;
    const rawMimic = obj.mimic;
    const mimic: Mimic | undefined =
      typeof rawMimic === 'string' && supportMimics.includes(rawMimic as Mimic)
        ? (rawMimic as Mimic)
        : undefined;

    return {
      type: type as ProviderType,
      name: obj.name,
      baseUrl,
      apiKey: typeof obj.apiKey === 'string' ? obj.apiKey : undefined,
      models,
      mimic,
      extraHeaders:
        obj.extraHeaders && typeof obj.extraHeaders === 'object'
          ? (obj.extraHeaders as Record<string, string>)
          : undefined,
      extraBody:
        obj.extraBody && typeof obj.extraBody === 'object'
          ? (obj.extraBody as Record<string, unknown>)
          : undefined,
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
        let capabilities: ModelCapabilities | undefined;
        if (obj.capabilities && typeof obj.capabilities === 'object') {
          const caps = obj.capabilities as Record<string, unknown>;
          capabilities = {
            toolCalling:
              typeof caps.toolCalling === 'boolean' ||
              typeof caps.toolCalling === 'number'
                ? caps.toolCalling
                : undefined,
            imageInput:
              typeof caps.imageInput === 'boolean'
                ? caps.imageInput
                : undefined,
          };
        }

        return {
          id: obj.id,
          name: typeof obj.name === 'string' ? obj.name : undefined,
          family: typeof obj.family === 'string' ? obj.family : undefined,
          maxInputTokens:
            typeof obj.maxInputTokens === 'number'
              ? obj.maxInputTokens
              : undefined,
          maxOutputTokens:
            typeof obj.maxOutputTokens === 'number'
              ? obj.maxOutputTokens
              : undefined,
          capabilities,
          stream: typeof obj.stream === 'boolean' ? obj.stream : undefined,
          temperature:
            typeof obj.temperature === 'number' ? obj.temperature : undefined,
          topK: typeof obj.topK === 'number' ? obj.topK : undefined,
          topP: typeof obj.topP === 'number' ? obj.topP : undefined,
          frequencyPenalty:
            typeof obj.frequencyPenalty === 'number'
              ? obj.frequencyPenalty
              : undefined,
          presencePenalty:
            typeof obj.presencePenalty === 'number'
              ? obj.presencePenalty
              : undefined,
          verbosity:
            obj.verbosity === 'low' ||
            obj.verbosity === 'medium' ||
            obj.verbosity === 'high'
              ? obj.verbosity
              : undefined,
          parallelToolCalling:
            typeof obj.parallelToolCalling === 'boolean'
              ? obj.parallelToolCalling
              : undefined,
          thinking:
            obj.thinking && typeof obj.thinking === 'object'
              ? (() => {
                  const thinking = obj.thinking as Record<string, unknown>;
                  const effort =
                    thinking.effort === 'none' ||
                    thinking.effort === 'minimal' ||
                    thinking.effort === 'low' ||
                    thinking.effort === 'medium' ||
                    thinking.effort === 'high' ||
                    thinking.effort === 'xhigh'
                      ? thinking.effort
                      : undefined;

                  const type =
                    thinking.type === 'enabled' || thinking.type === 'disabled'
                      ? thinking.type
                      : undefined;

                  if (!type) {
                    return undefined;
                  }

                  return {
                    type,
                    budgetTokens:
                      typeof thinking.budgetTokens === 'number'
                        ? thinking.budgetTokens
                        : undefined,
                    effort,
                  };
                })()
              : undefined,
          extraHeaders:
            obj.extraHeaders && typeof obj.extraHeaders === 'object'
              ? (obj.extraHeaders as Record<string, string>)
              : undefined,
          extraBody:
            obj.extraBody && typeof obj.extraBody === 'object'
              ? (obj.extraBody as Record<string, unknown>)
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
