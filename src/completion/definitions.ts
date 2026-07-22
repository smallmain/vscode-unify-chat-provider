import type { CompletionAlgorithmDefinition } from './types';
import { CompletionAlgorithmRegistry } from './registry';
import { simpleAlgorithmDefinition } from './simple/algorithm';
import { copilotReplicaAlgorithmDefinition } from './copilot/algorithm';
import {
  inceptionAlgorithmDefinition,
  mistralAlgorithmDefinition,
  zedAlgorithmDefinition,
} from './edit/algorithm';

export const COMPLETION_ALGORITHM_DEFINITIONS: readonly CompletionAlgorithmDefinition[] =
  [
    simpleAlgorithmDefinition,
    copilotReplicaAlgorithmDefinition,
    zedAlgorithmDefinition,
    inceptionAlgorithmDefinition,
    mistralAlgorithmDefinition,
  ];

export const completionAlgorithmRegistry = new CompletionAlgorithmRegistry(
  COMPLETION_ALGORITHM_DEFINITIONS,
);
