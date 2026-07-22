import type * as vscode from 'vscode';
import type { CompletionAlgorithmChange } from './types';

export const COMPLETION_CHANGE_HINT_KIND =
  'unify-chat-provider.completion-change';

export interface RoutedCompletionChange {
  readonly kind: typeof COMPLETION_CHANGE_HINT_KIND;
  readonly providerId: string;
  readonly change?: CompletionAlgorithmChange;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createRoutedCompletionChange(
  providerId: string,
  change: CompletionAlgorithmChange | void,
): RoutedCompletionChange {
  return {
    kind: COMPLETION_CHANGE_HINT_KIND,
    providerId,
    ...(change === undefined ? {} : { change }),
  };
}

export function readRoutedCompletionChange(
  context: vscode.InlineCompletionContext,
): RoutedCompletionChange | undefined {
  const data = context.changeHint?.data;
  if (!isRecord(data)) {
    return undefined;
  }
  const kind = data.kind;
  const providerId = data.providerId;
  if (
    kind !== COMPLETION_CHANGE_HINT_KIND ||
    typeof providerId !== 'string'
  ) {
    return undefined;
  }
  const rawChange = data.change;
  if (rawChange === undefined) {
    return { kind, providerId };
  }
  if (!isRecord(rawChange) || typeof rawChange.reason !== 'string') {
    return undefined;
  }
  const branch = rawChange.branch;
  if (
    branch !== undefined &&
    branch !== 'fim' &&
    branch !== 'nes' &&
    branch !== 'diagnostics'
  ) {
    return undefined;
  }
  return {
    kind,
    providerId,
    change: {
      reason: rawChange.reason,
      ...(branch === undefined ? {} : { branch }),
      ...('data' in rawChange ? { data: rawChange.data } : {}),
    },
  };
}
