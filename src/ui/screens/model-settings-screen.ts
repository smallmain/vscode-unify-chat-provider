import * as vscode from 'vscode';
import type { ModelConfig } from '../../types';
import { t } from '../../i18n';
import { pickQuickItem, showInput } from '../component';
import type {
  MultiAgentFormRoute,
  ThinkingFormRoute,
  UiContext,
  UiNavAction,
  UiResume,
} from '../router/types';

type ThinkingConfig = NonNullable<ModelConfig['thinking']>;
type ThinkingDraft = Partial<ThinkingConfig>;
type ThinkingField =
  | 'type'
  | 'budgetTokens'
  | 'effort'
  | 'summary'
  | 'mode'
  | 'context';

type MultiAgentConfig = NonNullable<ModelConfig['multi-agent']>;
type MultiAgentDraft = Partial<MultiAgentConfig>;
type MultiAgentField = 'enabled' | 'maxConcurrentSubagents';

interface SettingsItem<T> extends vscode.QuickPickItem {
  action?: 'back' | 'reset';
  edit?: T;
}

export async function runThinkingFormScreen(
  _ctx: UiContext,
  route: ThinkingFormRoute,
  _resume: UiResume | undefined,
): Promise<UiNavAction> {
  const selection = await pickQuickItem<SettingsItem<ThinkingField>>({
    title: t('Thinking'),
    placeholder: route.readOnly
      ? t('Select a field to view')
      : t('Select a setting to edit'),
    ignoreFocusOut: true,
    items: buildThinkingItems(route.draft, route.readOnly),
  });

  if (!selection || selection.action === 'back') {
    if (!route.readOnly) {
      route.model.thinking = buildThinkingConfig(route.draft);
    }
    return { kind: 'pop' };
  }

  if (route.readOnly) return { kind: 'stay' };

  if (selection.action === 'reset') {
    route.draft = {};
    return { kind: 'stay' };
  }

  if (selection.edit) {
    await editThinkingField(route.draft, selection.edit);
  }
  return { kind: 'stay' };
}

export async function runMultiAgentFormScreen(
  _ctx: UiContext,
  route: MultiAgentFormRoute,
  _resume: UiResume | undefined,
): Promise<UiNavAction> {
  const selection = await pickQuickItem<SettingsItem<MultiAgentField>>({
    title: t('Native Multi-agent'),
    placeholder: route.readOnly
      ? t('Select a field to view')
      : t('Select a setting to edit'),
    ignoreFocusOut: true,
    items: buildMultiAgentItems(route.draft, route.readOnly),
  });

  if (!selection || selection.action === 'back') {
    if (!route.readOnly) {
      route.model['multi-agent'] = buildMultiAgentConfig(route.draft);
    }
    return { kind: 'pop' };
  }

  if (route.readOnly) return { kind: 'stay' };

  if (selection.action === 'reset') {
    route.draft = {};
    return { kind: 'stay' };
  }

  if (selection.edit) {
    await editMultiAgentField(route.draft, selection.edit);
  }
  return { kind: 'stay' };
}

function buildThinkingItems(
  draft: ThinkingDraft,
  readOnly: boolean,
): SettingsItem<ThinkingField>[] {
  const items: SettingsItem<ThinkingField>[] = [
    { label: `$(arrow-left) ${t('Back')}`, action: 'back' },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    {
      label: `$(symbol-enum) ${t('Thinking Type')}`,
      description: formatThinkingType(draft.type),
      edit: 'type',
    },
    {
      label: `$(symbol-number) ${t('Budget Tokens')}`,
      description:
        draft.budgetTokens === undefined
          ? t('Provider Default')
          : t('{0} tokens', draft.budgetTokens),
      edit: 'budgetTokens',
    },
    {
      label: `$(dashboard) ${t('Reasoning Effort')}`,
      description: formatThinkingEffort(draft.effort),
      edit: 'effort',
    },
    {
      label: `$(note) ${t('Reasoning Summary')}`,
      description: formatThinkingSummary(draft.summary),
      edit: 'summary',
    },
    {
      label: `$(settings) ${t('Thinking Mode')}`,
      description: formatThinkingMode(draft.mode),
      edit: 'mode',
    },
    {
      label: `$(history) ${t('Reasoning Context')}`,
      description: formatThinkingContext(draft.context),
      edit: 'context',
    },
  ];

  if (!readOnly) {
    items.push(
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: `$(refresh) ${t('Reset to Defaults')}`, action: 'reset' },
    );
  }
  return items;
}

