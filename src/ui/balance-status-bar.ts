import * as vscode from 'vscode';
import type { BalanceProviderState } from '../balance/types';
import { balanceManager } from '../balance';
import type { ConfigStore } from '../config-store';
import type { ProviderConfig } from '../types';
import { t } from '../i18n';
import { formatTokenTextCompact } from '../balance/token-display';

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

function parseRemainingPercentFromText(value: string): number | undefined {
  const match = value.match(/\((\d{1,3})%\)/);
  if (!match) {
    return undefined;
  }

  const parsed = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return clampPercent(parsed);
}

function resolveRemainingPercent(
  state: BalanceProviderState | undefined,
): number | undefined {
  const fromModelDisplay = state?.snapshot?.modelDisplay?.remainingPercent;
  if (
    typeof fromModelDisplay === 'number' &&
    Number.isFinite(fromModelDisplay)
  ) {
    return clampPercent(fromModelDisplay);
  }

  const snapshot = state?.snapshot;
  if (!snapshot) {
    return undefined;
  }

  const fromSummary = parseRemainingPercentFromText(snapshot.summary);
  if (fromSummary !== undefined) {
    return fromSummary;
  }

  for (const detail of snapshot.details) {
    const fromDetail = parseRemainingPercentFromText(detail);
    if (fromDetail !== undefined) {
      return fromDetail;
    }
  }

  return undefined;
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
  const lines: string[] = [];

  if (state?.lastError) {
    lines.push(formatTokenTextCompact(t('Error: {0}', state.lastError)));
  }

  const snapshot = state?.snapshot;
  if (snapshot) {
    const snapshotLines = snapshot.details
      .map((line) => line.trim())
      .filter((line) => !!line);

    if (snapshotLines.length > 0) {
      lines.push(...snapshotLines.map((line) => formatTokenTextCompact(line)));
    } else {
      const summary = snapshot.summary.trim();
      if (summary) {
        lines.push(formatTokenTextCompact(summary));
      } else if (lines.length === 0) {
        lines.push(t('No data'));
      }
    }
  }

  if (lines.length === 0) {
    lines.push(t('Not refreshed yet'));
  }

  return lines;
}

function formatProgressText(percent: number | undefined): string {
  if (percent === undefined) {
    return t('N/A');
  }

  return `${Math.round(clampPercent(percent))}%`;
}

function isUnlimitedText(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }

  const lower = normalized.toLowerCase();
  return (
    normalized.includes('∞') ||
    normalized.includes('无限') ||
    normalized.includes('不限') ||
    lower.includes('unlimited') ||
    lower.includes('no limit')
  );
}

function isUnlimitedBalanceState(
  state: BalanceProviderState | undefined,
): boolean {
  const snapshot = state?.snapshot;
  if (!snapshot) {
    return false;
  }

  const badgeText = snapshot.modelDisplay?.badge?.text;
  if (typeof badgeText === 'string' && isUnlimitedText(badgeText)) {
    return true;
  }

  if (isUnlimitedText(snapshot.summary)) {
    return true;
  }

  return snapshot.details.some((line) => isUnlimitedText(line));
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
    const icon = options.store.balanceStatusBarIcon;
    if (!icon.trim()) {
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

    item.text = icon;
    item.tooltip = buildTooltip(providers);
    item.show();
  };

  refresh();

  const storeDisposable = options.store.onDidChange(() => refresh());
  const balanceDisposable = balanceManager.onDidUpdate(() => refresh());

  return vscode.Disposable.from(item, storeDisposable, balanceDisposable);
}
