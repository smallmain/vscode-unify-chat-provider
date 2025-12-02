import * as vscode from 'vscode';
import { ConfigStore } from './config/store';
import { UnifyChatProvider } from './provider/chatProvider';
import { registerCommands } from './commands';

const VENDOR_ID = 'unify-chat-provider';

/**
 * Extension activation
 */
export function activate(context: vscode.ExtensionContext): void {
  const configStore = new ConfigStore();
  const chatProvider = new UnifyChatProvider(configStore);

  // Register the language model chat provider
  const providerRegistration = vscode.lm.registerLanguageModelChatProvider(
    VENDOR_ID,
    chatProvider,
  );
  context.subscriptions.push(providerRegistration);

  // Register commands
  registerCommands(context, configStore);

  // Re-register provider when configuration changes to pick up new models
  context.subscriptions.push(
    configStore.onDidChange(() => {
      chatProvider.clearClients();
    }),
  );

  // Clean up config store on deactivation
  context.subscriptions.push(configStore);
}

/**
 * Extension deactivation
 */
export function deactivate(): void {
  // Cleanup handled by disposables
}
