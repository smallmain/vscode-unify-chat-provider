import { t } from '../i18n';
import type {
  ModelConfig,
  PresetTemplate,
  ServiceTier,
  ThinkingEffort,
} from '../types';

type Verbosity = NonNullable<ModelConfig['verbosity']>;
type BudgetReasoningEffort = Extract<ThinkingEffort, 'high' | 'medium' | 'low'>;

const DEFAULT_PRESET_ID = 'default';

const REASONING_EFFORT_ORDER: readonly ThinkingEffort[] = [
  'max',
  'xhigh',
  'high',
  'medium',
  'low',
  'minimal',
  'none',
];

const VERBOSITY_ORDER: readonly Verbosity[] = ['low', 'medium', 'high'];

const SERVICE_TIER_ORDER: readonly ServiceTier[] = [
  'auto',
  'standard',
  'flex',
  'scale',
  'priority',
];

const REASONING_EFFORT_PRESET_METADATA = {
  max: {
    name: t('Max'),
    description: t('Maximum depth of inference'),
  },
  xhigh: {
    name: t('Extra High'),
    description: t('Extra high depth of inference'),
  },
  high: {
    name: t('High'),
    description: t('High depth of inference'),
  },
  medium: {
    name: t('Medium'),
    description: t('Balance thinking with speed'),
  },
  low: {
    name: t('Low'),
    description: t('Faster response times and lower depth of inference'),
  },
  minimal: {
    name: t('Minimal'),
    description: t('Minimum depth of inference'),
  },
  none: {
    name: t('None'),
    description: t('Responding without reasoning'),
  },
} satisfies Record<ThinkingEffort, { name: string; description: string }>;

const VERBOSITY_PRESET_METADATA = {
  low: {
    name: t('Low'),
    description: t('More concise responses'),
  },
  medium: {
    name: t('Medium'),
    description: t('Balanced verbosity'),
  },
  high: {
    name: t('High'),
    description: t('More verbose responses'),
  },
} satisfies Record<Verbosity, { name: string; description: string }>;

const SERVICE_TIER_PRESET_METADATA = {
  auto: {
    name: t('Auto'),
    description: t('Let the provider choose automatically'),
  },
  standard: {
    name: t('Standard'),
    description: t('Standard pricing and speed'),
  },
  flex: {
    name: t('Flex'),
    description: t('Lower prices and slower speeds'),
  },
  scale: {
    name: t('Scale'),
    description: t('Higher price and faster speed'),
  },
  priority: {
    name: t('Priority'),
    description: t('Higher price and faster speed'),
  },
} satisfies Record<ServiceTier, { name: string; description: string }>;

const BUDGET_REASONING_EFFORT_ORDER: readonly BudgetReasoningEffort[] = [
  'high',
  'medium',
  'low',
];

const DEFAULT_REASONING_BUDGETS = {
  high: 32000,
  medium: 16000,
  low: 1024,
} satisfies Record<BudgetReasoningEffort, number>;

export interface ReasoningEffortTemplateOptions {
  default?: ThinkingEffort | 'auto';
  includeAuto?: boolean;
  supported?: readonly ThinkingEffort[];
}

export interface BudgetReasoningEffortTemplateOptions {
  default?:
    | BudgetReasoningEffort
    | 'auto'
    | 'none';
  includeAuto?: boolean;
  includeNone?: boolean;
  budgets?: Partial<Record<BudgetReasoningEffort, number>>;
  supported?: readonly BudgetReasoningEffort[];
}

interface SupportedTemplateOptions<T> {
  supported?: readonly T[];
}

export type VerbosityTemplateOptions = SupportedTemplateOptions<Verbosity>;

export type ServiceTierTemplateOptions = SupportedTemplateOptions<ServiceTier>;

export interface ThinkingModeTemplateOptions {
  default?: 'auto' | 'enabled' | 'disabled';
  includeAuto?: boolean;
}

function isReasoningEffortTemplateOptions(
  input: readonly ThinkingEffort[] | ReasoningEffortTemplateOptions | undefined,
): input is ReasoningEffortTemplateOptions {
  return input !== undefined && !Array.isArray(input);
}

function normalizeReasoningEffortTemplateOptions(
  input?: readonly ThinkingEffort[] | ReasoningEffortTemplateOptions,
): ReasoningEffortTemplateOptions | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (isReasoningEffortTemplateOptions(input)) {
    return input;
  }
  return { supported: input };
}

