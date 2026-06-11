import * as vscode from 'vscode';
import type { ConfigStore } from '../config-store';
import { t } from '../i18n';
import { createUsageSnapshot } from '../usage/usage-aggregates';
import { formatCacheHitRate, formatInteger, formatTokens } from '../usage/format';
import { usageStore } from '../usage/usage-store';
import type { UsageSnapshot } from '../usage/types';

function escapeHtml(value: string): string {
  const normalized = value.replace(/[\r\n]+/g, ' ').trim();
  return normalized
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function startOfToday(): number {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function createTodaySnapshot(): UsageSnapshot {
  return createUsageSnapshot(
    usageStore.getRecords(),
    { id: 'today', label: t('Today'), since: startOfToday() },
    5,
  );
}

function createHistoricalSnapshot(): UsageSnapshot {
  return createUsageSnapshot(
    usageStore.getRecords(),
    { id: 'all', label: t('Historical Total Usage') },
    0,
  );
}

function buildTooltip(todaySnapshot: UsageSnapshot, historicalSnapshot: UsageSnapshot): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  markdown.supportHtml = true;
  markdown.isTrusted = false;

  markdown.appendMarkdown(
    `<table width="100%">
<tbody>
<tr><td><h4>${escapeHtml(t('Usage Statistics'))}</h4></td><td align="right">${escapeHtml(t('Today'))}</td></tr>
<tr><td>${escapeHtml(t('Requests'))}</td><td align="right">${escapeHtml(formatInteger(todaySnapshot.totals.requests))}</td></tr>
<tr><td>${escapeHtml(t('Total Tokens'))}</td><td align="right">${escapeHtml(formatTokens(todaySnapshot.totals.totalTokens))}</td></tr>
<tr><td>${escapeHtml(t('Cache Hit'))}</td><td align="right">${escapeHtml(formatCacheHitRate(todaySnapshot.totals))}</td></tr>
<tr><td>${escapeHtml(t('Historical Total Usage'))}</td><td align="right">${escapeHtml(formatTokens(historicalSnapshot.totals.totalTokens))}</td></tr>
</tbody>
</table>\n\n`,
  );

  for (const provider of todaySnapshot.byProvider.slice(0, 5)) {
    markdown.appendMarkdown(
      `<table width="100%">
<tbody>
<tr><td><strong>${escapeHtml(provider.label)}</strong></td><td align="right">${escapeHtml(formatTokens(provider.totalTokens))}</td></tr>
<tr><td>${escapeHtml(t('Requests'))}</td><td align="right">${escapeHtml(formatInteger(provider.requests))}</td></tr>
</tbody>
</table>\n\n`,
    );
  }

  return markdown;
}

export function registerUsageStatusBar(options: {
  context: vscode.ExtensionContext;
  store: ConfigStore;
}): vscode.Disposable {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    99,
  );
  item.command = 'unifyChatProvider.showUsageDashboard';

  const refresh = (): void => {
    const todaySnapshot = createTodaySnapshot();
    const historicalSnapshot = createHistoricalSnapshot();

    item.text = `$(graph) ${formatTokens(todaySnapshot.totals.totalTokens)}`;
    item.tooltip = buildTooltip(todaySnapshot, historicalSnapshot);
    item.show();
  };

  refresh();

  return vscode.Disposable.from(
    item,
    options.store.onDidChange(() => refresh()),
    usageStore.onDidChange(() => refresh()),
  );
}
