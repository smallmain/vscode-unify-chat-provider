import * as vscode from 'vscode';

/**
 * Base field definition shared by all field types.
 */
export interface BaseFieldDef<T, K extends keyof T> {
  /** The field key in the draft object */
  key: K;
  /** Display label with optional icon prefix */
  label: string;
  /** Icon codicon name (without the $() wrapper) */
  icon?: string;
  /** Section this field belongs to */
  section?: string;
}

/**
 * Text input field definition.
 */
export interface TextFieldDef<T, K extends keyof T> extends BaseFieldDef<T, K> {
  type: 'text';
  prompt: string;
  placeholder?: string;
  password?: boolean;
  required?: boolean;
  /** Custom validation function (sync, runs on every keystroke) */
  validate?: (value: string, draft: T, context: FieldContext) => string | null;
  /**
   * Called when user presses Enter. Return false to keep the input box open.
   * Can be used for async validation or confirmation dialogs.
   * Return { value: string } to override the accepted value.
   */
  onWillAccept?: (
    value: string,
    draft: T,
    context: FieldContext,
  ) =>
    | Promise<boolean | { value: string } | void>
    | boolean
    | { value: string }
    | void;
  /** Transform the value before storing */
  transform?: (value: string) => string | undefined;
  /** Get the current value for display */
  getValue?: (draft: T) => string;
  /** Get the description for the form item */
  getDescription?: (draft: T) => string;
}

/**
 * Numeric input field definition.
 */
export interface NumericFieldDef<T, K extends keyof T>
  extends BaseFieldDef<T, K> {
  type: 'number';
  prompt: string;
  placeholder?: string;
  /** Whether to allow only positive integers */
  positiveInteger?: boolean;
  /** Get the current value for display */
  getValue?: (draft: T) => number | undefined;
  /** Get the description for the form item */
  getDescription?: (draft: T) => string;
}

/**
 * Option for picker fields.
 */
export interface PickerOption<V> {
  label: string;
  description?: string;
  value: V;
}

/**
 * Picker field definition (dropdown selection).
 */
export interface PickerFieldDef<T, K extends keyof T, V = unknown>
  extends BaseFieldDef<T, K> {
  type: 'picker';
  title: string;
  placeholder?: string;
  /** Static options or function to generate options dynamically */
  options:
    | PickerOption<V>[]
    | ((draft: T, context: FieldContext) => PickerOption<V>[]);
  /** Get the current value */
  getValue?: (draft: T) => V;
  /** Set the value after selection */
  setValue?: (draft: T, value: V) => void;
  /** Get the description for the form item */
  getDescription?: (draft: T) => string;
}

/**
 * Custom field definition for complex fields.
 */
export interface CustomFieldDef<T, K extends keyof T>
  extends BaseFieldDef<T, K> {
  type: 'custom';
  /** Custom edit handler */
  edit: (draft: T, context: FieldContext) => Promise<void>;
  /** Get the description for the form item */
  getDescription?: (draft: T) => string;
  /** Get the detail text for the form item */
  getDetail?: (draft: T) => string | undefined;
}

/**
 * Union of all field definition types.
 */
export type FieldDef<T, K extends keyof T = keyof T> =
  | TextFieldDef<T, K>
  | NumericFieldDef<T, K>
  | PickerFieldDef<T, K>
  | CustomFieldDef<T, K>;

/**
 * Section definition for grouping fields.
 */
export interface SectionDef {
  id: string;
  label: string;
}

/**
 * Form schema definition.
 */
export interface FormSchema<T> {
  sections: SectionDef[];
  fields: FieldDef<T, keyof T>[];
}

/**
 * Context passed to field handlers.
 */
export interface FieldContext {
  [key: string]: unknown;
}

/**
 * Form item with field reference.
 */
export type FormItem<T> = vscode.QuickPickItem & {
  action?: 'confirm' | 'cancel' | 'delete' | 'copy' | 'duplicate';
  field?: keyof T;
};

/**
 * Build form items from a schema and draft.
 */
