import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { t } from '../i18n';
import { createUsageSnapshot } from '../usage/usage-aggregates';
import { formatDateTime, formatInteger } from '../usage/format';
import { usageStore } from '../usage/usage-store';
import type { UsageRecord, UsageSnapshot, UsageTimeRange, UsageTotals } from '../usage/types';

const RECENT_LIMIT = 250;
let detailsPanel: vscode.WebviewPanel | undefined;
let detailsCustomRange: [number, number] | undefined;

interface UsageRangeView {
  id: string;
  label: string;
  since?: number;
  until?: number;
}

interface UsageRecordView extends Omit<UsageRecord, 'providerType'> {
  providerType: string;
  timeText: string;
  latencyText: string;
}

interface UsageDetailTexts {
  title: string;
  historicalTotalUsage: string;
  customTimeRange: string;
  startDate: string;
  endDate: string;
  updated: string;
  refresh: string;
  clear: string;
  requests: string;
  success: string;
  errors: string;
  totalTokens: string;
  prompt: string;
  completion: string;
  cacheHit: string;
  cachedInputTokens: string;
  averageLatency: string;
  recordsWithUsage: string;
  missing: string;
  dailyTrend: string;
  noUsageRecords: string;
  breakdown: string;
  provider: string;
  model: string;
  topUsage: string;
  recentRequests: string;
  filterPlaceholder: string;
  name: string;
  outcome: string;
  tokens: string;
  latency: string;
  requestDetail: string;
  time: string;
  vscodeModel: string;
  promptTokens: string;
  completionTokens: string;
  cachedTokens: string;
  total: string;
  cached: string;
  cancelled: string;
  notAvailable: string;
}

interface UsageDetailPayload extends Omit<UsageSnapshot, 'range' | 'recent'> {
  activeRangeId: string;
  ranges: UsageRangeView[];
  customRange: [number, number] | null;
  historicalTotals: UsageTotals;
  recent: UsageRecordView[];
  generatedAtText: string;
  locale: string;
  texts: UsageDetailTexts;
}

function endOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(23, 59, 59, 999);
  return date.getTime();
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function buildPresetRanges(): UsageTimeRange[] {
  return [
    { id: 'today', label: t('Today'), ...createDateRange(0) },
    { id: '7d', label: t('Last {0} days', '7'), since: startOfLocalDayOffset(6), until: endOfLocalDay(Date.now()) },
    { id: '30d', label: t('Last {0} days', '30'), since: startOfLocalDayOffset(29), until: endOfLocalDay(Date.now()) },
  ];
}

function createDateRange(daysAgo: number): Pick<UsageTimeRange, 'since' | 'until'> {
  return {
    since: startOfLocalDayOffset(daysAgo),
    until: endOfLocalDay(Date.now()),
  };
}