function isSupportedTemplateOptions<T>(
  input: readonly T[] | SupportedTemplateOptions<T> | undefined,
): input is SupportedTemplateOptions<T> {
  return input !== undefined && !Array.isArray(input);
}

function normalizeSupportedTemplateOptions<T>(
  input?: readonly T[] | SupportedTemplateOptions<T>,
): SupportedTemplateOptions<T> | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (isSupportedTemplateOptions(input)) {
    return input;
  }
  return { supported: input };
}

function resolveSupportedValues<T>(
  order: readonly T[],
  supported: readonly T[] | undefined,
): readonly T[] {
  return supported && supported.length > 0
    ? order.filter((value) => supported.includes(value))
    : order;
}

function createDefaultPreset(
  description: string,
): PresetTemplate['presets'][number] {
  return {
    id: DEFAULT_PRESET_ID,
    name: t('Default'),
    description,
    config: {},
  };
}

function createAutoReasoningEffortPreset(): PresetTemplate['presets'][number] {
  return {
    id: 'auto',
    name: t('Auto'),
    description: t('Let the provider choose automatically'),
    config: {
      thinking: {
        type: 'auto',
      },
    },
  };
}

function createReasoningEffortPreset(
  effort: ThinkingEffort,
  thinking: NonNullable<ModelConfig['thinking']>,
): PresetTemplate['presets'][number] {
  return {
    ...REASONING_EFFORT_PRESET_METADATA[effort],
    id: effort,
    config: {
      thinking,
    },
  };
}

export function thinkingMode(
  opts?: ThinkingModeTemplateOptions,
): PresetTemplate {
  const presets: PresetTemplate['presets'] = [
    ...(opts?.includeAuto || opts?.default === 'auto'
      ? [
          {
            id: 'auto',
            name: t('Auto'),
            description: t('Auto thinking'),
            config: {
              thinking: {
                type: 'auto',
              },
            },
          } satisfies PresetTemplate['presets'][number],
        ]
      : []),
    {
      id: 'enabled',
      name: t('Enabled'),
      description: t('Enable thinking'),
      config: {
        thinking: {
          type: 'enabled',
        },
      },
    },
    {
      id: 'disabled',
      name: t('Disabled'),
      description: t('Disable thinking'),
      config: {
        thinking: {
          type: 'disabled',
        },
      },
    },
  ];

  return {
    name: t('Thinking'),
    id: 'thinkingMode',
    presets,
    default: opts?.default ?? 'enabled',
  };
}

export function reasoningEffort(
  supported?: readonly ThinkingEffort[],
): PresetTemplate;
export function reasoningEffort(
  opts?: ReasoningEffortTemplateOptions,
): PresetTemplate;
export function reasoningEffort(
  input?: readonly ThinkingEffort[] | ReasoningEffortTemplateOptions,
): PresetTemplate {
  const resolvedOptions = normalizeReasoningEffortTemplateOptions(input);
  const supportedEfforts = resolveSupportedValues(
    REASONING_EFFORT_ORDER,
    resolvedOptions?.supported,
  );
  const presets: PresetTemplate['presets'] = [
    ...(resolvedOptions?.includeAuto ? [createAutoReasoningEffortPreset()] : []),
    ...supportedEfforts.map(
      (effort): PresetTemplate['presets'][number] =>
        createReasoningEffortPreset(effort, {
          type: 'enabled',
          effort,
        }),
    ),
  ];
  const defaultPreset =
    resolvedOptions?.default === 'auto' && resolvedOptions.includeAuto
      ? 'auto'
      : resolvedOptions?.default &&
          resolvedOptions.default !== 'auto' &&
          supportedEfforts.includes(resolvedOptions.default)
      ? resolvedOptions.default
      : (presets[0]?.id ?? 'xhigh');

  return {
    name: t('Reasoning Effort'),
    id: 'reasoningEffort',
    presets,
    default: defaultPreset,
  };
}

