import type { BalanceProvider, BalanceProviderContext } from './balance-provider';
import type { BalanceConfig, BalanceMethod } from './types';
import { getBalanceMethodDefinition } from './definitions';

export function createBalanceProvider(
  context: BalanceProviderContext,
  config: BalanceConfig,
): BalanceProvider | null {
  const definition = getBalanceMethodDefinition(config.method);
  if (!definition) {
    return null;
  }
  return new definition.ctor(context, config);
}

export function createBalanceProviderForMethod(
  context: BalanceProviderContext,
  method: BalanceMethod,
  config?: BalanceConfig,
): BalanceProvider | null {
  if (method === 'none') {
    return null;
  }

  const definition = getBalanceMethodDefinition(method);
  if (!definition) {
    return null;
  }

  return new definition.ctor(
    context,
    config?.method === method ? config : undefined,
  );
}
