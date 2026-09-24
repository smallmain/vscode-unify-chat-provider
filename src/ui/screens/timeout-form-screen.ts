import * as vscode from 'vscode';
import { pickQuickItem } from '../component';
import { resolveChatNetwork, type ResolvedChatNetworkConfig, type RetryConfig } from '../../utils';
import type { ProxyConfig, ProxyType, TimeoutConfig } from '../../types';
import type { RateLimitConfig } from '../../rate-limit';
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
    }
  | {
      kind: 'proxy';
      field: 'type' | 'url' | 'authorization' | 'strictSSL' | 'noProxy';
    }
  | { kind: 'rateLimit'; field: 'rpm' };

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
  const proxy = route.proxy;
  const rateLimit = route.rateLimit;
  const globalDefaults = resolveChatNetwork(undefined);
  const isCodeAssist =
    route.draft.type === 'google-antigravity' ||
    route.draft.type === 'google-gemini-cli';

  const items: NetworkSettingsItem[] = [
    { label: `$(arrow-left) ${t('Back')}`, action: 'back' },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    {
      label: `$(dashboard) ${t('Rate Limit (RPM)')}`,
      description:
        rateLimit.rpm && rateLimit.rpm > 0
          ? String(rateLimit.rpm)
          : t('Disabled'),
      detail: t('Maximum requests per minute (0 = disabled)'),
      edit: { kind: 'rateLimit', field: 'rpm' },
    },
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
    {
      label: `$(globe) ${t('Proxy Type')}`,
      description: formatProxyType(proxy.type),
      detail: t('Select whether to use VS Code proxy settings, connect directly, or use a custom proxy'),
      edit: { kind: 'proxy', field: 'type' },
    },
    {
      label: `$(link) ${t('Proxy URL')}`,
      description: proxy.url?.trim() || t('Not configured'),
      detail: t('Used when proxy type is Custom'),
      edit: { kind: 'proxy', field: 'url' },
    },
    {
      label: `$(key) ${t('Proxy Authorization')}`,
      description: proxy.authorization?.trim()
        ? t('Configured')
        : t('Not configured'),
      detail: t('Optional proxy authorization header or user:password credentials'),
      edit: { kind: 'proxy', field: 'authorization' },
    },
    {
      label: `$(shield) ${t('Proxy Strict SSL')}`,
      description:
        proxy.strictSSL === undefined
          ? t('default')
          : proxy.strictSSL
            ? t('Enabled')
            : t('Disabled'),
      detail: t('Whether to enforce TLS certificate validation for proxied requests'),
      edit: { kind: 'proxy', field: 'strictSSL' },
    },
    {
      label: `$(list-unordered) ${t('No Proxy')}`,
      description:
        proxy.noProxy && proxy.noProxy.length > 0
          ? t('{0} entries', proxy.noProxy.length)
          : t('Not configured'),
      detail:
        proxy.noProxy && proxy.noProxy.length > 0
          ? t('Hosts that should bypass the proxy: {0}', proxy.noProxy.join(', '))
          : t('Hosts that should bypass the proxy'),
      edit: { kind: 'proxy', field: 'noProxy' },
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
    route.draft.proxy = hasProxyValues(proxy) ? proxy : undefined;
    route.draft.rateLimit = hasRateLimitValues(rateLimit) ? rateLimit : undefined;
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
    route.proxy.type = undefined;
    route.proxy.url = undefined;
    route.proxy.authorization = undefined;
    route.proxy.strictSSL = undefined;
    route.proxy.noProxy = undefined;
    route.rateLimit.rpm = undefined;
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
    } else if (selection.edit.kind === 'retry') {
      await editRetryField(retry, selection.edit.field, globalDefaults.retry);
    } else if (selection.edit.kind === 'rateLimit') {
      await editRateLimitField(rateLimit, selection.edit.field);
    } else {
      await editProxyField(proxy, selection.edit.field);
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

function hasProxyValues(proxy: ProxyConfig): boolean {
  return (
    proxy.type !== undefined ||
    proxy.url !== undefined ||
    proxy.authorization !== undefined ||
    proxy.strictSSL !== undefined ||
    (proxy.noProxy !== undefined && proxy.noProxy.length > 0)
  );
}

function hasRateLimitValues(rateLimit: RateLimitConfig): boolean {
  return (
    rateLimit.rpm !== undefined &&
    Number.isFinite(rateLimit.rpm) &&
    Number.isInteger(rateLimit.rpm) &&
    rateLimit.rpm >= 0
  );
}

async function editRateLimitField(
  rateLimit: RateLimitConfig,
  field: 'rpm',
): Promise<void> {
  const currentValue = rateLimit[field];

  const input = await vscode.window.showInputBox({
    title: t('Rate Limit (RPM)'),
    prompt: t('Enter maximum requests per minute (0 = disabled)'),
    value: currentValue?.toString() ?? '',
    placeHolder: '0',
    validateInput: (value) => {
      if (!value.trim()) return null;
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) {
        return t('Please enter a non-negative integer');
      }
      return null;
    },
  });

  if (input === undefined) {
    return;
  }

  if (!input.trim()) {
    rateLimit[field] = undefined;
  } else {
    rateLimit[field] = Number(input);
  }
}

function formatProxyType(type: ProxyType | undefined): string {
  switch (type) {
    case 'custom':
      return t('Custom');
    case 'direct':
      return t('Direct');
    case 'vscode':
    case undefined:
      return t('VS Code');
  }
}

function isSupportedProxyUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol.toLowerCase();
    return (
      protocol === 'http:' ||
      protocol === 'https:' ||
      protocol === 'socks:' ||
      protocol === 'socks4:' ||
      protocol === 'socks4a:' ||
      protocol === 'socks5:' ||
      protocol === 'socks5h:'
    );
  } catch {
    return false;
  }
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

