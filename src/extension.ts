import * as vscode from 'vscode';
import { ConfigStore } from './config-store';
import {
  ApiKeySecretStore,
  createApiKeySecretRef,
  isApiKeySecretRef,
} from './api-key-secret-store';
import { UnifyChatService } from './service';
import {
  addProvider,
  addProviderFromConfig,
  addProviderFromWellKnownList,
  exportAllProviders,
  importProviders,
  manageProviders,
  removeProvider,
} from './ui';
import { officialModelsManager } from './official-models-manager';
import { registerUriHandler } from './uri-handler';

const VENDOR_ID = 'unify-chat-provider';
const CONFIG_NAMESPACE = 'unifyChatProvider';

/**
 * Extension activation
 */
export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const configStore = new ConfigStore();
  const apiKeyStore = new ApiKeySecretStore(context.secrets);
  const chatProvider = new UnifyChatService(configStore, apiKeyStore);

  // Initialize official models manager
  await officialModelsManager.initialize(context, apiKeyStore);
  context.subscriptions.push(officialModelsManager);

  // Register the language model chat provider
  const providerRegistration = vscode.lm.registerLanguageModelChatProvider(
    VENDOR_ID,
    chatProvider,
  );
  context.subscriptions.push(providerRegistration);
  context.subscriptions.push(chatProvider);

  // Register commands
  registerCommands(context, configStore, apiKeyStore);

  // Register URI handler for importing configurations via URI
  registerUriHandler(context, configStore, apiKeyStore);

  registerApiKeyStorageMaintenance(context, configStore, apiKeyStore);
  runApiKeyStorageMaintenanceOnStartup(configStore, apiKeyStore);

  // Re-register provider when configuration changes to pick up new models
  context.subscriptions.push(
    configStore.onDidChange(() => {
      chatProvider.handleConfigurationChange();
    }),
  );

  // Re-register provider when official models are updated
  context.subscriptions.push(
    officialModelsManager.onDidUpdate(() => {
      chatProvider.handleConfigurationChange();
    }),
  );

  // Clean up config store on deactivation
  context.subscriptions.push(configStore);
}

export function registerCommands(
  context: vscode.ExtensionContext,
  configStore: ConfigStore,
  apiKeyStore: ApiKeySecretStore,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('unifyChatProvider.addProvider', () =>
      addProvider(configStore, apiKeyStore),
    ),

    vscode.commands.registerCommand('unifyChatProvider.removeProvider', () =>
      removeProvider(configStore, apiKeyStore),
    ),
    vscode.commands.registerCommand('unifyChatProvider.importConfig', () =>
      addProviderFromConfig(configStore, apiKeyStore),
    ),
    vscode.commands.registerCommand(
      'unifyChatProvider.addProviderFromWellKnownProviderList',
      () => addProviderFromWellKnownList(configStore, apiKeyStore),
    ),
    vscode.commands.registerCommand(
      'unifyChatProvider.importConfigFromOtherApplications',
      () => importProviders(configStore, apiKeyStore),
    ),
    vscode.commands.registerCommand('unifyChatProvider.exportConfig', () =>
      exportAllProviders(configStore, apiKeyStore),
    ),
    vscode.commands.registerCommand('unifyChatProvider.manageProviders', () =>
      manageProviders(configStore, apiKeyStore),
    ),
    vscode.commands.registerCommand(
      'unifyChatProvider.refreshAllProvidersOfficialModels',
      async () => {
        const providers = configStore.endpoints;
        const enabledCount = providers.filter(
          (p) => p.autoFetchOfficialModels,
        ).length;
        if (enabledCount === 0) {
          vscode.window.showInformationMessage(
            'No providers have auto-fetch official models enabled.',
          );
          return;
        }
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Refreshing official models...',
            cancellable: false,
          },
          async () => {
            await officialModelsManager.refreshAll(providers);
          },
        );
        vscode.window.showInformationMessage(
          `Refreshed official models for ${enabledCount} provider(s).`,
        );
      },
    ),
  );
}

/**
 * Extension deactivation
 */
export function deactivate(): void {
  // Cleanup handled by disposables
}

let maintenanceQueue: Promise<void> = Promise.resolve();

function enqueueMaintenance(work: () => Promise<void>): void {
  const run = async (): Promise<void> => {
    try {
      await work();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(
        `Failed to maintain API key storage: ${message}`,
        { modal: true },
      );
    }
  };
  maintenanceQueue = maintenanceQueue.then(run, run);
}

