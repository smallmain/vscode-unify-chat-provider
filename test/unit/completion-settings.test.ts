import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_COMPLETION_DISABLED_GLOBS } from '../../src/completion/disabled-globs';

const registry = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn((): { id: string; label: string }[] => []),
}));

const vscodeWindow = vi.hoisted(() => ({
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showInputBox: vi.fn(),
  showQuickPick: vi.fn(),
  showWarningMessage: vi.fn(),
}));

const configurationApi = vi.hoisted(() => ({
  clear: vi.fn(),
  read: vi.fn(),
  update: vi.fn(),
}));

const ui = vi.hoisted(() => ({
  pickQuickItem: vi.fn(),
  pickAsyncQuickItems: vi.fn(),
}));

const languageModelPicker = vi.hoisted(() => ({
  pick: vi.fn(),
}));

vi.mock('vscode', () => ({
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  QuickInputButtons: { Back: { id: 'back' } },
  QuickPickItemKind: { Separator: -1 },
  ThemeIcon: class ThemeIcon {
    constructor(readonly id: string) {}
  },
  env: { language: 'en' },
  l10n: {
    t: (message: string, ...args: unknown[]) =>
      message.replace(/\{(\d+)\}/g, (_placeholder, index: string) =>
        String(args[Number(index)]),
      ),
  },
  workspace: { workspaceFile: undefined, workspaceFolders: undefined },
  window: vscodeWindow,
}));

vi.mock('../../src/language-model-picker', () => ({
  pickLanguageModel: languageModelPicker.pick,
}));

vi.mock('../../src/completion/definitions', () => ({
  completionAlgorithmRegistry: registry,
}));

vi.mock('../../src/ui/component', () => ({
  pickQuickItem: ui.pickQuickItem,
  pickAsyncQuickItems: ui.pickAsyncQuickItems,
  showInput: vi.fn(),
}));

vi.mock('../../src/utils', () => ({
  getAllModelsForProviderData: vi.fn(),
  getAllModelsForProviderSync: vi.fn(() => []),
}));

vi.mock('../../src/completion/vscode-configuration', () => ({
  clearCompletionConfiguration: configurationApi.clear,
  readScopedCompletionConfiguration: configurationApi.read,
  updateCompletionConfiguration: configurationApi.update,
}));

import {
  buildCopilotEagernessItems,
  buildCopilotNesStrategyItems,
  buildConfigurationTargetItems,
  buildCurrentProviderAlgorithmItems,
  buildDisableVSCodeBuiltinCompletionItems,
  buildMainSettingsItems,
  buildModelStrategyItems,
  buildOtherProvidersStartTimingItems,
  buildProviderFormItems,
  buildSchedulingModeItems,
  buildStatusItems,
  buildStopConditionItems,
  buildStrategyFormItems,
  COMPLETION_MODEL_REQUEST_KIND_BY_FIELD,
  createCurrentProviderCompletionDraft,
  createUniqueCompletionProviderId,
  pickModelReference,
  pickOptionalModelReference,
  resetScope,
  showCompletionSettings,
  updateProvidersAfterEdit,
  updateProvidersAndStrategy,
  updateStrategyAfterEdit,
  validateCompletionAlgorithmDraftModels,
} from '../../src/completion/settings';
import {
  buildEditedCopilotReplicaOptions,
  createCompletionAlgorithmEntryDraft,
  createCompletionStrategyDraft,
} from '../../src/completion/settings-model';
import type { ScopedCompletionConfigurationResult } from '../../src/completion/vscode-configuration';
import type {
  CompletionAlgorithmEntry,
  CompletionModelReference,
  CompletionModelResolver,
  CompletionStrategy,
} from '../../src/completion/types';
import type { NesPromptStrategy } from '../../src/chat-lib/core/behavior-config';
import {
  normalizeCopilotReplicaAlgorithmOptions,
  type CopilotReplicaAlgorithmOptions,
} from '../../src/completion/copilot/options';
import {
  editCompletionConfig,
  formatCompletionConfig,
} from '../../src/ui/completion-fields';
import type { PickLanguageModelOptions } from '../../src/language-model-picker';
import type { CurrentProviderModelCandidate } from '../../src/completion/current-provider-models';
import type { AlgorithmRequestKind } from '../../src/completion/model/requests';

const model = { vendor: 'copilot', id: 'nes-model' };
const modelResolver: CompletionModelResolver = {
  resolveCompletionModel: async () => {
    throw new Error('Model resolution is not used by settings interaction tests.');
  },
};

beforeEach(() => {
  registry.get.mockReset();
  registry.list.mockReset();
  registry.list.mockReturnValue([]);
  for (const mock of Object.values(vscodeWindow)) mock.mockReset();
  for (const mock of Object.values(configurationApi)) mock.mockReset();
  ui.pickQuickItem.mockReset();
  ui.pickAsyncQuickItems.mockReset();
  languageModelPicker.pick.mockReset();
  configurationApi.clear.mockResolvedValue(undefined);
  configurationApi.update.mockResolvedValue(undefined);
});

