import { isDeepStrictEqual } from 'node:util';
import * as vscode from 'vscode';
import { t } from '../i18n';
import { pickLanguageModel } from '../language-model-picker';
import type { ConfigStore } from '../config-store';
import {
  getAllModelsForProviderData,
  getAllModelsForProviderSync,
} from '../utils';
import {
  pickAsyncQuickItems,
  pickQuickItem,
  type AsyncQuickPickLoadResult,
} from '../ui/component';
import type {
  NesAggressivenessSetting,
  NesPromptStrategy,
} from '../chat-lib/core/behavior-config';
import { completionAlgorithmRegistry } from './definitions';
import {
  candidateSupportsAlgorithm,
  candidateSupportsCopilotNes,
  CurrentProviderModelCatalog,
  type CurrentProviderCatalogSnapshot,
  type CurrentProviderModelCandidate,
} from './current-provider-models';
import {
  buildCompletionAlgorithmEntry,
  buildCompletionStrategy,
  cloneCompletionAlgorithmEntry,
  createCompletionAlgorithmEntryDraft,
  createCompletionStrategyDraft,
  updateStrategyForRemovedEntry,
  updateStrategyForRenamedEntry,
  type CompletionAlgorithmEntryDraft,
  type CompletionAlgorithmEntryDraftError,
  type CompletionStopConditionType,
  type CompletionStrategyDraft,
  type StrategyDraftError,
} from './settings-model';
import type {
  CompletionAlgorithmId,
  CompletionAlgorithmEntry,
  CompletionModelEligibility,
  CompletionModelResolver,
  CompletionModelReference,
  CompletionStrategy,
} from './types';
import {
  clearCompletionConfiguration,
  readScopedCompletionConfiguration,
  updateCompletionConfiguration,
  type CompletionConfigurationKey,
  type CompletionConfigurationTarget,
  type ScopedCompletionConfigurationResult,
} from './vscode-configuration';

interface CopilotNesStrategyItem extends vscode.QuickPickItem {
  value: NesPromptStrategy;
}

interface CopilotEagernessItem extends vscode.QuickPickItem {
  value: NesAggressivenessSetting;
}

interface ValueItem<T> extends vscode.QuickPickItem {
  value: T;
}

type MainSettingsAction =
  | 'status'
  | 'add'
  | 'add-current'
  | 'provider'
  | 'strategy'
  | 'reset';

interface MainSettingsItem extends vscode.QuickPickItem {
  action?: MainSettingsAction;
  providerId?: string;
}

type ProviderFormField =
  | 'id'
  | 'algorithm'
  | 'simpleModel'
  | 'copilotModes'
  | 'copilotFimModel'
  | 'copilotN'
  | 'copilotNesModel'
  | 'copilotCursorPredictionModel'
  | 'copilotUnifiedModel'
  | 'copilotNesStrategy'
  | 'copilotEagerness'
  | 'copilotModelUnification'
  | 'zedModel'
  | 'zedMaxTokens'
  | 'inceptionModel'
  | 'mistralModel'
  | 'mistralMaxTokens';

type CompletionModelRequestKind = Parameters<
  NonNullable<CompletionModelResolver['evaluateModelForRequest']>
>[1];

export const COMPLETION_MODEL_REQUEST_KIND_BY_FIELD = {
  simpleModel: 'simple',
  copilotFimModel: 'copilot-replica/fim',
  copilotNesModel: 'copilot-replica/nes',
  copilotUnifiedModel: 'copilot-replica/nes',
  copilotCursorPredictionModel: 'copilot-replica/cursor-prediction',
  zedModel: 'zed',
  inceptionModel: 'inception',
  mistralModel: 'mistral',
} as const satisfies Partial<
  Record<ProviderFormField, CompletionModelRequestKind>
>;

interface ProviderFormItem extends vscode.QuickPickItem {
  action?: 'save';
  field?: ProviderFormField;
}

interface CurrentProviderAlgorithmItem extends vscode.QuickPickItem {
  action: 'algorithm' | 'manage' | 'status';
  algorithm?: CompletionAlgorithmId;
  candidates?: readonly CurrentProviderModelCandidate[];
}

interface CurrentProviderModelItem extends vscode.QuickPickItem {
  candidate: CurrentProviderModelCandidate;
}

type CompletionProviderStore = Pick<ConfigStore, 'endpoints'>;

type StrategyFormField =
  | 'mode'
  | 'disableVSCodeBuiltinCompletion'
  | 'disabledGlobs'
  | 'mainProvider'
  | 'parallelRequestOthers'
  | 'mainFirstTimeoutMs'
  | 'stopType'
  | 'firstUsableGraceMs'
  | 'deadlineTimeoutMs'
  | 'enoughResultsMinItems'
  | 'enoughResultsGraceMs';

interface StrategyFormItem extends vscode.QuickPickItem {
  action?: 'save';
  field?: StrategyFormField;
}

type ProviderFormResult =
  | { kind: 'saved'; entry: CompletionAlgorithmEntry }
  | { kind: 'cancelled' };

type StrategyFormResult =
  | { kind: 'saved'; strategy: CompletionStrategy }
  | { kind: 'cancelled' };

type SettingsPageResult = 'back' | 'close';
type UnsavedChoice = 'save' | 'discard' | 'continue';

const COPILOT_NES_STRATEGIES = [
  { label: 'Copilot NES Xtab', value: 'copilotNesXtab' },
  { label: 'Xtab 275', value: 'xtab275' },
  { label: 'Xtab Unified Model', value: 'xtabUnifiedModel' },
  { label: 'Xtab Aggressiveness', value: 'xtabAggressiveness' },
  { label: 'Xtab 275 Aggressiveness', value: 'xtab275Aggressiveness' },
  {
    label: 'Xtab 275 Aggressiveness High/Low',
    value: 'xtab275AggressivenessHighLow',
  },
  { label: 'Xtab 275 Edit Intent', value: 'xtab275EditIntent' },
  {
    label: 'Xtab 275 Edit Intent Short',
    value: 'xtab275EditIntentShort',
  },
] as const satisfies readonly {
  readonly label: string;
  readonly value: NesPromptStrategy;
}[];

export function buildCopilotNesStrategyItems(
  current: NesPromptStrategy,
): CopilotNesStrategyItem[] {
  return COPILOT_NES_STRATEGIES.map((item) => ({
    ...item,
    picked: item.value === current,
  }));
}

export function buildCopilotEagernessItems(
  current: NesAggressivenessSetting,
): CopilotEagernessItem[] {
  const items: readonly CopilotEagernessItem[] = [
    { label: t('Auto'), value: 'auto' },
    { label: t('Low'), value: 'low' },
    { label: t('Medium'), value: 'medium' },
    { label: t('High'), value: 'high' },
  ];
  return items.map((item) => ({
    ...item,
    picked: item.value === current,
  }));
}

export function buildModelStrategyItems(
  unified: boolean,
): ValueItem<boolean>[] {
  return [
    {
      label: t('Unified Model'),
      description: t(
        'Use one unified model for both FIM insertions and NES edits.',
      ),
      value: true,
      picked: unified,
    },
    {
      label: t('Independent Models'),
      description: t(
        'Use separate FIM and NES models with the official separate-provider presentation behavior.',
      ),
      value: false,
      picked: !unified,
    },
  ];
}

export function buildSchedulingModeItems(
  current: CompletionStrategy['mode'],
): ValueItem<CompletionStrategy['mode']>[] {
  return [
    {
      label: t('All Providers Concurrent'),
      description: 'all',
      value: 'all',
      picked: current === 'all',
    },
    {
      label: t('Main Provider First'),
      description: 'main-first',
      value: 'main-first',
      picked: current === 'main-first',
    },
  ];
}

export function buildDisableVSCodeBuiltinCompletionItems(
  current: boolean,
): ValueItem<boolean>[] {
  return [
    {
      label: t('Enabled'),
      description: 'true',
      value: true,
      picked: current,
    },
    {
      label: t('Disabled'),
      description: 'false',
      value: false,
      picked: !current,
    },
  ];
}

