import * as vscode from 'vscode';
import { ConfigStore, CONFIG_NAMESPACE } from './config-store';
import {
  SecretStore,
  migrateApiKeyToAuth,
  migrateProviderTypes,
  migrateSessionAuthState,
  migrateApiKeyStorage,
  cleanupUnusedSecrets,
  reconcileLocalAuthStateWithConfiguredEndpoints,
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
  showUsageDashboard,
  clearUsageStats,
} from './ui';
import { officialModelsManager } from './official-models-manager';
import { registerUriHandler, type EventedUriHandler } from './uri-handler';
import { t } from './i18n';
import { AuthManager } from './auth';
import { balanceManager } from './balance';
import { registerBalanceStatusBar } from './ui/balance-status-bar';
import { registerUsageStatusBar } from './ui/usage-status-bar';
import { usageStore } from './usage/usage-store';
import { mainInstance } from './main-instance';
import { isLeaderUnavailableError } from './main-instance/errors';
import {
  ensureMainInstanceCompatibility,
  showMainInstanceCompatibilityWarning,
} from './main-instance/compatibility';
import { MainInstanceError } from './main-instance/errors';
import { registerMainInstanceHandlers } from './main-instance/register-handlers';
import { authLog } from './logger';
import { webSocketSessionManager } from './client/websocket-session-manager';
import { syncBuiltInParamsToAllConfigs } from './sync-built-in-model-params';
import { registerCommitMessageGeneration } from './commit-message';
import { isUsageRecord, isUsageStoreState } from './usage/guards';
import type { UsageRecord, UsageStoreState } from './usage/types';
import {
  changeVSCodeDefaultModel,
  handleVSCodeDefaultModelError,
} from './vscode-default-model';
import { migrateLegacyVSCodeModelIds } from './vscode-model-id-migration';
import { CompletionManager, showCompletionSettings } from './completion';
import { ConfiguredCompletionModelResolver } from './completion/model/resolver';
import type { AlgorithmRequest } from './completion/model/requests';
import type { CompletionModelResolver } from './completion/types';
import {
  contextProviderApiV1,
  registerDefaultCopilotContextProviders,
} from './completion/copilot/default-context-providers';
import type { CopilotContextProvider } from './completion/copilot/context-provider';
import {
  createProposedApiCapabilities,
  initializeProposedApiCapabilities,
  type ProposedApiCapabilities,
} from './proposed-api/capabilities';
import { canUseLanguageModelThinkingPart } from './proposed-api/thinking';
import {
  registerProposedApiEnableCommand,
  scheduleProposedApiStartupReminder,
} from './proposed-api/reminder';
import { clearZedModelRoutes } from './client/zed/route-cache';
import {
  isSessionAuthConfig,
  isValidAuthBindingId,
} from './auth/local-auth-state';

const VENDOR_ID = 'unify-chat-provider';
const EXTENSIONS_CONFIG_NAMESPACE = 'extensions';
const SUPPORT_AGENTS_WINDOW_SETTING = 'supportAgentsWindow';
const E2E_SECRET_STORAGE_FILE_ENV = 'UCP_E2E_SECRET_STORAGE_FILE';

export interface UnifyChatProviderExtensionApi {
  getContextProviderAPI(version: 'v1'): {
    registerContextProvider(provider: CopilotContextProvider): vscode.Disposable;
  };
}

async function resolveSecretStorage(
  context: vscode.ExtensionContext,
): Promise<vscode.SecretStorage> {
  if (context.extensionMode === vscode.ExtensionMode.Production) {
    return context.secrets;
  }

  const filePath = process.env[E2E_SECRET_STORAGE_FILE_ENV]?.trim();
  if (!filePath) return context.secrets;

  const { E2EFileSecretStorage } = await import(
    './secret/e2e-file-secret-storage'
  );
  const storage = new E2EFileSecretStorage(filePath);
  context.subscriptions.push(storage);
  return storage;
}

function filterUsageRecords(value: unknown): UsageRecord[] {
  return Array.isArray(value) ? value.filter(isUsageRecord) : [];
}

