import * as vscode from 'vscode';
import { pickQuickItem } from '../component';
import { DEFAULT_TIMEOUT_CONFIG } from '../../utils';
import { TimeoutConfig } from '../../types';
import type {
  TimeoutFormRoute,
  UiContext,
  UiNavAction,
  UiResume,
} from '../router/types';

interface TimeoutFormItem extends vscode.QuickPickItem {
  action?: 'back' | 'reset';
  field?: 'connection' | 'response';
}

export async function runTimeoutFormScreen(
  _ctx: UiContext,
  route: TimeoutFormRoute,
  _resume: UiResume | undefined,
): Promise<UiNavAction> {
  const timeout = route.timeout;

  const items: TimeoutFormItem[] = [
    { label: '$(arrow-left) Back', action: 'back' },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    {
      label: '$(clock) Connection Timeout',
      description: formatTimeoutValue(timeout.connection, 'connection'),
      detail: 'Maximum time to wait for TCP connection to be established',
      field: 'connection',
    },
    {
      label: '$(clock) Response Timeout',
      description: formatTimeoutValue(timeout.response, 'response'),
      detail:
        'Maximum time to wait between data chunks during streaming (resets on each data received)',
      field: 'response',
    },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(refresh) Reset to Defaults', action: 'reset' },
  ];

  const selection = await pickQuickItem<TimeoutFormItem>({
    title: 'Timeout Configuration',
    placeholder: 'Select a field to edit',
    ignoreFocusOut: true,
    items,
  });

  if (!selection || selection.action === 'back') {
    route.draft.timeout = hasTimeoutValues(timeout) ? timeout : undefined;
    return { kind: 'pop' };
  }

  if (selection.action === 'reset') {
    route.timeout.connection = undefined;
    route.timeout.response = undefined;
    return { kind: 'stay' };
  }

  if (selection.field) {
    await editTimeoutField(timeout, selection.field);
  }

  return { kind: 'stay' };
}

function formatTimeoutValue(
  value: number | undefined,
  field: 'connection' | 'response',
): string {
  const defaultValue = DEFAULT_TIMEOUT_CONFIG[field];
  if (value === undefined) {
    return `default (${formatMs(defaultValue)})`;
  }
  return formatMs(value);
}

function formatMs(ms: number): string {
  if (ms >= 60_000) {
    const minutes = ms / 60_000;
    return `${minutes}min`;
  }
  if (ms >= 1_000) {
    const seconds = ms / 1_000;
    return `${seconds}s`;
  }
  return `${ms}ms`;
}

function hasTimeoutValues(timeout: TimeoutConfig): boolean {
  return timeout.connection !== undefined || timeout.response !== undefined;
}

async function editTimeoutField(
  timeout: TimeoutConfig,
  field: 'connection' | 'response',
): Promise<void> {
  const currentValue = timeout[field];
  const defaultValue = DEFAULT_TIMEOUT_CONFIG[field];

  const label =
    field === 'connection' ? 'Connection Timeout' : 'Response Timeout';
  const placeholder = `Enter timeout in milliseconds (default: ${defaultValue})`;

  const input = await vscode.window.showInputBox({
    title: label,
    prompt: placeholder,
    value: currentValue?.toString() ?? '',
    placeHolder: `e.g., ${defaultValue}`,
    validateInput: (value) => {
      if (!value.trim()) return null; // Empty is valid (means use default)
      const n = Number(value);
      if (Number.isNaN(n) || n <= 0) {
        return 'Please enter a positive number';
      }
      return null;
    },
  });

  if (input === undefined) {
    return; // Cancelled
  }

  if (!input.trim()) {
    timeout[field] = undefined;
  } else {
    timeout[field] = Number(input);
  }
}
