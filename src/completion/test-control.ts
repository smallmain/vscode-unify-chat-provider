import * as vscode from 'vscode';
import {
  observeCompletionWarningsForTest,
  type CompletionWarningEvent,
} from './notifier';

export function registerCompletionWarningTestCommands(
  context: vscode.ExtensionContext,
): void {
  const warnings: CompletionWarningEvent[] = [];
  context.subscriptions.push(
    observeCompletionWarningsForTest((event) => warnings.push(event)),
    vscode.commands.registerCommand(
      'unifyChatProvider.completion.test.getWarnings',
      () => warnings.map((event) => ({ ...event })),
    ),
    vscode.commands.registerCommand(
      'unifyChatProvider.completion.test.clearWarnings',
      () => {
        warnings.length = 0;
      },
    ),
  );
}