describe('CompletionConfig UI diagnostics', () => {
  it('keeps a preserved invalid raw state visible until explicitly edited', () => {
    expect(
      formatCompletionConfig(undefined, 'inherit', {
        status: 'invalid',
        issues: [
          {
            code: 'completion-invalid-templates',
            field: 'templates',
            message: 'Invalid templates.',
          },
        ],
      }),
    ).toBe('Invalid configuration');
    expect(formatCompletionConfig({}, 'inherit', { status: 'absent' })).toBe(
      'inherit',
    );
  });

  it('does not overwrite a preserved invalid config when the editor is cancelled', async () => {
    const draft: { completion?: undefined } = {};
    ui.pickQuickItem.mockResolvedValueOnce(undefined);

    await editCompletionConfig(draft, { modelOverride: true });

    expect(Object.hasOwn(draft, 'completion')).toBe(false);
  });

  it('shows provider defaults as auto/disabled and model defaults as inherited', () => {
    expect(
      formatCompletionConfig({ templates: ['fim'] }, 'default', undefined, false),
    ).toBe('auto, fim');
    expect(
      formatCompletionConfig({ transport: 'native' }, 'default', undefined, false),
    ).toBe('native, disabled');
    expect(
      formatCompletionConfig({ templates: ['fim'] }, 'inherit'),
    ).toBe('inherit, fim');
  });

  it('offers templates for every completion algorithm in the config editor', async () => {
    const labels: string[] = [];
    ui.pickQuickItem
      .mockResolvedValueOnce({ field: 'templates' })
      .mockResolvedValueOnce({ value: 'custom' })
      .mockResolvedValueOnce(undefined);
    vscodeWindow.showQuickPick.mockImplementationOnce(
      async (items: readonly { label: string }[]) => {
        labels.push(...items.map((item) => item.label));
        return undefined;
      },
    );

    await editCompletionConfig({}, { modelOverride: false });

    expect(labels).toEqual([
      'fim',
      'codegemma',
      'copilot-replica-nes',
      'zeta1',
      'zeta2',
      'zeta2.1',
      'zeta3-internal',
      'mercury-edit-2',
      'codestral',
    ]);
  });
});

describe('completion settings model eligibility picker', () => {
  it.each([
    ['simpleModel', false],
    ['copilotFimModel', false],
    ['copilotNesModel', false],
    ['copilotUnifiedModel', false],
    ['copilotCursorPredictionModel', true],
  ] as const)('filters the %s slot by its request kind', async (field, optional) => {
    const sourceKind = COMPLETION_MODEL_REQUEST_KIND_BY_FIELD[field];
    const evaluateModelForRequest = vi.fn(
      async (reference: { vendor: string; id: string }) => ({
        eligible: reference.id === 'visible',
        ...(reference.id === 'visible'
          ? {}
          : { code: 'completion-no-template' as const }),
      }),
    );
    const resolver: CompletionModelResolver = {
      resolveCompletionModel: modelResolver.resolveCompletionModel,
      evaluateModelForRequest,
    };
    languageModelPicker.pick.mockImplementationOnce(
      async (options: PickLanguageModelOptions) => {
        const hidden = {
          name: 'Hidden',
          vendor: 'test',
          id: 'hidden',
          family: 'test',
        };
        const visible = { ...hidden, name: 'Visible', id: 'visible' };
        if (!options.filter) throw new Error('Expected an eligibility filter.');
        expect(await options.filter(hidden)).toBe(false);
        expect(await options.filter(visible)).toBe(true);
        expect(options.includeDefault ?? false).toBe(optional);
        if (optional) {
          expect(options.defaultLabel).toBe('Use NES/Unified Model');
          expect(options.defaultDetail).toBe(
            'Reuse the current NES or Unified model.',
          );
        }
        return { kind: 'model' as const, model: visible };
      },
    );

    const selected = optional
      ? await pickOptionalModelReference(
          'Select a model',
          sourceKind,
          resolver,
        )
      : await pickModelReference('Select a model', sourceKind, resolver);

    expect(selected).toBeDefined();
    expect(evaluateModelForRequest).toHaveBeenCalledWith(
      { vendor: 'test', id: 'hidden' },
      sourceKind,
    );
    expect(evaluateModelForRequest).toHaveBeenCalledWith(
      { vendor: 'test', id: 'visible' },
      sourceKind,
    );
  });
});

function existingOptions(
  strategy: NesPromptStrategy,
): CopilotReplicaAlgorithmOptions & { readonly strategy: NesPromptStrategy } {
  return {
    enableFIM: false,
    enableNES: true,
    n: 1,
    nesModel: model,
    strategy,
    eagerness: 'high',
  };
}