export function buildOtherProvidersStartTimingItems(
  current: boolean,
): ValueItem<boolean>[] {
  return [
    {
      label: t('Start with Main Provider'),
      description: 'true',
      value: true,
      picked: current,
    },
    {
      label: t('Start on Main Provider Fallback'),
      description: 'false',
      value: false,
      picked: !current,
    },
  ];
}

export function buildStopConditionItems(
  current: CompletionStopConditionType,
): ValueItem<CompletionStopConditionType>[] {
  return [
    {
      label: t('First Usable Result'),
      description: 'firstUsable',
      value: 'firstUsable',
      picked: current === 'firstUsable',
    },
    {
      label: t('Time Limit'),
      description: 'deadline',
      value: 'deadline',
      picked: current === 'deadline',
    },
    {
      label: t('Result Count'),
      description: 'enoughResults',
      value: 'enoughResults',
      picked: current === 'enoughResults',
    },
    {
      label: t('All Completed'),
      description: 'allSettled',
      value: 'allSettled',
      picked: current === 'allSettled',
    },
  ];
}

function scopeLabel(target: CompletionConfigurationTarget): string {
  return target === vscode.ConfigurationTarget.Global
    ? t('User')
    : t('Workspace');
}

function hasWorkspaceTarget(): boolean {
  return (
    vscode.workspace.workspaceFile !== undefined ||
    (vscode.workspace.workspaceFolders?.length ?? 0) > 0
  );
}

export function buildConfigurationTargetItems(
  workspaceAvailable: boolean,
): ValueItem<CompletionConfigurationTarget>[] {
  const items: ValueItem<CompletionConfigurationTarget>[] = [
    {
      label: t('User'),
      description: t('Apply to all workspaces'),
      value: vscode.ConfigurationTarget.Global,
    },
  ];
  if (workspaceAvailable) {
    items.push({
      label: t('Workspace'),
      description: t('Apply only to this workspace'),
      value: vscode.ConfigurationTarget.Workspace,
    });
  }
  return items;
}

async function pickConfigurationTarget(): Promise<
  CompletionConfigurationTarget | undefined
> {
  const selected = await vscode.window.showQuickPick(
    buildConfigurationTargetItems(hasWorkspaceTarget()),
    {
      title: t('Code Completion Settings'),
      placeHolder: t('Select the configuration scope'),
    },
  );
  return selected?.value;
}

function createSeparator(description?: string): vscode.QuickPickItem {
  return {
    label: '',
    kind: vscode.QuickPickItemKind.Separator,
    ...(description ? { description } : {}),
  };
}

function providerDetail(provider: CompletionAlgorithmEntry): string {
  const definition = completionAlgorithmRegistry.get(provider.algorithm);
  if (!definition) {
    return t(
      'Invalid configuration: Unknown algorithm "{0}".',
      provider.algorithm,
    );
  }
  return (
    definition.getSettingsDetail?.(provider.options) ??
    t('Invalid configuration: Completion details are unavailable.')
  );
}

export function buildMainSettingsItems(
  target: CompletionConfigurationTarget,
  state: ScopedCompletionConfigurationResult,
): MainSettingsItem[] {
  const { configuration, explicit } = state;
  const statusIsUnset =
    target === vscode.ConfigurationTarget.Workspace && !explicit.enabled;
  const statusIsDefault =
    target === vscode.ConfigurationTarget.Global && !explicit.enabled;
  const statusIcon = statusIsUnset
    ? 'circle-dashed'
    : configuration.enabled
      ? 'check'
      : 'warning';
  const statusDescription = statusIsUnset
    ? t('Not Set')
    : statusIsDefault
      ? t('Default (Enabled)')
      : configuration.enabled
        ? t('Enabled')
        : t('Disabled');
  const items: MainSettingsItem[] = [
    {
      label: `$(${statusIcon}) ${t('Status')}`,
      description: statusDescription,
      action: 'status',
    },
  ];

  items.push(createSeparator());
  items.push({
    label: `$(add) ${t('Add Completion Provider')}`,
    action: 'add',
  });
  items.push({
    label: `$(star-empty) ${t('Add From Current Provider List...')}`,
    action: 'add-current',
  });

  if (configuration.providers.length > 0) {
    items.push(createSeparator());
    for (const provider of configuration.providers) {
      const definition = completionAlgorithmRegistry.get(provider.algorithm);
      items.push({
        label: `$(symbol-method) ${provider.id}`,
        description: definition?.label ?? provider.algorithm,
        detail: providerDetail(provider),
        action: 'provider',
        providerId: provider.id,
        buttons: [
          {
            iconPath: new vscode.ThemeIcon('files'),
            tooltip: t('Clone Completion Provider'),
          },
          {
            iconPath: new vscode.ThemeIcon('trash'),
            tooltip: t('Delete Completion Provider'),
          },
        ],
      });
    }
  }

  items.push(createSeparator());
  const strategyIsUnset =
    target === vscode.ConfigurationTarget.Workspace && !explicit.strategy;
  items.push({
    label: strategyIsUnset
      ? `$(circle-dashed) ${t('Completion Strategy Settings (Not Set)')}`
      : `$(settings-gear) ${t('Completion Strategy Settings')}`,
    action: 'strategy',
  });

  items.push(createSeparator());
  items.push({
    label: `$(discard) ${t('Reset Current Scope')}`,
    action: 'reset',
  });
  return items;
}

export function createUniqueCompletionProviderId(
  algorithm: CompletionAlgorithmId,
  providers: readonly CompletionAlgorithmEntry[],
): string {
  const existingIds = new Set(providers.map((provider) => provider.id));
  if (!existingIds.has(algorithm)) return algorithm;
  let suffix = 2;
  while (existingIds.has(`${algorithm}-${suffix}`)) suffix++;
  return `${algorithm}-${suffix}`;
}

export function createCurrentProviderCompletionDraft(
  algorithm: CompletionAlgorithmId,
  candidate: CurrentProviderModelCandidate,
  providers: readonly CompletionAlgorithmEntry[],
): CompletionAlgorithmEntryDraft {
  const draft = createCompletionAlgorithmEntryDraft();
  const reference = { ...candidate.reference };
  draft.id = createUniqueCompletionProviderId(algorithm, providers);
  draft.algorithm = algorithm;

  switch (algorithm) {
    case 'simple':
      draft.simple.model = reference;
      break;
    case 'copilot-replica': {
      const supportsFim = candidate.supportedRequests.has(
        'copilot-replica/fim',
      );
      const supportsNes = candidateSupportsCopilotNes(candidate);
      draft.copilotReplica.enableFIM = supportsFim;
      draft.copilotReplica.enableNES = supportsNes;
      draft.copilotReplica.modelUnification = supportsFim && supportsNes;
      if (supportsFim && supportsNes) {
        draft.copilotReplica.unifiedModel = reference;
      } else if (supportsFim) {
        draft.copilotReplica.fimModel = reference;
      } else if (supportsNes) {
        draft.copilotReplica.nesModel = reference;
      }
      break;
    }
    case 'zed':
      draft.zed.model = reference;
      break;
    case 'inception':
      draft.inception.model = reference;
      break;
    case 'mistral':
      draft.mistral.model = reference;
      break;
  }
  return draft;
}

export function buildCurrentProviderAlgorithmItems(
  snapshot: CurrentProviderCatalogSnapshot,
): CurrentProviderAlgorithmItem[] {
  const items = completionAlgorithmRegistry.list().flatMap((definition) => {
    const candidates = snapshot.candidates.filter((candidate) =>
      candidateSupportsAlgorithm(candidate, definition.id),
    );
    return candidates.length > 0
      ? [
          {
            label: definition.label,
            description: definition.id,
            detail: t('{0} eligible model(s)', candidates.length),
            action: 'algorithm' as const,
            algorithm: definition.id,
            candidates,
          },
        ]
      : [];
  });
  if (items.length > 0) return items;
  return [
    {
      label: `$(info) ${t('No eligible completion models are available')}`,
      action: 'status',
    },
    {
      label: `$(settings-gear) ${t('Manage Providers')}`,
      action: 'manage',
    },
  ];
}