export function buildFormItems<T>(
  schema: FormSchema<T>,
  draft: T,
  options: {
    isEditing: boolean;
    backLabel?: string;
    saveLabel?: string;
    deleteLabel?: string;
    copyLabel?: string;
    duplicateLabel?: string;
  },
): FormItem<T>[] {
  const {
    isEditing,
    backLabel = '$(arrow-left) Back',
    saveLabel = '$(check) Save',
    deleteLabel = '$(trash) Delete',
    copyLabel = '$(copy) Copy',
    duplicateLabel = '$(files) Duplicate',
  } = options;
  const items: FormItem<T>[] = [];

  // Back button
  items.push({ label: backLabel, action: 'cancel' });

  // Group fields by section
  const fieldsBySection = new Map<string | undefined, FieldDef<T, keyof T>[]>();
  for (const field of schema.fields) {
    const sectionId = field.section;
    if (!fieldsBySection.has(sectionId)) {
      fieldsBySection.set(sectionId, []);
    }
    fieldsBySection.get(sectionId)!.push(field);
  }

  // Add sections and fields
  for (const section of schema.sections) {
    const sectionFields = fieldsBySection.get(section.id);
    if (!sectionFields || sectionFields.length === 0) continue;

    // Section separator
    items.push({
      label: '',
      kind: vscode.QuickPickItemKind.Separator,
      description: section.label,
    });

    // Fields in this section
    for (const field of sectionFields) {
      const icon = field.icon ? `$(${field.icon}) ` : '';
      const description = getFieldDescription(field, draft);
      const detail = getFieldDetail(field, draft);

      items.push({
        label: `${icon}${field.label}`,
        description,
        detail,
        field: field.key,
      });
    }
  }

  // Fields without section
  const unsectionedFields = fieldsBySection.get(undefined);
  if (unsectionedFields && unsectionedFields.length > 0) {
    items.push({
      label: '',
      kind: vscode.QuickPickItemKind.Separator,
    });

    for (const field of unsectionedFields) {
      const icon = field.icon ? `$(${field.icon}) ` : '';
      const description = getFieldDescription(field, draft);
      const detail = getFieldDetail(field, draft);

      items.push({
        label: `${icon}${field.label}`,
        description,
        detail,
        field: field.key,
      });
    }
  }

  // Action buttons
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: saveLabel, action: 'confirm' });

  if (isEditing) {
    items.push({ label: copyLabel, action: 'copy' });
    items.push({ label: duplicateLabel, action: 'duplicate' });
    items.push({ label: deleteLabel, action: 'delete' });
  }

  return items;
}

function getFieldDescription<T>(field: FieldDef<T, keyof T>, draft: T): string {
  if (
    field.type === 'text' ||
    field.type === 'number' ||
    field.type === 'picker' ||
    field.type === 'custom'
  ) {
    if ('getDescription' in field && field.getDescription) {
      return field.getDescription(draft);
    }
  }

  // Default descriptions based on field type
  switch (field.type) {
    case 'text': {
      const value = field.getValue
        ? field.getValue(draft)
        : (draft[field.key] as string | undefined);
      if (field.password && value) return '••••••••';
      return value || (field.required ? '(required)' : '(optional)');
    }
    case 'number': {
      const value = field.getValue
        ? field.getValue(draft)
        : (draft[field.key] as number | undefined);
      return value !== undefined ? value.toLocaleString() : 'default';
    }
    case 'picker': {
      const value = field.getValue ? field.getValue(draft) : draft[field.key];
      const options = typeof field.options === 'function' ? [] : field.options;
      const option = options.find((o) => o.value === value);
      return option?.label || 'default';
    }
    case 'custom':
      return '';
  }
}

function getFieldDetail<T>(
  field: FieldDef<T, keyof T>,
  draft: T,
): string | undefined {
  if (field.type === 'custom' && field.getDetail) {
    return field.getDetail(draft);
  }
  return undefined;
}

/**
 * Find a field definition by key.
 */
export function findField<T>(
  schema: FormSchema<T>,
  key: keyof T,
): FieldDef<T, keyof T> | undefined {
  return schema.fields.find((f) => f.key === key);
}