async function editProxyField(
  proxy: ProxyConfig,
  field: 'type' | 'url' | 'authorization' | 'strictSSL' | 'noProxy',
): Promise<void> {
  if (field === 'type') {
    const picked = await pickQuickItem<
      vscode.QuickPickItem & { value: ProxyType | undefined }
    >({
      title: t('Proxy Type'),
      placeholder: t('Select proxy type'),
      ignoreFocusOut: true,
      items: [
        {
          label: t('VS Code'),
          description: t('Use VS Code proxy settings'),
          value: 'vscode',
          picked: proxy.type === undefined || proxy.type === 'vscode',
        },
        {
          label: t('Direct'),
          description: t('Connect directly without a proxy'),
          value: 'direct',
          picked: proxy.type === 'direct',
        },
        {
          label: t('Custom'),
          description: t('Use a custom HTTP(S) or SOCKS proxy'),
          value: 'custom',
          picked: proxy.type === 'custom',
        },
        {
          label: t('Default'),
          description: t('Clear provider proxy override'),
          value: undefined,
        },
      ],
    });
    if (picked) {
      proxy.type = picked.value;
    }
    return;
  }

  if (field === 'url') {
    const input = await vscode.window.showInputBox({
      title: t('Proxy URL'),
      prompt: t('Enter custom proxy URL'),
      value: proxy.url ?? '',
      placeHolder: t('e.g., http://127.0.0.1:7890 or socks5://127.0.0.1:1080'),
      validateInput: (value) => {
        const trimmed = value.trim();
        if (!trimmed) return null;
        return isSupportedProxyUrl(trimmed)
          ? null
          : t('Please enter a valid HTTP(S) or SOCKS proxy URL');
      },
    });
    if (input === undefined) return;
    const trimmed = input.trim();
    proxy.url = trimmed || undefined;
    if (trimmed && proxy.type === undefined) {
      proxy.type = 'custom';
    }
    return;
  }

  if (field === 'authorization') {
    const input = await vscode.window.showInputBox({
      title: t('Proxy Authorization'),
      prompt: t('Enter proxy authorization header or user:password credentials'),
      value: proxy.authorization ?? '',
      password: true,
    });
    if (input === undefined) return;
    proxy.authorization = input.trim() || undefined;
    return;
  }

  if (field === 'strictSSL') {
    const picked = await pickQuickItem<
      vscode.QuickPickItem & { value: boolean | undefined }
    >({
      title: t('Proxy Strict SSL'),
      placeholder: t('Select strict SSL mode'),
      ignoreFocusOut: true,
      items: [
        {
          label: t('Default'),
          description: t('Use VS Code proxyStrictSSL setting'),
          value: undefined,
          picked: proxy.strictSSL === undefined,
        },
        {
          label: t('Enabled'),
          value: true,
          picked: proxy.strictSSL === true,
        },
        {
          label: t('Disabled'),
          value: false,
          picked: proxy.strictSSL === false,
        },
      ],
    });
    if (picked) {
      proxy.strictSSL = picked.value;
    }
    return;
  }

  const input = await vscode.window.showInputBox({
    title: t('No Proxy'),
    prompt: t('Enter hosts that should bypass the proxy, separated by commas'),
    value: proxy.noProxy?.join(', ') ?? '',
    placeHolder: t('e.g., localhost, 127.0.0.1, .example.com'),
  });
  if (input === undefined) return;
  const entries = input
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  proxy.noProxy = entries.length > 0 ? entries : undefined;
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