function isNotImplementedError(error: unknown): boolean {
  return error instanceof MainInstanceError && error.code === 'NOT_IMPLEMENTED';
}

/**
 * Extension activation
 */
export async function activate(
  context: vscode.ExtensionContext,
): Promise<UnifyChatProviderExtensionApi> {
  await ensureAgentsWindowSupportConfigured(context);

  await mainInstance.initialize(context);
  context.subscriptions.push(mainInstance);

  const proposedApiCapabilities =
    await initializeExtensionProposedApiCapabilities(context);
  const shouldScheduleProposedApiReminder = mainInstance.isLeader();
  const canUseSystemMessage = proposedApiCapabilities.isProposedCanUse(
    'languageModelSystem',
  );
  const canUseChatProvider = proposedApiCapabilities.isProposedCanUse(
    'chatProvider',
  );
  const completionAvailable = proposedApiCapabilities.isProposedCanUse(
    'inlineCompletionsAdditions',
  );
  await Promise.all([
    vscode.commands.executeCommand(
      'setContext',
      'unifyChatProvider.proposedApi.contribSourceControlInputBoxMenu',
      proposedApiCapabilities.isProposedCanUse(
        'contribSourceControlInputBoxMenu',
      ),
    ),
    vscode.commands.executeCommand(
      'setContext',
      'unifyChatProvider.completion.available',
      completionAvailable,
    ),
  ]);
  if (context.extensionMode !== vscode.ExtensionMode.Production) {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        'unifyChatProvider.proposedApi.test.getState',
        () => ({
          declared: [...proposedApiCapabilities.declared],
          enabled: [...proposedApiCapabilities.enabled],
          missing: [...proposedApiCapabilities.missing],
          canUse: Object.fromEntries(
            proposedApiCapabilities.declared.map((proposal) => [
              proposal,
              proposedApiCapabilities.isProposedCanUse(proposal),
            ]),
          ),
          completionAvailable,
          scmInputBoxMenuAvailable:
            proposedApiCapabilities.isProposedCanUse(
              'contribSourceControlInputBoxMenu',
            ),
        }),
      ),
    );
  }

  const configStore = new ConfigStore();
  const secretStore = new SecretStore(await resolveSecretStorage(context));
  await secretStore.initializeLocalAuthState();
  let localAuthReloadQueue = Promise.resolve();
  const reloadConfiguredLocalAuthState = (): Promise<void> => {
    const run = async (): Promise<void> => {
      const bindingIds = new Set(
        configStore.endpoints.flatMap((provider) => {
          const auth = provider.auth;
          return auth &&
            isSessionAuthConfig(auth) &&
            isValidAuthBindingId(auth.bindingId)
            ? [auth.bindingId]
            : [];
        }),
      );
      await Promise.all(
        Array.from(bindingIds, (bindingId) =>
          secretStore.reloadLocalAuthState(bindingId),
        ),
      );
    };
    localAuthReloadQueue = localAuthReloadQueue.then(run, run);
    return localAuthReloadQueue;
  };
  context.subscriptions.push(
    configStore.onDidChange(() => {
      void reloadConfiguredLocalAuthState().catch((error) => {
        authLog.warn(
          'auth-state',
          `Failed to reload device-local auth state after configuration change: ${String(error)}`,
        );
      });
    }),
  );
  await reloadConfiguredLocalAuthState();

  // Register URI handler (import-config + OAuth callbacks)
  const uriHandler = registerUriHandler(context, configStore, secretStore);

  let mainInstanceHandlersRegistered = false;
  let leaderStartupReady = false;
  let leaderPromotionPromise: Promise<void> | undefined;
  let leaderPromotionRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let authManager: AuthManager | undefined;

  const syncUsageSnapshotFromLeader = (): void => {
    if (mainInstance.isLeader() || !mainInstance.isReady()) {
      return;
    }
    void mainInstance
      .runInLeaderWhenAvailable<UsageStoreState>(
        'usage.getState',
        {},
        { timeoutMs: 2_000 },
      )
      .then((state) => {
        if (isUsageStoreState(state)) {
          usageStore.replaceState(state);
        }
        usageStore.flushPendingRemoteRecords();
      })
      .catch((error) => {
        if (isNotImplementedError(error)) {
          void mainInstance
            .runInLeaderWhenAvailable('usage.getSnapshot', {}, { timeoutMs: 2_000 })
            .then((records) => {
              usageStore.replaceRecords(filterUsageRecords(records));
              usageStore.flushPendingRemoteRecords();
            })
            .catch((snapshotError) => {
              authLog.error(
                'main-instance',
                'Failed to sync usage snapshot',
                snapshotError,
              );
              usageStore.flushPendingRemoteRecords();
            });
          return;
        }
        authLog.error('main-instance', 'Failed to sync usage state', error);
        usageStore.flushPendingRemoteRecords();
      });
  };

  const runLeaderStartupMigrations = async (): Promise<void> => {
    if (!mainInstance.isLeader()) {
      authLog.verbose(
        'main-instance',
        'Skipping leader startup migrations because this instance is not leader',
      );
      return;
    }
    await mainInstance.runLeaderMutation(async () => {
      authLog.verbose('main-instance', 'Running leader startup migrations');
      await reloadConfiguredLocalAuthState();
      await migrateProviderTypes(configStore);
      await migrateApiKeyToAuth(configStore);
      await migrateSessionAuthState({ configStore, secretStore });
      await reconcileLocalAuthStateWithConfiguredEndpoints(secretStore);
      authLog.verbose('main-instance', 'Leader startup migrations completed');
    });
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
    authManager?.setLeaderAuthReady(true);
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
      usageStore.setCanPersist(snapshot.role === 'leader');
      if (snapshot.role === 'follower' && snapshot.ready) {
        syncUsageSnapshotFromLeader();
      }
      if (snapshot.role !== 'leader') {
        leaderStartupReady = false;
        authManager?.setLeaderAuthReady(false);
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

  // Leader migration must finish before any auth provider can read legacy state.
  authManager = new AuthManager(
    configStore,
    secretStore,
    uriHandler,
    leaderStartupReady,
  );
  context.subscriptions.push(authManager);

  if (context.extensionMode !== vscode.ExtensionMode.Production) {
    const { registerAuthTestCommands } = await import('./auth/test-control');
    registerAuthTestCommands({ context, configStore, secretStore });
  }

  await balanceManager.initialize({
    configStore,
    secretStore,
    authManager,
    extensionContext: context,
  });
  context.subscriptions.push(balanceManager);
  usageStore.initialize({
    context,
    canPersist: () => mainInstance.isLeader(),
    detailRetentionDays: configStore.usageDetailRetentionDays,
    syncAdapter: {
      async forwardRecord(record) {
        await mainInstance.runInLeaderWhenAvailable('usage.record', record, {
          timeoutMs: 2_000,
        });
      },
      async forwardClear() {
        await mainInstance.runInLeaderWhenAvailable('usage.clear', {}, {
          timeoutMs: 2_000,
        });
      },
    },
  });
  context.subscriptions.push(usageStore);
  syncUsageSnapshotFromLeader();
  context.subscriptions.push(webSocketSessionManager);

  const chatProvider = new UnifyChatService(
    configStore,
    secretStore,
    authManager,
    balanceManager,
    usageStore,
    canUseChatProvider,
  );
  if (context.extensionMode !== vscode.ExtensionMode.Production) {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        'unifyChatProvider.proposedApi.test.getModelInformation',
        async () => {
          const cancellation = new vscode.CancellationTokenSource();
          try {
            return await chatProvider.provideLanguageModelChatInformation(
              { silent: true },
              cancellation.token,
            );
          } finally {
            cancellation.dispose();
          }
        },
      ),
    );
  }

  // Initialize official models manager
  await officialModelsManager.initialize(
    context,
    configStore,
    secretStore,
    authManager,
    uriHandler,
  );
  context.subscriptions.push(officialModelsManager);
  context.subscriptions.push(
    authManager.onDidChangeAuthState((change) => {
      if (
        change.reason === 'refresh' ||
        change.reason === 'migration'
      ) {
        return;
      }
      if (change.method === 'zed') {
        clearZedModelRoutes(change.bindingId);
      }
      chatProvider.handleAuthStateChange(change.providerName);
      if (!mainInstance.isLeader()) return;
      const provider = configStore.getProvider(change.providerName);
      void officialModelsManager
        .clearProviderState(change.providerName)
        .then(() => {
          if (provider?.autoFetchOfficialModels) {
            officialModelsManager.triggerBackgroundFetch(provider);
          }
        })
        .catch((error) => {
          authLog.warn(
            'auth-state',
            `Failed to reset official models after auth context changed for ${change.providerName}: ${String(error)}`,
          );
        });
      void balanceManager
        .handleAuthStateChange(change.providerName)
        .catch((error) => {
          authLog.warn(
            'auth-state',
            `Failed to reset balance after auth context changed for ${change.providerName}: ${String(error)}`,
          );
        });
    }),
  );
  if (mainInstance.isLeader()) {
    await migrateLegacyVSCodeModelIds(configStore);
  }

  registerMainInstanceHandlers({
    configStore,
    authManager,
    balanceManager,
    officialModelsManager,
    usageStore,
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

  // Copilot Chat is built into VS Code, but Remote-SSH hosts may not enumerate
  // it early enough for a hard extension dependency to work reliably.
  // Activate it opportunistically before we fire the first model refresh.
  try {
    await vscode.extensions.getExtension('github.copilot-chat')?.activate();
  } catch {
    authLog.warn(
      'main-instance',
      'Copilot Chat activation unavailable; initial model refresh may be delayed',
    );
  }

  // Trigger initial model cache refresh
  chatProvider.handleConfigurationChange();

  // Register commands
  registerCommands(context, configStore, secretStore, uriHandler);
  registerProposedApiEnableCommand(context);
  registerCommitMessageGeneration(context, canUseSystemMessage);

  if (completionAvailable) {
    const productionCompletionModelResolver =
      new ConfiguredCompletionModelResolver(
        configStore,
        authManager,
        undefined,
        canUseSystemMessage,
      );
    let completionModelResolver: CompletionModelResolver =
      productionCompletionModelResolver;
    let completionTestControl:
      | {
          setTestResponse(value: unknown): boolean;
          getTestRequests(): readonly AlgorithmRequest[];
        }
      | undefined;
    if (context.extensionMode !== vscode.ExtensionMode.Production) {
      const { TestingCompletionModelResolver } = await import(
        './completion/model/testing-resolver'
      );
      const testingResolver = new TestingCompletionModelResolver(
        productionCompletionModelResolver,
      );
      completionModelResolver = testingResolver;
      completionTestControl = testingResolver;
    }
    context.subscriptions.push(
      vscode.commands.registerCommand(
        'unifyChatProvider.completion.settings',
        () => showCompletionSettings(completionModelResolver, configStore),
      ),
    );
    context.subscriptions.push(registerDefaultCopilotContextProviders());
    const completionManager = new CompletionManager(completionModelResolver);
    context.subscriptions.push(completionManager);
    context.subscriptions.push(
      authManager.onDidChangeAuthState((change) => {
        if (
          change.reason !== 'refresh' &&
          change.reason !== 'migration'
        ) {
          completionManager.handleAuthStateChange(change.providerName);
        }
      }),
    );
    if (context.extensionMode !== vscode.ExtensionMode.Production) {
      const [
        { registerCompletionWarningTestCommands },
        { CompletionTestHarness },
      ] = await Promise.all([
        import('./completion/test-control'),
        import('./completion/test-harness'),
      ]);
      registerCompletionWarningTestCommands(context);
      const completionTestHarness = new CompletionTestHarness(completionManager);
      context.subscriptions.push(
        completionTestHarness,
        vscode.commands.registerCommand(
          'unifyChatProvider.completion.test.getState',
          () => completionManager.getState(),
        ),
        vscode.commands.registerCommand(
          'unifyChatProvider.completion.test.setResponse',
          (value: unknown) =>
            completionTestControl?.setTestResponse(value) ?? false,
        ),
        vscode.commands.registerCommand(
          'unifyChatProvider.completion.test.getRequests',
          () => completionTestControl?.getTestRequests() ?? [],
        ),
        vscode.commands.registerCommand(
          'unifyChatProvider.completion.test.getRuntimeState',
          (providerId: unknown) =>
            typeof providerId === 'string'
              ? completionManager.getRuntimeDebugState(providerId)
              : undefined,
        ),
        vscode.commands.registerCommand(
          'unifyChatProvider.completion.test.provide',
          (options: unknown) => completionTestHarness.provideTexts(options),
        ),
        vscode.commands.registerCommand(
          'unifyChatProvider.completion.test.provideDetailed',
          (options: unknown) => completionTestHarness.provide(options),
        ),
        vscode.commands.registerCommand(
          'unifyChatProvider.completion.test.cancelProvide',
          (cancellationKey: unknown) =>
            completionTestHarness.cancelProvide(cancellationKey),
        ),
        vscode.commands.registerCommand(
          'unifyChatProvider.completion.test.dispatchLifecycle',
          (event: unknown) => completionTestHarness.dispatchLifecycle(event),
        ),
        vscode.commands.registerCommand(
          'unifyChatProvider.completion.test.getHarnessState',
          () => completionTestHarness.getState(),
        ),
        vscode.commands.registerCommand(
          'unifyChatProvider.completion.test.clearHarness',
          () => completionTestHarness.clear(),
        ),
      );
    }
  } else {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        'unifyChatProvider.completion.settings',
        () =>
          vscode.window.showWarningMessage(
            t(
              'Code completion is unavailable because the inlineCompletionsAdditions Proposed API is not enabled.',
            ),
          ),
      ),
    );
    if (context.extensionMode !== vscode.ExtensionMode.Production) {
      registerUnavailableCompletionTestCommands(context);
    }
  }

  context.subscriptions.push(
    registerBalanceStatusBar({ context, store: configStore }),
  );
  context.subscriptions.push(
    registerUsageStatusBar({ context, store: configStore }),
  );

  registerSecretStorageMaintenance(context, configStore, secretStore);

  // Re-register provider when configuration changes to pick up new models
  context.subscriptions.push(
    configStore.onDidChange(() => {
      chatProvider.handleConfigurationChange();
      usageStore.setDetailRetentionDays(configStore.usageDetailRetentionDays);
      if (!mainInstance.isLeader() || !mainInstance.isReady()) return;
      enqueueMaintenance('cleanup-unused-secrets-on-config-change', async () => {
        await cleanupUnusedSecrets(secretStore);
      });
    }),
  );

  context.subscriptions.push(
    mainInstance.onDidReceiveEvent(({ event, payload }) => {
      if (event === 'usage.record') {
        if (isUsageRecord(payload)) {
          usageStore.acceptRemoteRecord(payload);
        }
      } else if (event === 'usage.clear') {
        void usageStore.clearFromRemote();
      } else if (event === 'usage.snapshot' && Array.isArray(payload)) {
        usageStore.replaceRecords(filterUsageRecords(payload));
      }
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
  if (shouldScheduleProposedApiReminder) {
    scheduleProposedApiStartupReminder(context, proposedApiCapabilities);
  }
  return {
    getContextProviderAPI(version) {
      if (version !== 'v1') {
        throw new Error(`Unsupported context provider API version: ${version}`);
      }
      return contextProviderApiV1();
    },
  };
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
    vscode.commands.registerCommand('unifyChatProvider.showUsageDashboard', () =>
      showUsageDashboard(context),
    ),
    vscode.commands.registerCommand('unifyChatProvider.clearUsageStats', () =>
      clearUsageStats(),
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
    vscode.commands.registerCommand(
      'unifyChatProvider.changeVSCodeDefaultModel',
      async () => {
        try {
          await changeVSCodeDefaultModel();
        } catch (error) {
          await handleVSCodeDefaultModelError(error);
        }
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

async function initializeExtensionProposedApiCapabilities(
  context: vscode.ExtensionContext,
): Promise<ProposedApiCapabilities> {
  try {
    return await initializeProposedApiCapabilities(context, {
      canUseLanguageModelThinkingPart,
    });
  } catch (error) {
    authLog.error(
      'proposed-api',
      'Unable to read the Proposed API manifest; all Proposed API features will use their fallback behavior',
      error,
    );
    return createProposedApiCapabilities(
      { declared: [], enabled: [] },
      { canUseLanguageModelThinkingPart: () => false },
    );
  }
}

function registerUnavailableCompletionTestCommands(
  context: vscode.ExtensionContext,
): void {
  const unavailableState = Object.freeze({
    available: false,
    unavailableReason: 'inlineCompletionsAdditions',
    registered: false,
    enabled: false,
    providerCount: 0,
    providerIds: Object.freeze([]),
    excludedProviderGroups: Object.freeze([]),
    runtimeCount: 0,
    runtimeInstances: Object.freeze({}),
  });
  const unavailable = (): typeof unavailableState => unavailableState;
  const commandIds = [
    'unifyChatProvider.completion.test.getState',
    'unifyChatProvider.completion.test.setResponse',
    'unifyChatProvider.completion.test.getRequests',
    'unifyChatProvider.completion.test.getRuntimeState',
    'unifyChatProvider.completion.test.provide',
    'unifyChatProvider.completion.test.provideDetailed',
    'unifyChatProvider.completion.test.cancelProvide',
    'unifyChatProvider.completion.test.dispatchLifecycle',
    'unifyChatProvider.completion.test.getHarnessState',
    'unifyChatProvider.completion.test.clearHarness',
    'unifyChatProvider.completion.test.getWarnings',
    'unifyChatProvider.completion.test.clearWarnings',
  ];
  context.subscriptions.push(
    ...commandIds.map((commandId) =>
      vscode.commands.registerCommand(commandId, unavailable),
    ),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function ensureAgentsWindowSupportConfigured(
  context: vscode.ExtensionContext,
): Promise<void> {
  try {
    const config = vscode.workspace.getConfiguration(
      EXTENSIONS_CONFIG_NAMESPACE,
    );
    const inspection = config.inspect<unknown>(SUPPORT_AGENTS_WINDOW_SETTING);
    const globalValue = inspection?.globalValue;
    const supportAgentsWindow = isRecord(globalValue) ? globalValue : {};
    const extensionId = context.extension.id;

    if (supportAgentsWindow[extensionId] === false) {
      return;
    }
    if (supportAgentsWindow[extensionId] === true) {
      return;
    }

    await config.update(
      SUPPORT_AGENTS_WINDOW_SETTING,
      {
        ...supportAgentsWindow,
        [extensionId]: true,
      },
      vscode.ConfigurationTarget.Global,
    );
  } catch (error) {
    console.warn(
      '[UnifyChatProvider] Failed to configure Agents window support:',
      error,
    );
  }
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
      await mainInstance.runLeaderMutation(work);
      authLog.verbose('main-instance', `Completed maintenance task (${label})`);
    } catch (error) {
      if (isLeaderUnavailableError(error)) {
        authLog.verbose(
          'main-instance',
          `Maintenance stopped because leadership changed (${label})`,
        );
        return;
      }
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
  let lastStoreApiKeyInSettings = configStore.storeApiKeyInSettings;
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        !e.affectsConfiguration(`${CONFIG_NAMESPACE}.storeApiKeyInSettings`)
      ) {
        return;
      }
      const nextStoreApiKeyInSettings = configStore.storeApiKeyInSettings;
      if (nextStoreApiKeyInSettings === lastStoreApiKeyInSettings) {
        return;
      }
      lastStoreApiKeyInSettings = nextStoreApiKeyInSettings;

      enqueueMaintenance('migrate-api-key-storage-on-setting-change', async () => {
        await migrateApiKeyStorage({
          configStore,
          secretStore,
          storeApiKeyInSettings: nextStoreApiKeyInSettings,
          showProgress: true,
        });
        if (mainInstance.isLeader() && mainInstance.isReady()) {
          await cleanupUnusedSecrets(secretStore);
        }
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