function startOfLocalDayOffset(daysAgo: number): number {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function createCustomRange(): UsageTimeRange | undefined {
  if (!detailsCustomRange) {
    return undefined;
  }

  const [start, end] = detailsCustomRange;
  return {
    id: 'custom',
    label: `${formatDateOnly(start)} - ${formatDateOnly(end)}`,
    since: startOfLocalDay(start),
    until: endOfLocalDay(end),
  };
}

function formatDateOnly(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString();
}

function createNonce(): string {
  return randomBytes(16).toString('base64');
}

function createRecordView(record: UsageRecord): UsageRecordView {
  return {
    ...record,
    providerType: record.providerType,
    timeText: formatDateTime(record.timestamp),
    latencyText: record.latencyMs === undefined
      ? 'N/A'
      : `${formatInteger(record.latencyMs)}ms`,
  };
}

function createTexts(): UsageDetailTexts {
  return {
    title: t('Usage Statistics'),
    historicalTotalUsage: t('Historical Total Usage'),
    customTimeRange: t('Custom time range'),
    startDate: t('Start date'),
    endDate: t('End date'),
    updated: t('Updated'),
    refresh: t('Refresh'),
    clear: t('Clear'),
    requests: t('Requests'),
    success: t('Success'),
    errors: t('Errors'),
    totalTokens: t('Total Tokens'),
    prompt: t('Prompt'),
    completion: t('Completion'),
    cacheHit: t('Cache Hit'),
    cachedInputTokens: t('Cached input tokens'),
    averageLatency: t('Avg Latency'),
    recordsWithUsage: t('records with usage'),
    missing: t('missing'),
    dailyTrend: t('Daily Trend'),
    noUsageRecords: t('No usage records in this range.'),
    breakdown: t('Breakdown'),
    provider: t('Provider'),
    model: t('Model'),
    topUsage: t('Top Usage'),
    recentRequests: t('Recent Requests'),
    filterPlaceholder: t('Filter provider, model, outcome'),
    name: t('Name'),
    outcome: t('Outcome'),
    tokens: t('Tokens'),
    latency: t('Latency'),
    requestDetail: t('Request Detail'),
    time: t('Time'),
    vscodeModel: t('VS Code Model'),
    promptTokens: t('Prompt Tokens'),
    completionTokens: t('Completion Tokens'),
    cachedTokens: t('Cached Tokens'),
    total: t('Total'),
    cached: t('Cached'),
    cancelled: t('Cancelled'),
    notAvailable: t('N/A'),
  };
}

function createPayload(): UsageDetailPayload {
  const ranges = buildPresetRanges();
  const range = createCustomRange() ?? ranges[0];
  const snapshot = createUsageSnapshot(usageStore.getRecords(), range, RECENT_LIMIT);
  return {
    activeRangeId: range.id,
    ranges: ranges.map((item) => ({
      id: item.id,
      label: item.label,
      since: item.since,
      until: item.until,
    })),
    customRange: detailsCustomRange ?? null,
    historicalTotals: usageStore.getHistoricalTotals(),
    totals: snapshot.totals,
    byProvider: snapshot.byProvider,
    byModel: snapshot.byModel,
    byDay: snapshot.byDay,
    trend: snapshot.trend,
    recent: snapshot.recent.map(createRecordView),
    generatedAtText: formatDateTime(Date.now()),
    locale: vscode.env.language,
    texts: createTexts(),
  };
}

function postUsageData(): void {
  if (!detailsPanel) {
    return;
  }

  void detailsPanel.webview.postMessage({
    type: 'usage-data',
    payload: createPayload(),
  });
}

function isUsageWebviewMessage(value: unknown): value is Record<string, unknown> & { type: string } {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.type === 'string';
}

function buildDetailsHtml(options: {
  context: vscode.ExtensionContext;
  webview: vscode.Webview;
}): string {
  const scriptUri = options.webview.asWebviewUri(
    vscode.Uri.joinPath(options.context.extensionUri, 'media', 'usage-detail', 'usage-detail.js'),
  );
  const styleUri = options.webview.asWebviewUri(
    vscode.Uri.joinPath(options.context.extensionUri, 'media', 'usage-detail', 'usage-detail.css'),
  );
  const nonce = createNonce();

  return `<!doctype html>
<html lang="${vscode.env.language}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${options.webview.cspSource} data:; style-src ${options.webview.cspSource} 'unsafe-inline'; script-src ${options.webview.cspSource} 'nonce-${nonce}'; font-src ${options.webview.cspSource}; connect-src 'none';">
<link rel="stylesheet" href="${styleUri}">
<title>${t('Usage Statistics')}</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
}

export function showUsageDashboard(context: vscode.ExtensionContext): void {
  if (detailsPanel) {
    detailsPanel.reveal(vscode.ViewColumn.Active);
  } else {
    detailsPanel = vscode.window.createWebviewPanel(
      'unifyChatProviderUsageDetails',
      t('Usage Statistics'),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'media', 'usage-detail'),
        ],
        retainContextWhenHidden: true,
      },
    );
    detailsPanel.webview.html = buildDetailsHtml({ context, webview: detailsPanel.webview });
    const usageChangeDisposable = usageStore.onDidChange(() => {
      postUsageData();
    });

    detailsPanel.onDidDispose(() => {
      usageChangeDisposable.dispose();
      detailsPanel = undefined;
    });
    detailsPanel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!isUsageWebviewMessage(message)) {
        return;
      }

      if (message.type === 'ready' || message.type === 'refresh') {
        postUsageData();
        return;
      }

      if (message.type === 'range' && typeof message.id === 'string') {
        detailsCustomRange = readRangeFromMessage(message);
        postUsageData();
        return;
      }

      if (message.type === 'clear') {
        await clearUsageStats();
        postUsageData();
      }
    });
  }

  postUsageData();
}

function readRangeFromMessage(message: Record<string, unknown>): [number, number] | undefined {
  const value = message.value;
  if (!Array.isArray(value) || value.length !== 2) {
    return undefined;
  }
  const [start, end] = value;
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return undefined;
  }
  return start <= end ? [start, end] : [end, start];
}

export async function clearUsageStats(): Promise<void> {
  const confirm = t('Clear');
  const selected = await vscode.window.showWarningMessage(
    t('Clear all stored usage statistics? This cannot be undone.'),
    { modal: true },
    confirm,
  );

  if (selected !== confirm) {
    return;
  }

  await usageStore.clear();
  vscode.window.showInformationMessage(t('Usage statistics cleared.'));
}