describe('completion settings Copilot editor', () => {
  it('offers every strategy accepted by Copilot option normalization', () => {
    const strategies = buildCopilotNesStrategyItems('copilotNesXtab').map(
      (item) => item.value,
    );

    expect(strategies).toEqual([
      'copilotNesXtab',
      'xtab275',
      'xtabUnifiedModel',
      'xtabAggressiveness',
      'xtab275Aggressiveness',
      'xtab275AggressivenessHighLow',
      'xtab275EditIntent',
      'xtab275EditIntentShort',
    ]);
    for (const strategy of strategies) {
      expect(
        normalizeCopilotReplicaAlgorithmOptions({
          enableFIM: false,
          enableNES: true,
          nesModel: model,
          strategy,
        }),
      ).toMatchObject({ ok: true, value: { strategy } });
    }
  });

  it('marks and preserves an existing adaptive strategy', () => {
    const existing = existingOptions('xtab275EditIntentShort');
    const items = buildCopilotNesStrategyItems(existing.strategy);

    expect(items.filter((item) => item.picked)).toEqual([
      expect.objectContaining({ value: 'xtab275EditIntentShort' }),
    ]);
    expect(
      buildEditedCopilotReplicaOptions(existing, {
        enableFIM: false,
        enableNES: true,
        n: 1,
        nesModel: model,
        strategy: existing.strategy,
        eagerness: existing.eagerness ?? 'auto',
        modelUnification: false,
      }),
    ).toMatchObject({ strategy: 'xtab275EditIntentShort' });
  });

  it('offers and persists per-provider eagerness while NES is enabled', () => {
    expect(buildCopilotEagernessItems('medium')).toEqual([
      { label: 'Auto', value: 'auto', picked: false },
      { label: 'Low', value: 'low', picked: false },
      { label: 'Medium', value: 'medium', picked: true },
      { label: 'High', value: 'high', picked: false },
    ]);
    expect(
      buildEditedCopilotReplicaOptions(existingOptions('xtab275Aggressiveness'), {
        enableFIM: false,
        enableNES: true,
        n: 1,
        nesModel: model,
        strategy: 'xtab275Aggressiveness',
        eagerness: 'low',
        modelUnification: false,
      }),
    ).toMatchObject({ enableNES: true, eagerness: 'low' });
  });

  it('drops eagerness with the other NES-only fields when NES is disabled', () => {
    const edited = buildEditedCopilotReplicaOptions(
      existingOptions('xtab275Aggressiveness'),
      {
        enableFIM: true,
        enableNES: false,
        n: 1,
        fimModel: { vendor: 'copilot', id: 'fim-model' },
        strategy: 'xtab275Aggressiveness',
        eagerness: 'high',
        modelUnification: false,
      },
    );

    expect(edited).not.toHaveProperty('eagerness');
    expect(edited).not.toHaveProperty('strategy');
    expect(edited).not.toHaveProperty('nesModel');
  });

  it('persists FIM candidate count only while FIM is enabled', () => {
    const fimOptions = buildEditedCopilotReplicaOptions(undefined, {
      enableFIM: true,
      enableNES: false,
      n: 5,
      fimModel: { vendor: 'copilot', id: 'fim-model' },
      strategy: 'copilotNesXtab',
      eagerness: 'auto',
      modelUnification: false,
    });
    expect(fimOptions).toMatchObject({
      enableFIM: true,
      n: 5,
    });

    const nesOnlyOptions = buildEditedCopilotReplicaOptions(undefined, {
      enableFIM: false,
      enableNES: true,
      n: 5,
      nesModel: model,
      strategy: 'copilotNesXtab',
      eagerness: 'auto',
      modelUnification: false,
    });
    expect(nesOnlyOptions).not.toHaveProperty('n');
  });
});

