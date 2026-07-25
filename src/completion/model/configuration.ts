import type {
  CompletionConfig,
  CompletionTemplate,
  CompletionTemplates,
} from '../../types';
import type {
  CompletionRequestKind,
  CompletionTemplates as RequestCompletionTemplates,
} from './requests';

export const COMPLETION_TEMPLATE_ORDER = [
  'fim',
  'codegemma',
  'copilot-replica-nes',
  'zeta1',
  'zeta2',
  'zeta2.1',
  'zeta3-internal',
  'mercury-edit-2',
  'codestral',
] as const satisfies readonly CompletionTemplate[];

type AssertNever<T extends never> = T;

export type _AssertCompletionTemplatesMatchRequestKinds = AssertNever<
  | Exclude<CompletionTemplate, CompletionRequestKind>
  | Exclude<CompletionRequestKind, CompletionTemplate>
>;

export type _AssertCompletionTemplateSetsMatch = AssertNever<
  | Exclude<CompletionTemplates, RequestCompletionTemplates>
  | Exclude<RequestCompletionTemplates, CompletionTemplates>
>;

export type _AssertCompletionTemplateOrderComplete = AssertNever<
  Exclude<CompletionTemplate, (typeof COMPLETION_TEMPLATE_ORDER)[number]>
>;

const COMPLETION_CONFIG_FIELDS = new Set([
  'transport',
  'baseUrl',
  'templates',
]);

export type CompletionConfigIssueCode =
  | 'completion-not-object'
  | 'completion-unknown-field'
  | 'completion-invalid-transport'
  | 'completion-invalid-base-url'
  | 'completion-invalid-templates';

export interface CompletionConfigIssue {
  readonly code: CompletionConfigIssueCode;
  readonly field?: string;
  readonly message: string;
}

export type CompletionConfigNormalizationResult =
  | { readonly status: 'absent' }
  | { readonly status: 'valid'; readonly value: CompletionConfig }
  | {
      readonly status: 'invalid';
      readonly issues: readonly CompletionConfigIssue[];
    };

export interface ResolvedCompletionConfig {
  readonly transport: 'auto' | 'native' | 'compatible';
  readonly baseUrl?: string;
  readonly templates: CompletionTemplates;
}

export type ResolvedCompletionConfigResult =
  | { readonly status: 'valid'; readonly value: ResolvedCompletionConfig }
  | {
      readonly status: 'invalid';
      readonly scope: 'provider' | 'model';
      readonly issues: readonly CompletionConfigIssue[];
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isCompletionTemplate(
  value: unknown,
): value is CompletionTemplate {
  switch (value) {
    case 'fim':
    case 'codegemma':
    case 'copilot-replica-nes':
    case 'zeta1':
    case 'zeta2':
    case 'zeta2.1':
    case 'zeta3-internal':
    case 'mercury-edit-2':
    case 'codestral':
      return true;
    default:
      return false;
  }
}

function normalizeTemplates(value: unknown): CompletionTemplates | undefined {
  if (value === 'all') {
    return 'all';
  }
  if (!Array.isArray(value)) {
    return undefined;
  }

  const selected = new Set<CompletionTemplate>();
  for (const item of value) {
    if (!isCompletionTemplate(item)) {
      return undefined;
    }
    selected.add(item);
  }
  return COMPLETION_TEMPLATE_ORDER.filter((template) => selected.has(template));
}

export function normalizeCompletionConfig(
  raw: unknown,
): CompletionConfigNormalizationResult {
  if (raw === undefined) {
    return { status: 'absent' };
  }
  if (!isRecord(raw)) {
    return {
      status: 'invalid',
      issues: [
        {
          code: 'completion-not-object',
          message: 'Completion configuration must be an object.',
        },
      ],
    };
  }

  const issues: CompletionConfigIssue[] = [];
  for (const field of Object.keys(raw)) {
    if (!COMPLETION_CONFIG_FIELDS.has(field)) {
      issues.push({
        code: 'completion-unknown-field',
        field,
        message: `Unknown completion configuration field "${field}".`,
      });
    }
  }

  const normalized: CompletionConfig = {};
  if (raw.transport !== undefined) {
    if (
      raw.transport === 'auto' ||
      raw.transport === 'native' ||
      raw.transport === 'compatible'
    ) {
      normalized.transport = raw.transport;
    } else {
      issues.push({
        code: 'completion-invalid-transport',
        field: 'transport',
        message: 'Completion transport must be auto, native, or compatible.',
      });
    }
  }

  if (raw.baseUrl !== undefined) {
    if (typeof raw.baseUrl !== 'string') {
      issues.push({
        code: 'completion-invalid-base-url',
        field: 'baseUrl',
        message: 'Completion baseUrl must be a string.',
      });
    } else if (raw.baseUrl.trim()) {
      normalized.baseUrl = raw.baseUrl.trim();
    }
  }

  if (raw.templates !== undefined) {
    const templates = normalizeTemplates(raw.templates);
    if (templates === undefined) {
      issues.push({
        code: 'completion-invalid-templates',
        field: 'templates',
        message:
          'Completion templates must be "all" or an array of registered template IDs.',
      });
    } else {
      normalized.templates = templates;
    }
  }

  return issues.length > 0
    ? { status: 'invalid', issues }
    : { status: 'valid', value: normalized };
}

export function resolveCompletionConfig(
  provider: CompletionConfigNormalizationResult,
  model: CompletionConfigNormalizationResult,
): ResolvedCompletionConfigResult {
  if (provider.status === 'invalid') {
    return {
      status: 'invalid',
      scope: 'provider',
      issues: provider.issues,
    };
  }
  if (model.status === 'invalid') {
    return { status: 'invalid', scope: 'model', issues: model.issues };
  }

  const providerValue =
    provider.status === 'valid' ? provider.value : undefined;
  const modelValue = model.status === 'valid' ? model.value : undefined;
  const baseUrl = modelValue?.baseUrl ?? providerValue?.baseUrl;
  return {
    status: 'valid',
    value: {
      transport:
        modelValue?.transport ?? providerValue?.transport ?? 'auto',
      ...(baseUrl === undefined ? {} : { baseUrl }),
      templates:
        modelValue?.templates ?? providerValue?.templates ?? [],
    },
  };
}

export function resolveExternalCompletionConfig(): ResolvedCompletionConfig {
  return { transport: 'compatible', templates: 'all' };
}
