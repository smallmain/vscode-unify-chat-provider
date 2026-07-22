import * as vscode from 'vscode';
import {
  normalizeCompletionConfiguration,
  type CompletionConfigurationResult,
} from './configuration';

export const COMPLETION_CONFIGURATION_SECTION = 'unifyChatProvider.completion';

export type CompletionConfigurationKey =
  | 'enabled'
  | 'providers'
  | 'strategy';

export type CompletionConfigurationTarget =
  | vscode.ConfigurationTarget.Global
  | vscode.ConfigurationTarget.Workspace;

export interface ScopedCompletionConfigurationResult
  extends CompletionConfigurationResult {
  readonly explicit: {
    readonly enabled: boolean;
    readonly strategy: boolean;
  };
}

export function readCompletionConfiguration(): CompletionConfigurationResult {
  const configuration = vscode.workspace.getConfiguration(
    COMPLETION_CONFIGURATION_SECTION,
  );
  return normalizeCompletionConfiguration({
    enabled: configuration.get<unknown>('enabled'),
    providers: configuration.get<unknown>('providers'),
    strategy: configuration.get<unknown>('strategy'),
  });
}

function readValueAtTarget(
  configuration: vscode.WorkspaceConfiguration,
  key: CompletionConfigurationKey,
  target: CompletionConfigurationTarget,
): unknown {
  const inspected = configuration.inspect<unknown>(key);
  return target === vscode.ConfigurationTarget.Global
    ? inspected?.globalValue
    : inspected?.workspaceValue;
}

export function readScopedCompletionConfiguration(
  target: CompletionConfigurationTarget,
): ScopedCompletionConfigurationResult {
  const configuration = vscode.workspace.getConfiguration(
    COMPLETION_CONFIGURATION_SECTION,
  );
  const raw = {
    enabled: readValueAtTarget(configuration, 'enabled', target),
    providers: readValueAtTarget(configuration, 'providers', target),
    strategy: readValueAtTarget(configuration, 'strategy', target),
  };
  const normalized = normalizeCompletionConfiguration(raw);
  return {
    ...normalized,
    explicit: {
      enabled: raw.enabled !== undefined,
      strategy: raw.strategy !== undefined,
    },
  };
}

export function affectsCompletionConfiguration(
  event: vscode.ConfigurationChangeEvent,
): boolean {
  return event.affectsConfiguration(COMPLETION_CONFIGURATION_SECTION);
}

export async function updateCompletionConfiguration(
  key: CompletionConfigurationKey,
  value: unknown,
  target: CompletionConfigurationTarget,
): Promise<void> {
  await vscode.workspace
    .getConfiguration(COMPLETION_CONFIGURATION_SECTION)
    .update(key, value, target);
}

export async function clearCompletionConfiguration(
  key: CompletionConfigurationKey,
  target: CompletionConfigurationTarget,
): Promise<void> {
  await updateCompletionConfiguration(key, undefined, target);
}
