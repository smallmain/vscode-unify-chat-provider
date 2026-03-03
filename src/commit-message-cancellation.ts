import * as vscode from 'vscode';

const COMMIT_MESSAGE_REQUEST_NAME_PREFIX = 'ucp-commit-message:';

const cancelEmitter = new vscode.EventEmitter<string>();

/**
 * Create a unique request name used to identify commit-message generation requests.
 */
export function createCommitMessageRequestName(): string {
    const randomPart = Math.random().toString(36).slice(2, 10);
    return `${COMMIT_MESSAGE_REQUEST_NAME_PREFIX}${Date.now().toString(36)}-${randomPart}`;
}

/**
 * Check whether message name belongs to commit-message generation flow.
 */
export function isCommitMessageRequestName(name: string | undefined): boolean {
    return typeof name === 'string' && name.startsWith(COMMIT_MESSAGE_REQUEST_NAME_PREFIX);
}

/**
 * Broadcast cancellation request for a specific commit-message generation request.
 */
export function requestCommitMessageCancellation(requestName: string | undefined): void {
    if (!requestName) {
        return;
    }

    cancelEmitter.fire(requestName);
}

/**
 * Subscribe to commit-message generation cancellation events.
 */
export function onCommitMessageCancellation(
    listener: (requestName: string) => void,
): vscode.Disposable {
    return cancelEmitter.event(listener);
}