function toCurrentProviderAlgorithmLoadResult(
  snapshot: CurrentProviderCatalogSnapshot,
  catalog: CurrentProviderModelCatalog,
): AsyncQuickPickLoadResult<CurrentProviderAlgorithmItem> {
  return {
    items: buildCurrentProviderAlgorithmItems(snapshot),
    failures: snapshot.failures.map((failure) => ({
      label: failure.providerName,
      message: failure.message,
    })),
    ...(snapshot.failures.length > 0
      ? {
          retry: async () =>
            toCurrentProviderAlgorithmLoadResult(
              await catalog.retryFailures(),
              catalog,
            ),
        }
      : {}),
  };
}

async function pickCurrentProviderAlgorithm(
  catalog: CurrentProviderModelCatalog,
): Promise<CurrentProviderAlgorithmItem | undefined> {
  const selected = await pickAsyncQuickItems<CurrentProviderAlgorithmItem>({
    title: t('Add From Current Provider List'),
    loadingPlaceholder: t('Loading provider models...'),
    placeholder: t('Select a completion algorithm'),
    retryLabel: t('Retry Failed Providers'),
    ignoreFocusOut: true,
    loadItems: async () =>
      toCurrentProviderAlgorithmLoadResult(await catalog.load(), catalog),
    onWillAccept: (items) => items[0]?.action !== 'status',
  });
  return selected?.[0];
}

async function pickCurrentProviderModel(
  algorithm: CompletionAlgorithmId,
  candidates: readonly CurrentProviderModelCandidate[],
): Promise<CurrentProviderModelCandidate | undefined> {
  const definition = completionAlgorithmRegistry.get(algorithm);
  const selected = await pickQuickItem<CurrentProviderModelItem>({
    title: t(
      'Select a Model for {0}',
      definition?.label ?? algorithm,
    ),
    placeholder: t('Select a model'),
    ignoreFocusOut: true,
    items: candidates.map((candidate) => ({
      label: candidate.model.name || candidate.model.id,
      description: candidate.providerName,
      detail: candidate.model.id,
      candidate,
    })),
    buttons: [vscode.QuickInputButtons.Back],
    onDidTriggerButton: (button, quickPick) => {
      if (button === vscode.QuickInputButtons.Back) quickPick.hide();
    },
  });
  return selected?.candidate;
}

async function editStatus(
  target: CompletionConfigurationTarget,
  state: ScopedCompletionConfigurationResult,
): Promise<void> {
  const selected = await vscode.window.showQuickPick(
    buildStatusItems(target, state),
    {
      title: t('Status'),
      placeHolder: t('Select the code completion status'),
    },
  );
  if (!selected) {
    return;
  }
  if (selected.value === undefined) {
    await clearCompletionConfiguration('enabled', target);
  } else {
    await updateCompletionConfiguration('enabled', selected.value, target);
  }
}

export function buildStatusItems(
  target: CompletionConfigurationTarget,
  state: ScopedCompletionConfigurationResult,
): ValueItem<boolean | undefined>[] {
  const current = state.explicit.enabled
    ? state.configuration.enabled
    : undefined;
  return target === vscode.ConfigurationTarget.Global
    ? [
        {
          label: t('Default (Enabled)'),
          description: 'default',
          value: undefined,
          picked: current === undefined,
        },
        {
          label: t('Enabled'),
          description: 'true',
          value: true,
          picked: current === true,
        },
        {
          label: t('Disabled'),
          description: 'false',
          value: false,
          picked: current === false,
        },
      ]
    : [
        {
          label: t('Not Set'),
          description: 'undefined',
          value: undefined,
          picked: current === undefined,
        },
        {
          label: t('Enabled'),
          description: 'true',
          value: true,
          picked: current === true,
        },
        {
          label: t('Disabled'),
          description: 'false',
          value: false,
          picked: current === false,
        },
      ];
}

async function confirmDeleteProvider(providerId: string): Promise<boolean> {
  const deleteLabel = t('Delete');
  const selected = await vscode.window.showWarningMessage(
    t('Delete completion provider "{0}"?', providerId),
    { modal: true },
    deleteLabel,
  );
  return selected === deleteLabel;
}

async function confirmResetScope(
  target: CompletionConfigurationTarget,
): Promise<boolean> {
  const resetLabel = t('Reset');
  const selected = await vscode.window.showWarningMessage(
    t(
      'Reset all code completion settings in the {0} scope?',
      scopeLabel(target),
    ),
    { modal: true },
    resetLabel,
  );
  return selected === resetLabel;
}

export async function resetScope(
  target: CompletionConfigurationTarget,
): Promise<void> {
  const keys: readonly CompletionConfigurationKey[] = [
    'providers',
    'strategy',
    'enabled',
  ];
  for (const key of keys) {
    await clearCompletionConfiguration(key, target);
  }
}

export async function updateProvidersAndStrategy(
  target: CompletionConfigurationTarget,
  previousStrategy: CompletionStrategy,
  providers: readonly CompletionAlgorithmEntry[],
  strategy: CompletionStrategy,
): Promise<void> {
  if (strategy === previousStrategy) {
    await updateCompletionConfiguration('providers', providers, target);
    return;
  }

  await updateCompletionConfiguration('strategy', strategy, target);
  try {
    await updateCompletionConfiguration('providers', providers, target);
  } catch (error) {
    try {
      await updateCompletionConfiguration(
        'strategy',
        previousStrategy,
        target,
      );
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Updating completion providers failed and the strategy rollback also failed.',
      );
    }
    throw error;
  }
}

export async function updateProvidersAfterEdit(
  target: CompletionConfigurationTarget,
  original: CompletionAlgorithmEntry | undefined,
  provider: CompletionAlgorithmEntry,
): Promise<boolean> {
  const latest = readScopedCompletionConfiguration(target);
  const originalId = original?.id;
  if (originalId) {
    const latestOriginal = latest.configuration.providers.find(
      (candidate) => candidate.id === originalId,
    );
    if (
      !latestOriginal ||
      !isDeepStrictEqual(latestOriginal, original)
    ) {
      await vscode.window.showErrorMessage(
        t(
          'Completion provider "{0}" changed outside this form. Reopen it and try again.',
          originalId,
        ),
        { modal: true },
      );
      return false;
    }
    if (
      provider.id !== originalId &&
      latest.configuration.providers.some(
        (candidate) => candidate.id === provider.id,
      )
    ) {
      await vscode.window.showErrorMessage(t('Provider ID must be unique.'), {
        modal: true,
      });
      return false;
    }
  } else if (
    latest.configuration.providers.some(
      (candidate) => candidate.id === provider.id,
    )
  ) {
    await vscode.window.showErrorMessage(t('Provider ID must be unique.'), {
      modal: true,
    });
    return false;
  }

  const providers = originalId
    ? latest.configuration.providers.map((candidate) =>
        candidate.id === originalId ? provider : candidate,
      )
    : [...latest.configuration.providers, provider];
  const strategy =
    originalId && originalId !== provider.id && latest.explicit.strategy
      ? updateStrategyForRenamedEntry(
          latest.configuration.strategy,
          originalId,
          provider.id,
        )
      : latest.configuration.strategy;
  await updateProvidersAndStrategy(
    target,
    latest.configuration.strategy,
    providers,
    strategy,
  );
  return true;
}

async function deleteProvider(
  target: CompletionConfigurationTarget,
  providerId: string,
): Promise<void> {
  const latest = readScopedCompletionConfiguration(target);
  const providers = latest.configuration.providers.filter(
    (provider) => provider.id !== providerId,
  );
  const strategy = latest.explicit.strategy
    ? updateStrategyForRemovedEntry(
        latest.configuration.strategy,
        providerId,
      )
    : latest.configuration.strategy;
  await updateProvidersAndStrategy(
    target,
    latest.configuration.strategy,
    providers,
    strategy,
  );
}

