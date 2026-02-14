import * as vscode from 'vscode';
import { ConfigStore } from './config-store';
import {
  SecretStore,
  migrateApiKeyToAuth,
  migrateProviderTypes,
  migrateApiKeyStorage,
  cleanupUnusedSecrets,
} from './secret';
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
import { registerUriHandler, type EventedUriHandler } from './uri-handler';
import { t } from './i18n';
import {
  AuthManager,
} from './auth';
import { balanceManager } from './balance';

const VENDOR_ID = 'unify-chat-provider';
const CONFIG_NAMESPACE = 'unifyChatProvider';

/**
 * Extension activation
 */
export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const configStore = new ConfigStore();
  const secretStore = new SecretStore(context.secrets);

  // Register URI handler (import-config + OAuth callbacks)
  const uriHandler = registerUriHandler(
    context,
    configStore,
    secretStore,
  );

  // Initialize auth system
  const authManager = new AuthManager(configStore, secretStore, uriHandler);
  context.subscriptions.push(authManager);

  await migrateProviderTypes(configStore);
  await migrateApiKeyToAuth(configStore);

  balanceManager.initialize({
    configStore,
    secretStore,
    authManager,
  });
  context.subscriptions.push(balanceManager);

  const chatProvider = new UnifyChatService(
    configStore,
    secretStore,
    authManager,
    balanceManager,
  );


  // Initialize official models manager
  await officialModelsManager.initialize(context, secretStore, authManager);
  context.subscriptions.push(officialModelsManager);

  // Register the language model chat provider
  const providerRegistration = vscode.lm.registerLanguageModelChatProvider(
    VENDOR_ID,
    chatProvider,
  );
  context.subscriptions.push(providerRegistration);
  context.subscriptions.push(chatProvider);

  // Trigger initial model cache refresh
  chatProvider.handleConfigurationChange();

  // Register commands
  registerCommands(context, configStore, secretStore, uriHandler);

  registerSecretStorageMaintenance(context, configStore, secretStore);
  runSecretStorageMaintenanceOnStartup(configStore, secretStore);

  // Re-register provider when configuration changes to pick up new models
  context.subscriptions.push(
    configStore.onDidChange(() => {
      chatProvider.handleConfigurationChange();
      enqueueMaintenance(async () => {
        await cleanupUnusedSecrets(secretStore);
      });
    }),
  );

  // Re-register provider when official models are updated
  context.subscriptions.push(
    officialModelsManager.onDidUpdate(() => {
      chatProvider.handleConfigurationChange();
    }),
  );

  // Note: Auth errors are now handled silently during passive refresh.
  // Errors are stored and shown only when user actively requests credentials
  // (e.g., when sending a chat request). See service.ts resolveProvider().

  // Clean up config store on deactivation
  context.subscriptions.push(configStore);
}

export function registerCommands(
  context: vscode.ExtensionContext,
  configStore: ConfigStore,
  secretStore: SecretStore,
  uriHandler: EventedUriHandler,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('unifyChatProvider.addProvider', () =>
      addProvider(configStore, secretStore, uriHandler),
    ),

    vscode.commands.registerCommand('unifyChatProvider.removeProvider', () =>
      removeProvider(configStore, secretStore, uriHandler),
    ),
    vscode.commands.registerCommand('unifyChatProvider.importConfig', () =>
      addProviderFromConfig(configStore, secretStore, uriHandler),
    ),
    vscode.commands.registerCommand(
      'unifyChatProvider.addProviderFromWellKnownProviderList',
      () => addProviderFromWellKnownList(configStore, secretStore, uriHandler),
    ),
    vscode.commands.registerCommand(
      'unifyChatProvider.importConfigFromOtherApplications',
      () => importProviders(configStore, secretStore, uriHandler),
    ),
    vscode.commands.registerCommand('unifyChatProvider.exportConfig', () =>
      exportAllProviders(configStore, secretStore, uriHandler),
    ),
    vscode.commands.registerCommand('unifyChatProvider.manageProviders', () =>
      manageProviders(configStore, secretStore, uriHandler),
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
            t('No providers have auto-fetch official models enabled.'),
          );
          return;
        }
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: t('Refreshing official models...'),
            cancellable: false,
          },
          async () => {
            await officialModelsManager.refreshAll(providers);
          },
        );
        vscode.window.showInformationMessage(
          t('Refreshed official models for {0} provider(s).', enabledCount),
        );
      },
    ),
    vscode.commands.registerCommand(
      'unifyChatProvider.refreshAllProvidersBalance',
      async () => {
        const providers = configStore.endpoints;
        const enabledCount = providers.filter(
          (p) => p.balanceProvider && p.balanceProvider.method !== 'none',
        ).length;

        if (enabledCount === 0) {
          vscode.window.showInformationMessage(
            t('No providers have balance monitoring configured.'),
          );
          return;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: t('Refreshing provider balances...'),
            cancellable: false,
          },
          async () => {
            await balanceManager.forceRefreshAll();
          },
        );

        vscode.window.showInformationMessage(
          t('Refreshed balances for {0} provider(s).', enabledCount),
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
        t('Failed to maintain secret storage: {0}', message),
        { modal: true },
      );
    }
  };
  maintenanceQueue = maintenanceQueue.then(run, run);
}

function registerSecretStorageMaintenance(
  context: vscode.ExtensionContext,
  configStore: ConfigStore,
  secretStore: SecretStore,
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
          secretStore,
          storeApiKeyInSettings: configStore.storeApiKeyInSettings,
          showProgress: true,
        });
        await cleanupUnusedSecrets(secretStore);
      });
    }),
  );
}

function runSecretStorageMaintenanceOnStartup(
  configStore: ConfigStore,
  secretStore: SecretStore,
): void {
  enqueueMaintenance(async () => {
    await migrateApiKeyStorage({
      configStore,
      secretStore,
      storeApiKeyInSettings: configStore.storeApiKeyInSettings,
      showProgress: false,
    });
    await cleanupUnusedSecrets(secretStore);
  });
}
