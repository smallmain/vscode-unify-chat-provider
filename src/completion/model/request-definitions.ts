import type {
  AlgorithmRequestKind,
  CompletionRequestKind,
} from './requests';

export type CompletionResponseMode = 'buffered' | 'streaming';

export const COMPLETION_REQUEST_RESPONSE_MODES = {
  fim: 'buffered',
  codegemma: 'buffered',
  'copilot-replica-nes': 'streaming',
  zeta1: 'buffered',
  zeta2: 'buffered',
  'zeta2.1': 'buffered',
  'zeta3-internal': 'buffered',
  'mercury-edit-2': 'buffered',
  codestral: 'buffered',
} as const satisfies Readonly<
  Record<CompletionRequestKind, CompletionResponseMode>
>;

export const ALGORITHM_REQUEST_DEFINITIONS = {
  simple: { targets: ['fim', 'codegemma'], responseMode: 'buffered' },
  'copilot-replica/fim': {
    targets: ['fim', 'codegemma'],
    responseMode: 'buffered',
  },
  'copilot-replica/nes': {
    targets: ['copilot-replica-nes'],
    responseMode: 'streaming',
  },
  'copilot-replica/cursor-prediction': {
    targets: ['copilot-replica-nes'],
    responseMode: 'streaming',
  },
  zed: {
    targets: ['zeta3-internal', 'zeta2.1', 'zeta2', 'zeta1'],
    responseMode: 'buffered',
  },
  inception: {
    targets: ['mercury-edit-2'],
    responseMode: 'buffered',
  },
  mistral: {
    targets: ['codestral'],
    responseMode: 'buffered',
  },
} as const satisfies Readonly<
  Record<
    AlgorithmRequestKind,
    {
      readonly targets: readonly CompletionRequestKind[];
      readonly responseMode: CompletionResponseMode;
    }
  >
>;