export async function updateStrategyAfterEdit(
  target: CompletionConfigurationTarget,
  original: ScopedCompletionConfigurationResult,
  strategy: CompletionStrategy,
): Promise<boolean> {
  const latest = readScopedCompletionConfiguration(target);
  if (
    latest.explicit.strategy !== original.explicit.strategy ||
    !isDeepStrictEqual(
      latest.configuration.strategy,
      original.configuration.strategy,
    )
  ) {
    await vscode.window.showErrorMessage(
      t(
        'The completion strategy changed outside this form. Reopen it and try again.',
      ),
      { modal: true },
    );
    return false;
  }
  if (
    strategy.mode === 'main-first' &&
    !latest.configuration.providers.some(
      (provider) => provider.id === strategy.mainProvider,
    )
  ) {
    await vscode.window.showErrorMessage(
      t('The selected main completion provider no longer exists.'),
      { modal: true },
    );
    return false;
  }
  await updateCompletionConfiguration('strategy', strategy, target);
  return true;
}

async function handleProviderItemButton(
  target: CompletionConfigurationTarget,
  event: vscode.QuickPickItemButtonEvent<MainSettingsItem>,
  quickPick: vscode.QuickPick<MainSettingsItem>,
): Promise<void> {
  const providerId = event.item.providerId;
  if (!providerId) {
    return;
  }
  const state = readScopedCompletionConfiguration(target);
  const provider = state.configuration.providers.find(
    (candidate) => candidate.id === providerId,
  );
  if (!provider) {
    quickPick.items = buildMainSettingsItems(
      target,
      readScopedCompletionConfiguration(target),
    );
    return;
  }
  const buttonIndex = event.item.buttons?.indexOf(event.button) ?? -1;
  if (buttonIndex === 0) {
    const latest = readScopedCompletionConfiguration(target);
    const latestProvider = latest.configuration.providers.find(
      (candidate) => candidate.id === provider.id,
    );
    if (!latestProvider) return;
    const clone = cloneCompletionAlgorithmEntry(
      latestProvider,
      latest.configuration.providers,
    );
    await updateCompletionConfiguration(
      'providers',
      [...latest.configuration.providers, clone],
      target,
    );
    void vscode.window.showInformationMessage(
      t('Completion provider cloned as "{0}".', clone.id),
    );
  } else if (buttonIndex === 1) {
    if (!(await confirmDeleteProvider(provider.id))) {
      return;
    }
    await deleteProvider(target, provider.id);
  } else {
    return;
  }
  quickPick.items = buildMainSettingsItems(
    target,
    readScopedCompletionConfiguration(target),
  );
}

function formField(
  label: string,
  description: string | undefined,
  field: ProviderFormField,
  icon: string,
): ProviderFormItem {
  return {
    label: `$(${icon}) ${label}`,
    description,
    field,
  };
}

function modelDescription(
  model: CompletionModelReference | undefined,
): string {
  return model ? `${model.vendor}/${model.id}` : t('Not Set');
}

function algorithmDescription(
  algorithm: CompletionAlgorithmId | undefined,
): string {
  return algorithm
    ? (completionAlgorithmRegistry.get(algorithm)?.label ?? algorithm)
    : t('Not Selected');
}

function copilotModesDescription(draft: CompletionAlgorithmEntryDraft): string {
  if (draft.copilotReplica.enableFIM && draft.copilotReplica.enableNES) {
    return t('FIM + NES');
  }
  return draft.copilotReplica.enableNES ? 'NES' : 'FIM';
}

export function buildProviderFormItems(
  draft: CompletionAlgorithmEntryDraft,
): ProviderFormItem[] {
  const items: ProviderFormItem[] = [];
  items.push(createSeparator(t('Common Settings')));
  items.push(
    formField(
      t('Provider ID'),
      draft.id || t('Not Set'),
      'id',
      'key',
    ),
    formField(
      t('Algorithm'),
      algorithmDescription(draft.algorithm),
      'algorithm',
      'symbol-method',
    ),
  );

  if (draft.algorithm === 'simple') {
    items.push(createSeparator(t('Simple Settings')));
    items.push(
      formField(
        t('Model'),
        modelDescription(draft.simple.model),
        'simpleModel',
        'server',
      ),
    );
  }

  if (draft.algorithm === 'copilot-replica') {
    items.push(createSeparator(t('Completion Modes')));
    items.push(
      formField(
        t('Completion Modes'),
        copilotModesDescription(draft),
        'copilotModes',
        'list-selection',
      ),
    );

    const canUnifyModels =
      draft.copilotReplica.enableFIM && draft.copilotReplica.enableNES;
    const useUnifiedModel =
      canUnifyModels && draft.copilotReplica.modelUnification;
    if (canUnifyModels) {
      items.push(createSeparator(t('Model Strategy')));
      items.push(
        formField(
          t('Model Strategy'),
          draft.copilotReplica.modelUnification
            ? t('Unified Model')
            : t('Independent Models'),
          'copilotModelUnification',
          'git-merge',
        ),
      );
    }

    if (useUnifiedModel) {
      items.push(createSeparator(t('Unified Model Settings')));
      items.push(
        formField(
          t('Unified Model'),
          modelDescription(draft.copilotReplica.unifiedModel),
          'copilotUnifiedModel',
          'server',
        ),
        formField(
          t('Eagerness'),
          eagernessLabel(draft.copilotReplica.eagerness),
          'copilotEagerness',
          'dashboard',
        ),
      );
    }

    if (draft.copilotReplica.enableFIM && !useUnifiedModel) {
      items.push(createSeparator(t('FIM Settings')));
      items.push(
        formField(
          t('FIM Model'),
          modelDescription(draft.copilotReplica.fimModel),
          'copilotFimModel',
          'server',
        ),
        formField(
          t('FIM Candidate Count'),
          String(draft.copilotReplica.n),
          'copilotN',
          'list-ordered',
        ),
      );
    }

    if (draft.copilotReplica.enableNES && !useUnifiedModel) {
      items.push(createSeparator(t('NES Settings')));
      items.push(
        formField(
          t('NES Model'),
          modelDescription(draft.copilotReplica.nesModel),
          'copilotNesModel',
          'server',
        ),
        formField(
          t('NES Prompt Strategy'),
          draft.copilotReplica.strategy,
          'copilotNesStrategy',
          'symbol-event',
        ),
        formField(
          t('Eagerness'),
          eagernessLabel(draft.copilotReplica.eagerness),
          'copilotEagerness',
          'dashboard',
        ),
      );
    }

    if (draft.copilotReplica.enableNES) {
      items.push(
        formField(
          t('Cursor Prediction Model'),
          modelDescription(draft.copilotReplica.cursorPredictionModel),
          'copilotCursorPredictionModel',
          'target',
        ),
      );
    }

  }

  if (draft.algorithm === 'zed') {
    items.push(createSeparator(t('Zed Settings')));
    items.push(
      formField(
        t('Model'),
        modelDescription(draft.zed.model),
        'zedModel',
        'server',
      ),
      formField(
        t('Max Tokens'),
        String(draft.zed.maxTokens),
        'zedMaxTokens',
        'list-ordered',
      ),
    );
  }

  if (draft.algorithm === 'inception') {
    items.push(createSeparator(t('Inception Settings')));
    items.push(
      formField(
        t('Model'),
        modelDescription(draft.inception.model),
        'inceptionModel',
        'server',
      ),
    );
  }

  if (draft.algorithm === 'mistral') {
    items.push(createSeparator(t('Mistral Settings')));
    items.push(
      formField(
        t('Model'),
        modelDescription(draft.mistral.model),
        'mistralModel',
        'server',
      ),
      formField(
        t('Max Tokens'),
        String(draft.mistral.maxTokens),
        'mistralMaxTokens',
        'list-ordered',
      ),
    );
  }

  items.push(createSeparator());
  items.push({ label: `$(check) ${t('Save')}`, action: 'save' });
  return items;
}

function eagernessLabel(value: NesAggressivenessSetting): string {
  switch (value) {
    case 'auto':
      return t('Auto');
    case 'low':
      return t('Low');
    case 'medium':
      return t('Medium');
    case 'high':
      return t('High');
  }
}

