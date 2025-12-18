import { ConfigStore } from '../config-store';
import { runUiStack } from './router/stack-router';
import type { UiContext } from './router/types';
import { runRemoveProviderScreen } from './screens/remove-provider-screen';

export async function manageProviders(store: ConfigStore): Promise<void> {
  const ctx: UiContext = { store };
  await runUiStack(ctx, { kind: 'providerList' });
}

export async function addProvider(store: ConfigStore): Promise<void> {
  const ctx: UiContext = { store };
  await runUiStack(ctx, { kind: 'providerForm' });
}

export async function removeProvider(store: ConfigStore): Promise<void> {
  await runRemoveProviderScreen(store);
}