function buildMultiAgentItems(
  draft: MultiAgentDraft,
  readOnly: boolean,
): SettingsItem<MultiAgentField>[] {
  const items: SettingsItem<MultiAgentField>[] = [
    { label: `$(arrow-left) ${t('Back')}`, action: 'back' },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    {
      label: `$(check) ${t('Enabled')}`,
      description:
        draft.enabled === undefined
          ? t('Provider Default')
          : draft.enabled
            ? t('Enabled')
            : t('Disabled'),
      edit: 'enabled',
    },
    {
      label: `$(symbol-number) ${t('Max Concurrent Subagents')}`,
      description:
        draft.maxConcurrentSubagents === undefined
          ? t('Provider Default')
          : String(draft.maxConcurrentSubagents),
      edit: 'maxConcurrentSubagents',
    },
  ];

  if (!readOnly) {
    items.push(
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: `$(refresh) ${t('Reset to Defaults')}`, action: 'reset' },
    );
  }
  return items;
}

async function editThinkingField(
  draft: ThinkingDraft,
  field: ThinkingField,
): Promise<void> {
  if (field === 'type') {
    const picked = await pickQuickItem<
      vscode.QuickPickItem & { value: ThinkingConfig['type'] | undefined }
    >({
      title: t('Thinking Type'),
      placeholder: t('Select thinking type'),
      ignoreFocusOut: true,
      items: [
        {
          label: t('Provider Default'),
          value: undefined,
          picked: draft.type === undefined,
        },
        {
          label: t('Enabled'),
          value: 'enabled',
          picked: draft.type === 'enabled',
        },
        { label: t('Auto'), value: 'auto', picked: draft.type === 'auto' },
        {
          label: t('Disabled'),
          value: 'disabled',
          picked: draft.type === 'disabled',
        },
      ],
    });
    if (!picked) return;
    if (picked.value === undefined) {
      clearThinkingDraft(draft);
    } else {
      draft.type = picked.value;
    }
    return;
  }

  if (field === 'budgetTokens') {
    const input = await showInput({
      title: t('Budget Tokens'),
      prompt: t('Enter budget tokens for thinking'),
      placeHolder: t('Leave blank for default'),
      value: draft.budgetTokens?.toString() ?? '',
      ignoreFocusOut: true,
      validateInput: validatePositiveIntegerOrEmpty,
    });
    if (input === undefined) return;
    const trimmed = input.trim();
    draft.budgetTokens = trimmed ? Number(trimmed) : undefined;
    ensureThinkingIsEnabledWhenConfigured(draft, draft.budgetTokens);
    return;
  }

  if (field === 'effort') {
    const picked = await pickQuickItem<
      vscode.QuickPickItem & {
        value: NonNullable<ThinkingConfig['effort']> | undefined;
      }
    >({
      title: t('Reasoning Effort'),
      placeholder: t('Select reasoning effort (optional)'),
      ignoreFocusOut: true,
      items: [
        {
          label: t('Provider Default'),
          value: undefined,
          picked: draft.effort === undefined,
        },
        { label: t('None'), value: 'none', picked: draft.effort === 'none' },
        {
          label: t('Minimal'),
          value: 'minimal',
          picked: draft.effort === 'minimal',
        },
        { label: t('Low'), value: 'low', picked: draft.effort === 'low' },
        {
          label: t('Medium'),
          value: 'medium',
          picked: draft.effort === 'medium',
        },
        { label: t('High'), value: 'high', picked: draft.effort === 'high' },
        {
          label: t('Extra High'),
          value: 'xhigh',
          picked: draft.effort === 'xhigh',
        },
        { label: t('Max'), value: 'max', picked: draft.effort === 'max' },
      ],
    });
    if (!picked) return;
    draft.effort = picked.value;
    ensureThinkingIsEnabledWhenConfigured(draft, picked.value);
    return;
  }

  if (field === 'summary') {
    const picked = await pickQuickItem<
      vscode.QuickPickItem & {
        value: NonNullable<ThinkingConfig['summary']> | undefined;
      }
    >({
      title: t('Reasoning Summary'),
      placeholder: t('Select reasoning summary level (optional)'),
      ignoreFocusOut: true,
      items: [
        {
          label: t('Provider Default'),
          value: undefined,
          picked: draft.summary === undefined,
        },
        { label: t('None'), value: 'none', picked: draft.summary === 'none' },
        { label: t('Auto'), value: 'auto', picked: draft.summary === 'auto' },
        {
          label: t('Concise'),
          value: 'concise',
          picked: draft.summary === 'concise',
        },
        {
          label: t('Detailed'),
          value: 'detailed',
          picked: draft.summary === 'detailed',
        },
      ],
    });
    if (!picked) return;
    draft.summary = picked.value;
    ensureThinkingIsEnabledWhenConfigured(draft, picked.value);
    return;
  }

  if (field === 'mode') {
    const picked = await pickQuickItem<
      vscode.QuickPickItem & {
        value: NonNullable<ThinkingConfig['mode']> | undefined;
      }
    >({
      title: t('Thinking Mode'),
      placeholder: t('Select thinking mode'),
      ignoreFocusOut: true,
      items: [
        {
          label: t('Provider Default'),
          value: undefined,
          picked: draft.mode === undefined,
        },
        {
          label: t('Standard'),
          value: 'standard',
          picked: draft.mode === 'standard',
        },
        { label: t('Pro'), value: 'pro', picked: draft.mode === 'pro' },
      ],
    });
    if (!picked) return;
    draft.mode = picked.value;
    ensureThinkingIsEnabledWhenConfigured(draft, picked.value);
    return;
  }

  const picked = await pickQuickItem<
    vscode.QuickPickItem & {
      value: NonNullable<ThinkingConfig['context']> | undefined;
    }
  >({
    title: t('Reasoning Context'),
    placeholder: t('Select reasoning context'),
    ignoreFocusOut: true,
    items: [
      {
        label: t('Provider Default'),
        value: undefined,
        picked: draft.context === undefined,
      },
      { label: t('Auto'), value: 'auto', picked: draft.context === 'auto' },
      {
        label: t('Current Turn'),
        value: 'current_turn',
        picked: draft.context === 'current_turn',
      },
      {
        label: t('All Turns'),
        value: 'all_turns',
        picked: draft.context === 'all_turns',
      },
    ],
  });
  if (!picked) return;
  draft.context = picked.value;
  ensureThinkingIsEnabledWhenConfigured(draft, picked.value);
}

