import * as vscode from 'vscode';
import { pickQuickItem } from '../component';
import { resolveChatNetwork, type ResolvedChatNetworkConfig, type RetryConfig } from '../../utils';
import type { TimeoutConfig } from '../../types';
import type {
  TimeoutFormRoute,
  UiContext,
  UiNavAction,
  UiResume,
} from '../router/types';
import { t } from '../../i18n';

type NetworkField =
  | { kind: 'timeout'; field: 'connection' | 'response' }
  | {
      kind: 'retry';
      field:
        | 'maxRetries'
        | 'initialDelayMs'
        | 'maxDelayMs'
        | 'backoffMultiplier'
        | 'jitterFactor';
    };

interface NetworkSettingsItem extends vscode.QuickPickItem {
  action?: 'back' | 'reset';
  edit?: NetworkField;
  readOnly?: boolean;
}

export async function runTimeoutFormScreen(
  _ctx: UiContext,
  route: TimeoutFormRoute,
  _resume: UiResume | undefined,
): Promise<UiNavAction> {
  const timeout = route.timeout;
  const retry = route.retry;
  const globalDefaults = resolveChatNetwork(undefined);
  const isCodeAssist =
    route.draft.type === 'google-antigravity' ||
    route.draft.type === 'google-gemini-cli';

  const items: NetworkSettingsItem[] = [
    { label: `$(arrow-left) ${t('Back')}`, action: 'back' },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    {
      label: `$(clock) ${t('Connection Timeout')}`,
      description: formatTimeoutValue(
        timeout.connection,
        globalDefaults.timeout.connection,
      ),
      detail: t('Maximum time to wait for TCP connection to be established'),
      edit: { kind: 'timeout', field: 'connection' },
    },
    {
      label: `$(clock) ${t('Response Timeout')}`,
      description: formatTimeoutValue(
        timeout.response,
        globalDefaults.timeout.response,
      ),
      detail: t(
        'Maximum time to wait between data chunks during streaming (resets on each data received)',
      ),
      edit: { kind: 'timeout', field: 'response' },
    },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    {
      label: `$(sync) ${t('Max Retries')}`,
      description: formatRetryValue(
        retry.maxRetries,
        globalDefaults.retry.maxRetries,
      ),
      detail: isCodeAssist
        ? t('Retry settings are managed internally for this provider')
        : t('Maximum number of retry attempts for transient errors'),
      edit: { kind: 'retry', field: 'maxRetries' },
      readOnly: isCodeAssist,
    },
    {
      label: `$(clock) ${t('Initial Delay')}`,
      description: formatMsOrDefault(
        retry.initialDelayMs,
        globalDefaults.retry.initialDelayMs,
      ),
      detail: isCodeAssist
        ? t('Retry settings are managed internally for this provider')
        : t('Initial delay before the first retry'),
      edit: { kind: 'retry', field: 'initialDelayMs' },
      readOnly: isCodeAssist,
    },
    {
      label: `$(clock) ${t('Max Delay')}`,
      description: formatMsOrDefault(
        retry.maxDelayMs,
        globalDefaults.retry.maxDelayMs,
      ),
      detail: isCodeAssist
        ? t('Retry settings are managed internally for this provider')
        : t('Maximum delay cap for retries'),
      edit: { kind: 'retry', field: 'maxDelayMs' },
      readOnly: isCodeAssist,
    },
    {
      label: `$(symbol-number) ${t('Backoff Multiplier')}`,
      description: formatNumberOrDefault(
        retry.backoffMultiplier,
        globalDefaults.retry.backoffMultiplier,
      ),
      detail: isCodeAssist
        ? t('Retry settings are managed internally for this provider')
        : t('Exponential backoff multiplier (e.g., 2 means double each retry)'),
      edit: { kind: 'retry', field: 'backoffMultiplier' },
      readOnly: isCodeAssist,
    },
    {
      label: `$(symbol-number) ${t('Jitter Factor')}`,
      description: formatNumberOrDefault(
        retry.jitterFactor,
        globalDefaults.retry.jitterFactor,
      ),
      detail: isCodeAssist
        ? t('Retry settings are managed internally for this provider')
        : t('Adds randomness (0-1) to avoid synchronized retries'),
      edit: { kind: 'retry', field: 'jitterFactor' },
      readOnly: isCodeAssist,
    },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: `$(refresh) ${t('Reset to Defaults')}`, action: 'reset' },
  ];

  const selection = await pickQuickItem<NetworkSettingsItem>({
    title: t('Network Settings'),
    placeholder: t('Select a setting to edit'),
    ignoreFocusOut: true,
    items,
  });

  if (!selection || selection.action === 'back') {
    route.draft.timeout = hasTimeoutValues(timeout) ? timeout : undefined;
    route.draft.retry = hasRetryValues(retry) ? retry : undefined;
    return { kind: 'pop' };
  }

  if (selection.action === 'reset') {
    route.timeout.connection = undefined;
    route.timeout.response = undefined;
    route.retry.maxRetries = undefined;
    route.retry.initialDelayMs = undefined;
    route.retry.maxDelayMs = undefined;
    route.retry.backoffMultiplier = undefined;
    route.retry.jitterFactor = undefined;
    return { kind: 'stay' };
  }

  if (selection.edit) {
    if (selection.readOnly) {
      vscode.window.showInformationMessage(
        t('Retry settings are managed internally for this provider'),
      );
      return { kind: 'stay' };
    }

    if (selection.edit.kind === 'timeout') {
      const defaultValue =
        selection.edit.field === 'connection'
          ? globalDefaults.timeout.connection
          : globalDefaults.timeout.response;
      await editTimeoutField(timeout, selection.edit.field, defaultValue);
    } else {
      await editRetryField(retry, selection.edit.field, globalDefaults.retry);
    }
  }

  return { kind: 'stay' };
}

