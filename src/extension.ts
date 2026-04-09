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
  manageBalances,
  manageProviders,
  removeProvider,
} from './ui';
import { officialModelsManager } from './official-models-manager';
import { registerUriHandler, type EventedUriHandler } from './uri-handler';
import { t } from './i18n';
import { AuthManager } from './auth';
import { balanceManager } from './balance';
import { registerBalanceStatusBar } from './ui/balance-status-bar';
import { mainInstance } from './main-instance';
import {
  ensureMainInstanceCompatibility,
  showMainInstanceCompatibilityWarning,
} from './main-instance/compatibility';
import { registerMainInstanceHandlers } from './main-instance/register-handlers';
import { authLog } from './logger';
import { webSocketSessionManager } from './client/websocket-session-manager';
import { syncBuiltInParamsToAllConfigs } from './sync-built-in-model-params';
import {
  disposeContextWindowHookBridge,
  initializeContextWindowHookBridge,
} from './context-window-hook-bridge';

const VENDOR_ID = 'unify-chat-provider';
const CONFIG_NAMESPACE = 'unifyChatProvider';

/**
 * Extension activation
 */
export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  await mainInstance.initialize(context);
  context.subscriptions.push(mainInstance);

  const configStore = new ConfigStore();
  const secretStore = new SecretStore(context.secrets);
  registerIgnoredScopeConfigurationWarning(context, configStore);

  // Register URI handler (import-config + OAuth callbacks)
  const uriHandler = registerUriHandler(context, configStore, secretStore);

  // Initialize auth system
  const authManager = new AuthManager(configStore, secretStore, uriHandler);
  context.subscriptions.push(authManager);
  let mainInstanceHandlersRegistered = false;
  let leaderStartupReady = false;
  let leaderPromotionPromise: Promise<void> | undefined;
  let leaderPromotionRetryTimer: ReturnType<typeof setTimeout> | undefined;

  const runLeaderStartupMigrations = async (): Promise<void> => {
    if (!mainInstance.isLeader()) {
      authLog.verbose(
        'main-instance',
        'Skipping leader startup migrations because this instance is not leader',
      );
      return;
    }
    authLog.verbose('main-instance', 'Running leader startup migrations');
    await migrateProviderTypes(configStore);
    await migrateApiKeyToAuth(configStore);
    authLog.verbose('main-instance', 'Leader startup migrations completed');
  };

  const setMainInstanceReadyIfPossible = (): void => {
    if (
      !mainInstanceHandlersRegistered ||
      !leaderStartupReady ||
      !mainInstance.isLeader()
    ) {
      authLog.verbose(
        'main-instance',
        'Deferring leader ready state until startup prerequisites are satisfied',
        {
          mainInstanceHandlersRegistered,
          leaderStartupReady,
          isLeader: mainInstance.isLeader(),
        },
      );
      return;
    }
    if (leaderPromotionRetryTimer) {
      clearTimeout(leaderPromotionRetryTimer);
      leaderPromotionRetryTimer = undefined;
    }
    authLog.verbose('main-instance', 'Marking leader as ready');
    mainInstance.setReady(true);
  };

  const scheduleLeaderPromotionRetry = (error: unknown): void => {
    leaderStartupReady = false;
    authLog.error(
      'main-instance',
      'Leader promotion finalization failed; scheduling retry',
      error,
    );
    if (!mainInstance.isLeader() || leaderPromotionRetryTimer) {
      return;
    }
    leaderPromotionRetryTimer = setTimeout(() => {
      leaderPromotionRetryTimer = undefined;
      if (!mainInstance.isLeader() || leaderStartupReady) {
        return;
      }
      void ensureLeaderPromotionFinalized().catch((retryError) => {
        scheduleLeaderPromotionRetry(retryError);
      });
    }, 1_000);
  };

  const finalizeLeaderPromotion = async (): Promise<void> => {
    if (!mainInstance.isLeader()) {
      authLog.verbose(
        'main-instance',
        'Skipping leader promotion finalization because this instance is not leader',
      );
      return;
    }
    authLog.verbose('main-instance', 'Finalizing leader promotion');
    await runLeaderStartupMigrations();
    if (!mainInstance.isLeader()) {
      leaderStartupReady = false;
      authLog.verbose(
        'main-instance',
        'Leader promotion interrupted before startup finished',
      );
      return;
    }
    leaderStartupReady = true;
    authLog.verbose(
      'main-instance',
      'Leader startup marked ready; scheduling secret storage maintenance',
    );
    runSecretStorageMaintenanceOnStartup(configStore, secretStore);
    setMainInstanceReadyIfPossible();
  };

  const ensureLeaderPromotionFinalized = (): Promise<void> => {
    if (!mainInstance.isLeader()) {
      authLog.verbose(
        'main-instance',
        'Skipping leader promotion finalization request because this instance is not leader',
      );
      return Promise.resolve();
    }
    if (leaderPromotionPromise) {
      authLog.verbose(
        'main-instance',
        'Leader promotion finalization already in progress; joining existing promise',
      );
      return leaderPromotionPromise;
    }
    authLog.verbose('main-instance', 'Starting leader promotion finalization');
    leaderPromotionPromise = finalizeLeaderPromotion().finally(() => {
      authLog.verbose('main-instance', 'Leader promotion finalization settled');
      leaderPromotionPromise = undefined;
    });
    return leaderPromotionPromise;
  };

  context.subscriptions.push(
    mainInstance.onDidChangeRole((snapshot) => {
      authLog.verbose('main-instance', 'Observed main-instance role change', snapshot);
      if (snapshot.role !== 'leader') {
        leaderStartupReady = false;
        if (leaderPromotionRetryTimer) {
          clearTimeout(leaderPromotionRetryTimer);
          leaderPromotionRetryTimer = undefined;
        }
        return;
      }
      if (snapshot.ready) {
        return;
      }
      leaderStartupReady = false;
      void ensureLeaderPromotionFinalized().catch((error) => {
        scheduleLeaderPromotionRetry(error);
      });
    }),
  );
  context.subscriptions.push(
    new vscode.Disposable(() => {
      if (leaderPromotionRetryTimer) {
        clearTimeout(leaderPromotionRetryTimer);
        leaderPromotionRetryTimer = undefined;
      }
    }),
  );
  if (mainInstance.isLeader()) {
    await ensureLeaderPromotionFinalized();
  }

  await balanceManager.initialize({
    configStore,
    secretStore,
    authManager,
    extensionContext: context,
  });
  context.subscriptions.push(balanceManager);
  context.subscriptions.push(webSocketSessionManager);

  const chatProvider = new UnifyChatService(
    configStore,
    secretStore,
    authManager,
    balanceManager,
  );

  let contextWindowHookInitialization: Promise<boolean> | undefined;
  let contextWindowHookTouched = false;

  const ensureContextWindowHookInitialized = (): void => {
    if (
      !configStore.fix001ContextIndicatorDisplay ||
      contextWindowHookInitialization
      ) {
      return;
    }

    contextWindowHookTouched = true;
    contextWindowHookInitialization = initializeContextWindowHookBridge()
      .then((success) => {
        if (!success) {
          contextWindowHookInitialization = undefined;
        }
        console.log(
          '[UnifyChatProvider] Context window hook initialized:',
          success,
        );
        return success;
      })
      .catch((error) => {
        contextWindowHookInitialization = undefined;
        console.error(
          '[UnifyChatProvider] Failed to initialize context window hook:',
          error,
        );
        return false;
      });
  };

  const disposeContextWindowHook = (): void => {
    if (!contextWindowHookTouched) {
      return;
    }

    contextWindowHookInitialization = undefined;
    disposeContextWindowHookBridge()
      .then((disposed) => {
        console.log(
          '[UnifyChatProvider] Context window hook disposed:',
          disposed,
        );
      })
      .catch((error) => {
        console.warn(
          '[UnifyChatProvider] Failed to dispose context window hook:',
          error,
        );
      });
  };

  const syncContextWindowHook = (): void => {
    if (configStore.fix001ContextIndicatorDisplay) {
      ensureContextWindowHookInitialized();
      return;
    }

    disposeContextWindowHook();
  };

  // Initialize context window hook to try to inject usage data
  // into VS Code's context window widget when the compatibility fix is enabled.
  syncContextWindowHook();

  // Initialize official models manager
  await officialModelsManager.initialize(
    context,
    configStore,
    secretStore,
    authManager,
    uriHandler,
  );
  context.subscriptions.push(officialModelsManager);

  registerMainInstanceHandlers({
    configStore,
    authManager,
    balanceManager,
    officialModelsManager,
  });
  mainInstanceHandlersRegistered = true;
  authLog.verbose('main-instance', 'Main-instance handlers registered');
  setMainInstanceReadyIfPossible();

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

  context.subscriptions.push(
    registerBalanceStatusBar({ context, store: configStore }),
  );

  registerSecretStorageMaintenance(context, configStore, secretStore);

  // Re-register provider when configuration changes to pick up new models
  context.subscriptions.push(
    configStore.onDidChange(() => {
      syncContextWindowHook();
      chatProvider.handleConfigurationChange();
      enqueueMaintenance('cleanup-unused-secrets-on-config-change', async () => {
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

  // Re-register provider when balance states are updated
  context.subscriptions.push(
    balanceManager.onDidUpdate(() => {
      chatProvider.handleConfigurationChange();
    }),
  );

  // Note: Auth errors are now handled silently during passive refresh.
  // Errors are stored and shown only when user actively requests credentials
  // (e.g., when sending a chat request). See service.ts resolveProvider().

  // Clean up config store on deactivation
  context.subscriptions.push(configStore);

  setMainInstanceReadyIfPossible();
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
    vscode.commands.registerCommand('unifyChatProvider.manageBalances', () =>
      manageBalances(configStore, secretStore, uriHandler),
    ),
    vscode.commands.registerCommand(
      'unifyChatProvider.refreshAllProvidersOfficialModels',
      async () => {
        if (!(await ensureMainInstanceCompatibility())) {
          return;
        }
        let refreshedCount = 0;
        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: t('Refreshing official models...'),
              cancellable: false,
            },
            async () => {
              refreshedCount = await officialModelsManager.refreshAll();
            },
          );
        } catch (error) {
          if (await showMainInstanceCompatibilityWarning(error)) {
            return;
          }
          throw error;
        }
        if (refreshedCount === 0) {
          vscode.window.showInformationMessage(
            t('No providers have auto-fetch official models enabled.'),
          );
          return;
        }
        vscode.window.showInformationMessage(
          t('Refreshed official models for {0} provider(s).', refreshedCount),
        );
      },
    ),
    vscode.commands.registerCommand(
      'unifyChatProvider.refreshAllProvidersBalance',
      async () => {
        if (!(await ensureMainInstanceCompatibility())) {
          return;
        }
        let refreshedCount = 0;

        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: t('Refreshing provider balances...'),
              cancellable: false,
            },
            async () => {
              refreshedCount = await balanceManager.forceRefreshAll();
            },
          );
        } catch (error) {
          if (await showMainInstanceCompatibilityWarning(error)) {
            return;
          }
          throw error;
        }

        if (refreshedCount === 0) {
          vscode.window.showInformationMessage(
            t('No providers have balance monitoring configured.'),
          );
          return;
        }

        vscode.window.showInformationMessage(
          t('Refreshed balances for {0} provider(s).', refreshedCount),
        );
      },
    ),
    vscode.commands.registerCommand(
      'unifyChatProvider.syncBuiltInParamsToAllConfigs',
      () => syncBuiltInParamsToAllConfigs(configStore),
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

function enqueueMaintenance(
  label: string,
  work: () => Promise<void>,
): void {
  if (!mainInstance.isLeader()) {
    authLog.verbose(
      'main-instance',
      `Skipping maintenance enqueue because this instance is not leader (${label})`,
    );
    return;
  }
  const run = async (): Promise<void> => {
    if (!mainInstance.isLeader()) {
      authLog.verbose(
        'main-instance',
        `Skipping queued maintenance because leadership changed before execution (${label})`,
      );
      return;
    }
    try {
      authLog.verbose('main-instance', `Starting maintenance task (${label})`);
      await work();
      authLog.verbose('main-instance', `Completed maintenance task (${label})`);
    } catch (error) {
      authLog.error(
        'main-instance',
        `Secret storage maintenance failed (${label})`,
        error,
      );
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
  let lastGlobalStoreApiKeyInSettings = configStore.storeApiKeyInSettings;
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        !e.affectsConfiguration(`${CONFIG_NAMESPACE}.storeApiKeyInSettings`)
      ) {
        return;
      }
      const nextGlobalStoreApiKeyInSettings = configStore.storeApiKeyInSettings;
      if (nextGlobalStoreApiKeyInSettings === lastGlobalStoreApiKeyInSettings) {
        return;
      }
      lastGlobalStoreApiKeyInSettings = nextGlobalStoreApiKeyInSettings;

      enqueueMaintenance('migrate-api-key-storage-on-setting-change', async () => {
        await migrateApiKeyStorage({
          configStore,
          secretStore,
          storeApiKeyInSettings: nextGlobalStoreApiKeyInSettings,
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
  enqueueMaintenance('startup-secret-storage-maintenance', async () => {
    await migrateApiKeyStorage({
      configStore,
      secretStore,
      storeApiKeyInSettings: configStore.storeApiKeyInSettings,
      showProgress: false,
    });
    await cleanupUnusedSecrets(secretStore);
  });
}

function registerIgnoredScopeConfigurationWarning(
  context: vscode.ExtensionContext,
  configStore: ConfigStore,
): void {
  let hasWarnedThisSession = false;

  const notifyIfNeeded = (): void => {
    if (hasWarnedThisSession) {
      return;
    }

    const ignoredKeys = configStore.getIgnoredNonGlobalKeys().sort();
    if (ignoredKeys.length === 0) {
      return;
    }
    hasWarnedThisSession = true;

    const openUserSettingsAction = t('Open User Settings');
    const message = t(
      'Detected workspace-scoped settings for Unify Chat Provider ({0}). They are ignored and related credentials may be removed automatically. Please move them to user settings (global), then re-enter API keys or re-authorize OAuth if prompted.',
      ignoredKeys.map((key) => `${CONFIG_NAMESPACE}.${key}`).join(', '),
    );

    void vscode.window
      .showWarningMessage(message, openUserSettingsAction)
      .then((selection) => {
        if (selection === openUserSettingsAction) {
          void vscode.commands.executeCommand('workbench.action.openSettingsJson');
        }
      });
  };

  notifyIfNeeded();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(CONFIG_NAMESPACE)) {
        return;
      }
      notifyIfNeeded();
    }),
  );
}