async function editMultiAgentField(
  draft: MultiAgentDraft,
  field: MultiAgentField,
): Promise<void> {
  if (field === 'enabled') {
    const picked = await pickQuickItem<
      vscode.QuickPickItem & { value: boolean | undefined }
    >({
      title: t('Native Multi-agent'),
      placeholder: t('Select multi-agent setting'),
      ignoreFocusOut: true,
      items: [
        {
          label: t('Provider Default'),
          value: undefined,
          picked: draft.enabled === undefined,
        },
        { label: t('Enabled'), value: true, picked: draft.enabled === true },
        { label: t('Disabled'), value: false, picked: draft.enabled === false },
      ],
    });
    if (!picked) return;
    draft.enabled = picked.value;
    if (picked.value === undefined) {
      draft.maxConcurrentSubagents = undefined;
    }
    return;
  }

  const input = await showInput({
    title: t('Max Concurrent Subagents'),
    prompt: t('Enter the maximum number of concurrent subagents'),
    placeHolder: t('Leave blank to omit this field'),
    value: draft.maxConcurrentSubagents?.toString() ?? '',
    ignoreFocusOut: true,
    validateInput: validatePositiveIntegerOrEmpty,
  });
  if (input === undefined) return;
  const trimmed = input.trim();
  draft.maxConcurrentSubagents = trimmed ? Number(trimmed) : undefined;
  if (
    draft.maxConcurrentSubagents !== undefined &&
    draft.enabled === undefined
  ) {
    draft.enabled = false;
  }
}

