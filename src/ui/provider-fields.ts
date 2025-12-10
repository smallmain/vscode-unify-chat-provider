import * as vscode from 'vscode';
import { ConfigStore } from '../config-store';
import { Mimic, MIMIC_LABELS, PROVIDERS, ProviderType } from '../client';
import type { FormSchema, FieldContext } from './field-schema';
import {
  validateBaseUrl,
  validateProviderNameUnique,
  type ProviderFormDraft,
} from './form-utils';
import { normalizeBaseUrlInput } from '../utils';

/**
 * Context for provider form fields.
 */
export interface ProviderFieldContext extends FieldContext {
  store: ConfigStore;
  originalName?: string;
  onEditModels: (draft: ProviderFormDraft) => Promise<void>;
}

/**
 * Format a mimic label for display.
 */
export function formatMimicLabel(mimic: Mimic): string {
  return MIMIC_LABELS[mimic] ?? mimic;
}

/**
 * Provider form field schema.
 */
export const providerFormSchema: FormSchema<ProviderFormDraft> = {
  sections: [
    { id: 'primary', label: 'Primary Fields' },
    { id: 'content', label: 'Content Fields' },
    { id: 'other', label: 'Other Fields' },
  ],
  fields: [
    // Name field
    {
      key: 'name',
      type: 'text',
      label: 'Name',
      icon: 'tag',
      section: 'primary',
      prompt: 'Enter a name for this provider',
      placeholder: 'e.g., My Provider, OpenRouter, Custom',
      required: true,
      validate: (value, _draft, context) => {
        const ctx = context as ProviderFieldContext;
        return validateProviderNameUnique(value, ctx.store, ctx.originalName);
      },
      transform: (value) => value.trim() || undefined,
      getDescription: (draft) => draft.name || '(required)',
    },
    // Type field
    {
      key: 'type',
      type: 'custom',
      label: 'API Format',
      icon: 'symbol-enum',
      section: 'primary',
      edit: async (draft) => {
        const { pickQuickItem } = await import('./component');
        const picked = await pickQuickItem<
          vscode.QuickPickItem & { typeValue: ProviderType }
        >({
          title: 'API Format',
          placeholder: 'Select the API format',
          items: Object.values(PROVIDERS).map((opt) => ({
            label: opt.label,
            description: opt.description,
            picked: opt.type === draft.type,
            typeValue: opt.type,
          })),
        });
        if (picked) {
          draft.type = picked.typeValue;
          // Reset mimic if it is not supported by the newly selected provider type
          if (
            draft.mimic &&
            !PROVIDERS[picked.typeValue].supportMimics.includes(draft.mimic)
          ) {
            draft.mimic = undefined;
          }
        }
      },
      getDescription: (draft) =>
        Object.values(PROVIDERS).find((o) => o.type === draft.type)?.label ||
        '(required)',
    },
    // Base URL field
    {
      key: 'baseUrl',
      type: 'text',
      label: 'API Base URL',
      icon: 'globe',
      section: 'primary',
      prompt: 'Enter the API base URL',
      placeholder: 'e.g., https://api.example.com',
      required: true,
      validate: (value) => validateBaseUrl(value),
      transform: (value) => normalizeBaseUrlInput(value),
      getDescription: (draft) => draft.baseUrl || '(required)',
    },
    // API Key field
    {
      key: 'apiKey',
      type: 'text',
      label: 'API Key',
      icon: 'key',
      section: 'primary',
      prompt: 'Enter your API key (leave blank to remove)',
      password: true,
      transform: (value) => value.trim() || undefined,
      getDescription: (draft) => (draft.apiKey ? '••••••••' : '(optional)'),
    },
    // Models field (custom)
    {
      key: 'models',
      type: 'custom',
      label: 'Models',
      icon: 'symbol-misc',
      section: 'content',
      edit: async (draft, context) => {
        const ctx = context as ProviderFieldContext;
        await ctx.onEditModels(draft);
      },
      getDescription: (draft) =>
        draft.models.length > 0
          ? `${draft.models.length} model(s)`
          : '(optional, none added)',
      getDetail: (draft) =>
        draft.models.length > 0
          ? draft.models.map((m) => m.name || m.id).join(', ')
          : undefined,
    },
    // Mimic field
    {
      key: 'mimic',
      type: 'custom',
      label: 'Mimic',
      icon: 'vr',
      section: 'other',
      edit: async (draft) => {
        if (!draft.type) {
          vscode.window.showWarningMessage(
            'Please select an API format before choosing a mimic option.',
          );
          return;
        }

        const supported = PROVIDERS[draft.type].supportMimics;
        if (supported.length === 0) {
          vscode.window.showInformationMessage(
            'The selected provider type does not have any mimic options.',
          );
          draft.mimic = undefined;
          return;
        }

        const { pickQuickItem } = await import('./component');
        const picked = await pickQuickItem<
          vscode.QuickPickItem & { mimicValue?: Mimic }
        >({
          title: 'Mimic Behavior',
          placeholder: 'Select a mimic option (or None)',
          items: [
            {
              label: 'None',
              description: "Use the provider's default behavior",
              picked: !draft.mimic,
              mimicValue: undefined,
            },
            ...supported.map((mimic) => ({
              label: formatMimicLabel(mimic),
              description: mimic,
              picked: draft.mimic === mimic,
              mimicValue: mimic,
            })),
          ],
        });

        if (picked) {
          draft.mimic = picked.mimicValue ?? undefined;
        }
      },
      getDescription: (draft) =>
        draft.mimic ? formatMimicLabel(draft.mimic) : '(optional, none)',
      getDetail: () => 'Mimic some User-Agent client behavior.',
    },
  ],
};
