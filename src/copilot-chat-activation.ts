import * as vscode from 'vscode';
import { authLog } from './logger';

export function activateCopilotChatInBackground(
  refreshModels: () => void,
): vscode.Disposable {
  let disposed = false;
  const disposable = new vscode.Disposable(() => {
    disposed = true;
  });

  // Copilot can wait indefinitely for authentication. UCP must finish starting
  // independently, then refresh again when Copilot is ready to discover models.
  void (async () => {
    try {
      const extension = vscode.extensions.getExtension('github.copilot-chat');
      if (!extension) return;
      await extension.activate();
      if (!disposed) refreshModels();
    } catch {
      if (!disposed) {
        authLog.warn(
          'main-instance',
          'Copilot Chat activation unavailable; initial model refresh may be delayed',
        );
      }
    }
  })();

  return disposable;
}
