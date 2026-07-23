import * as vscode from 'vscode';
import { NotificationThrottle } from './notification-throttle';

const DEFAULT_THROTTLE_MS = 60_000;

export interface CompletionWarningEvent {
  key: string;
  message: string;
}

const testObservers = new Set<(event: CompletionWarningEvent) => void>();

export function observeCompletionWarningsForTest(
  observer: (event: CompletionWarningEvent) => void,
): vscode.Disposable {
  testObservers.add(observer);
  return {
    dispose: () => testObservers.delete(observer),
  };
}

export class CompletionNotifier {
  private readonly throttle: NotificationThrottle;

  constructor(throttleMs = DEFAULT_THROTTLE_MS) {
    this.throttle = new NotificationThrottle(throttleMs);
  }

  warn(key: string, message: string): void {
    if (!this.throttle.shouldShow(key, Date.now())) {
      return;
    }
    for (const observer of testObservers) {
      observer({ key, message });
    }
    void vscode.window.showWarningMessage(message);
  }
}