export function adaptiveReasoningEffort(
  supported?: readonly ThinkingEffort[],
): PresetTemplate;
export function adaptiveReasoningEffort(
  opts?: ReasoningEffortTemplateOptions,
): PresetTemplate;
export function adaptiveReasoningEffort(
  input?: readonly ThinkingEffort[] | ReasoningEffortTemplateOptions,
): PresetTemplate {
  const resolvedOptions = normalizeReasoningEffortTemplateOptions(input);
  const supportedEfforts = resolveSupportedValues(
    REASONING_EFFORT_ORDER,
    resolvedOptions?.supported,
  );
  const presets: PresetTemplate['presets'] = supportedEfforts.map(
    (effort): PresetTemplate['presets'][number] =>
      createReasoningEffortPreset(effort, {
        type: 'auto',
        effort,
      }),
  );
  const defaultPreset =
    resolvedOptions?.default &&
    resolvedOptions.default !== 'auto' &&
    supportedEfforts.includes(resolvedOptions.default)
      ? resolvedOptions.default
      : (presets[0]?.id ?? 'high');

  return {
    name: t('Reasoning Effort'),
    id: 'reasoningEffort',
    presets,
    default: defaultPreset,
  };
}

export function budgetReasoningEffort(
  opts?: BudgetReasoningEffortTemplateOptions,
): PresetTemplate {
  const budgets: Record<BudgetReasoningEffort, number> = {
    ...DEFAULT_REASONING_BUDGETS,
    ...opts?.budgets,
  };
  const supportedEfforts = resolveSupportedValues(
    BUDGET_REASONING_EFFORT_ORDER,
    opts?.supported,
  );
  const presets: PresetTemplate['presets'] = [
    ...(opts?.includeAuto ? [createAutoReasoningEffortPreset()] : []),
    ...(opts?.includeNone
      ? [createReasoningEffortPreset('none', { type: 'disabled' })]
      : []),
    ...supportedEfforts.map((effort): PresetTemplate['presets'][number] => ({
      ...REASONING_EFFORT_PRESET_METADATA[effort],
      id: effort,
      config: {
        thinking: {
          type: 'enabled',
          budgetTokens: budgets[effort],
        },
      },
    })),
  ];
  const defaultPreset =
    opts?.default === 'auto' && opts.includeAuto
      ? 'auto'
      : opts?.default === 'none' && opts.includeNone
      ? 'none'
      : opts?.default !== undefined &&
          opts.default !== 'auto' &&
          opts.default !== 'none' &&
          supportedEfforts.includes(opts.default)
      ? opts.default
      : (presets[0]?.id ?? 'high');

  return {
    name: t('Reasoning Effort'),
    id: 'reasoningEffort',
    presets,
    default: defaultPreset,
  };
}

export function verbosity(supported?: readonly Verbosity[]): PresetTemplate;
export function verbosity(opts?: VerbosityTemplateOptions): PresetTemplate;
export function verbosity(
  input?: readonly Verbosity[] | VerbosityTemplateOptions,
): PresetTemplate {
  const resolvedOptions = normalizeSupportedTemplateOptions(input);
  const supportedVerbosity = resolveSupportedValues(
    VERBOSITY_ORDER,
    resolvedOptions?.supported,
  );
  const presets: PresetTemplate['presets'] = [
    createDefaultPreset(t('Use provider default')),
    ...supportedVerbosity.map((value): PresetTemplate['presets'][number] => ({
      ...VERBOSITY_PRESET_METADATA[value],
      id: value,
      config: {
        verbosity: value,
      },
    })),
  ];

  return {
    name: t('Verbosity'),
    id: 'verbosity',
    presets,
    default: DEFAULT_PRESET_ID,
  };
}

export function serviceTier(supported?: readonly ServiceTier[]): PresetTemplate;
export function serviceTier(opts?: ServiceTierTemplateOptions): PresetTemplate;
export function serviceTier(
  input?: readonly ServiceTier[] | ServiceTierTemplateOptions,
): PresetTemplate {
  const resolvedOptions = normalizeSupportedTemplateOptions(input);
  const supportedServiceTiers = resolveSupportedValues(
    SERVICE_TIER_ORDER,
    resolvedOptions?.supported,
  );
  const presets: PresetTemplate['presets'] = [
    createDefaultPreset(t('Use provider default behavior')),
    ...supportedServiceTiers.map(
      (value): PresetTemplate['presets'][number] => ({
        ...SERVICE_TIER_PRESET_METADATA[value],
        id: value,
        config: {
          serviceTier: value,
        },
      }),
    ),
  ];

  return {
    name: t('Service Tier'),
    id: 'serviceTier',
    presets,
    default: DEFAULT_PRESET_ID,
  };
}