describe('completion settings presentation', () => {
  it('offers workspace scope only when a workspace is open', () => {
    expect(buildConfigurationTargetItems(false).map((item) => item.label)).toEqual([
      'User',
    ]);
    expect(buildConfigurationTargetItems(true).map((item) => item.label)).toEqual([
      'User',
      'Workspace',
    ]);
  });

  it('builds the scoped main page without a back row or status/strategy detail', () => {
    registry.get.mockReturnValue({
      label: 'Simple',
      getSettingsDetail: () => 'Model: vendor/model',
    });

    const items = buildMainSettingsItems(2, {
      configuration: {
        enabled: false,
        providers: [
          {
            id: 'primary',
            algorithm: 'simple',
            options: { model: { vendor: 'vendor', id: 'model' } },
          },
        ],
        strategy: {
          mode: 'all',
          stopWhen: { type: 'firstUsable', graceMs: 0 },
        },
      },
      explicit: { enabled: true, strategy: false },
      issues: [],
    });

    expect(items[0]).toMatchObject({
      label: '$(warning) Status',
      description: 'Disabled',
      action: 'status',
    });
    expect(items[0]).not.toHaveProperty('detail');
    expect(items.some((item) => item.label.includes('Back'))).toBe(false);
    expect(items.filter((item) => item.kind === -1)).toHaveLength(4);
    const addIndex = items.findIndex((item) => item.action === 'add');
    expect(items[addIndex + 1]).toMatchObject({
      label: '$(star-empty) Add From Current Provider List...',
      action: 'add-current',
    });

    const provider = items.find((item) => item.providerId === 'primary');
    expect(provider).toMatchObject({
      description: 'Simple',
      detail: 'Model: vendor/model',
    });
    expect(provider?.buttons).toHaveLength(2);

    const strategy = items.find((item) => item.action === 'strategy');
    expect(strategy?.label).toBe(
      '$(circle-dashed) Completion Strategy Settings (Not Set)',
    );
    expect(strategy).not.toHaveProperty('description');
    expect(strategy).not.toHaveProperty('detail');
  });

  it('shows the user default status and treats missing providers as an empty list', () => {
    const state: ScopedCompletionConfigurationResult = {
      configuration: {
        enabled: true,
        providers: [],
        strategy: {
          mode: 'all',
          stopWhen: { type: 'firstUsable', graceMs: 0 },
        },
      },
      explicit: { enabled: false, strategy: false },
      issues: [],
    };
    const items = buildMainSettingsItems(1, state);

    expect(items[0]).toMatchObject({
      label: '$(check) Status',
      description: 'Default (Enabled)',
    });
    expect(items.some((item) => item.action === 'provider')).toBe(false);
    expect(items.some((item) => item.label.includes('(Not Set)'))).toBe(false);
    expect(buildStatusItems(1, state)[0]).toMatchObject({
      label: 'Default (Enabled)',
      description: 'default',
      value: undefined,
      picked: true,
    });
    expect(buildStatusItems(2, state)[0]).toMatchObject({
      label: 'Not Set',
      description: 'undefined',
      value: undefined,
      picked: true,
    });
  });

  it('builds algorithm-specific provider sections without field details', () => {
    const draft = createCompletionAlgorithmEntryDraft();
    draft.id = 'copilot';
    draft.algorithm = 'copilot-replica';
    draft.copilotReplica.enableFIM = true;
    draft.copilotReplica.enableNES = true;
    draft.copilotReplica.fimModel = { vendor: 'vendor', id: 'fim' };
    draft.copilotReplica.nesModel = { vendor: 'vendor', id: 'nes' };

    const items = buildProviderFormItems(draft);
    const sections = items
      .filter((item) => item.kind === -1)
      .map((item) => item.description);
    expect(sections).toEqual([
      'Common Settings',
      'Completion Modes',
      'Model Strategy',
      'FIM Settings',
      'NES Settings',
      undefined,
    ]);
    expect(items.filter((item) => item.field).map((item) => item.field)).toEqual([
      'id',
      'algorithm',
      'copilotModes',
      'copilotModelUnification',
      'copilotFimModel',
      'copilotN',
      'copilotNesModel',
      'copilotNesStrategy',
      'copilotEagerness',
      'copilotCursorPredictionModel',
    ]);
    expect(items.every((item) => item.detail === undefined)).toBe(true);
  });

  it('shows only the unified model and eagerness in unified mode', () => {
    const draft = createCompletionAlgorithmEntryDraft();
    draft.id = 'copilot';
    draft.algorithm = 'copilot-replica';
    draft.copilotReplica.enableFIM = true;
    draft.copilotReplica.enableNES = true;
    draft.copilotReplica.modelUnification = true;
    draft.copilotReplica.unifiedModel = { vendor: 'vendor', id: 'unified' };
    draft.copilotReplica.fimModel = { vendor: 'vendor', id: 'unused-fim' };
    draft.copilotReplica.nesModel = { vendor: 'vendor', id: 'unused-nes' };

    const items = buildProviderFormItems(draft);
    expect(
      items.filter((item) => item.kind === -1).map((item) => item.description),
    ).toEqual([
      'Common Settings',
      'Completion Modes',
      'Model Strategy',
      'Unified Model Settings',
      undefined,
    ]);
    expect(items.filter((item) => item.field).map((item) => item.field)).toEqual([
      'id',
      'algorithm',
      'copilotModes',
      'copilotModelUnification',
      'copilotUnifiedModel',
      'copilotEagerness',
      'copilotCursorPredictionModel',
    ]);
  });

  it.each([
    {
      name: 'FIM-only',
      enableFIM: true,
      enableNES: false,
      sections: ['Common Settings', 'Completion Modes', 'FIM Settings', undefined],
      fields: ['id', 'algorithm', 'copilotModes', 'copilotFimModel', 'copilotN'],
    },
    {
      name: 'NES-only',
      enableFIM: false,
      enableNES: true,
      sections: ['Common Settings', 'Completion Modes', 'NES Settings', undefined],
      fields: [
        'id',
        'algorithm',
        'copilotModes',
        'copilotNesModel',
        'copilotNesStrategy',
        'copilotEagerness',
        'copilotCursorPredictionModel',
      ],
    },
  ])('hides model strategy for $name mode', ({ enableFIM, enableNES, sections, fields }) => {
    const draft = createCompletionAlgorithmEntryDraft();
    draft.algorithm = 'copilot-replica';
    draft.copilotReplica.enableFIM = enableFIM;
    draft.copilotReplica.enableNES = enableNES;
    draft.copilotReplica.modelUnification = true;

    const items = buildProviderFormItems(draft);
    expect(
      items.filter((item) => item.kind === -1).map((item) => item.description),
    ).toEqual(sections);
    expect(items.filter((item) => item.field).map((item) => item.field)).toEqual(
      fields,
    );
  });

  it('uses readable strategy labels and raw persisted values in option descriptions', () => {
    expect(buildSchedulingModeItems('all').map(({ label, description }) => [
      label,
      description,
    ])).toEqual([
      ['All Providers Concurrent', 'all'],
      ['Main Provider First', 'main-first'],
    ]);
    expect(
      buildDisableVSCodeBuiltinCompletionItems(false).map(
        ({ label, description, picked }) => [label, description, picked],
      ),
    ).toEqual([
      ['Enabled', 'true', false],
      ['Disabled', 'false', true],
    ]);
    expect(
      buildStopConditionItems('firstUsable').map(
        ({ label, description }) => [label, description],
      ),
    ).toEqual([
      ['First Usable Result', 'firstUsable'],
      ['Time Limit', 'deadline'],
      ['Result Count', 'enoughResults'],
      ['All Completed', 'allSettled'],
    ]);
    expect(
      buildOtherProvidersStartTimingItems(false).map(
        ({ label, description }) => [label, description],
      ),
    ).toEqual([
      ['Start with Main Provider', 'true'],
      ['Start on Main Provider Fallback', 'false'],
    ]);
  });

  it('shows only fields used by the active stop condition', () => {
    const draft = createCompletionStrategyDraft({
      mode: 'main-first',
      disableVSCodeBuiltinCompletion: false,
      mainProvider: 'primary',
      mainFirstTimeoutMs: 300,
      parallelRequestOthers: false,
      stopWhen: { type: 'enoughResults', minItems: 2, graceMs: 50 },
    });

    const items = buildStrategyFormItems(draft);
    expect(items.filter((item) => item.field).map((item) => item.field)).toEqual([
      'mode',
      'disableVSCodeBuiltinCompletion',
      'disabledGlobs',
      'mainProvider',
      'parallelRequestOthers',
      'mainFirstTimeoutMs',
      'stopType',
      'enoughResultsMinItems',
      'enoughResultsGraceMs',
    ]);
    expect(
      items.find(
        (item) => item.field === 'disableVSCodeBuiltinCompletion',
      ),
    ).toMatchObject({
      label: '$(circle-slash) Disable VS Code Built-in Completion',
      description: 'Disabled',
    });
    expect(items.every((item) => item.detail === undefined)).toBe(true);
  });

  it('shows dedicated fields and request kinds for edit-prediction algorithms', () => {
    const draft = createCompletionAlgorithmEntryDraft();
    draft.algorithm = 'zed';
    expect(
      buildProviderFormItems(draft)
        .filter((item) => item.field)
        .map((item) => item.field),
    ).toEqual(['id', 'algorithm', 'zedModel', 'zedMaxTokens']);

    draft.algorithm = 'inception';
    expect(
      buildProviderFormItems(draft)
        .filter((item) => item.field)
        .map((item) => item.field),
    ).toEqual(['id', 'algorithm', 'inceptionModel']);

    draft.algorithm = 'mistral';
    expect(
      buildProviderFormItems(draft)
        .filter((item) => item.field)
        .map((item) => item.field),
    ).toEqual(['id', 'algorithm', 'mistralModel', 'mistralMaxTokens']);
    expect(COMPLETION_MODEL_REQUEST_KIND_BY_FIELD).toMatchObject({
      zedModel: 'zed',
      inceptionModel: 'inception',
      mistralModel: 'mistral',
    });
  });

  it('describes unified and independent model strategies by their behavior', () => {
    const items = buildModelStrategyItems(false);
    expect(items.map((item) => item.label)).toEqual([
      'Unified Model',
      'Independent Models',
    ]);
    expect(items.every((item) => item.description?.length)).toBeTruthy();
    expect(items.some((item) => item.description?.includes('arbitration'))).toBe(
      false,
    );
  });
});