function formatTimeoutValue(
  value: number | undefined,
  defaultValue: number,
): string {
  if (value === undefined) return t('default ({0})', formatMs(defaultValue));
  return formatMs(value);
}

function formatRetryValue(
  value: number | undefined,
  defaultValue: number,
): string {
  if (value === undefined) return t('default ({0})', defaultValue);
  return String(value);
}

function formatMsOrDefault(
  value: number | undefined,
  defaultValue: number,
): string {
  if (value === undefined) return t('default ({0})', formatMs(defaultValue));
  return formatMs(value);
}

function formatNumberOrDefault(
  value: number | undefined,
  defaultValue: number,
): string {
  if (value === undefined) return t('default ({0})', defaultValue);
  return String(value);
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

function hasRetryValues(retry: RetryConfig): boolean {
  return (
    retry.maxRetries !== undefined ||
    retry.initialDelayMs !== undefined ||
    retry.maxDelayMs !== undefined ||
    retry.backoffMultiplier !== undefined ||
    retry.jitterFactor !== undefined
  );
}

async function editTimeoutField(
  timeout: TimeoutConfig,
  field: 'connection' | 'response',
  defaultValue: number,
): Promise<void> {
  const currentValue = timeout[field];

  const label =
    field === 'connection' ? t('Connection Timeout') : t('Response Timeout');
  const placeholder = t(
    'Enter timeout in milliseconds (default: {0})',
    defaultValue,
  );

  const input = await vscode.window.showInputBox({
    title: label,
    prompt: placeholder,
    value: currentValue?.toString() ?? '',
    placeHolder: t('e.g., {0}', defaultValue),
    validateInput: (value) => {
      if (!value.trim()) return null; // Empty is valid (means use default)
      const n = Number(value);
      if (Number.isNaN(n) || n <= 0) {
        return t('Please enter a positive number');
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

async function editRetryField(
  retry: RetryConfig,
  field:
    | 'maxRetries'
    | 'initialDelayMs'
    | 'maxDelayMs'
    | 'backoffMultiplier'
    | 'jitterFactor',
  defaults: ResolvedChatNetworkConfig['retry'],
): Promise<void> {
  const currentValue = retry[field];
  const defaultValue = defaults[field];

  const labels: Record<typeof field, string> = {
    maxRetries: t('Max Retries'),
    initialDelayMs: t('Initial Delay'),
    maxDelayMs: t('Max Delay'),
    backoffMultiplier: t('Backoff Multiplier'),
    jitterFactor: t('Jitter Factor'),
  };

  const label = labels[field];
  const placeholder =
    field === 'maxRetries'
      ? t('Enter a non-negative integer (default: {0})', defaultValue)
      : field === 'initialDelayMs' || field === 'maxDelayMs'
        ? t('Enter milliseconds (default: {0})', defaultValue)
        : field === 'backoffMultiplier'
          ? t('Enter a number ≥ 1 (default: {0})', defaultValue)
          : t('Enter a number between 0 and 1 (default: {0})', defaultValue);

  const input = await vscode.window.showInputBox({
    title: label,
    prompt: placeholder,
    value: currentValue?.toString() ?? '',
    placeHolder: String(defaultValue),
    validateInput: (value) => {
      if (!value.trim()) return null;
      const n = Number(value);
      if (!Number.isFinite(n)) {
        return t('Please enter a valid number');
      }
      if (field === 'maxRetries') {
        if (!Number.isInteger(n) || n < 0) {
          return t('Please enter a non-negative integer');
        }
        return null;
      }
      if (field === 'initialDelayMs') {
        if (!Number.isInteger(n) || n < 0) {
          return t('Please enter a non-negative integer');
        }
        return null;
      }
      if (field === 'maxDelayMs') {
        if (!Number.isInteger(n) || n <= 0) {
          return t('Please enter a positive integer');
        }
        return null;
      }
      if (field === 'backoffMultiplier') {
        if (n < 1) {
          return t('Please enter a number greater than or equal to 1');
        }
        return null;
      }
      // jitterFactor
      if (n < 0 || n > 1) {
        return t('Please enter a number between 0 and 1');
      }
      return null;
    },
  });

  if (input === undefined) {
    return;
  }

  if (!input.trim()) {
    retry[field] = undefined;
  } else {
    retry[field] = Number(input);
  }
}