function registerApiKeyStorageMaintenance(
  context: vscode.ExtensionContext,
  configStore: ConfigStore,
  apiKeyStore: ApiKeySecretStore,
): void {
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        !e.affectsConfiguration(`${CONFIG_NAMESPACE}.storeApiKeyInSettings`)
      ) {
        return;
      }
      enqueueMaintenance(async () => {
        await migrateApiKeyStorage({
          configStore,
          apiKeyStore,
          storeApiKeyInSettings: configStore.storeApiKeyInSettings,
          showProgress: true,
        });
        await cleanupUnusedApiKeySecrets(configStore, apiKeyStore);
      });
    }),
  );
}

function runApiKeyStorageMaintenanceOnStartup(
  configStore: ConfigStore,
  apiKeyStore: ApiKeySecretStore,
): void {
  enqueueMaintenance(async () => {
    await migrateApiKeyStorage({
      configStore,
      apiKeyStore,
      storeApiKeyInSettings: configStore.storeApiKeyInSettings,
      showProgress: false,
    });
    await cleanupUnusedApiKeySecrets(configStore, apiKeyStore);
  });
}

async function migrateApiKeyStorage(options: {
  configStore: ConfigStore;
  apiKeyStore: ApiKeySecretStore;
  storeApiKeyInSettings: boolean;
  showProgress: boolean;
}): Promise<void> {
  const work = async (): Promise<void> => {
    const providers = options.configStore.endpoints;
    if (providers.length === 0) {
      return;
    }

    const updated = providers.map((p) => ({ ...p }));
    let didChange = false;
    const missingSecretProviders: string[] = [];

    for (const p of updated) {
      const status = await options.apiKeyStore.getStatus(p.apiKey);

      if (options.storeApiKeyInSettings) {
        if (status.kind === 'unset') {
          if (p.apiKey !== undefined) {
            p.apiKey = undefined;
            didChange = true;
          }
          continue;
        }
        if (status.kind === 'plain') {
          if (p.apiKey !== status.apiKey) {
            p.apiKey = status.apiKey;
            didChange = true;
          }
          continue;
        }
        if (status.kind === 'secret') {
          p.apiKey = status.apiKey;
          didChange = true;
          continue;
        }
        // missing-secret
        missingSecretProviders.push(p.name);
        if (p.apiKey !== status.ref) {
          p.apiKey = status.ref;
          didChange = true;
        }
        continue;
      }

      // Store in Secret Storage (default)
      if (status.kind === 'unset') {
        if (p.apiKey !== undefined) {
          p.apiKey = undefined;
          didChange = true;
        }
        continue;
      }
      if (status.kind === 'plain') {
        const ref = createApiKeySecretRef();
        await options.apiKeyStore.set(ref, status.apiKey);
        p.apiKey = ref;
        didChange = true;
        continue;
      }
      if (status.kind === 'secret') {
        if (p.apiKey !== status.ref) {
          p.apiKey = status.ref;
          didChange = true;
        }
        continue;
      }
      // missing-secret
      if (p.apiKey !== status.ref) {
        p.apiKey = status.ref;
        didChange = true;
      }
    }

    if (didChange) {
      await options.configStore.setEndpoints(updated);
    }
  };

  if (options.showProgress) {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Migrating API key storage...',
        cancellable: false,
      },
      work,
    );
    return;
  }

  await work();
}

function collectApiKeySecretRefsFromRawEndpoints(raw: unknown): Set<string> {
  const refs = new Set<string>();
  if (!Array.isArray(raw)) return refs;

  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const apiKey = obj['apiKey'];
    if (typeof apiKey !== 'string') continue;
    const trimmed = apiKey.trim();
    if (trimmed && isApiKeySecretRef(trimmed)) {
      refs.add(trimmed);
    }
  }

  return refs;
}

async function cleanupUnusedApiKeySecrets(
  configStore: ConfigStore,
  apiKeyStore: ApiKeySecretStore,
): Promise<void> {
  const allKeys = await apiKeyStore.keys();
  const candidateKeys = allKeys.filter((k) => isApiKeySecretRef(k));
  if (candidateKeys.length === 0) return;

  const referenced = new Set<string>();

  const addRefs = (raw: unknown) => {
    for (const ref of collectApiKeySecretRefsFromRawEndpoints(raw)) {
      referenced.add(ref);
    }
  };

  const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  const inspection = config.inspect<unknown[]>('endpoints');
  addRefs(inspection?.globalValue);
  addRefs(inspection?.workspaceValue);
  addRefs(inspection?.workspaceFolderValue);

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const folderConfig = vscode.workspace.getConfiguration(
      CONFIG_NAMESPACE,
      folder.uri,
    );
    const folderInspection = folderConfig.inspect<unknown[]>('endpoints');
    addRefs(folderInspection?.workspaceFolderValue);
  }

  const toDelete = candidateKeys.filter((ref) => !referenced.has(ref));
  if (toDelete.length === 0) return;

  await Promise.all(toDelete.map((ref) => apiKeyStore.delete(ref)));
}