export async function pickModelReference(
  purpose: string,
  sourceKind: Parameters<
    NonNullable<CompletionModelResolver['evaluateModelForRequest']>
  >[1],
  modelResolver: CompletionModelResolver,
  current?: CompletionModelReference,
): Promise<CompletionModelReference | undefined> {
  try {
    const picked = await pickLanguageModel({
      placeHolder: purpose,
      current,
      filter: async (model) =>
        (
          await modelResolver.evaluateModelForRequest?.(
            { vendor: model.vendor, id: model.id },
            sourceKind,
          )
        )?.eligible ?? true,
    });
    return picked?.kind === 'model'
      ? { vendor: picked.model.vendor, id: picked.model.id }
      : undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(message);
    return undefined;
  }
}

export async function pickOptionalModelReference(
  purpose: string,
  sourceKind: Parameters<
    NonNullable<CompletionModelResolver['evaluateModelForRequest']>
  >[1],
  modelResolver: CompletionModelResolver,
  current?: CompletionModelReference,
): Promise<
  | { readonly changed: false }
  | { readonly changed: true; readonly model?: CompletionModelReference }
> {
  try {
    const picked = await pickLanguageModel({
      placeHolder: purpose,
      current,
      includeDefault: true,
      defaultLabel: t('Use NES/Unified Model'),
      defaultDetail: t('Reuse the current NES or Unified model.'),
      filter: async (model) =>
        (
          await modelResolver.evaluateModelForRequest?.(
            { vendor: model.vendor, id: model.id },
            sourceKind,
          )
        )?.eligible ?? true,
    });
    if (!picked) return { changed: false };
    return picked.kind === 'default'
      ? { changed: true }
      : {
          changed: true,
          model: { vendor: picked.model.vendor, id: picked.model.id },
        };
  } catch (error) {
    void vscode.window.showErrorMessage(
      error instanceof Error ? error.message : String(error),
    );
    return { changed: false };
  }
}

async function editProviderId(
  draft: CompletionAlgorithmEntryDraft,
  providers: readonly CompletionAlgorithmEntry[],
  originalId: string | undefined,
): Promise<void> {
  const value = await vscode.window.showInputBox({
    title: t('Provider ID'),
    prompt: t('Enter a unique provider ID'),
    value: draft.id,
    validateInput: (candidate) => {
      const id = candidate.trim();
      if (!id) {
        return t('Provider ID is required.');
      }
      return providers.some(
        (provider) => provider.id === id && provider.id !== originalId,
      )
        ? t('Provider ID must be unique.')
        : undefined;
    },
  });
  if (value !== undefined) {
    draft.id = value.trim();
  }
}

async function editProviderAlgorithm(
  draft: CompletionAlgorithmEntryDraft,
): Promise<void> {
  const items: ValueItem<CompletionAlgorithmId>[] =
    completionAlgorithmRegistry.list().map((definition) => ({
      label: definition.label,
      description: definition.id,
      value: definition.id,
      picked: definition.id === draft.algorithm,
    }));
  const selected = await vscode.window.showQuickPick(items, {
    title: t('Algorithm'),
    placeHolder: t('Select a completion algorithm'),
  });
  if (selected) {
    draft.algorithm = selected.value;
  }
}

async function editCopilotModes(draft: CompletionAlgorithmEntryDraft): Promise<void> {
  const selected = await vscode.window.showQuickPick(
    [
      {
        label: t('FIM Completion'),
        mode: 'fim' as const,
        picked: draft.copilotReplica.enableFIM,
      },
      {
        label: t('NES Suggestion'),
        mode: 'nes' as const,
        picked: draft.copilotReplica.enableNES,
      },
    ],
    {
      title: t('Completion Modes'),
      placeHolder: t('Select one or both Copilot completion modes'),
      canPickMany: true,
    },
  );
  if (!selected) {
    return;
  }
  if (selected.length === 0) {
    void vscode.window.showWarningMessage(
      t('Enable at least one Copilot completion mode.'),
    );
    return;
  }
  draft.copilotReplica.enableFIM = selected.some((item) => item.mode === 'fim');
  draft.copilotReplica.enableNES = selected.some((item) => item.mode === 'nes');
}

async function readPositiveInteger(
  title: string,
  value: number,
): Promise<number | undefined> {
  const input = await vscode.window.showInputBox({
    title,
    value: String(value),
    validateInput: (candidate) => {
      const parsed = Number(candidate.trim());
      return Number.isSafeInteger(parsed) && parsed > 0
        ? undefined
        : t('Enter a positive integer.');
    },
  });
  return input === undefined ? undefined : Number(input.trim());
}

async function editProviderField(
  field: ProviderFormField,
  draft: CompletionAlgorithmEntryDraft,
  providers: readonly CompletionAlgorithmEntry[],
  originalId: string | undefined,
  modelResolver: CompletionModelResolver,
): Promise<void> {
  switch (field) {
    case 'id':
      await editProviderId(draft, providers, originalId);
      return;
    case 'algorithm':
      await editProviderAlgorithm(draft);
      return;
    case 'simpleModel': {
      const model = await pickModelReference(
        t('Select the Simple completion model'),
        COMPLETION_MODEL_REQUEST_KIND_BY_FIELD.simpleModel,
        modelResolver,
        draft.simple.model,
      );
      if (model) draft.simple.model = model;
      return;
    }
    case 'copilotModes':
      await editCopilotModes(draft);
      return;
    case 'copilotFimModel': {
      const model = await pickModelReference(
        t('Select the Copilot FIM model'),
        COMPLETION_MODEL_REQUEST_KIND_BY_FIELD.copilotFimModel,
        modelResolver,
        draft.copilotReplica.fimModel,
      );
      if (model) draft.copilotReplica.fimModel = model;
      return;
    }
    case 'copilotN': {
      const n = await readPositiveInteger(
        t('FIM Candidate Count'),
        draft.copilotReplica.n,
      );
      if (n !== undefined) draft.copilotReplica.n = n;
      return;
    }
    case 'copilotNesModel': {
      const model = await pickModelReference(
        t('Select the Copilot NES model'),
        COMPLETION_MODEL_REQUEST_KIND_BY_FIELD.copilotNesModel,
        modelResolver,
        draft.copilotReplica.nesModel,
      );
      if (model) draft.copilotReplica.nesModel = model;
      return;
    }
    case 'copilotUnifiedModel': {
      const model = await pickModelReference(
        t('Select the Copilot unified model'),
        COMPLETION_MODEL_REQUEST_KIND_BY_FIELD.copilotUnifiedModel,
        modelResolver,
        draft.copilotReplica.unifiedModel,
      );
      if (model) draft.copilotReplica.unifiedModel = model;
      return;
    }
    case 'copilotCursorPredictionModel': {
      const selected = await pickOptionalModelReference(
        t('Select the cursor prediction model'),
        COMPLETION_MODEL_REQUEST_KIND_BY_FIELD.copilotCursorPredictionModel,
        modelResolver,
        draft.copilotReplica.cursorPredictionModel,
      );
      if (selected.changed) {
        draft.copilotReplica.cursorPredictionModel = selected.model;
      }
      return;
    }
    case 'copilotNesStrategy': {
      const selected = await vscode.window.showQuickPick(
        buildCopilotNesStrategyItems(draft.copilotReplica.strategy),
        {
          title: t('NES Prompt Strategy'),
          placeHolder: t('Select the NES prompting strategy'),
        },
      );
      if (selected) draft.copilotReplica.strategy = selected.value;
      return;
    }
    case 'copilotEagerness': {
      const selected = await vscode.window.showQuickPick(
        buildCopilotEagernessItems(draft.copilotReplica.eagerness),
        { title: t('Eagerness'), placeHolder: t('Select eagerness') },
      );
      if (selected) draft.copilotReplica.eagerness = selected.value;
      return;
    }
    case 'copilotModelUnification': {
      const selected = await vscode.window.showQuickPick(
        buildModelStrategyItems(draft.copilotReplica.modelUnification),
        { title: t('Model Strategy'), placeHolder: t('Select a model strategy') },
      );
      if (selected) draft.copilotReplica.modelUnification = selected.value;
      return;
    }
    case 'zedModel': {
      const model = await pickModelReference(
        t('Select the Zed model'),
        COMPLETION_MODEL_REQUEST_KIND_BY_FIELD.zedModel,
        modelResolver,
        draft.zed.model,
      );
      if (model) draft.zed.model = model;
      return;
    }
    case 'zedMaxTokens': {
      const maxTokens = await readPositiveInteger(
        t('Zed Max Tokens'),
        draft.zed.maxTokens,
      );
      if (maxTokens !== undefined) draft.zed.maxTokens = maxTokens;
      return;
    }
    case 'inceptionModel': {
      const model = await pickModelReference(
        t('Select the Inception model'),
        COMPLETION_MODEL_REQUEST_KIND_BY_FIELD.inceptionModel,
        modelResolver,
        draft.inception.model,
      );
      if (model) draft.inception.model = model;
      return;
    }
    case 'mistralModel': {
      const model = await pickModelReference(
        t('Select the Mistral model'),
        COMPLETION_MODEL_REQUEST_KIND_BY_FIELD.mistralModel,
        modelResolver,
        draft.mistral.model,
      );
      if (model) draft.mistral.model = model;
      return;
    }
    case 'mistralMaxTokens': {
      const maxTokens = await readPositiveInteger(
        t('Mistral Max Tokens'),
        draft.mistral.maxTokens,
      );
      if (maxTokens !== undefined) draft.mistral.maxTokens = maxTokens;
      return;
    }
  }
}

