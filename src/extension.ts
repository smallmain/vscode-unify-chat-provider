import * as vscode from 'vscode';
import { ConfigStore } from './config-store';
import { UnifyChatService } from './service';
import { addProvider, removeProvider, manageProviders } from './ui/state';

const VENDOR_ID = 'unify-chat-provider';

/**
 * Extension activation
 */
export function activate(context: vscode.ExtensionContext): void {
  const configStore = new ConfigStore();
  const chatProvider = new UnifyChatService(configStore);

  // Register the language model chat provider
  const providerRegistration = vscode.lm.registerLanguageModelChatProvider(
    VENDOR_ID,
    chatProvider,
  );
  context.subscriptions.push(providerRegistration);
  context.subscriptions.push(chatProvider);

  // Register commands
  registerCommands(context, configStore);

  // Re-register provider when configuration changes to pick up new models
  context.subscriptions.push(
    configStore.onDidChange(() => {
      chatProvider.handleConfigurationChange();
    }),
  );

  // Clean up config store on deactivation
  context.subscriptions.push(configStore);
}

export function registerCommands(
  context: vscode.ExtensionContext,
  configStore: ConfigStore,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('unifyChatProvider.addProvider', () =>
      addProvider(configStore),
    ),
    vscode.commands.registerCommand('unifyChatProvider.removeProvider', () =>
      removeProvider(configStore),
    ),
    vscode.commands.registerCommand('unifyChatProvider.manageProviders', () =>
      manageProviders(configStore),
    ),
  );
}

/**
 * Extension deactivation
 */
export function deactivate(): void {
  // Cleanup handled by disposables
}
