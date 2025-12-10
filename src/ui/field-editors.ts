import * as vscode from 'vscode';
import { pickQuickItem, showInput } from './component';
import type {
  FieldContext,
  FormSchema,
  NumericFieldDef,
  PickerFieldDef,
  TextFieldDef,
} from './field-schema';
import { validatePositiveIntegerOrEmpty } from './form-utils';

/**
 * Edit a field based on its definition.
 */
export async function editField<T>(
  schema: FormSchema<T>,
  draft: T,
  fieldKey: keyof T,
  context: FieldContext,
): Promise<void> {
  const field = schema.fields.find((f) => f.key === fieldKey);
  if (!field) return;

  switch (field.type) {
    case 'text':
      await editTextField(field as TextFieldDef<T, keyof T>, draft, context);
      break;
    case 'number':
      await editNumericField(field as NumericFieldDef<T, keyof T>, draft);
      break;
    case 'picker':
      await editPickerField(
        field as PickerFieldDef<T, keyof T>,
        draft,
        context,
      );
      break;
    case 'custom':
      await field.edit(draft, context);
      break;
  }
}

/**
 * Edit a text field.
 */
async function editTextField<T>(
  field: TextFieldDef<T, keyof T>,
  draft: T,
  context: FieldContext,
): Promise<void> {
  const currentValue = field.getValue
    ? field.getValue(draft)
    : (draft[field.key] as string | undefined) ?? '';

  const val = await showInput({
    prompt: field.prompt,
    placeHolder: field.placeholder,
    value: currentValue,
    password: field.password,
    validateInput: field.validate
      ? (v) => field.validate!(v, draft, context)
      : undefined,
  });

  if (val !== undefined) {
    const transformed = field.transform
      ? field.transform(val)
      : val.trim() || undefined;
    (draft as Record<keyof T, unknown>)[field.key] = transformed;
  }
}

/**
 * Edit a numeric field.
 */
async function editNumericField<T>(
  field: NumericFieldDef<T, keyof T>,
  draft: T,
): Promise<void> {
  const currentValue = field.getValue
    ? field.getValue(draft)
    : (draft[field.key] as number | undefined);

  const validator = field.positiveInteger
    ? validatePositiveIntegerOrEmpty
    : (v: string) => {
        if (!v) return null;
        const n = Number(v);
        if (isNaN(n)) return 'Must be a number';
        return null;
      };

  const val = await showInput({
    prompt: field.prompt,
    placeHolder: field.placeholder || 'Leave blank for default',
    value: currentValue?.toString() || '',
    validateInput: validator,
  });

  if (val !== undefined) {
    (draft as Record<keyof T, unknown>)[field.key] = val
      ? Number(val)
      : undefined;
  }
}

/**
 * Edit a picker field.
 */
async function editPickerField<T, V>(
  field: PickerFieldDef<T, keyof T, V>,
  draft: T,
  context: FieldContext,
): Promise<void> {
  const options =
    typeof field.options === 'function'
      ? field.options(draft, context)
      : field.options;

  const currentValue = field.getValue
    ? field.getValue(draft)
    : draft[field.key];

  const picked = await pickQuickItem<vscode.QuickPickItem & { optionValue: V }>(
    {
      title: field.title,
      placeholder: field.placeholder,
      items: options.map((opt) => ({
        label: opt.label,
        description: opt.description,
        picked: opt.value === currentValue,
        optionValue: opt.value,
      })),
    },
  );

  if (picked) {
    if (field.setValue) {
      field.setValue(draft, picked.optionValue);
    } else {
      (draft as Record<keyof T, unknown>)[field.key] = picked.optionValue;
    }
  }
}

/**
 * Standard boolean picker options (Default/True/False).
 */
export function booleanOptions(labels?: {
  default?: string;
  defaultDesc?: string;
  true?: string;
  trueDesc?: string;
  false?: string;
  falseDesc?: string;
}): Array<{ label: string; description?: string; value: boolean | undefined }> {
  return [
    {
      label: labels?.default ?? 'Default',
      description: labels?.defaultDesc ?? 'Use provider default',
      value: undefined,
    },
    {
      label: labels?.true ?? 'True',
      description: labels?.trueDesc ?? 'Enable',
      value: true,
    },
    {
      label: labels?.false ?? 'False',
      description: labels?.falseDesc ?? 'Disable',
      value: false,
    },
  ];
}

/**
 * Standard enabled/disabled picker options.
 */
export function enabledDisabledOptions(labels?: {
  enabled?: string;
  enabledDesc?: string;
  disabled?: string;
  disabledDesc?: string;
}): Array<{ label: string; description?: string; value: boolean }> {
  return [
    {
      label: labels?.enabled ?? 'Enabled',
      description: labels?.enabledDesc,
      value: true,
    },
    {
      label: labels?.disabled ?? 'Disabled',
      description: labels?.disabledDesc,
      value: false,
    },
  ];
}

/**
 * Format a boolean value for display.
 */
export function formatBoolean(
  value: boolean | undefined,
  labels?: { default?: string; true?: string; false?: string },
): string {
  if (value === undefined) return labels?.default ?? 'default';
  return value ? labels?.true ?? 'true' : labels?.false ?? 'false';
}

/**
 * Format an optional value for display.
 */
export function formatOptional<T>(
  value: T | undefined,
  format?: (v: T) => string,
): string {
  if (value === undefined) return 'default';
  return format ? format(value) : String(value);
}