function buildThinkingConfig(draft: ThinkingDraft): ThinkingConfig | undefined {
  if (!hasThinkingValues(draft)) return undefined;
  return {
    type: draft.type ?? 'enabled',
    budgetTokens: draft.budgetTokens,
    effort: draft.effort,
    summary: draft.summary,
    mode: draft.mode,
    context: draft.context,
  };
}

function buildMultiAgentConfig(
  draft: MultiAgentDraft,
): MultiAgentConfig | undefined {
  if (
    draft.enabled === undefined &&
    draft.maxConcurrentSubagents === undefined
  ) {
    return undefined;
  }
  return {
    enabled: draft.enabled ?? false,
    maxConcurrentSubagents: draft.maxConcurrentSubagents,
  };
}

function hasThinkingValues(draft: ThinkingDraft): boolean {
  return (
    draft.type !== undefined ||
    draft.budgetTokens !== undefined ||
    draft.effort !== undefined ||
    draft.summary !== undefined ||
    draft.mode !== undefined ||
    draft.context !== undefined
  );
}

function clearThinkingDraft(draft: ThinkingDraft): void {
  draft.type = undefined;
  draft.budgetTokens = undefined;
  draft.effort = undefined;
  draft.summary = undefined;
  draft.mode = undefined;
  draft.context = undefined;
}

function ensureThinkingIsEnabledWhenConfigured(
  draft: ThinkingDraft,
  value: unknown,
): void {
  if (value !== undefined && draft.type === undefined) {
    draft.type = 'enabled';
  }
}

function validatePositiveIntegerOrEmpty(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0
    ? null
    : t('Please enter a positive integer');
}

function formatThinkingType(type: ThinkingDraft['type']): string {
  switch (type) {
    case 'enabled':
      return t('Enabled');
    case 'auto':
      return t('Auto');
    case 'disabled':
      return t('Disabled');
    case undefined:
      return t('Provider Default');
  }
}

function formatThinkingEffort(effort: ThinkingDraft['effort']): string {
  switch (effort) {
    case 'none':
      return t('None');
    case 'minimal':
      return t('Minimal');
    case 'low':
      return t('Low');
    case 'medium':
      return t('Medium');
    case 'high':
      return t('High');
    case 'xhigh':
      return t('Extra High');
    case 'max':
      return t('Max');
    case undefined:
      return t('Provider Default');
  }
}

function formatThinkingSummary(summary: ThinkingDraft['summary']): string {
  switch (summary) {
    case 'none':
      return t('None');
    case 'auto':
      return t('Auto');
    case 'concise':
      return t('Concise');
    case 'detailed':
      return t('Detailed');
    case undefined:
      return t('Provider Default');
  }
}

function formatThinkingMode(mode: ThinkingDraft['mode']): string {
  switch (mode) {
    case 'standard':
      return t('Standard');
    case 'pro':
      return t('Pro');
    case undefined:
      return t('Provider Default');
  }
}

function formatThinkingContext(context: ThinkingDraft['context']): string {
  switch (context) {
    case 'auto':
      return t('Auto');
    case 'current_turn':
      return t('Current Turn');
    case 'all_turns':
      return t('All Turns');
    case undefined:
      return t('Provider Default');
  }
}