function providerValidationMessage(error: CompletionAlgorithmEntryDraftError): string {
  switch (error) {
    case 'entryIdRequired':
      return t('Provider ID is required.');
    case 'entryIdDuplicate':
      return t('Provider ID must be unique.');
    case 'algorithmRequired':
      return t('Select a completion algorithm.');
    case 'simpleModelRequired':
      return t('Select the Simple completion model.');
    case 'copilotReplicaModeRequired':
      return t('Enable at least one Copilot completion mode.');
    case 'copilotReplicaFimModelRequired':
      return t('Select the Copilot FIM model.');
    case 'copilotReplicaNInvalid':
      return t('FIM candidate count must be a positive integer.');
    case 'copilotReplicaNesModelRequired':
      return t('Select the Copilot NES model.');
    case 'copilotReplicaUnifiedModelRequired':
      return t('Select the Copilot unified model.');
    case 'zedModelRequired':
      return t('Select the Zed model.');
    case 'zedMaxTokensInvalid':
      return t('Zed max tokens must be a positive integer.');
    case 'inceptionModelRequired':
      return t('Select the Inception model.');
    case 'mistralModelRequired':
      return t('Select the Mistral model.');
    case 'mistralMaxTokensInvalid':
      return t('Mistral max tokens must be a positive integer.');
  }
}

interface DraftModelRequirement {
  readonly model: CompletionModelReference;
  readonly purpose: string;
  readonly sourceKind: CompletionModelRequestKind;
}

function getDraftModelRequirements(
  draft: CompletionAlgorithmEntryDraft,
): DraftModelRequirement[] {
  const requirements: DraftModelRequirement[] = [];
  const add = (
    model: CompletionModelReference | undefined,
    purpose: string,
    sourceKind: CompletionModelRequestKind,
  ) => {
    if (model) requirements.push({ model, purpose, sourceKind });
  };

  switch (draft.algorithm) {
    case 'simple':
      add(draft.simple.model, t('Simple completion'), 'simple');
      break;
    case 'copilot-replica': {
      const unified =
        draft.copilotReplica.enableFIM &&
        draft.copilotReplica.enableNES &&
        draft.copilotReplica.modelUnification;
      if (unified) {
        add(
          draft.copilotReplica.unifiedModel,
          t('Copilot FIM'),
          'copilot-replica/fim',
        );
        add(
          draft.copilotReplica.unifiedModel,
          t('Copilot NES'),
          'copilot-replica/nes',
        );
        add(
          draft.copilotReplica.cursorPredictionModel ??
            draft.copilotReplica.unifiedModel,
          t('Copilot cursor prediction'),
          'copilot-replica/cursor-prediction',
        );
      } else {
        if (draft.copilotReplica.enableFIM) {
          add(
            draft.copilotReplica.fimModel,
            t('Copilot FIM'),
            'copilot-replica/fim',
          );
        }
        if (draft.copilotReplica.enableNES) {
          add(
            draft.copilotReplica.nesModel,
            t('Copilot NES'),
            'copilot-replica/nes',
          );
          add(
            draft.copilotReplica.cursorPredictionModel ??
              draft.copilotReplica.nesModel,
            t('Copilot cursor prediction'),
            'copilot-replica/cursor-prediction',
          );
        }
      }
      break;
    }
    case 'zed':
      add(draft.zed.model, t('Zed completion'), 'zed');
      break;
    case 'inception':
      add(draft.inception.model, t('Inception completion'), 'inception');
      break;
    case 'mistral':
      add(draft.mistral.model, t('Mistral completion'), 'mistral');
      break;
    case undefined:
      break;
  }
  return requirements;
}

