import * as vscode from 'vscode';
import { t } from '../i18n';
import {
  COMPLETION_TEMPLATE_ORDER,
  normalizeCompletionConfig,
  type CompletionConfigNormalizationResult,
} from '../completion/model/configuration';
import type {
  CompletionConfig,
  CompletionTemplate,
  CompletionTemplates,
} from '../types';
import { pickQuickItem, showInput } from './component';

interface CompletionConfigDraft {
  completion?: CompletionConfig;
}
type CompletionSettingsItem = vscode.QuickPickItem & {
  action?: 'back' | 'reset' | 'disable';
  field?: keyof CompletionConfig;
};

interface ValueItem<T> extends vscode.QuickPickItem {
  readonly value: T;
}

const COMPLETION_TEMPLATES =
  COMPLETION_TEMPLATE_ORDER satisfies readonly CompletionTemplate[];

function templatesDescription(
  templates: CompletionTemplates | undefined,
  allowInherit: boolean,
): string {
  if (templates === undefined) {
    return allowInherit ? t('inherit') : t('disabled');
  }
  if (templates === 'all') return t('all');
  if (templates.length === 0) return t('disabled');
  return templates.join(', ');
}

export function formatCompletionConfig(
  config: CompletionConfig | undefined,
  inheritedLabel = t('default'),
  preservedState?: CompletionConfigNormalizationResult,
  allowInherit = true,
): string {
  if (config === undefined && preservedState?.status === 'invalid') {
    return t('Invalid configuration');
  }
  const normalized = normalizeCompletionConfig(config);
  if (normalized.status === 'absent') return inheritedLabel;
  if (normalized.status === 'invalid') return t('Invalid configuration');
  if (Object.keys(normalized.value).length === 0) return inheritedLabel;
  return [
    normalized.value.transport ?? (allowInherit ? t('inherit') : t('auto')),
    templatesDescription(normalized.value.templates, allowInherit),
    ...(normalized.value.baseUrl ? [normalized.value.baseUrl] : []),
  ].join(', ');
}

async function pickTransport(
  current: CompletionConfig['transport'],
  allowInherit: boolean,
): Promise<CompletionConfig['transport'] | undefined | 'cancelled'> {
  const items: ValueItem<CompletionConfig['transport']>[] = [
    {
      label: allowInherit
        ? t('Inherit Provider Default')
        : t('Default (Auto)'),
      value: undefined,
    },
    {
      label: t('Auto'),
      description: t(
        'Use the native completion API when available, otherwise use compatible mode',
      ),
      value: 'auto',
    },
    {
      label: t('Native'),
      description: t('Require a native completion API'),
      value: 'native',
    },
    {
      label: t('Compatible'),
      description: t('Use the selected VS Code language model'),
      value: 'compatible',
    },
  ];
  const selected = await pickQuickItem({
    title: t('Completion Transport'),
    placeholder: t('Select how completion requests are sent'),
    items: items.map((item) => ({
      ...item,
      picked: item.value === current,
    })),
  });
  return selected ? selected.value : 'cancelled';
}

async function pickCustomTemplates(
  current: readonly CompletionTemplate[],
): Promise<readonly CompletionTemplate[] | undefined> {
  const items = COMPLETION_TEMPLATES.map((template) => ({
    label: template,
    value: template,
    picked: current.includes(template),
  }));
  const selected = await vscode.window.showQuickPick(items, {
    title: t('Completion Templates'),
    placeHolder: t('Select supported completion templates'),
    canPickMany: true,
  });
  return selected?.map((item) => item.value);
}

async function pickTemplates(
  current: CompletionConfig['templates'],
  allowInherit: boolean,
): Promise<CompletionConfig['templates'] | undefined | 'cancelled'> {
  type TemplateMode = 'inherit' | 'all' | 'custom' | 'disabled';
  const selected = await pickQuickItem<ValueItem<TemplateMode>>({
    title: t('Completion Templates'),
    placeholder: t('Select the model completion capability'),
    items: [
      {
        label: allowInherit
          ? t('Inherit Provider Default')
          : t('Default (Disabled)'),
        value: 'inherit',
        picked: current === undefined,
      },
      { label: t('All Templates'), value: 'all', picked: current === 'all' },
      {
        label: t('Select Templates'),
        value: 'custom',
        picked: Array.isArray(current) && current.length > 0,
      },
      {
        label: t('Disable Completion'),
        value: 'disabled',
        picked: Array.isArray(current) && current.length === 0,
      },
    ],
  });
  if (!selected) return 'cancelled';
  switch (selected.value) {
    case 'inherit':
      return undefined;
    case 'all':
      return 'all';
    case 'disabled':
      return [];
    case 'custom': {
      const custom = await pickCustomTemplates(
        Array.isArray(current) ? current : [],
      );
      return custom ?? 'cancelled';
    }
  }
}

export async function editCompletionConfig(
  draft: CompletionConfigDraft,
  options: { modelOverride: boolean },
): Promise<void> {
  const initial = normalizeCompletionConfig(draft.completion);
  const editing: CompletionConfig =
    initial.status === 'valid' ? { ...initial.value } : {};
  let dirty = false;

  while (true) {
    const items: CompletionSettingsItem[] = [
      { label: t('$(arrow-left) Back'), action: 'back' },
      {
        label: t('Completion Transport'),
        description:
          editing.transport ??
          (options.modelOverride ? t('inherit') : t('auto')),
        field: 'transport',
      },
      {
        label: t('Native Completion Base URL'),
        description:
          editing.baseUrl ??
          (options.modelOverride ? t('inherit') : t('provider base URL')),
        field: 'baseUrl',
      },
      {
        label: t('Completion Templates'),
        description: templatesDescription(
          editing.templates,
          options.modelOverride,
        ),
        field: 'templates',
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      {
        label: t('$(circle-slash) Disable Completion'),
        action: 'disable',
      },
      { label: t('$(discard) Reset Completion Settings'), action: 'reset' },
    ];
    const selected = await pickQuickItem({
      title: options.modelOverride
        ? t('Model Completion Override')
        : t('Provider Completion Defaults'),
      placeholder: options.modelOverride
        ? t('Unset fields inherit the Provider completion defaults')
        : t('Configure completion capabilities'),
      items,
    });
    if (!selected || selected.action === 'back') {
      if (dirty) draft.completion = { ...editing };
      return;
    }
    if (selected.action === 'reset') {
      draft.completion = {};
      return;
    }
    if (selected.action === 'disable') {
      draft.completion = { ...editing, templates: [] };
      return;
    }

    switch (selected.field) {
      case 'transport': {
        const value = await pickTransport(
          editing.transport,
          options.modelOverride,
        );
        if (value === 'cancelled') break;
        if (value === undefined) delete editing.transport;
        else editing.transport = value;
        dirty = true;
        break;
      }
      case 'baseUrl': {
        const value = await showInput({
          title: t('Native Completion Base URL'),
          prompt: options.modelOverride
            ? t('Leave blank to inherit the Provider base URL')
            : t('Leave blank to use the Provider base URL'),
          value: editing.baseUrl ?? '',
        });
        if (value !== undefined) {
          const normalized = value.trim();
          if (normalized) editing.baseUrl = normalized;
          else delete editing.baseUrl;
          dirty = true;
        }
        break;
      }
      case 'templates': {
        const value = await pickTemplates(
          editing.templates,
          options.modelOverride,
        );
        if (value === 'cancelled') break;
        if (value === undefined) delete editing.templates;
        else editing.templates = value;
        dirty = true;
        break;
      }
    }
  }
}