function currentProviderCandidate(
  supportedRequests: readonly AlgorithmRequestKind[],
): CurrentProviderModelCandidate {
  return {
    providerName: 'Provider',
    model: { id: 'model', name: 'Model' },
    reference: { vendor: 'unify-chat-provider', id: 'Provider/model' },
    supportedRequests: new Set(supportedRequests),
  };
}

describe('current provider completion shortcut', () => {
  it('uses the algorithm ID and fills the first available numeric suffix', () => {
    expect(createUniqueCompletionProviderId('simple', [])).toBe('simple');
    expect(
      createUniqueCompletionProviderId('simple', [
        { id: 'simple', algorithm: 'simple' },
        { id: 'simple-2', algorithm: 'simple' },
        { id: 'simple-4', algorithm: 'simple' },
      ]),
    ).toBe('simple-3');
  });

  it('prefills Copilot FIM, NES, and unified modes from eligibility', () => {
    const fim = createCurrentProviderCompletionDraft(
      'copilot-replica',
      currentProviderCandidate(['copilot-replica/fim']),
      [],
    );
    expect(fim.copilotReplica).toMatchObject({
      enableFIM: true,
      enableNES: false,
      modelUnification: false,
      fimModel: { vendor: 'unify-chat-provider', id: 'Provider/model' },
    });

    const nes = createCurrentProviderCompletionDraft(
      'copilot-replica',
      currentProviderCandidate([
        'copilot-replica/nes',
        'copilot-replica/cursor-prediction',
      ]),
      [],
    );
    expect(nes.copilotReplica).toMatchObject({
      enableFIM: false,
      enableNES: true,
      modelUnification: false,
      nesModel: { vendor: 'unify-chat-provider', id: 'Provider/model' },
    });
    expect(nes.copilotReplica.cursorPredictionModel).toBeUndefined();

    const unified = createCurrentProviderCompletionDraft(
      'copilot-replica',
      currentProviderCandidate([
        'copilot-replica/fim',
        'copilot-replica/nes',
        'copilot-replica/cursor-prediction',
      ]),
      [],
    );
    expect(unified.copilotReplica).toMatchObject({
      enableFIM: true,
      enableNES: true,
      modelUnification: true,
      unifiedModel: { vendor: 'unify-chat-provider', id: 'Provider/model' },
    });
  });

  it('shows every inferred algorithm and keeps one model in multiple lists', () => {
    registry.list.mockReturnValue([
      { id: 'simple', label: 'Simple' },
      { id: 'copilot-replica', label: 'Copilot Replica' },
      { id: 'zed', label: 'Zed' },
    ]);
    const candidate = currentProviderCandidate([
      'simple',
      'copilot-replica/fim',
      'zed',
    ]);

    expect(
      buildCurrentProviderAlgorithmItems({
        candidates: [candidate],
        failures: [],
      }).map((item) => item.algorithm),
    ).toEqual(['simple', 'copilot-replica', 'zed']);
  });

  it('revalidates every active model role before saving', async () => {
    const draft = createCurrentProviderCompletionDraft(
      'copilot-replica',
      currentProviderCandidate([
        'copilot-replica/fim',
        'copilot-replica/nes',
        'copilot-replica/cursor-prediction',
      ]),
      [],
    );
    const evaluateModelForRequest = vi.fn(async (
      _reference: CompletionModelReference,
      sourceKind: AlgorithmRequestKind,
    ) => ({
      eligible: sourceKind !== 'copilot-replica/nes',
      ...(sourceKind === 'copilot-replica/nes'
        ? { code: 'completion-no-template' as const }
        : {}),
    }));

    await expect(
      validateCompletionAlgorithmDraftModels(draft, {
        resolveCompletionModel: modelResolver.resolveCompletionModel,
        evaluateModelForRequest,
      }),
    ).resolves.toContain('Copilot NES');
    expect(evaluateModelForRequest.mock.calls.map((call) => call[1])).toEqual([
      'copilot-replica/fim',
      'copilot-replica/nes',
    ]);
  });
});

