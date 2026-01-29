import * as vscode from 'vscode';
import { t } from '../i18n';
import { DEFAULT_MAX_OUTPUT_TOKENS } from '../defaults';
import type { FieldContext, FormSchema } from './field-schema';
import { booleanOptions, formatBoolean } from './field-editors';
import { pickQuickItem, showInput } from './component';
import {
  validateModelIdUnique,
  validatePositiveIntegerOrEmpty,
} from './form-utils';
import {
  hasVersion,
  generateAutoVersionedId,
  MODEL_VERSION_DELIMITER,
} from '../model-id-utils';
import type { ApiType } from '../client/definitions';
import { ModelConfig } from '../types';

/**
 * Context for model form fields.
 */
export interface ModelFieldContext extends FieldContext {
  models: ModelConfig[];
  originalId?: string;
  providerType?: ApiType;
}

/**
 * Model form field schema.
 */
export const modelFormSchema: FormSchema<ModelConfig> = {
  sections: [
    { id: 'primary', label: t('Primary Fields') },
    { id: 'details', label: t('Detailed Fields') },
    { id: 'capabilities', label: t('Capabilities') },
    { id: 'parameters', label: t('Parameters') },
    { id: 'others', label: t('others') },
  ],
  fields: [
    {
      key: 'id',
      type: 'text',
      label: t('Model ID'),
      icon: 'tag',
      section: 'primary',
      prompt: t('Enter the model ID'),
      placeholder: t('e.g., claude-sonnet-4-20250514'),
      required: true,
      validate: (input, _draft, context) => {
        const ctx = context as ModelFieldContext;
        const trimmed = input.trim();
        const err = validateModelIdUnique(input, ctx.models, ctx.originalId);
        if (err) {
          if (trimmed === '' || hasVersion(trimmed)) {
            return err;
          }
        }
        if (trimmed.endsWith(MODEL_VERSION_DELIMITER)) {
          return t("Model ID cannot end with '{0}'", MODEL_VERSION_DELIMITER);
        }
        return null;
      },
      onWillAccept: async (input, _draft, context) => {
        const ctx = context as ModelFieldContext;
        const trimmed = input.trim();
        if (!trimmed) return false;

        if (validateModelIdUnique(trimmed, ctx.models, ctx.originalId)) {
          // If ID already has a version, the input validation already blocked it
          // This handles the case where ID has no version - show auto-version dialog
          if (!hasVersion(trimmed)) {
            const autoVersionedId = generateAutoVersionedId(
              trimmed,
              ctx.models,
            );
            const choice = await vscode.window.showWarningMessage(
              t("A model with the ID '{0}' already exists.\nWould you like to add a version suffix to '{1}'?", trimmed, autoVersionedId),
              { modal: true },
              t('Yes'),
            );

            if (choice === t('Yes')) {
              return { value: autoVersionedId };
            }
            // If cancelled, keep input open
            return false;
          }
        }
        return true;
      },
      transform: (value) => value.trim() || undefined,
      getDescription: (draft) => draft.id || t('(required)'),
    },
    // Name field
    {
      key: 'name',
      type: 'text',
      label: t('Display Name'),
      icon: 'symbol-text',
      section: 'primary',
      prompt: t('Enter display name (leave blank to use model ID)'),
      placeholder: t('e.g., Claude Sonnet 4'),
      transform: (value) => value.trim() || undefined,
      getDescription: (draft) => draft.name || t('(optional)'),
    },
    // Family field
    {
      key: 'family',
      type: 'text',
      label: t('Model Family'),
      icon: 'preserve-case',
      section: 'primary',
      prompt: t('Enter model family (leave blank to use model ID)'),
      placeholder: t('e.g., gpt-4, claude-3'),
      transform: (value) => value.trim() || undefined,
      getDescription: (draft) => draft.family || t('(optional)'),
    },
    // Max Input Tokens
    {
      key: 'maxInputTokens',
      type: 'number',
      label: t('Max Input/Context Tokens'),
      icon: 'arrow-down',
      section: 'details',
      prompt: (_draft, context) => {
        const providerType = (context as ModelFieldContext).providerType;
        if (!providerType) return t('Enter max input/context tokens');
        return t('Enter max input/context tokens (leave blank to let the provider decide)');
      },
      placeholder: t('Leave blank for default'),
      positiveInteger: true,
      getDescription: (draft, context) => {
        if (draft.maxInputTokens !== undefined) {
          return draft.maxInputTokens.toLocaleString();
        }
        const providerType = (context as ModelFieldContext | undefined)
          ?.providerType;
        if (!providerType) return undefined;
        return t('provider decides');
      },
    },
    // Max Output Tokens
    {
      key: 'maxOutputTokens',
      type: 'number',
      label: t('Max Output Tokens'),
      icon: 'arrow-up',
      section: 'details',
      prompt: (_draft, context) => {
        const providerType = (context as ModelFieldContext).providerType;
        if (!providerType) return t('Enter max output tokens');
        if (providerType === 'anthropic') {
          return t('Enter max output tokens (leave blank to send default: {0})', DEFAULT_MAX_OUTPUT_TOKENS.toLocaleString());
        }
        return t('Enter max output tokens (leave blank to let the provider decide)');
      },
      placeholder: t('Leave blank for default'),
      positiveInteger: true,
      getDescription: (draft, context) => {
        if (draft.maxOutputTokens !== undefined) {
          return draft.maxOutputTokens.toLocaleString();
        }
        const providerType = (context as ModelFieldContext | undefined)
          ?.providerType;
        if (!providerType) return undefined;
        if (providerType === 'anthropic') {
          return t('default: {0}', DEFAULT_MAX_OUTPUT_TOKENS.toLocaleString());
        }
        return t('provider decides');
      },
    },
    // Tool Calling (custom due to special limit option)
    {
      key: 'capabilities',
      type: 'custom',
      label: t('Tool Calling'),
      icon: 'tools',
      section: 'capabilities',
      edit: async (draft) => {
        const picked = await pickQuickItem<
          vscode.QuickPickItem & { value: boolean | 'limit' }
        >({
          title: t('Tool Calling Support'),
          placeholder: t('Select tool calling support'),
          items: [
            {
              label: t('Enabled'),
              description: t('Model supports tool calling'),
              value: true,
            },
            {
              label: t('Disabled'),
              description: t('Model does not support tool calling'),
              value: false,
            },
            {
              label: t('Limited...'),
              description: t('Set a maximum number of tools'),
              value: 'limit',
            },
          ],
        });

        if (!picked) return;

        if (picked.value === 'limit') {
          const limitStr = await showInput({
            prompt: t('Enter maximum number of tools'),
            placeHolder: t('e.g., 10'),
            value:
              typeof draft.capabilities?.toolCalling === 'number'
                ? draft.capabilities.toolCalling.toString()
                : '',
            validateInput: validatePositiveIntegerOrEmpty,
          });
          if (limitStr !== undefined) {
            const limit = limitStr ? Number(limitStr) : undefined;
            if (limit !== undefined) {
              draft.capabilities = {
                ...draft.capabilities,
                toolCalling: limit,
              };
            }
          }
        } else {
          draft.capabilities = {
            ...draft.capabilities,
            toolCalling: picked.value,
          };
        }
      },
      getDescription: (draft) =>
        typeof draft.capabilities?.toolCalling === 'number'
          ? t('Enabled (max {0})', draft.capabilities.toolCalling)
          : draft.capabilities?.toolCalling
          ? t('Enabled')
          : t('Disabled'),
    },
    // Parallel Tool Calling
    {
      key: 'parallelToolCalling',
      type: 'picker',
      label: t('Parallel Tool Calling'),
      icon: 'group-by-ref-type',
      section: 'capabilities',
      title: t('Parallel Tool Calling'),
      placeholder: t('Enable or disable parallel tool calls'),
      options: [
        {
          label: t('Default'),
          description: t('Use provider default behavior'),
          value: undefined,
        },
        {
          label: t('Enable'),
          description: t('Allow parallel tool calls'),
          value: true,
        },
        {
          label: t('Disable'),
          description: t('Disallow parallel tool calls'),
          value: false,
        },
      ],
      getDescription: (draft) =>
        draft.parallelToolCalling === undefined
          ? t('default')
          : draft.parallelToolCalling
          ? t('enable')
          : t('disable'),
    },
    // Image Input (custom because it modifies capabilities nested object)
    {
      key: 'capabilities',
      type: 'custom',
      label: t('Image Input Support'),
      icon: 'file-media',
      section: 'capabilities',
      edit: async (draft) => {
        const picked = await pickQuickItem<
          vscode.QuickPickItem & { value: boolean }
        >({
          title: t('Image Input Support'),
          placeholder: t('Enable or disable image input'),
          items: [
            {
              label: t('Enabled'),
              description: t('Model supports image input'),
              value: true,
            },
            {
              label: t('Disabled'),
              description: t('Model does not support image input'),
              value: false,
            },
          ],
        });
        if (picked) {
          draft.capabilities = {
            ...draft.capabilities,
            imageInput: picked.value,
          };
        }
      },
      getDescription: (draft) =>
        draft.capabilities?.imageInput ? t('Enabled') : t('Disabled'),
    },
    // Stream
    {
      key: 'stream',
      type: 'picker',
      label: t('Stream'),
      icon: 'diff-renamed',
      section: 'capabilities',
      title: t('Stream Response'),
      placeholder: t('Select stream setting'),
      options: booleanOptions({
        default: t('Default'),
        defaultDesc: t('Use provider default'),
        true: t('True'),
        trueDesc: t('Enable streaming'),
        false: t('False'),
        falseDesc: t('Disable streaming'),
      }),
      getDescription: (draft) => formatBoolean(draft.stream),
    },
    // Thinking (custom due to complex nested structure)
    {
      key: 'thinking',
      type: 'custom',
      label: t('Thinking'),
      icon: 'lightbulb',
      section: 'capabilities',
      edit: async (draft) => {
        const picked = await pickQuickItem<
          vscode.QuickPickItem & {
            value: 'enabled' | 'disabled' | 'auto' | undefined;
          }
        >({
          title: t('Thinking Capability'),
          placeholder: t('Select thinking setting'),
          items: [
            {
              label: t('Default'),
              description: t('Use provider default'),
              value: undefined,
            },
            {
              label: t('Enabled'),
              description: t('Enable thinking'),
              value: 'enabled',
            },
            {
              label: t('Auto'),
              description: t('Auto thinking'),
              value: 'auto',
            },
            {
              label: t('Disabled'),
              description: t('Disable thinking'),
              value: 'disabled',
            },
          ],
        });

        if (!picked) return;

        if (picked.value === undefined) {
          draft.thinking = undefined;
        } else if (picked.value === 'disabled') {
          draft.thinking = { type: 'disabled' };
        } else {
          const budgetStr = await showInput({
            prompt: t('Enter budget tokens for thinking'),
            placeHolder: t('Leave blank for default'),
            value: draft.thinking?.budgetTokens?.toString(),
            validateInput: validatePositiveIntegerOrEmpty,
          });

          const effort = await pickQuickItem<
            vscode.QuickPickItem & {
              value:
                | 'none'
                | 'minimal'
                | 'low'
                | 'medium'
                | 'high'
                | 'xhigh'
                | undefined;
            }
          >({
            title: t('Thinking Effort'),
            placeholder: t('Select thinking effort (optional)'),
            items: [
              {
                label: t('Default'),
                description: t('Let the provider decide'),
                value: undefined,
                picked: draft.thinking?.effort === undefined,
              },
              {
                label: t('None'),
                value: 'none',
                picked: draft.thinking?.effort === 'none',
              },
              {
                label: t('Minimal'),
                value: 'minimal',
                picked: draft.thinking?.effort === 'minimal',
              },
              {
                label: t('Low'),
                value: 'low',
                picked: draft.thinking?.effort === 'low',
              },
              {
                label: t('Medium'),
                value: 'medium',
                picked: draft.thinking?.effort === 'medium',
              },
              {
                label: t('High'),
                value: 'high',
                picked: draft.thinking?.effort === 'high',
              },
              {
                label: t('Extra High'),
                value: 'xhigh',
                picked: draft.thinking?.effort === 'xhigh',
              },
            ],
          });

          draft.thinking = {
            type: picked.value,
            budgetTokens: budgetStr ? Number(budgetStr) : undefined,
            effort: effort ? effort.value : undefined,
          };
        }
      },
      getDescription: (draft) => {
        if (!draft.thinking) return t('default');
        if (draft.thinking.type === 'disabled') return t('disabled');
        const typeLabel = draft.thinking.type === 'auto' ? t('auto') : t('enabled');
        const details: string[] = [];
        if (draft.thinking.budgetTokens !== undefined) {
          details.push(t('{0} tokens', draft.thinking.budgetTokens));
        }
        if (draft.thinking.effort) {
          details.push(t('{0} effort', draft.thinking.effort));
        }
        return `${typeLabel}${
          details.length > 0 ? ` (${details.join(', ')})` : ''
        }`;
      },
    },
    // Verbosity
    {
      key: 'verbosity',
      type: 'picker',
      label: t('Verbosity'),
      icon: 'code-review',
      section: 'capabilities',
      title: t('Verbosity'),
      placeholder: t('Choose response verbosity'),
      options: [
        {
          label: t('Default'),
          description: t('Use provider default'),
          value: undefined,
        },
        {
          label: t('Low'),
          description: t('More concise responses'),
          value: 'low',
        },
        {
          label: t('Medium'),
          description: t('Balanced verbosity'),
          value: 'medium',
        },
        {
          label: t('High'),
          description: t('More verbose responses'),
          value: 'high',
        },
      ],
      getDescription: (draft) => draft.verbosity ?? t('default'),
    },
    // Temperature
    {
      key: 'temperature',
      type: 'number',
      label: t('Temperature'),
      icon: 'circle',
      section: 'parameters',
      prompt: t('Enter temperature'),
      placeholder: t('Leave blank for default'),
      getDescription: (draft) =>
        draft.temperature === undefined
          ? t('default')
          : draft.temperature.toString(),
    },
    // Top K
    {
      key: 'topK',
      type: 'number',
      label: t('Top K'),
      icon: 'circle',
      section: 'parameters',
      prompt: t('Enter Top K'),
      placeholder: t('Leave blank for default'),
      positiveInteger: true,
      getDescription: (draft) =>
        draft.topK === undefined ? t('default') : draft.topK.toString(),
    },
    // Top P
    {
      key: 'topP',
      type: 'number',
      label: t('Top P'),
      icon: 'circle',
      section: 'parameters',
      prompt: t('Enter Top P'),
      placeholder: t('Leave blank for default'),
      getDescription: (draft) =>
        draft.topP === undefined ? t('default') : draft.topP.toString(),
    },
    // Frequency Penalty
    {
      key: 'frequencyPenalty',
      type: 'number',
      label: t('Frequency Penalty'),
      icon: 'circle',
      section: 'parameters',
      prompt: t('Enter Frequency Penalty'),
      placeholder: t('Leave blank for default'),
      getDescription: (draft) =>
        draft.frequencyPenalty === undefined
          ? t('default')
          : draft.frequencyPenalty.toString(),
    },
    // Presence Penalty
    {
      key: 'presencePenalty',
      type: 'number',
      label: t('Presence Penalty'),
      icon: 'circle',
      section: 'parameters',
      prompt: t('Enter Presence Penalty'),
      placeholder: t('Leave blank for default'),
      getDescription: (draft) =>
        draft.presencePenalty === undefined
          ? t('default')
          : draft.presencePenalty.toString(),
    },
    // Extra Headers
    {
      key: 'extraHeaders',
      type: 'custom',
      label: t('Extra Headers'),
      icon: 'json',
      section: 'others',
      edit: async () => {
        vscode.window
          .showInformationMessage(
            t('Extra headers must be configured in VS Code settings (JSON).'),
            t('Open Settings'),
          )
          .then((choice) => {
            if (choice === t('Open Settings')) {
              vscode.commands.executeCommand(
                'workbench.action.openSettingsJson',
              );
            }
          });
      },
      getDescription: (draft) =>
        draft.extraHeaders
          ? t('{0} headers', Object.keys(draft.extraHeaders).length)
          : t('Not configured'),
    },
    // Extra Body
    {
      key: 'extraBody',
      type: 'custom',
      label: t('Extra Body'),
      icon: 'json',
      section: 'others',
      edit: async () => {
        vscode.window
          .showInformationMessage(
            t('Extra body parameters must be configured in VS Code settings (JSON).'),
            t('Open Settings'),
          )
          .then((choice) => {
            if (choice === t('Open Settings')) {
              vscode.commands.executeCommand(
                'workbench.action.openSettingsJson',
              );
            }
          });
      },
      getDescription: (draft) =>
        draft.extraBody
          ? t('{0} properties', Object.keys(draft.extraBody).length)
          : t('Not configured'),
    },
  ],
};

/**
 * Find model fields by key (for fields with same key like capabilities).
 * Returns all matching fields.
 */
export function findModelFieldsByKey(
  key: keyof ModelConfig,
): typeof modelFormSchema.fields {
  return modelFormSchema.fields.filter((f) => f.key === key);
}
