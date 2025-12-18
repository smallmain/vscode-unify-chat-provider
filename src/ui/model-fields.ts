import * as vscode from 'vscode';
import {
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from '../defaults';
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
import { ModelConfig } from '../types';

/**
 * Context for model form fields.
 */
export interface ModelFieldContext extends FieldContext {
  models: ModelConfig[];
  originalId?: string;
}

/**
 * Model form field schema.
 */
export const modelFormSchema: FormSchema<ModelConfig> = {
  sections: [
    { id: 'primary', label: 'Primary Fields' },
    { id: 'details', label: 'Detailed Fields' },
    { id: 'capabilities', label: 'Capabilities' },
    { id: 'parameters', label: 'Parameters' },
    { id: 'others', label: 'others' },
  ],
  fields: [
    {
      key: 'id',
      type: 'text',
      label: 'Model ID',
      icon: 'tag',
      section: 'primary',
      prompt: 'Enter the model ID',
      placeholder: 'e.g., claude-sonnet-4-20250514',
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
          return `Model ID cannot end with '${MODEL_VERSION_DELIMITER}'`;
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
              `A model with the ID '${trimmed}' already exists.\nWould you like to add a version suffix to '${autoVersionedId}'?`,
              { modal: true },
              'Yes',
            );

            if (choice === 'Yes') {
              return { value: autoVersionedId };
            }
            // If cancelled, keep input open
            return false;
          }
        }
        return true;
      },
      transform: (value) => value.trim() || undefined,
      getDescription: (draft) => draft.id || '(required)',
    },
    // Name field
    {
      key: 'name',
      type: 'text',
      label: 'Display Name',
      icon: 'symbol-text',
      section: 'primary',
      prompt: 'Enter display name (leave blank to remove)',
      placeholder: 'e.g., Claude Sonnet 4',
      transform: (value) => value.trim() || undefined,
      getDescription: (draft) => draft.name || '(optional)',
    },
    // Family field
    {
      key: 'family',
      type: 'text',
      label: 'Model Family',
      icon: 'preserve-case',
      section: 'primary',
      prompt: 'Enter model family (leave blank to use model ID)',
      placeholder: 'e.g., gpt-4, claude-3',
      transform: (value) => value.trim() || undefined,
      getDescription: (draft) => draft.family || '(optional)',
    },
    // Max Input Tokens
    {
      key: 'maxInputTokens',
      type: 'number',
      label: 'Max Input Tokens',
      icon: 'arrow-down',
      section: 'details',
      prompt: `Enter max input tokens (leave blank for defaults: ${DEFAULT_MAX_INPUT_TOKENS.toLocaleString()})`,
      positiveInteger: true,
      getDescription: (draft) =>
        draft.maxInputTokens?.toLocaleString() ||
        `optional, defaults: ${DEFAULT_MAX_INPUT_TOKENS.toLocaleString()}`,
    },
    // Max Output Tokens
    {
      key: 'maxOutputTokens',
      type: 'number',
      label: 'Max Output Tokens',
      icon: 'arrow-up',
      section: 'details',
      prompt: `Enter max output tokens (leave blank for defaults: ${DEFAULT_MAX_OUTPUT_TOKENS.toLocaleString()})`,
      positiveInteger: true,
      getDescription: (draft) =>
        draft.maxOutputTokens?.toLocaleString() ||
        `optional, defaults: ${DEFAULT_MAX_OUTPUT_TOKENS.toLocaleString()}`,
    },
    // Tool Calling (custom due to special limit option)
    {
      key: 'capabilities',
      type: 'custom',
      label: 'Tool Calling',
      icon: 'tools',
      section: 'capabilities',
      edit: async (draft) => {
        const picked = await pickQuickItem<
          vscode.QuickPickItem & { value: boolean | 'limit' }
        >({
          title: 'Tool Calling Support',
          placeholder: 'Select tool calling support',
          items: [
            {
              label: 'Enabled',
              description: 'Model supports tool calling',
              value: true,
            },
            {
              label: 'Disabled',
              description: 'Model does not support tool calling',
              value: false,
            },
            {
              label: 'Limited...',
              description: 'Set a maximum number of tools',
              value: 'limit',
            },
          ],
        });

        if (!picked) return;

        if (picked.value === 'limit') {
          const limitStr = await showInput({
            prompt: 'Enter maximum number of tools',
            placeHolder: 'e.g., 10',
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
          ? `Enabled (max ${draft.capabilities.toolCalling})`
          : draft.capabilities?.toolCalling
          ? 'Enabled'
          : 'Disabled',
    },
    // Parallel Tool Calling
    {
      key: 'parallelToolCalling',
      type: 'picker',
      label: 'Parallel Tool Calling',
      icon: 'group-by-ref-type',
      section: 'capabilities',
      title: 'Parallel Tool Calling',
      placeholder: 'Enable or disable parallel tool calls',
      options: [
        {
          label: 'Default',
          description: 'Use provider default behavior',
          value: undefined,
        },
        {
          label: 'Enable',
          description: 'Allow parallel tool calls',
          value: true,
        },
        {
          label: 'Disable',
          description: 'Disallow parallel tool calls',
          value: false,
        },
      ],
      getDescription: (draft) =>
        draft.parallelToolCalling === undefined
          ? 'default'
          : draft.parallelToolCalling
          ? 'enable'
          : 'disable',
    },
    // Image Input (custom because it modifies capabilities nested object)
    {
      key: 'capabilities',
      type: 'custom',
      label: 'Image Input Support',
      icon: 'file-media',
      section: 'capabilities',
      edit: async (draft) => {
        const picked = await pickQuickItem<
          vscode.QuickPickItem & { value: boolean }
        >({
          title: 'Image Input Support',
          placeholder: 'Enable or disable image input',
          items: [
            {
              label: 'Enabled',
              description: 'Model supports image input',
              value: true,
            },
            {
              label: 'Disabled',
              description: 'Model does not support image input',
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
        draft.capabilities?.imageInput ? 'Enabled' : 'Disabled',
    },
    // Stream
    {
      key: 'stream',
      type: 'picker',
      label: 'Stream',
      icon: 'diff-renamed',
      section: 'capabilities',
      title: 'Stream Response',
      placeholder: 'Select stream setting',
      options: booleanOptions({
        default: 'Default',
        defaultDesc: 'Use provider default',
        true: 'True',
        trueDesc: 'Enable streaming',
        false: 'False',
        falseDesc: 'Disable streaming',
      }),
      getDescription: (draft) => formatBoolean(draft.stream),
    },
    // Thinking (custom due to complex nested structure)
    {
      key: 'thinking',
      type: 'custom',
      label: 'Thinking',
      icon: 'lightbulb',
      section: 'capabilities',
      edit: async (draft) => {
        const picked = await pickQuickItem<
          vscode.QuickPickItem & { value: 'enabled' | 'disabled' | undefined }
        >({
          title: 'Thinking Capability',
          placeholder: 'Select thinking setting',
          items: [
            {
              label: 'Default',
              description: 'Use provider default',
              value: undefined,
            },
            {
              label: 'Enabled',
              description: 'Enable thinking',
              value: 'enabled',
            },
            {
              label: 'Disabled',
              description: 'Disable thinking',
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
            prompt: 'Enter budget tokens for thinking',
            placeHolder: 'Leave blank for default',
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
            title: 'Thinking Effort',
            placeholder: 'Select thinking effort (optional)',
            items: [
              {
                label: 'Default',
                description: 'Let the provider decide',
                value: undefined,
                picked: draft.thinking?.effort === undefined,
              },
              {
                label: 'None',
                value: 'none',
                picked: draft.thinking?.effort === 'none',
              },
              {
                label: 'Minimal',
                value: 'minimal',
                picked: draft.thinking?.effort === 'minimal',
              },
              {
                label: 'Low',
                value: 'low',
                picked: draft.thinking?.effort === 'low',
              },
              {
                label: 'Medium',
                value: 'medium',
                picked: draft.thinking?.effort === 'medium',
              },
              {
                label: 'High',
                value: 'high',
                picked: draft.thinking?.effort === 'high',
              },
              {
                label: 'Extra High',
                value: 'xhigh',
                picked: draft.thinking?.effort === 'xhigh',
              },
            ],
          });

          draft.thinking = {
            type: 'enabled',
            budgetTokens: budgetStr ? Number(budgetStr) : undefined,
            effort: effort ? effort.value : undefined,
          };
        }
      },
      getDescription: (draft) => {
        if (!draft.thinking) return 'default';
        if (draft.thinking.type === 'disabled') return 'disabled';
        const details: string[] = [];
        if (draft.thinking.budgetTokens !== undefined) {
          details.push(`${draft.thinking.budgetTokens} tokens`);
        }
        if (draft.thinking.effort) {
          details.push(`${draft.thinking.effort} effort`);
        }
        return `enabled${details.length > 0 ? ` (${details.join(', ')})` : ''}`;
      },
    },
    // Verbosity
    {
      key: 'verbosity',
      type: 'picker',
      label: 'Verbosity',
      icon: 'code-review',
      section: 'capabilities',
      title: 'Verbosity',
      placeholder: 'Choose response verbosity',
      options: [
        {
          label: 'Default',
          description: 'Use provider default',
          value: undefined,
        },
        {
          label: 'Low',
          description: 'More concise responses',
          value: 'low',
        },
        {
          label: 'Medium',
          description: 'Balanced verbosity',
          value: 'medium',
        },
        {
          label: 'High',
          description: 'More verbose responses',
          value: 'high',
        },
      ],
      getDescription: (draft) => draft.verbosity ?? 'default',
    },
    // Temperature
    {
      key: 'temperature',
      type: 'number',
      label: 'Temperature',
      icon: 'circle',
      section: 'parameters',
      prompt: 'Enter temperature',
      placeholder: 'Leave blank for default',
      getDescription: (draft) =>
        draft.temperature === undefined
          ? 'default'
          : draft.temperature.toString(),
    },
    // Top K
    {
      key: 'topK',
      type: 'number',
      label: 'Top K',
      icon: 'circle',
      section: 'parameters',
      prompt: 'Enter Top K',
      placeholder: 'Leave blank for default',
      positiveInteger: true,
      getDescription: (draft) =>
        draft.topK === undefined ? 'default' : draft.topK.toString(),
    },
    // Top P
    {
      key: 'topP',
      type: 'number',
      label: 'Top P',
      icon: 'circle',
      section: 'parameters',
      prompt: 'Enter Top P',
      placeholder: 'Leave blank for default',
      getDescription: (draft) =>
        draft.topP === undefined ? 'default' : draft.topP.toString(),
    },
    // Frequency Penalty
    {
      key: 'frequencyPenalty',
      type: 'number',
      label: 'Frequency Penalty',
      icon: 'circle',
      section: 'parameters',
      prompt: 'Enter Frequency Penalty',
      placeholder: 'Leave blank for default',
      getDescription: (draft) =>
        draft.frequencyPenalty === undefined
          ? 'default'
          : draft.frequencyPenalty.toString(),
    },
    // Presence Penalty
    {
      key: 'presencePenalty',
      type: 'number',
      label: 'Presence Penalty',
      icon: 'circle',
      section: 'parameters',
      prompt: 'Enter Presence Penalty',
      placeholder: 'Leave blank for default',
      getDescription: (draft) =>
        draft.presencePenalty === undefined
          ? 'default'
          : draft.presencePenalty.toString(),
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

/**
 * Find model fields by key (for fields with same key like capabilities).
 * Returns all matching fields.
 */
export function findModelFieldsByKey(
  key: keyof ModelConfig,
): typeof modelFormSchema.fields {
  return modelFormSchema.fields.filter((f) => f.key === key);
}