describe('completion settings persistence', () => {
  it('clears providers and strategy before restoring the default status', async () => {
    await resetScope(2);

    expect(configurationApi.clear.mock.calls).toEqual([
      ['providers', 2],
      ['strategy', 2],
      ['enabled', 2],
    ]);
  });

  it('updates strategy first and rolls it back when the provider write fails', async () => {
    const original: CompletionStrategy = {
      mode: 'main-first',
      mainProvider: 'old',
      stopWhen: { type: 'allSettled' },
    };
    const updated: CompletionStrategy = {
      ...original,
      mainProvider: 'new',
    };
    const failure = new Error('provider write failed');
    configurationApi.update
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);

    await expect(
      updateProvidersAndStrategy(
        2,
        original,
        [{ id: 'new', algorithm: 'simple' }],
        updated,
      ),
    ).rejects.toBe(failure);
    expect(configurationApi.update.mock.calls).toEqual([
      ['strategy', updated, 2],
      ['providers', [{ id: 'new', algorithm: 'simple' }], 2],
      ['strategy', original, 2],
    ]);
  });

  it('preserves both failures when the provider write and strategy rollback fail', async () => {
    const original: CompletionStrategy = {
      mode: 'main-first',
      mainProvider: 'old',
      stopWhen: { type: 'allSettled' },
    };
    const updated: CompletionStrategy = {
      ...original,
      mainProvider: 'new',
    };
    const providerFailure = new Error('provider write failed');
    const rollbackFailure = new Error('strategy rollback failed');
    configurationApi.update
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(providerFailure)
      .mockRejectedValueOnce(rollbackFailure);

    const operation = updateProvidersAndStrategy(
      2,
      original,
      [{ id: 'new', algorithm: 'simple' }],
      updated,
    );
    await expect(operation).rejects.toMatchObject({
      errors: [providerFailure, rollbackFailure],
    });
  });

  it('merges a saved provider into the latest scoped list and updates its main reference', async () => {
    const original: CompletionAlgorithmEntry = {
      id: 'old',
      algorithm: 'simple',
      options: { model: { vendor: 'vendor', id: 'old-model' } },
    };
    const external: CompletionAlgorithmEntry = {
      id: 'external',
      algorithm: 'simple',
      options: { model: { vendor: 'vendor', id: 'external-model' } },
    };
    const edited: CompletionAlgorithmEntry = {
      id: 'new',
      algorithm: 'simple',
      options: { model: { vendor: 'vendor', id: 'new-model' } },
    };
    const strategy: CompletionStrategy = {
      mode: 'main-first',
      mainProvider: 'old',
      stopWhen: { type: 'allSettled' },
    };
    configurationApi.read.mockReturnValue({
      configuration: {
        enabled: true,
        providers: [original, external],
        strategy,
      },
      explicit: { enabled: true, strategy: true },
      issues: [],
    });

    await expect(updateProvidersAfterEdit(2, original, edited)).resolves.toBe(
      true,
    );
    expect(configurationApi.update.mock.calls).toEqual([
      ['strategy', { ...strategy, mainProvider: 'new' }, 2],
      ['providers', [edited, external], 2],
    ]);
  });

  it('rejects a save when the edited provider changed outside the form', async () => {
    const original: CompletionAlgorithmEntry = {
      id: 'provider',
      algorithm: 'simple',
      options: { model: { vendor: 'vendor', id: 'old' } },
    };
    configurationApi.read.mockReturnValue({
      configuration: {
        enabled: true,
        providers: [
          {
            ...original,
            options: { model: { vendor: 'vendor', id: 'external' } },
          },
        ],
        strategy: { mode: 'all', stopWhen: { type: 'allSettled' } },
      },
      explicit: { enabled: true, strategy: true },
      issues: [],
    });

    await expect(
      updateProvidersAfterEdit(2, original, {
        ...original,
        options: { model: { vendor: 'vendor', id: 'local' } },
      }),
    ).resolves.toBe(false);
    expect(configurationApi.update).not.toHaveBeenCalled();
    expect(vscodeWindow.showErrorMessage).toHaveBeenCalledOnce();
  });

  it('rejects a strategy save when the scoped strategy changed externally', async () => {
    const original: ScopedCompletionConfigurationResult = {
      configuration: {
        enabled: true,
        providers: [],
        strategy: { mode: 'all', stopWhen: { type: 'allSettled' } },
      },
      explicit: { enabled: true, strategy: true },
      issues: [],
    };
    configurationApi.read.mockReturnValue({
      ...original,
      configuration: {
        ...original.configuration,
        strategy: {
          mode: 'all',
          stopWhen: { type: 'firstUsable', graceMs: 25 },
        },
      },
    });

    await expect(
      updateStrategyAfterEdit(2, original, {
        mode: 'all',
        stopWhen: { type: 'deadline', timeoutMs: 500 },
      }),
    ).resolves.toBe(false);
    expect(configurationApi.update).not.toHaveBeenCalled();
    expect(vscodeWindow.showErrorMessage).toHaveBeenCalledOnce();
  });

  it('rejects a main-first strategy when its provider disappeared', async () => {
    const original: ScopedCompletionConfigurationResult = {
      configuration: {
        enabled: true,
        providers: [],
        strategy: { mode: 'all', stopWhen: { type: 'allSettled' } },
      },
      explicit: { enabled: true, strategy: true },
      issues: [],
    };
    configurationApi.read.mockReturnValue(original);

    await expect(
      updateStrategyAfterEdit(2, original, {
        mode: 'main-first',
        mainProvider: 'missing',
        mainFirstTimeoutMs: 500,
        parallelRequestOthers: false,
        stopWhen: { type: 'allSettled' },
      }),
    ).resolves.toBe(false);
    expect(configurationApi.update).not.toHaveBeenCalled();
    expect(vscodeWindow.showErrorMessage).toHaveBeenCalledOnce();
  });
});