export async function validateCompletionAlgorithmDraftModels(
  draft: CompletionAlgorithmEntryDraft,
  modelResolver: CompletionModelResolver,
): Promise<string | undefined> {
  if (!modelResolver.evaluateModelForRequest) return undefined;
  for (const requirement of getDraftModelRequirements(draft)) {
    let result: CompletionModelEligibility;
    try {
      result = await modelResolver.evaluateModelForRequest(
        requirement.model,
        requirement.sourceKind,
      );
    } catch (error) {
      return t(
        'Model "{0}" could not be validated for {1}: {2}',
        `${requirement.model.vendor}/${requirement.model.id}`,
        requirement.purpose,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (result.eligible) continue;
    return t(
      'Model "{0}" is no longer eligible for {1}: {2}',
      `${requirement.model.vendor}/${requirement.model.id}`,
      requirement.purpose,
      result.message ?? result.code ?? t('Unknown eligibility error'),
    );
  }
  return undefined;
}

async function confirmUnsavedChanges(): Promise<UnsavedChoice> {
  const save = t('Save Changes');
  const discard = t('Discard Changes');
  const keepEditing = t('Continue Editing');
  const selected = await vscode.window.showWarningMessage(
    t('Save changes before leaving?'),
    { modal: true },
    save,
    discard,
    keepEditing,
  );
  if (selected === save) return 'save';
  if (selected === discard) return 'discard';
  return 'continue';
}

async function editCompletionAlgorithmEntry(
  target: CompletionConfigurationTarget,
  providers: readonly CompletionAlgorithmEntry[],
  existing?: CompletionAlgorithmEntry,
  modelResolver?: CompletionModelResolver,
  initialDraft?: CompletionAlgorithmEntryDraft,
): Promise<ProviderFormResult> {
  const draft = initialDraft ?? createCompletionAlgorithmEntryDraft(existing);
  const initialSnapshot = JSON.stringify(draft);
  const originalId = existing?.id;

  const trySave = async (): Promise<ProviderFormResult | undefined> => {
    const result = buildCompletionAlgorithmEntry(draft, providers, originalId);
    if (!result.ok) {
      await vscode.window.showErrorMessage(
        providerValidationMessage(result.error),
        { modal: true },
      );
      return undefined;
    }
    if (modelResolver) {
      const eligibilityError = await validateCompletionAlgorithmDraftModels(
        draft,
        modelResolver,
      );
      if (eligibilityError) {
        await vscode.window.showErrorMessage(eligibilityError, { modal: true });
        return undefined;
      }
    }
    return { kind: 'saved', entry: result.entry };
  };

  while (true) {
    const selected = await pickQuickItem<ProviderFormItem>({
      title: existing
        ? t('Edit Completion Provider ({0})', scopeLabel(target))
        : t('Add Completion Provider ({0})', scopeLabel(target)),
      placeholder: t('Select a field to edit'),
      ignoreFocusOut: true,
      items: buildProviderFormItems(draft),
      buttons: [vscode.QuickInputButtons.Back],
      onDidTriggerButton: (button, quickPick) => {
        if (button === vscode.QuickInputButtons.Back) quickPick.hide();
      },
    });

    if (!selected) {
      if (JSON.stringify(draft) === initialSnapshot) {
        return { kind: 'cancelled' };
      }
      const choice = await confirmUnsavedChanges();
      if (choice === 'discard') return { kind: 'cancelled' };
      if (choice === 'save') {
        const result = await trySave();
        if (result) return result;
      }
      continue;
    }
    if (selected.action === 'save') {
      const result = await trySave();
      if (result) return result;
      continue;
    }
    if (selected.field) {
      if (modelResolver) {
        await editProviderField(
          selected.field,
          draft,
          providers,
          originalId,
          modelResolver,
        );
      }
    }
  }
}

function schedulingModeLabel(mode: CompletionStrategy['mode']): string {
  return mode === 'all'
    ? t('All Providers Concurrent')
    : t('Main Provider First');
}

function otherProvidersTimingLabel(parallel: boolean): string {
  return parallel
    ? t('Start with Main Provider')
    : t('Start on Main Provider Fallback');
}

function stopConditionLabel(type: CompletionStopConditionType): string {
  switch (type) {
    case 'firstUsable':
      return t('First Usable Result');
    case 'deadline':
      return t('Time Limit');
    case 'enoughResults':
      return t('Result Count');
    case 'allSettled':
      return t('All Completed');
  }
}

function strategyField(
  label: string,
  description: string,
  field: StrategyFormField,
  icon: string,
): StrategyFormItem {
  return {
    label: `$(${icon}) ${label}`,
    description,
    field,
  };
}

export function buildStrategyFormItems(
  draft: CompletionStrategyDraft,
): StrategyFormItem[] {
  const items: StrategyFormItem[] = [];
  items.push(createSeparator(t('Scheduling')));
  items.push(
    strategyField(
      t('Scheduling Mode'),
      schedulingModeLabel(draft.mode),
      'mode',
      'type-hierarchy',
    ),
    strategyField(
      t('Disable VS Code Built-in Completion'),
      draft.disableVSCodeBuiltinCompletion ? t('Enabled') : t('Disabled'),
      'disableVSCodeBuiltinCompletion',
      'circle-slash',
    ),
    strategyField(
      t('Disabled File Globs'),
      t('{0} patterns', draft.disabledGlobs.length),
      'disabledGlobs',
      'exclude',
    ),
  );
  if (draft.mode === 'main-first') {
    items.push(
      strategyField(
        t('Main Provider'),
        draft.mainProvider ?? t('Not Set'),
        'mainProvider',
        'star-full',
      ),
      strategyField(
        t('Other Providers Start Timing'),
        otherProvidersTimingLabel(draft.parallelRequestOthers),
        'parallelRequestOthers',
        'run-all',
      ),
      strategyField(
        t('Main Provider Wait Time (ms)'),
        String(draft.mainFirstTimeoutMs),
        'mainFirstTimeoutMs',
        'clock',
      ),
    );
  }

  items.push(createSeparator(t('Stop Condition')));
  items.push(
    strategyField(
      t('Stop Condition'),
      stopConditionLabel(draft.stopType),
      'stopType',
      'filter',
    ),
  );
  switch (draft.stopType) {
    case 'firstUsable':
      items.push(
        strategyField(
          t('Grace Period (ms)'),
          String(draft.firstUsableGraceMs),
          'firstUsableGraceMs',
          'clock',
        ),
      );
      break;
    case 'deadline':
      items.push(
        strategyField(
          t('Time Limit (ms)'),
          String(draft.deadlineTimeoutMs),
          'deadlineTimeoutMs',
          'clock',
        ),
      );
      break;
    case 'enoughResults':
      items.push(
        strategyField(
          t('Minimum Results'),
          String(draft.enoughResultsMinItems),
          'enoughResultsMinItems',
          'list-numbered',
        ),
        strategyField(
          t('Grace Period (ms)'),
          String(draft.enoughResultsGraceMs),
          'enoughResultsGraceMs',
          'clock',
        ),
      );
      break;
    case 'allSettled':
      break;
  }

  items.push(createSeparator());
  items.push({ label: `$(check) ${t('Save')}`, action: 'save' });
  return items;
}

async function readNonNegativeNumber(
  title: string,
  value: number,
): Promise<number | undefined> {
  const input = await vscode.window.showInputBox({
    title,
    value: String(value),
    validateInput: (candidate) => {
      const parsed = Number(candidate.trim());
      return Number.isFinite(parsed) && parsed >= 0
        ? undefined
        : t('Enter a non-negative number.');
    },
  });
  return input === undefined ? undefined : Number(input.trim());
}

async function editStrategyField(
  field: StrategyFormField,
  draft: CompletionStrategyDraft,
  providers: readonly CompletionAlgorithmEntry[],
): Promise<void> {
  switch (field) {
    case 'mode': {
      const selected = await vscode.window.showQuickPick(
        buildSchedulingModeItems(draft.mode),
        { title: t('Scheduling Mode'), placeHolder: t('Select a scheduling mode') },
      );
      if (selected) draft.mode = selected.value;
      return;
    }
    case 'disableVSCodeBuiltinCompletion': {
      const selected = await vscode.window.showQuickPick(
        buildDisableVSCodeBuiltinCompletionItems(
          draft.disableVSCodeBuiltinCompletion,
        ),
        {
          title: t('Disable VS Code Built-in Completion'),
          placeHolder: t('Select a setting to change'),
        },
      );
      if (selected) draft.disableVSCodeBuiltinCompletion = selected.value;
      return;
    }
    case 'disabledGlobs': {
      const value = await vscode.window.showInputBox({
        title: t('Disabled Completion Globs (JSON array)'),
        value: JSON.stringify(draft.disabledGlobs),
        validateInput: (candidate) => {
          try {
            const parsed: unknown = JSON.parse(candidate);
            return Array.isArray(parsed) &&
              parsed.every(
                (item) => typeof item === 'string' && item.trim().length > 0,
              )
              ? undefined
              : t('Enter a JSON array of non-empty glob strings.');
          } catch {
            return t('Enter a valid JSON array.');
          }
        },
      });
      if (value !== undefined) {
        const parsed: unknown = JSON.parse(value);
        if (
          Array.isArray(parsed) &&
          parsed.every((item): item is string => typeof item === 'string')
        ) {
          draft.disabledGlobs = parsed;
        }
      }
      return;
    }
    case 'mainProvider': {
      if (providers.length === 0) {
        void vscode.window.showWarningMessage(
          t('Add a completion provider before selecting a main provider.'),
        );
        return;
      }
      const selected = await vscode.window.showQuickPick(
        providers.map((provider) => ({
          label: provider.id,
          description:
            completionAlgorithmRegistry.get(provider.algorithm)?.label ??
            provider.algorithm,
          providerId: provider.id,
          picked: provider.id === draft.mainProvider,
        })),
        {
          title: t('Main Provider'),
          placeHolder: t('Select the main completion provider'),
        },
      );
      if (selected) draft.mainProvider = selected.providerId;
      return;
    }
    case 'parallelRequestOthers': {
      const selected = await vscode.window.showQuickPick(
        buildOtherProvidersStartTimingItems(draft.parallelRequestOthers),
        {
          title: t('Other Providers Start Timing'),
          placeHolder: t('Choose when other providers start'),
        },
      );
      if (selected) draft.parallelRequestOthers = selected.value;
      return;
    }
    case 'mainFirstTimeoutMs': {
      const value = await readNonNegativeNumber(
        t('Main Provider Wait Time (ms)'),
        draft.mainFirstTimeoutMs,
      );
      if (value !== undefined) draft.mainFirstTimeoutMs = value;
      return;
    }
    case 'stopType': {
      const selected = await vscode.window.showQuickPick(
        buildStopConditionItems(draft.stopType),
        { title: t('Stop Condition'), placeHolder: t('Select a stop condition') },
      );
      if (selected) draft.stopType = selected.value;
      return;
    }
    case 'firstUsableGraceMs': {
      const value = await readNonNegativeNumber(
        t('Grace Period (ms)'),
        draft.firstUsableGraceMs,
      );
      if (value !== undefined) draft.firstUsableGraceMs = value;
      return;
    }
    case 'deadlineTimeoutMs': {
      const value = await readNonNegativeNumber(
        t('Time Limit (ms)'),
        draft.deadlineTimeoutMs,
      );
      if (value !== undefined) draft.deadlineTimeoutMs = value;
      return;
    }
    case 'enoughResultsMinItems': {
      const value = await readPositiveInteger(
        t('Minimum Results'),
        draft.enoughResultsMinItems,
      );
      if (value !== undefined) draft.enoughResultsMinItems = value;
      return;
    }
    case 'enoughResultsGraceMs': {
      const value = await readNonNegativeNumber(
        t('Grace Period (ms)'),
        draft.enoughResultsGraceMs,
      );
      if (value !== undefined) draft.enoughResultsGraceMs = value;
      return;
    }
  }
}

function strategyValidationMessage(error: StrategyDraftError): string {
  switch (error) {
    case 'mainProviderRequired':
      return t('Select a main completion provider.');
    case 'mainProviderMissing':
      return t('The selected main completion provider no longer exists.');
    case 'mainFirstTimeoutInvalid':
      return t('Main provider wait time must be a non-negative number.');
    case 'graceInvalid':
      return t('Grace period must be a non-negative number.');
    case 'deadlineInvalid':
      return t('Time limit must be a non-negative number.');
    case 'minimumResultsInvalid':
      return t('Minimum results must be a positive integer.');
  }
}

async function editCompletionStrategy(
  target: CompletionConfigurationTarget,
  strategy: CompletionStrategy,
  providers: readonly CompletionAlgorithmEntry[],
): Promise<StrategyFormResult> {
  const draft = createCompletionStrategyDraft(strategy);
  const initialSnapshot = JSON.stringify(draft);

  const trySave = async (): Promise<StrategyFormResult | undefined> => {
    const result = buildCompletionStrategy(draft, providers);
    if (!result.ok) {
      await vscode.window.showErrorMessage(
        strategyValidationMessage(result.error),
        { modal: true },
      );
      return undefined;
    }
    return { kind: 'saved', strategy: result.strategy };
  };

  while (true) {
    const selected = await pickQuickItem<StrategyFormItem>({
      title: t('Completion Strategy Settings ({0})', scopeLabel(target)),
      placeholder: t('Select a field to edit'),
      ignoreFocusOut: true,
      items: buildStrategyFormItems(draft),
      buttons: [vscode.QuickInputButtons.Back],
      onDidTriggerButton: (button, quickPick) => {
        if (button === vscode.QuickInputButtons.Back) quickPick.hide();
      },
    });
    if (!selected) {
      if (JSON.stringify(draft) === initialSnapshot) {
        return { kind: 'cancelled' };
      }
      const choice = await confirmUnsavedChanges();
      if (choice === 'discard') return { kind: 'cancelled' };
      if (choice === 'save') {
        const result = await trySave();
        if (result) return result;
      }
      continue;
    }
    if (selected.action === 'save') {
      const result = await trySave();
      if (result) return result;
      continue;
    }
    if (selected.field) {
      await editStrategyField(selected.field, draft, providers);
    }
  }
}

async function addCompletionProviderFromCurrentProviders(
  target: CompletionConfigurationTarget,
  modelResolver: CompletionModelResolver,
  providerStore: CompletionProviderStore | undefined,
): Promise<void> {
  const catalog = new CurrentProviderModelCatalog(
    {
      getProviders: () => providerStore?.endpoints ?? [],
      getCachedModels: getAllModelsForProviderSync,
      getModels: (provider, forceFetch) =>
        getAllModelsForProviderData(provider, { forceFetch }),
    },
    modelResolver,
  );

  while (true) {
    const algorithmSelection = await pickCurrentProviderAlgorithm(catalog);
    if (!algorithmSelection) return;
    if (algorithmSelection.action === 'manage') {
      await vscode.commands.executeCommand('unifyChatProvider.manageProviders');
      catalog.reset();
      continue;
    }
    if (
      algorithmSelection.action !== 'algorithm' ||
      !algorithmSelection.algorithm ||
      !algorithmSelection.candidates
    ) {
      continue;
    }

    while (true) {
      const candidate = await pickCurrentProviderModel(
        algorithmSelection.algorithm,
        algorithmSelection.candidates,
      );
      if (!candidate) break;

      const latest = readScopedCompletionConfiguration(target);
      const draft = createCurrentProviderCompletionDraft(
        algorithmSelection.algorithm,
        candidate,
        latest.configuration.providers,
      );
      const result = await editCompletionAlgorithmEntry(
        target,
        latest.configuration.providers,
        undefined,
        modelResolver,
        draft,
      );
      if (result.kind === 'saved') {
        if (await updateProvidersAfterEdit(target, undefined, result.entry)) {
          return;
        }
      }
    }
  }
}

async function runSettingsPage(
  target: CompletionConfigurationTarget,
  modelResolver: CompletionModelResolver,
  providerStore?: CompletionProviderStore,
): Promise<SettingsPageResult> {
  while (true) {
    const state = readScopedCompletionConfiguration(target);
    let backRequested = false;
    const selected = await pickQuickItem<MainSettingsItem>({
      title: t('Code Completion Settings ({0})', scopeLabel(target)),
      placeholder: t('Select a setting to change'),
      ignoreFocusOut: true,
      items: buildMainSettingsItems(target, state),
      buttons: [vscode.QuickInputButtons.Back],
      onDidTriggerButton: (button, quickPick) => {
        if (button !== vscode.QuickInputButtons.Back) return;
        backRequested = true;
        quickPick.hide();
      },
      onDidTriggerItemButton: async (event, quickPick) => {
        quickPick.busy = true;
        try {
          await handleProviderItemButton(target, event, quickPick);
        } finally {
          quickPick.busy = false;
        }
      },
    });
    if (!selected) {
      return backRequested ? 'back' : 'close';
    }

    switch (selected.action) {
      case 'status':
        await editStatus(target, state);
        break;
      case 'add': {
        const result = await editCompletionAlgorithmEntry(
          target,
          state.configuration.providers,
          undefined,
          modelResolver,
        );
        if (result.kind === 'saved') {
          await updateProvidersAfterEdit(
            target,
            undefined,
            result.entry,
          );
        }
        break;
      }
      case 'add-current':
        await addCompletionProviderFromCurrentProviders(
          target,
          modelResolver,
          providerStore,
        );
        break;
      case 'provider': {
        const provider = state.configuration.providers.find(
          (candidate) => candidate.id === selected.providerId,
        );
        if (!provider) break;
        const result = await editCompletionAlgorithmEntry(
          target,
          state.configuration.providers,
          provider,
          modelResolver,
        );
        if (result.kind === 'saved') {
          await updateProvidersAfterEdit(
            target,
            provider,
            result.entry,
          );
        }
        break;
      }
      case 'strategy': {
        const result = await editCompletionStrategy(
          target,
          state.configuration.strategy,
          state.configuration.providers,
        );
        if (result.kind === 'saved') {
          await updateStrategyAfterEdit(target, state, result.strategy);
        }
        break;
      }
      case 'reset':
        if (await confirmResetScope(target)) {
          await resetScope(target);
        }
        break;
      case undefined:
        break;
    }
  }
}

export async function showCompletionSettings(
  modelResolver: CompletionModelResolver,
  providerStore?: CompletionProviderStore,
): Promise<void> {
  while (true) {
    const target = await pickConfigurationTarget();
    if (target === undefined) {
      return;
    }
    if (
      (await runSettingsPage(target, modelResolver, providerStore)) === 'close'
    ) {
      return;
    }
  }
}
