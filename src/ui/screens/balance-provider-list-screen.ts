import * as vscode from 'vscode';
import type { ProviderConfig } from '../../types';
import type { BalanceProviderState } from '../../balance/types';
import { balanceManager } from '../../balance';
import { evaluateBalanceWarning } from '../../balance/warning-utils';
import { formatTokenTextCompact } from '../../balance/token-display';
import { stableStringify } from '../../config-ops';
import { t } from '../../i18n';
import { pickQuickItem } from '../component';
import { createProviderDraft } from '../form-utils';
import { saveProviderDraft } from '../provider-ops';
import { editBalanceMonitorField, type ProviderFieldContext } from '../provider-fields';
import type {
  BalanceProviderListRoute,
  UiContext,
  UiNavAction,
  UiResume,
} from '../router/types';

type BalanceProviderListItem = vscode.QuickPickItem & {
  action?: 'noop' | 'provider' | 'configure' | 'refresh-all' | 'view-all-providers';
  providerName?: string;
};

function hasConfiguredBalanceProvider(provider: ProviderConfig): boolean {
  return !!provider.balanceProvider && provider.balanceProvider.method !== 'none';
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

  const percent = clampPercent(parsed);
  return percent;
}

function resolveRemainingPercent(state: BalanceProviderState | undefined): number | undefined {
  const fromModelDisplay = state?.snapshot?.modelDisplay?.remainingPercent;
  if (typeof fromModelDisplay === 'number' && Number.isFinite(fromModelDisplay)) {
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
  const width = 10;

  if (percent === undefined) {
    return undefined;
  }

  const clamped = clampPercent(percent);
  const filled = Math.floor((clamped / 100) * width);
  const empty = Math.max(0, width - filled);

  const bar = `${'█'.repeat(filled)}${'░'.repeat(empty)}`;
  return `${bar} ${Math.round(clamped)}%`;
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

function isUnlimitedBalanceState(state: BalanceProviderState | undefined): boolean {
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

function formatBalanceDetail(state: BalanceProviderState | undefined): string {
  const parts: string[] = [];

  if (state?.lastError) {
    parts.push(formatTokenTextCompact(t('Error: {0}', state.lastError)));
  }

  const snapshot = state?.snapshot;
  if (snapshot) {
    const snapshotLines = snapshot.details
      .map((line) => line.trim())
      .filter((line) => !!line);

    if (snapshotLines.length > 0) {
      parts.push(...snapshotLines.map((line) => formatTokenTextCompact(line)));
    } else {
      const summary = snapshot.summary.trim();
      if (summary) {
        parts.push(formatTokenTextCompact(summary));
      } else if (parts.length === 0) {
        parts.push(t('No data'));
      }
    }
  }

  if (parts.length === 0) {
    return t('Not refreshed yet');
  }

  return parts.join(' | ');
}

async function configureBalanceMonitor(options: {
  ctx: UiContext;
  providerName: string;
}): Promise<void> {
  const provider = options.ctx.store.getProvider(options.providerName);
  if (!provider) {
    vscode.window.showErrorMessage(
      t('Provider "{0}" not found.', options.providerName),
    );
    return;
  }

  const draft = createProviderDraft(provider);
  const fieldCtx: ProviderFieldContext = {
    store: options.ctx.store,
    originalName: provider.name,
    onEditModels: async () => {},
    onEditTimeout: async () => {},
    secretStore: options.ctx.secretStore,
    uriHandler: options.ctx.uriHandler,
  };

  const before = stableStringify(provider.balanceProvider);
  await editBalanceMonitorField(draft, fieldCtx);
  const after = stableStringify(draft.balanceProvider);
  if (before === after) {
    return;
  }

  const saved = await saveProviderDraft({
    draft,
    store: options.ctx.store,
    secretStore: options.ctx.secretStore,
    existing: provider,
    originalName: provider.name,
    skipConflictResolution: true,
  });

  if (saved === 'saved') {
    balanceManager.requestRefresh(provider.name, 'manual');
  }
}

export async function runBalanceProviderListScreen(
  ctx: UiContext,
  _route: BalanceProviderListRoute,
  _resume: UiResume | undefined,
): Promise<UiNavAction> {
  const buildItems = async (): Promise<BalanceProviderListItem[]> => {
    const providers = ctx.store.endpoints.filter((provider) =>
      hasConfiguredBalanceProvider(provider),
    );

    providers.sort((a, b) => {
      const at = balanceManager.getProviderLastUsedAt(a.name) ?? 0;
      const bt = balanceManager.getProviderLastUsedAt(b.name) ?? 0;
      if (bt !== at) {
        return bt - at;
      }
      return a.name.localeCompare(b.name);
    });

    const items: BalanceProviderListItem[] = [];

    if (providers.length === 0) {
      items.push({
        label: t('No providers have balance monitoring configured.'),
        description: t('Configure a balance monitor in provider settings.'),
        action: 'noop',
        alwaysShow: true,
      });
    } else {
      const warningThresholds = {
        ...ctx.store.balanceWarning,
        enabled: true,
      };

      for (const provider of providers) {
        const state = balanceManager.getProviderState(provider.name);
        const percent = resolveRemainingPercent(state);
        const description =
          formatProgressBar(percent) ??
          (isUnlimitedBalanceState(state) ? t('Unlimited') : undefined);
        const detail = formatBalanceDetail(state);
        const warning = evaluateBalanceWarning(
          state?.snapshot?.modelDisplay,
          warningThresholds,
        );
        const label = warning.isNearThreshold
          ? `$(warning) ${provider.name}`
          : provider.name;

        items.push({
          label,
          description,
          detail,
          action: 'provider',
          providerName: provider.name,
          buttons: [
            {
              iconPath: new vscode.ThemeIcon('refresh'),
              tooltip: t('Refresh now'),
            },
            {
              iconPath: new vscode.ThemeIcon('gear'),
              tooltip: t('Configure balance monitor'),
            },
          ],
        });
      }
    }

    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({
      label: '$(refresh) ' + t('Refresh all balances'),
      action: 'refresh-all',
      alwaysShow: true,
    });
    items.push({
      label: '$(list-unordered) ' + t('View all providers...'),
      action: 'view-all-providers',
      alwaysShow: true,
    });

    return items;
  };

  const selection = await pickQuickItem<BalanceProviderListItem>({
    title: t('Provider Balance Monitoring'),
    placeholder: t('Select a provider to view details'),
    ignoreFocusOut: false,
    items: await buildItems(),
    onInlineAction: async (item, qp) => {
      if (item.action === 'noop') {
        return true;
      }

      if (item.action === 'refresh-all') {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: t('Refreshing provider balances...'),
            cancellable: false,
          },
          async () => {
            await balanceManager.forceRefreshAll();
          },
        );
        qp.items = await buildItems();
        return true;
      }

      return;
    },
    onDidTriggerItemButton: async (event) => {
      const item = event.item;
      if (item.action !== 'provider' || !item.providerName) {
        return;
      }

      const buttonIndex = item.buttons?.findIndex((b) => b === event.button);
      if (buttonIndex === 0) {
        balanceManager.requestRefresh(item.providerName, 'manual');
        return;
      }

      if (buttonIndex === 1) {
        return { ...item, action: 'configure' };
      }

      return;
    },
    onExternalRefresh: (refreshItems) => {
      let disposed = false;
      let refreshInFlight = false;
      const disposables: vscode.Disposable[] = [];

      const refreshView = async (): Promise<void> => {
        if (disposed || refreshInFlight) {
          return;
        }
        refreshInFlight = true;
        try {
          refreshItems(await buildItems());
        } finally {
          refreshInFlight = false;
        }
      };

      disposables.push(ctx.store.onDidChange(() => void refreshView()));
      disposables.push(balanceManager.onDidUpdate(() => void refreshView()));

      void refreshView();

      return {
        dispose: () => {
          disposed = true;
          for (const disposable of disposables) {
            disposable.dispose();
          }
        },
      };
    },
  });

  if (!selection) {
    return { kind: 'pop' };
  }

  if (selection.action === 'view-all-providers') {
    return { kind: 'replace', route: { kind: 'providerList' } };
  }

  if (selection.action === 'configure' && selection.providerName) {
    await configureBalanceMonitor({
      ctx,
      providerName: selection.providerName,
    });
    return { kind: 'stay' };
  }

  if (selection.action === 'provider' && selection.providerName) {
    const existing = ctx.store.getProvider(selection.providerName);
    if (!existing) {
      vscode.window.showErrorMessage(
        t('Provider "{0}" not found.', selection.providerName),
      );
      return { kind: 'stay' };
    }

    const draft = createProviderDraft(existing);
    return {
      kind: 'push',
      route: {
        kind: 'modelList',
        invocation: 'providerEdit',
        models: draft.models,
        providerLabel: existing.name,
        requireAtLeastOne: false,
        draft,
        existing,
        originalName: existing.name,
        confirmDiscardOnBack: true,
        onSave: async () =>
          saveProviderDraft({
            draft,
            store: ctx.store,
            secretStore: ctx.secretStore,
            existing,
            originalName: existing.name,
          }),
        afterSave: 'pop',
      },
    };
  }

  return { kind: 'stay' };
}