describe('completion settings interaction flow', () => {
  const state: ScopedCompletionConfigurationResult = {
    configuration: {
      enabled: true,
      providers: [],
      strategy: {
        mode: 'all',
        stopWhen: { type: 'firstUsable', graceMs: 0 },
      },
    },
    explicit: { enabled: false, strategy: false },
    issues: [],
  };

  it('opens the chosen scope and closes cleanly when the main page is dismissed', async () => {
    vscodeWindow.showQuickPick.mockResolvedValueOnce({ value: 1 });
    configurationApi.read.mockReturnValue(state);
    ui.pickQuickItem.mockResolvedValueOnce(undefined);

    await showCompletionSettings(modelResolver);

    expect(vscodeWindow.showQuickPick).toHaveBeenCalledOnce();
    expect(ui.pickQuickItem).toHaveBeenCalledOnce();
    expect(ui.pickQuickItem.mock.calls[0][0]).toMatchObject({
      title: 'Code Completion Settings (User)',
      buttons: [{ id: 'back' }],
    });
  });

  it('walks back from Draft to model, algorithm, and settings one level at a time', async () => {
    const candidate = currentProviderCandidate(['simple']);
    vscodeWindow.showQuickPick.mockResolvedValueOnce({ value: 1 });
    configurationApi.read.mockReturnValue(state);
    ui.pickAsyncQuickItems
      .mockResolvedValueOnce([
        {
          label: 'Simple',
          action: 'algorithm',
          algorithm: 'simple',
          candidates: [candidate],
        },
      ])
      .mockResolvedValueOnce(undefined);
    ui.pickQuickItem
      .mockResolvedValueOnce({ label: 'Add Current', action: 'add-current' })
      .mockResolvedValueOnce({ label: 'Model', candidate })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    await showCompletionSettings(modelResolver, { endpoints: [] });

    expect(ui.pickAsyncQuickItems).toHaveBeenCalledTimes(2);
    expect(
      ui.pickQuickItem.mock.calls.map((call) => call[0].title),
    ).toEqual([
      'Code Completion Settings (User)',
      'Select a Model for simple',
      'Add Completion Provider (User)',
      'Select a Model for simple',
      'Code Completion Settings (User)',
    ]);
    expect(configurationApi.update).not.toHaveBeenCalled();
  });

  it('edits and saves the VS Code built-in completion exclusion setting', async () => {
    vscodeWindow.showQuickPick
      .mockResolvedValueOnce({ value: 1 })
      .mockResolvedValueOnce({ value: false });
    configurationApi.read.mockReturnValue(state);
    ui.pickQuickItem
      .mockResolvedValueOnce({ label: 'Strategy', action: 'strategy' })
      .mockResolvedValueOnce({
        label: 'Disable VS Code Built-in Completion',
        field: 'disableVSCodeBuiltinCompletion',
      })
      .mockResolvedValueOnce({ label: 'Save', action: 'save' })
      .mockResolvedValueOnce(undefined);

    await showCompletionSettings(modelResolver);

    expect(vscodeWindow.showQuickPick.mock.calls[1][1]).toMatchObject({
      title: 'Disable VS Code Built-in Completion',
    });
    expect(configurationApi.update).toHaveBeenCalledWith(
      'strategy',
      {
        mode: 'all',
        disableVSCodeBuiltinCompletion: false,
        disabledGlobs: [...DEFAULT_COMPLETION_DISABLED_GLOBS],
        stopWhen: { type: 'firstUsable', graceMs: 0 },
      },
      1,
    );
  });

  it('prompts before discarding a dirty provider draft', async () => {
    vscodeWindow.showQuickPick.mockResolvedValueOnce({ value: 1 });
    vscodeWindow.showInputBox.mockResolvedValueOnce('draft-provider');
    vscodeWindow.showWarningMessage.mockResolvedValueOnce('Discard Changes');
    configurationApi.read.mockReturnValue(state);
    ui.pickQuickItem
      .mockResolvedValueOnce({ label: 'Add', action: 'add' })
      .mockResolvedValueOnce({ label: 'Provider ID', field: 'id' })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    await showCompletionSettings(modelResolver);

    expect(vscodeWindow.showWarningMessage).toHaveBeenCalledWith(
      'Save changes before leaving?',
      { modal: true },
      'Save Changes',
      'Discard Changes',
      'Continue Editing',
    );
    expect(configurationApi.update).not.toHaveBeenCalled();
  });
});
