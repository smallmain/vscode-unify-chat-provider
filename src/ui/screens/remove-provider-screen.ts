import * as vscode from 'vscode';
import type { ConfigStore } from '../../config-store';
import {
  confirmRemove,
  pickAsyncQuickItems,
  showRemovedMessage,
  type AsyncQuickPickLoadResult,
} from '../component';
import { getAllModelsForProviderData } from '../../utils';
import { ModelConfig, ProviderConfig } from '../../types';
import { t } from '../../i18n';

type RemoveProviderItem = vscode.QuickPickItem & { providerName: string };

function buildProviderItem(
  p: ProviderConfig,
  allModels: readonly ModelConfig[],
): RemoveProviderItem {
  const modelList = allModels.map((m) => m.name || m.id).join(', ');
  return {
    label: p.name,
    description: p.baseUrl,
    detail: t('{0} model(s): {1}', allModels.length, modelList),
    providerName: p.name,
  };
}

async function loadProviderItems(
  providers: readonly ProviderConfig[],
  previous = new Map<string, RemoveProviderItem>(),
  providersToLoad: readonly ProviderConfig[] = providers,
  forceFetch = false,
): Promise<AsyncQuickPickLoadResult<RemoveProviderItem>> {
  const results = await Promise.allSettled(
    providersToLoad.map(async (provider) => ({
      provider,
      result: await getAllModelsForProviderData(provider, { forceFetch }),
    })),
  );
  const failedProviders: ProviderConfig[] = [];
  const failures: { label: string; message: string }[] = [];

  for (let index = 0; index < results.length; index++) {
    const provider = providersToLoad[index];
    const result = results[index];
    if (!provider || !result) continue;
    if (result.status === 'fulfilled') {
      previous.set(
        provider.name,
        buildProviderItem(provider, result.value.result.models),
      );
      if (result.value.result.error) {
        failedProviders.push(provider);
        failures.push({
          label: provider.name,
          message: result.value.result.error,
        });
      }
      continue;
    }

    failedProviders.push(provider);
    failures.push({
      label: provider.name,
      message:
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason),
    });
    if (!previous.has(provider.name)) {
      previous.set(provider.name, buildProviderItem(provider, provider.models));
    }
  }

  return {
    items: providers.flatMap((provider) => {
      const item = previous.get(provider.name);
      return item ? [item] : [];
    }),
    failures,
    ...(failedProviders.length > 0
      ? {
          retry: () =>
            loadProviderItems(providers, previous, failedProviders, true),
        }
      : {}),
  };
}

export async function runRemoveProviderScreen(
  store: ConfigStore,
): Promise<void> {
  const endpoints = store.endpoints;
  if (endpoints.length === 0) {
    vscode.window.showInformationMessage(t('No providers configured.'));
    return;
  }

  const selections = await pickAsyncQuickItems<RemoveProviderItem>({
    title: t('Remove Provider'),
    placeholder: t('Select a provider to remove'),
    loadingPlaceholder: t('Loading models...'),
    retryLabel: t('Retry Failed Providers'),
    loadItems: () => loadProviderItems(endpoints),
  });
  const selection = selections?.[0];

  if (!selection) return;

  const confirmed = await confirmRemove(selection.providerName, 'provider');
  if (!confirmed) return;

  await store.removeProvider(selection.providerName);
  showRemovedMessage(selection.providerName, 'Provider');
}
