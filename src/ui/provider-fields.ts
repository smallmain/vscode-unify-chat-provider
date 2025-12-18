import * as vscode from 'vscode';
import { ConfigStore } from '../config-store';
import type { FormSchema, FieldContext } from './field-schema';
import {
  validateBaseUrl,
  validateProviderNameUnique,
  type ProviderFormDraft,
} from './form-utils';
import { normalizeBaseUrlInput } from '../utils';
import {
  Mimic,
  MIMIC_LABELS,
  ProviderType,
  PROVIDER_TYPES,
} from '../client/definitions';

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
    { id: 'special', label: 'Special Fields' },
    { id: 'others', label: 'Other Fields' },
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
          items: Object.values(PROVIDER_TYPES).map((opt) => ({
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
            !PROVIDER_TYPES[picked.typeValue].supportMimics.includes(
              draft.mimic,
            )
          ) {
            draft.mimic = undefined;
          }
        }
      },
      getDescription: (draft) =>
        Object.values(PROVIDER_TYPES).find((o) => o.type === draft.type)
          ?.label || '(required)',
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
      section: 'special',
      edit: async (draft) => {
        if (!draft.type) {
          vscode.window.showWarningMessage(
            'Please select an API format before choosing a mimic option.',
          );
          return;
        }

        const supported = PROVIDER_TYPES[draft.type].supportMimics;
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
    // Extra Headers
    {
      key: 'extraHeaders',
      type: 'custom',
      label: 'Extra Headers',
      icon: 'json',
      section: 'others',
      edit: async () => {
        vscode.window
          .showInformationMessage(
            'Extra headers must be configured in VS Code settings (JSON).',
            'Open Settings',
          )
          .then((choice) => {
            if (choice === 'Open Settings') {
              vscode.commands.executeCommand(
                'workbench.action.openSettingsJson',
              );
            }
          });
      },
      getDescription: (draft) =>
        draft.extraHeaders
          ? `${Object.keys(draft.extraHeaders).length} headers`
          : 'Not configured',
    },
    // Extra Body
    {
      key: 'extraBody',
      type: 'custom',
      label: 'Extra Body',
      icon: 'json',
      section: 'others',
      edit: async () => {
        vscode.window
          .showInformationMessage(
            'Extra body parameters must be configured in VS Code settings (JSON).',
            'Open Settings',
          )
          .then((choice) => {
            if (choice === 'Open Settings') {
              vscode.commands.executeCommand(
                'workbench.action.openSettingsJson',
              );
            }
          });
      },
      getDescription: (draft) =>
        draft.extraBody
          ? `${Object.keys(draft.extraBody).length} properties`
          : 'Not configured',
    },
  ],
};
