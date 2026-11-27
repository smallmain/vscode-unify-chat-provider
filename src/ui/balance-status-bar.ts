import * as vscode from 'vscode';
import type {
  BalancePercentMetric,
  BalanceProviderState,
} from '../balance/types';
import {
  balanceManager,
  formatDetailLines,
  formatPrimaryBadge,
  isUnlimited,
  resolveProgressPercent,
} from '../balance';
import type { ConfigStore } from '../config-store';
import type { ProviderConfig } from '../types';
import { t } from '../i18n';

function hasConfiguredBalanceProvider(provider: ProviderConfig): boolean {
  return (
    !!provider.balanceProvider && provider.balanceProvider.method !== 'none'
  );
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
}

function resolveRemainingPercent(
  state: BalanceProviderState | undefined,
): number | undefined {
  return resolveProgressPercent(state?.snapshot);
}

function formatProgressBar(percent: number | undefined): string | undefined {
  const width = 30;

  if (percent === undefined) {
    return undefined;
  }

  const clamped = clampPercent(percent);
  const filled = Math.floor((clamped / 100) * width);
  const empty = Math.max(0, width - filled);
  return `${'█'.repeat(filled)}${'░'.repeat(empty)}`;
}

function formatBalanceDetail(
  state: BalanceProviderState | undefined,
): string[] {
  return formatDetailLines(state);
}

function formatProgressText(percent: number | undefined): string {
  if (percent === undefined) {
    return t('N/A');
  }

  return `${Math.round(clampPercent(percent))}%`;
}

function formatUsedPercentValue(metric: BalancePercentMetric): string {
  const used = metric.basis === 'used' ? metric.value : 100 - metric.value;
  return formatProgressText(used);
}

/**
 * Builds the text shown in the status bar when `balanceStatusBarMode` is
 * `summary`, e.g. `OpenCode Go: 45% / 71% / 0%` (monthly / weekly / 5-hour).
 * Percentages are the *used* share of each quota so the text matches the detail
 * lines and badges shown in the balance panel and the tooltip, and they keep
 * the order in which the provider reports them.
 */
function buildSummaryText(providers: ProviderConfig[]): string {
  return providers
    .map((provider) => {
      const snapshot = balanceManager.getProviderState(provider.name)?.snapshot;
      const percents = (snapshot?.items ?? []).filter(
        (item): item is BalancePercentMetric => item.type === 'percent',
      );

      if (percents.length === 0) {
        const badge = formatPrimaryBadge(snapshot);
        return badge ? `${provider.name}: ${badge}` : provider.name;
      }

      const values = percents.map(formatUsedPercentValue).join(' / ');
      return `${provider.name}: ${values}`;
    })
    .join('  |  ');
}

function isUnlimitedBalanceState(
  state: BalanceProviderState | undefined,
): boolean {
  return isUnlimited(state?.snapshot);
}

function escapeHtml(value: string): string {
  const normalized = value.replace(/[\r\n]+/g, ' ').trim();
  return normalized
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildTooltip(providers: ProviderConfig[]): vscode.MarkdownString {
  const sorted = [...providers].sort((a, b) => {
    const at = balanceManager.getProviderLastUsedAt(a.name) ?? 0;
    const bt = balanceManager.getProviderLastUsedAt(b.name) ?? 0;
    if (bt !== at) {
      return bt - at;
    }
    return a.name.localeCompare(b.name);
  });

  const markdown = new vscode.MarkdownString();
  markdown.supportHtml = true;
  markdown.isTrusted = false;
  markdown.appendMarkdown(
    `<table width="100%">
<tbody>
<tr>
<td width="70%"><h4>${escapeHtml(t('Provider Balance Monitoring'))}</h4></td>
<td width="30%" align="right">${escapeHtml('')}</td>
</tr>
</tbody>
</table>\n\n`,
  );

  sorted.forEach((provider, index) => {
    const state = balanceManager.getProviderState(provider.name);
    const percent = resolveRemainingPercent(state);
    const progressBar = formatProgressBar(percent);
    const progressText = isUnlimitedBalanceState(state)
      ? t('Unlimited')
      : formatProgressText(percent);
    const detailLines = formatBalanceDetail(state);
    const details = detailLines.map((line) => escapeHtml(line)).join('<br/>');
    const updatedAt = state?.snapshot?.updatedAt;
    const updatedText =
      typeof updatedAt === 'number' && Number.isFinite(updatedAt)
        ? new Date(updatedAt).toLocaleTimeString()
        : t('N/A');

    markdown.appendMarkdown(
      `<table width="100%">
<tbody>
<tr><td><strong>${escapeHtml(provider.name)}</strong></td><td align="right">${escapeHtml(progressText)}</td></tr>
${progressBar ? `<tr><td colspan="2">${escapeHtml(progressBar)}</td></tr>` : ''}
<tr><td>${escapeHtml(t('Details'))}</td><td align="right">${escapeHtml(t('{0} item(s)', String(detailLines.length)))}</td></tr>
<tr><td colspan="2">${details}</td></tr>
<tr><td>${escapeHtml(t('Updated'))}</td><td align="right">${escapeHtml(updatedText)}</td></tr>
</tbody>
</table>\n\n`,
    );

    if (index !== sorted.length - 1) {
      markdown.appendMarkdown('---\n\n<span style="height: 5px"></span>');
    }
  });

  return markdown;
}

export function registerBalanceStatusBar(options: {
  context: vscode.ExtensionContext;
  store: ConfigStore;
}): vscode.Disposable {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );

  item.command = 'unifyChatProvider.manageBalances';

  const refresh = (): void => {
    const mode = options.store.balanceStatusBarMode;
    const icon = options.store.balanceStatusBarIcon;
    if (mode === 'icon' && !icon.trim()) {
      item.hide();
      return;
    }

    const providers = options.store.endpoints.filter((provider) =>
      hasConfiguredBalanceProvider(provider),
    );

    if (providers.length === 0) {
      item.hide();
      return;
    }

    item.text = mode === 'summary' ? buildSummaryText(providers) : icon;
    item.tooltip = buildTooltip(providers);
    item.show();
  };

  refresh();

  const storeDisposable = options.store.onDidChange(() => refresh());
  const balanceDisposable = balanceManager.onDidUpdate(() => refresh());

  return vscode.Disposable.from(item, storeDisposable, balanceDisposable);
}
